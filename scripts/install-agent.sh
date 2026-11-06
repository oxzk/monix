#!/bin/bash

# Monix Agent 安装 / 卸载脚本
#
# 兼容主流 Linux 发行版的服务管理方式:
#   - systemd   (Debian/Ubuntu/CentOS/RHEL/Fedora/Arch/openSUSE 等现代发行版)
#   - OpenRC    (Alpine/Gentoo)
#   - SysV init (老旧发行版)
#   - 无 init   (容器: Docker/LXC/Podman)
#
# 安装:
#   sudo ./scripts/install-agent.sh \
#     --server-url https://monix.example.com \
#     --token <agent-token>
#
# 卸载 (保留配置与数据):
#   sudo ./scripts/install-agent.sh --uninstall

set -euo pipefail

REPO="${MONIX_REPO:-oxzk/monix}"
INSTALL_DIR="/opt/monix-agent"
BIN_PATH="$INSTALL_DIR/monix-agent"
CONFIG_DIR="/etc/monix-agent"
CONFIG_FILE="$CONFIG_DIR/agent.env"
DATA_DIR="/var/lib/monix-agent"
PID_FILE="$DATA_DIR/agent.pid"
LOG_FILE="$DATA_DIR/agent.log"
SERVICE_NAME="monix-agent"
SYSTEMD_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
INITD_FILE="/etc/init.d/${SERVICE_NAME}"
SERVICE_USER="monix"

SERVER_URL=""
TOKEN=""
UNINSTALL=0

usage() {
  cat <<'EOF'
Monix Agent 安装脚本

用法:
  sudo ./install-agent.sh --server-url URL --token TOKEN
  sudo ./install-agent.sh --uninstall

参数:
  --server-url URL   服务端地址, 例如 https://monix.example.com  (必填)
  --token TOKEN      Agent 令牌, 仅在创建/轮换时显示一次           (必填)
                     令牌唯一标识服务器, 无需单独提供服务器 ID
  --uninstall        卸载 Agent (保留配置与数据)
  -h, --help         显示帮助

示例:
  sudo ./install-agent.sh \
    --server-url https://monix.example.com \
    --token 87145a5d2225d74dbe88d5573a079053e2a48406689a9ac373050f2dd4800071
EOF
}

log() { printf '%s\n' "$*"; }
err() { printf '❌ %s\n' "$*" >&2; }
warn() { printf '⚠️  %s\n' "$*" >&2; }

die() {
  err "$*"
  exit 1
}

# ---------- 参数解析 ----------

while [[ $# -gt 0 ]]; do
  case $1 in
    --server-url) SERVER_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1 (使用 --help 查看用法)" ;;
  esac
done

# ---------- 通用工具 ----------

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "需要 root 权限, 请使用 sudo 运行"
  fi
}

# 检测当前平台, 返回与 CI 产物一致的 `{os}-{arch}` 标识.
#
# 本脚本只处理 Linux; macOS 与 Windows 由各自的分发方式处理.
detect_platform() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) echo "linux-x86_64" ;;
    aarch64|arm64) echo "linux-aarch64" ;;
    armv7l|armv6l|armhf) echo "linux-armv7" ;;
    *) die "不支持的 CPU 架构: $machine" ;;
  esac
}

# 跨发行版的下载工具.
download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=20 -O "$dest" "$url"
  else
    die "需要 curl 或 wget 之一"
  fi
}

# 跨发行版的 SHA-256 校验.
verify_sha256() {
  local file="$1" expected="$2"
  local actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    actual="$(openssl dgst -sha256 "$file" | awk '{print $NF}')"
  else
    warn "系统缺少 SHA-256 工具, 跳过完整性校验"
    return 0
  fi
  [[ "$actual" == "$expected" ]]
}

# 跨发行版创建系统账号. useradd 参数在不同发行版差异较大, 逐个降级尝试.
create_service_user() {
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    return 0
  fi

  local nologin=/bin/false
  for candidate in /usr/sbin/nologin /sbin/nologin /bin/nologin; do
    if [[ -x "$candidate" ]]; then
      nologin="$candidate"
      break
    fi
  done

  log "👤 创建服务账号 $SERVICE_USER"

  # Debian/Ubuntu/RHEL/Fedora/Arch/openSUSE
  if command -v useradd >/dev/null 2>&1; then
    if useradd --system --no-create-home --shell "$nologin" "$SERVICE_USER" 2>/dev/null \
      || useradd -r -M -s "$nologin" "$SERVICE_USER" 2>/dev/null; then
      return 0
    fi
  fi

  # Alpine / BusyBox
  if command -v adduser >/dev/null 2>&1; then
    if adduser -S -H -s "$nologin" "$SERVICE_USER" 2>/dev/null \
      || adduser -S -D -H -s "$nologin" "$SERVICE_USER" 2>/dev/null; then
      return 0
    fi
  fi

  warn "创建系统账号失败, Agent 将以 root 运行"
  SERVICE_USER="root"
  return 0
}

# 设置目录属主. 某些文件系统(如容器 overlay)会忽略 chown, 失败不致命.
chown_dir() {
  local dir="$1"
  chown "$SERVICE_USER:$SERVICE_USER" "$dir" 2>/dev/null || true
}

# ---------- 初始化系统探测 ----------

detect_init() {
  # systemd 必须确认 PID 1 真的是 systemd: 容器里常能看到 systemctl 命令,
  # 但 /run/systemd/system 不存在, 此时 systemctl 无法工作.
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    echo "systemd"
    return
  fi
  # OpenRC (Alpine/Gentoo)
  if command -v rc-service >/dev/null 2>&1 && [[ -d /etc/init.d ]]; then
    echo "openrc"
    return
  fi
  # SysV init (老旧发行版与容器镜像)
  if [[ -d /etc/init.d ]] && command -v service >/dev/null 2>&1; then
    echo "sysv"
    return
  fi
  # 容器: 无任何 init 系统
  echo "none"
}

# ---------- 进程控制 ----------

pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  head -n 1 "$PID_FILE" 2>/dev/null
}

# 按可执行文件路径查找进程. 不用 pgrep -f: 会命中安装脚本自身命令行.
find_agent_pid() {
  if command -v pidof >/dev/null 2>&1; then
    pidof monix-agent 2>/dev/null | tr ' ' '\n' | head -n 1
    return 0
  fi
  # 无 pidof 时用 ps 兜底 (精简镜像可能缺少 pidof).
  ps -eo pid=,args= 2>/dev/null | awk -v bin="$BIN_PATH" '$2 == bin {print $1; exit}'
}

wait_pid_gone() {
  local pid="$1" attempt="$2"
  local i=0
  while pid_alive "$pid" && [[ $i -lt $attempt ]]; do
    sleep 0.2
    i=$((i + 1))
  done
  ! pid_alive "$pid"
}

stop_agent() {
  local init="$1"
  case "$init" in
    systemd)
      systemctl stop "$SERVICE_NAME" 2>/dev/null || true
      systemctl disable "$SERVICE_NAME" 2>/dev/null || true
      ;;
    openrc)
      rc-service "$SERVICE_NAME" stop 2>/dev/null || true
      rc-update del "$SERVICE_NAME" default 2>/dev/null || true
      ;;
    sysv)
      service "$SERVICE_NAME" stop 2>/dev/null || true
      if command -v update-rc.d >/dev/null 2>&1; then
        update-rc.d -f "$SERVICE_NAME" remove 2>/dev/null || true
      elif command -v chkconfig >/dev/null 2>&1; then
        chkconfig --del "$SERVICE_NAME" 2>/dev/null || true
      fi
      ;;
    none)
      local pid
      if pid="$(read_pid)" && pid_alive "$pid"; then
        log "🛑 停止后台进程 (PID $pid)"
        kill -TERM "$pid" 2>/dev/null || true
        if ! wait_pid_gone "$pid" 20; then
          kill -KILL "$pid" 2>/dev/null || true
        fi
      fi
      rm -f "$PID_FILE"
      ;;
  esac

  # 兜底清理: 单元文件可能已删除, 但进程仍在运行.
  local leftover
  leftover="$(find_agent_pid || true)"
  if [[ -n "$leftover" ]]; then
    warn "仍有 monix-agent 进程存活, 强制终止"
    kill -TERM "$leftover" 2>/dev/null || true
    if ! wait_pid_gone "$leftover" 15; then
      kill -KILL "$leftover" 2>/dev/null || true
    fi
  fi
}

# 无 init 系统时后台启动.
start_agent_daemon() {
  mkdir -p "$DATA_DIR"
  chown_dir "$DATA_DIR"
  touch "$LOG_FILE" "$PID_FILE"

  # setsid 让进程脱离当前会话, 避免退出 shell 时被带走 (容器内常见).
  # 不能依赖 $! 推导 PID: setsid 会再 fork 一层, $! 指向的既不是 su 也不是 agent.
  local launcher=()
  if command -v setsid >/dev/null 2>&1; then
    launcher=(setsid)
  fi

  local start_cmd="set -a; . '$CONFIG_FILE'; set +a; exec '$BIN_PATH'"
  if [[ "$SERVICE_USER" == "root" ]]; then
    "${launcher[@]}" sh -c "$start_cmd" >>"$LOG_FILE" 2>&1 &
  else
    "${launcher[@]}" su -s /bin/sh "$SERVICE_USER" -c "$start_cmd" >>"$LOG_FILE" 2>&1 &
  fi
  local launched=$!

  local pid=""
  local i=0
  while [[ $i -lt 40 ]]; do
    # 优先取 su 的直接子进程.
    if command -v pgrep >/dev/null 2>&1; then
      pid="$(pgrep -P "$launched" 2>/dev/null | head -n 1 || true)"
    fi
    if [[ -z "$pid" ]]; then
      pid="$(find_agent_pid || true)"
    fi
    if [[ -n "$pid" ]]; then
      break
    fi
    sleep 0.2
    i=$((i + 1))
  done

  if [[ -z "$pid" ]]; then
    warn "未能定位 agent 进程, PID 文件将使用启动器 PID"
    pid="$launched"
  fi
  echo "$pid" > "$PID_FILE"
}

# ---------- 服务单元生成 ----------

write_service_unit() {
  local init="$1"
  case "$init" in
    systemd)
      cat > "$SYSTEMD_FILE" <<EOF
[Unit]
Description=Monix Agent
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${CONFIG_FILE}
ExecStart=${BIN_PATH}
Restart=always
RestartSec=5s

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
      systemctl daemon-reload
      systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
      systemctl restart "$SERVICE_NAME"
      ;;

    openrc)
      cat > "$INITD_FILE" <<EOF
#!/sbin/openrc-run
name="monix-agent"
description="Monix Agent"
command="${BIN_PATH}"
command_user="${SERVICE_USER}:${SERVICE_USER}"
command_background=true
pidfile="/run/${SERVICE_NAME}.pid"
output_log="${LOG_FILE}"
error_log="${LOG_FILE}"

depend() {
    need net
    after firewall
}

start_pre() {
    checkpath --directory --owner ${SERVICE_USER}:${SERVICE_USER} ${DATA_DIR}
}
EOF
      chmod 0755 "$INITD_FILE"
      rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
      rc-service "$SERVICE_NAME" restart >/dev/null 2>&1 || true
      ;;

    sysv)
      cat > "$INITD_FILE" <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          ${SERVICE_NAME}
# Required-Start:    \$network \$remote_fs
# Required-Stop:     \$network \$remote_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Monix Agent
### END INIT INFO

PIDFILE=/var/run/${SERVICE_NAME}.pid
DAEMON=${BIN_PATH}
CONFIG=${CONFIG_FILE}
RUN_USER=${SERVICE_USER}
LOG=${LOG_FILE}

start() {
    echo "Starting ${SERVICE_NAME}..."
    mkdir -p ${DATA_DIR}
    chown \$RUN_USER:\$RUN_USER ${DATA_DIR} 2>/dev/null || true
    if [ "\$RUN_USER" = "root" ]; then
        ( set -a; . \$CONFIG; set +a; exec \$DAEMON ) >>\$LOG 2>&1 &
    else
        su -s /bin/sh \$RUN_USER -c "set -a; . \$CONFIG; set +a; exec \$DAEMON" >>\$LOG 2>&1 &
    fi
    echo \$! > \$PIDFILE
}

stop() {
    echo "Stopping ${SERVICE_NAME}..."
    if [ -f \$PIDFILE ]; then
        kill -TERM \$(cat \$PIDFILE) 2>/dev/null
        rm -f \$PIDFILE
    fi
}

case "\$1" in
    start) start ;;
    stop) stop ;;
    restart) stop; sleep 1; start ;;
    status)
        if [ -f \$PIDFILE ] && kill -0 \$(cat \$PIDFILE) 2>/dev/null; then
            echo running; exit 0
        fi
        echo stopped; exit 3
        ;;
    *) echo "Usage: \$0 {start|stop|restart|status}"; exit 1 ;;
esac
EOF
      chmod 0755 "$INITD_FILE"
      if command -v update-rc.d >/dev/null 2>&1; then
        update-rc.d "$SERVICE_NAME" defaults >/dev/null 2>&1 || true
      elif command -v chkconfig >/dev/null 2>&1; then
        chkconfig --add "$SERVICE_NAME" >/dev/null 2>&1 || true
      fi
      "$INITD_FILE" restart >/dev/null 2>&1 || true
      ;;

    none)
      log "ℹ️  未检测到 init 系统, 使用后台进程方式运行"
      start_agent_daemon
      ;;
  esac
}

check_running() {
  local init="$1"
  case "$init" in
    systemd) systemctl is-active --quiet "$SERVICE_NAME" ;;
    openrc) rc-service "$SERVICE_NAME" status >/dev/null 2>&1 ;;
    sysv) "$INITD_FILE" status >/dev/null 2>&1 ;;
    none)
      local pid
      pid="$(read_pid)" && pid_alive "$pid"
      ;;
  esac
}

service_hint() {
  local init="$1"
  case "$init" in
    systemd)
      log "   服务:       systemctl status $SERVICE_NAME"
      log "   日志:       journalctl -u $SERVICE_NAME -f"
      ;;
    openrc)
      log "   服务:       rc-service $SERVICE_NAME status"
      log "   日志:       tail -f $LOG_FILE"
      ;;
    sysv)
      log "   服务:       $INITD_FILE status"
      log "   日志:       tail -f $LOG_FILE"
      ;;
    none)
      log "   进程:       PID 文件 $PID_FILE"
      log "   日志:       tail -f $LOG_FILE"
      log "   停止:       kill \$(cat $PID_FILE)"
      ;;
  esac
}

# ---------- 卸载 ----------

uninstall_agent() {
  require_root

  local init
  init="$(detect_init)"

  # 先停止: 单元文件可能已丢失, 但进程仍在运行.
  stop_agent "$init"

  if [[ -f "$SYSTEMD_FILE" ]]; then
    log "🗑️  删除 systemd 单元"
    rm -f "$SYSTEMD_FILE"
    systemctl daemon-reload 2>/dev/null || true
  fi
  if [[ -f "$INITD_FILE" ]]; then
    log "🗑️  删除 init 脚本"
    rm -f "$INITD_FILE"
  fi

  if [[ -f "$BIN_PATH" ]]; then
    log "🗑️  删除程序 $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi

  log "✅ 已卸载 Agent"
  log "   配置保留: $CONFIG_FILE"
  log "   数据保留: $DATA_DIR"
  log "   如需删除, 手动执行: rm -rf $CONFIG_DIR $DATA_DIR"
}

# ---------- 安装 ----------

install_agent() {
  # 先校验参数, 再检查权限: 让普通用户先看到用法错误而不是权限错误.
  [[ -n "$SERVER_URL" ]] || die "缺少 --server-url"
  [[ -n "$TOKEN" ]] || die "缺少 --token"

  require_root

  local init
  init="$(detect_init)"
  log "🔧 服务管理方式: $init"

  # Linux 统一使用 musl 静态包: 同一份产物可在 glibc 与 musl 发行版运行.
  local platform
  platform="$(detect_platform)"
  log "🔧 目标平台: $platform"

  local asset="monix-agent-${platform}.tar.gz"
  local base_url="https://github.com/${REPO}/releases/latest/download"
  local download_url="${base_url}/${asset}"
  local checksum_url="${download_url}.sha256"

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  log "📥 下载 $asset"
  if ! download "$download_url" "$tmp_dir/$asset"; then
    die "下载失败: $download_url"
  fi

  # 校验完整性. 校验和文件不可用时仅告警, 因为发布流程可能尚未产出该文件.
  if download "$checksum_url" "$tmp_dir/$asset.sha256" 2>/dev/null; then
    local expected
    expected="$(awk '{print $1; exit}' "$tmp_dir/$asset.sha256")"
    log "🔐 校验 SHA-256"
    verify_sha256 "$tmp_dir/$asset" "$expected" \
      || die "SHA-256 校验失败, 安装包可能已损坏或被篡改"
    log "   ✅ 校验通过"
  else
    warn "未找到校验和文件, 跳过完整性校验"
  fi

  log "📦 解压"
  command -v tar >/dev/null 2>&1 || die "缺少依赖命令: tar"
  tar -xzf "$tmp_dir/$asset" -C "$tmp_dir"
  local extracted
  extracted="$(find "$tmp_dir" -maxdepth 2 -type f -name 'monix-agent' | head -n 1)"
  [[ -n "$extracted" ]] || die "安装包内未找到 monix-agent"

  create_service_user

  log "📁 安装到 $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$extracted" "$BIN_PATH" 2>/dev/null || {
    cp "$extracted" "$BIN_PATH"
    chmod 0755 "$BIN_PATH"
  }

  log "📁 创建配置与数据目录"
  mkdir -p "$CONFIG_DIR" "$DATA_DIR"
  chmod 0750 "$CONFIG_DIR" "$DATA_DIR" 2>/dev/null || true
  chown_dir "$CONFIG_DIR"
  chown_dir "$DATA_DIR"

  # 写配置. 令牌敏感, 权限收紧到 0640.
  log "📝 写入配置 $CONFIG_FILE"
  umask 077
  {
    echo "MONIX_SERVER_URL=${SERVER_URL}"
    echo "MONIX_AGENT_TOKEN=${TOKEN}"
  } > "$CONFIG_FILE"
  chown "root:$SERVICE_USER" "$CONFIG_FILE" 2>/dev/null || true
  chmod 0640 "$CONFIG_FILE"

  log "⚙️  配置启动方式"
  write_service_unit "$init"

  log ""
  log "⏳ 等待 Agent 启动..."
  sleep 2

  if check_running "$init"; then
    log "✅ Monix Agent 已安装并运行"
    log "   可执行文件: $BIN_PATH"
    log "   配置:       $CONFIG_FILE"
    service_hint "$init"
  else
    warn "Agent 未能启动, 请检查日志:"
    if [[ -f "$LOG_FILE" ]]; then
      tail -n 20 "$LOG_FILE" || true
    else
      journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true
    fi
    exit 1
  fi
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_agent
else
  install_agent
fi
