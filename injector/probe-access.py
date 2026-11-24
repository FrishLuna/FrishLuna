import ctypes
from ctypes import wintypes as w
import subprocess, sys, json

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = w.HANDLE
k32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k32.CloseHandle.argtypes = [w.HANDLE]
k32.ReadProcessMemory.restype = w.BOOL
k32.ReadProcessMemory.argtypes = [w.HANDLE, w.LPCVOID, w.LPVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]

ACCESS = {
    'PROCESS_QUERY_LIMITED_INFORMATION': 0x1000,
    'PROCESS_QUERY_INFORMATION': 0x0400,
    'PROCESS_VM_READ': 0x0010,
    'PROCESS_VM_WRITE': 0x0020,
    'PROCESS_VM_OPERATION': 0x0008,
    'PROCESS_CREATE_THREAD': 0x0002,
    'PROCESS_ALL_ACCESS': 0x1F0FFF,
}

def find_main_pid():
    ps = ["powershell.exe", "-NoProfile", "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | "
          "Where-Object { $_.CommandLine -notmatch '--type=' } | "
          "Select-Object -ExpandProperty ProcessId"]
    out = subprocess.run(ps, capture_output=True, text=True).stdout.strip()
    return [int(x) for x in out.split() if x.strip().isdigit()]

def is_admin():
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False

def main():
    pids = find_main_pid()
    if not pids:
        print('❌ 没有运行中的 QQ 主进程'); return 1
    pid = pids[0]
    print(f'QQ 主进程 PID = {pid}')
    print(f'当前进程是否管理员: {is_admin()}')

    results = {}
    for name, code in ACCESS.items():
        h = k32.OpenProcess(code, False, pid)
        err = ctypes.get_last_error()
        if h:
            results[name] = 'OK'
            # 顺手读 2 字节 PE 头验证读权限
            if name in ('PROCESS_VM_READ', 'PROCESS_ALL_ACCESS'):
                buf = ctypes.create_string_buffer(2)
                got = ctypes.c_size_t(0)
                ok = k32.ReadProcessMemory(h, ctypes.c_void_p(0x140000000), buf, 2, ctypes.byref(got))
                results[name] += f'  (ReadProcessMemory@ImageBase: {"ok " + buf.raw[:2].hex() if ok else "fail"} )'
            k32.CloseHandle(h)
        else:
            results[name] = f'FAIL err={err} ({ctypes.FormatError(err) if err else "?"})'

    print('\n=== OpenProcess 结果 ===')
    for k, v in results.items():
        mark = '✅' if v.startswith('OK') else '❌'
        print(f'{mark} {k:36s} {v}')

    ok_all = results.get('PROCESS_ALL_ACCESS', '').startswith('OK')
    print('\n结论:', '可以注入（完整权限）' if ok_all else '权限不足或被保护，需要提权/换手段')
    return 0 if ok_all else 1

if __name__ == '__main__':
    sys.exit(main())
