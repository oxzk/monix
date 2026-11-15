---
name: install-monix-agent
description: 在 Linux 服务器上安装、升级或卸载 Monix Agent(资源监控上报)。需要目标机器 root 权限, 以及 Monix 后台为这台服务器生成的 Agent Token。
---

# Monix Agent 安装

Monix Agent 通过 WebSocket 长连接上报 CPU/内存/磁盘/网络/负载, 并接受后台下发的命令与交互式终端。安装脚本自动识别 systemd / OpenRC / SysV / 容器(无 init)。

## 前置条件

1. 目标机器: Linux(x86_64 / aarch64 / armv7), 具备 `curl` 或 `wget` 与 `tar`。
2. 根权限: 安装需要 `sudo`(脚本内部要求 root)。
3. Agent Token: 在 Monix 后台添加服务器后, 由「安装命令」按钮复制, 形如 `mnx_...`。Token 等同于该机器的凭据, 不要外泄。

## 安装 / 升级

在目标机器上执行(把 `<TOKEN>` 换成实际 Token):

```bash
curl -fsSL https://monix.api01.eu.org/install-agent.sh | sudo bash -s -- --token <TOKEN>
```

脚本要求 root 权限, 不做自动提权: 已是 root(容器/root 登录)时可省略 `sudo`,
非 root 必须用 `sudo` 执行, 否则直接报错退出。

- 自建部署或自定义域名时追加 `--server-url https://<域名>`; 默认使用官方站点。
- 重复执行同一命令即为升级(覆盖二进制、重写服务单元并重启)。
- 安装器会把二进制装到 `/opt/monix-agent`, 配置写入 `/etc/monix-agent/agent.env`(0600), 数据目录 `/var/lib/monix-agent`。

## 验证

```bash
# systemd
systemctl status monix-agent
journalctl -u monix-agent -n 20
```

- 日志出现「已连接, 采集间隔 ... ms」即成功。
- 后台服务器列表该机器变为「在线」, 公开状态页出现指标。

## 卸载

```bash
curl -fsSL https://monix.api01.eu.org/install-agent.sh | sudo bash -s -- --uninstall
```

默认连配置与数据一并删除(`/etc/monix-agent`、`/var/lib/monix-agent`)。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 日志「凭据被拒绝 (HTTP 401/403)」 | Token 无效或服务器已被删除/禁用; 回后台轮换 Token 后重装 |
| 日志「连接中断」反复重连 | 网络/DNS/代理问题; Agent 自动指数退避, 长连恢复后自动回到 5s 上报 |
| 后台显示离线但进程在跑 | 检查机器出网与 `MONIX_SERVER_URL` 是否可达 |