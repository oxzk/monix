/**
 * 后台实时客户端 —— 只承载命令与终端事件.
 *
 * 后台不需要实时指标: 指标/状态由公开状态页的 WS 与 D1 缓存承载,
 * 这条连接是**按需**建立的 —— 仅在执行命令或打开终端时连接,
 * 空闲(无活动命令、无终端会话)10 秒后自动断开.
 *
 * 终端数据走二进制帧(与 Agent/DO 协议一致), 控制消息走 JSON:
 * - 输入 `0x01 + 数据`(Dashboard→Agent)
 * - 输出 `0x02 + u64 大端 seq + 数据`(Agent→Dashboard)
 * 断线/刷新后按最后处理的 seq 续传, 交由 Agent 的有界缓冲重放.
 */

import type {
  CommandStatus,
  StreamEvent,
} from '@/api/types'

/** 前端保留的输出上限, 与服务端 1 MiB 限制相互独立. */
const MAX_LINES = 300
/** 单行渲染上限: 只影响单行显示, 不丢弃输出内容. */
const MAX_LINE_CHARS = 4000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** 无活动命令且无终端会话时, 连接保持这么久后自动断开. */
const IDLE_DISCONNECT_MS = 15_000

/** 二进制帧类型, 与 Agent 侧保持一致. */
const TERMINAL_INPUT_TYPE = 0x01
const TERMINAL_OUTPUT_TYPE = 0x02
/** 输出帧头部: 1 字节类型 + 8 字节大端序列号. */
const TERMINAL_OUTPUT_HEADER_LEN = 9
/** 单个输入帧的最大载荷, 与 DO/Agent 的 8 KiB 限制一致. */
const TERMINAL_INPUT_CHUNK_SIZE = 8 * 1024

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
  /** opening: 已创建待握手; open: 已连接; reconnecting: 实时通道断开, 会话仍在服务端; closed: 已结束. */
  status: 'idle' | 'opening' | 'open' | 'reconnecting' | 'closed'
  reason: string | null
  /** 一次性提示(如输入过载), 面板展示后可清除. */
  notice: string | null
}

const EMPTY_TERMINAL: TerminalState = {
  sessionId: null,
  serverId: null,
  status: 'idle',
  reason: null,
  notice: null,
}

/** 客户端对外暴露的快照, React 层据此渲染. */
export interface MonitorSnapshotState {
  connected: boolean
  /**
   * 每台服务器各自的活动命令.
   *
   * 后端执行槽是按服务器隔离的, 前端也必须按 serverId 分组:
   * 用单个全局命令状态会导致 A 服务器的输出显示在 B 的页面,
   * 并让 B 页面的"取消"按钮取消掉 A 的命令.
   */
  commands: Map<string, ActiveCommand>
  terminal: TerminalState
  error: string | null
}

/** 终端输出回调, 由 xterm 实例注册. */
export type TerminalDataHandler = (data: Uint8Array) => void
/** 终端清屏回调: 续传出现空洞时由面板重置 xterm. */
export type TerminalResetHandler = () => void

/** 把单个事件归并为命令状态表; 不属于任何已跟踪命令的事件原样返回. */
function reduceCommands(
  prev: Map<string, ActiveCommand>,
  event: StreamEvent,
): Map<string, ActiveCommand> {
  if (
    event.type !== 'command.status' &&
    event.type !== 'command.output' &&
    event.type !== 'command.finished'
  ) {
    return prev
  }

  const commandId = event.commandId
  // 找到该 commandId 对应的服务器键; 事件本身携带 serverId, 可直接用.
  const serverId = event.serverId
  const current = prev.get(serverId)
  if (!current || current.commandId !== commandId) return prev

  const next = new Map(prev)
  next.set(serverId, reduceCommand(current, event) ?? current)
  return next
}

/** 把单个事件归并为新的命令状态; 不属于该命令的事件原样返回. */
function reduceCommand(prev: ActiveCommand, event: StreamEvent): ActiveCommand | null {
  switch (event.type) {
    case 'command.status':
      return { ...prev, status: event.status }
    case 'command.output': {
      // event.data 是一次输出分块(最长 8 KiB), 可能包含多行, 不能按
      // 单行长度裁剪——那会永久丢失后半段输出. 长行只影响渲染, 由 CSS 换行处理.
      const lines = [...prev.lines, { kind: event.stream, text: event.data }]
      const overflow = lines.length > MAX_LINES
      return {
        ...prev,
        lines: overflow ? lines.slice(-MAX_LINES) : lines,
        // 只标记"因行数上限丢弃了旧输出", 与服务端的字节上限区分开.
        truncated: prev.truncated || overflow,
      }
    }
    case 'command.finished': {
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

/**
 * 按需连接的实时客户端.
 *
 * 生命周期: `ensureConnected()` 按需建立连接; 空闲(无活动命令/终端)时
 * 自动断开. 断线后按指数退避加抖动重连; 终端会话保留在服务端,
 * 重连后按 seq 续传.
 */
export class MonitorClient {
  private socket: WebSocket | null = null
  private retryAttempt = 0
  private reconnectTimer: number | null = null
  private idleTimer: number | null = null
  /** 空闲主动断开的连接: onclose 据此跳过自动重连. */
  private idleClosed = false
  private disposed = false
  private terminalHandler: TerminalDataHandler | null = null
  private terminalResetHandler: TerminalResetHandler | null = null
  private currentTerminalId: string | null = null
  /** 浏览器已处理的终端输出序列号(续传位置). */
  private lastTerminalSeq = 0

  private state: MonitorSnapshotState = {
    connected: false,
    commands: new Map<string, ActiveCommand>(),
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

  /** 按需建立连接; 已连接/正在连接/已销毁时为空操作. */
  ensureConnected(): void {
    if (this.disposed) return
    this.idleClosed = false
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.connect()
  }

  /** 建立连接; 已连接或已销毁时为空操作. */
  private connect(): void {
    if (this.disposed) return
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/admin/stream`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.onopen = (): void => {
      this.retryAttempt = 0
      this.patch({ connected: true, error: null })
      // 断线重连或页面刷新: 会话若仍在服务端运行, 按最后处理的 seq 续传.
      this.resumeTerminal()
    }

    socket.onmessage = (event: MessageEvent): void => {
      if (event.data instanceof ArrayBuffer) {
        this.handleTerminalFrame(event.data)
        return
      }
      if (typeof event.data !== 'string') return
      try {
        this.applyEvent(JSON.parse(event.data) as StreamEvent)
      } catch {
        // 非法消息忽略, 不断开连接.
      }
    }

    socket.onclose = (): void => {
      this.socket = null
      // 断线时不能继续展示"执行中": 服务端已按断线清理命令运行态.
      const commands = new Map(this.state.commands)
      for (const [serverId, command] of commands) {
        if (command.status === 'queued' || command.status === 'running') {
          commands.set(serverId, { ...command, status: 'disconnected' })
        }
      }
      const terminal = this.state.terminal
      this.patch({
        connected: false,
        commands,
        // 终端会话保留在服务端, 标记为重连中而不是结束.
        terminal:
          terminal.status === 'opening' || terminal.status === 'open'
            ? { ...terminal, status: 'reconnecting' }
            : terminal,
      })
      // 空闲主动断开: 不重连, 等下一次 ensureConnected.
      if (this.idleClosed) return
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
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.socket?.close()
    this.socket = null
    this.listeners.clear()
    this.terminalHandler = null
    this.terminalResetHandler = null
    this.currentTerminalId = null
    this.lastTerminalSeq = 0
  }

  startCommand(commandId: string, serverId: string): void {
    const commands = new Map(this.state.commands)
    commands.set(serverId, {
      commandId,
      serverId,
      status: 'queued',
      exitCode: null,
      durationMs: null,
      outputTruncated: false,
      truncated: false,
      lines: [],
    })
    this.patch({ commands })
  }

  /** 清除指定服务器的命令记录; 不传时清除全部. */
  clearCommand(serverId?: string): void {
    if (serverId === undefined) {
      this.patch({ commands: new Map<string, ActiveCommand>() })
      return
    }
    if (!this.state.commands.has(serverId)) return
    const commands = new Map(this.state.commands)
    commands.delete(serverId)
    this.patch({ commands })
  }

  /**
   * 登记当前终端会话.
   *
   * `status` 为 `opening`(刚创建)或 `open`(页面刷新后发现的活动会话).
   * 登记会重置续传位置: 调用方应先清屏, 随后由 Agent 缓冲从头重放.
   * opening 阶段服务端只绑定连接, 不重放.
   */
  setTerminalSession(sessionId: string, serverId: string, status: 'opening' | 'open' = 'opening'): void {
    this.currentTerminalId = sessionId
    this.lastTerminalSeq = 0
    this.patch({ terminal: { sessionId, serverId, status, reason: null, notice: null } })
    this.send({ type: 'terminal.resume', session_id: sessionId, last_seq: 0 })
  }

  setTerminalHandler(handler: TerminalDataHandler | null): void {
    this.terminalHandler = handler
  }

  setTerminalResetHandler(handler: TerminalResetHandler | null): void {
    this.terminalResetHandler = handler
  }

  /** 按最后处理的 seq 请求续传; 未连接时为空操作, 由 onopen 再次触发. */
  resumeTerminal(): void {
    const terminal = this.state.terminal
    if (!terminal.sessionId) return
    if (
      terminal.status !== 'opening' &&
      terminal.status !== 'open' &&
      terminal.status !== 'reconnecting'
    ) {
      return
    }
    this.send({ type: 'terminal.resume', session_id: terminal.sessionId, last_seq: this.lastTerminalSeq })
  }

  /**
   * 键盘输入: 二进制帧 `0x01 + 数据`, 会话未就绪时丢弃.
   *
   * 单帧上限与服务端一致(8 KiB), 大段粘贴在此分片, 避免被 DO/Agent 丢弃.
   */
  sendTerminalInput(data: Uint8Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (!this.currentTerminalId) return
    if (this.state.terminal.status !== 'open') return

    for (let offset = 0; offset < data.length; offset += TERMINAL_INPUT_CHUNK_SIZE) {
      const payload = data.subarray(
        offset,
        Math.min(offset + TERMINAL_INPUT_CHUNK_SIZE, data.length),
      )
      const frame = new Uint8Array(payload.length + 1)
      frame[0] = TERMINAL_INPUT_TYPE
      frame.set(payload, 1)
      socket.send(frame)
    }
  }

  sendTerminalResize(cols: number, rows: number): void {
    this.send({ type: 'terminal.resize', session_id: this.currentTerminalId, cols, rows })
  }

  closeTerminal(): void {
    this.send({ type: 'terminal.close', session_id: this.currentTerminalId })
  }

  /** 清除一次性终端提示(输入过载等). */
  clearTerminalNotice(): void {
    if (this.state.terminal.notice === null) return
    this.patch({ terminal: { ...this.state.terminal, notice: null } })
  }

  /** 发送 JSON 控制消息; 未连接或终端未建立时静默丢弃. */
  private send(payload: Record<string, unknown>): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (!payload.session_id) return
    socket.send(JSON.stringify(payload))
  }

  /** 处理终端输出二进制帧: 去重后交给 xterm. */
  private handleTerminalFrame(frame: ArrayBuffer): void {
    if (frame.byteLength <= TERMINAL_OUTPUT_HEADER_LEN) return
    const bytes = new Uint8Array(frame)
    if (bytes[0] !== TERMINAL_OUTPUT_TYPE) return

    const seq = Number(new DataView(frame).getBigUint64(1))
    // 续传与实时帧可能重叠, 只处理未出现过的序号.
    if (seq <= this.lastTerminalSeq) return
    this.lastTerminalSeq = seq
    this.terminalHandler?.(bytes.subarray(TERMINAL_OUTPUT_HEADER_LEN))
  }

  private patch(partial: Partial<MonitorSnapshotState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) listener(this.state)
    // 状态变化后重新评估是否可以断开空闲连接.
    this.scheduleIdleDisconnect()
  }

  private applyEvent(event: StreamEvent): void {
    // 终端事件带有续传/重置等副作用, 单独处理.
    if (this.handleTerminalEvent(event)) return

    this.patch({
      commands: reduceCommands(this.state.commands, event),
      error: event.type === 'error' ? event.message : this.state.error,
    })
  }

  /** 返回 true 表示该事件已由终端状态机消费. */
  private handleTerminalEvent(event: StreamEvent): boolean {
    switch (event.type) {
      case 'terminal.opened': {
        if (!this.matchesTerminal(event.sessionId)) return true
        // 会话已结束(例如关闭与握手竞态)时不再改回 open.
        if (this.state.terminal.status === 'closed') return true
        this.patch({ terminal: { ...this.state.terminal, status: 'open' } })
        // 握手完成后再请求一次续传, 取回握手前产生的输出.
        this.resumeTerminal()
        return true
      }
      case 'terminal.resumed': {
        if (!this.matchesTerminal(event.sessionId)) return true
        if (this.state.terminal.status !== 'closed') {
          this.patch({ terminal: { ...this.state.terminal, status: 'open' } })
        }
        return true
      }
      case 'terminal.gap': {
        if (!this.matchesTerminal(event.sessionId)) return true
        // 续传位置已被 Agent 缓冲淘汰: 清屏后从头拉取保留的输出.
        this.lastTerminalSeq = 0
        this.terminalResetHandler?.()
        this.send({ type: 'terminal.resume', session_id: event.sessionId, last_seq: 0 })
        return true
      }
      case 'terminal.error': {
        if (!this.matchesTerminal(event.sessionId)) return true
        this.patch({ terminal: { ...this.state.terminal, notice: event.message } })
        return true
      }
      case 'terminal.detached': {
        if (!this.matchesTerminal(event.sessionId)) return true
        // 会话已被其他窗口接管: 停止输出, 不自动重连; 保留 sessionId 与 seq,
        // 用户点击"接管终端"时可以从断点继续.
        this.patch({
          terminal: { ...this.state.terminal, status: 'closed', reason: 'detached', notice: null },
        })
        return true
      }
      case 'terminal.closed': {
        if (!this.matchesTerminal(event.sessionId)) return true
        this.patch({
          terminal: { ...this.state.terminal, status: 'closed', reason: event.reason, notice: null },
        })
        return true
      }
      default:
        return false
    }
  }

  private matchesTerminal(sessionId: string): boolean {
    return this.currentTerminalId === sessionId
  }

  /** 无活动命令且无终端会话时, 定时关闭连接(按需连接的另一半). */
  private scheduleIdleDisconnect(): void {
    if (this.disposed) return
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.isBusy()) return

    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null
      if (this.disposed || this.isBusy()) return
      this.idleClosed = true
      this.socket?.close()
    }, IDLE_DISCONNECT_MS)
  }

  private isBusy(): boolean {
    for (const command of this.state.commands.values()) {
      if (command.status === 'queued' || command.status === 'running') return true
    }
    const status = this.state.terminal.status
    return status === 'opening' || status === 'open' || status === 'reconnecting'
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.idleClosed) return

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