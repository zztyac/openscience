#!/bin/bash
set -euo pipefail

materials_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$materials_root"

materials_bun="$(command -v bun || true)"
if [[ -z "$materials_bun" && -x "$HOME/.bun/bin/bun" ]]; then
  materials_bun="$HOME/.bun/bin/bun"
fi
if [[ -z "$materials_bun" ]]; then
  printf '%s\n' '未找到 Bun。请先安装 package.json 中指定的 Bun 版本，再运行此脚本。' >&2
  exit 1
fi

if [[ ! -f backend/cli/src/web/assets.generated.ts ]]; then
  printf '%s\n' '网页资源尚未生成。请在项目目录先运行：bun run setup --web' >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:4106 -sTCP:LISTEN >/dev/null 2>&1; then
  printf '%s\n' '端口 4106 已有程序监听，未启动新服务。'
  printf '%s\n' '如果这是已经运行的材料工作台，请访问：http://127.0.0.1:4106/'
  printf '%s\n' '如果是其他程序，请先确认端口用途；本脚本不会停止现有程序。'
  exit 0
fi

printf '%s\n' '材料科研工作台：http://127.0.0.1:4106/'
printf '%s\n' '模型沿用现有 OpenScience 全局配置。此终端需保持打开；按 Ctrl+C 正常停止。'
# This Mac's TUN proxy returns synthetic DNS addresses. AliDNS is reachable on
# this network and keeps public-address validation enabled; callers can override it.
export OPENSCIENCE_DNS_RESOLVER="${OPENSCIENCE_DNS_RESOLVER:-alidns}"
exec "$materials_bun" --no-env-file run --cwd backend/cli --conditions=browser src/index.ts serve --port 4106
