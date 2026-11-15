import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { badRequest, unauthorized } from '../../shared/errors'
import { readJson, requireString } from '../../shared/validation'
import { hashPassword, verifyPassword } from '../../shared/crypto'
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from '../../shared/totp'
import { SettingsRepository } from '../../infrastructure/db/settings'
import {
  bumpSessionVersion,
  clearSession,
  issueSession,
  readSession,
} from '../middleware/auth'
import type { Env, Vars } from '../../shared/types'

export const DEFAULT_ADMIN_USERNAME = 'admin'
/**
 * 默认管理员密码.
 *
 * ⚠️ 公开部署时 admin/admin 极易被猜测: 首次登录后必须立即在「系统设置」中
 * 修改密码, 且修改前的登录接口完全暴露在公网. 若不可接受, 回退为随机初始
 * 密码 + 日志打印的方案(见 git 历史).
 */
const DEFAULT_ADMIN_PASSWORD = 'admin'

/** 每个 isolate 只执行一次引导, 避免每次请求都查库. */
let bootstrapPromise: Promise<void> | null = null

/**
 * 初始化管理员账号.
 *
 * 规则:
 * - system_settings 中已有 pbkdf2 密码时不覆盖 (管理员已改过密码).
 * - 没有可用密码时写入默认凭据 admin/admin, 依赖管理员登录后立即改密.
 * - 历史遗留的非 pbkdf2 值无法用于登录, 直接覆盖为默认凭据.
 * - 写入是幂等的(同一哈希重复写结果一致), 多 isolate 并发首启也安全.
 */
export async function ensureAdminAccount(env: Env): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise

  bootstrapPromise = (async () => {
    const settings = new SettingsRepository(env.DB)
    const now = Date.now()

    const existingHash = await settings.get('admin', 'password_hash')
    if (existingHash && existingHash.startsWith('pbkdf2$')) {
      // 已有管理员密码, 只补齐缺失的用户名.
      const existingUser = await settings.get('admin', 'username')
      if (!existingUser) {
        await settings.putIfAbsent('admin', 'username', DEFAULT_ADMIN_USERNAME, now)
      }
      return
    }

    // 无可用密码(全新部署或历史遗留的无效哈希): 写入默认凭据 admin/admin.
    const hashed = await hashPassword(DEFAULT_ADMIN_PASSWORD)
    await settings.put('admin', 'password_hash', hashed, now)
    await settings.putIfAbsent('admin', 'username', DEFAULT_ADMIN_USERNAME, now)
  })()

  try {
    await bootstrapPromise
  } catch (error) {
    // 失败时允许下次请求重试.
    bootstrapPromise = null
    throw error
  }
}

/**
 * 读取当前管理员密码哈希.
 * 只从 system_settings 读取; password_hash 不在可修改白名单内,
 * 只能通过改密接口写入.
 */
export async function resolvePasswordHash(env: Env): Promise<string | null> {
  const settings = new SettingsRepository(env.DB)
  const stored = await settings.get('admin', 'password_hash')
  if (stored && stored.startsWith('pbkdf2$')) return stored
  return null
}

export async function resolveUsername(env: Env): Promise<string> {
  const settings = new SettingsRepository(env.DB)
  const stored = await settings.get('admin', 'username')
  return stored && stored.length > 0 ? stored : DEFAULT_ADMIN_USERNAME
}

/** TOTP 状态: 存于 system_settings 的 auth 分类, 不在通用设置接口中暴露. */
async function readTotpState(env: Env): Promise<{ enabled: boolean; secret: string | null }> {
  const settings = new SettingsRepository(env.DB)
  const [secret, enabled] = await Promise.all([
    settings.get('auth', 'totp_secret'),
    settings.get('auth', 'totp_enabled'),
  ])
  return { enabled: enabled === '1' && Boolean(secret), secret }
}

/** 登录之外的 TOTP 管理接口都要求有效会话. */
async function requireAdminSession(ctx: AppContext): Promise<void> {
  const session = await readSession(ctx)
  if (!session) throw unauthorized()
}

const auth = new Hono<{ Bindings: Env; Variables: Vars }>()

auth.post('/login', async (c) => {
  const ctx = c as unknown as AppContext

  // 全新部署首次登录时写入默认凭据 admin/admin(登录后请立即改密).
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

  // 密码通过后再要求动态码: 未启用两步验证时完全无感;
  // 未带码返回 TOTP_REQUIRED, 前端据此展示验证码输入框.
  const totp = await readTotpState(c.env)
  if (totp.enabled && totp.secret) {
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!code) throw unauthorized('需要动态验证码', 'TOTP_REQUIRED')
    if (!(await verifyTotp(totp.secret, code))) throw unauthorized('动态验证码错误', 'TOTP_INVALID')
  }

  await issueSession(ctx, username)
  return ok(ctx, { username })
})

auth.post('/logout', async (c) => {
  const ctx = c as unknown as AppContext
  // 递增会话版本, 让已经签发的 Cookie 全部失效.
  // 只删 Cookie 对已泄露的会话无效: 攻击者可以直接复用旧 Cookie 值继续访问.
  // 单管理员模型中登出即意味着"结束当前登录状态", 这里选择更强的一侧.
  await bumpSessionVersion(c.env)
  clearSession(ctx)
  return ok(ctx, { ok: true })
})

auth.get('/me', async (c) => {
  const ctx = c as unknown as AppContext
  // 登录页加载时会先请求本接口, 在这里完成首启引导(写入默认凭据 admin/admin).
  // 引导只会在没有管理员密码记录时写库一次.
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

/** 两步验证状态(是否启用). */
auth.get('/totp', async (c) => {
  const ctx = c as unknown as AppContext
  await requireAdminSession(ctx)
  const state = await readTotpState(c.env)
  return ok(ctx, { enabled: state.enabled })
})

/**
 * 生成新的 TOTP 密钥(未启用状态), 返回 otpauth 地址供验证器 App 扫码.
 * 已启用时拒绝: 需先关闭再重新配置, 避免误操作让现有验证器失效.
 */
auth.post('/totp/setup', async (c) => {
  const ctx = c as unknown as AppContext
  await requireAdminSession(ctx)

  const state = await readTotpState(c.env)
  if (state.enabled) throw badRequest('两步验证已启用, 请先关闭再重新配置', 'TOTP_ALREADY_ENABLED')

  const secret = generateTotpSecret()
  const settings = new SettingsRepository(c.env.DB)
  const now = Date.now()
  await settings.put('auth', 'totp_secret', secret, now)
  await settings.put('auth', 'totp_enabled', '0', now)

  const username = await resolveUsername(c.env)
  return ok(ctx, { secret, uri: totpProvisioningUri(secret, username) })
})

/** 用验证码确认启用. */
auth.post('/totp/enable', async (c) => {
  const ctx = c as unknown as AppContext
  await requireAdminSession(ctx)

  const body = await readJson(c)
  const code = requireString(body, 'code', { max: 16 })

  const state = await readTotpState(c.env)
  if (!state.secret) throw badRequest('请先生成密钥', 'TOTP_NOT_SETUP')
  if (state.enabled) throw badRequest('两步验证已启用', 'TOTP_ALREADY_ENABLED')
  if (!(await verifyTotp(state.secret, code))) throw badRequest('动态验证码错误', 'TOTP_INVALID')

  await new SettingsRepository(c.env.DB).put('auth', 'totp_enabled', '1', Date.now())
  return ok(ctx, { ok: true })
})

/** 用当前验证码确认关闭, 并清除密钥. */
auth.post('/totp/disable', async (c) => {
  const ctx = c as unknown as AppContext
  await requireAdminSession(ctx)

  const body = await readJson(c)
  const code = requireString(body, 'code', { max: 16 })

  const state = await readTotpState(c.env)
  if (!state.enabled || !state.secret) throw badRequest('两步验证未启用', 'TOTP_NOT_ENABLED')
  if (!(await verifyTotp(state.secret, code))) throw badRequest('动态验证码错误', 'TOTP_INVALID')

  const settings = new SettingsRepository(c.env.DB)
  const now = Date.now()
  await settings.put('auth', 'totp_enabled', '0', now)
  await settings.put('auth', 'totp_secret', '', now)
  return ok(ctx, { ok: true })
})

export { auth }
