/**
 * MonitorDO: 单一 Durable Object, 负责 Agent/Dashboard WebSocket 会话、
 * 最新指标缓存、在线状态以及活动命令的运行态.
 *
 * 关键约束:
 * - 启用 WebSocket Hibernation, JS 内存不保证持续存在, 因此连接身份放在
 *   WebSocket attachment 中, 活动命令状态放在 DO 自有 SQLite storage 中.
 * - 不保存指标历史, 不保存命令历史, 不保存命令输出.
 */

import type { Env } from '../../shared/types'
import { ServersRepository } from '../db/servers'

/** 离线阈值: 2 个心跳周期. Agent 每 15 秒发送一次 ping. */
export const OFFLINE_TIMEOUT_MS = 30_000
/** Alarm 检查间隔略小于阈值, 保证状态变化能及时被发现. */
const ALARM_INTERVAL_MS = 10_000
/** 服务端超时兜底相对 Agent 超时的宽限, 让 Agent 的最终结果先到. */
const COMMAND_TIMEOUT_GRACE_MS = 5_000
/** 终端输出活跃度落盘节流, 避免每个输出分片都写 storage. */
const TERMINAL_ACTIVITY_WRITE_MS = 30_000

/**
 * 审计日志.
 *
 * 只记录操作人、目标与结果(状态/退出码/耗时), 绝不记录命令内容或命令输出:
 * 命令体可能含密钥, 输出可能含任意业务数据, 都不应进入持久化日志.
 */
function audit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields, ts: Date.now() }))
}

export type CommandStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'disconnected'

export interface CommandRecord {
  commandId: string
  serverId: string
  admin: string
  status: CommandStatus
  createdAt: number
  timeoutSeconds: number
  /** 最近一次状态时间, 用于服务端超时兜底. */
  updatedAt: number
}

/** 连接身份, 序列化进 WebSocket attachment. */
interface AgentAttachment {
  role: 'agent'
  serverId: string
}

interface DashboardAttachment {
  role: 'dashboard'
  admin: string
}

type Attachment = AgentAttachment | DashboardAttachment

interface ServerRuntime {
  lastSeenAt: number
  /** 最新指标快照, 仅内存缓存. */
  metrics: unknown
  sampleTs: number | null
  receivedTs: number | null
  status: 'online' | 'offline'
}

export type TerminalStatus = 'opening' | 'open'

/** 终端会话运行态. 与命令一样只存元数据, 不存任何输出. */
export interface TerminalRecord {
  sessionId: string
  serverId: string
  admin: string
  status: TerminalStatus
  cols: number
  rows: number
  /** 服务端兜底用的时长上限, 与创建时下发给 Agent 的值一致. */
  idleTimeoutSeconds: number
  maxDurationSeconds: number
  createdAt: number
  lastActivityAt: number
}

const COMMAND_PREFIX = 'cmd:'
const TERMINAL_PREFIX = 'term:'
/** 终端握手超时: 旧版 Agent 会静默忽略 terminal.open. */
const TERMINAL_OPEN_TIMEOUT_MS = 5_000
/** resize 的硬性范围, 与 Agent 侧保持一致. */
const MIN_COLS = 20
const MAX_COLS = 500
const MIN_ROWS = 5
const MAX_ROWS = 200
/** 终端时长范围, 与 SETTINGS_BOUNDS 及 Agent 侧保持一致. */
const MIN_IDLE_TIMEOUT = 60
const MAX_IDLE_TIMEOUT = 3_600
const MIN_MAX_DURATION = 300
const MAX_MAX_DURATION = 7_200
/** 命令参数范围, 与 SETTINGS_BOUNDS 保持一致. */
const MIN_COMMAND_TIMEOUT = 5
const MAX_COMMAND_TIMEOUT = 300
const MIN_OUTPUT_BYTES = 65_536
const MAX_OUTPUT_BYTES = 16_777_216
const COMMAND_STATUSES: readonly CommandStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'disconnected',
]

export class MonitorDO implements DurableObject {
  private readonly serverStates = new Map<string, ServerRuntime>()

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    // 对象被回收或重新部署后, 内存状态不再可信:
    // 先按 D1 全量置为离线, 再依据仍然存在的 WebSocket 连接重建在线状态.
    this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now()
      const repo = new ServersRepository(this.env.DB)
      try {
        await repo.resetAllStatuses(now)
        for (const ws of this.ctx.getWebSockets()) {
          const attachment = ws.deserializeAttachment() as Attachment | null
          if (attachment?.role !== 'agent') continue
          this.serverStates.set(attachment.serverId, {
            lastSeenAt: now,
            metrics: null,
            sampleTs: null,
            receivedTs: null,
            status: 'online',
          })
          await repo.setStatus(attachment.serverId, 'online', now)
        }
      } catch (error) {
        console.error(
          JSON.stringify({ level: 'error', event: 'monitor.state_rebuild_failed', error: String(error) }),
        )
      }
    })
  }

  /* ------------------------------- HTTP 入口 ------------------------------- */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws/agent') return this.handleAgentSocket(request)
    if (url.pathname === '/ws/dashboard') return this.handleDashboardSocket(request)
    if (url.pathname === '/api/metrics') return this.handleLatestMetrics(url)
    if (url.pathname === '/api/command' && request.method === 'POST') return this.handleCreateCommand(request)
    if (url.pathname.startsWith('/api/command/') && request.method === 'GET') return this.handleCommandStatus(url)
    if (url.pathname.startsWith('/api/command/') && url.pathname.endsWith('/cancel')) {
      return this.handleCancelCommand(request, url)
    }
    if (url.pathname === '/api/terminal' && request.method === 'POST') return this.handleCreateTerminal(request)
    if (url.pathname.startsWith('/api/terminal/') && request.method === 'GET') {
      return this.handleTerminalStatus(url)
    }
    if (url.pathname.startsWith('/api/terminal/') && url.pathname.endsWith('/close')) {
      return this.handleCloseTerminal(request, url)
    }
    if (url.pathname === '/api/server/disable' && request.method === 'POST') {
      return this.handleDisableServer(request)
    }

    return new Response('Not found', { status: 404 })
  }

  /* ------------------------------- WebSocket ------------------------------- */

  private handleAgentSocket(request: Request): Response {
    const serverId = request.headers.get('x-monix-server-id')
    if (!serverId) return new Response('Unauthorized', { status: 401 })

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    // 同一服务器只保留最新连接, 旧连接直接关闭.
    for (const existing of this.ctx.getWebSockets()) {
      const attachment = existing.deserializeAttachment() as Attachment | null
      if (attachment?.role === 'agent' && attachment.serverId === serverId) {
        try {
          existing.close(4000, 'replaced by new connection')
        } catch {
          // 已关闭的连接忽略.
        }
      }
    }

    this.ctx.acceptWebSocket(server)
    const attachment: AgentAttachment = { role: 'agent', serverId }
    server.serializeAttachment(attachment)

    this.markOnline(serverId)

    return new Response(null, { status: 101, webSocket: client })
  }

  private handleDashboardSocket(request: Request): Response {
    const admin = request.headers.get('x-monix-admin')
    if (!admin) return new Response('Unauthorized', { status: 401 })

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ role: 'dashboard', admin } satisfies DashboardAttachment)

    // 新订阅者立即收到当前快照, 避免等待下一次指标上报.
    const snapshot = this.buildSnapshot()
    server.send(JSON.stringify({ type: 'snapshot', servers: snapshot }))

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      ws.close(4001, 'binary not supported')
      return
    }
    if (message.length > 512 * 1024) {
      ws.send(JSON.stringify({ type: 'error', message: '消息超过大小限制' }))
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: '消息必须是合法 JSON' }))
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const msg = parsed as Record<string, unknown>
    const type = typeof msg.type === 'string' ? msg.type : ''

    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment) {
      ws.close(4001, 'missing identity')
      return
    }

    if (attachment.role === 'agent') {
      await this.handleAgentMessage(ws, attachment.serverId, type, msg)
      return
    }

    // Dashboard 侧控制消息: ping 与终端输入/尺寸/关闭.
    switch (type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
        return
      case 'terminal.input':
        await this.onTerminalInput(attachment.admin, msg)
        return
      case 'terminal.resize':
        await this.onTerminalResize(attachment.admin, msg)
        return
      case 'terminal.close':
        await this.onTerminalCloseRequest(attachment.admin, msg)
        return
      default:
        return
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment) return

    // Dashboard 断开: 同一管理员还有其它标签页时保留终端会话, 全部断开才终止.
    if (attachment.role === 'dashboard') {
      const stillConnected = this.ctx.getWebSockets().some((other) => {
        if (other === ws) return false
        const a = other.deserializeAttachment() as Attachment | null
        return a?.role === 'dashboard' && a.admin === attachment.admin
      })
      if (!stillConnected) await this.closeTerminalsForAdmin(attachment.admin)
      return
    }

    // 仍有其它连接时不做离线处理.
    const stillConnected = this.ctx.getWebSockets().some((other) => {
      if (other === ws) return false
      const a = other.deserializeAttachment() as Attachment | null
      return a?.role === 'agent' && a.serverId === attachment.serverId
    })
    if (stillConnected) return

    // Agent 断开: 活动命令无法再确认结果, 必须显式结束并释放执行槽.
    await this.failActiveCommandsForServer(attachment.serverId)
    // 其终端会话也一并失效.
    await this.closeTerminalsForServer(attachment.serverId)
    await this.markOffline(attachment.serverId)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws)
  }

  /* --------------------------- Agent 消息处理 --------------------------- */

  private async handleAgentMessage(
    ws: WebSocket,
    serverId: string,
    type: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    switch (type) {
      case 'metrics': {
        await this.onMetrics(serverId, msg)
        return
      }
      case 'command.started': {
        await this.onCommandStatus(serverId, msg, 'running')
        return
      }
      case 'command.output': {
        await this.onCommandOutput(serverId, msg)
        return
      }
      case 'command.finished': {
        await this.onCommandFinished(serverId, msg)
        return
      }
      case 'terminal.opened': {
        await this.onTerminalOpened(serverId, msg)
        return
      }
      case 'terminal.output': {
        await this.onTerminalOutput(serverId, msg)
        return
      }
      case 'terminal.closed': {
        await this.onTerminalClosed(serverId, msg)
        return
      }
      case 'ping': {
        // 心跳同样代表存活: 采集间隔可能远大于离线阈值.
        const state = this.ensureState(serverId)
        state.lastSeenAt = Date.now()
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
        return
      }
      default: {
        ws.send(JSON.stringify({ type: 'error', message: `未知消息类型: ${type}` }))
      }
    }
  }

  private async onMetrics(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const now = Date.now()
    const sampleTs = typeof msg.sample_ts === 'number' && Number.isFinite(msg.sample_ts) ? msg.sample_ts : null
    const metrics = msg.metrics ?? null

    const state = this.ensureState(serverId)
    state.lastSeenAt = now
    state.metrics = metrics
    state.sampleTs = sampleTs
    state.receivedTs = now
    const wasOffline = state.status === 'offline'
    state.status = 'online'

    if (wasOffline) {
      await this.syncStatus(serverId, 'online')
      this.broadcast({ type: 'server.status', serverId, status: 'online', ts: now })
    }

    this.broadcast({ type: 'metrics', serverId, sampleTs, receivedTs: now, metrics })
    await this.ensureAlarm()
  }

  private async onCommandStatus(serverId: string, msg: Record<string, unknown>, status: CommandStatus): Promise<void> {
    const commandId = typeof msg.command_id === 'string' ? msg.command_id : ''
    if (!commandId) return

    const record = await this.ctx.storage.get<CommandRecord>(COMMAND_PREFIX + commandId)
    if (!record || record.serverId !== serverId) return

    record.status = status
    record.updatedAt = Date.now()
    await this.ctx.storage.put(COMMAND_PREFIX + commandId, record)
    this.sendToAdmin(record.admin, { type: 'command.status', commandId, serverId, status })
  }

  private async onCommandOutput(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const commandId = typeof msg.command_id === 'string' ? msg.command_id : ''
    const data = typeof msg.data === 'string' ? msg.data : ''
    if (!commandId || data.length === 0) return

    // 输出只做转发, 不落 storage. 必须 await, 否则并发 storage 读取会让分片乱序.
    const forwarded = await this.forwardToCommandOwner(commandId, {
      type: 'command.output',
      commandId,
      serverId,
      stream: msg.stream === 'stderr' ? 'stderr' : 'stdout',
      seq: typeof msg.seq === 'number' ? msg.seq : 0,
      data,
    })
    if (!forwarded) {
      // 服务端已失去该命令上下文: 要求 Agent 终止, 不能静默忽略.
      this.sendToAgent(serverId, { type: 'command.cancel', command_id: commandId })
    }
  }

  private async onCommandFinished(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const commandId = typeof msg.command_id === 'string' ? msg.command_id : ''
    if (!commandId) return

    const key = COMMAND_PREFIX + commandId
    const record = await this.ctx.storage.get<CommandRecord>(key)
    if (!record || record.serverId !== serverId) {
      // 服务端已失去该命令上下文: 要求 Agent 终止, 不能静默忽略.
      this.sendToAgent(serverId, { type: 'command.cancel', command_id: commandId })
      return
    }

    const status = normalizeCommandStatus(msg.status)
    const exitCode = typeof msg.exit_code === 'number' ? msg.exit_code : null
    const durationMs = typeof msg.duration_ms === 'number' ? msg.duration_ms : null

    this.sendToAdmin(record.admin, {
      type: 'command.finished',
      commandId,
      serverId,
      status,
      exitCode,
      durationMs,
      outputTruncated: msg.output_truncated === true,
    })

    audit('audit.command_finished', {
      admin: record.admin,
      serverId,
      commandId,
      status,
      exitCode,
      durationMs: durationMs ?? Date.now() - record.createdAt,
    })

    await this.ctx.storage.delete(key)
  }

  /** 按 command_id 找到发起者并定向转发, 避免广播给无关连接. */
  private async forwardToCommandOwner(commandId: string, payload: unknown): Promise<boolean> {
    const record = await this.ctx.storage.get<CommandRecord>(COMMAND_PREFIX + commandId)
    if (!record) return false
    this.sendToAdmin(record.admin, payload)
    return true
  }

  /* --------------------------- 命令控制 --------------------------- */

  private async handleCreateCommand(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      serverId?: string
      command?: string
      admin?: string
      timeoutSeconds?: number
      maxOutputBytes?: number
    }
    const serverId = body.serverId ?? ''
    const command = body.command ?? ''
    const admin = typeof body.admin === 'string' ? body.admin.trim() : ''
    if (!serverId || !command || !admin) {
      return Response.json({ ok: false, error: '缺少参数' }, { status: 400 })
    }

    const state = this.serverStates.get(serverId)
    if (!state || state.status !== 'online') {
      return Response.json({ ok: false, code: 'SERVER_OFFLINE', error: '目标服务器离线' }, { status: 409 })
    }
    if (!this.hasAgentConnection(serverId)) {
      return Response.json({ ok: false, code: 'SERVER_OFFLINE', error: '目标服务器未建立连接' }, { status: 409 })
    }

    // 终端与一次性命令共用执行槽.
    if (await this.hasActiveExecution(serverId)) {
      return Response.json(
        { ok: false, code: 'EXECUTION_BUSY', error: '该服务器已有执行中的任务' },
        { status: 409 },
      )
    }

    const commandId = crypto.randomUUID()
    const now = Date.now()
    const timeoutSeconds = clampInt(body.timeoutSeconds ?? 60, MIN_COMMAND_TIMEOUT, MAX_COMMAND_TIMEOUT)
    const maxOutputBytes = clampInt(body.maxOutputBytes ?? 1_048_576, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
    const record: CommandRecord = {
      commandId,
      serverId,
      admin,
      status: 'queued',
      createdAt: now,
      timeoutSeconds,
      updatedAt: now,
    }

    // 先持久化再发送: 对象在发送后立刻休眠也不会丢失关联.
    await this.ctx.storage.put(COMMAND_PREFIX + commandId, record)

    const sent = this.sendToAgent(serverId, {
      type: 'command.execute',
      command_id: commandId,
      command,
      timeout_seconds: timeoutSeconds,
      max_output_bytes: maxOutputBytes,
    })

    if (!sent) {
      await this.ctx.storage.delete(COMMAND_PREFIX + commandId)
      return Response.json({ ok: false, code: 'SERVER_OFFLINE', error: '目标服务器连接已断开' }, { status: 409 })
    }

    this.sendToAdmin(record.admin, { type: 'command.status', commandId, serverId, status: 'queued' })
    audit('audit.command_started', { admin, serverId, commandId, timeoutSeconds })
    return Response.json({ ok: true, data: { commandId, status: 'queued', timeoutSeconds: record.timeoutSeconds } })
  }

  private async handleCommandStatus(url: URL): Promise<Response> {
    const commandId = url.pathname.split('/').pop() ?? ''
    const admin = url.searchParams.get('admin') ?? ''
    const record = await this.ctx.storage.get<CommandRecord>(COMMAND_PREFIX + commandId)
    // 命令不存在、已清理或不属于当前管理员时统一 404, 不泄露存在性.
    if (!record || record.admin !== admin) {
      return Response.json({ ok: false, code: 'NOT_FOUND', error: '命令不存在或已结束' }, { status: 404 })
    }
    return Response.json({ ok: true, data: record })
  }

  private async handleCancelCommand(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.slice('/api/command/'.length)
    const commandId = path.replace(/\/cancel$/, '')
    const body = (await request.json().catch(() => ({}))) as { admin?: string }
    const admin = body.admin ?? url.searchParams.get('admin') ?? ''

    const record = await this.ctx.storage.get<CommandRecord>(COMMAND_PREFIX + commandId)
    if (!record || record.admin !== admin) {
      return Response.json({ ok: false, code: 'NOT_FOUND', error: '命令不存在或已结束' }, { status: 404 })
    }

    const sent = this.sendToAgent(record.serverId, { type: 'command.cancel', command_id: commandId })
    if (!sent) {
      // 连接已断开: 无法保证远端进程已停止, 明确返回结果未知.
      record.status = 'disconnected'
      record.updatedAt = Date.now()
      await this.ctx.storage.put(COMMAND_PREFIX + commandId, record)
      this.sendToAdmin(record.admin, {
        type: 'command.finished',
        commandId,
        serverId: record.serverId,
        status: 'disconnected',
        exitCode: null,
        durationMs: null,
        outputTruncated: false,
      })
      audit('audit.command_finished', {
        admin: record.admin,
        serverId: record.serverId,
        commandId,
        status: 'disconnected',
        exitCode: null,
        durationMs: Date.now() - record.createdAt,
      })
      await this.ctx.storage.delete(COMMAND_PREFIX + commandId)
      return Response.json({ ok: true, data: { status: 'disconnected' } })
    }

    return Response.json({ ok: true, data: { status: record.status } })
  }

  /* --------------------------- 终端会话 --------------------------- */

  private async handleCreateTerminal(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      serverId?: string
      admin?: string
      cols?: number
      rows?: number
      idleTimeoutSeconds?: number
      maxDurationSeconds?: number
    }
    const serverId = body.serverId ?? ''
    const admin = body.admin ?? ''
    if (!serverId || !admin) {
      return Response.json({ ok: false, code: 'BAD_REQUEST', error: '缺少参数' }, { status: 400 })
    }

    const state = this.serverStates.get(serverId)
    if (!state || state.status !== 'online') {
      return Response.json({ ok: false, code: 'SERVER_OFFLINE', error: '目标服务器离线' }, { status: 409 })
    }
    if (!this.hasAgentConnection(serverId)) {
      return Response.json({ ok: false, code: 'SERVER_OFFLINE', error: '目标服务器未建立连接' }, { status: 409 })
    }

    // 终端与一次性命令共用执行槽: 任一活动即拒绝.
    if (await this.hasActiveExecution(serverId)) {
      return Response.json(
        { ok: false, code: 'EXECUTION_BUSY', error: '该服务器已有执行中的任务' },
        { status: 409 },
      )
    }

    const sessionId = crypto.randomUUID()
    const now = Date.now()
    const idleTimeoutSeconds = clampInt(body.idleTimeoutSeconds ?? 600, MIN_IDLE_TIMEOUT, MAX_IDLE_TIMEOUT)
    const maxDurationSeconds = clampInt(body.maxDurationSeconds ?? 3_600, MIN_MAX_DURATION, MAX_MAX_DURATION)
    const record: TerminalRecord = {
      sessionId,
      serverId,
      admin,
      status: 'opening',
      cols: clampInt(body.cols ?? 80, MIN_COLS, MAX_COLS),
      rows: clampInt(body.rows ?? 24, MIN_ROWS, MAX_ROWS),
      idleTimeoutSeconds,
      maxDurationSeconds,
      createdAt: now,
      lastActivityAt: now,
    }

    // 先持久化再发送: 对象在发送后立刻休眠也不会丢失关联.
    await this.ctx.storage.put(TERMINAL_PREFIX + sessionId, record)

    const sent = this.sendToAgent(serverId, {
      type: 'terminal.open',
      session_id: sessionId,
      cols: record.cols,
      rows: record.rows,
      idle_timeout_seconds: idleTimeoutSeconds,
      max_duration_seconds: maxDurationSeconds,
    })

    if (!sent) {
      await this.ctx.storage.delete(TERMINAL_PREFIX + sessionId)
      return Response.json({ ok: false, code: 'SERVER_OFFLINE', error: '目标服务器连接已断开' }, { status: 409 })
    }

    await this.ensureAlarm()
    audit('audit.terminal_opened', {
      admin,
      serverId,
      sessionId,
      cols: record.cols,
      rows: record.rows,
      idleTimeoutSeconds,
      maxDurationSeconds,
    })
    return Response.json({ ok: true, data: { sessionId, cols: record.cols, rows: record.rows } })
  }

  private async handleTerminalStatus(url: URL): Promise<Response> {
    const sessionId = url.pathname.split('/').pop() ?? ''
    const admin = url.searchParams.get('admin') ?? ''
    const record = await this.ctx.storage.get<TerminalRecord>(TERMINAL_PREFIX + sessionId)
    if (!record || record.admin !== admin) {
      return Response.json({ ok: false, code: 'NOT_FOUND', error: '会话不存在或已结束' }, { status: 404 })
    }
    return Response.json({ ok: true, data: record })
  }

  private async handleCloseTerminal(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.slice('/api/terminal/'.length)
    const sessionId = path.replace(/\/close$/, '')
    const body = (await request.json().catch(() => ({}))) as { admin?: string }
    const admin = body.admin ?? url.searchParams.get('admin') ?? ''

    const record = await this.ctx.storage.get<TerminalRecord>(TERMINAL_PREFIX + sessionId)
    if (!record || record.admin !== admin) {
      return Response.json({ ok: false, code: 'NOT_FOUND', error: '会话不存在或已结束' }, { status: 404 })
    }

    await this.closeTerminal(record, 'closed_by_user')
    return Response.json({ ok: true, data: { sessionId } })
  }

  private async onTerminalOpened(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    if (!sessionId) return

    const key = TERMINAL_PREFIX + sessionId
    const record = await this.ctx.storage.get<TerminalRecord>(key)
    if (!record || record.serverId !== serverId) {
      this.sendToAgent(serverId, { type: 'terminal.close', session_id: sessionId })
      return
    }

    record.status = 'open'
    record.lastActivityAt = Date.now()
    await this.ctx.storage.put(key, record)

    this.sendToAdmin(record.admin, {
      type: 'terminal.opened',
      sessionId,
      serverId,
      cols: record.cols,
      rows: record.rows,
    })
  }

  private async onTerminalOutput(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    const data = typeof msg.data === 'string' ? msg.data : ''
    if (!sessionId || data.length === 0) return

    const key = TERMINAL_PREFIX + sessionId
    const record = await this.ctx.storage.get<TerminalRecord>(key)
    if (!record || record.serverId !== serverId) {
      // 服务端已失去该会话上下文: 要求 Agent 关闭, 不能静默忽略.
      this.sendToAgent(serverId, { type: 'terminal.close', session_id: sessionId })
      return
    }

    // 输出也算活跃, 但按窗口节流落盘, 避免每个分片都写 storage.
    const now = Date.now()
    if (now - record.lastActivityAt >= TERMINAL_ACTIVITY_WRITE_MS) {
      record.lastActivityAt = now
      await this.ctx.storage.put(key, record)
    }

    // 输出只做转发, 不落 storage, 也不做累积截断(由 Agent 侧速率限制兜底).
    this.sendToAdmin(record.admin, {
      type: 'terminal.output',
      sessionId,
      serverId,
      seq: typeof msg.seq === 'number' ? msg.seq : 0,
      data,
    })
  }

  private async onTerminalClosed(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    if (!sessionId) return

    const key = TERMINAL_PREFIX + sessionId
    const record = await this.ctx.storage.get<TerminalRecord>(key)
    if (!record || record.serverId !== serverId) return

    this.sendToAdmin(record.admin, {
      type: 'terminal.closed',
      sessionId,
      serverId,
      reason: typeof msg.reason === 'string' ? msg.reason : 'error',
    })
    await this.ctx.storage.delete(key)
  }

  /** Dashboard 下发的键盘输入, 校验归属后转发给 Agent. */
  private async onTerminalInput(admin: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    const data = typeof msg.data === 'string' ? msg.data : ''
    if (!sessionId || data.length === 0) return
    if (data.length > 16 * 1024) return

    const key = TERMINAL_PREFIX + sessionId
    const record = await this.ctx.storage.get<TerminalRecord>(key)
    if (!record || record.admin !== admin || record.status !== 'open') return

    record.lastActivityAt = Date.now()
    await this.ctx.storage.put(key, record)

    this.sendToAgent(record.serverId, {
      type: 'terminal.input',
      session_id: sessionId,
      data,
    })
  }

  private async onTerminalResize(admin: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    if (!sessionId) return

    const key = TERMINAL_PREFIX + sessionId
    const record = await this.ctx.storage.get<TerminalRecord>(key)
    if (!record || record.admin !== admin || record.status !== 'open') return

    const cols = clampInt(typeof msg.cols === 'number' ? msg.cols : record.cols, MIN_COLS, MAX_COLS)
    const rows = clampInt(typeof msg.rows === 'number' ? msg.rows : record.rows, MIN_ROWS, MAX_ROWS)
    record.cols = cols
    record.rows = rows
    record.lastActivityAt = Date.now()
    await this.ctx.storage.put(key, record)

    this.sendToAgent(record.serverId, {
      type: 'terminal.resize',
      session_id: sessionId,
      cols,
      rows,
    })
  }

  private async onTerminalCloseRequest(admin: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    if (!sessionId) return

    const record = await this.ctx.storage.get<TerminalRecord>(TERMINAL_PREFIX + sessionId)
    if (!record || record.admin !== admin) return

    await this.closeTerminal(record, 'closed_by_user')
  }

  /** 关闭单个会话: 通知 Agent 并立即释放服务端运行态. */
  private async closeTerminal(record: TerminalRecord, reason: string): Promise<void> {
    this.sendToAgent(record.serverId, { type: 'terminal.close', session_id: record.sessionId })
    this.sendToAdmin(record.admin, {
      type: 'terminal.closed',
      sessionId: record.sessionId,
      serverId: record.serverId,
      reason,
    })
    audit('audit.terminal_closed', {
      admin: record.admin,
      serverId: record.serverId,
      sessionId: record.sessionId,
      reason,
      durationMs: Date.now() - record.createdAt,
    })
    await this.ctx.storage.delete(TERMINAL_PREFIX + record.sessionId)
  }

  /** Dashboard 断开时立即终止该管理员的全部会话. */
  private async closeTerminalsForAdmin(admin: string): Promise<void> {
    const entries = await this.ctx.storage.list<TerminalRecord>({ prefix: TERMINAL_PREFIX })
    for (const record of entries.values()) {
      if (record.admin === admin) await this.closeTerminal(record, 'closed_by_user')
    }
  }

  /** Agent 断开或服务器被禁用时终止其全部会话. */
  private async closeTerminalsForServer(serverId: string): Promise<void> {
    const entries = await this.ctx.storage.list<TerminalRecord>({ prefix: TERMINAL_PREFIX })
    for (const record of entries.values()) {
      if (record.serverId === serverId) await this.closeTerminal(record, 'closed_by_user')
    }
  }

  /**
   * 连接断开或被禁用时结束该服务器的活动命令.
   * 远端进程是否真的停止无法确认, 因此统一以 disconnected 结束并释放执行槽.
   */
  private async failActiveCommandsForServer(serverId: string): Promise<void> {
    const entries = await this.ctx.storage.list<CommandRecord>({ prefix: COMMAND_PREFIX })
    for (const [key, record] of entries) {
      if (record.serverId !== serverId) continue
      if (record.status === 'queued' || record.status === 'running') {
        const durationMs = Date.now() - record.createdAt
        this.sendToAdmin(record.admin, {
          type: 'command.finished',
          commandId: record.commandId,
          serverId: record.serverId,
          status: 'disconnected',
          exitCode: null,
          durationMs,
          outputTruncated: false,
        })
        audit('audit.command_finished', {
          admin: record.admin,
          serverId: record.serverId,
          commandId: record.commandId,
          status: 'disconnected',
          exitCode: null,
          durationMs,
        })
      }
      await this.ctx.storage.delete(key)
    }
  }

  /** 执行槽检查: 一次性命令或终端任一活动即视为占用. */
  private async hasActiveExecution(serverId: string): Promise<boolean> {
    const commands = await this.ctx.storage.list<CommandRecord>({ prefix: COMMAND_PREFIX })
    for (const record of commands.values()) {
      if (record.serverId !== serverId) continue
      if (record.status === 'queued' || record.status === 'running') return true
    }
    const terminals = await this.ctx.storage.list<TerminalRecord>({ prefix: TERMINAL_PREFIX })
    for (const record of terminals.values()) {
      if (record.serverId === serverId) return true
    }
    return false
  }

  /* --------------------------- 查询接口 --------------------------- */

  private handleLatestMetrics(url: URL): Response {
    const serverId = url.searchParams.get('serverId')
    if (serverId) {
      const state = this.serverStates.get(serverId)
      if (!state) return Response.json({ ok: true, data: null })
      return Response.json({
        ok: true,
        data: {
          serverId,
          status: state.status,
          sampleTs: state.sampleTs,
          receivedTs: state.receivedTs,
          metrics: state.metrics,
        },
      })
    }
    return Response.json({ ok: true, data: { servers: this.buildSnapshot() } })
  }

  private buildSnapshot(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const [serverId, state] of this.serverStates) {
      out.push({
        serverId,
        status: state.status,
        sampleTs: state.sampleTs,
        receivedTs: state.receivedTs,
        metrics: state.metrics,
      })
    }
    return out
  }

  /* --------------------------- 禁用服务器 --------------------------- */

  private async handleDisableServer(request: Request): Promise<Response> {
    const body = (await request.json()) as { serverId?: string }
    const serverId = body.serverId ?? ''
    if (!serverId) return Response.json({ ok: false }, { status: 400 })

    // 关闭该服务器的全部连接.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.role === 'agent' && attachment.serverId === serverId) {
        try {
          ws.send(JSON.stringify({ type: 'error', code: 'SERVER_DISABLED', message: '服务器已被禁用' }))
          ws.close(4003, 'server disabled')
        } catch {
          // 忽略已关闭连接.
        }
      }
    }

    // 先给管理员明确的终态, 再清理活动命令.
    await this.failActiveCommandsForServer(serverId)

    // 关闭该服务器的终端会话.
    await this.closeTerminalsForServer(serverId)

    await this.markOffline(serverId)
    return Response.json({ ok: true })
  }

  /* --------------------------- 在线状态 --------------------------- */

  private hasAgentConnection(serverId: string): boolean {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.role === 'agent' && attachment.serverId === serverId) return true
    }
    return false
  }

  private ensureState(serverId: string): ServerRuntime {
    let state = this.serverStates.get(serverId)
    if (!state) {
      state = { lastSeenAt: 0, metrics: null, sampleTs: null, receivedTs: null, status: 'offline' }
      this.serverStates.set(serverId, state)
    }
    return state
  }

  private async markOnline(serverId: string): Promise<void> {
    const now = Date.now()
    const state = this.ensureState(serverId)
    const wasOffline = state.status === 'offline'
    state.lastSeenAt = now
    state.status = 'online'
    if (wasOffline) {
      await this.syncStatus(serverId, 'online')
      this.broadcast({ type: 'server.status', serverId, status: 'online', ts: now })
    }
    await this.ensureAlarm()
  }

  private async markOffline(serverId: string): Promise<void> {
    const state = this.serverStates.get(serverId)
    if (!state) return
    if (state.status === 'offline') return

    state.status = 'offline'
    // 离线后不再保留过期指标, 避免被当作当前值展示.
    state.metrics = null
    state.sampleTs = null
    state.receivedTs = null
    await this.syncStatus(serverId, 'offline')
    this.broadcast({ type: 'server.status', serverId, status: 'offline', ts: Date.now() })
  }

  /** 只在状态变化时写 D1. */
  private async syncStatus(serverId: string, status: 'online' | 'offline'): Promise<void> {
    try {
      await new ServersRepository(this.env.DB).setStatus(serverId, status, Date.now())
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'monitor.status_sync_failed', serverId, error: String(error) }))
    }
  }

  /* --------------------------- Alarm --------------------------- */

  private async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    const next = Date.now() + ALARM_INTERVAL_MS
    if (current === null || current > next) {
      await this.ctx.storage.setAlarm(next)
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    let hasOnline = false

    for (const [serverId, state] of this.serverStates) {
      if (state.status !== 'online') continue
      if (now - state.lastSeenAt > OFFLINE_TIMEOUT_MS) {
        // 对象休眠期间内存中的 lastSeenAt 可能过期, 但连接仍然有效.
        if (this.hasAgentConnection(serverId)) {
          state.lastSeenAt = now
          hasOnline = true
          continue
        }
        await this.markOffline(serverId)
        continue
      }
      hasOnline = true
    }

    // 服务端命令超时兜底: Agent 未按预期结束或连接异常时释放执行槽.
    const commands = await this.ctx.storage.list<CommandRecord>({ prefix: COMMAND_PREFIX })
    for (const [key, record] of commands) {
      if (record.status !== 'queued' && record.status !== 'running') continue
      if (now - record.updatedAt <= record.timeoutSeconds * 1000 + COMMAND_TIMEOUT_GRACE_MS) continue
      this.sendToAgent(record.serverId, { type: 'command.cancel', command_id: record.commandId })
      const durationMs = now - record.createdAt
      this.sendToAdmin(record.admin, {
        type: 'command.finished',
        commandId: record.commandId,
        serverId: record.serverId,
        status: 'timed_out',
        exitCode: null,
        durationMs,
        outputTruncated: false,
      })
      audit('audit.command_finished', {
        admin: record.admin,
        serverId: record.serverId,
        commandId: record.commandId,
        status: 'timed_out',
        exitCode: null,
        durationMs,
      })
      await this.ctx.storage.delete(key)
    }

    const terminals = await this.ctx.storage.list<TerminalRecord>({ prefix: TERMINAL_PREFIX })
    for (const record of terminals.values()) {
      // 终端握手超时: 旧版 Agent 会静默忽略 terminal.open, 必须给出明确结束.
      if (record.status === 'opening') {
        if (now - record.createdAt <= TERMINAL_OPEN_TIMEOUT_MS) continue
        this.sendToAdmin(record.admin, {
          type: 'terminal.closed',
          sessionId: record.sessionId,
          serverId: record.serverId,
          reason: 'open_timeout',
        })
        this.sendToAgent(record.serverId, { type: 'terminal.close', session_id: record.sessionId })
        await this.ctx.storage.delete(TERMINAL_PREFIX + record.sessionId)
        continue
      }

      // 时长兜底: 不依赖 Agent 本地计时.
      const maxDurationSeconds = record.maxDurationSeconds ?? 3_600
      const idleTimeoutSeconds = record.idleTimeoutSeconds ?? 600
      if (now - record.createdAt >= maxDurationSeconds * 1000) {
        await this.closeTerminal(record, 'max_duration')
        continue
      }
      if (now - record.lastActivityAt >= idleTimeoutSeconds * 1000) {
        await this.closeTerminal(record, 'idle_timeout')
      }
    }

    // 仍有在线服务器时继续巡检; 否则停止 Alarm, 让对象可以彻底休眠.
    if (hasOnline) await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS)
  }

  /* --------------------------- 工具 --------------------------- */

  private sendToAgent(serverId: string, payload: unknown): boolean {
    const data = JSON.stringify(payload)
    let sent = false
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.role === 'agent' && attachment.serverId === serverId) {
        try {
          ws.send(data)
          sent = true
        } catch {
          // 发送失败视为未发送.
        }
      }
    }
    return sent
  }

  private broadcast(payload: unknown): void {
    const data = JSON.stringify(payload)
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.role !== 'dashboard') continue
      try {
        ws.send(data)
      } catch {
        // 失效连接由 webSocketClose 清理.
      }
    }
  }

  /** 只发给指定管理员的 Dashboard 连接, 用于命令与终端等私有数据. */
  private sendToAdmin(admin: string, payload: unknown): number {
    const data = JSON.stringify(payload)
    let count = 0
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.role !== 'dashboard' || attachment.admin !== admin) continue
      try {
        ws.send(data)
        count += 1
      } catch {
        // 失效连接由 webSocketClose 清理.
      }
    }
    return count
  }
}

/** 将数值钳制到整数区间; 非有限值回退到下限. */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/** Agent 上报的状态必须落在协议枚举内, 否则按失败处理. */
function normalizeCommandStatus(value: unknown): CommandStatus {
  if (typeof value === 'string' && (COMMAND_STATUSES as readonly string[]).includes(value)) {
    return value as CommandStatus
  }
  return 'failed'
}
