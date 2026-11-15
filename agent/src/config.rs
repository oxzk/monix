use std::env;
use std::net::IpAddr;

use crate::limits::{COLLECT_INTERVAL_MAX, COLLECT_INTERVAL_MIN};

/// 默认服务端地址: 未设置 `MONIX_SERVER_URL` 时使用.
///
/// 安装脚本会把实际地址写入配置文件, 这里的默认值只服务于
/// "二进制直接运行且未给环境变量" 的场景, 必须与脚本默认值保持一致.
pub const DEFAULT_SERVER_URL: &str = "https://monix.api01.eu.org";

/// Agent 运行配置. 通过环境变量提供, 运行期可由服务端下发覆盖.
#[derive(Debug, Clone)]
pub struct Config {
    pub server_url: String,
    pub token: String,
    pub collect_interval_ms: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let server_url = env::var("MONIX_SERVER_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());
        let token =
            env::var("MONIX_AGENT_TOKEN").map_err(|_| anyhow::anyhow!("缺少 MONIX_AGENT_TOKEN"))?;
        let collect_interval_ms = env::var("MONIX_COLLECT_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(5_000)
            .clamp(COLLECT_INTERVAL_MIN, COLLECT_INTERVAL_MAX);

        Ok(Self {
            server_url: server_url.trim_end_matches('/').to_string(),
            token,
            collect_interval_ms,
        })
    }

    /// HTTP 基地址. 与 `ws_url` 使用同一份 server_url 推导, 保证两者协议一致.
    pub fn http_base(&self) -> String {
        self.server_url.trim_end_matches('/').to_string()
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

/// 平台标识 `{os}-{arch}`, 例 linux-x86_64 / linux-aarch64.
///
/// 与 CI 产物命名一致, 由连接请求的 X-Monix-Platform 头上报.
pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// 服务端下发的运行配置.
///
/// 只需采集间隔: 命令超时与输出上限随每条 `command.execute` 一起下发,
/// Agent 不在本地保存, 避免与服务端配置产生双份状态.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    #[serde(default)]
    pub collect_interval_ms: Option<u64>,
}

/// 从服务端拉取运行配置.
///
/// 只在会话建立时调用一次: 配置项本身变更频率很低, 没必要轮询.
/// 失败时返回 `None`, 调用方继续使用本地配置.
pub async fn fetch_remote_config(config: &Config) -> Option<RemoteConfig> {
    let url = format!("{}/api/v1/agent/config", config.http_base());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;

    #[derive(serde::Deserialize)]
    struct Envelope {
        ok: bool,
        data: Option<RemoteConfig>,
    }

    match client
        .get(&url)
        .bearer_auth(&config.token)
        .header("X-Monix-Agent-Version", env!("CARGO_PKG_VERSION"))
        .send()
        .await
    {
        Ok(response) => {
            if !response.status().is_success() {
                log::warn!("拉取服务端配置失败: HTTP {}", response.status());
                return None;
            }
            match response.json::<Envelope>().await {
                Ok(envelope) if envelope.ok => envelope.data,
                Ok(_) => {
                    log::warn!("拉取服务端配置失败: 响应未标记成功");
                    None
                }
                Err(error) => {
                    log::warn!("解析服务端配置失败: {error}");
                    None
                }
            }
        }
        Err(error) => {
            log::warn!("拉取服务端配置失败: {error}");
            None
        }
    }
}

/// 双栈公网地址探测结果.
#[derive(Debug, Default, Clone)]
pub struct PublicIps {
    pub ipv4: Option<String>,
    pub ipv6: Option<String>,
}

#[derive(serde::Deserialize)]
struct IpEnvelope {
    ok: bool,
    data: Option<IpEcho>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IpEcho {
    ip: Option<String>,
}

/// 分别通过仅 IPv4 / 仅 IPv6 的本地 socket 请求服务端回显接口.
///
/// `local_address` 绑定 `0.0.0.0` / `[::]` 强制出口地址族: 机器缺少某族
/// 出口(无公网路由)时该族请求失败, 对应地址记为 None.
async fn probe_family(url: &str, token: &str, local: Option<IpAddr>) -> Option<String> {
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10));
    if let Some(address) = local {
        builder = builder.local_address(Some(address));
    }
    let client = builder.build().ok()?;

    let envelope = client
        .get(url)
        .bearer_auth(token)
        .header("X-Monix-Agent-Version", env!("CARGO_PKG_VERSION"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<IpEnvelope>()
        .await
        .ok()?;

    if envelope.ok {
        envelope.data.and_then(|echo| echo.ip)
    } else {
        None
    }
}

/// 探测两族公网地址.
pub async fn probe_public_ips(config: &Config) -> PublicIps {
    let url = format!("{}/api/v1/agent/ip", config.http_base());
    // 字面量恒可解析, ok() 仅为统一 Option 参数; 失败不可能发生.
    let v4_bind = "0.0.0.0".parse::<IpAddr>().ok();
    let v6_bind = "::".parse::<IpAddr>().ok();
    let ipv4 = probe_family(&url, &config.token, v4_bind).await;
    let ipv6 = probe_family(&url, &config.token, v6_bind).await;
    PublicIps { ipv4, ipv6 }
}
