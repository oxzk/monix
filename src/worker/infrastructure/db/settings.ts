export interface SettingRow {
  groupName: string
  key: string
  value: string
  description: string | null
  updated_at: number
}

/** 允许通过通用接口修改的配置项白名单, 防止越权覆盖密码哈希等敏感值. */
export const MUTABLE_SETTINGS: Record<string, readonly string[]> = {
  agent: ['collect_interval'],
  command: ['timeout_seconds', 'max_output_bytes'],
  terminal: ['idle_timeout_seconds', 'max_duration_seconds'],
  system: ['site_name', 'server_url'],
}

/** 硬性安全上限. 与 shared/protocol.ts 共用同一份定义. */
export { SETTINGS_BOUNDS } from '../../shared/protocol'

export class SettingsRepository {
  constructor(private readonly db: D1Database) {}

  async all(): Promise<SettingRow[]> {
    const result = await this.db
      .prepare('SELECT group_name AS groupName, key, value, description, updated_at FROM system_settings ORDER BY group_name, key')
      .all<SettingRow>()
    return result.results ?? []
  }

  async get(type: string, key: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT value FROM system_settings WHERE group_name = ? AND key = ?')
      .bind(type, key)
      .first<{ value: string }>()
    return row?.value ?? null
  }

  async getMany(type: string, keys: readonly string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {}
    const placeholders = keys.map(() => '?').join(', ')
    const result = await this.db
      .prepare(`SELECT key, value FROM system_settings WHERE group_name = ? AND key IN (${placeholders})`)
      .bind(type, ...keys)
      .all<{ key: string; value: string }>()
    const out: Record<string, string> = {}
    for (const row of result.results ?? []) out[row.key] = row.value
    return out
  }

  async put(type: string, key: string, value: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO system_settings (group_name, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (group_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(type, key, value, now)
      .run()
  }

  /** 仅当 key 不存在时写入, 返回是否真正写入. 用于首次启动时抢占式初始化. */
  async putIfAbsent(type: string, key: string, value: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO system_settings (group_name, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (group_name, key) DO NOTHING`,
      )
      .bind(type, key, value, now)
      .run()
    return (result.meta?.changes ?? 0) > 0
  }
  /**
   * 批量写入, 全部成功或全部失败.
   *
   * D1 的 `batch()` 在单个隐式事务中执行, 避免"校验通过后中途失败导致部分生效".
   */
  async putMany(entries: ReadonlyArray<{ type: string; key: string; value: string }>, now: number): Promise<void> {
    if (entries.length === 0) return
    const statement = this.db.prepare(
      `INSERT INTO system_settings (group_name, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (group_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    await this.db.batch(entries.map((entry) => statement.bind(entry.type, entry.key, entry.value, now)))
  }
}

/** 判断某个 type.key 是否允许管理员修改. */
export function isMutableSetting(type: string, key: string): boolean {
  return (MUTABLE_SETTINGS[type] ?? []).includes(key)
}

export function parseIntOr(value: string | null, fallback: number): number {
  if (value === null) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Agent 运行配置, 下发给 Agent 的字段. */
export interface AgentRuntimeConfig {
  collectIntervalMs: number
  timeoutSeconds: number
  maxOutputBytes: number
}

/**
 * 读取下发给 Agent 的配置.
 *
 * 注意: 这里只返回 Agent 会真正使用的值. 自动更新尚未实现, 因此不再下发
 * autoUpdate, 避免界面开关与实际行为不一致.
 */
export async function loadAgentConfig(repo: SettingsRepository): Promise<AgentRuntimeConfig> {
  const agent = await repo.getMany('agent', ['collect_interval'])
  const command = await repo.getMany('command', ['timeout_seconds', 'max_output_bytes'])
  return {
    collectIntervalMs: parseIntOr(agent.collect_interval ?? null, 5_000),
    timeoutSeconds: parseIntOr(command.timeout_seconds ?? null, 60),
    maxOutputBytes: parseIntOr(command.max_output_bytes ?? null, 1_048_576),
  }
}
