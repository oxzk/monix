mod collector;
mod command;
mod config;
mod limits;
mod protocol;
mod pty;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use collector::Collector;
use command::{CommandRegistry, CommandRequest};
use config::{fetch_remote_config, Config, PublicIps};
use limits::{COLLECT_INTERVAL_MAX, COLLECT_INTERVAL_MIN};
use protocol::{ClientMessage, MetricsMessage, Outbound, ServerMessage};
use pty::{PtySessionRequest, SessionHandle};

/// 重连退避: 指数增长 + 抖动, 避免多台 Agent 同步重连.
const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 60_000;
const HEARTBEAT_MS: u64 = 15_000;
/// 断线时等待会话收尾的上限.
const SHUTDOWN_GRACE_MS: u64 = 2_000;
/// 凭据类错误(401/403)说明令牌无效或服务器已被删除/禁用, 重试没有意义.
/// 这类情况下退避到更长间隔, 避免所有失联机器持续打服务端.
const AUTH_BACKOFF_MS: u64 = 300_000;

/// 连接失败分类, 决定重连节奏.
#[derive(Debug)]
enum SessionError {
    /// 凭据无效: 需要人工干预, 不应高频重试.
    Auth(u16),
    /// 网络或协议错误: 按指数退避重试.
    ///
    /// `connected` 表示本次会话是否曾成功建立连接: 已连上后断线属于
    /// 环境抖动(如服务端发布导致的 DO 重建), 重连应从零退避快速重试;
    /// 只有"连接都没建立"的连续失败才逐次累加退避.
    Transient {
        error: anyhow::Error,
        connected: bool,
    },
}

/// 双栈公网地址探测节奏: 启动后先等待(给 WS 连接让路), 之后每 24 小时一次.
const IP_PROBE_INITIAL_DELAY_SECS: u64 = 15;
const IP_PROBE_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// 上报探测结果. 仅在至少一个族成功时上报 —— 两族全失败视为断网, 保留服务端已有地址.
async fn report_public_ips(config: &Config, ips: &PublicIps) -> anyhow::Result<()> {
    #[derive(serde::Serialize)]
    struct Report {
        ipv4: Option<String>,
        ipv6: Option<String>,
    }

    let url = format!("{}/api/v1/agent/ip", config.http_base());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    client
        .post(&url)
        .bearer_auth(&config.token)
        .header("X-Monix-Agent-Version", env!("CARGO_PKG_VERSION"))
        .json(&Report {
            ipv4: ips.ipv4.clone(),
            ipv6: ips.ipv6.clone(),
        })
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// 双栈公网地址探测循环: 与 WS 会话独立运行, 失败静默, 下个周期重试.
async fn ip_probe_loop(config: Arc<Config>) {
    tokio::time::sleep(Duration::from_secs(IP_PROBE_INITIAL_DELAY_SECS)).await;
    loop {
        let ips = config::probe_public_ips(&config).await;
        if ips.ipv4.is_some() || ips.ipv6.is_some() {
            match report_public_ips(&config, &ips).await {
                Ok(()) => {
                    log::info!(
                        "已上报公网地址: v4={:?}, v6={:?}",
                        ips.ipv4.as_deref().unwrap_or("无"),
                        ips.ipv6.as_deref().unwrap_or("无")
                    );
                }
                Err(error) => log::warn!("上报公网地址失败: {error:#}"),
            }
        } else {
            log::debug!("双栈探测均未成功, 本周期不上报");
        }
        tokio::time::sleep(Duration::from_secs(IP_PROBE_INTERVAL_SECS)).await;
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let config = Arc::new(Config::from_env()?);
    log::info!("Monix Agent 启动, 目标={}", config.server_url);

    // 双栈地址探测: 独立任务, 不随 WS 会话重建.
    tokio::spawn(ip_probe_loop(config.clone()));

    let mut attempt: u32 = 0;

    loop {
        let outcome = tokio::select! {
            result = run_session(&config) => result,
            signal = shutdown_signal() => {
                // 服务管理器要求退出: 不再重连, 让 run_session 之外的收尾逻辑
                // (终止 PTY 子进程) 通过取消信号完成.
                log::info!("收到退出信号 {signal}, 正在停止 Agent");
                break;
            }
        };

        match outcome {
            Ok(()) => {
                log::info!("连接正常关闭");
                attempt = 0;
            }
            Err(SessionError::Auth(status)) => {
                attempt = attempt.saturating_add(1);
                log::error!(
                    "凭据被拒绝 (HTTP {status}). 请检查 MONIX_AGENT_TOKEN 是否有效, 或该服务器是否已被删除/禁用. \
                     将在 {} 秒后重试",
                    AUTH_BACKOFF_MS / 1000
                );
                tokio::time::sleep(Duration::from_millis(AUTH_BACKOFF_MS)).await;
                continue;
            }
            Err(SessionError::Transient { error, connected }) => {
                if connected {
                    attempt = 0;
                } else {
                    attempt = attempt.saturating_add(1);
                }
                log::warn!("连接中断: {error}");
            }
        }

        let base = (RECONNECT_BASE_MS.saturating_mul(1u64 << attempt.min(6))).min(RECONNECT_MAX_MS);
        let jitter = (base as f64 * 0.3 * rand::random::<f64>()) as u64;
        let delay = base + jitter;
        log::info!("{delay} ms 后重连");
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }

    Ok(())
}

/// 等待 SIGTERM / SIGINT (Unix) 或 Ctrl-C.
///
/// 没有这一步时, `systemctl restart` 会让进程立刻终止, `run_session` 的
/// 收尾逻辑(终止进程组、关闭 PTY)根本不会执行, 每次升级都遗留孤儿 shell.
async fn shutdown_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(error) => {
                log::warn!("无法注册 SIGTERM 处理器: {error}");
                // 注册失败时退化为永不触发, 不影响正常重连逻辑.
                return std::future::pending().await;
            }
        };
        let mut int = match signal(SignalKind::interrupt()) {
            Ok(signal) => signal,
            Err(error) => {
                log::warn!("无法注册 SIGINT 处理器: {error}");
                return std::future::pending().await;
            }
        };
        tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "Ctrl-C"
    }
}

async fn run_session(config: &Config) -> Result<(), SessionError> {
    let url = config.ws_url();
    let mut request =
        url.clone()
            .into_client_request()
            .map_err(|error| SessionError::Transient {
                error: anyhow::anyhow!("{error}"),
                connected: false,
            })?;
    // 长期凭据放在 Authorization 头, 不放 URL.
    let auth_header =
        HeaderValue::from_str(&format!("Bearer {}", config.token)).map_err(|error| {
            SessionError::Transient {
                error: anyhow::anyhow!("令牌格式无效: {error}"),
                connected: false,
            }
        })?;
    request.headers_mut().insert("Authorization", auth_header);
    request.headers_mut().insert(
        "X-Monix-Agent-Version",
        HeaderValue::from_str(env!("CARGO_PKG_VERSION")).map_err(|error| {
            SessionError::Transient {
                error: anyhow::anyhow!("{error}"),
                connected: false,
            }
        })?,
    );
    request.headers_mut().insert(
        "X-Monix-Platform",
        HeaderValue::from_str(&config::platform()).map_err(|error| SessionError::Transient {
            error: anyhow::anyhow!("{error}"),
            connected: false,
        })?,
    );

    let (socket, _response) = connect_async(request)
        .await
        .map_err(|error| classify_connect_error(&error))?;

    // 建立连接后立刻拉取服务端配置: 采集间隔由服务端决定, 环境变量只是初值.
    let mut collect_interval_ms = config.collect_interval_ms;
    if let Some(remote) = fetch_remote_config(config).await {
        if let Some(interval) = remote.collect_interval_ms {
            collect_interval_ms = interval.clamp(COLLECT_INTERVAL_MIN, COLLECT_INTERVAL_MAX);
            log::info!("应用服务端采集间隔: {collect_interval_ms} ms");
        }
    }

    let (mut write, mut read) = socket.split();

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Outbound>();
    let registry = Arc::new(CommandRegistry::new());
    // 活动终端会话: session_id -> 控制句柄.
    let mut sessions: HashMap<String, SessionHandle> = HashMap::new();
    // PTY 任务结束后回报 session_id, 由主循环清理句柄.
    let (ended_tx, mut ended_rx) = mpsc::unbounded_channel::<String>();

    // 发送任务: 所有出站消息统一经此通道串行化(JSON 控制消息与终端二进制帧).
    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            let frame = match message {
                Outbound::Text(text) => Message::Text(text),
                Outbound::Binary(bytes) => Message::Binary(bytes),
            };
            if write.send(frame).await.is_err() {
                break;
            }
        }
    });

    let mut collector = Collector::new();
    // 上报间隔可由服务端按公开页订阅数动态调整(report_interval 消息).
    let report_interval_ms = Arc::new(AtomicU64::new(collect_interval_ms));
    let mut next_metrics_at = tokio::time::Instant::now();
    let mut heartbeat_timer = tokio::time::interval(Duration::from_millis(HEARTBEAT_MS));

    log::info!("已连接, 采集间隔 {collect_interval_ms} ms");

    let result = loop {
        tokio::select! {
            // 动态上报: 间隔由 report_interval 消息调整, 首帧立即采集.
            _ = tokio::time::sleep_until(next_metrics_at) => {
                let interval = Duration::from_millis(report_interval_ms.load(Ordering::SeqCst));
                next_metrics_at = tokio::time::Instant::now() + interval;

                let metrics = collector.collect(interval);
                let message = MetricsMessage {
                    kind: "metrics",
                    sample_ts: protocol::now_ms(),
                    metrics: &metrics,
                };
                match serde_json::to_string(&message) {
                    Ok(text) => {
                        if out_tx.send(Outbound::Text(text)).is_err() { break Ok(()); }
                    }
                    Err(error) => log::warn!("指标序列化失败: {error}"),
                }
            }

            _ = heartbeat_timer.tick() => {
                // 字面量 "ping": 服务端用 setWebSocketAutoResponse 免唤醒回 "pong".
                if out_tx.send(Outbound::Text("ping".to_string())).is_err() {
                    break Ok(());
                }
            }

            ended = ended_rx.recv() => {
                if let Some(session_id) = ended {
                    sessions.remove(&session_id);
                }
            }

            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        // auto-response 的回包不是 JSON, 直接忽略.
                        if text == "pong" { continue; }
                        handle_server_message(
                            &text,
                            &registry,
                            &mut sessions,
                            out_tx.clone(),
                            ended_tx.clone(),
                            &report_interval_ms,
                        )
                        .await;
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        handle_binary_input(&bytes, &sessions, &out_tx);
                    }
                    Some(Ok(Message::Close(_))) | None => break Ok(()),
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        break Err(SessionError::Transient {
                            error: anyhow::anyhow!("{error}"),
                            connected: true,
                        })
                    }
                }
            }
        }
    };

    // 连接断开: 停止接受新命令, 终止活动执行单元(命令或终端).
    if let Some(active) = registry.cancel_all().await {
        log::warn!("连接断开, 正在终止 {active}");
    }

    // 关闭全部终端会话的输入通道, 让 PTY 任务收尾.
    sessions.clear();

    // 给执行器一点时间完成进程组终止与 PTY 收尾.
    tokio::time::sleep(Duration::from_millis(SHUTDOWN_GRACE_MS)).await;

    drop(out_tx);
    writer.abort();
    result
}

/// 把握手阶段的错误分类为"凭据无效"或"可重试".
///
/// Worker 对无效 Token 返回 401/403, 对已禁用的服务器返回 403.
/// 这些情况重试不会自愈, 需要管理员介入; 其余错误(网络、DNS、代理)按退避重试.
fn classify_connect_error(error: &tokio_tungstenite::tungstenite::Error) -> SessionError {
    use tokio_tungstenite::tungstenite::Error as WsError;

    if let WsError::Http(response) = error {
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            return SessionError::Auth(status);
        }
    }
    SessionError::Transient {
        error: anyhow::anyhow!("{error}"),
        connected: false,
    }
}

/// 处理 Dashboard 下发的终端输入二进制帧(`0x01 + 数据`).
///
/// 单实例共享执行槽, 活动终端会话至多一个, 因此输入帧不需要携带 session id.
fn handle_binary_input(
    frame: &[u8],
    sessions: &HashMap<String, SessionHandle>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
) {
    let Some(payload) = pty::decode_input_frame(frame) else {
        log::debug!("丢弃非法的终端输入帧");
        return;
    };
    let Some((session_id, handle)) = sessions.iter().next() else {
        return;
    };

    // 输入也算活跃: 用户持续敲键但 shell 无输出时不应被判为空闲.
    handle.touch_input();
    match handle.input_tx.try_send(Some(payload)) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(_)) => {
            // 输入过载只提示一次, 避免刷屏.
            if !handle.overflow_warned.swap(true, Ordering::SeqCst) {
                let message = ClientMessage::TerminalError {
                    session_id: session_id.clone(),
                    code: "INPUT_OVERFLOW",
                    message: "输入过载, 部分按键可能已丢失",
                };
                if let Ok(text) = serde_json::to_string(&message) {
                    let _ = out_tx.send(Outbound::Text(text));
                }
            }
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {}
    }
}

async fn handle_server_message(
    text: &str,
    registry: &Arc<CommandRegistry>,
    sessions: &mut HashMap<String, SessionHandle>,
    out_tx: mpsc::UnboundedSender<Outbound>,
    ended_tx: mpsc::UnboundedSender<String>,
    report_interval_ms: &Arc<AtomicU64>,
) {
    let parsed: ServerMessage = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("无法解析服务端消息: {error}");
            return;
        }
    };

    match parsed {
        ServerMessage::CommandExecute(execute) => {
            let flag = Arc::new(AtomicBool::new(false));
            if !registry
                .try_begin_command(&execute.command_id, flag.clone())
                .await
            {
                let command_id = execute.command_id.clone();
                // 明确告诉管理员被拒绝的原因, 而不是只回一个无正文的 failed.
                let _ = out_tx.send(
                    serde_json::to_string(&ClientMessage::CommandOutput {
                        command_id: command_id.clone(),
                        stream: "stderr",
                        seq: 1,
                        data: "该服务器已有执行中的任务\n".to_string(),
                    })
                    .unwrap_or_default()
                    .into(),
                );
                let busy = ClientMessage::CommandFinished {
                    command_id,
                    status: "failed",
                    exit_code: None,
                    started_at: protocol::now_ms(),
                    finished_at: protocol::now_ms(),
                    duration_ms: 0,
                    output_truncated: false,
                };
                let _ = out_tx.send(serde_json::to_string(&busy).unwrap_or_default().into());
                return;
            }

            let command_id = execute.command_id.clone();
            let registry = registry.clone();
            let sender = out_tx.clone();
            tokio::spawn(async move {
                command::execute(
                    CommandRequest {
                        command_id: command_id.clone(),
                        command: execute.command,
                        timeout_seconds: execute.timeout_seconds,
                        max_output_bytes: execute.max_output_bytes,
                    },
                    sender,
                    flag,
                )
                .await;
                registry.finish_command(&command_id).await;
            });
        }

        ServerMessage::CommandCancel { command_id } => {
            if registry.cancel_command(&command_id).await {
                log::info!("收到取消请求 {command_id}");
            }
        }

        ServerMessage::TerminalOpen(open) => {
            let flag = Arc::new(AtomicBool::new(false));
            // 终端与一次性命令共用执行槽, 占用失败立即回执.
            if !registry
                .try_begin_terminal(&open.session_id, flag.clone())
                .await
            {
                let _ = out_tx.send(
                    serde_json::to_string(&ClientMessage::TerminalClosed {
                        session_id: open.session_id,
                        reason: "busy",
                    })
                    .unwrap_or_default()
                    .into(),
                );
                return;
            }

            let (input_tx, input_rx) =
                mpsc::channel::<Option<Vec<u8>>>(pty::INPUT_CHANNEL_CAPACITY);
            let shutdown_tx = input_tx.clone();
            let (resume_tx, resume_rx) = mpsc::unbounded_channel::<u64>();
            let (resize_tx, resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
            let last_input_at = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
            sessions.insert(
                open.session_id.clone(),
                SessionHandle {
                    input_tx,
                    resume_tx,
                    resize_tx,
                    cancel: flag.clone(),
                    overflow_warned: Arc::new(AtomicBool::new(false)),
                    last_input_at: last_input_at.clone(),
                },
            );

            let session_id = open.session_id.clone();
            let registry = registry.clone();
            let sender = out_tx.clone();
            let ended = ended_tx.clone();
            tokio::spawn(async move {
                let reason = pty::run_session(
                    PtySessionRequest {
                        session_id: session_id.clone(),
                        cols: open.cols,
                        rows: open.rows,
                        idle_timeout_secs: open.idle_timeout_seconds,
                        max_duration_secs: open.max_duration_seconds,
                    },
                    sender.clone(),
                    input_rx,
                    shutdown_tx,
                    resume_rx,
                    resize_rx,
                    flag,
                    last_input_at,
                )
                .await;

                let closed = ClientMessage::TerminalClosed {
                    session_id: session_id.clone(),
                    reason: reason.as_str(),
                };
                if let Ok(text) = serde_json::to_string(&closed) {
                    let _ = sender.send(Outbound::Text(text));
                }
                registry.finish_terminal(&session_id).await;
                let _ = ended.send(session_id);
            });
        }

        ServerMessage::TerminalResume {
            session_id,
            last_seq,
        } => {
            if let Some(handle) = sessions.get(&session_id) {
                let _ = handle.resume_tx.send(last_seq);
            }
        }

        ServerMessage::ReportInterval { interval_ms } => {
            let clamped = interval_ms.clamp(COLLECT_INTERVAL_MIN, COLLECT_INTERVAL_MAX);
            report_interval_ms.store(clamped, Ordering::SeqCst);
            log::info!("服务端调整上报间隔: {clamped} ms");
        }

        ServerMessage::TerminalResize {
            session_id,
            cols,
            rows,
        } => {
            if let Some(handle) = sessions.get(&session_id) {
                let _ = handle.resize_tx.send((cols, rows));
            }
        }

        ServerMessage::TerminalClose { session_id } => {
            if let Some(handle) = sessions.remove(&session_id) {
                handle.cancel.store(true, Ordering::SeqCst);
            }
        }

        ServerMessage::Pong { .. } => {}

        ServerMessage::Error { message } => {
            log::warn!("服务端错误: {}", message.unwrap_or_default());
        }

        ServerMessage::Unknown => {
            log::debug!("忽略未知消息类型");
        }
    }
}
