import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import type { Env, Vars } from '../../shared/types'

const health = new Hono<{ Bindings: Env; Variables: Vars }>()

/**
 * 公开的存活探针.
 *
 * 只表明 Worker 可以响应, 不探测 D1 或 Durable Object: 依赖状态属于内部信息,
 * 不应暴露给未认证的调用方. 配置错误由 app.ts 的全局校验统一返回 500.
 */
health.get('/', (c) => ok(c as unknown as AppContext, { status: 'ok' }))

export { health }
