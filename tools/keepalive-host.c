/* FrishLuna / tools / keepalive-host.c
 *
 * 用途：计划任务的最小启动器。
 *
 * 问题：Task Scheduler 以交互令牌运行任务时，任何控制台子系统程序（node.exe）
 * 都会分配一个控制台窗口；任务的 <Hidden> 属性只影响任务列表里的显示，不隐藏窗口。
 * 用 wscript/cmd 之类的系统代理去隐藏窗口属于绕道，且会让杀软/EDR 认为是在规避检测。
 *
 * 做法：编成 GUI 子系统程序（-mwindows），进程本身不分配控制台；
 * 由它用 CREATE_NO_WINDOW 启动 keepalive.mjs，全程零窗口。
 *
 * 构建（仓库内工具链）：
 *   toolchain/zig-x86_64-windows-0.17.1/zig.exe cc -target x86_64-windows-gnu \
 *     -mwindows -O2 -o build/keepalive-host.exe tools/keepalive-host.c
 */

#include <windows.h>

static void SelfDir(wchar_t *out, DWORD cap) {
    DWORD n = GetModuleFileNameW(NULL, out, cap);
    if (n == 0 || n >= cap) { out[0] = 0; return; }
    for (DWORD i = n; i > 0; --i) {
        if (out[i - 1] == L'\\' || out[i - 1] == L'/') { out[i - 1] = 0; return; }
    }
    out[0] = 0;
}

static BOOL Exists(const wchar_t *p) {
    DWORD a = GetFileAttributesW(p);
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmdline, int show) {
    (void)inst; (void)prev; (void)cmdline; (void)show;

    wchar_t dir[MAX_PATH] = {0};
    SelfDir(dir, MAX_PATH);
    if (!dir[0]) return 1;

    /* keepalive.mjs：先找同目录，再找 <自身目录>\..\tools\ */
    wchar_t script[MAX_PATH * 2] = {0};
    wsprintfW(script, L"%s\\keepalive.mjs", dir);
    if (!Exists(script)) {
        wsprintfW(script, L"%s\\..\\tools\\keepalive.mjs", dir);
        if (!Exists(script)) return 2;
    }

    wchar_t node[MAX_PATH * 2] = {0};
    lstrcpynW(node, L"C:\\Program Files\\nodejs\\node.exe", MAX_PATH * 2);
    if (!Exists(node)) lstrcpynW(node, L"node.exe", MAX_PATH * 2);

    wchar_t line[MAX_PATH * 6] = {0};
    wsprintfW(line, L"\"%s\" \"%s\"", node, script);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof si);
    si.cb = sizeof si;
    ZeroMemory(&pi, sizeof pi);

    /* 工作目录用脚本所在目录，keepalive 自身按 __dirname 推导项目根，不依赖 cwd */
    if (!CreateProcessW(NULL, line, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, dir, &si, &pi))
        return 3;

    /* keepalive 只探端口，最多等 2 分钟；超时直接放它跑完，父进程退出不影响子进程 */
    WaitForSingleObject(pi.hProcess, 120000);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
