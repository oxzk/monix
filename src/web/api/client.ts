interface ApiEnvelope<T> {
  ok: boolean
  data: T
  error?: { code: string; message: string }
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

function isAuthPath(path: string): boolean {
  return path.startsWith('/api/v1/auth/')
}

function handleUnauthorized(path: string): never {
  if (!isAuthPath(path) && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    const next = `${window.location.pathname}${window.location.search}`
    window.location.assign(next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login')
  }
  throw new ApiError('登录已过期, 请重新登录', 'UNAUTHORIZED', 401)
}

/** 统一 fetch 封装: 携带 Cookie, 解开 { ok, data } 信封. */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, { credentials: 'include', ...init, headers })

  if (response.status === 401) {
    if (!isAuthPath(path)) handleUnauthorized(path)
    throw new ApiError('身份校验失败', 'UNAUTHORIZED', 401)
  }

  const text = await response.text()
  let payload: ApiEnvelope<T> | null = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as ApiEnvelope<T>
    } catch {
      payload = null
    }
  }

  if (!response.ok || !payload || payload.ok === false) {
    const message = payload?.error?.message ?? `请求失败 (HTTP ${response.status})`
    const code = payload?.error?.code ?? 'HTTP_ERROR'
    throw new ApiError(message, code, response.status)
  }

  return payload.data
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> => apiJson<T>(path, { method: 'GET', signal }),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    apiJson<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown): Promise<T> =>
    apiJson<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string): Promise<T> => apiJson<T>(path, { method: 'DELETE' }),
}
