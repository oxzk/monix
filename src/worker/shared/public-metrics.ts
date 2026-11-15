/**
 * 公开指标脱敏.
 *
 * 状态页(HTTP 与 WebSocket)共用同一份转换: 只保留使用率、容量与系统名,
 * 去掉主机名、网卡名与累计字节. 任何新增的公开出口都必须走这里,
 * 不能直接把 Agent 原始 payload 透传出去.
 */

export interface PublicMetrics {
  cpu: {
    usagePercent: number | null
    perCoreUsage: number[]
    physicalCores: number | null
    logicalCores: number | null
  } | null
  memory: { totalBytes: number | null; usedBytes: number | null; usagePercent: number | null } | null
  disks: Array<{
    mountPoint: string
    totalBytes: number | null
    usedBytes: number | null
    usagePercent: number | null
  }>
  network: { uploadBytesPerSec: number | null; downloadBytesPerSec: number | null } | null
  load: { load1: number | null; load5: number | null; load15: number | null } | null
  uptimeSeconds: number | null
  /** 操作系统与版本(如 "Ubuntu 22.04"), Agent 未上报时为 null. */
  os: string | null
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function toPublicMetrics(raw: unknown): PublicMetrics | null {
  if (raw === null || typeof raw !== 'object') return null
  const m = raw as {
    cpu?: { usage_percent?: unknown; per_core_usage?: unknown; physical_cores?: unknown; logical_cores?: unknown }
    memory?: { total_bytes?: unknown; used_bytes?: unknown; usage_percent?: unknown }
    disks?: Array<{ mount_point?: unknown; total_bytes?: unknown; used_bytes?: unknown; usage_percent?: unknown }>
    network?: { upload_bytes_per_sec?: unknown; download_bytes_per_sec?: unknown }
    load?: { load1?: unknown; load5?: unknown; load15?: unknown }
    system?: { os?: unknown; os_version?: unknown; uptime_seconds?: unknown }
  }

  const perCore = Array.isArray(m.cpu?.per_core_usage)
    ? m.cpu.per_core_usage.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : []

  return {
    cpu: m.cpu
      ? {
          usagePercent: numberOrNull(m.cpu.usage_percent),
          perCoreUsage: perCore,
          physicalCores: numberOrNull(m.cpu.physical_cores),
          logicalCores: numberOrNull(m.cpu.logical_cores),
        }
      : null,
    memory: m.memory
      ? {
          totalBytes: numberOrNull(m.memory.total_bytes),
          usedBytes: numberOrNull(m.memory.used_bytes),
          usagePercent: numberOrNull(m.memory.usage_percent),
        }
      : null,
    disks: Array.isArray(m.disks)
      ? m.disks.map((disk) => ({
          mountPoint: typeof disk.mount_point === 'string' ? disk.mount_point : '',
          totalBytes: numberOrNull(disk.total_bytes),
          usedBytes: numberOrNull(disk.used_bytes),
          usagePercent: numberOrNull(disk.usage_percent),
        }))
      : [],
    network: m.network
      ? {
          uploadBytesPerSec: numberOrNull(m.network.upload_bytes_per_sec),
          downloadBytesPerSec: numberOrNull(m.network.download_bytes_per_sec),
        }
      : null,
    load: m.load
      ? {
          load1: numberOrNull(m.load.load1),
          load5: numberOrNull(m.load.load5),
          load15: numberOrNull(m.load.load15),
        }
      : null,
    uptimeSeconds: numberOrNull(m.system?.uptime_seconds),
    os: [m.system?.os, m.system?.os_version]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .join(' ') || null,
  }
}
/**
 * 公开展示用的 IP 掩码: 只保留前缀, 隐藏完整地址.
 *
 * - IPv4 `1.2.3.4` → `1.2.3.*`(掩掉末段)
 * - IPv6 → 保留前两组 + `::*`(如 `240e:3a00::*`)
 */
export function maskIpForPublic(ip: string): string {
  if (ip.includes(':')) {
    // :: 压缩会产生空段, 先剔除再按"掩最后两组"处理; 组数不足两组时全掩.
    const groups = ip.split(':').filter((group) => group !== '')
    if (groups.length <= 2) return `${groups[0] ?? ''}::*`
    return `${groups.slice(0, groups.length - 2).join(':')}:*:*`
  }
  const parts = ip.split('.')
  if (parts.length !== 4) return '*.*'
  return `${parts.slice(0, 2).join('.')}.*.*`
}
