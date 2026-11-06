export interface SettingRow {
  type: string
  key: string
  value: string
  description: string | null
  updated_at: number
}

/** 允许通过通用接口修改的配置项白名单, 防止越权覆盖密码哈希等敏感值. */
export const MUTABLE_SETTINGS: Record<string, readonly string[]> = {
  agent: ['collect_interval', 'auto_update'],
  command: ['timeout_seconds', 'max_output_bytes'],
  terminal: ['idle_timeout_seconds', 'max_duration_seconds'],
  system: ['site_name', 'server_url'],
}

/** 硬性安全上限: 即使管理员也无法配置超出该范围的值. */
export const SETTINGS_BOUNDS: Record<string, { min: number; max: number }> = {
  'agent.collect_interval': { min: 1_000, max: 300_000 },
  'command.timeout_seconds': { min: 5, max: 300 },
  'command.max_output_bytes': { min: 65_536, max: 16_777_216 },
  'terminal.idle_timeout_seconds': { min: 60, max: 3_600 },
  'terminal.max_duration_seconds': { min: 300, max: 7_200 },
}

export class SettingsRepository {
  constructor(private readonly db: D1Database) {}

  async all(): Promise<SettingRow[]> {
    const result = await this.db
      .prepare('SELECT type, key, value, description, updated_at FROM system_settings ORDER BY type, key')
      .all<SettingRow>()
    return result.results ?? []
  }

  async get(type: string, key: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT value FROM system_settings WHERE type = ? AND key = ?')
      .bind(type, key)
      .first<{ value: string }>()
    return row?.value ?? null
  }

  async getMany(type: string, keys: readonly string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {}
    const placeholders = keys.map(() => '?').join(', ')
    const result = await this.db
      .prepare(`SELECT key, value FROM system_settings WHERE type = ? AND key IN (${placeholders})`)
      .bind(type, ...keys)
      .all<{ key: string; value: string }>()
    const out: Record<string, string> = {}
    for (const row of result.results ?? []) out[row.key] = row.value
    return out
  }

  async put(type: string, key: string, value: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO system_settings (type, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (type, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(type, key, value, now)
      .run()
  }

  /** 仅当 key 不存在时写入, 返回是否真正写入. 用于首次启动时抢占式初始化. */
  async putIfAbsent(type: string, key: string, value: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO system_settings (type, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (type, key) DO NOTHING`,
      )
      .bind(type, key, value, now)
      .run()
    return (result.meta?.changes ?? 0) > 0
  }
}

/** 判断某个 type.key 是否允许管理员修改. */
export function isMutableSetting(type: string, key: string): boolean {
  return (MUTABLE_SETTINGS[type] ?? []).includes(key)
}

export function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback
  return value === 'true' || value === '1'
}

export function parseIntOr(value: string | null, fallback: number): number {
  if (value === null) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Agent 运行配置, 下发给 Agent 的字段. */
export interface AgentRuntimeConfig {
  collectIntervalMs: number
  autoUpdate: boolean
  timeoutSeconds: number
  maxOutputBytes: number
}

export async function loadAgentConfig(repo: SettingsRepository): Promise<AgentRuntimeConfig> {
  const agent = await repo.getMany('agent', ['collect_interval', 'auto_update'])
  const command = await repo.getMany('command', ['timeout_seconds', 'max_output_bytes'])
  return {
    collectIntervalMs: parseIntOr(agent.collect_interval ?? null, 5_000),
    autoUpdate: parseBoolean(agent.auto_update ?? null, true),
    timeoutSeconds: parseIntOr(command.timeout_seconds ?? null, 60),
    maxOutputBytes: parseIntOr(command.max_output_bytes ?? null, 1_048_576),
  }
}
