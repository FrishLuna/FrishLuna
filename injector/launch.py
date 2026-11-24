import ctypes
import os
import sys
import time
from ctypes import wintypes as w

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from inject import inject, list_pipes, DEFAULT_DLL  # noqa: E402

k32 = ctypes.WinDLL('kernel32', use_last_error=True)


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ('cb', w.DWORD), ('lpReserved', w.LPWSTR), ('lpDesktop', w.LPWSTR),
        ('lpTitle', w.LPWSTR), ('dwX', w.DWORD), ('dwY', w.DWORD),
        ('dwXSize', w.DWORD), ('dwYSize', w.DWORD),
        ('dwXCountChars', w.DWORD), ('dwYCountChars', w.DWORD),
        ('dwFillAttribute', w.DWORD), ('dwFlags', w.DWORD),
        ('wShowWindow', w.WORD), ('cbReserved2', w.WORD),
        ('lpReserved2', ctypes.POINTER(ctypes.c_byte)),
        ('hStdInput', w.HANDLE), ('hStdOutput', w.HANDLE), ('hStdError', w.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', w.HANDLE), ('hThread', w.HANDLE),
        ('dwProcessId', w.DWORD), ('dwThreadId', w.DWORD),
    ]


k32.CreateProcessW.restype = w.BOOL
k32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL,
                               w.DWORD, w.LPVOID, w.LPCWSTR,
                               ctypes.POINTER(STARTUPINFOW), ctypes.POINTER(PROCESS_INFORMATION)]
k32.ResumeThread.restype = w.DWORD
k32.ResumeThread.argtypes = [w.HANDLE]
k32.CloseHandle.argtypes = [w.HANDLE]

QQ = os.environ.get('FL_QQ_EXE') or r'C:\Program Files\Tencent\QQNT\QQ.exe'
CREATE_SUSPENDED = 0x00000004


def main():
    dll = DEFAULT_DLL
    extra = sys.argv[1:]
    cmd = '"%s"' % QQ
    for a in extra:
        cmd += (' "%s"' % a) if (' ' in a) else (' ' + a)
    cmdbuf = ctypes.create_unicode_buffer(cmd)

    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(si)
    pi = PROCESS_INFORMATION()

    ok = k32.CreateProcessW(QQ, cmdbuf, None, None, False, CREATE_SUSPENDED, None,
                            os.path.dirname(QQ), ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        print('[!!] CreateProcessW 失败 err=%d' % ctypes.get_last_error())
        return 1
    print('[ok] 挂起创建 QQ pid=%d（主线程尚未执行）' % pi.dwProcessId)

    time.sleep(0.25)
    try:
        inject(pi.dwProcessId, dll)
    except Exception as e:
        print('[!!] 注入失败: %s' % e)

    rc = k32.ResumeThread(pi.hThread)
    print('[ok] ResumeThread ->', rc, '(0xFFFFFFFF 表示失败)')
    k32.CloseHandle(pi.hThread)
    k32.CloseHandle(pi.hProcess)

    pid = pi.dwProcessId
    print('\n等待管道出现…')
    pipes = []
    for _ in range(30):
        time.sleep(0.5)
        pipes = list_pipes('frishluna.')
        if any(str(pid) in p for p in pipes):
            break
    print('管道 =', pipes or '(无)')
    print('FL_PID=%d' % pid)          # 机器可读，host 用它接管道
    print('\n主进程 pid =', pid)
    print('接下来看 payload/frishluna-debug.log 与 frishluna-runtime.log')
    return 0


if __name__ == '__main__':
    sys.exit(main())
