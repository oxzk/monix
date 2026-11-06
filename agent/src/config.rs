use std::env;

/// Agent 运行配置. 通过环境变量或命令行参数提供.
#[derive(Debug, Clone)]
pub struct Config {
    pub server_url: String,
    pub token: String,
    pub collect_interval_ms: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let server_url = env::var("MONIX_SERVER_URL").map_err(|_| {
            anyhow::anyhow!("缺少 MONIX_SERVER_URL, 例如 https://monix.example.com")
        })?;
        let token =
            env::var("MONIX_AGENT_TOKEN").map_err(|_| anyhow::anyhow!("缺少 MONIX_AGENT_TOKEN"))?;
        let collect_interval_ms = env::var("MONIX_COLLECT_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(5_000)
            .clamp(1_000, 300_000);

        Ok(Self {
            server_url: server_url.trim_end_matches('/').to_string(),
            token,
            collect_interval_ms,
        })
    }

    /// 转换为 WebSocket 地址. http → ws, https → wss.
    pub fn ws_url(&self) -> String {
        let base = if let Some(rest) = self.server_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.server_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            format!("wss://{}", self.server_url)
        };
        format!("{base}/api/v1/agent/connect")
    }
}
