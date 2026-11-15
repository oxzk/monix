/**
 * REST 接口封装.
 *
 * 每个对象对应一组相关端点, 只负责拼路径与标注返回类型;
 * 错误处理与信封解开统一由 `api` 客户端完成.
 */
import { api } from './client'
import type {
  CommandAccepted,
  Group,
  PublicServer,
  ThemeOptions,
  ServerSummary,
  SettingsMap,
  TerminalAccepted,
  TerminalSessionInfo,
  TerminalSessionSummary,
} from './types'

export const publicApi = {
  /** 状态页服务器列表(只含服务器数据); 无需登录. */
  servers: (signal?: AbortSignal) => api.get<{ servers: PublicServer[] }>('/api/v1/servers', signal),
  /** 状态页站点配置(站点名 + 主题); 无需登录, 变化频率低, 首屏拉取一次即可. */
  config: (signal?: AbortSignal) =>
    api.get<{ siteName: string; theme: ThemeOptions }>('/api/v1/config', signal),
}

export const themeApi = {
  /** 当前前台主题配置(后台). */
  get: (signal?: AbortSignal) => api.get<ThemeOptions>('/api/admin/theme', signal),
  save: (options: ThemeOptions) => api.post<ThemeOptions>('/api/admin/theme', options),
}

export const authApi = {
  /** code: 启用两步验证时必填; 未启用时忽略. */
  login: (username: string, password: string, code?: string) =>
    api.post<{ username: string }>('/api/v1/auth/login', code ? { username, password, code } : { username, password }),
  logout: () => api.post<{ ok: boolean }>('/api/v1/auth/logout'),
  me: (signal?: AbortSignal) =>
    api.get<{ authenticated: boolean; username?: string; expiresAt?: number }>('/api/v1/auth/me', signal),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ ok: boolean }>('/api/v1/auth/password', { currentPassword, newPassword }),
  /** 两步验证(TOTP)状态. */
  totpStatus: (signal?: AbortSignal) => api.get<{ enabled: boolean }>('/api/v1/auth/totp', signal),
  /** 生成新密钥(未启用), 返回 secret 与 otpauth 地址. */
  totpSetup: () => api.post<{ secret: string; uri: string }>('/api/v1/auth/totp/setup'),
  totpEnable: (code: string) => api.post<{ ok: boolean }>('/api/v1/auth/totp/enable', { code }),
  totpDisable: (code: string) => api.post<{ ok: boolean }>('/api/v1/auth/totp/disable', { code }),
}

export const serversApi = {
  list: (params: { limit?: number; offset?: number; status?: string; groupId?: number; q?: string } = {}, signal?: AbortSignal) => {
    const search = new URLSearchParams()
    if (params.limit !== undefined) search.set('limit', String(params.limit))
    if (params.offset !== undefined) search.set('offset', String(params.offset))
    if (params.status) search.set('status', params.status)
    if (params.groupId !== undefined) search.set('groupId', String(params.groupId))
    if (params.q) search.set('q', params.q)
    const suffix = search.toString()
    return api.get<{ items: ServerSummary[]; total: number }>(`/api/admin/servers${suffix ? `?${suffix}` : ''}`, signal)
  },
  create: (name: string, groupId?: number | null) =>
    api.post<{ id: string; name: string; token: string }>('/api/admin/servers', { name, groupId }),
  get: (id: string, signal?: AbortSignal) =>
    api.get<ServerSummary>(`/api/admin/servers/${encodeURIComponent(id)}`, signal),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/admin/servers/${encodeURIComponent(id)}`),
  /** Agent 安装命令; 命令内含该服务器的 Agent Token. */
  getInstallCommand: (id: string) =>
    api.get<{ id: string; command: string; token: string }>(
      `/api/admin/servers/${encodeURIComponent(id)}/install-command`,
    ),
  /** 轮换 Agent Token; 旧凭据立即失效, 该服务器的现有连接会被断开. */
  rotateToken: (id: string) =>
    api.post<{ id: string; token: string }>(`/api/admin/servers/${encodeURIComponent(id)}/token/rotate`),
}

export const groupsApi = {
  list: (signal?: AbortSignal) => api.get<Group[]>('/api/admin/groups', signal),
  create: (name: string, description?: string | null) =>
    api.post<{ id: number; name: string }>('/api/admin/groups', { name, description }),
  update: (id: number, name: string, description?: string | null) =>
    api.patch<{ id: number; name: string }>(`/api/admin/groups/${id}`, { name, description }),
  remove: (id: number) => api.delete<{ ok: boolean }>(`/api/admin/groups/${id}`),
}

export const settingsApi = {
  get: (signal?: AbortSignal) => api.get<SettingsMap>('/api/admin/settings', signal),
  patch: (settings: Record<string, Record<string, unknown>>) =>
    api.patch<{ changed: number }>('/api/admin/settings', { settings }),
}

export const commandsApi = {
  create: (serverId: string, command: string) =>
    api.post<CommandAccepted>(`/api/admin/servers/${encodeURIComponent(serverId)}/commands`, { command }),
  cancel: (commandId: string) =>
    api.post<{ status: string }>(`/api/admin/commands/${encodeURIComponent(commandId)}/cancel`),
}

export const terminalApi = {
  open: (serverId: string, cols: number, rows: number) =>
    api.post<TerminalAccepted>(`/api/admin/terminal/servers/${encodeURIComponent(serverId)}`, { cols, rows }),
  /** 查询该服务器上当前管理员的活动会话; 没有时返回 null. */
  active: (serverId: string, signal?: AbortSignal) =>
    api.get<TerminalSessionSummary | null>(
      `/api/admin/terminal/servers/${encodeURIComponent(serverId)}/active`,
      signal,
    ),
  get: (sessionId: string) =>
    api.get<TerminalSessionInfo>(`/api/admin/terminal/sessions/${encodeURIComponent(sessionId)}`),
  close: (sessionId: string) =>
    api.post<{ sessionId: string }>(`/api/admin/terminal/sessions/${encodeURIComponent(sessionId)}/close`),
}
