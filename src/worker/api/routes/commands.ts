import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { notFound } from '../../shared/errors'
import type { Env, Vars } from '../../shared/types'
import { monitorStub } from '../monitor'

const commands = new Hono<{ Bindings: Env; Variables: Vars }>()

/** 查询活动命令状态. 命令不存在、已清理或不属于当前管理员时统一 404. */
commands.get('/:commandId', async (c) => {
  const ctx = c as unknown as AppContext
  const commandId = c.req.param('commandId')
  const admin = ctx.get('admin').username

  const res = await monitorStub(c.env).fetch(
    `https://monitor/api/command/${encodeURIComponent(commandId)}?admin=${encodeURIComponent(admin)}`,
  )
  if (!res.ok) throw notFound('命令不存在或已结束', 'COMMAND_NOT_FOUND')

  const payload = (await res.json()) as { data?: unknown }
  return ok(ctx, payload.data ?? null)
})

/** 取消活动命令. 连接已断开时返回结果未知, 不谎称取消成功. */
commands.post('/:commandId/cancel', async (c) => {
  const ctx = c as unknown as AppContext
  const commandId = c.req.param('commandId')
  const admin = ctx.get('admin').username

  const res = await monitorStub(c.env).fetch(
    `https://monitor/api/command/${encodeURIComponent(commandId)}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ admin }),
    },
  )
  if (!res.ok) throw notFound('命令不存在或已结束', 'COMMAND_NOT_FOUND')

  const payload = (await res.json()) as { data?: unknown }
  return ok(ctx, payload.data ?? null)
})

export { commands }
