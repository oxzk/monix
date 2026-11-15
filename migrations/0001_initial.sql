-- Monix 初始 schema: 3 张业务表, 不保存指标历史与命令历史.
--

CREATE TABLE IF NOT EXISTS server_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 分组名唯一性按大小写不敏感判定, 与 GroupsRepository.findByName 的
-- COLLATE NOCASE 查询以及接口的 GROUP_NAME_TAKEN 语义保持一致.
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_groups_name_nocase
ON server_groups(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    -- Agent 上报的平台标识 {os}-{arch}, 如 linux-x86_64; 连接时经 X-Monix-Platform 头写入.
    platform TEXT,
    -- Agent 当前版本, 如 0.1.0; 连接时经 X-Monix-Agent-Version 头写入.
    version TEXT,
    ipv4 TEXT,
    ipv6 TEXT,
    country_code TEXT,
    ip_updated_at INTEGER,
    -- Agent Token 明文. 安装脚本直接写入 /etc/monix-agent/agent.env,
    -- 数据库与本列同等敏感, D1 与其备份的访问权限需按凭据管理.
    token TEXT NOT NULL,
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

-- 认证路径按 Token 精确查询, 唯一索引同时保证"一个 Token 只对应一台服务器".
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_token
ON servers(token);

-- group_name 是配置分类(agent/command/system/admin/auth...), 与值的类型无关.
CREATE TABLE IF NOT EXISTS system_settings (
    group_name TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    description TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_name, key)
);

INSERT OR IGNORE INTO system_settings (group_name, key, value, description, updated_at) VALUES
    ('agent', 'collect_interval', '5000', 'Agent 采集间隔, 毫秒', 0),
    ('command', 'timeout_seconds', '60', '单条命令最大执行时间, 秒', 0),
    ('command', 'max_output_bytes', '1048576', '单条命令最大输出量, 字节', 0),
    ('terminal', 'idle_timeout_seconds', '600', '终端空闲超时, 秒', 0),
    ('terminal', 'max_duration_seconds', '3600', '终端会话最长时长, 秒', 0),
    ('system', 'site_name', 'Monix', '站点名称', 0),
    ('system', 'server_url', '', '对外访问地址, 用于生成 Agent 安装命令', 0);
