import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { unauthorized, forbidden } from '../../shared/errors'
import { timingSafeEqualString } from '../../shared/crypto'
import { isIpv6, normalizeCountryCode, normalizeIp } from '../../shared/validation'
import { ServersRepository } from '../../infrastructure/db/servers'
import type { ServerRow } from '../../infrastructure/db/servers'
import { loadAgentConfig, SettingsRepository } from '../../infrastructure/db/settings'
import type { Env, Vars } from '../../shared/types'
import { monitorStub } from '../monitor'

const agent = new Hono<{ Bindings: Env; Variables: Vars }>()

/** 从 Authorization: Bearer 读取 Agent 令牌. 禁止从 URL 读取长期凭据. */
function readBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

/**
 * 校验 Agent 令牌并返回服务器记录.
 *
 * 按 Token 精确查询命中唯一索引, 再对同一条记录做常量时间比较,
 * 不依赖数据库的比较规则.
 */
async function authenticateAgent(env: Env, header: string | undefined): Promise<ServerRow> {
  const token = readBearer(header)
  if (!token) throw unauthorized('缺少 Agent 令牌', 'AGENT_TOKEN_MISSING')

  const row = await new ServersRepository(env.DB).findByToken(token)
  if (!row || !timingSafeEqualString(token, row.token)) {
    throw unauthorized('Agent 令牌无效', 'AGENT_TOKEN_INVALID')
  }
  if (row.enabled !== 1) throw forbidden('服务器已被禁用', 'SERVER_DISABLED')

  return row
}

/**
 * 连接可观测到的国家代码, 24 小时内只刷新一次.
 *
 * 公网地址不再从连接推导(cf-connecting-ip 只有当前连接的单一地址族,
 * 双栈机器只能拿到其一), 改由 Agent 双栈探测后经 POST /ip 上报.
 */
async function refreshObservedCountry(env: Env, row: ServerRow, request: Request): Promise<void> {
  const now = Date.now()
  const stale = row.ip_updated_at === null || now - row.ip_updated_at > 24 * 60 * 60 * 1000
  if (!stale) return

  const country = normalizeCountryCode((request as unknown as { cf?: { country?: string } }).cf?.country)
  await new ServersRepository(env.DB).update(row.id, { countryCode: country, ipUpdatedAt: now }, now)
}

/** 平台标识 `{os}-{arch}`(如 linux-x86_64): 只收小写字母数字与单个连字符. */
function normalizePlatform(value: string | undefined | null): string | null {
  if (!value) return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > 50) return null
  return /^[a-z0-9_]+-[a-z0-9_]+$/.test(trimmed) ? trimmed : null
}

/** Agent 版本号: 字母数字与 . + - _, 最长 32 字符(如 0.1.0). */
function normalizeAgentVersion(value: string | undefined | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 32) return null
  return /^[0-9A-Za-z.+-]+$/.test(trimmed) ? trimmed : null
}

/** 上报内容 → 列值: 通过格式校验且地址族匹配才落库, 否则清空该列. */
function toFamilyColumn(value: unknown, expectIpv6: boolean): string | null {
  if (typeof value !== 'string') return null
  const ip = normalizeIp(value)
  if (!ip || isIpv6(ip) !== expectIpv6) return null
  return ip
}

/** Agent 运行配置. Agent 在每次建立连接(含重连)时拉取一次, 连接期间不刷新. */
agent.get('/config', async (c) => {
  const ctx = c as unknown as AppContext
  const row = await authenticateAgent(c.env, c.req.header('authorization'))
  const runtime = await loadAgentConfig(new SettingsRepository(c.env.DB))

  return ok(ctx, {
    serverId: row.id,
    collectIntervalMs: runtime.collectIntervalMs,
    timeoutSeconds: runtime.timeoutSeconds,
    maxOutputBytes: runtime.maxOutputBytes,
  })
})

/**
 * GET /ip —— 双栈探测回显: 返回当前连接的公网地址.
 * Agent 分别用仅 IPv4 / 仅 IPv6 的本地 socket 各请求一次, 即可同时拿到两族地址.
 */
agent.get('/ip', async (c) => {
  const ctx = c as unknown as AppContext
  await authenticateAgent(c.env, c.req.header('authorization'))
  return ok(ctx, { ip: normalizeIp(c.req.header('cf-connecting-ip')) })
})

/**
 * POST /ip —— Agent 上报双栈探测结果.
 * 只在至少一个族探测成功时上报(全部失败视为断网, 保留服务端已有地址).
 */
agent.post('/ip', async (c) => {
  const ctx = c as unknown as AppContext
  const row = await authenticateAgent(c.env, c.req.header('authorization'))

  let body: { ipv4?: unknown; ipv6?: unknown }
  try {
    body = (await c.req.json()) as { ipv4?: unknown; ipv6?: unknown }
  } catch {
    body = {}
  }

  await new ServersRepository(c.env.DB).update(
    row.id,
    {
      ipv4: toFamilyColumn(body.ipv4, false),
      ipv6: toFamilyColumn(body.ipv6, true),
      ipUpdatedAt: Date.now(),
    },
    Date.now(),
  )
  return ok(ctx, { ok: true })
})

/**
 * Agent WebSocket 接入.
 * Worker 完成令牌校验, 再把已认证的 server_id 与连接信息交给 MonitorDO.
 */
agent.get('/connect', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected websocket upgrade', 426)
  }

  const row = await authenticateAgent(c.env, c.req.header('authorization'))
  await refreshObservedCountry(c.env, row, c.req.raw)

  // 平台标识与版本由 Agent 上报, 只在变化时写库(每次重连都会带).
  const platform = normalizePlatform(c.req.header('x-monix-platform'))
  const version = normalizeAgentVersion(c.req.header('x-monix-agent-version'))
  const runtimePatch: { platform?: string; version?: string } = {}
  if (platform && platform !== row.platform) runtimePatch.platform = platform
  if (version && version !== row.version) runtimePatch.version = version
  if (Object.keys(runtimePatch).length > 0) {
    await new ServersRepository(c.env.DB).update(row.id, runtimePatch, Date.now())
  }

  // 内部请求头只由 Worker 生成, 外部同名头不会被透传.
  const headers = new Headers(c.req.raw.headers)
  headers.set('x-monix-server-id', row.id)
  headers.delete('x-monix-admin')

  const url = new URL(c.req.url)
  const target = new URL('https://monitor/ws/agent')
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value))

  return monitorStub(c.env).fetch(target.toString(), {
    method: 'GET',
    headers,
  })
})

export { agent, authenticateAgent }
