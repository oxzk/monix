import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { unauthorized } from '../../shared/errors'
import { signPayload, verifyPayload } from '../../shared/crypto'
import { SettingsRepository } from '../../infrastructure/db/settings'
import type { AppContext } from '../../shared/response'
import type { SessionPayload } from '../../shared/types'

/** Session 有效期 24 小时. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const SESSION_COOKIE = '__Host-monix_session'

/** 读取当前密码版本. 改密时递增, 使旧 Session 立即失效. */
export async function readSessionVersion(env: { DB: D1Database }): Promise<number> {
  const settings = new SettingsRepository(env.DB)
  const raw = await settings.get('admin', 'session_version')
  const version = raw === null ? 0 : Number.parseInt(raw, 10)
  return Number.isFinite(version) ? version : 0
}

export async function bumpSessionVersion(env: { DB: D1Database }): Promise<number> {
  const settings = new SettingsRepository(env.DB)
  const current = await readSessionVersion(env)
  const next = current + 1
  await settings.put('admin', 'session_version', String(next), Date.now())
  return next
}

export async function issueSession(c: AppContext, username: string): Promise<void> {
  const now = Date.now()
  const version = await readSessionVersion(c.env)
  const payload: SessionPayload = { sub: username, iat: now, exp: now + SESSION_TTL_MS, ver: version }
  const token = await signPayload(payload, c.env.SESSION_SECRET)

  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export function clearSession(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'Strict' })
}

/** 校验 Session Cookie, 返回管理员身份; 无效返回 null. */
export async function readSession(c: AppContext): Promise<SessionPayload | null> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null

  const payload = await verifyPayload<SessionPayload>(token, c.env.SESSION_SECRET)
  if (!payload) return null
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null

  // 密码版本不一致: 改密之后签发的旧会话全部失效.
  const current = await readSessionVersion(c.env)
  if (payload.ver !== current) return null

  return payload
}

/** 管理接口守卫. */
export const requireAdmin: MiddlewareHandler<{
  Bindings: import('../../shared/types').Env
  Variables: import('../../shared/types').Vars
}> = async (c, next) => {
  const session = await readSession(c as unknown as AppContext)
  if (!session) throw unauthorized()
  c.set('admin', { username: session.sub })
  await next()
}

/** 修改类请求的 Origin 校验, 作为 SameSite=Strict 的额外一层. */
export const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next()
    return
  }
  const origin = c.req.header('origin')
  if (!origin) {
    // 非浏览器客户端(如 curl)不带 Origin, 由 Session 校验兜底.
    await next()
    return
  }
  const expected = new URL(c.req.url).origin
  if (origin !== expected) {
    throw unauthorized('跨站请求被拒绝', 'CSRF_REJECTED')
  }
  await next()
}
