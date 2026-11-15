/**
 * server_groups 表的数据访问.
 *
 * 删除分组依赖外键 ON DELETE SET NULL 解除服务器关联, 不级联删除服务器.
 */
export interface GroupRow {
  id: number
  name: string
  description: string | null
  created_at: number
  updated_at: number
}

const GROUP_SELECT = `
SELECT id, name, description, created_at, updated_at
FROM server_groups
`

export class GroupsRepository {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<Array<GroupRow & { server_count: number }>> {
    const result = await this.db
      .prepare(
        `SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
                (SELECT COUNT(*) FROM servers s WHERE s.group_id = g.id) AS server_count
         FROM server_groups g
         ORDER BY g.name ASC`,
      )
      .all<GroupRow & { server_count: number }>()
    return result.results ?? []
  }

  async findById(id: number): Promise<GroupRow | null> {
    return this.db.prepare(`${GROUP_SELECT} WHERE id = ?`).bind(id).first<GroupRow>()
  }

  async findByName(name: string): Promise<GroupRow | null> {
    return this.db.prepare(`${GROUP_SELECT} WHERE name = ? COLLATE NOCASE`).bind(name).first<GroupRow>()
  }

  /**
   * 创建分组.
   *
   * name 上有 COLLATE NOCASE 的唯一索引, 并发创建同名分组时数据库会拒绝第二条;
   * 这里把该错误翻译成 `DuplicateGroupNameError`, 由路由层转成 409 而不是 500.
   */
  async create(name: string, description: string | null, now: number): Promise<number> {
    try {
      const result = await this.db
        .prepare(
          `INSERT INTO server_groups (name, description, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(name, description, now, now)
        .run()
      return Number(result.meta.last_row_id ?? 0)
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new DuplicateGroupNameError()
      throw error
    }
  }

  async update(id: number, name: string, description: string | null, now: number): Promise<void> {
    try {
      await this.db
        .prepare('UPDATE server_groups SET name = ?, description = ?, updated_at = ? WHERE id = ?')
        .bind(name, description, now, id)
        .run()
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new DuplicateGroupNameError()
      throw error
    }
  }

  /** 删除分组: 外键 ON DELETE SET NULL 会把服务器的 group_id 置空. */
  async delete(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM server_groups WHERE id = ?').bind(id).run()
  }
}

/** 分组名唯一约束冲突. 由路由层映射为 409. */
export class DuplicateGroupNameError extends Error {
  constructor() {
    super('分组名称已存在')
    this.name = 'DuplicateGroupNameError'
  }
}

/** D1 把 SQLite 的约束错误包在 message 里, 这里做宽松匹配. */
function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed/i.test(message)
}
