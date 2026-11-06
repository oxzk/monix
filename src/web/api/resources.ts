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
  ServerSnapshot,
  ServerSummary,
  SettingsMap,
  TerminalAccepted,
  TerminalSessionInfo,
} from './types'

export const authApi = {
  login: (username: string, password: string) =>
    api.post<{ username: string }>('/api/v1/auth/login', { username, password }),
  logout: () => api.post<{ ok: boolean }>('/api/v1/auth/logout'),
  me: (signal?: AbortSignal) =>
    api.get<{ authenticated: boolean; username?: string; expiresAt?: number }>('/api/v1/auth/me', signal),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ ok: boolean }>('/api/v1/auth/password', { currentPassword, newPassword }),
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
    return api.get<{ items: ServerSummary[]; total: number }>(`/api/v1/servers${suffix ? `?${suffix}` : ''}`, signal)
  },
  create: (name: string, groupId?: number | null) =>
    api.post<{ id: string; name: string; token: string }>('/api/v1/servers', { name, groupId }),
  get: (id: string, signal?: AbortSignal) =>
    api.get<ServerSummary>(`/api/v1/servers/${encodeURIComponent(id)}`, signal),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/v1/servers/${encodeURIComponent(id)}`),
  getInstallCommand: (id: string) =>
    api.get<{ id: string; command: string }>(`/api/v1/servers/${encodeURIComponent(id)}/install-command`),
  latest: (signal?: AbortSignal) =>
    api.get<ServerSnapshot[]>('/api/v1/servers/metrics/latest', signal),
  latestOne: (id: string, signal?: AbortSignal) =>
    api.get<ServerSnapshot | null>(`/api/v1/servers/${encodeURIComponent(id)}/metrics/latest`, signal),
}

export const groupsApi = {
  list: (signal?: AbortSignal) => api.get<Group[]>('/api/v1/groups', signal),
  create: (name: string, description?: string | null) =>
    api.post<{ id: number; name: string }>('/api/v1/groups', { name, description }),
  update: (id: number, name: string, description?: string | null) =>
    api.patch<{ id: number; name: string }>(`/api/v1/groups/${id}`, { name, description }),
  remove: (id: number) => api.delete<{ ok: boolean }>(`/api/v1/groups/${id}`),
}

export const settingsApi = {
  get: (signal?: AbortSignal) => api.get<SettingsMap>('/api/v1/settings', signal),
  patch: (settings: Record<string, Record<string, unknown>>) =>
    api.patch<{ changed: number }>('/api/v1/settings', { settings }),
}

export const commandsApi = {
  create: (serverId: string, command: string) =>
    api.post<CommandAccepted>(`/api/v1/servers/${encodeURIComponent(serverId)}/commands`, { command }),
  cancel: (commandId: string) =>
    api.post<{ status: string }>(`/api/v1/commands/${encodeURIComponent(commandId)}/cancel`),
  status: (commandId: string) => api.get<unknown>(`/api/v1/commands/${encodeURIComponent(commandId)}`),
}

export const terminalApi = {
  open: (serverId: string, cols: number, rows: number) =>
    api.post<TerminalAccepted>(`/api/v1/terminal/servers/${encodeURIComponent(serverId)}`, { cols, rows }),
  get: (sessionId: string) =>
    api.get<TerminalSessionInfo>(`/api/v1/terminal/sessions/${encodeURIComponent(sessionId)}`),
  close: (sessionId: string) =>
    api.post<{ sessionId: string }>(`/api/v1/terminal/sessions/${encodeURIComponent(sessionId)}/close`),
}
