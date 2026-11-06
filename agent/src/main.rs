mod collector;
mod command;
mod config;
mod protocol;
mod pty;

use std::collections::HashMap;
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
use config::Config;
use protocol::{ClientMessage, MetricsMessage, ServerMessage};
use pty::{PtySessionRequest, SessionHandle};

/// 重连退避: 指数增长 + 抖动, 避免多台 Agent 同步重连.
const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 60_000;
const HEARTBEAT_MS: u64 = 15_000;
/// 断线时等待会话收尾的上限.
const SHUTDOWN_GRACE_MS: u64 = 2_000;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let config = Config::from_env()?;
    log::info!("Monix Agent 启动, 目标={}", config.server_url);

    let mut attempt: u32 = 0;

    loop {
        match run_session(&config).await {
            Ok(()) => {
                log::info!("连接正常关闭");
                attempt = 0;
            }
            Err(error) => {
                attempt = attempt.saturating_add(1);
                log::warn!("连接中断: {error}");
            }
        }

        let base = (RECONNECT_BASE_MS.saturating_mul(1u64 << attempt.min(6))).min(RECONNECT_MAX_MS);
        let jitter = (base as f64 * 0.3 * rand::random::<f64>()) as u64;
        let delay = base + jitter;
        log::info!("{delay} ms 后重连");
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

async fn run_session(config: &Config) -> anyhow::Result<()> {
    let url = config.ws_url();
    let mut request = url.clone().into_client_request()?;
    // 长期凭据放在 Authorization 头, 不放 URL.
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", config.token))?,
    );
    request.headers_mut().insert(
        "X-Monix-Agent-Version",
        HeaderValue::from_str(env!("CARGO_PKG_VERSION"))?,
    );

    let (socket, _response) = connect_async(request).await?;
    let (mut write, mut read) = socket.split();

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let registry = Arc::new(CommandRegistry::new());
    // 活动终端会话: session_id -> 控制句柄.
    let mut sessions: HashMap<String, SessionHandle> = HashMap::new();
    // PTY 任务结束后回报 session_id, 由主循环清理句柄.
    let (ended_tx, mut ended_rx) = mpsc::unbounded_channel::<String>();

    // 发送任务: 所有出站消息统一经此通道串行化.
    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            if write.send(Message::Text(message)).await.is_err() {
                break;
            }
        }
    });

    let mut collector = Collector::new();
    let interval = Duration::from_millis(config.collect_interval_ms);
    let mut metrics_timer = tokio::time::interval(interval);
    let mut heartbeat_timer = tokio::time::interval(Duration::from_millis(HEARTBEAT_MS));

    log::info!("已连接, 采集间隔 {} ms", config.collect_interval_ms);

    let result = loop {
        tokio::select! {
            _ = metrics_timer.tick() => {
                let metrics = collector.collect(interval);
                let message = MetricsMessage {
                    kind: "metrics",
                    sample_ts: protocol::now_ms(),
                    metrics: &metrics,
                };
                match serde_json::to_string(&message) {
                    Ok(text) => {
                        if out_tx.send(text).is_err() { break Ok(()); }
                    }
                    Err(error) => log::warn!("指标序列化失败: {error}"),
                }
            }

            _ = heartbeat_timer.tick() => {
                let ping = ClientMessage::Ping { ts: protocol::now_ms() };
                if out_tx.send(serde_json::to_string(&ping).unwrap_or_default()).is_err() {
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
                        handle_server_message(&text, &registry, &mut sessions, out_tx.clone(), &ended_tx).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break Ok(()),
                    Some(Ok(_)) => {}
                    Some(Err(error)) => break Err(anyhow::anyhow!("{error}")),
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

async fn handle_server_message(
    text: &str,
    registry: &Arc<CommandRegistry>,
    sessions: &mut HashMap<String, SessionHandle>,
    out_tx: mpsc::UnboundedSender<String>,
    ended_tx: &mpsc::UnboundedSender<String>,
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
            let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
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
                    .unwrap_or_default(),
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
                let _ = out_tx.send(serde_json::to_string(&busy).unwrap_or_default());
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
            let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
            // 终端与一次性命令共用执行槽, 占用失败立即回执.
            if !registry
                .try_begin_terminal(&open.session_id, flag.clone())
                .await
            {
                let _ = out_tx.send(pty::serialize(&ClientMessage::TerminalClosed {
                    session_id: open.session_id,
                    reason: "busy",
                }));
                return;
            }

            let (input_tx, input_rx) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
            let shutdown_tx = input_tx.clone();
            let (resize_tx, resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
            let last_input_at = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
            sessions.insert(
                open.session_id.clone(),
                SessionHandle {
                    input_tx,
                    resize_tx,
                    cancel: flag.clone(),
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
                    resize_rx,
                    flag,
                    last_input_at,
                )
                .await;

                let _ = sender.send(pty::serialize(&ClientMessage::TerminalClosed {
                    session_id: session_id.clone(),
                    reason: reason.as_str(),
                }));
                registry.finish_terminal(&session_id).await;
                let _ = ended.send(session_id);
            });
        }

        ServerMessage::TerminalInput { session_id, data } => {
            if let Some(handle) = sessions.get(&session_id) {
                match pty::decode_input(&data) {
                    Some(bytes) => {
                        // 输入也算活跃: 用户持续敲键但 shell 无输出时不应被判为空闲.
                        handle.touch_input();
                        let _ = handle.input_tx.send(Some(bytes));
                    }
                    None => log::debug!("丢弃非法的终端输入 {session_id}"),
                }
            }
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
                handle
                    .cancel
                    .store(true, std::sync::atomic::Ordering::SeqCst);
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
