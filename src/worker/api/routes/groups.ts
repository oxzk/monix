/**
 * 分组接口: 列表、创建、更新、删除.
 *
 * 名称唯一性由服务层检查, 数据库另有 UNIQUE 约束兜底.
 */
import { Hono } from 'hono'
import { ok } from '../../shared/response'
import type { AppContext } from '../../shared/response'
import { conflict, notFound } from '../../shared/errors'
import { optionalString, readJson, requireString } from '../../shared/validation'
import { GroupsRepository } from '../../infrastructure/db/groups'
import type { Env, Vars } from '../../shared/types'

const groups = new Hono<{ Bindings: Env; Variables: Vars }>()

groups.get('/', async (c) => {
  const ctx = c as unknown as AppContext
  const rows = await new GroupsRepository(c.env.DB).list()
  return ok(
    ctx,
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      serverCount: row.server_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  )
})

groups.post('/', async (c) => {
  const ctx = c as unknown as AppContext
  const body = await readJson(c)
  const name = requireString(body, 'name', { max: 64 })
  const description = optionalString(body, 'description', 255) ?? null

  const repo = new GroupsRepository(c.env.DB)
  if (await repo.findByName(name)) throw conflict('分组名称已存在', 'GROUP_NAME_TAKEN')

  const id = await repo.create(name, description, Date.now())
  return ok(ctx, { id, name, description, serverCount: 0 }, 201)
})

groups.patch('/:id', async (c) => {
  const ctx = c as unknown as AppContext
  const id = Number.parseInt(c.req.param('id'), 10)
  if (!Number.isFinite(id)) throw notFound('分组不存在', 'GROUP_NOT_FOUND')

  const repo = new GroupsRepository(c.env.DB)
  const existing = await repo.findById(id)
  if (!existing) throw notFound('分组不存在', 'GROUP_NOT_FOUND')

  const body = await readJson(c)
  const name = body.name === undefined ? existing.name : requireString(body, 'name', { max: 64 })
  const description =
    body.description === undefined ? existing.description : (optionalString(body, 'description', 255) ?? null)

  if (name !== existing.name) {
    const same = await repo.findByName(name)
    if (same && same.id !== id) throw conflict('分组名称已存在', 'GROUP_NAME_TAKEN')
  }

  await repo.update(id, name, description, Date.now())
  return ok(ctx, { id, name, description })
})

groups.delete('/:id', async (c) => {
  const ctx = c as unknown as AppContext
  const id = Number.parseInt(c.req.param('id'), 10)
  if (!Number.isFinite(id)) throw notFound('分组不存在', 'GROUP_NOT_FOUND')

  const repo = new GroupsRepository(c.env.DB)
  if (!(await repo.findById(id))) throw notFound('分组不存在', 'GROUP_NOT_FOUND')

  // 关联服务器的 group_id 由外键 ON DELETE SET NULL 置空, 服务器本身保留.
  await repo.delete(id)
  return ok(ctx, { ok: true })
})

export { groups }
