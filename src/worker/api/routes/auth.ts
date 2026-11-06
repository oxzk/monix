import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { badRequest, unauthorized } from '../../shared/errors'
import { readJson, requireString } from '../../shared/validation'
import { hashPassword, verifyPassword } from '../../shared/crypto'
import { SettingsRepository } from '../../infrastructure/db/settings'
import { ensureAdminAccount, resolvePasswordHash, resolveUsername } from '../../application/auth'
import {
  bumpSessionVersion,
  clearSession,
  issueSession,
  readSession,
} from '../middleware/auth'
import type { Env, Vars } from '../../shared/types'

const auth = new Hono<{ Bindings: Env; Variables: Vars }>()

auth.post('/login', async (c) => {
  const ctx = c as unknown as AppContext

  // 全新部署首次登录时创建管理员, 初始密码随机生成并打印到 Worker 日志(仅一次).
  // 只放在登录路径上, 避免 /auth/me 之类的只读请求触发写库.
  await ensureAdminAccount(c.env)

  const body = await readJson(c)
  const username = requireString(body, 'username', { max: 64 })
  const password = requireString(body, 'password', { max: 256, trim: false })

  const passwordHash = await resolvePasswordHash(c.env)
  if (!passwordHash) throw badRequest('管理员密码未初始化', 'CONFIG_MISSING')

  const expectedUser = await resolveUsername(c.env)
  const userOk = username === expectedUser
  const passOk = await verifyPassword(password, passwordHash)

  if (!userOk || !passOk) {
    throw unauthorized('用户名或密码错误', 'INVALID_CREDENTIALS')
  }

  await issueSession(ctx, username)
  return ok(ctx, { username })
})

auth.post('/logout', async (c) => {
  const ctx = c as unknown as AppContext
  clearSession(ctx)
  return ok(ctx, { ok: true })
})

auth.get('/me', async (c) => {
  const ctx = c as unknown as AppContext
  // 登录页加载时会先请求本接口, 在这里完成首启引导, 让初始密码在用户尝试登录前
  // 就打印到日志. 引导只会在没有管理员记录时写库一次.
  await ensureAdminAccount(c.env)
  const session = await readSession(ctx)
  if (!session) return ok(ctx, { authenticated: false })
  return ok(ctx, { authenticated: true, username: session.sub, expiresAt: session.exp })
})

auth.post('/password', async (c) => {
  const ctx = c as unknown as AppContext
  const session = await readSession(ctx)
  if (!session) throw unauthorized()

  const body = await readJson(c)
  const current = requireString(body, 'currentPassword', { max: 256, trim: false })
  const next = requireString(body, 'newPassword', { min: 8, max: 256, trim: false })

  const passwordHash = await resolvePasswordHash(c.env)
  if (!passwordHash) throw badRequest('管理员密码未初始化', 'CONFIG_MISSING')

  const valid = await verifyPassword(current, passwordHash)
  if (!valid) throw unauthorized('当前密码错误', 'INVALID_CREDENTIALS')

  const settings = new SettingsRepository(c.env.DB)
  const hashed = await hashPassword(next)
  await settings.put('admin', 'password_hash', hashed, Date.now())
  await bumpSessionVersion(c.env)

  // 改密后旧会话全部失效, 当前会话重新签发.
  clearSession(ctx)
  await issueSession(ctx, session.sub)

  return ok(ctx, { ok: true })
})

export { auth }
