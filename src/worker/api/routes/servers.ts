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
import { callMonitor, monitorStub } from '../monitor'
import { invalidatePublicCache } from './public'

const servers = new Hono<{ Bindings: Env; Variables: Vars }>()

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

  invalidatePublicCache()
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

  if (groupId !== undefined && groupId !== null) {
    const group = await new GroupsRepository(c.env.DB).findById(groupId)
    if (!group) throw notFound('分组不存在', 'GROUP_NOT_FOUND')
  }

  await repo.update(id, { name, groupId, enabled }, Date.now())

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

  invalidatePublicCache()
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

  invalidatePublicCache()
  await repo.delete(id)
  return ok(ctx, { ok: true })
})

/**
 * 管理员获取该服务器的 Agent 安装命令.
 *
 * 命令里直接携带长期 Agent Token: 数据库同样以明文保存, 因此这里不再需要
 * 一次性令牌兑换. 复制即等价于复制凭据, 只应粘贴到目标机器执行.
 */
servers.get('/:id/install-command', async (c) => {
  const ctx = c as unknown as AppContext
  const id = c.req.param('id')
  const repo = new ServersRepository(c.env.DB)
  const row = await repo.findById(id)
  if (!row) throw notFound('服务器不存在', 'SERVER_NOT_FOUND')

  // 脚本由本部署的静态资源层提供(public/install-agent.sh → /install-agent.sh),
  // 跟随当前访问域名, 不依赖 raw.githubusercontent.com 与 Release tag.
  const origin = new URL(c.req.url).origin
  const scriptUrl = `${origin}/install-agent.sh`

  // 只有系统设置里显式配置了地址才写进命令.
  // 未配置时一律省略: 脚本与 Agent 都内置默认地址, 用当前访问域名兜底会把
  // 反向代理/内网调试域名写进目标机器配置, 反而是错的.
  const configured = ((await new SettingsRepository(c.env.DB).get('system', 'server_url')) ?? '').trim().replace(/\/+$/, '')
  const flag = configured.length > 0 ? ` --server-url ${configured}` : ''

  // 单行管道执行: 不落地临时文件, 复制后可直接粘贴.
  // 是否需要 sudo/root 由脚本内部判断, 命令本身保持最简.
  const command = `curl -fsSL ${scriptUrl} | bash -s --${flag} --token ${row.token}`

  return ok(ctx, { id: row.id, command, token: row.token })
})

/** 轮换 Agent Token: 立即作废旧凭据并断开该服务器的现有连接. */
servers.post('/:id/token/rotate', async (c) => {
  const ctx = c as unknown as AppContext
  const id = c.req.param('id')
  const repo = new ServersRepository(c.env.DB)
  const row = await repo.findById(id)
  if (!row) throw notFound('服务器不存在', 'SERVER_NOT_FOUND')

  const token = newAgentToken(32)
  await repo.update(id, { token }, Date.now())

  // 旧 Token 已失效, 但已建立的 WebSocket 不会自动断开, 这里主动踢掉.
  try {
    await monitorStub(c.env).fetch('https://monitor/api/server/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: id }),
    })
  } catch {
    // MonitorDO 不可达时以 D1 中的新凭据为准, 重连会使用新 Token.
  }

  return ok(ctx, { id, token })
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

  const data = await callMonitor<{ commandId: string; status: string; timeoutSeconds: number }>(
    c.env,
    '/api/command',
    {
      body: {
        serverId: id,
        command,
        admin: ctx.get('admin').username,
        timeoutSeconds: runtime.timeoutSeconds,
        maxOutputBytes: runtime.maxOutputBytes,
      },
    },
  )
  return ok(ctx, data, 202)
})

export { servers }
