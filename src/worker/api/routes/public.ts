/**
 * 公开状态页接口, 无需登录.
 *
 * 前台路由 /api/v1: 服务器列表(/servers)、站点配置(/config)与实时通道(/stream).
 * 只暴露展示必需的最小字段: 名称、分组、在线状态与脱敏后的实时指标.
 * 明确不返回 IP、主机名、系统版本、网卡名、Token 与启用状态,
 * 也不返回任何命令/终端相关数据.
 */
import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { SettingsRepository } from '../../infrastructure/db/settings'
import { ServersRepository } from '../../infrastructure/db/servers'
import { GroupsRepository } from '../../infrastructure/db/groups'
import type { Env, Vars } from '../../shared/types'
import { maskIpForPublic, toPublicMetrics, numberOrNull } from '../../shared/public-metrics'
import { parseThemeOptions } from '../../shared/theme'
import { monitorStub } from '../monitor'

/** 公开服务器列表(GET /api/v1/servers): 与站点配置分开提供. */
export const publicServersRoutes = new Hono<{ Bindings: Env; Variables: Vars }>()

/** 公开站点配置(GET /api/v1/config). */
export const publicConfigRoutes = new Hono<{ Bindings: Env; Variables: Vars }>()

/** 公开实时通道(GET /api/v1/stream). */
export const publicStreamRoutes = new Hono<{ Bindings: Env; Variables: Vars }>()

/**
 * 同一 isolate 内的短缓存.
 *
 * 首屏与低频列表刷新都会重复读 D1 与 MonitorDO; 3 秒缓存把并发访客的
 * 重复读取收敛到采集周期以内. 实时指标走 WebSocket, 不经过这里.
 */
const SNAPSHOT_CACHE_MS = 3_000
let cachedServers: unknown = null
let cachedServersAt = 0
let cachedConfig: unknown = null
let cachedConfigAt = 0

/** 服务器/分组/主题配置变更后由对应路由调用, 立即失效状态页缓存. */
export function invalidatePublicCache(): void {
  cachedServers = null
  cachedServersAt = 0
  cachedConfig = null
  cachedConfigAt = 0
}

/** 从 MonitorDO 读取最新快照. 失败时返回空表, 状态页按离线展示. */
async function loadSnapshots(env: Env): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  try {
    const res = await monitorStub(env).fetch('https://monitor/api/metrics')
    const payload = (await res.json()) as { data?: { servers?: Array<Record<string, unknown>> } }
    for (const item of payload.data?.servers ?? []) {
      const serverId = typeof item.serverId === 'string' ? item.serverId : ''
      if (serverId) out.set(serverId, item)
    }
  } catch {
    // 监控对象不可达时按全离线返回, 不向状态页暴露内部错误.
  }
  return out
}

/**
 * GET /api/v1/public/servers —— 状态页数据源.
 *
 * 被禁用的服务器不展示; 没有快照的服务器按离线展示.
 */
publicServersRoutes.get('/', async (c) => {
  const ctx = c as unknown as AppContext
  c.header('Cache-Control', 'no-store')

  if (cachedServers !== null && Date.now() - cachedServersAt < SNAPSHOT_CACHE_MS) {
    return ok(ctx, cachedServers)
  }

  const repo = new ServersRepository(c.env.DB)
  const { items } = await repo.list({ limit: 100, offset: 0 })
  const groups = await new GroupsRepository(c.env.DB).list()
  const groupNames = new Map(groups.map((group) => [group.id, group.name]))
  const snapshots = await loadSnapshots(c.env)

  const servers = items
    .filter((row) => row.enabled === 1)
    .map((row) => {
      const snapshot = snapshots.get(row.id)
      const online = snapshot?.status === 'online'
      // IP 只出掩码: IPv4 保留前三段, IPv6 保留前两组; 优先 IPv4, 无则 IPv6.
      const rawIp = row.ipv4 ?? row.ipv6
      return {
        id: row.id,
        name: row.name,
        countryCode: row.country_code,
        ip: rawIp ? maskIpForPublic(rawIp) : null,
        groupName: row.group_id === null ? null : (groupNames.get(row.group_id) ?? null),
        status: online ? 'online' : 'offline',
        sampleTs: online ? numberOrNull(snapshot?.sampleTs) : null,
        receivedTs: online ? numberOrNull(snapshot?.receivedTs) : null,
        metrics: online ? toPublicMetrics(snapshot?.metrics) : null,
      }
    })

  const payload = { servers }
  cachedServers = payload
  cachedServersAt = Date.now()
  return ok(ctx, payload)
})

/**
 * GET /api/v1/public/config —— 状态页站点配置(站点名 + 主题).
 *
 * 与服务器数据分离: 配置变化频率低, 前端只在首屏拉取一次,
 * 不随 WS 重连/列表刷新重复请求.
 */
publicConfigRoutes.get('/', async (c) => {
  const ctx = c as unknown as AppContext
  c.header('Cache-Control', 'no-store')

  if (cachedConfig !== null && Date.now() - cachedConfigAt < SNAPSHOT_CACHE_MS) {
    return ok(ctx, cachedConfig)
  }

  const settings = new SettingsRepository(c.env.DB)
  const siteName = (await settings.get('system', 'site_name'))?.trim() || 'Monix'
  // 后台自定义主题(背景图/配色); 未配置时为空, 前端沿用内置 default.
  const theme = parseThemeOptions(await settings.get('system', 'theme_options'))

  const payload = { siteName, theme }
  cachedConfig = payload
  cachedConfigAt = Date.now()
  return ok(ctx, payload)
})

/**
 * GET /api/v1/public/stream —— 公开状态页的实时通道.
 *
 * 匿名只读: 只转发快照、指标与在线状态, 且指标已脱敏.
 * Worker 只做握手转发, 连接身份与并发上限由 MonitorDO 控制.
 */
publicStreamRoutes.get('/', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected websocket upgrade', 426)
  }

  // 外部同名头一律丢弃, 防止伪造管理端身份.
  const headers = new Headers(c.req.raw.headers)
  headers.delete('x-monix-admin')
  headers.delete('x-monix-server-id')

  return monitorStub(c.env).fetch('https://monitor/ws/public', { method: 'GET', headers })
})
