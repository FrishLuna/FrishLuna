#!/usr/bin/env bash
# 容器入口：起虚拟桌面（Xvfb + VNC + noVNC）后交给 supervisor 管 QQ 与面板
set -euo pipefail

: "${VNC_PASSWD:=vncpasswd}"
: "${FL_UID:=1000}"
: "${FL_GID:=1000}"
: "${FL_HOME:=/opt/frishluna}"
: "${FL_RUNTIME_DIR:=/tmp/frishluna}"
: "${SCREEN:=1920x1080x16}"

export DISPLAY="${DISPLAY:-:1}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-${FL_UID}}"
export FL_RUNTIME_DIR

DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM%%.*}"

chmod 1777 /tmp || true
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix || true
rm -f /run/dbus/pid "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"

mkdir -p /var/run/dbus /root/.vnc "${XDG_RUNTIME_DIR}" /app/.cache /app/.config /app/.local/share

groupmod -o -g "${FL_GID}" frishluna
usermod -o -u "${FL_UID}" -g "${FL_GID}" frishluna
chown -R "${FL_UID}:${FL_GID}" /app /opt/frishluna "${XDG_RUNTIME_DIR}" "${FL_RUNTIME_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}"

# 容器重启后可能残留失效的 socket 节点，先清掉避免误判
find "${FL_RUNTIME_DIR}" -maxdepth 1 -type s -name 'frishluna-*.sock' -delete 2>/dev/null || true
# 主进程占位锁也要清：容器重启后 pid 会被复用（旧 pid 落到别的进程上），
# 留着会让新启动的 QQ 误判「主进程还在」而主动让位，一个 socket 都不建
rm -f "${FL_RUNTIME_DIR}/frishluna-owner.pid"

x11vnc -storepasswd "${VNC_PASSWD}" /root/.vnc/passwd >/dev/null

wait_for_xvfb() {
  local socket="/tmp/.X11-unix/X${DISPLAY_NUM}"
  for _ in $(seq 1 200); do
    [ -S "${socket}" ] && return 0
    kill -0 "${XVFB_PID}" 2>/dev/null || { echo "Xvfb 提前退出" >&2; return 1; }
    sleep 0.1
  done
  echo "等待显示 ${DISPLAY} 超时" >&2
  return 1
}

dbus-daemon --config-file=/usr/share/dbus-1/system.conf --print-address &
Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" +extension GLX +render -noreset &
XVFB_PID=$!
wait_for_xvfb

fluxbox &
x11vnc -display "${DISPLAY}" -noxrecord -noxfixes -noxdamage -forever -rfbauth /root/.vnc/passwd &
X11VNC_PID=$!
sleep 0.5
kill -0 "${X11VNC_PID}" 2>/dev/null || { echo "x11vnc 启动失败" >&2; exit 1; }

nohup /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 6081 --file-only >/var/log/novnc.log 2>&1 &

exec supervisord -c /etc/supervisord.conf
