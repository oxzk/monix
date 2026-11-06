/**
 * Dashboard 实时客户端.
 *
 * 这里使用类而不是函数, 因为它承载了明确的有状态资源:
 * WebSocket 连接、重连定时器、当前命令与终端会话上下文. 这些状态
 * 需要在 React 组件卸载时被可靠释放, 也需要在连接生命周期内持续可变.
 *
 * 纯转换逻辑 (base64、事件到状态的归并) 仍保持为普通函数.
 */

import type {
  CommandStatus,
  MetricsPayload,
  ServerSnapshot,
  StreamEvent,
} from '@/api/types'

/** 前端保留的输出上限, 与服务端 1 MiB 限制相互独立. */
const MAX_LINES = 300
const MAX_LINE_CHARS = 4000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export interface CommandOutputLine {
  kind: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface ActiveCommand {
  commandId: string
  serverId: string
  status: CommandStatus
  exitCode: number | null
  durationMs: number | null
  /** 服务端因输出上限而截断. */
  outputTruncated: boolean
  /** 前端本地保留上限触发的截断, 与服务端标记独立. */
  truncated: boolean
  lines: CommandOutputLine[]
}

export interface TerminalState {
  sessionId: string | null
  serverId: string | null
  status: 'idle' | 'opening' | 'open' | 'closed'
  reason: string | null
}

const EMPTY_TERMINAL: TerminalState = {
  sessionId: null,
  serverId: null,
  status: 'idle',
  reason: null,
}

/** 客户端对外暴露的快照, React 层据此渲染. */
export interface MonitorSnapshotState {
  connected: boolean
  snapshots: Map<string, ServerSnapshot>
  command: ActiveCommand | null
  terminal: TerminalState
  error: string | null
}

/** 终端输出回调, 由 xterm 实例注册. */
export type TerminalDataHandler = (data: Uint8Array) => void

/** 分块 base64 编码, 避免 String.fromCharCode 参数过多导致栈溢出. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 把单个事件归并为新的命令状态; 不属于当前命令的事件原样返回. */
function reduceCommand(
  prev: ActiveCommand | null,
  event: StreamEvent,
): ActiveCommand | null {
  switch (event.type) {
    case 'command.status': {
      if (!prev || prev.commandId !== event.commandId) return prev
      return { ...prev, status: event.status }
    }
    case 'command.output': {
      if (!prev || prev.commandId !== event.commandId) return prev
      const lineTruncated = event.data.length > MAX_LINE_CHARS
      const text = lineTruncated ? `${event.data.slice(0, MAX_LINE_CHARS)}…` : event.data
      const lines = [...prev.lines, { kind: event.stream, text }]
      return {
        ...prev,
        lines: lines.slice(-MAX_LINES),
        truncated: prev.truncated || lineTruncated || lines.length > MAX_LINES,
      }
    }
    case 'command.finished': {
      if (!prev || prev.commandId !== event.commandId) return prev
      const notice: CommandOutputLine[] = [
        {
          kind: 'system',
          text: `进程结束 · 状态 ${event.status} · 退出码 ${event.exitCode ?? '—'}`,
        },
      ]
      if (event.outputTruncated) {
        notice.push({ kind: 'system', text: '输出已达服务端上限, 后续内容未传输' })
      }
      return {
        ...prev,
        status: event.status,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        outputTruncated: event.outputTruncated,
        lines: [...prev.lines, ...notice].slice(-MAX_LINES),
      }
    }
    default:
      return prev
  }
}

/** 把单个事件归并为新的服务器快照表. */
function reduceSnapshots(
  prev: Map<string, ServerSnapshot>,
  event: StreamEvent,
): Map<string, ServerSnapshot> {
  switch (event.type) {
    case 'snapshot': {
      const next = new Map<string, ServerSnapshot>()
      for (const item of event.servers) next.set(item.serverId, item)
      return next
    }
    case 'metrics': {
      const next = new Map(prev)
      next.set(event.serverId, {
        serverId: event.serverId,
        status: 'online',
        sampleTs: event.sampleTs,
        receivedTs: event.receivedTs,
        metrics: event.metrics as MetricsPayload,
      })
      return next
    }
    case 'server.status': {
      const next = new Map(prev)
      const existing = next.get(event.serverId)
      next.set(event.serverId, {
        serverId: event.serverId,
        status: event.status,
        sampleTs: existing?.sampleTs ?? null,
        receivedTs: existing?.receivedTs ?? null,
        // 离线后不保留过期指标, 避免被当作当前值展示.
        metrics: event.status === 'online' ? (existing?.metrics ?? null) : null,
      })
      return next
    }
    default:
      return prev
  }
}

/**
 * 实时订阅客户端.
 *
 * 生命周期: `connect()` 建立连接, `dispose()` 停止重连并关闭 socket.
 * 断线后按指数退避加抖动重连, 重连成功由服务端下发最新快照,
 * 不把断线期间缺失的消息当作完整历史.
 */
export class MonitorClient {
  private socket: WebSocket | null = null
  private retryAttempt = 0
  private reconnectTimer: number | null = null
  private disposed = false
  private terminalHandler: TerminalDataHandler | null = null
  private currentTerminalId: string | null = null

  private state: MonitorSnapshotState = {
    connected: false,
    snapshots: new Map<string, ServerSnapshot>(),
    command: null,
    terminal: EMPTY_TERMINAL,
    error: null,
  }

  private readonly listeners = new Set<(state: MonitorSnapshotState) => void>()

  /** 订阅状态变化, 返回取消订阅函数. */
  subscribe(listener: (state: MonitorSnapshotState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState(): MonitorSnapshotState {
    return this.state
  }

  /** 建立连接; 已连接或已销毁时为空操作. */
  connect(): void {
    if (this.disposed) return
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/stream`)
    this.socket = socket

    socket.onopen = (): void => {
      this.retryAttempt = 0
      this.patch({ connected: true, error: null })
    }

    socket.onmessage = (event: MessageEvent): void => {
      if (typeof event.data !== 'string') return
      try {
        this.applyEvent(JSON.parse(event.data) as StreamEvent)
      } catch {
        // 非法消息忽略, 不断开连接.
      }
    }

    socket.onclose = (): void => {
      this.socket = null
      // 断线时不能继续展示"执行中/已连接": 服务端已按断线清理运行态.
      const command = this.state.command
      const terminal = this.state.terminal
      this.patch({
        connected: false,
        command:
          command && (command.status === 'queued' || command.status === 'running')
            ? { ...command, status: 'disconnected' }
            : command,
        terminal:
          terminal.status === 'opening' || terminal.status === 'open'
            ? { ...terminal, status: 'closed', reason: 'disconnected' }
            : terminal,
      })
      this.scheduleReconnect()
    }

    socket.onerror = (): void => {
      this.patch({ error: '实时连接异常, 正在重连' })
    }
  }

  /** 停止重连并关闭连接, 释放所有定时器. */
  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close()
    this.socket = null
    this.listeners.clear()
    this.terminalHandler = null
  }

  startCommand(commandId: string, serverId: string): void {
    this.patch({
      command: {
        commandId,
        serverId,
        status: 'queued',
        exitCode: null,
        durationMs: null,
        outputTruncated: false,
        truncated: false,
        lines: [],
      },
    })
  }

  clearCommand(): void {
    this.patch({ command: null })
  }

  setTerminalSession(sessionId: string, serverId: string): void {
    this.currentTerminalId = sessionId
    this.patch({ terminal: { sessionId, serverId, status: 'opening', reason: null } })
  }

  setTerminalHandler(handler: TerminalDataHandler | null): void {
    this.terminalHandler = handler
  }

  sendTerminalInput(data: Uint8Array): void {
    this.send({ type: 'terminal.input', session_id: this.currentTerminalId, data: toBase64(data) })
  }

  sendTerminalResize(cols: number, rows: number): void {
    this.send({ type: 'terminal.resize', session_id: this.currentTerminalId, cols, rows })
  }

  closeTerminal(): void {
    this.send({ type: 'terminal.close', session_id: this.currentTerminalId })
  }

  /** 发送 JSON 消息; 未连接或终端未建立时静默丢弃. */
  private send(payload: Record<string, unknown>): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (!payload.session_id) return
    socket.send(JSON.stringify(payload))
  }

  private patch(partial: Partial<MonitorSnapshotState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) listener(this.state)
  }

  private applyEvent(event: StreamEvent): void {
    // 终端输出直接交给 xterm, 不进入 React 状态, 避免高频重渲染.
    if (event.type === 'terminal.output') {
      if (event.sessionId === this.currentTerminalId) {
        this.terminalHandler?.(fromBase64(event.data))
      }
      return
    }

    this.patch({
      snapshots: reduceSnapshots(this.state.snapshots, event),
      command: reduceCommand(this.state.command, event),
      terminal: this.reduceTerminal(event),
      error: event.type === 'error' ? event.message : this.state.error,
    })
  }

  private reduceTerminal(event: StreamEvent): TerminalState {
    const terminal = this.state.terminal
    switch (event.type) {
      case 'terminal.opened':
        return terminal.sessionId === event.sessionId ? { ...terminal, status: 'open' } : terminal
      case 'terminal.closed':
        return terminal.sessionId === event.sessionId
          ? { ...terminal, status: 'closed', reason: event.reason }
          : terminal
      default:
        return terminal
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return

    // 指数退避 + 抖动, 避免所有标签页同时重连.
    const attempt = this.retryAttempt + 1
    this.retryAttempt = attempt
    const base = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
    const jitter = base * 0.3 * Math.random()
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, base + jitter)
  }
}
