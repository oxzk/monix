/**
 * servers 表的数据访问.
 *
 * 只负责 SQL 与行到 DTO 的映射, 不含业务判断.
 * 注意 `token_hash` 列名是历史遗留, 当前存 Agent Token 明文.
 */
import type { AppError } from '../../shared/errors'

export type ServerStatus = 'online' | 'offline'

export interface ServerRow {
  id: string
  name: string
  hostname: string | null
  ipv4: string | null
  ipv6: string | null
  country_code: string | null
  ip_updated_at: number | null
  token_hash: string
  group_id: number | null
  enabled: number
  status: ServerStatus
  created_at: number
  updated_at: number
}

export interface ServerDto {
  id: string
  name: string
  hostname: string | null
  ipv4: string | null
  ipv6: string | null
  countryCode: string | null
  ipUpdatedAt: number | null
  groupId: number | null
  enabled: boolean
  status: ServerStatus
  createdAt: number
  updatedAt: number
}

export function toServerDto(row: ServerRow): ServerDto {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    ipv4: row.ipv4,
    ipv6: row.ipv6,
    countryCode: row.country_code,
    ipUpdatedAt: row.ip_updated_at,
    groupId: row.group_id,
    enabled: row.enabled === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SERVER_SELECT = `
SELECT id, name, hostname, ipv4, ipv6, country_code, ip_updated_at,
       token_hash, group_id, enabled, status, created_at, updated_at
FROM servers
`

export interface ListServersQuery {
  limit: number
  offset: number
  groupId?: number | null
  status?: ServerStatus | null
  keyword?: string | null
}

export class ServersRepository {
  constructor(private readonly db: D1Database) {}

  async list(query: ListServersQuery): Promise<{ items: ServerRow[]; total: number }> {
    const where: string[] = []
    const params: unknown[] = []

    if (query.groupId !== undefined && query.groupId !== null) {
      where.push('group_id = ?')
      params.push(query.groupId)
    }
    if (query.status) {
      where.push('status = ?')
      params.push(query.status)
    }
    if (query.keyword) {
      where.push('(id LIKE ? OR name LIKE ? OR ipv4 LIKE ?)')
      const like = `%${query.keyword}%`
      params.push(like, like, like)
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const countRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM servers ${clause}`)
      .bind(...params)
      .first<{ total: number }>()

    const items = await this.db
      .prepare(`${SERVER_SELECT} ${clause} ORDER BY name ASC LIMIT ? OFFSET ?`)
      .bind(...params, query.limit, query.offset)
      .all<ServerRow>()

    return { items: items.results ?? [], total: countRow?.total ?? 0 }
  }

  async findById(id: string): Promise<ServerRow | null> {
    return this.db.prepare(`${SERVER_SELECT} WHERE id = ?`).bind(id).first<ServerRow>()
  }

  /** 读取当前 Agent Token. 兼容保留旧列名 token_hash, 当前存储明文. */
  async findByToken(token: string): Promise<ServerRow | null> {
    return this.db.prepare(`${SERVER_SELECT} WHERE token_hash = ?`).bind(token).first<ServerRow>()
  }

  async create(input: {
    id: string
    name: string
    token: string
    groupId: number | null
    now: number
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO servers (id, name, token_hash, group_id, enabled, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'offline', ?, ?)`,
      )
      .bind(input.id, input.name, input.token, input.groupId, input.now, input.now)
      .run()
  }

  async update(
    id: string,
    patch: {
      name?: string
      groupId?: number | null
      enabled?: boolean
      hostname?: string | null
      countryCode?: string | null
      ipv4?: string | null
      ipv6?: string | null
      ipUpdatedAt?: number
      tokenHash?: string
    },
    now: number,
  ): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []

    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.groupId !== undefined) {
      sets.push('group_id = ?')
      params.push(patch.groupId)
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(patch.enabled ? 1 : 0)
    }
    if (patch.hostname !== undefined) {
      sets.push('hostname = ?')
      params.push(patch.hostname)
    }
    if (patch.countryCode !== undefined) {
      sets.push('country_code = ?')
      params.push(patch.countryCode)
    }
    if (patch.ipv4 !== undefined) {
      sets.push('ipv4 = ?')
      params.push(patch.ipv4)
    }
    if (patch.ipv6 !== undefined) {
      sets.push('ipv6 = ?')
      params.push(patch.ipv6)
    }
    if (patch.ipUpdatedAt !== undefined) {
      sets.push('ip_updated_at = ?')
      params.push(patch.ipUpdatedAt)
    }
    if (patch.tokenHash !== undefined) {
      sets.push('token_hash = ?')
      params.push(patch.tokenHash)
    }
    if (sets.length === 0) return

    sets.push('updated_at = ?')
    params.push(now, id)

    await this.db.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run()
  }

  async setStatus(id: string, status: ServerStatus, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE servers SET status = ?, updated_at = ? WHERE id = ? AND status != ?`)
      .bind(status, now, id, status)
      .run()
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM servers WHERE id = ?').bind(id).run()
  }

  /** 冷启动时把所有服务器的缓存状态重置为离线, 避免 D1 残留过期的 online. */
  async resetAllStatuses(now: number): Promise<void> {
    await this.db.prepare(`UPDATE servers SET status = 'offline', updated_at = ? WHERE status = 'online'`).bind(now).run()
  }
}

export type { AppError }
