/** 密码哈希与随机令牌工具. 全部基于 WebCrypto, 不依赖 Node 内置模块. */

const PBKDF2_ITERATIONS = 210_000
const PBKDF2_HASH = 'SHA-256'
const SALT_BYTES = 16
const KEY_BITS = 256

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 计算 SHA-256 摘要(hex). 用于兼容历史摘要形式的 Agent Token. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return toHex(new Uint8Array(digest))
}

/** 以 hex 形式生成随机令牌, 便于粘贴到 Agent 配置. */
export function randomTokenHex(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return toHex(buf)
}

/**
 * Agent Token 前缀. 新令牌带前缀, 使明文记录与历史 SHA-256 摘要
 * (纯 64 位十六进制) 在格式上可区分, 不会互相误判.
 */
export const AGENT_TOKEN_PREFIX = 'mnx_'

/** 生成带前缀的 Agent Token. */
export function newAgentToken(bytes = 32): string {
  return `${AGENT_TOKEN_PREFIX}${randomTokenHex(bytes)}`
}


async function derivePbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH },
    keyMaterial,
    KEY_BITS,
  )
  return new Uint8Array(bits)
}

/** 生成密码哈希: pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES)
  crypto.getRandomValues(salt)
  const derived = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`
}

/** 校验密码. 解析失败或格式不识别时返回 false, 不抛出异常. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false
  const iterations = Number.parseInt(parts[2] ?? '', 10)
  if (!Number.isFinite(iterations) || iterations < 10_000) return false
  try {
    const salt = fromBase64(parts[3] ?? '')
    const expected = fromBase64(parts[4] ?? '')
    const derived = await derivePbkdf2(password, salt, iterations)
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

/** 定长比较, 避免时序侧信道. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b))
}

/* ---------------- Session Cookie 签名 ---------------- */

function base64UrlEncode(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return fromBase64(padded)
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

/** 生成 `<payloadB64>.<signatureB64>` 形式的签名串. */
export async function signPayload(payload: unknown, secret: string): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`
}

/** 校验签名并返回 payload; 任何异常都返回 null. */
export async function verifyPayload<T>(token: string, secret: string): Promise<T | null> {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  try {
    const key = await hmacKey(secret)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(signature),
      new TextEncoder().encode(body),
    )
    if (!valid) return null
    const json = new TextDecoder().decode(base64UrlDecode(body))
    return JSON.parse(json) as T
  } catch {
    return null
  }
}
