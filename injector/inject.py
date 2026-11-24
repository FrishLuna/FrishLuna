import ctypes
from ctypes import wintypes as w
import subprocess, sys, os, time, argparse

k32 = ctypes.WinDLL('kernel32', use_last_error=True)

# ---- 正确的 64 位签名（写错会截断指针，务必声明）----
k32.OpenProcess.restype = w.HANDLE
k32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k32.CloseHandle.argtypes = [w.HANDLE]
k32.VirtualAllocEx.restype = w.LPVOID
k32.VirtualAllocEx.argtypes = [w.HANDLE, w.LPVOID, ctypes.c_size_t, w.DWORD, w.DWORD]
k32.VirtualFreeEx.argtypes = [w.HANDLE, w.LPVOID, ctypes.c_size_t, w.DWORD]
k32.WriteProcessMemory.restype = w.BOOL
k32.WriteProcessMemory.argtypes = [w.HANDLE, w.LPVOID, w.LPCVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.GetModuleHandleW.restype = w.HMODULE
k32.GetModuleHandleW.argtypes = [w.LPCWSTR]
k32.GetProcAddress.restype = w.LPVOID
k32.GetProcAddress.argtypes = [w.HMODULE, w.LPCSTR]
k32.CreateRemoteThread.restype = w.HANDLE
k32.CreateRemoteThread.argtypes = [w.HANDLE, w.LPVOID, ctypes.c_size_t, w.LPVOID, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD)]
k32.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k32.GetExitCodeThread.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]

PROCESS_ALL_ACCESS = 0x1F0FFF
MEM_COMMIT = 0x1000
MEM_RESERVE = 0x2000
MEM_RELEASE = 0x8000
PAGE_READWRITE = 0x04

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DLL = os.path.join(HERE, '..', 'payload', 'frishluna-payload.dll')


def find_main_pid():
    ps = ["powershell.exe", "-NoProfile", "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | "
          "Where-Object { $_.CommandLine -notmatch '--type=' } | "
          "Select-Object -ExpandProperty ProcessId"]
    out = subprocess.run(ps, capture_output=True, text=True).stdout.strip()
    return [int(x) for x in out.split() if x.strip().isdigit()]


def list_pipes(prefix=''):
    """列出当前存在的命名管道"""
    out = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                          "[System.IO.Directory]::GetFiles('\\\\.\\pipe\\')"],
                         capture_output=True, text=True).stdout
    return [p for p in out.splitlines() if prefix in p]


def inject(pid: int, dll_path: str, timeout_ms=15000):
    dll_path = os.path.abspath(dll_path)
    if not os.path.isfile(dll_path):
        raise FileNotFoundError(dll_path)

    h = k32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not h:
        raise OSError(ctypes.get_last_error(), 'OpenProcess 失败')
    print(f'[ok] OpenProcess        handle=0x{h:X}')

    try:
        buf = (dll_path + '\x00').encode('utf-16-le')
        size = len(buf)
        addr = k32.VirtualAllocEx(h, None, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
        if not addr:
            raise OSError(ctypes.get_last_error(), 'VirtualAllocEx 失败')
        print(f'[ok] VirtualAllocEx     remote=0x{addr:X} ({size}B)')

        written = ctypes.c_size_t(0)
        if not k32.WriteProcessMemory(h, addr, buf, size, ctypes.byref(written)):
            raise OSError(ctypes.get_last_error(), 'WriteProcessMemory 失败')
        print(f'[ok] WriteProcessMemory wrote={written.value}')

        hmod = k32.GetModuleHandleW('kernel32.dll')
        fn = k32.GetProcAddress(hmod, b'LoadLibraryW')
        if not fn:
            raise OSError(ctypes.get_last_error(), 'GetProcAddress(LoadLibraryW) 失败')
        print(f'[ok] LoadLibraryW       0x{fn:X}')

        tid = w.DWORD(0)
        th = k32.CreateRemoteThread(h, None, 0, fn, addr, 0, ctypes.byref(tid))
        if not th:
            raise OSError(ctypes.get_last_error(), 'CreateRemoteThread 失败')
        print(f'[ok] CreateRemoteThread tid={tid.value}')

        k32.WaitForSingleObject(th, timeout_ms)
        code = w.DWORD(0)
        k32.GetExitCodeThread(th, ctypes.byref(code))
        k32.CloseHandle(th)
        k32.VirtualFreeEx(h, addr, 0, MEM_RELEASE)
        print(f'[ok] 线程退出码 = 0x{code.value:X}  (非 0 表示模块已加载)')
        if code.value == 0:
            print('[!!] 退出码 0：LoadLibrary 返回 NULL，dll 加载失败')
        return code.value
    finally:
        k32.CloseHandle(h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pid', type=int, default=0)
    ap.add_argument('--dll', default=DEFAULT_DLL)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    pid = a.pid or (find_main_pid() or [None])[0]
    if not pid:
        print('[!!] 没找到 QQ 主进程'); return 1
    print(f'目标 PID   = {pid}')
    print(f'载荷 dll   = {os.path.abspath(a.dll)}')
    pre = list_pipes('frishluna.')
    print(f'注入前管道 = {pre or "(无 frishluna 管道)"}')

    if a.dry_run:
        print('(--dry-run，不执行注入)')
        return 0

    code = inject(pid, a.dll)
    print('\n等待 4 秒后检查管道…')
    for _ in range(8):
        time.sleep(0.5)
        pipes = list_pipes('frishluna.')
        if pipes:
            break
    print(f'注入后管道 = {pipes or "(无)"}')
    return 0 if pipes else 2


if __name__ == '__main__':
    sys.exit(main())
