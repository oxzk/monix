/**
 * TOTP (RFC 6238): 6 位动态码, 30 秒步长, SHA-1, 纯 Web Crypto 实现(无第三方依赖).
 *
 * 校验允许前后各 1 个时间步的时钟漂移, 与常见验证器 App 行为一致.
 * 密钥只存服务端 system_settings(auth 分类), 不进入任何读取接口.
 */

const DIGITS = 6
const PERIOD_SECONDS = 30
const WINDOW = 1
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 生成 base32 密钥(20 字节熵, 不含填充). */
export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return base32Encode(bytes)
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

/** base32 → 字节; 非法字符返回 null. */
function base32Decode(secret: string): Uint8Array | null {
  const normalized = secret.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const message = new ArrayBuffer(8)
  new DataView(message).setBigUint64(0, BigInt(counter))
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f
  const value =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff)
  return String(value % 10 ** DIGITS).padStart(DIGITS, '0')
}

/** 校验动态码; 允许前后各一个时间步的漂移. */
export async function verifyTotp(secret: string, code: string, now = Date.now()): Promise<boolean> {
  const normalized = code.trim()
  if (!/^\d{6}$/.test(normalized)) return false
  const key = base32Decode(secret)
  if (!key) return false
  const counter = Math.floor(now / 1000 / PERIOD_SECONDS)
  for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
    if ((await hotp(key, counter + offset)) === normalized) return true
  }
  return false
}

/** otpauth:// 配置地址, 供验证器 App 扫码. */
export function totpProvisioningUri(secret: string, account: string, issuer = 'Monix'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}