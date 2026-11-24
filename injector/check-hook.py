import ctypes, sys, re, os
from ctypes import wintypes as w

HERE = os.path.dirname(os.path.abspath(__file__))
DEBUG_LOG = os.path.join(os.path.dirname(HERE), 'payload', 'frishluna-debug.log')

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = w.HANDLE
k32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k32.ReadProcessMemory.argtypes = [w.HANDLE, w.LPVOID, w.LPVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [w.HANDLE]

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400


def pids():
    import subprocess
    ps = ["powershell.exe", "-NoProfile", "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | "
          "Where-Object { $_.CommandLine -notmatch '--type=' } | "
          "Select-Object -ExpandProperty ProcessId"]
    out = subprocess.run(ps, capture_output=True, text=True).stdout
    return [int(x) for x in out.split() if x.isdigit()]


def main():
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else (pids() or [0])[0]
    if not pid:
        print('无 QQ 主进程'); return 1
    h = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not h:
        print('OpenProcess 失败', ctypes.get_last_error()); return 1
    print('PID', pid)

    buf = ctypes.create_string_buffer(12)
    got = ctypes.c_size_t(0)
    # 从调试日志里读到的 target
    try:
        txt = open(DEBUG_LOG, encoding='utf-8', errors='ignore').read()
    except FileNotFoundError:
        print('日志不存在'); return 1
    m = re.search(r'\[hook\] installed target=([0-9A-Fa-f]+)', txt)
    if not m:
        print('日志里没有 target'); return 1
    addr = int(m.group(1), 16)
    print('target = 0x%X' % addr)

    if not k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, 12, ctypes.byref(got)):
        print('ReadProcessMemory 失败', ctypes.get_last_error()); return 1
    raw = bytes(buf.raw[:got.value])
    print('当前字节:', raw.hex(' '))
    if raw[:2] == b'\x48\xb8' and raw[10:12] == b'\xff\xe0':
        dst = int.from_bytes(raw[2:10], 'little')
        print('→ 已被我们的 detour 覆盖，跳转目标 0x%X' % dst)
    else:
        print('→ 不是 detour 头部（可能未打补丁或被还原）')
    k32.CloseHandle(h)
    return 0


if __name__ == '__main__':
    sys.exit(main())
