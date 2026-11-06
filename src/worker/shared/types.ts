/** 运行时环境与绑定. */
export interface Env {
  /** Session Cookie 签名密钥. */
  SESSION_SECRET: string
  DB: D1Database
  MONITOR: DurableObjectNamespace
  ASSETS?: Fetcher
}

/** 已认证的管理员身份, 由 Worker 在握手/请求阶段写入内部变量. */
export interface AdminIdentity {
  username: string
}

export interface Vars {
  admin: AdminIdentity
}

/** Session Cookie 中携带的数据. */
export interface SessionPayload {
  sub: string
  /** 签发时间(Unix 毫秒). */
  iat: number
  /** 过期时间(Unix 毫秒). */
  exp: number
  /** 密码版本, 与当前管理员密码版本不一致时视为失效. */
  ver: number
}
