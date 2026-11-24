#!/usr/bin/env bash
# FrishLuna / injector / boot-inject.sh
# 关键时序：QQ 启动后立刻注入（此时主进程正在密集调用 napi，hook 更容易命中）。
# 用法： ./boot-inject.sh [额外QQ参数...]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LOG="$ROOT/payload/frishluna-debug.log"

echo "[1/4] 关闭 QQ"
MSYS_NO_PATHCONV=1 taskkill /IM QQ.exe /F >/dev/null 2>&1
for i in $(seq 1 24); do
  n=$(MSYS_NO_PATHCONV=1 tasklist /FI "IMAGENAME eq QQ.exe" /NH 2>/dev/null | grep -c "QQ.exe")
  [ "$n" = "0" ] && break
  sleep 0.5
done

echo "[2/4] 启动 QQ $*"
QQ_EXE="${FL_QQ_EXE:-C:\\Program Files\\Tencent\\QQNT\\QQ.exe}"
cmd //c start "" "$QQ_EXE" "$@"

echo "[3/4] 抢注入"
cd "$HERE"
for i in $(seq 1 12); do
  sleep 1
  out=$(python inject.py 2>&1)
  pid=$(printf '%s' "$out" | sed -n 's/^目标 PID *= *\([0-9]*\)/\1/p')
  [ -z "${pid:-}" ] && continue
  if printf '%s' "$out" | grep -q 'frishluna\.'; then
    echo "  注入 pid=$pid"
    sleep 1.5
    if tail -40 "$LOG" | grep -q 'env captured'; then
      echo "  [ok] hook 已命中，env 抓到"
      break
    else
      echo "  第 $i 轮未命中，重试"
    fi
  fi
done

echo "[4/4] 状态"
tail -6 "$LOG"
echo "主进程 pid=${pid:-?}"
