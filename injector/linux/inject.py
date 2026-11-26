#!/usr/bin/env python3
"""把 .so 注入一个正在运行的 Linux 进程（ptrace 远程 dlopen）。

为什么要停住整个线程组：ptrace 只能改自己 attach 的那个线程。Electron/QQ 是
多线程的，只停一个线程就往共享代码里写 int3，别的线程跑过来会撞上断点直接崩。
所以这里先 attach 该进程的全部线程，全部停下再动手。

用法：
  python3 inject.py --pid 1234 --lib payload/libfrishluna-payload.so
  python3 inject.py --lib ... --dry-run
"""
import argparse
import ctypes
import os
import sys
import time

libc = ctypes.CDLL("libc.so.6", use_errno=True)

PTRACE_ATTACH = 16
PTRACE_DETACH = 17
PTRACE_CONT = 7
PTRACE_GETREGS = 12
PTRACE_SETREGS = 13
PTRACE_PEEKDATA = 2
PTRACE_POKEDATA = 5
WALL = 0x40000000

RTLD_NOW = 2


class UserRegs(ctypes.Structure):
    """x86-64 的 struct user_regs_struct（顺序与内核一致）"""
    _fields_ = [(n, ctypes.c_ulonglong) for n in (
        "r15 r14 r13 r12 rbp rbx r11 r10 r9 r8 rax rcx rdx rsi rdi orig_rax "
        "rip cs eflags rsp ss fs_base gs_base ds es fs gs").split()]


def err(msg):
    e = ctypes.get_errno()
    return f"{msg}（errno={e}: {os.strerror(e)}）" if e else msg


# 返回值必须是 long：PEEKDATA 读回来的是内存内容，按 int 截断会把合法数据变成 -1
libc.ptrace.restype = ctypes.c_long
libc.ptrace.argtypes = [ctypes.c_ulong, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]


def ptrace(req, pid, addr=0, data=0):
    ctypes.set_errno(0)
    r = libc.ptrace(req, pid, addr, data)
    if r == -1:
        e = ctypes.get_errno()
        # PEEKDATA 的 -1 可能是真实数据（全 0xFF 的字），只有 errno 非零才是失败
        if req != PTRACE_PEEKDATA or e != 0:
            raise OSError(e, f"ptrace({req}) pid={pid}")
    return r


def list_threads(pid):
    try:
        return sorted(int(t) for t in os.listdir(f"/proc/{pid}/task"))
    except OSError:
        return []


def wait_stop(tid, timeout=5.0):
    """等某个线程停住，返回 (status, 信号)"""
    end = time.time() + timeout
    while time.time() < end:
        wpid, status = os.waitpid(tid, WALL | os.WNOHANG)
        if wpid == tid:
            return status
        time.sleep(0.005)
    return None


def parse_maps(pid):
    """返回 [(start, end, perms, path)]"""
    out = []
    with open(f"/proc/{pid}/maps", "r") as f:
        for line in f:
            parts = line.split()
            if len(parts) < 5:
                continue
            rng, perms = parts[0], parts[1]
            path = parts[-1] if parts[-1].startswith("/") else ""
            lo, hi = (int(x, 16) for x in rng.split("-"))
            out.append((lo, hi, perms, path))
    return out


def find_libc(pid):
    """目标进程里 libc 的 (基址, 路径)"""
    for lo, hi, perms, path in parse_maps(pid):
        if "libc.so" in path or "libc-2" in path:
            if "x" in perms:
                continue
            return lo, path
    return 0, ""


def our_dlopen_offset(libc_path):
    """本进程里 dlopen 相对 libc 基址的偏移（同一台机器、同一个 libc 才成立）"""
    self_maps = parse_maps(os.getpid())
    base = 0
    for lo, hi, perms, path in self_maps:
        if path == libc_path and "x" not in perms:
            base = lo
            break
    if not base:
        return 0
    addr = ctypes.cast(libc.dlopen, ctypes.c_void_p).value
    return addr - base


def stack_room(pid, rsp):
    """rsp 往下 4KB 是否都在同一个可写栈映射里"""
    for lo, hi, perms, _ in parse_maps(pid):
        if lo <= rsp - 0x1000 and rsp <= hi:
            return "w" in perms
    return False


def inject(pid, so_path):
    so_path = os.path.abspath(so_path)
    if not os.path.isfile(so_path):
        raise FileNotFoundError(so_path)

    libc_base, libc_path = find_libc(pid)
    if not libc_base:
        raise RuntimeError("目标进程里找不到 libc")
    off = our_dlopen_offset(libc_path)
    if not off:
        raise RuntimeError("拿不到本机 dlopen 偏移（libc 与目标不一致？）")
    remote_dlopen = libc_base + off
    print(f"[ok] libc         {libc_path} @ 0x{libc_base:x}")
    print(f"[ok] remote dlopen 0x{remote_dlopen:x}")

    tids = list_threads(pid)
    if not tids:
        raise RuntimeError("读不到线程列表")
    if pid not in tids:
        raise RuntimeError("主线程不在线程列表里")

    attached = []
    try:
        for tid in tids:
            ptrace(PTRACE_ATTACH, tid)
            st = wait_stop(tid)
            if st is None:
                print(f"[!!] 线程 {tid} 没能停下来，放弃")
                raise RuntimeError("attach 超时")
            attached.append(tid)
        print(f"[ok] 已停住 {len(attached)} 个线程")

        regs = UserRegs()
        ptrace(PTRACE_GETREGS, pid, 0, ctypes.addressof(regs))
        print(f"[ok] rip=0x{regs.rip:x} rsp=0x{regs.rsp:x}")

        if not stack_room(pid, regs.rsp):
            raise RuntimeError("栈顶空间不足，换个时机再试")

        path_addr = regs.rsp - 0x800
        raw = so_path.encode() + b"\0"
        for i in range(0, len(raw), 8):
            chunk = raw[i:i + 8].ljust(8, b"\0")
            ptrace(PTRACE_POKEDATA, pid, path_addr + i,
                   int.from_bytes(chunk, "little"))
        print(f"[ok] 路径已写入 0x{path_addr:x}")

        orig_code = ptrace(PTRACE_PEEKDATA, pid, regs.rip, 0) & 0xFF
        ptrace(PTRACE_POKEDATA, pid, regs.rip,
               (ptrace(PTRACE_PEEKDATA, pid, regs.rip, 0) & ~0xFF) | 0xCC)

        saved = UserRegs()
        ctypes.memmove(ctypes.addressof(saved), ctypes.addressof(regs),
                       ctypes.sizeof(UserRegs))

        ret_slot = regs.rsp - 8
        ptrace(PTRACE_POKEDATA, pid, ret_slot, regs.rip)
        regs.rsp = ret_slot
        regs.rip = remote_dlopen
        regs.rdi = path_addr
        regs.rsi = RTLD_NOW
        regs.rax = 0
        ptrace(PTRACE_SETREGS, pid, 0, ctypes.addressof(regs))

        ptrace(PTRACE_CONT, pid, 0, 0)
        st = wait_stop(pid, timeout=10.0)
        if st is None:
            raise RuntimeError("dlopen 没返回（目标可能卡住）")

        # 恢复被覆盖的字节
        cur = ptrace(PTRACE_PEEKDATA, pid, saved.rip, 0)
        ptrace(PTRACE_POKEDATA, pid, saved.rip, (cur & ~0xFF) | orig_code)

        now = UserRegs()
        ptrace(PTRACE_GETREGS, pid, 0, ctypes.addressof(now))
        if now.rip not in (saved.rip, saved.rip + 1):   # int3 执行后 RIP 自然 +1，属正常
            print(f"[!!] 返回位置异常 rip=0x{now.rip:x}（期望 0x{saved.rip:x}）")
        ptrace(PTRACE_SETREGS, pid, 0, ctypes.addressof(saved))
        print("[ok] 现场已恢复")
    finally:
        for tid in attached:
            try:
                ptrace(PTRACE_DETACH, tid, 0, 0)
            except OSError:
                pass

    time.sleep(0.3)
    hit = [p for _, _, _, p in parse_maps(pid) if so_path in p]
    if hit:
        print(f"[ok] 已加载 {hit[0]}")
        return True
    print("[!!] 目标里没看到这个 .so，dlopen 可能失败了（看目标进程的 stderr）")
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, default=0)
    ap.add_argument("--lib", "--dll", dest="lib", default="")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if not a.lib:
        here = os.path.dirname(os.path.abspath(__file__))
        a.lib = os.path.join(here, "..", "..", "payload", "libfrishluna-payload.so")
    a.lib = os.path.abspath(a.lib)

    pid = a.pid
    if not pid:
        print("[!!] 需要 --pid（Linux 版不自动找进程：面板会传过来）")
        return 1
    if not os.path.isdir(f"/proc/{pid}"):
        print(f"[!!] 进程 {pid} 不存在")
        return 1

    print(f"目标 PID = {pid}")
    print(f"载荷     = {a.lib}")
    if a.dry_run:
        libc_base, libc_path = find_libc(pid)
        print(f"(--dry-run) libc={libc_path} base=0x{libc_base:x} 线程数={len(list_threads(pid))}")
        return 0
    try:
        ok = inject(pid, a.lib)
    except Exception as e:                      # noqa: BLE001
        print(f"[!!] 注入失败：{e}")
        return 2
    return 0 if ok else 3


if __name__ == "__main__":
    sys.exit(main())
