/* pkt.c — wrapper.node SSO hook 模块
 *
 * 背景结论：
 *
 *   send 目标 = QQ 的 JS 参数转换器 (self, env, value)：
 *     typeof(object) 分支走 napi_coerce_to_string —— 把二进制 Buffer 强转成 UTF-8
 *     字符串再入库，二进制 (OIDB envelope) 含非法 UTF-8 序列时被 V8 替换成 U+FFFD，
 *     服务端解不开 → 145 "[oidb] invalid pkg and decode req failed"。
 *     这就是 JS 层 sendSsoCmdReqByContend 必挂 145 的根因。
 *   修法：Buffer 参数时绕过 coerce，用 QQ 自己的 resize（按版本实测）分配
 *     QQ 自定义字符串 (24B: byte0=flag, bit0=长标志; 短串 data=+1 len=flag>>1,
 *     长串 len=+8 ptr=+0x10)，memcpy 原始字节，长度语义与 QQ 完全一致。
 *     非 Buffer 参数一律回落原函数（trampoline），除 Buffer 外行为零变化。
 *
 *   recv 目标 = NodeISendSsoCmdReqCallback::operator()(self)：
 *     self+0x10 → 持有 {env=+0x18, deferred=+0x20} 的回调持有者；
 *     原版把响应拼成 {result:int32(self+0x18), errMsg:字符串(self+0x20),
 *     rsp:二进制字符串(self+0x38)} —— rsp 经 napi_create_string_utf8 二进制转
 *     UTF-8 也是有损的。修法：同样的对象再补一个 rspbuffer
 *     (napi_create_buffer_copy，字节无损)，resolve deferred 后清空挂起指针。
 *     JS 侧优先读 rspbuffer。
 *
 *   hook 本体：自己的 14 字节 detour（mov rax,imm64 + jmp rax）+ trampoline。
 *     只搬移位置无关的序言指令（push/sub rsp/lea rsp 相对寻址），遇到
 *     rip 相对寻址或未知指令直接拒绝安装（宁可失败不猜）。
 *
 *   版本 RVA（wrapper.node，按版本实测定位）：
 *     9.9.36-53644: send=C3EE2F recv=24A6355 resize=77DE00
 *     9.9.37-54395: send=C5927F recv=24CC2B5 resize=78F800（字节级模式匹配）
 *
 *   JS 接口：
 *     initHook(sendRva, recvRva, resizeRva) → boolean
 *     lastError() → string
 */

#include <windows.h>
#include <string.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdlib.h>

typedef void *napi_env;
typedef void *napi_value;
typedef int napi_status;
typedef struct napi_handle_scope__ *napi_handle_scope;

#define napi_ok 0
#define NAPI_AUTO_LENGTH ((size_t)-1)

typedef napi_status (*pfn_is_buffer)(napi_env, napi_value, bool *);
typedef napi_status (*pfn_get_buffer_info)(napi_env, napi_value, void **, size_t *);
typedef napi_status (*pfn_create_object)(napi_env, napi_value *);
typedef napi_status (*pfn_create_int32)(napi_env, int32_t, napi_value *);
typedef napi_status (*pfn_create_string_utf8)(napi_env, const char *, size_t, napi_value *);
typedef napi_status (*pfn_set_named_property)(napi_env, napi_value, const char *, napi_value);
typedef napi_status (*pfn_create_buffer_copy)(napi_env, size_t, const void *, napi_value *);
typedef napi_status (*pfn_resolve_deferred)(napi_env, void *, napi_value);
typedef napi_status (*pfn_open_handle_scope)(napi_env, napi_handle_scope *);
typedef napi_status (*pfn_close_handle_scope)(napi_env, napi_handle_scope);
typedef napi_status (*pfn_throw_error)(napi_env, const char *, const char *);
typedef napi_status (*pfn_get_value_string_utf8)(napi_env, napi_value, char *, size_t, size_t *);
typedef napi_status (*pfn_create_function)(napi_env, const char *, size_t, void *, void *, napi_value);
typedef napi_status (*pfn_get_boolean)(napi_env, bool, napi_value *);
typedef napi_status (*pfn_get_undefined)(napi_env, napi_value *);
typedef napi_status (*pfn_create_string_latin1)(napi_env, const char *, size_t, napi_value *);
typedef napi_status (*pfn_get_cb_info)(napi_env, void *, size_t *, napi_value *, void **, void **);

static struct {
    pfn_is_buffer             is_buffer;
    pfn_get_buffer_info       get_buffer_info;
    pfn_create_object         create_object;
    pfn_create_int32          create_int32;
    pfn_create_string_utf8    create_string_utf8;
    pfn_set_named_property    set_named_property;
    pfn_create_buffer_copy    create_buffer_copy;
    pfn_resolve_deferred      resolve_deferred;
    pfn_open_handle_scope     open_handle_scope;
    pfn_close_handle_scope    close_handle_scope;
    pfn_throw_error           throw_error;
    pfn_get_value_string_utf8 get_value_string_utf8;
    pfn_create_function       create_function;
    pfn_get_boolean           get_boolean;
    pfn_get_undefined         get_undefined;
    pfn_create_string_latin1  create_string_latin1;
} N;

static pfn_get_cb_info N_get_cb_info;

/* ---------------- 状态 ---------------- */

static volatile LONG g_installed;      /* 0/1 */
static HMODULE g_wrapper;
static unsigned char *g_send_target;
static unsigned char *g_recv_target;
static void *g_orig_send;              /* trampoline：原 send 函数 */
static void *g_orig_recv;              /* trampoline：原 recv operator() */
static void (*g_resize)(void *, size_t, int);   /* QQ 自己的字符串 resize */
static void *(*g_qalloc)(size_t);   /* QQ 的 operator new（从 resize 内部 call 推导） */

static char g_err[256];

/* ---------------- 运行时开关与日志 ----------------
 * FL_DEBUG=1      → 写日志（默认 %TEMP%\frishluna-pkt.log，可用 FL_PKT_LOG 覆盖）
 * FL_PKT_NORSP=1  → recv 只回 result、不建 rsp/rspbuffer（崩溃对照实验用） */
static int g_verbose;
static int g_no_rsp;
static char g_logpath[MAX_PATH];

static void pkt_init_flags(void)
{
    char tmp[MAX_PATH];
    DWORD n;
    g_verbose = 0;
    g_no_rsp = 0;
    n = GetEnvironmentVariableA("FL_DEBUG", tmp, sizeof(tmp));
    if (n > 0 && tmp[0] == '1')
        g_verbose = 1;
    n = GetEnvironmentVariableA("FL_PKT_NORSP", tmp, sizeof(tmp));
    if (n > 0 && tmp[0] == '1')
        g_no_rsp = 1;
    g_logpath[0] = 0;
    n = GetEnvironmentVariableA("FL_PKT_LOG", g_logpath, sizeof(g_logpath) - 40);
    if (n == 0) {
        DWORD tl = GetTempPathA(sizeof(tmp) - 40, tmp);
        if (tl > 0 && tl < sizeof(tmp) - 40)
            snprintf(g_logpath, sizeof(g_logpath), "%s\\frishluna-pkt.log", tmp);
    }
}

static void plog(const char *fmt, ...)
{
    char buf[512];
    int n;
    va_list ap;
    HANDLE h;
    if (!g_verbose || !g_logpath[0])
        return;
    va_start(ap, fmt);
    n = vsnprintf(buf, sizeof(buf) - 3, fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    if ((size_t)n > sizeof(buf) - 4)
        n = (int)(sizeof(buf) - 4);
    buf[n] = '\r';
    buf[n + 1] = '\n';
    buf[n + 2] = 0;
    h = CreateFileA(g_logpath, FILE_APPEND_DATA,
                    FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE)
        return;
    SetFilePointer(h, 0, NULL, FILE_END);
    DWORD w = 0;
    WriteFile(h, buf, (DWORD)(n + 2), &w, NULL);
    CloseHandle(h);
}

static void seterr(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_err, sizeof(g_err), fmt, ap);
    va_end(ap);
}

/* ---------------- QQ 自定义字符串 ----------------
 * 24 字节：byte0=flag（bit0=1 长；bit0=0 短，len=flag>>1）；
 * 短串 data 从 +1 起（最长 22）；长串 len=+8、ptr=+0x10。 */

static inline const char *qstr_cstr(const void *s)
{
    return (*(const unsigned char *)s & 1)
        ? *(const char **)((const char *)s + 0x10)
        : (const char *)s + 1;
}

static inline size_t qstr_len(const void *s)
{
    unsigned int f = *(const unsigned int *)s;
    return (f & 1) ? *(const size_t *)((const char *)s + 8) : (size_t)(f >> 1);
}

/* 安全取串：布局对不上就返回 0（调用方跳过该字段），绝不把可疑指针/长度交给 napi。
 * 教训：群戳回执比私戳长，走进长串分支 → 一次 napi_create_string_utf8
 * 拿着野指针读 → QQ 主进程崩（虫子图标崩溃上报）。宁可少一个字段，不许越界。 */
static int qstr_safe(const void *s, const char **pp, size_t *pn)
{
    unsigned char f;
    if (!s)
        return 0;
    f = *(const unsigned char *)s;   /* 只有第 1 个字节是标志，后 3 字节是数据！ */
    if (f & 1u) {
        const char *p = *(const char **)((const char *)s + 0x10);
        size_t n = *(const size_t *)((const char *)s + 8);
        if (!p || n > 0x100000)      /* 1MB 上限：OIDB 回执远小于此 */
            return 0;
        *pp = p;
        *pn = n;
        return 1;
    }
    {
        size_t n = (size_t)(f >> 1);
        if (n > 22)                  /* 短串最长 22 字节，flag 异常就放弃 */
            return 0;
        *pp = (const char *)s + 1;
        *pn = n;
        return 1;
    }
}

/* ---------------- 位置无关序言校验 ----------------
 * 返回一条指令的字节数；0 = 不认识（拒绝 hook）。
 * 白名单：push r32/r12-15、sub rsp,imm8/imm32、lea reg,[rsp+disp8]、mov r64,imm64。 */

static size_t pi_insn_len(const unsigned char *p)
{
    /* push r32: 50-57 */
    if (*p >= 0x50 && *p <= 0x57)
        return 1;
    /* REX.B push r12-r15: 41 50-57 */
    if (*p == 0x41 && p[1] >= 0x50 && p[1] <= 0x57)
        return 2;
    /* sub rsp, imm8: 48 83 EC ib（只认 sub） */
    if (*p == 0x48 && p[1] == 0x83 && p[2] == 0xEC)
        return 4;
    /* sub rsp, imm32: 48 81 EC imm32 */
    if (*p == 0x48 && p[1] == 0x81 && p[2] == 0xEC)
        return 7;
    /* lea r64, [rsp+disp8]: 48 8d modrm(mod=01,rm=100=SIB) sib disp8 */
    if (*p == 0x48 && p[1] == 0x8d && (p[2] & 0xC7) == 0x44 && p[3] != 0x25)
        return 5;
    /* mov r64, imm64 (48 b8+r imm64)：位置无关，可搬 */
    if (*p == 0x48 && (p[1] & 0xF8) == 0xB8)
        return 10;
    return 0;
}

/* 搬移前 n 字节序言；成功返回实际搬移长度（>=n），失败 0 */
static size_t pi_consume(const unsigned char *p, size_t need)
{
    size_t off = 0;
    while (off < need) {
        size_t l = pi_insn_len(p + off);
        if (!l)
            return 0;
        off += l;
    }
    return off;
}

/* ---------------- detour ---------------- */

static void *alloc_trampoline(const unsigned char *target, size_t steal)
{
    void *t = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!t)
        return NULL;
    unsigned char *p = (unsigned char *)t;
    memcpy(p, target, steal);
    /* mov rax, target+steal ; jmp rax */
    p[steal] = 0x48;
    p[steal + 1] = 0xB8;
    *(uint64_t *)(p + steal + 2) = (uint64_t)(uintptr_t)(target + steal);
    p[steal + 10] = 0xFF;
    p[steal + 11] = 0xE0;
    DWORD old = 0;
    if (!VirtualProtect(t, 4096, PAGE_EXECUTE_READ, &old)) {
        VirtualFree(t, 0, MEM_RELEASE);
        return NULL;
    }
    FlushInstructionCache(GetCurrentProcess(), t, steal + 12);
    return t;
}

static BOOL patch14(unsigned char *target, void *detour)
{
    DWORD old = 0;
    if (!VirtualProtect(target, 16, PAGE_EXECUTE_READWRITE, &old))
        return FALSE;
    target[0] = 0x48;
    target[1] = 0xB8;
    *(uint64_t *)(target + 2) = (uint64_t)(uintptr_t)detour;
    target[10] = 0xFF;
    target[11] = 0xE0;
    FlushInstructionCache(GetCurrentProcess(), target, 14);
    VirtualProtect(target, 16, old, &old);
    return TRUE;
}

/* ---------------- send 替换 ----------------
 * 原函数 (self, env, value)：typeof(object) 时 napi_coerce_to_string 有损。
 * Buffer → QQ resize + 原始字节直写；其余回落原函数。 */

static void *__cdecl send_detour(void *self, napi_env env, napi_value value)
{
    if (self && env && value && g_resize) {
        bool isbuf = false;
        if (N.is_buffer(env, value, &isbuf) == napi_ok && isbuf) {
            void *data = NULL;
            size_t len = 0;
            if (N.get_buffer_info(env, value, &data, &len) == napi_ok && data) {
                if (len >= 0xF0) {
                    /* 反汇编结论：resize 开头 cmp rdx,0xF0 / jae throw ——
                     * 240 是 QQ 自己写死的硬上限，不是分配器能力。绕法：
                     * 用 QQ 自己的 operator new（resize+0x38 的 e8 rel32 目标）分配
                     * (len|0xF)+1 字节，手动写长串布局（[0]=cap|1, [8]=len, [0x10]=ptr），
                     * 字段公式与 resize 长串分支逐条一致。QQ 用同一个 new/delete
                     * 收发这条 holder，析构时 free 的是它自己的分配器给的指针，安全。 */
                    if (g_qalloc) {
                        size_t cap = (len | 0xF) + 2;
                        unsigned char *buf = (unsigned char *)g_qalloc((len | 0xF) + 1);
                        if (buf) {
                            memcpy(buf, data, len);
                            buf[len] = 0;
                            *(size_t *)((char *)self + 0x10) = (size_t)buf;
                            *(size_t *)((char *)self + 8) = len;
                            *(size_t *)self = cap;
                            return self;
                        }
                    }
                    /* 拿不到 QQ 分配器（老版本偏移漂移）：给 JS 一个可读错误，绝不硬塞 */
                    if (N.throw_error)
                        N.throw_error(env, NULL, "FrishLuna: SSO contend too large (>=240 bytes, QQ limit)");
                    return self;
                }
                g_resize(self, len, 0);
                memcpy((void *)qstr_cstr(self), data, len);
                {
                    const unsigned char *b = (const unsigned char *)data;
                    plog("[send] self=%p len=%zu hex=%02x%02x%02x%02x%02x%02x%02x%02x %02x%02x%02x%02x",
                         self, len,
                         len > 0 ? b[0] : 0, len > 1 ? b[1] : 0, len > 2 ? b[2] : 0,
                         len > 3 ? b[3] : 0, len > 4 ? b[4] : 0, len > 5 ? b[5] : 0,
                         len > 6 ? b[6] : 0, len > 7 ? b[7] : 0,
                         len > 8 ? b[8] : 0, len > 9 ? b[9] : 0,
                         len > 10 ? b[10] : 0, len > 11 ? b[11] : 0);
                }
                return self;
            }
            /* 取不到 buffer 信息 → 落回原函数 */
        }
    }
    if (g_orig_send)
        return ((void *(*)(void *, napi_env, napi_value))g_orig_send)(self, env, value);
    return self;
}

/* ---------------- recv 替换 ----------------
 * 原版 operator()：{result, errMsg, rsp(utf8 有损)} → resolve deferred。
 * 修法：同样对象 + rspbuffer(napi_create_buffer_copy 无损)，除 create_object
 * 失败外任何路径都 resolve（原版失败会挂起 Promise，这里宁可回空不悬挂）。 */

/* ---- recv：零 napi 的"记账 + 交还原函数" ----
 * 结论：在 recv 回调里自己 create_object/create_int32/resolve 会把 QQ 崩掉
 * （日志停 enter 之后、create_int32 之前，崩溃模块 QQNT.dll；同 env 的 create_object
 * 反而通过 —— V8 isolate 状态不允许在这条 C++ 回调里造值）。
 * 改为：只 memcpy 出原始 rsp 字节入队，然后原样调回 QQ 自己的 operator()，
 * resolve/清理全交给它 —— 行为与原生完全一致，回调里一条 napi 都不调。
 * JS 侧在 promise resolve 之后主动调 takeRsp() 取回无损字节。 */

#define RSPQ_MAX 8
static struct {
    unsigned char *data;
    size_t len;
    unsigned long seq;
} g_q[RSPQ_MAX];
static volatile LONG g_q_n;
static volatile LONG g_q_seq;

static void rsp_push(const char *p, size_t n)
{
    unsigned char *cp;
    LONG slot;
    if (!p || n == 0 || n > 0x100000)
        return;
    cp = (unsigned char *)malloc(n);
    if (!cp)
        return;
    memcpy(cp, p, n);
    slot = InterlockedIncrement(&g_q_n) - 1;
    if (slot >= RSPQ_MAX) {          /* 满了：丢最旧的，腾一格 */
        size_t i;
        if (g_q[0].data)
            free(g_q[0].data);
        for (i = 1; i < RSPQ_MAX; i++)
            g_q[i - 1] = g_q[i];
        slot = RSPQ_MAX - 1;
        g_q[slot].data = NULL;
        InterlockedDecrement(&g_q_n);
    }
    g_q[slot].data = cp;
    g_q[slot].len = n;
    g_q[slot].seq = (unsigned long)InterlockedIncrement(&g_q_seq);
    plog("[recv] queued seq=%lu len=%zu slot=%ld", g_q[slot].seq, n, (long)slot);
}

/* takeRsp() → Buffer | null：取最近一条并清空队列（同一时刻只有一条在途，
 * 取最近的即可避免历史积压串台） */
static void *__cdecl takerps_cb(napi_env env, void *info)
{
    napi_value out = NULL;
    unsigned char *data = NULL;
    size_t len = 0;
    LONG i;
    LONG n;
    napi_status st;

    plog("[take] cb enter");
    n = InterlockedCompareExchange(&g_q_n, 0, 0);
    for (i = (LONG)RSPQ_MAX - 1; i >= 0; i--) {   /* 取最新一条 */
        if (g_q[i].data) {
            data = g_q[i].data;
            len = g_q[i].len;
            g_q[i].data = NULL;
            break;
        }
    }
    for (i = 0; i < RSPQ_MAX; i++) {              /* 其余丢弃 */
        if (g_q[i].data) {
            free(g_q[i].data);
            g_q[i].data = NULL;
        }
    }
    InterlockedExchange(&g_q_n, 0);
    plog("[take] n=%ld len=%zu", (long)n, len);

    /* 用 latin1 字符串交回字节（charCode 1:1 = 字节，零损失）；
       napi_create_buffer_copy 在这条路径上不出现在回调栈里，风险更低。 */
    if (data && len && N.create_string_latin1) {
        st = N.create_string_latin1(env, (const char *)data, len, &out);
        plog("[take] latin1 st=%d", st);
        if (st == napi_ok) {
            free(data);
            return out;
        }
    }
    if (data)
        free(data);
    plog("[take] return undefined");
    if (N.get_undefined)
        N.get_undefined(env, &out);
    return out;
}

static void *__cdecl recv_detour(void *self)
{
    if (self) {
        const char *rp = NULL;
        size_t rn = 0;
        if (qstr_safe((char *)self + 0x38, &rp, &rn))
            rsp_push(rp, rn);
        plog("[recv] tid=%u self=%p result=%d rsp=%zu → 交还原函数",
             (unsigned)GetCurrentThreadId(), self, (int)*(int32_t *)((char *)self + 0x18), rn);
    }
    if (g_orig_recv)
        return ((void *(*)(void *))g_orig_recv)(self);
    return 0;
}

/* ---------------- hook 安装 ---------------- */

static BOOL resolve_napi(void)
{
    const wchar_t *candidates[] = { L"QQNT.dll", L"node.exe", L"nw.dll" };
    HMODULE h = NULL;
    for (int i = 0; i < 3 && !h; i++)
        h = GetModuleHandleW(candidates[i]);
    if (!h) {
        seterr("没有找到 napi 提供方 (QQNT.dll/node.exe/nw.dll 均未加载)");
        return FALSE;
    }
    struct { const char *name; void **slot; } tbl[] = {
        { "napi_is_buffer",             (void **)&N.is_buffer },
        { "napi_get_buffer_info",       (void **)&N.get_buffer_info },
        { "napi_create_object",         (void **)&N.create_object },
        { "napi_create_int32",          (void **)&N.create_int32 },
        { "napi_create_string_utf8",    (void **)&N.create_string_utf8 },
        { "napi_set_named_property",    (void **)&N.set_named_property },
        { "napi_create_buffer_copy",    (void **)&N.create_buffer_copy },
        { "napi_resolve_deferred",      (void **)&N.resolve_deferred },
        { "napi_open_handle_scope",     (void **)&N.open_handle_scope },
        { "napi_close_handle_scope",    (void **)&N.close_handle_scope },
        { "napi_throw_error",           (void **)&N.throw_error },
        { "napi_get_value_string_utf8", (void **)&N.get_value_string_utf8 },
        { "napi_create_function",       (void **)&N.create_function },
        { "napi_get_boolean",           (void **)&N.get_boolean },
        { "napi_get_undefined",         (void **)&N.get_undefined },
        { "napi_create_string_latin1",  (void **)&N.create_string_latin1 },
    };
    for (size_t i = 0; i < sizeof(tbl) / sizeof(tbl[0]); i++) {
        void *p = (void *)GetProcAddress(h, tbl[i].name);
        if (!p) {
            seterr("napi 提供方缺少导出 %s", tbl[i].name);
            return FALSE;
        }
        *tbl[i].slot = p;
    }
    return TRUE;
}

static uintptr_t parse_hex(const char *s)
{
    if (!s)
        return 0;
    uintptr_t v = 0;
    while (*s) {
        char c = *s++;
        int d;
        if (c >= '0' && c <= '9') d = c - '0';
        else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
        else return 0;
        v = (v << 4) | (uintptr_t)d;
    }
    return v;
}

/* initHook(sendRva, recvRva, resizeRva) —— 三个 hex 字符串 */
static napi_value __cdecl inithook_cb(napi_env env, void *info)
{
    napi_value argv[3];
    size_t argc = 3;
    bool okres = false;
    napi_value ret = NULL;

    if (N_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
        seterr("initHook 需要 3 个参数: send_rva, recv_rva, resize_rva (hex)");
        goto out;
    }
    {
        char buf[3][32] = {{0}};
        for (int i = 0; i < 3; i++) {
            size_t n = 0;
            if (N.get_value_string_utf8(env, argv[i], NULL, 0, &n) != napi_ok || n == 0 || n > 20) {
                seterr("参数 %d 不是十六进制字符串", i + 1);
                goto out;
            }
            N.get_value_string_utf8(env, argv[i], buf[i], sizeof(buf[i]), NULL);
        }
        uintptr_t send_rva = parse_hex(buf[0]);
        uintptr_t recv_rva = parse_hex(buf[1]);
        uintptr_t resize_rva = parse_hex(buf[2]);
        if (!send_rva || !recv_rva || !resize_rva) {
            seterr("RVA 解析失败: send=%s recv=%s resize=%s", buf[0], buf[1], buf[2]);
            goto out;
        }

        if (InterlockedCompareExchange(&g_installed, 1, 0) != 0) {
            /* 已装过：幂等成功 */
            okres = true;
            goto out;
        }

        if (!resolve_napi()) {
            InterlockedExchange(&g_installed, 0);
            goto out;
        }

        g_wrapper = GetModuleHandleW(L"wrapper.node");
        if (!g_wrapper) {
            seterr("wrapper.node 未加载");
            InterlockedExchange(&g_installed, 0);
            goto out;
        }
        unsigned char *base = (unsigned char *)g_wrapper;
        g_send_target = base + send_rva;
        g_recv_target = base + recv_rva;
        g_resize = (void (*)(void *, size_t, int))(base + resize_rva);
        /* 从 resize 内部推导 QQ 的 operator new（长串分配用）：
           resize+0x38 处是 e8 rel32 → operator new。偏移对不上就保持 NULL，
           JS 侧会退回「240 上限」的可读错误，不影响小包。 */
        do {
            unsigned char *rz = (unsigned char *)g_resize;
            int32_t rel = 0;
            if (!rz || rz[0x38] != 0xE8)
                break;
            memcpy(&rel, rz + 0x39, 4);
            g_qalloc = (void *(*)(size_t))(rz + 0x3D + rel);
        } while (0);

        size_t steal_send = pi_consume(g_send_target, 14);
        size_t steal_recv = pi_consume(g_recv_target, 14);
        if (!steal_send || !steal_recv) {
            seterr("序言校验失败（send=%zu recv=%zu）：版本不匹配或特征漂移", steal_send, steal_recv);
            InterlockedExchange(&g_installed, 0);
            goto out;
        }
        void *tramp_recv = alloc_trampoline(g_recv_target, steal_recv);
        if (!tramp_recv) {
            seterr("recv trampoline VirtualAlloc 失败");
            InterlockedExchange(&g_installed, 0);
            goto out;
        }
        g_orig_recv = tramp_recv;
        void *tramp = alloc_trampoline(g_send_target, steal_send);
        if (!tramp) {
            seterr("trampoline VirtualAlloc 失败");
            InterlockedExchange(&g_installed, 0);
            goto out;
        }
        g_orig_send = tramp;
        if (!patch14(g_send_target, (void *)send_detour)) {
            seterr("send patch VirtualProtect 失败");
            VirtualFree(tramp, 0, MEM_RELEASE);
            g_orig_send = NULL;
            InterlockedExchange(&g_installed, 0);
            goto out;
        }
        if (!patch14(g_recv_target, (void *)recv_detour)) {
            seterr("recv patch VirtualProtect 失败");
            DWORD old = 0;
            if (VirtualProtect(g_send_target, 16, PAGE_EXECUTE_READWRITE, &old)) {
                memcpy(g_send_target, tramp, steal_send);
                FlushInstructionCache(GetCurrentProcess(), g_send_target, steal_send);
                VirtualProtect(g_send_target, 16, old, &old);
            }
            VirtualFree(tramp, 0, MEM_RELEASE);
            g_orig_send = NULL;
            InterlockedExchange(&g_installed, 0);
            goto out;
        }

        g_err[0] = 0;
        pkt_init_flags();
        plog("[init] ok tid=%u wrapper=%p send=%p recv=%p resize=%p verbose=%d norsp=%d",
             (unsigned)GetCurrentThreadId(), g_wrapper, g_send_target, g_recv_target,
             g_resize, g_verbose, g_no_rsp);
        okres = true;
    }
out:
    if (N.get_boolean)
        N.get_boolean(env, okres, &ret);
    return ret;
}

/* ---------------- 模块注册 ---------------- */

static napi_value __cdecl reg_lasterr(napi_env env, void *info)
{
    (void)info;
    napi_value v = NULL;
    N.create_string_utf8(env, g_err[0] ? g_err : "", NAPI_AUTO_LENGTH, &v);
    return v;
}

__declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports)
{
    N_get_cb_info = (pfn_get_cb_info)GetProcAddress(GetModuleHandleW(L"QQNT.dll"), "napi_get_cb_info");
    if (!N_get_cb_info)
        N_get_cb_info = (pfn_get_cb_info)GetProcAddress(GetModuleHandleW(L"node.exe"), "napi_get_cb_info");
    resolve_napi();

    napi_value fn = NULL;
    if (N.create_function) {
        if (N.create_function(env, "initHook", NAPI_AUTO_LENGTH, (void *)inithook_cb, NULL, &fn) == napi_ok)
            N.set_named_property(env, exports, "initHook", fn);
        if (N.create_function(env, "lastError", NAPI_AUTO_LENGTH, (void *)reg_lasterr, NULL, &fn) == napi_ok)
            N.set_named_property(env, exports, "lastError", fn);
        if (N.create_function(env, "takeRsp", NAPI_AUTO_LENGTH, (void *)takerps_cb, NULL, &fn) == napi_ok)
            N.set_named_property(env, exports, "takeRsp", fn);
    }
    return exports;
}

__declspec(dllexport) int node_api_module_get_api_version_v1(void)
{
    return 8;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)inst; (void)reason; (void)reserved;
    return TRUE;
}
