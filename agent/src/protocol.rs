use serde::{Deserialize, Serialize};

/// 指标负载. 字段与 docs/design.md 第 7 节保持一致.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Metrics {
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub swap: SwapMetrics,
    pub disks: Vec<DiskMetrics>,
    pub network: NetworkMetrics,
    pub system: SystemInfo,
    pub load: LoadAverage,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CpuMetrics {
    pub name: Option<String>,
    pub usage_percent: f32,
    pub per_core_usage: Vec<f32>,
    pub physical_cores: usize,
    pub logical_cores: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MemoryMetrics {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub usage_percent: f32,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SwapMetrics {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub usage_percent: f32,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DiskMetrics {
    pub mount_point: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub usage_percent: f32,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct NetworkMetrics {
    pub interface: Option<String>,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub upload_bytes_per_sec: u64,
    pub download_bytes_per_sec: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SystemInfo {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub hostname: String,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct LoadAverage {
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
}

#[derive(Debug, Serialize)]
pub struct MetricsMessage<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub sample_ts: i64,
    pub metrics: &'a Metrics,
}

/// 服务端下发的命令.
#[derive(Debug, Clone, Deserialize)]
pub struct CommandExecute {
    pub command_id: String,
    pub command: String,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default = "default_max_output")]
    pub max_output_bytes: usize,
}

fn default_timeout() -> u64 {
    60
}

fn default_max_output() -> usize {
    1_048_576
}

fn default_idle_timeout() -> u64 {
    600
}

fn default_max_duration() -> u64 {
    3_600
}

/// 交互式 PTY 会话的开立请求.
#[derive(Debug, Clone, Deserialize)]
pub struct TerminalOpen {
    pub session_id: String,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_idle_timeout")]
    pub idle_timeout_seconds: u64,
    #[serde(default = "default_max_duration")]
    pub max_duration_seconds: u64,
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "command.execute")]
    CommandExecute(CommandExecute),
    #[serde(rename = "command.cancel")]
    CommandCancel { command_id: String },
    #[serde(rename = "terminal.open")]
    TerminalOpen(TerminalOpen),
    /// 键盘输入, data 为 base64 编码的原始字节.
    #[serde(rename = "terminal.input")]
    TerminalInput { session_id: String, data: String },
    #[serde(rename = "terminal.resize")]
    TerminalResize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "terminal.close")]
    TerminalClose { session_id: String },
    #[serde(rename = "pong")]
    Pong {
        #[allow(dead_code)]
        ts: i64,
    },
    #[serde(rename = "error")]
    Error { message: Option<String> },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "command.started")]
    CommandStarted { command_id: String, started_at: i64 },
    #[serde(rename = "command.output")]
    CommandOutput {
        command_id: String,
        stream: &'static str,
        seq: u64,
        data: String,
    },
    #[serde(rename = "command.finished")]
    CommandFinished {
        command_id: String,
        status: &'static str,
        exit_code: Option<i32>,
        started_at: i64,
        finished_at: i64,
        duration_ms: i64,
        output_truncated: bool,
    },
    #[serde(rename = "terminal.opened")]
    TerminalOpened {
        session_id: String,
        pid: Option<u32>,
    },
    /// PTY 输出, data 为 base64 编码的原始字节; ANSI 序列由前端 xterm 解析.
    #[serde(rename = "terminal.output")]
    TerminalOutput {
        session_id: String,
        seq: u64,
        data: String,
    },
    #[serde(rename = "terminal.closed")]
    TerminalClosed {
        session_id: String,
        reason: &'static str,
    },
    #[serde(rename = "ping")]
    Ping { ts: i64 },
}

pub fn now_ms() -> i64 {
    chrono_now_ms()
}

fn chrono_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
