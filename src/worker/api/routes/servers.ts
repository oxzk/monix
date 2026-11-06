import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { conflict, notFound } from '../../shared/errors'
import {
  optionalBoolean,
  optionalInt,
  optionalString,
  parsePagination,
  readJson,
  requireString,
} from '../../shared/validation'
import { newAgentToken, randomTokenHex } from '../../shared/crypto'
import { ServersRepository, toServerDto } from '../../infrastructure/db/servers'
import { GroupsRepository } from '../../infrastructure/db/groups'
import { loadAgentConfig, SettingsRepository } from '../../infrastructure/db/settings'
import type { ServerStatus } from '../../infrastructure/db/servers'
import type { Env, Vars } from '../../shared/types'
import { monitorStub } from '../monitor'

const servers = new Hono<{ Bindings: Env; Variables: Vars }>()

/** Agent 安装脚本来源; 与 scripts/install-agent.sh 的默认仓库保持一致. */
const REPO = 'oxzk/monix'

function newServerId(): string {
  // 便于识别与排序的稳定标识.
  return `srv_${randomTokenHex(8)}`
}

servers.get('/', async (c) => {
  const ctx = c as unknown as AppContext
  const url = new URL(c.req.url)
  const { limit, offset } = parsePagination(url)
  const repo = new ServersRepository(c.env.DB)

  const statusRaw = url.searchParams.get('status')
  const status: ServerStatus | null =
    statusRaw === 'online' || statusRaw === 'offline' ? statusRaw : null

  const groupRaw = url.searchParams.get('groupId')
  const parsedGroup = groupRaw === null ? null : Number.parseInt(groupRaw, 10)

  const { items, total } = await repo.list({
    limit,
    offset,
    status,
    groupId: Number.isFinite(parsedGroup as number) ? (parsedGroup as number) : null,
    keyword: url.searchParams.get('q'),
  })

  return ok(ctx, { items: items.map(toServerDto), total, limit, offset })
})

servers.post('/', async (c) => {
  const ctx = c as unknown as AppContext
  const body = await readJson(c)
  const name = requireString(body, 'name', { max: 100 })
  const groupId = optionalInt(body, 'groupId', 1, Number.MAX_SAFE_INTEGER)

  if (groupId !== undefined && groupId !== null) {
    const group = await new GroupsRepository(c.env.DB).findById(groupId)
    if (!group) throw notFound('分组不存在', 'GROUP_NOT_FOUND')
  }

  const token = newAgentToken(32)
  const id = newServerId()

  await new ServersRepository(c.env.DB).create({
    id,
    name,
    token,
    groupId: groupId ?? null,
    now: Date.now(),
  })

  return ok(ctx, { id, name, token }, 201)
})

servers.get('/:id', async (c) => {
  const ctx = c as unknown as AppContext
  const repo = new ServersRepository(c.env.DB)
  const row = await repo.findById(c.req.param('id'))
  if (!row) throw notFound('服务器不存在', 'SERVER_NOT_FOUND')
  return ok(ctx, toServerDto(row))
})

servers.patch('/:id', async (c) => {
  const ctx = c as unknown as AppContext
  const id = c.req.param('id')
  const repo = new ServersRepository(c.env.DB)
  const row = await repo.findById(id)
  if (!row) throw notFound('服务器不存在', 'SERVER_NOT_FOUND')

  const body = await readJson(c)
  const name = body.name === undefined ? undefined : requireString(body, 'name', { max: 100 })
  const groupId = optionalInt(body, 'groupId', 1, Number.MAX_SAFE_INTEGER)
  const enabled = optionalBoolean(body, 'enabled')
  const hostname = optionalString(body, 'hostname', 255)

  if (groupId !== undefined && groupId !== null) {
    const group = await new GroupsRepository(c.env.DB).findById(groupId)
    if (!group) throw notFound('分组不存在', 'GROUP_NOT_FOUND')
  }

  await repo.update(id, { name, groupId, enabled, hostname }, Date.now())

  // 禁用时立即断开该服务器的连接并清理活动命令.
  if (enabled === false) {
    try {
      await monitorStub(c.env).fetch('https://monitor/api/server/disable', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverId: id }),
      })
    } catch {
      // MonitorDO 不可达时以 D1 的 enabled=0 为准, 握手阶段同样会拒绝.
    }
  }

  const updated = await repo.findById(id)
  return ok(ctx, updated ? toServerDto(updated) : null)
})

servers.delete('/:id', async (c) => {
  const ctx = c as unknown as AppContext
  const id = c.req.param('id')
  const repo = new ServersRepository(c.env.DB)
  const row = await repo.findById(id)
  if (!row) throw notFound('服务器不存在', 'SERVER_NOT_FOUND')

  try {
    await monitorStub(c.env).fetch('https://monitor/api/server/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: id }),
    })
  } catch {
    // 忽略: 记录删除后即使旧连接存在, 也无法再通过身份校验.
  }

  await repo.delete(id)
  return ok(ctx, { ok: true })
})

/** 管理员获取该服务器的 Agent 安装命令(含 Token). */
servers.get('/:id/install-command', async (c) => {
  const ctx = c as unknown as AppContext
  const id = c.req.param('id')
  const repo = new ServersRepository(c.env.DB)
  const row = await repo.findById(id)
  if (!row) throw notFound('服务器不存在', 'SERVER_NOT_FOUND')

  // 不按格式拦截: 早期版本的明文 Token 也是 64 位十六进制, 无法与历史摘要区分.
  // 若该行确实是历史摘要, 生成的命令会认证失败, 由 Agent 侧明确报错.
  // 优先使用系统设置中的服务端地址; 未配置时回退到当前请求域名.
  const configured = await new SettingsRepository(c.env.DB).get('system', 'server_url')
  const origin = (configured && configured.trim().length > 0 ? configured.trim() : new URL(c.req.url).origin).replace(/\/+$/, '')
  const scriptUrl = `https://raw.githubusercontent.com/${REPO}/main/scripts/install-agent.sh`
  // 单行管道执行: 不落地临时文件, 复制后可直接粘贴.
  const command = `curl -fsSL ${scriptUrl} | sudo bash -s -- --server-url ${origin} --token ${row.token_hash}`

  return ok(ctx, { id: row.id, command })
})

/** 最新实时指标: 从 MonitorDO 内存读取, 不读 D1. */
servers.get('/:id/metrics/latest', async (c) => {
  const ctx = c as unknown as AppContext
  const id = c.req.param('id')

  const row = await new ServersRepository(c.env.DB).findById(id)
  if (!row) throw notFound('服务器不存在', 'SERVER_NOT_FOUND')

  const res = await monitorStub(c.env).fetch(`https://monitor/api/metrics?serverId=${encodeURIComponent(id)}`)
  const payload = (await res.json()) as { data?: unknown }
  return ok(ctx, payload.data ?? null)
})

/** 所有服务器的最新实时指标, 供总览一次取全. */
servers.get('/metrics/latest', async (c) => {
  const ctx = c as unknown as AppContext
  const res = await monitorStub(c.env).fetch('https://monitor/api/metrics')
  const payload = (await res.json()) as { data?: { servers?: unknown[] } }
  return ok(ctx, payload.data?.servers ?? [])
})

servers.post('/:id/commands', async (c) => {
  const ctx = c as unknown as AppContext
  const id = c.req.param('id')
  const repo = new ServersRepository(c.env.DB)
  const row = await repo.findById(id)
  if (!row) throw notFound('服务器不存在', 'SERVER_NOT_FOUND')
  if (row.enabled !== 1) throw conflict('服务器已被禁用', 'SERVER_DISABLED')

  const body = await readJson(c)
  const command = requireString(body, 'command', { max: 8192, trim: false })

  // 超时与输出上限由服务端配置决定, 客户端不能突破硬性限制.
  const runtime = await loadAgentConfig(new SettingsRepository(c.env.DB))

  const res = await monitorStub(c.env).fetch('https://monitor/api/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId: id,
      command,
      admin: ctx.get('admin').username,
      timeoutSeconds: runtime.timeoutSeconds,
      maxOutputBytes: runtime.maxOutputBytes,
    }),
  })

  const payload = (await res.json()) as { ok?: boolean; data?: unknown; error?: string; code?: string }
  if (!res.ok || payload.ok !== true) {
    throw conflict(payload.error ?? '命令未被执行', payload.code ?? 'COMMAND_REJECTED')
  }
  return ok(ctx, payload.data, 202)
})

export { servers }
