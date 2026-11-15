/**
 * 公开状态页的分组 tabs 计算.
 *
 * 单独抽成纯函数, 便于在没有 React 环境的情况下直接测试.
 */
import type { PublicServer } from '@/api/types'

/** 「全部」tab 的键; 未分组服务器用空串作为键. */
export const ALL_GROUPS = '__all__'

export interface GroupTab {
  key: string
  label: string
  total: number
  online: number
}

/** 按分组汇总在线/总数; 「全部」始终排在最前, 其余按名称排序. */
export function buildGroupTabs(servers: readonly PublicServer[]): GroupTab[] {
  const groups = new Map<string, GroupTab>()
  for (const server of servers) {
    const key = server.groupName ?? ''
    const entry = groups.get(key) ?? { key, label: server.groupName ?? '未分组', total: 0, online: 0 }
    entry.total += 1
    if (server.status === 'online') entry.online += 1
    groups.set(key, entry)
  }

  const ordered = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  const online = servers.filter((server) => server.status === 'online').length
  return [{ key: ALL_GROUPS, label: '全部', total: servers.length, online }, ...ordered]
}
