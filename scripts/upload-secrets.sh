#!/bin/bash

# 上传 env 文件中的变量到 Cloudflare Workers Secrets
# 使用方法:
#   ./scripts/upload-secrets.sh
#   ./scripts/upload-secrets.sh --env-file .dev.vars
#   ./scripts/upload-secrets.sh --env-file .env.prod

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# 默认 env 文件路径 (相对项目根)
ENV_FILE=".env"

# 解析命令行参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "使用方法: $0 [选项]"
      echo ""
      echo "选项:"
      echo "  --env-file FILE    指定 env 文件路径 (默认: .env, 相对项目根)"
      echo "  -h, --help         显示此帮助信息"
      echo ""
      echo "示例:"
      echo "  $0                         # 使用 .env"
      echo "  $0 --env-file .dev.vars    # 使用 .dev.vars"
      echo "  $0 --env-file .env.prod    # 使用生产 env"
      echo ""
      echo "常见密钥 (见 .dev.vars.example):"
      echo "  SESSION_SECRET"
      exit 0
      ;;
    *)
      echo "未知参数: $1"
      echo "使用 -h 或 --help 查看帮助信息"
      exit 1
      ;;
  esac
done

# 相对路径基于项目根解析
if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$ROOT_DIR/$ENV_FILE"
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ 错误: 文件 '$ENV_FILE' 不存在"
  exit 1
fi

if [ ! -f "$ROOT_DIR/wrangler.toml" ]; then
  echo "❌ 错误: 未找到 wrangler.toml (项目根: $ROOT_DIR)"
  exit 1
fi

if ! command -v npx &> /dev/null; then
  echo "❌ 错误: npx 未安装"
  exit 1
fi

echo "📦 开始上传 secrets 到 Cloudflare Workers..."
echo "📁 项目根: $ROOT_DIR"
echo "📄 使用文件: $ENV_FILE"
echo ""

TOTAL=0
SUCCESS=0
SKIPPED=0
FAILED=0

while IFS= read -r line || [ -n "$line" ]; do
  # 跳过空行和注释行
  if [[ -z "$line" ]] || [[ "$line" =~ ^[[:space:]]*# ]]; then
    continue
  fi

  # 解析 KEY=VALUE
  if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
    KEY="${BASH_REMATCH[1]}"
    VALUE="${BASH_REMATCH[2]}"

    # 移除值两端引号
    VALUE="${VALUE#\"}"
    VALUE="${VALUE%\"}"
    VALUE="${VALUE#\'}"
    VALUE="${VALUE%\'}"

    TOTAL=$((TOTAL + 1))

    if [[ -z "$VALUE" ]]; then
      echo "⏭️  跳过空值: $KEY"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    echo "📤 上传: $KEY"
    if printf '%s' "$VALUE" | npx wrangler secret put "$KEY" 2>&1 | grep -q "Success"; then
      echo "   ✅ 成功"
      SUCCESS=$((SUCCESS + 1))
    else
      echo "   ❌ 失败"
      FAILED=$((FAILED + 1))
    fi
    echo ""
  fi
done < "$ENV_FILE"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 上传完成统计:"
echo "   总计: $TOTAL"
echo "   成功: $SUCCESS"
echo "   跳过: $SKIPPED"
echo "   失败: $FAILED"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "⚠️  部分 secrets 上传失败, 请检查错误信息"
  exit 1
fi

if [ "$SUCCESS" -eq 0 ]; then
  echo ""
  echo "⚠️  没有成功上传任何 secret"
  exit 1
fi

echo ""
echo "🎉 所有 secrets 上传成功!"
