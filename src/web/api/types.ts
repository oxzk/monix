export interface MetricsPayload {
  cpu?: {
    name?: string | null
    usage_percent?: number | null
    per_core_usage?: number[] | null
    physical_cores?: number | null
    logical_cores?: number | null
  }
  memory?: {
    total_bytes?: number | null
    used_bytes?: number | null
    usage_percent?: number | null
  }
  swap?: {
    total_bytes?: number | null
    used_bytes?: number | null
    usage_percent?: number | null
  }
  disks?: Array<{
    mount_point: string
    total_bytes?: number | null
    used_bytes?: number | null
    usage_percent?: number | null
  }>
  network?: {
    bytes_sent?: number | null
    bytes_received?: number | null
    upload_bytes_per_sec?: number | null
    download_bytes_per_sec?: number | null
    interface?: string | null
  }
  system?: {
    os?: string | null
    os_version?: string | null
    arch?: string | null
    hostname?: string | null
    uptime_seconds?: number | null
  }
  load?: {
    load1?: number | null
    load5?: number | null
    load15?: number | null
  }
}

export interface ServerSummary {
  id: string
  name: string
  hostname: string | null
  ipv4: string | null
  ipv6: string | null
  countryCode: string | null
  groupId: number | null
  enabled: boolean
  status: 'online' | 'offline'
  createdAt: number
  updatedAt: number
}

export interface ServerSnapshot {
  serverId: string
  status: 'online' | 'offline'
  sampleTs: number | null
  receivedTs: number | null
  metrics: MetricsPayload | null
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
  | { type: 'snapshot'; servers: ServerSnapshot[] }
  | { type: 'metrics'; serverId: string; sampleTs: number | null; receivedTs: number; metrics: MetricsPayload }
  | { type: 'server.status'; serverId: string; status: 'online' | 'offline'; ts: number }
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
  | { type: 'terminal.output'; sessionId: string; serverId: string; seq: number; data: string }
  | { type: 'terminal.closed'; sessionId: string; serverId: string; reason: string }
  | { type: 'pong'; ts: number }
  | { type: 'error'; message: string }

export interface TerminalAccepted {
  sessionId: string
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
