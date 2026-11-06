import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { unauthorized, forbidden } from '../../shared/errors'
import { sha256Hex, timingSafeEqualString } from '../../shared/crypto'
import { isIpv6, normalizeCountryCode, normalizeIp } from '../../shared/validation'
import { ServersRepository } from '../../infrastructure/db/servers'
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
 * 校验通过后由 Worker 把可靠的 server_id 写入内部请求头, MonitorDO 只信任该值.
 */
async function authenticateAgent(env: Env, header: string | undefined) {
  const token = readBearer(header)
  if (!token) throw unauthorized('缺少 Agent 令牌', 'AGENT_TOKEN_MISSING')

  const repo = new ServersRepository(env.DB)

  // 新记录存明文 Token, 按明文精确查询.
  let row = await repo.findByToken(token)

  // 历史记录可能存 SHA-256 摘要: 明文查询落空时按摘要再查一次.
  if (!row) {
    row = await repo.findByToken(await sha256Hex(token))
  }
  if (!row) throw unauthorized('Agent 令牌无效', 'AGENT_TOKEN_INVALID')

  // 再做一次常量时间比对, 不依赖数据库的比较规则.
  const matchesPlain = timingSafeEqualString(token, row.token_hash)
  const matchesDigest = timingSafeEqualString(await sha256Hex(token), row.token_hash)
  if (!matchesPlain && !matchesDigest) {
    throw unauthorized('Agent 令牌无效', 'AGENT_TOKEN_INVALID')
  }
  if (row.enabled !== 1) throw forbidden('服务器已被禁用', 'SERVER_DISABLED')

  return row
}

/** Agent 运行配置. */
agent.get('/config', async (c) => {
  const ctx = c as unknown as AppContext
  const row = await authenticateAgent(c.env, c.req.header('authorization'))
  const runtime = await loadAgentConfig(new SettingsRepository(c.env.DB))

  return ok(ctx, {
    serverId: row.id,
    collectIntervalMs: runtime.collectIntervalMs,
    autoUpdate: runtime.autoUpdate,
    timeoutSeconds: runtime.timeoutSeconds,
    maxOutputBytes: runtime.maxOutputBytes,
  })
})

/** 更新检查. 第一版只返回是否有可用版本, 安装由 Agent 自行完成并校验签名. */
agent.get('/update/check', async (c) => {
  const ctx = c as unknown as AppContext
  await authenticateAgent(c.env, c.req.header('authorization'))

  const runtime = await loadAgentConfig(new SettingsRepository(c.env.DB))
  const current = c.req.header('x-monix-agent-version') ?? '0.0.0'

  // 更新通道固定使用 latest; 未配置发布来源时不声称存在更新.
  return ok(ctx, {
    channel: 'latest',
    autoUpdate: runtime.autoUpdate,
    currentVersion: current,
    updateAvailable: false,
    manifest: null,
  })
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

  // Worker 观察到的公网 IP 与国家代码, 24 小时内不重复刷新.
  const now = Date.now()
  const needsIpRefresh = row.ip_updated_at === null || now - row.ip_updated_at > 24 * 60 * 60 * 1000
  if (needsIpRefresh) {
    const ip = normalizeIp(c.req.header('cf-connecting-ip'))
    const country = normalizeCountryCode((c.req.raw as unknown as { cf?: { country?: string } }).cf?.country)
    const repo = new ServersRepository(c.env.DB)
    if (ip) {
      const patch = isIpv6(ip) ? { ipv6: ip } : { ipv4: ip }
      await repo.update(row.id, { ...patch, countryCode: country, ipUpdatedAt: now }, now)
    } else {
      await repo.update(row.id, { countryCode: country, ipUpdatedAt: now }, now)
    }
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

export { agent }
