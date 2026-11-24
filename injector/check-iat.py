import ctypes, os, re, subprocess, sys
from ctypes import wintypes as w
import pefile

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = w.HANDLE
k32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k32.ReadProcessMemory.argtypes = [w.HANDLE, w.LPVOID, w.LPVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [w.HANDLE]

QQ_EXE = os.environ.get('FL_QQ_EXE') or r'C:\Program Files\Tencent\QQNT\QQ.exe'
APP = os.environ.get('FL_QQ_APP') or r'C:\Program Files\Tencent\QQNT\versions\9.9.36-53644\resources\app'
WATCH = ['napi_create_string_utf8', 'napi_get_cb_info', 'napi_create_function',
         'napi_call_function', 'napi_get_named_property', 'napi_set_named_property',
         'napi_get_undefined', 'napi_typeof', 'napi_get_value_string_utf8']


def main_pid():
    ps = ["powershell.exe", "-NoProfile", "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | "
          "Where-Object { $_.CommandLine -notmatch '--type=' } | "
          "Select-Object -ExpandProperty ProcessId"]
    out = subprocess.run(ps, capture_output=True, text=True).stdout
    return [int(x) for x in out.split() if x.isdigit()][0]


def module_base(pid, name):
    ps = ["powershell.exe", "-NoProfile", "-Command",
          f"(Get-Process -Id {pid}).Modules | Where-Object {{ $_.ModuleName -eq '{name}' }} | "
          f"Select-Object -ExpandProperty BaseAddress"]
    out = subprocess.run(ps, capture_output=True, text=True).stdout.strip()
    return int(out) if out else 0


def read_remote(h, addr, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def main():
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else main_pid()
    print('PID', pid)

    # 1) QQ.exe 导出表里的地址
    pe = pefile.PE(QQ_EXE, fast_load=True)
    pe.parse_data_directories(directories=[
        pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_EXPORT']])
    exp = {}
    for e in pe.DIRECTORY_ENTRY_EXPORT.symbols:
        if e.name:
            exp[e.name.decode()] = e.address
    exe_base = module_base(pid, 'QQ.exe')
    print('QQ.exe 基址 = 0x%X' % exe_base)

    # 2) wrapper.node 的 IAT
    h = k32.OpenProcess(0x0010 | 0x0400, False, pid)
    wn_base = module_base(pid, 'wrapper.node')
    print('wrapper.node 基址 = 0x%X' % wn_base)
    if not wn_base:
        print('wrapper.node 未加载'); return

    wpe = pefile.PE(f'{APP}\\wrapper.node', fast_load=True)
    wpe.parse_data_directories(directories=[
        pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_IMPORT']])
    iat = {}
    for entry in getattr(wpe, 'DIRECTORY_ENTRY_IMPORT', []):
        for imp in entry.imports:
            if imp.name:
                iat[imp.name.decode()] = imp.address   # IAT 项的 RVA

    print('\n%-32s %-18s %-18s %s' % ('函数', 'QQ导出表地址', 'wrapper IAT 值', '差异'))
    for fn in WATCH:
        rva = exp.get(fn)
        exp_addr = (exe_base + rva) if rva else None
        irva = iat.get(fn)
        real = None
        if irva:
            raw = read_remote(h, wn_base + irva, 8)
            if raw:
                real = int.from_bytes(raw, 'little')
        same = '-' if (exp_addr and real and exp_addr == real) else ('不同!' if (exp_addr and real) else 'n/a')
        print('%-32s %-18s %-18s %s' % (
            fn,
            hex(exp_addr) if exp_addr else '(未导出)',
            hex(real) if real else '(未导入)',
            same))

    k32.CloseHandle(h)


if __name__ == '__main__':
    main()
