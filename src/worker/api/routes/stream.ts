import { Hono } from 'hono'
import { unauthorized } from '../../shared/errors'
import { readSession } from '../middleware/auth'
import type { AppContext } from '../../shared/response'
import type { Env, Vars } from '../../shared/types'
import { monitorStub } from '../monitor'

const stream = new Hono<{ Bindings: Env; Variables: Vars }>()

/**
 * Dashboard 实时订阅.
 * Worker 校验 Session, 把管理员标识写入内部请求头交给 MonitorDO;
 * MonitorDO 依赖该标识做命令归属校验, 不信任客户端自报身份.
 */
stream.get('/', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected websocket upgrade', 426)
  }

  const session = await readSession(c as unknown as AppContext)
  if (!session) throw unauthorized()

  const headers = new Headers(c.req.raw.headers)
  headers.set('x-monix-admin', session.sub)
  headers.delete('x-monix-server-id')

  return monitorStub(c.env).fetch('https://monitor/ws/dashboard', { method: 'GET', headers })
})

export { stream }
