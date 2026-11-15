import { AppError } from '../shared/errors'
import type { Env } from '../shared/types'

/** 全局唯一的 MonitorDO 实例. 所有 Worker 入口共用同一份连接与运行态. */
export function monitorStub(env: Env): DurableObjectStub {
  return env.MONITOR.get(env.MONITOR.idFromName('global'))
}

/** DO 响应信封: { ok, data } 或 { ok:false, error, code }. */
interface MonitorEnvelope<T> {
  ok?: boolean
  data?: T
  error?: string
  code?: string
}

/**
 * 调用 MonitorDO 的内部 HTTP 接口并解开信封.
 *
 * DO 返回的错误(缺少参数/离线/占用/不存在等)统一转成 AppError 向上抛,
 * 消息与状态码原样透传, 路由层不再各自写一遍 res.json + 错误翻译.
 */
export async function callMonitor<T>(
  env: Env,
  path: string,
  init: { body?: unknown } = {},
): Promise<T> {
  const hasBody = init.body !== undefined
  const res = await monitorStub(env).fetch(`https://monitor${path}`, {
    method: hasBody ? 'POST' : 'GET',
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
  })

  let payload: MonitorEnvelope<T> | null = null
  try {
    payload = (await res.json()) as MonitorEnvelope<T>
  } catch {
    // DO 侧非 JSON 响应按内部错误处理, 不把原始响应体泄露给调用方.
  }

  if (!res.ok || !payload || payload.ok !== true) {
    const message = payload?.error ?? '监控服务暂时不可用'
    const code = payload?.code ?? 'MONITOR_ERROR'
    throw new AppError(message, (res.status === 101 ? 500 : res.status) as never, code)
  }
  return payload.data as T
}
