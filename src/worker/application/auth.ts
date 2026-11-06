import { SettingsRepository } from '../infrastructure/db/settings'
import { hashPassword, randomTokenHex } from '../shared/crypto'
import type { Env } from '../shared/types'

/**
 * 默认管理员用户名. 密码在首次启动时随机生成, 不再使用固定值.
 * 凭据只保存在 D1, 不接受来自环境变量或 Secrets 的覆盖.
 */
export const DEFAULT_ADMIN_USERNAME = 'admin'

/** 初始密码的随机字节数. hex 编码后为 32 个字符, 满足 128 位熵. */
const INITIAL_PASSWORD_BYTES = 16

/** 每个 isolate 只执行一次引导, 避免每次请求都查库. */
let bootstrapPromise: Promise<void> | null = null

/**
 * 初始化管理员账号.
 *
 * 规则:
 * - system_settings 中已有 pbkdf2 密码时不覆盖 (管理员已改过密码).
 * - 没有可用密码时生成随机初始密码, 只在创建成功的那一次打印到日志.
 * - 并发首启时由 D1 的唯一约束决出唯一写入者, 只有它能打印, 避免打印出已被覆盖的密码.
 */
export async function ensureAdminAccount(env: Env): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise

  bootstrapPromise = (async () => {
    const settings = new SettingsRepository(env.DB)

    const existingHash = await settings.get('admin', 'password_hash')
    const existingUser = await settings.get('admin', 'username')
    const now = Date.now()

    if (existingHash && existingHash.startsWith('pbkdf2$')) {
      // 已有管理员密码, 只补齐缺失的用户名.
      if (!existingUser) {
        await settings.putIfAbsent('admin', 'username', DEFAULT_ADMIN_USERNAME, now)
      }
      return
    }

    const initialPassword = randomTokenHex(INITIAL_PASSWORD_BYTES)
    const hashed = await hashPassword(initialPassword)

    let claimed: boolean
    if (existingHash) {
      // 历史遗留的非 pbkdf2 值无法用于登录, 直接覆盖.
      await settings.put('admin', 'password_hash', hashed, now)
      claimed = true
    } else {
      claimed = await settings.putIfAbsent('admin', 'password_hash', hashed, now)
    }
    if (!claimed) return

    await settings.putIfAbsent('admin', 'username', DEFAULT_ADMIN_USERNAME, now)
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'admin.bootstrap_credentials',
        username: DEFAULT_ADMIN_USERNAME,
        password: initialPassword,
        message: '已生成管理员初始密码, 仅本次显示. 登录后请立即修改, 之后无法再找回该密码.',
      }),
    )
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
