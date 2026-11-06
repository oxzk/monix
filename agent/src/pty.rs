//! 交互式 PTY 会话.
//!
//! 与一次性命令不同, PTY 会话是长生命周期的: 有输入、输出、resize 与三种终止
//! 原因(用户关闭 / 空闲超时 / 最长时长). 输出不做累积截断, 因为交互式程序
//! (如 vim、top)一旦输出被截断就失去响应.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::mpsc;

use crate::protocol::ClientMessage;

/// 输出合并窗口: 先到者触发, 降低按键回显延迟.
const FLUSH_MS: u64 = 16;
/// 单批最大字节数, 避免一次发送过大的 base64.
const FLUSH_BYTES: usize = 8 * 1024;
/// 单条输入消息上限(解码后字节数).
pub const MAX_INPUT_BYTES: usize = 8 * 1024;
/// 终端尺寸硬性范围.
pub const MIN_COLS: u16 = 20;
pub const MAX_COLS: u16 = 500;
pub const MIN_ROWS: u16 = 5;
pub const MAX_ROWS: u16 = 200;
/// 等待阻塞读写线程收尾的上限, 超时后不再等待, 避免会话结束卡死执行槽.
const JOIN_TIMEOUT: Duration = Duration::from_secs(2);

/// 允许启动的 shell 白名单. 不直接信任 `$SHELL`, 避免被污染的环境变量
/// 引导 Agent 启动非预期的解释器.
///
/// 仅在 Unix 使用: Windows 下固定走 PowerShell.
#[cfg(not(windows))]
const ALLOWED_SHELLS: &[&str] = &[
    "/bin/bash",
    "/bin/sh",
    "/bin/zsh",
    "/usr/bin/bash",
    "/usr/bin/zsh",
    "/bin/dash",
    "/usr/bin/fish",
];

/// 会话可继承的环境变量白名单.
///
/// 只放行启动 shell 与常见交互工具必需的最小集合. Agent 自身的凭据与运行配置
/// (MONIX_*) 不在其中, 因此终端里读不到它们, 也不需要随新增变量维护剔除列表.
#[cfg(not(windows))]
const SESSION_ENV_ALLOWLIST: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TMPDIR",
];

/// Windows 下 ConPTY 与 shell 依赖系统变量, 缺少会导致进程无法启动.
#[cfg(windows)]
const SESSION_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
];

const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

pub struct PtySessionRequest {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub idle_timeout_secs: u64,
    pub max_duration_secs: u64,
}

/// 会话结束原因, 直接作为 `terminal.closed.reason` 下发.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    ClosedByUser,
    ProcessExited,
    IdleTimeout,
    MaxDuration,
    Error,
}

impl CloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClosedByUser => "closed_by_user",
            Self::ProcessExited => "process_exited",
            Self::IdleTimeout => "idle_timeout",
            Self::MaxDuration => "max_duration",
            Self::Error => "error",
        }
    }
}

/// 会话控制句柄: 由 main 持有, 用于转发输入/resize/关闭.
pub struct SessionHandle {
    pub input_tx: mpsc::UnboundedSender<Option<Vec<u8>>>,
    pub resize_tx: mpsc::UnboundedSender<(u16, u16)>,
    pub cancel: Arc<AtomicBool>,
    /// 最近一次收到输入的时间. 输入吞吐高, 不在主循环逐条转发, 因此
    /// 由句柄记录时间戳, 让空闲超时把"持续输入"也算作活跃.
    pub last_input_at: Arc<std::sync::Mutex<Instant>>,
}

impl SessionHandle {
    /// 记录一次输入活动, 供空闲超时判断.
    pub fn touch_input(&self) {
        if let Ok(mut guard) = self.last_input_at.lock() {
            *guard = Instant::now();
        }
    }
}

/// 启动一个 PTY 会话并等待其结束.
///
/// 返回结束原因; 调用方负责发送 `terminal.closed` 并释放执行槽.
///
/// `shutdown_tx` 用于在会话结束时显式唤醒写入线程 (发送 `None`).
/// 不能依赖 sender 被 drop 来结束写入线程: `SessionHandle` 由 main 持有,
/// 其释放发生在 `run_session` 返回之后, 会导致 shell 自行退出时永久阻塞.
pub async fn run_session(
    request: PtySessionRequest,
    out: mpsc::UnboundedSender<String>,
    mut input_rx: mpsc::UnboundedReceiver<Option<Vec<u8>>>,
    shutdown_tx: mpsc::UnboundedSender<Option<Vec<u8>>>,
    mut resize_rx: mpsc::UnboundedReceiver<(u16, u16)>,
    cancel: Arc<AtomicBool>,
    last_input_at: Arc<std::sync::Mutex<Instant>>,
) -> CloseReason {
    let session_id = request.session_id.clone();
    let cols = request.cols.clamp(MIN_COLS, MAX_COLS);
    let rows = request.rows.clamp(MIN_ROWS, MAX_ROWS);

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => {
            log::warn!("openpty 失败: {error}");
            return CloseReason::Error;
        }
    };

    // 由 portable-pty 建立会话与控制终端, 不能再调用 setsid, 否则会脱离控制终端.
    let mut builder = CommandBuilder::new(resolve_shell());
    apply_session_env(&mut builder);
    if let Some(home) = std::env::var_os("HOME") {
        builder.cwd(home);
    }

    let mut child = match pair.slave.spawn_command(builder) {
        Ok(child) => child,
        Err(error) => {
            log::warn!("启动 shell 失败: {error}");
            return CloseReason::Error;
        }
    };

    // process_group_leader() 带 #[cfg(unix)], Windows 下不可用;
    // process_id() 在各平台都由 portable-pty 提供.
    let pid = child.process_id();
    if let Err(error) = out.send(serialize(&ClientMessage::TerminalOpened {
        session_id: session_id.clone(),
        pid,
    })) {
        log::warn!("发送 terminal.opened 失败: {error}");
        let _ = child.kill();
        return CloseReason::Error;
    }

    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            log::warn!("获取 PTY 读取端失败: {error}");
            let _ = child.kill();
            return CloseReason::Error;
        }
    };
    let mut writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            log::warn!("获取 PTY 写入端失败: {error}");
            let _ = child.kill();
            return CloseReason::Error;
        }
    };

    // 读取端是阻塞 IO, 放到 blocking 线程; 子进程退出后 slave 关闭, read 返回 EOF/EIO.
    let (chunk_tx, mut chunk_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let reader_handle = tokio::task::spawn_blocking(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if chunk_tx.send(buffer[..n].to_vec()).is_err() {
                        break;
                    }
                }
                // Linux 上子进程退出后 master 读取会返回 EIO, 属于正常结束.
                Err(_) => break,
            }
        }
    });

    // 写入端同样阻塞. 输入通道由 main 持有的 SessionHandle 持有 sender,
    // 会话结束前必须先释放该 sender, 否则 blocking_recv 永远不返回.
    let writer_handle = tokio::task::spawn_blocking(move || {
        while let Some(message) = input_rx.blocking_recv() {
            let Some(data) = message else {
                // 收到显式停止信号.
                break;
            };
            if writer.write_all(&data).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

    let started = Instant::now();
    let max_duration = Duration::from_secs(request.max_duration_secs.clamp(300, 7_200));
    let idle_timeout = Duration::from_secs(request.idle_timeout_secs.clamp(60, 3_600));
    let mut last_activity = Instant::now();
    let mut seq: u64 = 0;

    let reason = loop {
        if cancel.load(Ordering::SeqCst) {
            break CloseReason::ClosedByUser;
        }

        // 子进程退出: 先排空剩余输出, 再结束.
        if let Ok(Some(_status)) = child.try_wait() {
            drain_output(
                &mut chunk_rx,
                &out,
                &session_id,
                &mut seq,
                &mut last_activity,
            );
            break CloseReason::ProcessExited;
        }

        if started.elapsed() >= max_duration {
            break CloseReason::MaxDuration;
        }

        // 空闲超时: 输出与输入都算作活跃. 用户持续输入但 shell 无输出时,
        // 会话不应被误判为空闲.
        let input_idle = last_input_at
            .lock()
            .map(|guard| guard.elapsed())
            .unwrap_or(idle_timeout);
        if last_activity.elapsed() >= idle_timeout && input_idle >= idle_timeout {
            break CloseReason::IdleTimeout;
        }

        tokio::select! {
            chunk = chunk_rx.recv() => {
                let Some(first) = chunk else {
                    break CloseReason::ProcessExited;
                };
                let mut batch = first;
                // 在窗口内继续聚合, 减少消息数量.
                let flush_at = Instant::now() + Duration::from_millis(FLUSH_MS);
                while batch.len() < FLUSH_BYTES {
                    let remaining = flush_at.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match tokio::time::timeout(remaining, chunk_rx.recv()).await {
                        Ok(Some(next)) => batch.extend_from_slice(&next),
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }

                seq += 1;
                if out
                    .send(serialize(&ClientMessage::TerminalOutput {
                        session_id: session_id.clone(),
                        seq,
                        data: BASE64.encode(&batch),
                    }))
                    .is_err()
                {
                    break CloseReason::Error;
                }
                last_activity = Instant::now();
            }

            Some(size) = resize_rx.recv() => {
                let next_cols = size.0.clamp(MIN_COLS, MAX_COLS);
                let next_rows = size.1.clamp(MIN_ROWS, MAX_ROWS);
                if pair
                    .master
                    .resize(PtySize {
                        rows: next_rows,
                        cols: next_cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .is_err()
                {
                    log::debug!("PTY resize 失败, 忽略");
                }
                last_activity = Instant::now();
            }

            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    };

    // 终止顺序: 先杀子进程让读端 EOF, 再逐级等待阻塞线程.
    kill_tree(&mut child);
    let _ = child.wait();

    // 读端随子进程退出而 EOF, 但仍设上限, 避免异常情况下卡住.
    let _ = tokio::time::timeout(JOIN_TIMEOUT, reader_handle).await;

    // 显式唤醒写入线程并等待其退出.
    // 不使用 drop(input_rx): 接收端已被移入闭包; 也不能依赖 sender 被 drop,
    // 因为 SessionHandle 由 main 持有, 释放发生在 run_session 返回之后.
    // 若在此直接 await, shell 自行退出时写入线程会永久阻塞, 执行槽无法释放.
    let _ = shutdown_tx.send(None);
    let _ = tokio::time::timeout(JOIN_TIMEOUT, writer_handle).await;

    reason
}

/// 终止子进程及其可能派生的子进程.
///
/// Unix 上 PTY 子进程本身是会话首进程, 直接 kill 即可; Windows 上 ConPTY
/// 派生的子进程需要 taskkill /T 才能一并清理.
fn kill_tree(child: &mut Box<dyn portable_pty::Child + Send + Sync>) {
    #[cfg(windows)]
    {
        if let Some(pid) = child.process_id() {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
    let _ = child.kill();
}

/// 子进程退出后尽可能取走缓冲区中剩余的输出, 避免丢失最后的提示符.
fn drain_output(
    chunk_rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    out: &mpsc::UnboundedSender<String>,
    session_id: &str,
    seq: &mut u64,
    last_activity: &mut Instant,
) {
    let mut batch = Vec::new();
    while let Ok(chunk) = chunk_rx.try_recv() {
        batch.extend_from_slice(&chunk);
        if batch.len() >= FLUSH_BYTES {
            break;
        }
    }
    if batch.is_empty() {
        return;
    }
    *seq += 1;
    *last_activity = Instant::now();
    let _ = out.send(serialize(&ClientMessage::TerminalOutput {
        session_id: session_id.to_string(),
        seq: *seq,
        data: BASE64.encode(&batch),
    }));
}

/// 用白名单重建会话环境: 先清空继承的全部变量, 再逐项放行.
///
/// 采用白名单而不是黑名单, 是因为新增一个 Agent 变量时黑名单会静默漏掉它,
/// 而白名单默认不传递任何未列出的变量.
fn apply_session_env(builder: &mut CommandBuilder) {
    builder.env_clear();
    for key in SESSION_ENV_ALLOWLIST {
        if let Some(value) = std::env::var_os(key) {
            builder.env(*key, value);
        }
    }
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
}

/// 选择 shell. 只接受白名单内的绝对路径, 否则回退到 `/bin/sh`.
///
/// 直接使用 `$SHELL` 会让被污染的环境变量决定执行哪个解释器; 这里用白名单
/// 收敛该风险, 同时保留用户偏好.
fn resolve_shell() -> String {
    #[cfg(windows)]
    {
        // ConPTY 下固定使用 PowerShell, 不读取环境变量.
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        match std::env::var("SHELL") {
            Ok(candidate) if ALLOWED_SHELLS.contains(&candidate.as_str()) => candidate,
            Ok(candidate) => {
                log::warn!("$SHELL={candidate} 不在白名单内, 回退到 /bin/sh");
                "/bin/sh".to_string()
            }
            Err(_) => "/bin/sh".to_string(),
        }
    }
}

pub fn serialize(message: &ClientMessage) -> String {
    serde_json::to_string(message).unwrap_or_default()
}

/// 解码前端下发的 base64 输入; 超限或非法时返回 None.
///
/// 先按 base64 长度估算解码后大小, 避免为超大输入分配内存后才拒绝.
pub fn decode_input(data: &str) -> Option<Vec<u8>> {
    // base64 每 4 个字符对应 3 字节, 留出 padding 余量.
    let max_encoded = MAX_INPUT_BYTES.div_ceil(3) * 4;
    if data.len() > max_encoded {
        return None;
    }
    let decoded = BASE64.decode(data).ok()?;
    if decoded.len() > MAX_INPUT_BYTES {
        return None;
    }
    Some(decoded)
}

#[cfg(test)]
mod tests {
    use super::{
        apply_session_env, decode_input, resolve_shell, CloseReason, MAX_COLS, MAX_INPUT_BYTES,
        MAX_ROWS, MIN_COLS, MIN_ROWS, SESSION_ENV_ALLOWLIST,
    };
    use base64::Engine as _;
    use portable_pty::CommandBuilder;
    use std::ffi::OsStr;

    #[test]
    fn decodes_base64_input() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"ls -la\n");
        assert_eq!(decode_input(&encoded).as_deref(), Some(&b"ls -la\n"[..]));
    }

    #[test]
    fn rejects_invalid_base64() {
        assert!(decode_input("!!!!").is_none());
    }

    #[test]
    fn rejects_oversized_input() {
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(vec![b'a'; MAX_INPUT_BYTES + 1]);
        assert!(decode_input(&encoded).is_none());
    }

    #[test]
    fn rejects_oversized_input_before_decoding() {
        // 超长但格式合法的 base64 必须在解码前被拦下.
        let encoded = "QUFB".repeat((MAX_INPUT_BYTES / 3) + 1024);
        assert!(decode_input(&encoded).is_none());
    }

    #[test]
    fn close_reasons_match_protocol_strings() {
        assert_eq!(CloseReason::ClosedByUser.as_str(), "closed_by_user");
        assert_eq!(CloseReason::ProcessExited.as_str(), "process_exited");
        assert_eq!(CloseReason::IdleTimeout.as_str(), "idle_timeout");
        assert_eq!(CloseReason::MaxDuration.as_str(), "max_duration");
        assert_eq!(CloseReason::Error.as_str(), "error");
    }

    #[test]
    fn clamps_produce_valid_sizes() {
        // 越界值必须被钳制到合法范围, 而不是被原样透传.
        let clamp_cols = |v: u16| v.clamp(MIN_COLS, MAX_COLS);
        let clamp_rows = |v: u16| v.clamp(MIN_ROWS, MAX_ROWS);

        assert_eq!(clamp_cols(0), MIN_COLS);
        assert_eq!(clamp_cols(u16::MAX), MAX_COLS);
        assert_eq!(clamp_cols(120), 120);
        assert_eq!(clamp_rows(0), MIN_ROWS);
        assert_eq!(clamp_rows(u16::MAX), MAX_ROWS);
        assert_eq!(clamp_rows(40), 40);
    }

    #[test]
    fn shell_is_absolute_and_allowlisted() {
        let shell = resolve_shell();
        assert!(
            shell.starts_with('/') || cfg!(windows),
            "shell 必须是绝对路径: {shell}"
        );
    }

    #[test]
    fn session_env_drops_inherited_credentials() {
        // 先塞入一个 Agent 变量, 重建环境后必须消失.
        let mut builder = CommandBuilder::new("/bin/sh");
        builder.env("MONIX_AGENT_TOKEN", "secret");
        apply_session_env(&mut builder);

        assert!(builder.get_env("MONIX_AGENT_TOKEN").is_none());
        assert_eq!(builder.get_env("TERM"), Some(OsStr::new("xterm-256color")));
    }

    #[test]
    fn env_allowlist_excludes_agent_configuration() {
        // 白名单必须只含系统与 shell 需要的变量, 不能出现 Agent 自身的配置.
        for key in SESSION_ENV_ALLOWLIST {
            assert!(
                !key.starts_with("MONIX_"),
                "白名单不得包含 Agent 变量: {key}"
            );
        }
        assert!(!SESSION_ENV_ALLOWLIST.contains(&"RUST_LOG"));
        assert!(SESSION_ENV_ALLOWLIST.contains(&"PATH"));
    }
}
