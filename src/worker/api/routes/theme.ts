/** 前台主题配置: 后台自定义背景图与 UI 配色. */
import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { badRequest } from '../../shared/errors'
import { normalizeThemeOptions, parseThemeOptions } from '../../shared/theme'
import { invalidatePublicCache } from './public'
import { SettingsRepository } from '../../infrastructure/db/settings'
import type { Env, Vars } from '../../shared/types'

const theme = new Hono<{ Bindings: Env; Variables: Vars }>()

const THEME_KEY = 'theme_options'
const THEME_TYPE = 'system'

async function readThemeOptions(db: D1Database) {
  const raw = await new SettingsRepository(db).get(THEME_TYPE, THEME_KEY)
  return parseThemeOptions(raw)
}

/** 当前前台主题配置. */
theme.get('/', async (c) => {
  const ctx = c as unknown as AppContext
  return ok(ctx, await readThemeOptions(c.env.DB))
})

/** 保存前台主题配置. 非法颜色键/值直接丢弃, 不让展示配置的保存被单个字段卡死. */
theme.post('/', async (c) => {
  const ctx = c as unknown as AppContext
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw badRequest('请求体必须是合法 JSON', 'INVALID_JSON')
  }

  const result = normalizeThemeOptions(body)
  if (!result.ok) throw badRequest('theme 配置格式不正确', 'INVALID_THEME')

  await new SettingsRepository(c.env.DB).put(THEME_TYPE, THEME_KEY, JSON.stringify(result.value), Date.now())
  invalidatePublicCache()
  return ok(ctx, result.value)
})

export { theme }