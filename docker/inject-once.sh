#!/bin/sh
# 迟注入器：由 supervisor（program:inject，root）常驻巡检，逐个给未注入的 QQ 主进程注入载荷。
#
# 为什么不用 LD_PRELOAD：QQ(NT) 在启动极早期被注入载荷，初始化阶段会 SIGTRAP 崩溃；
# 为什么不能看到进程就注：QQ 刚启动就 ptrace 远端 dlopen 会撞上加载器锁，
#   远端调用永远不返回（目标线程停在 futex），注入器只能超时放弃。
# 且登录窗还开着时注入会破坏消息服务初始化（登录后 pipe 反复断连，无法恢复），
# 所以必须等登录窗关闭（登录完成）后再注入。
# 因此：新主进程先等 15s；登录窗存在则继续等；注入失败冷却 20s。
set -u

FL_HOME="${FL_HOME:-/opt/frishluna}"
RUNTIME="${FL_RUNTIME_DIR:-/tmp/frishluna}"
LIB="$FL_HOME/payload/libfrishluna-payload.so"
INJECTOR="$FL_HOME/injector/linux/inject.py"
LOG="$RUNTIME/inject.log"
SEEN="$RUNTIME/inject_seen.pids"
export DISPLAY="${DISPLAY:-:1}"

mkdir -p "$RUNTIME" 2>/dev/null || true
: > "$LOG" 2>/dev/null || true
: > "$SEEN" 2>/dev/null || true

log() { echo "[inject-once $(date +%H:%M:%S)] $*" >> "$LOG" 2>/dev/null || true; }

# 登录窗（680x440 的账密登录页）还在 = 登录没完成，此时注入会弄坏消息服务
login_window_up() {
  for id in $(xdotool search --onlyvisible --name '^QQ$' 2>/dev/null); do
    g=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null) || continue
    eval "$g"
    [ "${WIDTH:-0}" -ge 600 ] && [ "${HEIGHT:-0}" -ge 380 ] && return 0
  done
  return 1
}

while true; do
  for pid in $(pgrep -f '^/opt/QQ/qq .*--no-sandbox' 2>/dev/null); do
    # 子进程（--type=renderer/gpu/zygote）不注入
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    case "$cmd" in *--type=*) continue ;; esac
    # 已注入：记下 pid 即可
    if grep -q 'libfrishluna-payload.so' "/proc/$pid/maps" 2>/dev/null; then
      grep -q "^$pid$" "$SEEN" 2>/dev/null || echo "$pid" >> "$SEEN"
      continue
    fi
    # 上轮刚失败过：冷却
    grep -q "^$pid$" "$SEEN" 2>/dev/null && continue
    # 登录窗还开着：等登录完成再注（不记 SEEN，保持新鲜）
    if login_window_up; then
      log "login window up, defer pid=$pid"
      sleep 10
      continue
    fi
    # 新进程：先等它初始化完再动手
    if ! grep -q "w$pid" "$SEEN" 2>/dev/null; then
      echo "w$pid" >> "$SEEN"
      log "wait15 pid=$pid"
      sleep 15
      grep -q 'libfrishluna-payload.so' "/proc/$pid/maps" 2>/dev/null && continue
      login_window_up && continue
    fi
    log "inject pid=$pid"
    python3 "$INJECTOR" --pid "$pid" --lib "$LIB" >> "$LOG" 2>&1
    if grep -q 'libfrishluna-payload.so' "/proc/$pid/maps" 2>/dev/null; then
      echo "$pid" >> "$SEEN"
      log "ok pid=$pid"
    else
      log "fail pid=$pid, cooldown 20s"
      sleep 20
    fi
  done
  sleep 3
done
