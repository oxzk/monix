import { Hono } from 'hono'
import { fail } from './shared/response'
import type { AppContext } from './shared/response'
import { AppError } from './shared/errors'
import { requireAdmin, requireSameOrigin } from './api/middleware/auth'
import { auth } from './api/routes/auth'
import { servers } from './api/routes/servers'
import { groups } from './api/routes/groups'
import { settings } from './api/routes/settings'
import { theme } from './api/routes/theme'
import { commands } from './api/routes/commands'
import { terminal } from './api/routes/terminal'
import { agent } from './api/routes/agent'
import { publicConfigRoutes, publicServersRoutes, publicStreamRoutes } from './api/routes/public'
import { stream } from './api/routes/stream'
import { health } from './api/routes/health'
import type { Env, Vars } from './shared/types'

const app = new Hono<{ Bindings: Env; Variables: Vars }>()

/** Session 签名密钥的最小长度. 短于该值时可被暴力破解, 视为部署配置错误. */
const MIN_SESSION_SECRET_LENGTH = 32

/**
 * 响应安全头.
 *
 * 只作用于 Worker 生成的响应(即 /api/*). 静态资源由 assets 层直接返回,
 * 不走 Worker, 因此同一组头还必须写进 `public/_headers`.
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  [
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // Radix 等组件会写入内联 style 属性.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      // Dashboard 的实时通道与 API 同源, 'self' 已覆盖同主机 ws/wss.
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  ],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
]

app.use('*', async (c, next) => {
  await next()

  const res = c.res
  // WebSocket 升级响应(101)重建后会丢失 webSocket 句柄, 必须原样返回.
  if (res.status === 101 || (res as Response & { webSocket?: unknown }).webSocket) return

  const headers = new Headers(res.headers)
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value)
  const body = res.status === 204 || res.status === 304 ? null : res.body
  c.res = new Response(body, { status: res.status, statusText: res.statusText, headers })
})

/** 配置错误只记录一次, 避免每个请求都刷日志. */
let configErrorLogged = false

// 配置校验放在所有路由之前: SESSION_SECRET 不可用时直接拒绝服务, 不进入业务逻辑.
app.use('*', async (c, next) => {
  const secret = c.env.SESSION_SECRET
  if (typeof secret !== 'string' || secret.trim().length < MIN_SESSION_SECRET_LENGTH) {
    if (!configErrorLogged) {
      configErrorLogged = true
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'config.invalid_session_secret',
          message: `SESSION_SECRET 缺失或长度不足 ${MIN_SESSION_SECRET_LENGTH} 个字符, 已拒绝提供服务`,
        }),
      )
    }
    return fail(c as unknown as AppContext, '服务配置错误, 请联系管理员', 500, 'CONFIG_ERROR')
  }
  await next()
})

/** 统一错误处理: AppError 对外使用 publicMessage, 其他错误一律 500 且不泄露细节. */
app.onError((err, c) => {
  const ctx = c as unknown as AppContext
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'http.request.failed',
          method: c.req.method,
          path: c.req.path,
          code: err.code,
          error: err.message,
        }),
      )
    }
    return fail(ctx, err.publicMessage, err.statusCode as never, err.code)
  }

  console.error(
    JSON.stringify({
      level: 'error',
      event: 'http.request.crashed',
      method: c.req.method,
      path: c.req.path,
      error: err instanceof Error ? err.message : String(err),
    }),
  )
  return fail(ctx, '服务暂时不可用, 请稍后重试', 500, 'INTERNAL_ERROR')
})

app.notFound((c) => {
  const ctx = c as unknown as AppContext
  if (c.req.path.startsWith('/api/')) {
    return fail(ctx, '接口不存在', 404, 'NOT_FOUND')
  }
  // 非 API 路径交给静态资源层与 SPA 回退处理.
  return c.env.ASSETS?.fetch(c.req.raw) ?? c.text('Not found', 404)
})

const api = new Hono<{ Bindings: Env; Variables: Vars }>()

// ---------------- 前台(公开): /api/v1 ----------------
// 健康检查、认证入口、状态页数据(只读、已脱敏)与 Agent 协议(独立 Token 认证).
const v1 = new Hono<{ Bindings: Env; Variables: Vars }>()

v1.route('/health', health)
v1.route('/auth', auth)
v1.route('/servers', publicServersRoutes)
v1.route('/config', publicConfigRoutes)
v1.route('/stream', publicStreamRoutes)
v1.route('/agent', agent)

app.route('/api/v1', v1)

// ---------------- 后台(管理员): /api/admin ----------------
const admin = new Hono<{ Bindings: Env; Variables: Vars }>()
admin.use('/*', requireSameOrigin)
admin.use('/*', requireAdmin)
admin.route('/servers', servers)
admin.route('/groups', groups)
admin.route('/settings', settings)
admin.route('/theme', theme)
admin.route('/commands', commands)
admin.route('/terminal', terminal)
admin.route('/stream', stream)

app.route('/api/admin', admin)

export default app
