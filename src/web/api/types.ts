export interface ServerSummary {
  id: string
  name: string
  /** Agent 上报的平台标识 {os}-{arch}, 如 linux-x86_64; 未上报为 null. */
  platform: string | null
  /** Agent 当前版本(连接时上报), 如 0.1.0; 未上报为 null. */
  version: string | null
  ipv4: string | null
  ipv6: string | null
  countryCode: string | null
  groupId: number | null
  enabled: boolean
  status: 'online' | 'offline'
  createdAt: number
  updatedAt: number
}

/** 公开状态页的服务器条目: 已脱敏, 不含 IP/主机名/系统版本. */
export interface PublicServer {
  id: string
  name: string
  countryCode: string | null
  /** 掩码后的公网 IP(如 1.2.3.* / 240e:3a00::*). */
  ip: string | null
  groupName: string | null
  status: 'online' | 'offline'
  sampleTs: number | null
  receivedTs: number | null
  metrics: PublicMetrics | null
}

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

export interface Group {
  id: number
  name: string
  description: string | null
  serverCount: number
  createdAt: number
  updatedAt: number
}

export interface SettingsMap {
  settings: Record<string, Record<string, { value: string; description: string | null; updatedAt: number }>>
  mutable: Record<string, string[]>
  bounds: Record<string, { min: number; max: number }>
}

export type CommandStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'disconnected'

export interface CommandAccepted {
  commandId: string
  status: CommandStatus
  timeoutSeconds: number
}

export type StreamEvent =
  | { type: 'command.status'; commandId: string; serverId: string; status: CommandStatus }
  | { type: 'command.output'; commandId: string; serverId: string; stream: 'stdout' | 'stderr'; seq: number; data: string }
  | {
      type: 'command.finished'
      commandId: string
      serverId: string
      status: CommandStatus
      exitCode: number | null
      durationMs: number | null
      outputTruncated: boolean
    }
  | { type: 'terminal.opened'; sessionId: string; serverId: string; cols: number; rows: number }
  | { type: 'terminal.resumed'; sessionId: string; serverId: string; seq: number }
  | { type: 'terminal.gap'; sessionId: string; serverId: string }
  | { type: 'terminal.error'; sessionId: string; serverId: string; code: string; message: string }
  | { type: 'terminal.detached'; sessionId: string }
  | { type: 'terminal.closed'; sessionId: string; serverId: string; reason: string }
  | { type: 'pong'; ts: number }
  | { type: 'error'; message: string }

export interface TerminalAccepted {
  sessionId: string
  cols: number
  rows: number
}

/** 按服务器查询到的活动会话; 无会话时为 null. */
export interface TerminalSessionSummary {
  sessionId: string
  serverId: string
  status: 'opening' | 'open'
  cols: number
  rows: number
}

export interface TerminalSessionInfo {
  sessionId: string
  serverId: string
  admin: string
  status: 'opening' | 'open' | 'closing'
  cols: number
  rows: number
  createdAt: number
  lastActivityAt: number
}

/** 前台主题的配色键(camelCase), 与 CSS 变量 --p-* 一一对应. */
export type ThemeColorKey = 'bg' | 'card' | 'ink' | 'muted' | 'faint' | 'line' | 'accent' | 'accentInk' | 'ok' | 'bad'

/** 后台可配置的前台主题: 背景图 + 配色覆盖. */
export interface ThemeOptions {
  backgroundImage: string | null
  /** 背景遮罩浓度(0-95): 叠加页面底色的不透明度, 默认 0(无遮罩). */
  backgroundOpacity: number
  colors: Partial<Record<ThemeColorKey, string>>
}

