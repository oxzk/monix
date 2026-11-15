//! 交互式 PTY 会话.
//!
//! 与一次性命令不同, PTY 会话是长生命周期的: 有输入、输出、resize 与三种终止
//! 原因(用户关闭 / 空闲超时 / 最长时长). 输出不做累积截断, 因为交互式程序
//! (如 vim、top)一旦输出被截断就失去响应.
//!
//! 输出按 ternox 的做法写入有界缓冲并携带单调递增序列号:
//! 前端断线/刷新后携带最后处理的 seq 续传, 只重放其后的内容;
//! 若续传位置已被淘汰, 返回空洞标记, 由前端清屏后从 0 重新拉取.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use tokio::sync::mpsc;

use crate::limits::{
    TERMINAL_COLS_MAX, TERMINAL_COLS_MIN, TERMINAL_IDLE_TIMEOUT_MAX, TERMINAL_IDLE_TIMEOUT_MIN,
    TERMINAL_INPUT_MAX_BYTES, TERMINAL_MAX_DURATION_MAX, TERMINAL_MAX_DURATION_MIN,
    TERMINAL_OUTPUT_BATCH_MAX_BYTES, TERMINAL_ROWS_MAX, TERMINAL_ROWS_MIN,
};
use crate::protocol::{ClientMessage, Outbound};

/// 输出合并窗口: 先到者触发, 降低按键回显延迟.
const FLUSH_MS: u64 = 16;
/// 单批最大字节数, 避免一次发送过大的帧.
const FLUSH_BYTES: usize = TERMINAL_OUTPUT_BATCH_MAX_BYTES;
/// 单条输入消息上限(字节数).
pub const MAX_INPUT_BYTES: usize = TERMINAL_INPUT_MAX_BYTES;
/// 有界输出缓冲上限: 只用于断线续传, 不是历史留存.
pub const OUTPUT_BUFFER_BYTES: usize = 256 * 1024;
/// 输入通道容量(流量控制: 写满即丢弃输入并提示).
pub const INPUT_CHANNEL_CAPACITY: usize = 128;
/// 终止时等待 Shell 自行退出的上限, 超时后强制 SIGKILL.
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
/// 终端尺寸硬性范围.
pub const MIN_COLS: u16 = TERMINAL_COLS_MIN;
pub const MAX_COLS: u16 = TERMINAL_COLS_MAX;
pub const MIN_ROWS: u16 = TERMINAL_ROWS_MIN;
pub const MAX_ROWS: u16 = TERMINAL_ROWS_MAX;
/// 等待阻塞读写线程收尾的上限, 超时后不再等待, 避免会话结束卡死执行槽.
const JOIN_TIMEOUT: Duration = Duration::from_secs(2);

/// 二进制协议帧类型: 与前端保持一致.
pub const INPUT_TYPE: u8 = 0x01;
pub const OUTPUT_TYPE: u8 = 0x02;
/// 输出帧头部长度: 1 字节类型 + 8 字节大端序列号.
pub const OUTPUT_HEADER_LEN: usize = 1 + 8;

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

/// 会话控制句柄: 由 main 持有, 用于转发输入/resume/resize/关闭.
pub struct SessionHandle {
    pub input_tx: mpsc::Sender<Option<Vec<u8>>>,
    pub resume_tx: mpsc::UnboundedSender<u64>,
    pub resize_tx: mpsc::UnboundedSender<(u16, u16)>,
    pub cancel: Arc<AtomicBool>,
    /// 输入过载只提示一次, 避免刷屏.
    pub overflow_warned: Arc<AtomicBool>,
    /// 最近一次收到输入的时间. 输入吞吐高, 不在主循环逐条转发, 因此
    /// 由句柄记录时间戳, 让空闲超时把"持续输入"也算作活跃.
    pub last_input_at: Arc<Mutex<Instant>>,
}

impl SessionHandle {
    /// 记录一次输入活动, 供空闲超时判断.
    pub fn touch_input(&self) {
        if let Ok(mut guard) = self.last_input_at.lock() {
            *guard = Instant::now();
        }
    }
}

/* ----------------------------- 输出缓冲 ----------------------------- */

/// 单个输出块.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub sequence: u64,
    pub data: Arc<[u8]>,
}

/// 续传结果.
#[derive(Debug)]
pub enum Replay {
    /// 可重放的输出块(可能为空).
    Chunks(Vec<Chunk>),
    /// 续传位置已超出缓冲保留范围.
    Gap,
}

/// 有界输出缓冲: 按块存储并带单调递增序列号, 超出容量淘汰最早的块.
pub struct OutputBuffer {
    chunks: VecDeque<Chunk>,
    bytes: usize,
    max_bytes: usize,
    next_sequence: u64,
}

impl OutputBuffer {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            max_bytes,
            next_sequence: 1,
        }
    }

    /// 追加输出, 返回该块的序列号.
    pub fn append(&mut self, data: &[u8]) -> u64 {
        if data.is_empty() {
            return self.latest();
        }
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.chunks.push_back(Chunk {
            sequence,
            data: Arc::from(data),
        });
        self.bytes += data.len();
        // 至少保留一块, 避免大块输出导致缓冲永远为空.
        while self.bytes > self.max_bytes && self.chunks.len() > 1 {
            if let Some(oldest) = self.chunks.pop_front() {
                self.bytes -= oldest.data.len();
            }
        }
        sequence
    }

    /// 最新序列号; 缓冲为空时为 0.
    pub fn latest(&self) -> u64 {
        self.chunks.back().map(|chunk| chunk.sequence).unwrap_or(0)
    }

    /// 回放 `sequence > last_sequence` 的输出.
    ///
    /// `last_sequence == 0` 表示从头开始, 不做空洞检查;
    /// 其余情况若客户端位置超前或最早的保留块与客户端位置不连续, 判定为空洞.
    pub fn replay_after(&self, last_sequence: u64) -> Replay {
        if last_sequence > 0 {
            let latest = self.latest();
            if last_sequence > latest
                || self
                    .chunks
                    .front()
                    .is_some_and(|front| front.sequence > last_sequence.saturating_add(1))
            {
                return Replay::Gap;
            }
        }
        Replay::Chunks(
            self.chunks
                .iter()
                .filter(|chunk| chunk.sequence > last_sequence)
                .cloned()
                .collect(),
        )
    }
}

/// 构造二进制输出帧: `[0x02][u64 大端 seq][数据]`.
pub fn output_frame(sequence: u64, data: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(OUTPUT_HEADER_LEN + data.len());
    frame.push(OUTPUT_TYPE);
    frame.extend_from_slice(&sequence.to_be_bytes());
    frame.extend_from_slice(data);
    frame
}

/// 解析输入帧: 只接受 `0x01 + 数据` 且不超过上限.
pub fn decode_input_frame(frame: &[u8]) -> Option<Vec<u8>> {
    if frame.len() < 2 || frame[0] != INPUT_TYPE {
        return None;
    }
    let payload = &frame[1..];
    if payload.len() > MAX_INPUT_BYTES {
        return None;
    }
    Some(payload.to_vec())
}

/* ----------------------------- 会话主流程 ----------------------------- */

/// 启动一个 PTY 会话并等待其结束.
///
/// 返回结束原因; 调用方负责发送 `terminal.closed` 并释放执行槽.
///
/// `shutdown_tx` 用于在会话结束时显式唤醒写入线程 (发送 `None`).
/// 不能依赖 sender 被 drop 来结束写入线程: `SessionHandle` 由 main 持有,
/// 其释放发生在 `run_session` 返回之后, 会导致 shell 自行退出时永久阻塞.
#[allow(clippy::too_many_arguments)]
pub async fn run_session(
    request: PtySessionRequest,
    out: mpsc::UnboundedSender<Outbound>,
    mut input_rx: mpsc::Receiver<Option<Vec<u8>>>,
    shutdown_tx: mpsc::Sender<Option<Vec<u8>>>,
    mut resume_rx: mpsc::UnboundedReceiver<u64>,
    mut resize_rx: mpsc::UnboundedReceiver<(u16, u16)>,
    cancel: Arc<AtomicBool>,
    last_input_at: Arc<Mutex<Instant>>,
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
    // 只在 HOME 真实存在时设置工作目录.
    //
    // systemd 单元创建的服务账号带 --no-create-home, HOME 可能指向不存在的路径,
    // 此时直接 cwd 会让 spawn_command 失败, 表现为终端一建立就报 error.
    if let Some(home) = std::env::var_os("HOME") {
        let home_path = std::path::Path::new(&home);
        if home_path.is_dir() {
            builder.cwd(home);
        } else {
            log::warn!(
                "HOME 目录不存在, 终端以默认工作目录启动: {}",
                home_path.display()
            );
        }
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
    #[cfg(unix)]
    let pgid = pair.master.process_group_leader();
    if let Err(error) = send_text(
        &out,
        ClientMessage::TerminalOpened {
            session_id: session_id.clone(),
            pid,
        },
    ) {
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
    let max_duration = Duration::from_secs(
        request
            .max_duration_secs
            .clamp(TERMINAL_MAX_DURATION_MIN, TERMINAL_MAX_DURATION_MAX),
    );
    let idle_timeout = Duration::from_secs(
        request
            .idle_timeout_secs
            .clamp(TERMINAL_IDLE_TIMEOUT_MIN, TERMINAL_IDLE_TIMEOUT_MAX),
    );
    let mut last_activity = Instant::now();
    let mut buffer = OutputBuffer::new(OUTPUT_BUFFER_BYTES);

    let reason = loop {
        if cancel.load(Ordering::SeqCst) {
            break CloseReason::ClosedByUser;
        }

        // 子进程退出: 先排空剩余输出, 再结束.
        if let Ok(Some(_status)) = child.try_wait() {
            drain_output(&mut chunk_rx, &out, &mut buffer, &mut last_activity);
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

                let seq = buffer.append(&batch);
                if out.send(Outbound::Binary(output_frame(seq, &batch))).is_err() {
                    break CloseReason::Error;
                }
                last_activity = Instant::now();
            }

            Some(last_seq) = resume_rx.recv() => {
                match buffer.replay_after(last_seq) {
                    Replay::Chunks(chunks) => {
                        let mut failed = false;
                        for chunk in chunks {
                            if out
                                .send(Outbound::Binary(output_frame(chunk.sequence, &chunk.data)))
                                .is_err()
                            {
                                failed = true;
                                break;
                            }
                        }
                        if failed {
                            break CloseReason::Error;
                        }
                        let _ = send_text(
                            &out,
                            ClientMessage::TerminalResumed {
                                session_id: session_id.clone(),
                                seq: buffer.latest(),
                            },
                        );
                    }
                    Replay::Gap => {
                        let _ = send_text(
                            &out,
                            ClientMessage::TerminalGap {
                                session_id: session_id.clone(),
                            },
                        );
                    }
                }
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

    // 终止顺序: 释放 master → 按进程组 SIGTERM → 宽限等待 → SIGKILL → 兜底 kill.
    // 注意: reader 克隆的 fd 仍持有 master, SIGHUP 的时机取决于最后一个
    // master fd 关闭, 因此可靠的终止手段是下面的 SIGTERM/SIGKILL 进程组信号.
    // 主动 setsid 脱离会话的进程不在保证范围内, 这是操作系统边界.
    drop(pair);
    // child 是 Box<dyn Child>, 这里显式解引用成 trait 对象;
    // 依赖自动解引用会让编译器先尝试对 Box 本身做 unsize 转换而报错.
    #[cfg(unix)]
    terminate(&mut *child, pgid).await;
    #[cfg(not(unix))]
    terminate(&mut *child).await;

    // 读端随子进程退出而 EOF, 但仍设上限, 避免异常情况下卡住.
    let _ = tokio::time::timeout(JOIN_TIMEOUT, reader_handle).await;

    // 显式唤醒写入线程并等待其退出.
    // 不使用 drop(input_rx): 接收端已被移入闭包; 也不能依赖 sender 被 drop,
    // 因为 SessionHandle 由 main 持有, 释放发生在 run_session 返回之后.
    match shutdown_tx.try_send(None) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(_)) => {
            // 通道已满: 带超时等待一次, 让写入线程在处理完积压后收到停止信号.
            let _ = tokio::time::timeout(JOIN_TIMEOUT, shutdown_tx.send(None)).await;
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {}
    }
    let _ = tokio::time::timeout(JOIN_TIMEOUT, writer_handle).await;

    reason
}

/// 向出站通道发送 JSON 控制消息.
fn send_text(out: &mpsc::UnboundedSender<Outbound>, message: ClientMessage) -> Result<(), String> {
    let text = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    out.send(Outbound::Text(text))
        .map_err(|_| "outbound channel closed".to_string())
}

/// 子进程退出后尽可能取走缓冲区中剩余的输出, 避免丢失最后的提示符.
fn drain_output(
    chunk_rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    out: &mpsc::UnboundedSender<Outbound>,
    buffer: &mut OutputBuffer,
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
    let seq = buffer.append(&batch);
    let _ = out.send(Outbound::Binary(output_frame(seq, &batch)));
    *last_activity = Instant::now();
}

/// 终止子进程及其进程组.
///
/// Unix: 先 SIGTERM 进程组并等待宽限期, 超时后 SIGKILL, 最后兜底 kill.
/// Windows: ConPTY 派生的子进程需要 taskkill /T 才能一并清理.
#[cfg(unix)]
async fn terminate(child: &mut (dyn Child + Send + Sync), pgid: Option<i32>) {
    if let Some(pgid) = pgid {
        unsafe {
            libc::kill(-pgid, libc::SIGTERM);
        }
        let deadline = Instant::now() + TERMINATE_GRACE;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(unix))]
async fn terminate(child: &mut (dyn Child + Send + Sync)) {
    if let Some(pid) = child.process_id() {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
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

/// 从 /etc/passwd 读取当前用户的登录 shell.
///
/// systemd 启动的服务没有登录会话, `$SHELL` 通常为空; 只靠环境变量会
/// 一律退到 `/bin/sh`. 这里按 euid 查 passwd 的登录 shell(如 root 的
/// /bin/bash), 让终端打开用户实际使用的 shell.
#[cfg(unix)]
fn login_shell_from_passwd() -> Option<String> {
    let uid = unsafe { libc::geteuid() };
    let content = std::fs::read_to_string("/etc/passwd").ok()?;
    for line in content.lines() {
        let mut fields = line.split(':');
        // 字段: name:password:uid:gid:gecos:home:shell
        let _name = fields.next()?;
        let _password = fields.next()?;
        let id = fields.next()?;
        if id.parse::<u32>().ok() != Some(uid) {
            continue;
        }
        // 跳过 gid、gecos、home, 取第 7 个字段; 字段不足的行直接跳过.
        let shell = match fields.nth(3) {
            Some(value) => value.trim(),
            None => continue,
        };
        if !shell.is_empty() {
            return Some(shell.to_string());
        }
    }
    None
}

/// 选择 shell. 只接受白名单内的绝对路径, 否则回退到常见 shell.
///
/// 优先级: 显式 `$SHELL` → 用户登录 shell(/etc/passwd) → 存在性探测.
/// 全部经白名单收敛, 避免被污染的环境变量引导启动非预期解释器.
fn resolve_shell() -> String {
    #[cfg(windows)]
    {
        // ConPTY 下固定使用 PowerShell, 不读取环境变量.
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        // 1) 显式设置的 $SHELL(白名单内): 手动启动或交互式安装时可用.
        if let Ok(candidate) = std::env::var("SHELL") {
            if ALLOWED_SHELLS.contains(&candidate.as_str()) {
                return candidate;
            }
            log::warn!("$SHELL={candidate} 不在白名单内, 忽略");
        }

        // 2) 当前用户的登录 shell: systemd 下 $SHELL 通常为空.
        if let Some(shell) = login_shell_from_passwd() {
            if ALLOWED_SHELLS.contains(&shell.as_str()) {
                return shell;
            }
            log::warn!("登录 shell {shell} 不在白名单内, 回退到常见 shell");
        }

        // 3) 按常见程度探测实际存在的 shell.
        for candidate in [
            "/bin/bash",
            "/usr/bin/bash",
            "/bin/zsh",
            "/usr/bin/zsh",
            "/bin/sh",
        ] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
        "/bin/sh".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_session_env, decode_input_frame, output_frame, resolve_shell, CloseReason,
        OutputBuffer, Replay, ALLOWED_SHELLS, MAX_COLS, MAX_INPUT_BYTES, MAX_ROWS, MIN_COLS,
        MIN_ROWS, OUTPUT_HEADER_LEN, OUTPUT_TYPE, SESSION_ENV_ALLOWLIST,
    };
    use portable_pty::CommandBuilder;
    use std::ffi::OsStr;

    #[test]
    fn appends_and_replays_output() {
        let mut buffer = OutputBuffer::new(64 * 1024);
        let seq1 = buffer.append(b"hello");
        let seq2 = buffer.append(b" world");
        assert_eq!((seq1, seq2), (1, 2));
        assert_eq!(buffer.latest(), 2);

        let Replay::Chunks(chunks) = buffer.replay_after(0) else {
            panic!("expected chunks");
        };
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].sequence, 1);

        let Replay::Chunks(chunks) = buffer.replay_after(1) else {
            panic!("expected chunks");
        };
        assert_eq!(chunks.len(), 1);
        assert_eq!(&*chunks[0].data, b" world");
    }

    #[test]
    fn replay_reports_gap_for_ahead_position() {
        let mut buffer = OutputBuffer::new(64 * 1024);
        buffer.append(b"hello");
        assert!(matches!(buffer.replay_after(9), Replay::Gap));
    }

    #[test]
    fn replay_reports_gap_after_eviction() {
        // 上限很小, 追加多块后最早的块被淘汰.
        let mut buffer = OutputBuffer::new(16);
        for i in 0..10u8 {
            buffer.append(&[i; 8]);
        }
        // 最早保留块已不是 1, 从 0 之后请求但位置不连续.
        assert!(matches!(buffer.replay_after(1), Replay::Gap));
    }

    #[test]
    fn buffer_keeps_at_least_one_chunk() {
        let mut buffer = OutputBuffer::new(1);
        buffer.append(b"big chunk");
        assert_eq!(buffer.latest(), 1);
        assert!(matches!(buffer.replay_after(0), Replay::Chunks(_)));
    }

    #[test]
    fn empty_replay_is_not_a_gap() {
        let buffer = OutputBuffer::new(1024);
        let Replay::Chunks(chunks) = buffer.replay_after(0) else {
            panic!("expected chunks");
        };
        assert!(chunks.is_empty());
    }

    #[test]
    fn output_frame_encodes_header() {
        let frame = output_frame(7, b"abc");
        assert_eq!(frame.len(), OUTPUT_HEADER_LEN + 3);
        assert_eq!(frame[0], OUTPUT_TYPE);
        assert_eq!(u64::from_be_bytes(frame[1..9].try_into().unwrap()), 7);
        assert_eq!(&frame[9..], b"abc");
    }

    #[test]
    fn decodes_input_frame() {
        assert_eq!(
            decode_input_frame(&[0x01, b'l', b's']).as_deref(),
            Some(&b"ls"[..])
        );
        assert!(decode_input_frame(&[]).is_none());
        assert!(decode_input_frame(&[0x01]).is_none());
        assert!(decode_input_frame(&[0x02, b'x']).is_none());
    }

    #[test]
    fn rejects_oversized_input_frame() {
        let mut frame = vec![0x01u8];
        frame.extend(std::iter::repeat(b'a').take(MAX_INPUT_BYTES + 1));
        assert!(decode_input_frame(&frame).is_none());
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
        #[cfg(unix)]
        assert!(
            ALLOWED_SHELLS.contains(&shell.as_str()),
            "shell 必须在白名单内: {shell}"
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
