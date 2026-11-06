import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { badRequest } from '../../shared/errors'
import { readJson } from '../../shared/validation'
import {
  isMutableSetting,
  MUTABLE_SETTINGS,
  SETTINGS_BOUNDS,
  SettingsRepository,
} from '../../infrastructure/db/settings'
import type { Env, Vars } from '../../shared/types'

const settings = new Hono<{ Bindings: Env; Variables: Vars }>()

settings.get('/', async (c) => {
  const ctx = c as unknown as AppContext
  const rows = await new SettingsRepository(c.env.DB).all()

  const grouped: Record<string, Record<string, { value: string; description: string | null; updatedAt: number }>> = {}
  for (const row of rows) {
    // admin 分类包含密码哈希与会话版本, 永不出现在通用读取接口中.
    if (row.type === 'admin') continue
    grouped[row.type] ??= {}
    grouped[row.type]![row.key] = {
      value: row.value,
      description: row.description,
      updatedAt: row.updated_at,
    }
  }

  return ok(ctx, { settings: grouped, mutable: MUTABLE_SETTINGS, bounds: SETTINGS_BOUNDS })
})

settings.patch('/', async (c) => {
  const ctx = c as unknown as AppContext
  const body = await readJson(c)
  const patch = body.settings

  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw badRequest('settings 必须是对象', 'INVALID_BODY')
  }

  const repo = new SettingsRepository(c.env.DB)
  const now = Date.now()
  let changed = 0

  for (const [type, entries] of Object.entries(patch as Record<string, unknown>)) {
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
      throw badRequest(`配置分类 ${type} 必须是对象`, 'INVALID_BODY')
    }
    for (const [key, rawValue] of Object.entries(entries as Record<string, unknown>)) {
      // 白名单以外的配置(含密码哈希)不允许经通用接口修改.
      if (!isMutableSetting(type, key)) {
        throw badRequest(`配置项 ${type}.${key} 不允许修改`, 'SETTING_NOT_MUTABLE')
      }

      const value = normalizeSettingValue(type, key, rawValue)
      await repo.put(type, key, value, now)
      changed += 1
    }
  }

  return ok(ctx, { changed })
})

/** 按配置项校验并归一化取值, 拒绝超出硬性上限的值. */
function normalizeSettingValue(type: string, key: string, raw: unknown): string {
  const bounds = SETTINGS_BOUNDS[`${type}.${key}`]

  if (typeof raw === 'boolean') {
    if (bounds) throw badRequest(`配置项 ${type}.${key} 必须是数字`, 'INVALID_SETTING')
    return raw ? 'true' : 'false'
  }

  if (typeof raw === 'number') {
    if (!bounds) throw badRequest(`配置项 ${type}.${key} 必须是字符串`, 'INVALID_SETTING')
    if (!Number.isInteger(raw)) throw badRequest(`配置项 ${type}.${key} 必须是整数`, 'INVALID_SETTING')
    if (raw < bounds.min || raw > bounds.max) {
      throw badRequest(
        `配置项 ${type}.${key} 必须在 ${bounds.min} 到 ${bounds.max} 之间`,
        'SETTING_OUT_OF_RANGE',
      )
    }
    return String(raw)
  }

  if (typeof raw === 'string') {
    const value = raw.trim()
    if (bounds) {
      if (!/^\d+$/.test(value)) throw badRequest(`配置项 ${type}.${key} 必须是数字`, 'INVALID_SETTING')
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed)) throw badRequest(`配置项 ${type}.${key} 必须是数字`, 'INVALID_SETTING')
      if (parsed < bounds.min || parsed > bounds.max) {
        throw badRequest(
          `配置项 ${type}.${key} 必须在 ${bounds.min} 到 ${bounds.max} 之间`,
          'SETTING_OUT_OF_RANGE',
        )
      }
      return String(parsed)
    }
    if (value.length > 200) throw badRequest(`配置项 ${type}.${key} 过长`, 'INVALID_SETTING')

    // 服务端地址会拼进 Agent 安装命令, 必须是可用的 http(s) 地址.
    if (type === 'system' && key === 'server_url' && value.length > 0) {
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        throw badRequest('服务端地址必须是完整 URL, 例如 https://monix.example.com', 'INVALID_SETTING')
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw badRequest('服务端地址只支持 http 或 https', 'INVALID_SETTING')
      }
      return parsed.origin
    }

    return value
  }

  throw badRequest(`配置项 ${type}.${key} 取值类型不支持`, 'INVALID_SETTING')
}

export { settings }
