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

  async create(name: string, description: string | null, now: number): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO server_groups (name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(name, description, now, now)
      .run()
    return Number(result.meta.last_row_id ?? 0)
  }

  async update(id: number, name: string, description: string | null, now: number): Promise<void> {
    await this.db
      .prepare('UPDATE server_groups SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .bind(name, description, now, id)
      .run()
  }

  /** 删除分组: 外键 ON DELETE SET NULL 会把服务器的 group_id 置空. */
  async delete(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM server_groups WHERE id = ?').bind(id).run()
  }
}
