/**
 * 前台主题配置的单一来源.
 *
 * 主题 = 内置 default 基底 + 后台自定义覆盖(背景图与配色), 以 JSON 存在
 * `system_settings` 的 `system.theme_options` 里. Worker 与前端共用这里的
 * 键位/校验/归一化, 避免两侧漂移.
 */

/** 可后台配置的配色键 (camelCase), 与 CSS 变量 `--p-*` 一一对应. */
export const THEME_COLOR_KEYS = [
  'bg',
  'card',
  'ink',
  'muted',
  'faint',
  'line',
  'accent',
  'accentInk',
  'ok',
  'bad',
] as const

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number]

export interface ThemeOptions {
  /** 背景图片地址; null/空表示不使用背景图. */
  backgroundImage: string | null
  /**
   * 背景遮罩浓度(0-95): 叠加页面底色的不透明度百分比.
   * 0 表示图片原样显示, 数值越高背景图越淡; 默认 0(无遮罩).
   */
  backgroundOpacity: number
  /** 配色覆盖; 未提供的键沿用内置 default 基底. */
  colors: Partial<Record<ThemeColorKey, string>>
}

/** 归一化后的存储形态(全部字段齐全, 空值以 null/空对象表示). */
export type NormalizedThemeOptions = ThemeOptions

/** camelCase 键 → CSS 变量名. */
export const THEME_COLOR_VAR: Record<ThemeColorKey, string> = {
  bg: '--p-bg',
  card: '--p-card',
  ink: '--p-ink',
  muted: '--p-muted',
  faint: '--p-faint',
  line: '--p-line',
  accent: '--p-accent',
  accentInk: '--p-accent-ink',
  ok: '--p-ok',
  bad: '--p-bad',
}

/** 十六进制颜色: #rgb / #rrggbb / #rrggbbaa. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value)
}

function normalizeBackgroundImage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > 500) return null
  // 站内路径(如默认背景 /b1-1.jpg): / 开头且不是协议相对 //
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * 校验并归一化后台提交的主题选项.
 *
 * 非法值不抛错而是丢弃(该键回退内置基底): 主题是纯展示配置,
 * 保存路径应当宽容, 让管理员改错一个颜色不至于保存失败.
 * `unknown` 返回整体无效(结构不对), 由路由层返回 400.
 */
export function normalizeThemeOptions(raw: unknown): { ok: true; value: NormalizedThemeOptions } | { ok: false } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false }
  const input = raw as { backgroundImage?: unknown; backgroundOpacity?: unknown; colors?: unknown }

  const backgroundImage = normalizeBackgroundImage(input.backgroundImage)
  // 遮罩浓度: 0-95 的整数; 非法值静默回落到 0(无遮罩).
  const rawOpacity = input.backgroundOpacity
  const backgroundOpacity =
    typeof rawOpacity === 'number' && Number.isFinite(rawOpacity)
      ? Math.min(95, Math.max(0, Math.round(rawOpacity)))
      : 0

  const colors: Partial<Record<ThemeColorKey, string>> = {}
  if (input.colors !== undefined && input.colors !== null) {
    if (typeof input.colors !== 'object' || Array.isArray(input.colors)) return { ok: false }
    for (const [key, value] of Object.entries(input.colors as Record<string, unknown>)) {
      if (!THEME_COLOR_KEYS.includes(key as ThemeColorKey)) {
        // 键位漂移说明前端与这里的白名单不同步, 记录下来便于发现.
        console.warn(JSON.stringify({ level: 'warn', event: 'theme.unknown_color_key', key }))
        continue
      }
      if (!isHexColor(value)) {
        console.warn(JSON.stringify({ level: 'warn', event: 'theme.invalid_color_value', key }))
        continue
      }
      colors[key as ThemeColorKey] = value
    }
  }

  return { ok: true, value: { backgroundImage, backgroundOpacity, colors } }
}

/** 读库后的宽松解析: 任何异常都回退到默认主题(无覆盖). */
export function parseThemeOptions(raw: string | null): NormalizedThemeOptions {
  if (!raw) return { backgroundImage: null, backgroundOpacity: 0, colors: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    const result = normalizeThemeOptions(parsed)
    return result.ok ? result.value : { backgroundImage: null, backgroundOpacity: 0, colors: {} }
  } catch {
    return { backgroundImage: null, backgroundOpacity: 0, colors: {} }
  }
}