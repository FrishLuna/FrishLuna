#!/usr/bin/env bash
# 停止后台运行的面板（读 app/data/panel.pid，先 TERM 再 KILL）
set -u
cd "$(dirname "$0")"

PID_FILE="data/panel.pid"
if [ ! -f "$PID_FILE" ]; then
  echo "没找到 $PID_FILE：面板可能不是从这里启动的"
  exit 1
fi

pid="$(cat "$PID_FILE" 2>/dev/null | tr -dc '0-9')"
if [ -z "$pid" ]; then
  echo "pid 文件是空的，删掉重来：rm -f $PID_FILE"
  exit 1
fi

if ! kill -0 "$pid" 2>/dev/null; then
  echo "进程 $pid 已经不在了，清理 pid 文件"
  rm -f "$PID_FILE" data/panel.port
  exit 0
fi

kill "$pid" 2>/dev/null
for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || { rm -f "$PID_FILE"; echo "已停止（$pid）"; exit 0; }
  sleep 0.15
done
kill -9 "$pid" 2>/dev/null
rm -f "$PID_FILE"
echo "已强制停止（$pid）"
