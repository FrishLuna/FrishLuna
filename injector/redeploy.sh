#!/usr/bin/env bash
# FrishLuna / injector / redeploy.sh
# 换 dll -> 重启 QQ -> 重新注入 -> 确认管道。改 C 代码后一条命令走完。
# 用法： ./redeploy.sh [dll文件]   默认 payload/frishluna-payload.dll
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DLL="${1:-$ROOT/payload/frishluna-payload.dll}"
TARGET="$ROOT/payload/frishluna-payload.dll"

echo "[1/5] 关闭 QQ"
MSYS_NO_PATHCONV=1 taskkill /IM QQ.exe /F >/dev/null 2>&1
for i in $(seq 1 20); do
  n=$(MSYS_NO_PATHCONV=1 tasklist /FI "IMAGENAME eq QQ.exe" /NH 2>/dev/null | grep -c "QQ.exe")
  [ "$n" = "0" ] && break
  sleep 0.5
done

echo "[2/5] 换 dll  $(basename "$DLL")"
cp -f "$DLL" "$TARGET" || { echo "覆盖 dll 失败（QQ 还在占用？）"; exit 1; }

echo "[3/5] 启动 QQ"
cmd //c start "" "${FL_QQ_EXE:-C:\\Program Files\\Tencent\\QQNT\\QQ.exe}"
sleep 20

echo "[4/5] 注入"
cd "$HERE" && python inject.py 2>&1 | tail -6

echo "[5/5] debug 日志尾部"
tail -8 "$ROOT/payload/frishluna-debug.log"
