/** 统一的业务错误: message 为内部细节, publicMessage 为对外文案. */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly publicMessage: string

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST', publicMessage?: string) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.publicMessage = publicMessage ?? (statusCode >= 500 ? '服务暂时不可用, 请稍后重试' : message)
  }
}

export function badRequest(message: string, code = 'BAD_REQUEST'): AppError {
  return new AppError(message, 400, code)
}

export function unauthorized(message = '请先登录后台', code = 'UNAUTHORIZED'): AppError {
  return new AppError(message, 401, code)
}

export function forbidden(message = '无权执行该操作', code = 'FORBIDDEN'): AppError {
  return new AppError(message, 403, code)
}

export function notFound(message = '资源不存在', code = 'NOT_FOUND'): AppError {
  return new AppError(message, 404, code)
}

export function conflict(message: string, code = 'CONFLICT'): AppError {
  return new AppError(message, 409, code)
}

export function serviceUnavailable(message: string, code = 'UNAVAILABLE'): AppError {
  return new AppError(message, 503, code)
}
