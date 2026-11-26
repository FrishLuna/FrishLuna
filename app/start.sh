#!/usr/bin/env bash
# FrishLuna 面板 · Linux 前台启动（Ctrl+C 退出）。首次运行会把初始令牌印在这里。
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node。先装 Node.js 22 或更高版本（面板用到内置 node:sqlite）" >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then
  echo "Node 版本过低：当前 $(node -v)，需要 22 或更高（内置 node:sqlite）" >&2
  exit 1
fi

exec node server/index.js
