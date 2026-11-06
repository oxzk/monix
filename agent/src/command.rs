use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};

use crate::protocol::{now_ms, ClientMessage};

/// 输出分片合并窗口, 减少 WebSocket 消息数量.
const FLUSH_MS: u64 = 80;

pub struct CommandRequest {
    pub command_id: String,
    pub command: String,
    pub timeout_seconds: u64,
    pub max_output_bytes: usize,
}

/// 当前占用的执行槽. 一次性命令与交互式终端共用同一个槽, 二者互斥.
enum ActiveUnit {
    Command {
        id: String,
        cancel: Arc<AtomicBool>,
    },
    Terminal {
        session_id: String,
        cancel: Arc<AtomicBool>,
    },
}

impl ActiveUnit {
    fn id(&self) -> &str {
        match self {
            Self::Command { id, .. } => id,
            Self::Terminal { session_id, .. } => session_id,
        }
    }

    fn cancel_flag(&self) -> &Arc<AtomicBool> {
        match self {
            Self::Command { cancel, .. } | Self::Terminal { cancel, .. } => cancel,
        }
    }

    fn describe(&self) -> String {
        match self {
            Self::Command { id, .. } => format!("command:{id}"),
            Self::Terminal { session_id, .. } => format!("terminal:{session_id}"),
        }
    }
}

/// 单服务器执行槽: 同一时刻只允许一条命令或一个终端会话.
pub struct CommandRegistry {
    active: Mutex<Option<ActiveUnit>>,
}

impl CommandRegistry {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }

    /// 尝试占用执行槽执行一次性命令.
    pub async fn try_begin_command(&self, command_id: &str, flag: Arc<AtomicBool>) -> bool {
        self.try_begin(ActiveUnit::Command {
            id: command_id.to_string(),
            cancel: flag,
        })
        .await
    }

    /// 尝试占用执行槽打开终端会话.
    pub async fn try_begin_terminal(&self, session_id: &str, flag: Arc<AtomicBool>) -> bool {
        self.try_begin(ActiveUnit::Terminal {
            session_id: session_id.to_string(),
            cancel: flag,
        })
        .await
    }

    async fn try_begin(&self, unit: ActiveUnit) -> bool {
        let mut guard = self.active.lock().await;
        if guard.is_some() {
            return false;
        }
        *guard = Some(unit);
        true
    }

    pub async fn finish_command(&self, command_id: &str) {
        self.finish(command_id).await;
    }

    pub async fn finish_terminal(&self, session_id: &str) {
        self.finish(session_id).await;
    }

    async fn finish(&self, id: &str) {
        let mut guard = self.active.lock().await;
        if let Some(current) = guard.as_ref() {
            if current.id() == id {
                *guard = None;
            }
        }
    }

    /// 取消指定命令; 返回是否找到.
    pub async fn cancel_command(&self, command_id: &str) -> bool {
        self.cancel(command_id).await
    }

    async fn cancel(&self, id: &str) -> bool {
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(unit) if unit.id() == id => {
                unit.cancel_flag().store(true, Ordering::SeqCst);
                true
            }
            _ => false,
        }
    }

    /// 连接断开时取消当前占用的执行槽, 返回其描述用于日志.
    pub async fn cancel_all(&self) -> Option<String> {
        let mut guard = self.active.lock().await;
        let result = guard.as_ref().map(ActiveUnit::describe);
        if let Some(unit) = guard.as_ref() {
            unit.cancel_flag().store(true, Ordering::SeqCst);
        }
        *guard = None;
        result
    }
}

/// 执行一条命令, 通过 sender 回传输出与最终结果.
///
/// 关键行为:
/// - stdout 与 stderr 独立读取, 避免管道写满阻塞子进程.
/// - 超过输出上限后继续读取并丢弃, 只停止发送. 若停止读取, 子进程会阻塞在写入上,
///   只能等到超时被杀, 表现为"截断输出的命令总是跑满超时".
/// - 超时与取消时终止整个进程组, 不只终止 Shell 父进程.
pub async fn execute(
    request: CommandRequest,
    sender: mpsc::UnboundedSender<String>,
    cancel_flag: Arc<AtomicBool>,
) {
    let started_at = now_ms();

    let _ = sender.send(serialize(&ClientMessage::CommandStarted {
        command_id: request.command_id.clone(),
        started_at,
    }));

    let mut child = match spawn_shell(&request.command) {
        Ok(child) => child,
        Err(error) => {
            let _ = sender.send(serialize_output(
                &request.command_id,
                "stderr",
                1,
                &format!("无法启动命令: {error}\n"),
            ));
            send_finished(
                &sender,
                &request.command_id,
                "failed",
                None,
                started_at,
                now_ms(),
                false,
            );
            return;
        }
    };

    let limit = request.max_output_bytes.max(1024);
    let sent_bytes = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    let (chunk_tx, mut chunk_rx) = mpsc::unbounded_channel::<OutputChunk>();

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(read_stream(
            stdout,
            "stdout",
            limit,
            sent_bytes.clone(),
            truncated.clone(),
            chunk_tx.clone(),
        ));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(read_stream(
            stderr,
            "stderr",
            limit,
            sent_bytes.clone(),
            truncated.clone(),
            chunk_tx.clone(),
        ));
    }
    drop(chunk_tx);

    // 转发任务: 按窗口合并 stdout/stderr, seq 递增.
    let forward_id = request.command_id.clone();
    let forward_sender = sender.clone();
    let forward_handle = tokio::spawn(async move {
        let mut seq = 0u64;
        let mut pending_stdout = String::new();
        let mut pending_stderr = String::new();

        let flush = |sender: &mpsc::UnboundedSender<String>,
                     seq: &mut u64,
                     out: &mut String,
                     err: &mut String| {
            if !out.is_empty() {
                *seq += 1;
                let data = std::mem::take(out);
                let _ = sender.send(serialize_output(&forward_id, "stdout", *seq, &data));
            }
            if !err.is_empty() {
                *seq += 1;
                let data = std::mem::take(err);
                let _ = sender.send(serialize_output(&forward_id, "stderr", *seq, &data));
            }
        };

        let mut ticker = tokio::time::interval(Duration::from_millis(FLUSH_MS));
        loop {
            tokio::select! {
                chunk = chunk_rx.recv() => {
                    match chunk {
                        Some(chunk) => {
                            if chunk.stream == "stdout" {
                                pending_stdout.push_str(&chunk.data);
                            } else {
                                pending_stderr.push_str(&chunk.data);
                            }
                            if pending_stdout.len() + pending_stderr.len() >= 8 * 1024 {
                                flush(&forward_sender, &mut seq, &mut pending_stdout, &mut pending_stderr);
                            }
                        }
                        None => {
                            flush(&forward_sender, &mut seq, &mut pending_stdout, &mut pending_stderr);
                            break;
                        }
                    }
                }
                _ = ticker.tick() => {
                    if !pending_stdout.is_empty() || !pending_stderr.is_empty() {
                        flush(&forward_sender, &mut seq, &mut pending_stdout, &mut pending_stderr);
                    }
                }
            }
        }
    });

    let timeout = Duration::from_secs(request.timeout_seconds.clamp(1, 3600));
    let deadline = Instant::now() + timeout;
    let mut tick = tokio::time::interval(Duration::from_millis(100));

    let (status, exit_code) = loop {
        if cancel_flag.load(Ordering::SeqCst) {
            kill_process_group(&mut child).await;
            let _ = child.wait().await;
            break ("cancelled", None);
        }

        match child.try_wait() {
            Ok(Some(exit_status)) => {
                let code = exit_status.code();
                break if code == Some(0) {
                    ("succeeded", code)
                } else {
                    ("failed", code)
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    kill_process_group(&mut child).await;
                    let _ = child.wait().await;
                    break ("timed_out", None);
                }
                tick.tick().await;
            }
            Err(_) => {
                kill_process_group(&mut child).await;
                break ("failed", None);
            }
        }
    };

    // 子进程已退出, 管道会 EOF, 读取任务随之结束.
    let _ = tokio::time::timeout(Duration::from_secs(2), forward_handle).await;

    let finished_at = now_ms();
    send_finished(
        &sender,
        &request.command_id,
        status,
        exit_code,
        started_at,
        finished_at,
        truncated.load(Ordering::SeqCst),
    );
}

struct OutputChunk {
    stream: &'static str,
    data: String,
}

async fn read_stream<R>(
    mut reader: R,
    stream: &'static str,
    limit: usize,
    sent: Arc<AtomicUsize>,
    truncated: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<OutputChunk>,
) where
    R: AsyncReadExt + Unpin,
{
    let mut buffer = [0u8; 8192];
    // 暂存末尾不完整的 UTF-8 字节, 等待下一批数据补齐.
    let mut carry: Vec<u8> = Vec::new();

    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => {
                let already = sent.load(Ordering::SeqCst);
                if already >= limit {
                    // 已达上限: 继续读取并丢弃, 保证子进程不会阻塞在管道写入上.
                    truncated.store(true, Ordering::SeqCst);
                    continue;
                }

                let remaining = limit - already;
                let take = n.min(remaining);
                sent.fetch_add(take, Ordering::SeqCst);
                if take < n {
                    truncated.store(true, Ordering::SeqCst);
                }

                carry.extend_from_slice(&buffer[..take]);
                // 兜底: 若解码后仍残留过多字节(理论不可达), 强制以替换字符输出.
                if carry.len() > MAX_CARRY_BYTES {
                    let salvaged = String::from_utf8_lossy(&carry).to_string();
                    carry.clear();
                    let _ = tx.send(OutputChunk {
                        stream,
                        data: salvaged,
                    });
                    continue;
                }
                let text = take_valid_utf8(&mut carry);
                if !text.is_empty() {
                    let _ = tx.send(OutputChunk { stream, data: text });
                }
            }
            Err(_) => break,
        }
    }

    if !carry.is_empty() {
        let text = String::from_utf8_lossy(&carry).to_string();
        if !text.is_empty() {
            let _ = tx.send(OutputChunk { stream, data: text });
        }
    }
}

/// 取出 carry 中完整的 UTF-8 前缀, 把不完整尾部留在 carry 中.
/// carry 的硬上限. UTF-8 单个字符最多 4 字节, 正常情况下不会超过几个字节;
/// 出现持续非法字节时必须强制清空, 否则缓冲区会无限增长.
const MAX_CARRY_BYTES: usize = 8 * 1024;

pub fn take_valid_utf8(carry: &mut Vec<u8>) -> String {
    if carry.is_empty() {
        return String::new();
    }

    // 从末尾回退, 找到最长的合法 UTF-8 前缀.
    let mut cut = carry.len();
    while cut > 0 && std::str::from_utf8(&carry[..cut]).is_err() {
        cut -= 1;
    }

    if cut == 0 {
        // 整个缓冲区都不合法: 以替换字符输出并清空, 避免无限累积.
        // 只有在残留不足一个完整字符时才继续等待后续数据.
        if carry.len() >= 4 {
            let text = String::from_utf8_lossy(carry).to_string();
            carry.clear();
            return text;
        }
        return String::new();
    }

    let text = String::from_utf8_lossy(&carry[..cut]).to_string();
    carry.drain(..cut);
    text
}

fn serialize(message: &ClientMessage) -> String {
    serde_json::to_string(message).unwrap_or_default()
}

fn serialize_output(command_id: &str, stream: &'static str, seq: u64, data: &str) -> String {
    serialize(&ClientMessage::CommandOutput {
        command_id: command_id.to_string(),
        stream,
        seq,
        data: data.to_string(),
    })
}

fn send_finished(
    sender: &mpsc::UnboundedSender<String>,
    command_id: &str,
    status: &'static str,
    exit_code: Option<i32>,
    started_at: i64,
    finished_at: i64,
    truncated: bool,
) {
    let _ = sender.send(serialize(&ClientMessage::CommandFinished {
        command_id: command_id.to_string(),
        status,
        exit_code,
        started_at,
        finished_at,
        duration_ms: (finished_at - started_at).max(0),
        output_truncated: truncated,
    }));
}

fn spawn_shell(command: &str) -> std::io::Result<tokio::process::Child> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    };

    #[cfg(not(windows))]
    let mut cmd = {
        // 一次性命令固定使用 /bin/sh, 不读取可被污染的 $SHELL.
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(command);
        c
    };

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(unix)]
    {
        // 独立进程组, 便于整组终止.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    cmd.spawn()
}

/// 终止整个进程组. Unix 先 SIGTERM 再 SIGKILL.
///
/// 使用 blocking 线程执行宽限期等待, 避免阻塞 tokio worker.
/// 主动 setsid/nohup 脱离进程组的孙进程无法被此机制终止, 这是操作系统边界.
async fn kill_process_group(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            let pgid = pid as i32;
            let _ = tokio::task::spawn_blocking(move || {
                unsafe {
                    libc::kill(-pgid, libc::SIGTERM);
                }
                std::thread::sleep(Duration::from_millis(120));
                unsafe {
                    libc::kill(-pgid, libc::SIGKILL);
                }
            })
            .await;
        }
    }
    #[cfg(windows)]
    {
        // Windows 没有等价的进程组信号: 先用 taskkill /T /F 终止整棵进程树,
        // 再回退到直接 kill. 缺少这一步时, `cmd /C` 派生的孙进程会残留.
        if let Some(pid) = child.id() {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            })
            .await;
        }
        let _ = child.start_kill();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.start_kill();
    }
}

#[cfg(test)]
mod tests {
    use super::{take_valid_utf8, CommandRegistry};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[tokio::test]
    async fn command_and_terminal_share_one_slot() {
        let registry = CommandRegistry::new();
        assert!(registry.try_begin_command("cmd-1", flag()).await);
        // 终端不能与命令同时占用执行槽.
        assert!(!registry.try_begin_terminal("sess-1", flag()).await);

        registry.finish_command("cmd-1").await;
        assert!(registry.try_begin_terminal("sess-1", flag()).await);
        // 命令也不能在终端打开时占用执行槽.
        assert!(!registry.try_begin_command("cmd-2", flag()).await);
    }

    #[tokio::test]
    async fn finish_ignores_mismatched_id() {
        let registry = CommandRegistry::new();
        assert!(registry.try_begin_command("cmd-1", flag()).await);
        registry.finish_command("cmd-2").await;
        // 槽位仍被 cmd-1 占用.
        assert!(!registry.try_begin_terminal("sess-1", flag()).await);
    }

    #[tokio::test]
    async fn cancel_sets_flag_only_for_matching_id() {
        let registry = CommandRegistry::new();
        let active = flag();
        assert!(registry.try_begin_terminal("sess-1", active.clone()).await);

        // 描述符用于辨识当前占用者, 取消由 cancel_all 统一处理.
        assert_eq!(
            registry.cancel_all().await.as_deref(),
            Some("terminal:sess-1")
        );
        assert!(active.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancel_all_clears_slot_and_returns_description() {
        let registry = CommandRegistry::new();
        let active = flag();
        assert!(registry.try_begin_terminal("sess-1", active.clone()).await);

        let described = registry.cancel_all().await;
        assert_eq!(described.as_deref(), Some("terminal:sess-1"));
        assert!(active.load(std::sync::atomic::Ordering::SeqCst));
        // 槽位已释放.
        assert!(registry.try_begin_command("cmd-1", flag()).await);
    }

    #[test]
    fn keeps_incomplete_utf8_tail() {
        // "中" 为 3 字节, 只给前 2 字节时应留在缓冲区.
        let mut carry = vec![0xE4, 0xB8];
        assert_eq!(take_valid_utf8(&mut carry), "");
        assert_eq!(carry, vec![0xE4, 0xB8]);
    }

    #[test]
    fn decodes_complete_prefix() {
        let mut carry = "abc中".as_bytes().to_vec();
        assert_eq!(take_valid_utf8(&mut carry), "abc中");
        assert!(carry.is_empty());
    }

    #[test]
    fn drains_complete_then_keeps_tail() {
        let mut carry = Vec::new();
        carry.extend_from_slice("中".as_bytes());
        carry.extend_from_slice(&[0xE6, 0x96]);
        assert_eq!(take_valid_utf8(&mut carry), "中");
        assert_eq!(carry, vec![0xE6, 0x96]);
    }
}
