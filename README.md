# Monix

轻量级服务器实时监控与远程运维系统。

## 安装

```bash
npm install
```

## 运行

```bash
cp .dev.vars.example .dev.vars     # 填写 SESSION_SECRET: openssl rand -hex 32
npm run db:migrate:local
npm run dev                        # http://localhost:5173
```

首次打开登录页会自动创建管理员，默认凭据为 **`admin` / `admin`**。


## 部署

```bash
wrangler d1 create monix           # 把 database_id 填入 wrangler.toml
npm run db:migrate                 # 远端 D1 建表
npm run secrets:upload -- --env-file .dev.vars
npm run build
npm run deploy
```

`npm run deploy` 只执行 `wrangler deploy`，不会构建前端；漏掉 `npm run build` 会发布旧的 `dist/client`。

```bash
# 需要 root 权限; 非 root 用户请用 sudo
curl -fsSL https://monix.api01.eu.org/install-agent.sh \
  | sudo bash -s -- --token <Agent Token>
```


卸载：

```bash
curl -fsSL https://monix.api01.eu.org/install-agent.sh | sudo bash -s -- --uninstall
```

推送 `v*` tag 会触发 GitHub Actions 构建多平台 Agent 并发布 Release。

## 配置

Secrets（`wrangler secret put` 或 `secrets:upload`）：

| 名称 | 说明 |
|---|---|
| `SESSION_SECRET` | Session Cookie 签名密钥，至少 32 字符；缺失或过短时所有接口返回 500 |
|
