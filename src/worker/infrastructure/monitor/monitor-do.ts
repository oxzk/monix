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
import {
  COMMAND_OUTPUT_MAX,
  COMMAND_OUTPUT_MIN,
  COMMAND_TIMEOUT_MAX,
  COMMAND_TIMEOUT_MIN,
  TERMINAL_COLS_MAX,
  TERMINAL_COLS_MIN,
  TERMINAL_IDLE_TIMEOUT_MAX,
  TERMINAL_IDLE_TIMEOUT_MIN,
  TERMINAL_MAX_DURATION_MAX,
  TERMINAL_MAX_DURATION_MIN,
  TERMINAL_OUTPUT_FRAME_MAX_BYTES,
  TERMINAL_ROWS_MAX,
  TERMINAL_ROWS_MIN,
} from '../../shared/protocol'
import { toPublicMetrics } from '../../shared/public-metrics'
import { ServersRepository } from '../db/servers'
import { loadAgentConfig, SettingsRepository } from '../db/settings'

/** 离线阈值: 2 个心跳周期. Agent 每 15 秒发送一次 ping. */
export const OFFLINE_TIMEOUT_MS = 30_000
/** 公开状态页的匿名连接上限: 防止被用来堆积长连接拖垮 DO. */
const MAX_PUBLIC_SOCKETS = 64
/** Alarm 检查间隔略小于阈值, 保证状态变化能及时被发现. */
const ALARM_INTERVAL_MS = 10_000
/** 服务端超时兜底相对 Agent 超时的宽限, 让 Agent 的最终结果先到. */
const COMMAND_TIMEOUT_GRACE_MS = 5_000
/** 终端输出活跃度落盘节流, 避免每个输出分片都写 storage. */
const TERMINAL_ACTIVITY_WRITE_MS = 30_000
/**
 * 终端二进制帧(与 Agent/前端保持一致):
 * - `0x01 + 输入字节`: Dashboard → Agent
 * - `0x02 + u64 大端 seq + 输出字节`: Agent → Dashboard
 */
const TERMINAL_INPUT_TYPE = 0x01
const TERMINAL_OUTPUT_TYPE = 0x02
const TERMINAL_OUTPUT_HEADER_LEN = 9
/** 帧大小上限: Agent 合并输出不超过 8 KiB, 输入同样限制 8 KiB. */
const MAX_TERMINAL_OUTPUT_FRAME = TERMINAL_OUTPUT_FRAME_MAX_BYTES
const MAX_TERMINAL_INPUT_FRAME = 8 * 1024 + 1

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
  /** 当前订阅的终端会话; 终端输出只发给已绑定的连接. */
  termSessionId?: string
}

/** 匿名只读订阅: 只收脱敏后的指标与在线状态, 不参与任何命令/终端事件. */
interface PublicAttachment {
  role: 'public'
}

type Attachment = AgentAttachment | DashboardAttachment | PublicAttachment

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
/** resize 的硬性范围, 与 shared/protocol.ts 共用同一份定义. */
const MIN_COLS = TERMINAL_COLS_MIN
const MAX_COLS = TERMINAL_COLS_MAX
const MIN_ROWS = TERMINAL_ROWS_MIN
const MAX_ROWS = TERMINAL_ROWS_MAX
/** 终端时长范围. */
const MIN_IDLE_TIMEOUT = TERMINAL_IDLE_TIMEOUT_MIN
const MAX_IDLE_TIMEOUT = TERMINAL_IDLE_TIMEOUT_MAX
const MIN_MAX_DURATION = TERMINAL_MAX_DURATION_MIN
const MAX_MAX_DURATION = TERMINAL_MAX_DURATION_MAX
/** 命令参数范围. */
const MIN_COMMAND_TIMEOUT = COMMAND_TIMEOUT_MIN
const MAX_COMMAND_TIMEOUT = COMMAND_TIMEOUT_MAX
const MIN_OUTPUT_BYTES = COMMAND_OUTPUT_MIN
const MAX_OUTPUT_BYTES = COMMAND_OUTPUT_MAX
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
  /** 最近一次下发给 Agent 的上报间隔; 仅在变化时重复广播. */
  private lastReportIntervalMs = 0
  /** 每台服务器至多一个终端会话: serverId → sessionId, 用于二进制输出路由. */
  private readonly serverTerminals = new Map<string, string>()
  /**
   * 执行槽互斥锁.
   *
   * DO 是单线程的, 但每个 `await` 都是让出点: "检查空闲 → 写入记录" 之间
   * 一旦交错, 两个请求会同时通过检查, 导致终端映射被覆盖、或两个命令并发下发.
   * 用 Promise 链把所有 "检查 + 占位" 串行化, 关闭该竞态窗口.
   */
  private executionLock: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    // 对象被回收或重新部署后, 内存状态不再可信:
    // 先按 D1 全量置为离线, 再依据仍然存在的 WebSocket 连接重建在线状态.
    // 应用层 ping/pong 自动应答: Agent 心跳与公开页 keepalive 不唤醒 DO.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))

    this.ctx.blockConcurrencyWhile(async () => {
      // 只做本地重建(内存 + DO storage, 毫秒级): D1 绝不能放在这里 ——
      // D1 慢查询或写锁排队会让 blockConcurrencyWhile 超过平台时限,
      // 整个 DO 被强制重置(线上 crash: "blockConcurrencyWhile waited too long").
      const now = Date.now()
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
      }

      // 终端会话运行态存于 storage, 二进制输出需要 serverId → sessionId 映射.
      const terminals = await this.ctx.storage.list<TerminalRecord>({ prefix: TERMINAL_PREFIX })
      for (const record of terminals.values()) {
        this.serverTerminals.set(record.serverId, record.sessionId)
      }
    })

    // D1 状态对账放后台(waitUntil): 先清掉「本次启动前」遗留的 online
    // (按 updated_at < 启动时刻判定, 不误伤启动后上报写入的 online),
    // 再把此刻仍在线的服务器写回 online. 幂等, DO 被重置后重建时自动重跑.
    const startedAt = Date.now()
    const repo = new ServersRepository(this.env.DB)
    this.ctx.waitUntil(
      (async () => {
        try {
          await repo.resetStaleStatuses(startedAt)
          for (const [serverId, state] of this.serverStates) {
            if (state.status === 'online') await repo.setStatus(serverId, 'online', Date.now())
          }
        } catch (error) {
          console.error(
            JSON.stringify({ level: 'error', event: 'monitor.state_rebuild_failed', error: String(error) }),
          )
        }
      })(),
    )
  }

  /* ------------------------------- HTTP 入口 ------------------------------- */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws/agent') return this.handleAgentSocket(request)
    if (url.pathname === '/ws/dashboard') return this.handleDashboardSocket(request)
    if (url.pathname === '/ws/public') return this.handlePublicSocket(request)
    if (url.pathname === '/api/metrics') return this.handleLatestMetrics(url)
    if (url.pathname === '/api/command' && request.method === 'POST') return this.handleCreateCommand(request)
    if (url.pathname.startsWith('/api/command/') && request.method === 'GET') return this.handleCommandStatus(url)
    if (url.pathname.startsWith('/api/command/') && url.pathname.endsWith('/cancel')) {
      return this.handleCancelCommand(request, url)
    }
    if (url.pathname === '/api/terminal' && request.method === 'POST') return this.handleCreateTerminal(request)
    if (url.pathname.startsWith('/api/terminal/server/') && request.method === 'GET') {
      return this.handleTerminalByServer(url)
    }
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

    // 头名大小写不敏感, 值也不应假设固定大小写.
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
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
    // 让新接入的 Agent 立刻拿到与公开订阅状态匹配的上报档位.
    void this.syncAgentReportInterval()

    return new Response(null, { status: 101, webSocket: client })
  }

  private handleDashboardSocket(request: Request): Response {
    const admin = request.headers.get('x-monix-admin')
    if (!admin) return new Response('Unauthorized', { status: 401 })

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ role: 'dashboard', admin } satisfies DashboardAttachment)

    // 该连接只承载命令/终端事件, 不推送指标(后台不需要实时数据).
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * 公开状态页订阅.
   *
   * 匿名只读: 连接数受限, 只下发脱敏快照与状态变化, 不接受任何控制消息.
   * 鉴权由 Worker 侧的公开路由决定(无需会话), DO 只按路径分发.
   */
  private handlePublicSocket(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket', { status: 426 })
    }

    let publicCount = 0
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.role === 'public') publicCount += 1
    }
    if (publicCount >= MAX_PUBLIC_SOCKETS) {
      return new Response('Too many public connections', { status: 429 })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ role: 'public' } satisfies PublicAttachment)

    server.send(JSON.stringify({ type: 'snapshot', servers: this.buildPublicSnapshot() }))

    // 订阅数变化会改变 Agent 的上报档位(有人在看 → 快, 无人 → 慢).
    void this.syncAgentReportInterval()

    return new Response(null, { status: 101, webSocket: client })
  }

  /** 公开快照: serverStates 的脱敏版本, 不含名称/分组. */
  private buildPublicSnapshot(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const [serverId, state] of this.serverStates) {
      out.push({
        serverId,
        status: state.status,
        sampleTs: state.sampleTs,
        receivedTs: state.receivedTs,
        metrics: state.status === 'online' ? toPublicMetrics(state.metrics) : null,
      })
    }
    return out
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment) {
      ws.close(4001, 'missing identity')
      return
    }

    // 终端数据走二进制帧, 控制消息走 JSON.
    if (typeof message !== 'string') {
      await this.handleBinaryFrame(ws, attachment, message)
      return
    }

    // 心跳走 auto-response; DO 清醒时可能仍会送达, 这里幂等回一份.
    if (message === 'ping') {
      ws.send('pong')
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

    if (attachment.role === 'agent') {
      await this.handleAgentMessage(ws, attachment.serverId, type, msg)
      return
    }

    // 公开订阅只允许心跳, 其余控制消息一律忽略.
    if (attachment.role === 'public') {
      if (type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      return
    }

    // Dashboard 侧控制消息: ping 与终端续传/尺寸/关闭.
    switch (type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
        return
      case 'terminal.resume':
        await this.onTerminalResume(ws, attachment, msg)
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

  /**
   * 终端二进制帧路由.
   *
   * Agent 输出帧按 `serverTerminals` 映射转发给已订阅该会话的 Dashboard;
   * Dashboard 输入帧按 attachment 上的 `termSessionId` 转发给对应 Agent.
   * 载荷原样透传, DO 不解析终端数据.
   */
  private async handleBinaryFrame(
    ws: WebSocket,
    attachment: Attachment,
    frame: ArrayBuffer,
  ): Promise<void> {
    const bytes = new Uint8Array(frame)
    if (bytes.length < 1) return

    if (attachment.role === 'agent') {
      // 输出帧: [0x02][u64 BE seq][数据]
      if (bytes[0] !== TERMINAL_OUTPUT_TYPE) return
      if (bytes.length <= TERMINAL_OUTPUT_HEADER_LEN) return
      if (bytes.length > MAX_TERMINAL_OUTPUT_FRAME) return

      const sessionId = this.serverTerminals.get(attachment.serverId)
      if (!sessionId) return
      this.sendBinaryToTerminal(sessionId, frame)
      return
    }

    // 公开订阅不参与终端数据.
    if (attachment.role !== 'dashboard') return

    // 输入帧: [0x01][数据]
    if (bytes[0] !== TERMINAL_INPUT_TYPE) return
    if (bytes.length < 2 || bytes.length > MAX_TERMINAL_INPUT_FRAME) return

    const sessionId = attachment.termSessionId
    if (!sessionId) return

    const key = TERMINAL_PREFIX + sessionId
    const record = await this.ctx.storage.get<TerminalRecord>(key)
    if (!record || record.admin !== attachment.admin || record.status !== 'open') return

    const now = Date.now()
    if (now - record.lastActivityAt >= TERMINAL_ACTIVITY_WRITE_MS) {
      record.lastActivityAt = now
      await this.ctx.storage.put(key, record)
    }

    this.sendToAgentBinary(record.serverId, frame)
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment) return

    // Dashboard 断开不再终止终端会话: 会话保留到空闲/最长时长,
    // 刷新或重连后由 terminal.resume 按序列号续传.
    if (attachment.role === 'dashboard') return

    // 公开订阅断开: 订阅数变化可能触发 Agent 降频.
    if (attachment.role === 'public') {
      void this.syncAgentReportInterval()
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
      case 'terminal.resumed': {
        await this.onTerminalResumed(serverId, msg)
        return
      }
      case 'terminal.gap': {
        await this.onTerminalGap(serverId, msg)
        return
      }
      case 'terminal.error': {
        await this.onTerminalError(serverId, msg)
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
      this.broadcastPublic({ type: 'server.status', serverId, status: 'online', ts: now })
    }

    // 公开出口必须脱敏: 原始 metrics 含主机名/系统版本, 不能透传.
    this.broadcastPublic({
      type: 'metrics',
      serverId,
      sampleTs,
      receivedTs: now,
      metrics: toPublicMetrics(metrics),
    })
    await this.ensureAlarm()
  }

  private async onCommandStatus(serverId: string, msg: Record<string, unknown>, status: CommandStatus): Promise<void> {
    const commandId = typeof msg.command_id === 'string' ? msg.command_id : ''
    const record = await this.findCommandRecord(serverId, commandId)
    if (!record) return

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
    const record = await this.findCommandRecord(serverId, commandId)
    if (!record) {
      // 服务端已失去该命令上下文: 要求 Agent 终止, 不能静默忽略.
      this.sendToAgent(serverId, { type: 'command.cancel', command_id: commandId })
      return
    }
    const key = COMMAND_PREFIX + commandId

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
    const body = await readJsonObjectSafe(request)
    const serverId = readId(body.serverId)
    const command = typeof body.command === 'string' ? body.command : ''
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

    // 终端与一次性命令共用执行槽: 检查与占位必须在同一临界区内完成.
    const commandId = crypto.randomUUID()
    const now = Date.now()
    const timeoutSeconds = clampInt(readNumber(body.timeoutSeconds) ?? 60, MIN_COMMAND_TIMEOUT, MAX_COMMAND_TIMEOUT)
    const maxOutputBytes = clampInt(readNumber(body.maxOutputBytes) ?? 1_048_576, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
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
    const acquired = await this.withExecutionLock(async () => {
      if (await this.hasActiveExecution(serverId)) return false
      await this.ctx.storage.put(COMMAND_PREFIX + commandId, record)
      return true
    })
    if (!acquired) {
      return Response.json(
        { ok: false, code: 'EXECUTION_BUSY', error: '该服务器已有执行中的任务' },
        { status: 409 },
      )
    }

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
    const body = await readJsonObjectSafe(request)
    const admin = readId(body.admin ?? url.searchParams.get('admin'))

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
    const body = await readJsonObjectSafe(request)
    const serverId = readId(body.serverId)
    const admin = typeof body.admin === 'string' ? body.admin.trim() : ''
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

    // 终端与一次性命令共用执行槽: 检查、占位与映射建立必须在同一临界区内完成.
    const sessionId = crypto.randomUUID()
    const now = Date.now()
    const idleTimeoutSeconds = clampInt(readNumber(body.idleTimeoutSeconds) ?? 600, MIN_IDLE_TIMEOUT, MAX_IDLE_TIMEOUT)
    const maxDurationSeconds = clampInt(readNumber(body.maxDurationSeconds) ?? 3_600, MIN_MAX_DURATION, MAX_MAX_DURATION)
    const record: TerminalRecord = {
      sessionId,
      serverId,
      admin,
      status: 'opening',
      cols: clampInt(readNumber(body.cols) ?? 80, MIN_COLS, MAX_COLS),
      rows: clampInt(readNumber(body.rows) ?? 24, MIN_ROWS, MAX_ROWS),
      idleTimeoutSeconds,
      maxDurationSeconds,
      createdAt: now,
      lastActivityAt: now,
    }

    // 先持久化再发送: 对象在发送后立刻休眠也不会丢失关联.
    // 二进制输出按 serverId 路由到该会话, 映射与记录在同一临界区内建立,
    // 避免并发创建时后来的会话覆盖前一个会话的输出路由.
    const acquired = await this.withExecutionLock(async () => {
      if (await this.hasActiveExecution(serverId)) return false
      await this.ctx.storage.put(TERMINAL_PREFIX + sessionId, record)
      this.serverTerminals.set(serverId, sessionId)
      return true
    })
    if (!acquired) {
      return Response.json(
        { ok: false, code: 'EXECUTION_BUSY', error: '该服务器已有执行中的任务' },
        { status: 409 },
      )
    }

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
      if (this.serverTerminals.get(serverId) === sessionId) this.serverTerminals.delete(serverId)
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

  /** 按服务器查询该管理员的活动会话, 供页面刷新后重新挂载终端. */
  private async handleTerminalByServer(url: URL): Promise<Response> {
    const serverId = url.pathname.slice('/api/terminal/server/'.length)
    const admin = url.searchParams.get('admin') ?? ''
    const entries = await this.ctx.storage.list<TerminalRecord>({ prefix: TERMINAL_PREFIX })
    for (const record of entries.values()) {
      if (record.serverId !== serverId || record.admin !== admin) continue
      return Response.json({
        ok: true,
        data: {
          sessionId: record.sessionId,
          serverId: record.serverId,
          status: record.status,
          cols: record.cols,
          rows: record.rows,
        },
      })
    }
    return Response.json({ ok: true, data: null })
  }

  private async handleCloseTerminal(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.slice('/api/terminal/'.length)
    const sessionId = path.replace(/\/close$/, '')
    const body = await readJsonObjectSafe(request)
    const admin = readId(body.admin ?? url.searchParams.get('admin'))

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
    const record = await this.findTerminalRecord(serverId, sessionId)
    if (!record) {
      this.sendToAgent(serverId, { type: 'terminal.close', session_id: sessionId })
      return
    }

    record.status = 'open'
    record.lastActivityAt = Date.now()
    await this.ctx.storage.put(key, record)

    // 已订阅的连接优先; 尚未订阅时回退给发起人, 避免 opened 在 attach 前到达而丢失.
    this.sendToTerminal(
      sessionId,
      {
        type: 'terminal.opened',
        sessionId,
        serverId,
        cols: record.cols,
        rows: record.rows,
      },
      record.admin,
    )
  }

  /** 续传完成: 携带缓冲中的最新 seq, 前端据此结束"重连中"状态. */
  private async onTerminalResumed(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    if (!sessionId) return
    const record = await this.findTerminalRecord(serverId, sessionId)
    if (!record) return

    this.sendToTerminal(
      sessionId,
      {
        type: 'terminal.resumed',
        sessionId,
        serverId,
        seq: typeof msg.seq === 'number' ? msg.seq : 0,
      },
      record.admin,
    )
  }

  /** 续传位置已被 Agent 缓冲淘汰: 前端清屏后从 0 重新拉取. */
  private async onTerminalGap(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    if (!sessionId) return
    const record = await this.findTerminalRecord(serverId, sessionId)
    if (!record) return

    this.sendToTerminal(sessionId, { type: 'terminal.gap', sessionId, serverId }, record.admin)
  }

  /** 终端告警(如输入过载), 只提示, 不改变会话状态. */
  private async onTerminalError(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    if (!sessionId) return
    const record = await this.findTerminalRecord(serverId, sessionId)
    if (!record) return

    this.sendToTerminal(
      sessionId,
      {
        type: 'terminal.error',
        sessionId,
        serverId,
        code: typeof msg.code === 'string' ? msg.code : 'ERROR',
        message: typeof msg.message === 'string' ? msg.message : '',
      },
      record.admin,
    )
  }

  private async onTerminalClosed(serverId: string, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    if (!sessionId) return

    const key = TERMINAL_PREFIX + sessionId
    const record = await this.findTerminalRecord(serverId, sessionId)
    if (!record) return

    if (this.serverTerminals.get(record.serverId) === sessionId) {
      this.serverTerminals.delete(record.serverId)
    }
    await this.ctx.storage.delete(key)

    this.sendToTerminal(
      sessionId,
      {
        type: 'terminal.closed',
        sessionId,
        serverId,
        reason: typeof msg.reason === 'string' ? msg.reason : 'error',
      },
      record.admin,
    )
  }

  /**
   * Dashboard 订阅/续传请求(兼作 attach).
   *
   * 绑定连接 → 接管同会话的其它标签页 → 状态为 open 时把 resume 转给 Agent 重放输出.
   * 服务端不保存输出, 重放完全由 Agent 的有界缓冲完成.
   */
  private async onTerminalResume(
    ws: WebSocket,
    attachment: DashboardAttachment,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
    if (!sessionId) return
    const lastSeq =
      typeof msg.last_seq === 'number' && Number.isFinite(msg.last_seq)
        ? Math.max(0, Math.trunc(msg.last_seq))
        : 0

    const record = await this.ctx.storage.get<TerminalRecord>(TERMINAL_PREFIX + sessionId)
    if (!record || record.admin !== attachment.admin) return

    // 同一会话只保留一个活跃订阅: 被接管的连接收到 detached 后停止输出.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue
      const otherAttachment = other.deserializeAttachment() as Attachment | null
      if (
        otherAttachment?.role !== 'dashboard' ||
        otherAttachment.admin !== attachment.admin ||
        otherAttachment.termSessionId !== sessionId
      ) {
        continue
      }
      other.serializeAttachment({
        role: 'dashboard',
        admin: otherAttachment.admin,
      } satisfies DashboardAttachment)
      try {
        other.send(JSON.stringify({ type: 'terminal.detached', sessionId }))
      } catch {
        // 失效连接由 webSocketClose 清理.
      }
    }

    ws.serializeAttachment({
      role: 'dashboard',
      admin: attachment.admin,
      termSessionId: sessionId,
    } satisfies DashboardAttachment)

    // opening 阶段只绑定连接; 客户端收到 terminal.opened 后会再次 resume.
    if (record.status !== 'open') return

    this.sendToAgent(record.serverId, {
      type: 'terminal.resume',
      session_id: sessionId,
      last_seq: lastSeq,
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
    if (this.serverTerminals.get(record.serverId) === record.sessionId) {
      this.serverTerminals.delete(record.serverId)
    }
    await this.ctx.storage.delete(TERMINAL_PREFIX + record.sessionId)

    this.sendToTerminal(
      record.sessionId,
      {
        type: 'terminal.closed',
        sessionId: record.sessionId,
        serverId: record.serverId,
        reason,
      },
      record.admin,
    )
    audit('audit.terminal_closed', {
      admin: record.admin,
      serverId: record.serverId,
      sessionId: record.sessionId,
      reason,
      durationMs: Date.now() - record.createdAt,
    })
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

  /**
   * 执行槽检查: 一次性命令或终端任一活动即视为占用.
   *
   * 调用方必须持有 `withExecutionLock` 提供的互斥, 否则检查结果随时可能失效.
   */
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

  /**
   * 在互斥锁内执行"检查执行槽 + 占位".
   *
   * 返回 `null` 表示槽位已被占用. 锁只覆盖检查与写入, 网络发送在锁外完成,
   * 避免一次慢发送阻塞其它服务器的会话创建.
   */
  private withExecutionLock<T>(action: () => Promise<T>): Promise<T> {
    const run = this.executionLock.then(action, action)
    // 无论成功失败都释放锁, 避免一次异常让后续请求永久排队.
    this.executionLock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
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
    // 无 serverId 的全量查询已随总览页删除; 公开页走 /public/servers.
    return Response.json({ ok: true, data: { servers: [] } })
  }


  /* --------------------------- 禁用服务器 --------------------------- */

  private async handleDisableServer(request: Request): Promise<Response> {
    const body = await readJsonObjectSafe(request)
    const serverId = readId(body.serverId)
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

  /** 按 Agent 消息里的 session_id 取本服务器的终端记录; 服务器不匹配时返回 null. */
  private async findTerminalRecord(
    serverId: string,
    sessionId: string,
  ): Promise<TerminalRecord | null> {
    if (!sessionId) return null
    const record = await this.ctx.storage.get<TerminalRecord>(TERMINAL_PREFIX + sessionId)
    return record && record.serverId === serverId ? record : null
  }

  /** 按 Agent 消息里的 command_id 取本服务器的命令记录. */
  private async findCommandRecord(
    serverId: string | undefined,
    commandId: string,
  ): Promise<CommandRecord | null> {
    if (!commandId) return null
    const record = await this.ctx.storage.get<CommandRecord>(COMMAND_PREFIX + commandId)
    if (!record) return null
    return !serverId || record.serverId === serverId ? record : null
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
      this.broadcastPublic({ type: 'server.status', serverId, status: 'online', ts: now })
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
    this.broadcastPublic({ type: 'server.status', serverId, status: 'offline', ts: Date.now() })
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
    let hasPendingCommand = false
    for (const [key, record] of commands) {
      if (record.status !== 'queued' && record.status !== 'running') continue
      if (now - record.updatedAt <= record.timeoutSeconds * 1000 + COMMAND_TIMEOUT_GRACE_MS) {
        hasPendingCommand = true
        continue
      }
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
    let hasPendingTerminal = false
    for (const record of terminals.values()) {
      // 终端握手超时: 旧版 Agent 会静默忽略 terminal.open, 必须给出明确结束.
      if (record.status === 'opening') {
        if (now - record.createdAt > TERMINAL_OPEN_TIMEOUT_MS) {
          this.sendToTerminal(
            record.sessionId,
            {
              type: 'terminal.closed',
              sessionId: record.sessionId,
              serverId: record.serverId,
              reason: 'open_timeout',
            },
            record.admin,
          )
          this.sendToAgent(record.serverId, { type: 'terminal.close', session_id: record.sessionId })
          if (this.serverTerminals.get(record.serverId) === record.sessionId) {
            this.serverTerminals.delete(record.serverId)
          }
          await this.ctx.storage.delete(TERMINAL_PREFIX + record.sessionId)
        } else {
          hasPendingTerminal = true
        }
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
        continue
      }
      hasPendingTerminal = true
    }

    // 只要还有在线服务器、未结束的命令或未结束的终端, 就必须继续巡检.
    // 只按 hasOnline 判断会让半开连接下的命令/终端永远停在 running:
    // 服务器被判离线后 alarm 停止, 之后没有任何机制再清理它们.
    if (hasOnline || hasPendingCommand || hasPendingTerminal) {
      await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS)
    }
  }

  /* --------------------------- 工具 --------------------------- */

  /**
   * 按谓词把消息发给匹配的连接(JSON 或二进制), 返回送达数.
   *
   * 所有定向/广播发送(sendToAgent/sendToAdmin/broadcastPublic/...)都收敛到这里,
   * 避免每个语义函数各自维护一遍 "遍历 attachment → 过滤 → send" 的样板.
   */
  private sendWhere(
    matches: (attachment: Attachment) => boolean,
    body: string | ArrayBuffer,
  ): number {
    let count = 0
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (!attachment || !matches(attachment)) continue
      try {
        ws.send(body)
        count += 1
      } catch {
        // 失效连接由 webSocketClose 清理.
      }
    }
    return count
  }

  private sendToAgent(serverId: string, payload: unknown): boolean {
    return (
      this.sendWhere(
        (a) => a.role === 'agent' && a.serverId === serverId,
        JSON.stringify(payload),
      ) > 0
    )
  }

  /** 转发终端输入二进制帧给指定服务器的 Agent. */
  private sendToAgentBinary(serverId: string, frame: ArrayBuffer): boolean {
    return (
      this.sendWhere((a) => a.role === 'agent' && a.serverId === serverId, frame) > 0
    )
  }

  /**
   * 只发给已订阅该终端会话的 Dashboard 连接.
   *
   * `fallbackAdmin` 用于还没有任何订阅者时把事件回退给发起人(opened/closed 等),
   * 避免在 attach 之前到达的控制消息被丢弃.
   */
  private sendToTerminal(sessionId: string, payload: unknown, fallbackAdmin?: string): number {
    const count = this.sendWhere(
      (a) => a.role === 'dashboard' && a.termSessionId === sessionId,
      JSON.stringify(payload),
    )
    if (count === 0 && fallbackAdmin) this.sendToAdmin(fallbackAdmin, payload)
    return count
  }

  /** 转发终端输出二进制帧给已订阅该会话的 Dashboard 连接. */
  private sendBinaryToTerminal(sessionId: string, frame: ArrayBuffer): void {
    this.sendWhere((a) => a.role === 'dashboard' && a.termSessionId === sessionId, frame)
  }

  /**
   * 订阅者感知空载: 按 public 订阅数同步 Agent 的指标上报间隔.
   *
   * 有人在公开页看 → collect_interval(默认 5s); 无人看 → 至少 30s.
   * 仅在档位变化时广播, 避免连接抖动导致重复下发.
   */
  private async syncAgentReportInterval(): Promise<void> {
    let publicCount = 0
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.role === 'public') publicCount += 1
    }

    let intervalMs: number
    try {
      const config = await loadAgentConfig(new SettingsRepository(this.env.DB))
      intervalMs = config.collectIntervalMs
    } catch {
      intervalMs = 5_000
    }
    if (publicCount === 0) intervalMs = Math.max(intervalMs, 30_000)

    if (intervalMs === this.lastReportIntervalMs) return
    this.lastReportIntervalMs = intervalMs

    const data = JSON.stringify({ type: 'report_interval', interval_ms: intervalMs })
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.role !== 'agent') continue
      try {
        ws.send(data)
      } catch {
        // 失效连接由 webSocketClose 清理.
      }
    }
  }

  /** 只发给公开订阅连接. 调用方必须传入已脱敏的数据. */
  private broadcastPublic(payload: unknown): void {
    this.sendWhere((a) => a.role === 'public', JSON.stringify(payload))
  }

  /** 只发给指定管理员的 Dashboard 连接, 用于命令等私有数据. */
  private sendToAdmin(admin: string, payload: unknown): number {
    return this.sendWhere(
      (a) => a.role === 'dashboard' && a.admin === admin,
      JSON.stringify(payload),
    )
  }
}

/** 将数值钳制到整数区间; 非有限值回退到下限. */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/**
 * 读取 JSON 对象请求体.
 *
 * DO 的 HTTP 入口只对 Worker 开放, 但仍按不可信输入处理:
 * 解析失败或类型不符时返回空对象, 由调用方按"缺少参数"拒绝,
 * 避免把 `as` 断言的结果直接用于业务逻辑.
 *
 * 与 shared/validation.ts 的 readJson(抛 400)语义不同: DO 内部入口
 * 没有统一的错误处理链, 解析失败走"空对象 + 参数校验拒绝"路径.
 */
async function readJsonObjectSafe(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 读取标识符字段: 只接受非空字符串, 并限制长度避免异常输入进入 storage key. */
function readId(value: unknown, maxLength = 128): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return ''
  return trimmed
}

/** 读取可选的数值参数; 缺失或类型不符时返回 undefined, 由 `clampInt` 的默认值兜底. */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Agent 上报的状态必须落在协议枚举内, 否则按失败处理. */
function normalizeCommandStatus(value: unknown): CommandStatus {
  if (typeof value === 'string' && (COMMAND_STATUSES as readonly string[]).includes(value)) {
    return value as CommandStatus
  }
  return 'failed'
}
