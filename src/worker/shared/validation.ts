import { badRequest } from './errors'

/** 读取并校验 JSON 请求体. */
export async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw badRequest('请求体必须是合法 JSON', 'INVALID_JSON')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('请求体必须是 JSON 对象', 'INVALID_BODY')
  }
  return raw as Record<string, unknown>
}

export function requireString(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; trim?: boolean } = {},
): string {
  const value = body[key]
  if (typeof value !== 'string') throw badRequest(`字段 ${key} 必须是字符串`, 'INVALID_FIELD')
  const out = options.trim === false ? value : value.trim()
  const min = options.min ?? 1
  const max = options.max ?? 200
  if (out.length < min) throw badRequest(`字段 ${key} 不能为空`, 'INVALID_FIELD')
  if (out.length > max) throw badRequest(`字段 ${key} 长度不能超过 ${max}`, 'INVALID_FIELD')
  return out
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  max = 500,
): string | null | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw badRequest(`字段 ${key} 必须是字符串或 null`, 'INVALID_FIELD')
  const out = value.trim()
  if (out.length > max) throw badRequest(`字段 ${key} 长度不能超过 ${max}`, 'INVALID_FIELD')
  return out.length === 0 ? null : out
}

export function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw badRequest(`字段 ${key} 必须是布尔值`, 'INVALID_FIELD')
  return value
}

export function optionalInt(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest(`字段 ${key} 必须是整数`, 'INVALID_FIELD')
  }
  if (value < min || value > max) {
    throw badRequest(`字段 ${key} 必须在 ${min} 到 ${max} 之间`, 'INVALID_FIELD')
  }
  return value
}

/** 解析分页参数, 并强制上限. */
export function parsePagination(url: URL, defaultSize = 20, maxSize = 100): { limit: number; offset: number } {
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const rawOffset = Number.parseInt(url.searchParams.get('offset') ?? '', 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), maxSize) : defaultSize
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0
  return { limit, offset }
}

/** 校验 ISO 3166-1 alpha-2; XX/T1 等特殊值不作为有效代码. */
export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const upper = value.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return null
  if (upper === 'XX' || upper === 'T1') return null
  return upper
}

/**
 * 校验 IPv4 / IPv6 字面量并归一化.
 *
 * 使用 WHATWG URL 解析器而不是手写正则: 它是标准的 IP 语法解析器, 会拒绝
 * 前导零、缩写 IPv4、带端口或路径等非规范写法, 并把 IPv6 归一化为标准形式.
 */
export function normalizeIp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 45) return null

  if (trimmed.includes(':')) {
    try {
      const host = new URL(`http://[${trimmed}]/`).hostname
      if (!host.startsWith('[') || !host.endsWith(']')) return null
      return host.slice(1, -1).toLowerCase()
    } catch {
      return null
    }
  }

  try {
    const host = new URL(`http://${trimmed}/`).hostname
    // 解析器会把 127.1、010.0.0.1 之类改写成别的地址; 只接受原样保留的规范四段十进制.
    if (host !== trimmed) return null
    // URL 解析器同样接受域名, 这里要求四段纯数字, 排除把主机名当成 IP.
    const parts = host.split('.')
    if (parts.length !== 4) return null
    for (const part of parts) {
      if (part.length === 0 || part.length > 3) return null
      for (const char of part) {
        if (char < '0' || char > '9') return null
      }
    }
    return host
  } catch {
    return null
  }
}

/** 归一化后的地址是否属于 IPv6, 用于选择 ipv4 / ipv6 列. */
export function isIpv6(value: string): boolean {
  return value.includes(':')
}
