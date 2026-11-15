import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { conflict, notFound } from '../../shared/errors'
import { optionalInt, readJson } from '../../shared/validation'
import { parseIntOr, SettingsRepository } from '../../infrastructure/db/settings'
import { ServersRepository } from '../../infrastructure/db/servers'
import type { Env, Vars } from '../../shared/types'
import { callMonitor } from '../monitor'

const terminal = new Hono<{ Bindings: Env; Variables: Vars }>()

/** 打开交互式终端会话. 终端与一次性命令共用同一执行槽. */
terminal.post('/servers/:id', async (c) => {
  const ctx = c as unknown as AppContext
  const id = c.req.param('id')

  const row = await new ServersRepository(c.env.DB).findById(id)
  if (!row) throw notFound('服务器不存在', 'SERVER_NOT_FOUND')
  if (row.enabled !== 1) throw conflict('服务器已被禁用', 'SERVER_DISABLED')

  const body = await readJson(c)
  const cols = optionalInt(body, 'cols', 20, 500)
  const rows = optionalInt(body, 'rows', 5, 200)

  // 会话时长由服务端配置决定, 客户端不能突破硬性上限.
  // 终端不使用 max_output_bytes: 交互式输出不做累积截断.
  const repo = new SettingsRepository(c.env.DB)
  const idleTimeout = await repo.get('terminal', 'idle_timeout_seconds')
  const maxDuration = await repo.get('terminal', 'max_duration_seconds')

  const data = await callMonitor<{ sessionId: string; cols: number; rows: number }>(
    c.env,
    '/api/terminal',
    {
      body: {
        serverId: id,
        admin: ctx.get('admin').username,
        cols: cols ?? undefined,
        rows: rows ?? undefined,
        idleTimeoutSeconds: parseIntOr(idleTimeout, 600),
        maxDurationSeconds: parseIntOr(maxDuration, 3_600),
      },
    },
  )
  return ok(ctx, data, 201)
})

/** 查询活动会话. 不属于当前管理员时统一 404. */
terminal.get('/sessions/:sessionId', async (c) => {
  const ctx = c as unknown as AppContext
  const sessionId = c.req.param('sessionId')
  const admin = ctx.get('admin').username

  return ok(
    ctx,
    await callMonitor(
      c.env,
      `/api/terminal/${encodeURIComponent(sessionId)}?admin=${encodeURIComponent(admin)}`,
    ),
  )
})

/** 按服务器查询该管理员的活动会话, 供页面刷新后重新挂载终端; 无会话时返回 null. */
terminal.get('/servers/:id/active', async (c) => {
  const ctx = c as unknown as AppContext
  const id = c.req.param('id')
  const admin = ctx.get('admin').username

  return ok(
    ctx,
    await callMonitor(c.env, `/api/terminal/server/${encodeURIComponent(id)}?admin=${encodeURIComponent(admin)}`),
  )
})

/** 主动关闭会话. */
terminal.post('/sessions/:sessionId/close', async (c) => {
  const ctx = c as unknown as AppContext
  const sessionId = c.req.param('sessionId')
  const admin = ctx.get('admin').username

  return ok(
    ctx,
    await callMonitor(c.env, `/api/terminal/${encodeURIComponent(sessionId)}/close`, { body: { admin } }),
  )
})

export { terminal }
