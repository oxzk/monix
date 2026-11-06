import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Env, Vars } from './types'

export type AppContext = Context<{ Bindings: Env; Variables: Vars }>

/** 成功响应: { ok: true, data }. */
export function ok(c: AppContext, data: unknown = null, status: ContentfulStatusCode = 200): Response {
  return c.json({ ok: true, data }, status)
}

/** 错误响应: { ok: false, error: { code, message } }, 不泄露堆栈与内部细节. */
export function fail(
  c: AppContext,
  message: string,
  status: ContentfulStatusCode = 400,
  code = 'BAD_REQUEST',
): Response {
  return c.json({ ok: false, error: { code, message } }, status)
}
