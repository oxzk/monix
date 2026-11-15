/**
 * servers 表的数据访问.
 *
 * 只负责 SQL 与行到 DTO 的映射, 不含业务判断.
 *
 * Agent 凭据:
 * - `token` 存 Agent Token 明文, 安装脚本直接写入目标机器的 agent.env.
 * - 该列有唯一索引, 同时保证一个 Token 只对应一台服务器.
 * - 凭据不进入通用 SELECT: 只有 findByToken / findById 显式带 token,
 *   其余查询(列表/公开路由)拿到的行不含凭据.
 */
export type ServerStatus = 'online' | 'offline'

export interface ServerRow {
  id: string
  name: string
  platform: string | null
  version: string | null
  ipv4: string | null
  ipv6: string | null
  country_code: string | null
  ip_updated_at: number | null
  group_id: number | null
  enabled: number
  status: ServerStatus
  created_at: number
  updated_at: number
}

/** 带 Agent Token 的行: 仅 findByToken / findById 返回. */
export interface ServerRowWithToken extends ServerRow {
  /** Agent Token 明文. */
  token: string
}

export interface ServerDto {
  id: string
  name: string
  platform: string | null
  version: string | null
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
    platform: row.platform,
    version: row.version,
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

/** 不含凭据的通用列清单: 列表与公开路由使用. */
const SERVER_COLUMNS = `
  id, name, platform, version, ipv4, ipv6, country_code, ip_updated_at,
  group_id, enabled, status, created_at, updated_at
`

const SERVER_SELECT = `
SELECT ${SERVER_COLUMNS}
FROM servers
`

const SERVER_SELECT_WITH_TOKEN = `
SELECT id, name, platform, version, ipv4, ipv6, country_code, ip_updated_at,
       token, group_id, enabled, status, created_at, updated_at
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
      // 关键字搜索对 LIKE 通配符做转义, 避免用户输入 % / _ 时产生意外匹配.
      const escaped = query.keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)
      where.push("(id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR ipv4 LIKE ? ESCAPE '\\')")
      const like = `%${escaped}%`
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

  /** 按 id 查询(带 Token, 供安装命令/轮换使用). */
  async findById(id: string): Promise<ServerRowWithToken | null> {
    return this.db.prepare(`${SERVER_SELECT_WITH_TOKEN} WHERE id = ?`).bind(id).first<ServerRowWithToken>()
  }

  /** 按 Token 查找服务器. 走 idx_servers_token 唯一索引. */
  async findByToken(token: string): Promise<ServerRowWithToken | null> {
    return this.db
      .prepare(`${SERVER_SELECT_WITH_TOKEN} WHERE token = ?`)
      .bind(token)
      .first<ServerRowWithToken>()
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
        `INSERT INTO servers (id, name, token, group_id, enabled, status, created_at, updated_at)
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
      platform?: string | null
      version?: string | null
      countryCode?: string | null
      ipv4?: string | null
      ipv6?: string | null
      ipUpdatedAt?: number
      token?: string
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
    if (patch.platform !== undefined) {
      sets.push('platform = ?')
      params.push(patch.platform)
    }
    if (patch.version !== undefined) {
      sets.push('version = ?')
      params.push(patch.version)
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
    if (patch.token !== undefined) {
      // 轮换: 覆盖 Token, 旧 Token 立即失效.
      sets.push('token = ?')
      params.push(patch.token)
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
  /**
   * 清理「早于 cutoff」的遗留 online 行(updated_at < cutoff).
   *
   * DO 冷启动对账专用: 只清本次启动前写入的 online, 启动后 Agent 上报 /
   * markOnline 写入的行(updated_at >= cutoff)不受影响, 因此可以安全地
   * 在后台与实时写入并发执行.
   */
  async resetStaleStatuses(cutoff: number): Promise<void> {
    await this.db
      .prepare(`UPDATE servers SET status = 'offline', updated_at = ? WHERE status = 'online' AND updated_at < ?`)
      .bind(cutoff, cutoff)
      .run()
  }
}
