use std::collections::HashMap;
use std::time::Duration;
use sysinfo::{Disks, Networks, System};

use crate::protocol::{
    CpuMetrics, DiskMetrics, LoadAverage, MemoryMetrics, Metrics, NetworkMetrics, SwapMetrics,
    SystemInfo,
};

/// 采集器持有跨采样状态: sysinfo 实例与上一次的网络累计值, 用于计算速率.
pub struct Collector {
    system: System,
    networks: Networks,
    last_net: HashMap<String, (u64, u64)>,
    last_refresh: i64,
}

impl Collector {
    pub fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_usage();
        Self {
            system,
            networks: Networks::new_with_refreshed_list(),
            last_net: HashMap::new(),
            last_refresh: 0,
        }
    }

    /// 采集一次指标. CPU 使用率依赖两次采样之间的间隔, 因此每次采集都会刷新.
    pub fn collect(&mut self, interval: Duration) -> Metrics {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.networks.refresh();

        let now = crate::protocol::now_ms();
        let elapsed_ms = if self.last_refresh == 0 {
            interval.as_millis() as i64
        } else {
            (now - self.last_refresh).max(1)
        };
        self.last_refresh = now;

        let cpu = self.collect_cpu();
        let memory = self.collect_memory();
        let swap = self.collect_swap();
        let disks = self.collect_disks();
        let network = self.collect_network(elapsed_ms);
        let system = self.collect_system();
        let load = self.collect_load();

        Metrics {
            cpu,
            memory,
            swap,
            disks,
            network,
            system,
            load,
        }
    }

    fn collect_cpu(&self) -> CpuMetrics {
        let cpus = self.system.cpus();
        let per_core: Vec<f32> = cpus.iter().map(|cpu| cpu.cpu_usage()).collect();
        let usage = if per_core.is_empty() {
            0.0
        } else {
            per_core.iter().sum::<f32>() / per_core.len() as f32
        };

        CpuMetrics {
            name: cpus
                .first()
                .map(|cpu| cpu.brand().to_string())
                .filter(|name| !name.is_empty()),
            usage_percent: round1(usage),
            per_core_usage: per_core.into_iter().map(round1).collect(),
            physical_cores: System::physical_core_count(&self.system).unwrap_or(0),
            logical_cores: cpus.len(),
        }
    }

    fn collect_memory(&self) -> MemoryMetrics {
        let total = self.system.total_memory();
        let used = self.system.used_memory();
        MemoryMetrics {
            total_bytes: total,
            used_bytes: used,
            usage_percent: percent(used, total),
        }
    }

    fn collect_swap(&self) -> SwapMetrics {
        let total = self.system.total_swap();
        let used = self.system.used_swap();
        SwapMetrics {
            total_bytes: total,
            used_bytes: used,
            usage_percent: percent(used, total),
        }
    }

    fn collect_disks(&self) -> Vec<DiskMetrics> {
        let disks = Disks::new_with_refreshed_list();
        disks
            .list()
            .iter()
            .map(|disk| {
                let total = disk.total_space();
                let available = disk.available_space();
                let used = total.saturating_sub(available);
                DiskMetrics {
                    mount_point: disk.mount_point().to_string_lossy().to_string(),
                    total_bytes: total,
                    used_bytes: used,
                    usage_percent: percent(used, total),
                }
            })
            .collect()
    }

    fn collect_network(&mut self, elapsed_ms: i64) -> NetworkMetrics {
        let mut total_sent = 0u64;
        let mut total_received = 0u64;
        let mut speed_up = 0f64;
        let mut speed_down = 0f64;
        let mut primary: Option<String> = None;
        let mut next_state: HashMap<String, (u64, u64)> = HashMap::new();

        for (name, data) in self.networks.iter() {
            let sent = data.total_transmitted();
            let received = data.total_received();
            total_sent = total_sent.saturating_add(sent);
            total_received = total_received.saturating_add(received);

            if let Some((last_sent, last_received)) = self.last_net.get(name) {
                let elapsed = (elapsed_ms.max(1) as f64) / 1000.0;
                let diff_sent = sent.saturating_sub(*last_sent) as f64;
                let diff_received = received.saturating_sub(*last_received) as f64;
                // 计数器重置或下降时不产生负速率.
                if sent >= *last_sent && received >= *last_received {
                    speed_up += diff_sent / elapsed;
                    speed_down += diff_received / elapsed;
                }
            }

            if primary.is_none() && name != "lo" && !name.starts_with("Loopback") {
                primary = Some(name.clone());
            }
            next_state.insert(name.clone(), (sent, received));
        }

        self.last_net = next_state;

        NetworkMetrics {
            interface: primary,
            bytes_sent: total_sent,
            bytes_received: total_received,
            upload_bytes_per_sec: speed_up.max(0.0).round() as u64,
            download_bytes_per_sec: speed_down.max(0.0).round() as u64,
        }
    }

    fn collect_system(&self) -> SystemInfo {
        SystemInfo {
            os: System::name().unwrap_or_else(|| "unknown".to_string()),
            os_version: System::os_version().unwrap_or_default(),
            arch: System::cpu_arch().unwrap_or_else(|| "unknown".to_string()),
            hostname: System::host_name().unwrap_or_else(|| "unknown".to_string()),
            uptime_seconds: System::uptime(),
        }
    }

    fn collect_load(&self) -> LoadAverage {
        let load = System::load_average();
        LoadAverage {
            load1: load.one,
            load5: load.five,
            load15: load.fifteen,
        }
    }
}

fn percent(used: u64, total: u64) -> f32 {
    if total == 0 {
        return 0.0;
    }
    round1((used as f64 / total as f64 * 100.0) as f32)
}

fn round1(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}
