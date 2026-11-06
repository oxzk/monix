-- Monix 初始 schema: 仅三张业务表, 不保存指标历史与命令历史.

CREATE TABLE IF NOT EXISTS server_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT,
    ipv4 TEXT,
    ipv6 TEXT,
    country_code TEXT,
    ip_updated_at INTEGER,
    token_hash TEXT NOT NULL,
    group_id INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1
        CHECK (enabled IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'offline'
        CHECK (status IN ('online', 'offline')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (group_id)
        REFERENCES server_groups(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_servers_group_id
ON servers(group_id);

CREATE TABLE IF NOT EXISTS system_settings (
    type TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    description TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (type, key)
);

INSERT OR IGNORE INTO system_settings (type, key, value, description, updated_at) VALUES
    ('agent', 'collect_interval', '5000', 'Agent 采集间隔, 毫秒', 0),
    ('agent', 'auto_update', 'true', '是否自动更新 Agent', 0),
    ('command', 'timeout_seconds', '60', '单条命令最大执行时间, 秒', 0),
    ('command', 'max_output_bytes', '1048576', '单条命令最大输出量, 字节', 0),
    ('terminal', 'idle_timeout_seconds', '600', '终端空闲超时, 秒', 0),
    ('terminal', 'max_duration_seconds', '3600', '终端会话最长时长, 秒', 0),
    ('system', 'site_name', 'Monix', '站点名称', 0),
    ('system', 'server_url', '', '对外访问地址, 用于生成 Agent 安装命令', 0);
