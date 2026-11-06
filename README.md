# Monix

轻量级服务器实时监控与远程运维系统。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置本地密钥

创建 `.dev.vars`：

```bash
SESSION_SECRET=<随机字符串>
```

`SESSION_SECRET` 可用 `openssl rand -hex 32` 生成，长度必须不少于 32 个字符；缺失或过短时所有接口直接返回 500，并记录 `config.invalid_session_secret`。

首次打开登录页时会自动创建管理员 `admin`，初始密码随机生成，**只在创建时的 Worker 日志中打印一次**：

```bash
npx wrangler tail        # 线上
# 或直接在 npm run dev 的终端输出里查看
```

日志形如 `{"event":"admin.bootstrap_credentials","username":"admin","password":"..."}`。
请登录后立即在「系统设置」中修改密码。密码只保存 PBKDF2 哈希，初始密码丢失后无法找回。

### 3. 初始化数据库并启动

```bash
npm run db:migrate:local
npm run dev
```

打开 http://localhost:5173，使用 `admin` 和上一步日志里的初始密码登录。

### 4. 部署 Agent

在「服务器」页面新建服务器，然后在服务器列表点击「复制安装命令」，把命令粘贴到目标服务器执行。Token 当前以明文保存在 D1 的历史列 `token_hash` 中；限制 D1、备份和运维账号的读取权限。当前版本不提供 Token 轮换。安装包必须来自受信任的 Monix Release；不要把 Token 放入命令历史或公开日志。

```bash
curl -fsSL https://raw.githubusercontent.com/oxzk/monix/main/scripts/install-agent.sh \
  | sudo bash -s -- --server-url https://your-worker.example.com --token <Agent Token>
```

脚本会自动下载匹配当前架构的 Release 包（musl 静态链接）、校验 SHA-256、创建 `monix` 服务账号、
安装到 `/opt/monix-agent`、写入 `/etc/monix-agent/agent.env`。

服务管理方式自动探测，覆盖主流 Linux 发行版：

| 方式 | 适用环境 |
|---|---|
| systemd | Debian / Ubuntu / CentOS / RHEL / Fedora / Arch / openSUSE |
| OpenRC | Alpine / Gentoo |
| SysV init | 老旧发行版 |
| 后台进程 | Docker / LXC / Podman 等无 init 的容器 |

产物按 `{os}-{arch}` 命名：

| 平台 | 产物 | 说明 |
|---|---|---|
| `linux-x86_64` | `monix-agent-linux-x86_64.tar.gz` | |
| `linux-aarch64` | `monix-agent-linux-aarch64.tar.gz` | |
| `linux-armv7` | `monix-agent-linux-armv7.tar.gz` | 树莓派等 32 位 ARM |
| `darwin-x86_64` | `monix-agent-darwin-x86_64.tar.gz` | |
| `darwin-aarch64` | `monix-agent-darwin-aarch64.tar.gz` | Apple Silicon |
| `windows-x86_64` | `monix-agent-windows-x86_64.zip` | |
| `windows-aarch64` | `monix-agent-windows-aarch64.zip` | |

Linux 产物统一使用 musl 静态链接，同一份二进制可在 glibc 与 musl 发行版（如 Alpine）上运行。

卸载：

```bash
sudo bash install-agent.sh --uninstall
```

卸载会停止服务并删除程序，配置文件与数据目录保留；需要时手动执行
`rm -rf /etc/monix-agent /var/lib/monix-agent`。

### 5. 部署到 Cloudflare

```bash
wrangler d1 create monix          # 把 database_id 填入 wrangler.toml
npm run secrets:upload -- --env-file .dev.vars
npm run deploy
```

`secrets:upload` 会读取 env 文件并逐个上传为 Worker Secrets。推送到 `v*` tag 会触发
GitHub Actions，构建 Linux / macOS / Windows 多平台 Agent 并发布 Release。

## 脚本

| 命令 | 说明 |
|---|---|
| `npm run secrets:upload -- --env-file .dev.vars` | 上传 Secrets 到 Cloudflare |
| `npm run agent:install -- --help` | Agent 安装 / 卸载 |

