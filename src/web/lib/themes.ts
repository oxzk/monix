/**
 * 前台主题.
 *
 * 主题 = 内置 `default` 基底配色 + 后台自定义覆盖(背景图与各配色键),
 * 以 CSS 变量注入前台容器, 只影响公开状态页, 不影响后台.
 * 颜色键与取值校验的单一来源在 `src/worker/shared/theme.ts`, 两边键位须一致.
 */

import type { ThemeColorKey, ThemeOptions } from '@/api/types'

/** 内置 default 主题的基底配色(中性灰白 + 深墨强调). */
export const DEFAULT_THEME_COLORS: Record<ThemeColorKey, string> = {
  bg: '#f6f7f9',
  card: '#ffffff',
  ink: '#111827',
  muted: '#6b7280',
  faint: '#9ca3af',
  line: '#e5e7eb',
  accent: '#111827',
  accentInk: '#ffffff',
  ok: '#10b981',
  bad: '#e11d48',
}

/** 配色键在设置面板里的展示名. */
export const THEME_COLOR_LABELS: Record<ThemeColorKey, string> = {
  bg: '页面背景',
  card: '卡片',
  ink: '正文',
  muted: '次要文字',
  faint: '弱化文字',
  line: '边框',
  accent: '强调色',
  accentInk: '强调色文字',
  ok: '在线',
  bad: '离线',
}

export const THEME_COLOR_KEYS = Object.keys(DEFAULT_THEME_COLORS) as ThemeColorKey[]

const THEME_VAR: Record<ThemeColorKey, string> = {
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

/**
 * 合成前台容器的 CSS 变量: 内置基底 + 后台覆盖.
 * 返回值直接铺进容器 style.
 */
export function buildThemeVars(colors: Partial<Record<ThemeColorKey, string>> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of THEME_COLOR_KEYS) {
    out[THEME_VAR[key]] = colors[key] ?? DEFAULT_THEME_COLORS[key]
  }
  return out
}

/** hex(#rrggbb) → rgba; 非法输入时回落到默认底色. */
function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())
  const digits = match?.[1]
  if (!digits) return `rgba(233, 238, 245, ${alpha})`
  const value = parseInt(digits, 16)
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

/** 组装背景图样式; 未配置背景图时为空(前台用纯色底). 遮罩浓度由主题配置决定. */
export function buildBackgroundStyle(theme: ThemeOptions | null | undefined): Record<string, string> {
  if (!theme?.backgroundImage) return {}
  const image = theme.backgroundImage
  const opacity = Math.min(95, Math.max(0, theme.backgroundOpacity ?? 0))
  const imageLayer = `url("${image}")`
  return {
    // 浓度 > 0 时在图片上叠一层页面底色遮罩(第一层在最上).
    backgroundImage:
      opacity > 0
        ? `linear-gradient(${withAlpha(theme.colors.bg ?? DEFAULT_THEME_COLORS.bg, opacity / 100)}, ${withAlpha(
            theme.colors.bg ?? DEFAULT_THEME_COLORS.bg,
            opacity / 100,
          )}), ${imageLayer}`
        : imageLayer,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundAttachment: 'fixed',
  }
}