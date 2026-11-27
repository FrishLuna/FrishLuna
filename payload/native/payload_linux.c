/*
 * payload_linux.c — FrishLuna 的 Linux 进程内载荷（.so）
 *
 * 和 Windows 侧同一套思路：不碰宿主的 C++ ABI，只借宿主的 V8 跑一段 JS。
 *   1) 加载（LD_PRELOAD 或 ptrace dlopen）→ constructor 起后台线程
 *   2) 在 napi_create_string_utf8 上装一次性 detour，命中时抓到 napi_env 立刻恢复原函数
 *   3) 把 __fl_emit / __fl_poll / __fl_dir 和 native 桥挂到 global，执行 bridge.js
 *   4) JS 产出的事件 → 队列 → 独立线程写 unix socket
 *
 * 与 Windows 的差异：
 *   - 命名管道 → unix domain socket：<runtime>/frishluna-<pid>.{evt,cmd}.sock
 *   - 两个方向都用「4 字节小端长度 + UTF-8 JSON」分帧（流式 socket 必须有边界）
 *   - napi 符号用 dlsym(RTLD_DEFAULT) 解析（Linux 上由 libnode / 主程序导出）
 *   - napi_get_cb_info 的持久 hook 默认关闭（FL_LINUX_HOOK2=1 才开）：这条路径
 *     在 Linux 上没有真机验证过，宁可少一个抓 session 的能力，也不让用户 QQ 崩
 *
 * 构建：payload/native/build_linux.sh（gcc -shared -fPIC）
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <link.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <sys/syscall.h>
#include <dirent.h>
#include <signal.h>

/* ---------------- N-API 最小声明 ---------------- */

typedef void *napi_env;
typedef void *napi_value;
typedef void *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);

#define NAPI_AUTO_LENGTH ((size_t)-1)
#define NAPI_OK 0

typedef napi_status (*p_create_string_utf8)(napi_env, const char *, size_t, napi_value *);
typedef napi_status (*p_run_script)(napi_env, napi_value, napi_value *);
typedef napi_status (*p_create_function)(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
typedef napi_status (*p_get_global)(napi_env, napi_value *);
typedef napi_status (*p_set_named_property)(napi_env, napi_value, const char *, napi_value);
typedef napi_status (*p_get_cb_info)(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
typedef napi_status (*p_get_value_string_utf8)(napi_env, napi_value, char *, size_t, size_t *);
typedef napi_status (*p_unwrap)(napi_env, napi_value, void **);
typedef napi_status (*p_wrap)(napi_env, napi_value, void *, void *, void *, void *);
typedef napi_status (*p_remove_wrap)(napi_env, napi_value, void **);
typedef napi_status (*p_create_bigint_uint64)(napi_env, uint64_t, napi_value *);
typedef napi_status (*p_get_value_bigint_uint64)(napi_env, napi_value, uint64_t *, bool *);
typedef napi_status (*p_get_value_double)(napi_env, napi_value, double *);
typedef napi_status (*p_create_array)(napi_env, napi_value *);
typedef napi_status (*p_set_element)(napi_env, napi_value, uint32_t, napi_value);
typedef napi_status (*p_get_undefined)(napi_env, napi_value *);
typedef napi_status (*p_get_boolean)(napi_env, bool, napi_value *);

static p_create_string_utf8      g_create_string;
static p_run_script              g_run_script;
static p_create_function         g_create_function;
static p_get_global              g_get_global;
static p_set_named_property      g_set_named_property;
static p_get_cb_info             g_get_cb_info;
static p_get_value_string_utf8   g_get_value_string;
static p_unwrap                  g_unwrap;
static p_wrap                    g_wrap;
static p_remove_wrap             g_remove_wrap;
static p_create_bigint_uint64    g_bigint_new;
static p_get_value_bigint_uint64 g_bigint_get;
static p_get_value_double        g_num_get;
static p_create_array            g_array_new;
static p_set_element             g_set_element;
static p_get_undefined           g_get_undefined;
static p_get_boolean             g_get_boolean;

/* ---------------- 全局状态 ---------------- */

static char   g_self_dir[PATH_MAX];
static char   g_runtime[PATH_MAX];
static napi_env g_env;
static pid_t  g_v8_tid;
static volatile int g_booted;
static volatile int g_bridge_done;

static pid_t fl_tid (void) { return (pid_t)syscall(SYS_gettid); }
static volatile int g_verbose;

static pthread_mutex_t g_qmtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_cmtx = PTHREAD_MUTEX_INITIALIZER;

/* ---------------- 日志 ---------------- */

static void plog (const char *fmt, ...) {
  if (!g_verbose || !g_self_dir[0]) return;
  char path[PATH_MAX + 32];
  snprintf(path, sizeof(path), "%s/frishluna-payload.log", g_self_dir);
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0) return;
  char buf[768];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf) - 2, fmt, ap);
  va_end(ap);
  if (n > 0) {
    if ((size_t)n > sizeof(buf) - 3) n = (int)(sizeof(buf) - 3);
    buf[n++] = '\n';
    ssize_t w = write(fd, buf, (size_t)n);
    (void)w;
  }
  close(fd);
}

/* ---------------- 事件队列（JS 线程只入队，绝不阻塞） ---------------- */

typedef struct qnode { struct qnode *next; size_t len; char data[]; } qnode;
static qnode *g_qhead, *g_qtail;
static int g_qlen;
#define Q_MAX 2048

static void q_push (const char *data, size_t len) {
  if (!data || !len) return;
  qnode *n = (qnode *)malloc(sizeof(qnode) + len);
  if (!n) return;
  n->len = len;
  n->next = NULL;
  memcpy(n->data, data, len);
  pthread_mutex_lock(&g_qmtx);
  if (g_qlen >= Q_MAX) { pthread_mutex_unlock(&g_qmtx); free(n); return; }
  if (g_qtail) g_qtail->next = n; else g_qhead = n;
  g_qtail = n;
  g_qlen++;
  pthread_mutex_unlock(&g_qmtx);
}

static qnode *q_pop (void) {
  pthread_mutex_lock(&g_qmtx);
  qnode *n = g_qhead;
  if (n) {
    g_qhead = n->next;
    if (!g_qhead) g_qtail = NULL;
    g_qlen--;
  }
  pthread_mutex_unlock(&g_qmtx);
  return n;
}

static void q_push_front (qnode *n) {
  if (!n) return;
  pthread_mutex_lock(&g_qmtx);
  n->next = g_qhead;
  g_qhead = n;
  if (!g_qtail) g_qtail = n;
  g_qlen++;
  pthread_mutex_unlock(&g_qmtx);
}

static void emit_json (const char *json) { q_push(json, strlen(json)); }

/* ---------------- 命令队列：cmd socket → JS 的 __fl_poll ---------------- */

#define CMD_MAX 64
static char *g_cq[CMD_MAX];
static int g_cqh, g_cqt;

static void cmd_push (char *s) {
  pthread_mutex_lock(&g_cmtx);
  int next = (g_cqt + 1) % CMD_MAX;
  if (next != g_cqh) { g_cq[g_cqt] = s; g_cqt = next; s = NULL; }
  pthread_mutex_unlock(&g_cmtx);
  if (s) free(s);          /* 队列满：丢最晚的，别让宿主线程等 */
}

static char *cmd_pop (void) {
  char *r = NULL;
  pthread_mutex_lock(&g_cmtx);
  if (g_cqh != g_cqt) { r = g_cq[g_cqh]; g_cq[g_cqh] = NULL; g_cqh = (g_cqh + 1) % CMD_MAX; }
  pthread_mutex_unlock(&g_cmtx);
  return r;
}

/* ---------------- socket 服务 ---------------- */

static int g_evt_fd = -1;                 /* 当前已连接的 evt 客户端 */
static pthread_mutex_t g_evt_mtx = PTHREAD_MUTEX_INITIALIZER;

static int read_full (int fd, void *buf, size_t n) {
  size_t off = 0;
  while (off < n) {
    ssize_t r = read(fd, (char *)buf + off, n - off);
    if (r == 0) return 0;
    if (r < 0) { if (errno == EINTR) continue; return -1; }
    off += (size_t)r;
  }
  return 1;
}

static int write_full (int fd, const void *buf, size_t n) {
  size_t off = 0;
  while (off < n) {
    ssize_t w = write(fd, (const char *)buf + off, n - off);
    if (w < 0) { if (errno == EINTR) continue; return -1; }
    off += (size_t)w;
  }
  return 0;
}

/** evt 通道：4 字节长度 + JSON */
static void *evt_writer (void *arg) {
  (void)arg;
  for (;;) {
    usleep(120 * 1000);
    qnode *n;
    while ((n = q_pop()) != NULL) {
      int fd;
      pthread_mutex_lock(&g_evt_mtx);
      fd = g_evt_fd;
      if (fd < 0) {                 /* 没客户端：放回队头留到有人连上来 */
        pthread_mutex_unlock(&g_evt_mtx);
        q_push_front(n);
        break;
      }
      {
        uint32_t len = (uint32_t)n->len;
        if (write_full(fd, &len, 4) != 0 || write_full(fd, n->data, n->len) != 0) {
          close(fd);
          g_evt_fd = -1;
          pthread_mutex_unlock(&g_evt_mtx);
          q_push_front(n);          /* 没发出去，放回队头等下一个客户端 */
          break;
        }
      }
      pthread_mutex_unlock(&g_evt_mtx);
      free(n);
    }
  }
  return NULL;
}

static void *evt_accept (void *arg) {
  int lfd = *(int *)arg;
  free(arg);
  for (;;) {
    int c = accept(lfd, NULL, NULL);
    if (c < 0) { if (errno == EINTR) continue; usleep(50 * 1000); continue; }
    pthread_mutex_lock(&g_evt_mtx);
    if (g_evt_fd >= 0) { close(g_evt_fd); }
    g_evt_fd = c;
    pthread_mutex_unlock(&g_evt_mtx);
    plog("[evt] client connected fd=%d", c);
  }
  return NULL;
}

/** cmd 通道：面板 → 载荷，同样的长度前缀；收到就进队列等 JS 拉 */
static void *cmd_conn (void *arg) {
  int fd = *(int *)arg;
  free(arg);
  plog("[cmd] client connected fd=%d", fd);
  for (;;) {
    uint32_t len = 0;
    int r = read_full(fd, &len, 4);
    if (r <= 0) break;
    if (len == 0 || len > (16u << 20)) break;
    char *buf = (char *)malloc(len + 1);
    if (!buf) break;
    if (read_full(fd, buf, len) <= 0) { free(buf); break; }
    buf[len] = 0;
    cmd_push(buf);
  }
  plog("[cmd] client gone fd=%d", fd);
  close(fd);
  return NULL;
}

static void *cmd_accept (void *arg) {
  int lfd = *(int *)arg;
  free(arg);
  for (;;) {
    int c = accept(lfd, NULL, NULL);
    if (c < 0) { if (errno == EINTR) continue; usleep(50 * 1000); continue; }
    int *p = (int *)malloc(sizeof(int));
    if (!p) { close(c); continue; }
    *p = c;
    pthread_t t;
    if (pthread_create(&t, NULL, cmd_conn, p) != 0) { free(p); close(c); continue; }
    pthread_detach(t);
  }
  return NULL;
}

/* 只有 QQ 主进程才建 socket：
 * LD_PRELOAD 会被 fork/exec 出来的子进程继承，渲染 / GPU / zygote / crashpad 都会跑
 * 一遍 constructor，各自建一组 socket。子进程一退出，socket 文件就成了死节点，
 * 面板连上去只会无限「消息服务已断开」。这里提前挡掉，让运行目录里始终只有主进程一套。
 *
 * 两条判据同时成立才算主进程：
 *   1) 可执行文件就是 QQ 主程序（排除 chrome_crashpad_handler 这类伴随进程）
 *   2) 命令行不含 --type=xxx（Chromium 的子进程都带这个参数，主进程没有）
 */
static int is_host_process (void) {
  char exe[PATH_MAX];
  ssize_t n = readlink("/proc/self/exe", exe, sizeof(exe) - 1);
  if (n <= 0) return 0;
  exe[n] = 0;
  const char *base = strrchr(exe, '/');
  base = base ? base + 1 : exe;
  /* crashpad 是 QQ 自带的独立进程，同样继承 LD_PRELOAD，但它不需要 socket */
  if (strstr(base, "crashpad")) return 0;

  FILE *f = fopen("/proc/self/cmdline", "rb");
  if (!f) return 1; /* 读不到命令行就按主进程处理，宁可多建也别漏 */
  char buf[8192];
  size_t len = fread(buf, 1, sizeof(buf) - 1, f);
  fclose(f);
  buf[len] = 0;
  for (size_t i = 0; i < len;) {
    const char *arg = buf + i;
    size_t alen = strlen(arg);
    if (strncmp(arg, "--type=", 7) == 0) return 0;
    if (alen == 0) break;
    i += alen + 1;
  }
  return 1;
}

/* 清掉已经不存在的进程留下的 socket，避免运行目录越堆越脏 */
static void cleanup_stale_sockets (void) {
  DIR *d = opendir(g_runtime);
  if (!d) return;
  struct dirent *de;
  int self = (int)getpid();
  while ((de = readdir(d)) != NULL) {
    const char *nm = de->d_name;
    if (strncmp(nm, "frishluna-", 10) != 0) continue;
    int pid = atoi(nm + 10);
    if (pid <= 0 || pid == self) continue;
    if (kill(pid, 0) != 0 && errno == ESRCH) {
      char p[PATH_MAX + 300];
      snprintf(p, sizeof(p), "%s/%s", g_runtime, nm);
      unlink(p);
    }
  }
  closedir(d);
}

static int listen_sock (const char *path) {
  struct sockaddr_un sa;
  memset(&sa, 0, sizeof(sa));
  sa.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(sa.sun_path) - 1) return -1;
  strcpy(sa.sun_path, path);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  unlink(path);
  if (bind(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0) { close(fd); return -1; }
  chmod(path, 0600);
  if (listen(fd, 4) != 0) { close(fd); return -1; }
  return fd;
}

static void start_server (void) {
  const char *rt = getenv("FL_RUNTIME_DIR");
  if (!rt || !rt[0]) {
    const char *xdg = getenv("XDG_RUNTIME_DIR");
    if (xdg && xdg[0]) snprintf(g_runtime, sizeof(g_runtime), "%s/frishluna", xdg);
    else snprintf(g_runtime, sizeof(g_runtime), "/tmp/frishluna-%u", (unsigned)getuid());
  } else {
    snprintf(g_runtime, sizeof(g_runtime), "%s", rt);
  }
  mkdir(g_runtime, 0700);
  chmod(g_runtime, 0700);
  cleanup_stale_sockets();

  char pe[PATH_MAX + 64], pc[PATH_MAX + 64];
  snprintf(pe, sizeof(pe), "%s/frishluna-%d.evt.sock", g_runtime, (int)getpid());
  snprintf(pc, sizeof(pc), "%s/frishluna-%d.cmd.sock", g_runtime, (int)getpid());

  int le = listen_sock(pe);
  int lc = listen_sock(pc);
  if (le < 0 || lc < 0) {
    char e[512];
    snprintf(e, sizeof(e), "{\"evt\":\"error\",\"where\":\"listen\",\"evt\":%d,\"cmd\":%d,\"err\":\"%s\"}",
             le, lc, strerror(errno));
    emit_json(e);
    if (le >= 0) close(le);
    if (lc >= 0) close(lc);
    return;
  }

  int *a = (int *)malloc(sizeof(int)); *a = le;
  int *b = (int *)malloc(sizeof(int)); *b = lc;
  pthread_t t1, t2, t3;
  pthread_create(&t1, NULL, evt_accept, a); pthread_detach(t1);
  pthread_create(&t2, NULL, cmd_accept, b); pthread_detach(t2);
  pthread_create(&t3, NULL, evt_writer, NULL); pthread_detach(t3);

  {
    char e[PATH_MAX * 2 + 128];
    snprintf(e, sizeof(e),
             "{\"evt\":\"listen-ok\",\"pid\":%d,\"runtime\":\"%s\",\"evt\":\"%s\",\"cmd\":\"%s\"}",
             (int)getpid(), g_runtime, pe, pc);
    emit_json(e);
    plog("[listen] %s , %s", pe, pc);
  }
}

/* ---------------- 注入给 JS 的函数 ---------------- */

static napi_value emit_cb (napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {0};
  if (!g_get_cb_info || g_get_cb_info(env, info, &argc, argv, NULL, NULL) != NAPI_OK || argc < 1) return NULL;
  char buf[16384];
  size_t len = 0;
  if (g_get_value_string(env, argv[0], buf, sizeof(buf) - 1, &len) != NAPI_OK) return NULL;
  buf[len] = 0;
  q_push(buf, len);
  return NULL;
}

static napi_value poll_cb (napi_env env, napi_callback_info info) {
  (void)info;
  char *c = cmd_pop();
  if (!c) return NULL;
  napi_value s = NULL;
  if (g_create_string) g_create_string(env, c, strlen(c), &s);
  free(c);
  return s;
}

static uint64_t get_u64_arg (napi_env env, napi_value v) {
  uint64_t out = 0;
  bool lossless = 0;
  if (g_bigint_get && g_bigint_get(env, v, &out, &lossless) == NAPI_OK) return out;
  double d = 0;
  if (g_num_get && g_num_get(env, v, &d) == NAPI_OK) return (uint64_t)d;
  return 0;
}

static napi_value unwrap_cb (napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {0};
  if (!g_get_cb_info || g_get_cb_info(env, info, &argc, argv, NULL, NULL) != NAPI_OK || argc < 1) return NULL;
  void *p = NULL;
  if (!g_unwrap || g_unwrap(env, argv[0], &p) != NAPI_OK) p = NULL;
  napi_value out = NULL;
  if (g_bigint_new && g_bigint_new(env, (uint64_t)(uintptr_t)p, &out) == NAPI_OK) return out;
  return NULL;
}

static napi_value read64_cb (napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {0};
  if (!g_get_cb_info || g_get_cb_info(env, info, &argc, argv, NULL, NULL) != NAPI_OK || argc < 2) return NULL;
  uint64_t p = get_u64_arg(env, argv[0]);
  uint64_t off = get_u64_arg(env, argv[1]);
  uint64_t v = p ? *(uint64_t *)(uintptr_t)(p + off) : 0;
  napi_value out = NULL;
  if (g_bigint_new && g_bigint_new(env, v, &out) == NAPI_OK) return out;
  return NULL;
}

static napi_value write64_cb (napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {0};
  if (!g_get_cb_info || g_get_cb_info(env, info, &argc, argv, NULL, NULL) != NAPI_OK || argc < 3) return NULL;
  uint64_t p = get_u64_arg(env, argv[0]);
  uint64_t off = get_u64_arg(env, argv[1]);
  uint64_t val = get_u64_arg(env, argv[2]);
  uint64_t old = 0;
  if (p) { old = *(uint64_t *)(uintptr_t)(p + off); *(uint64_t *)(uintptr_t)(p + off) = val; }
  napi_value out = NULL;
  if (g_bigint_new && g_bigint_new(env, old, &out) == NAPI_OK) return out;
  return NULL;
}

static napi_value dump_cb (napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {0};
  if (!g_get_cb_info || g_get_cb_info(env, info, &argc, argv, NULL, NULL) != NAPI_OK || argc < 2) return NULL;
  uint64_t p = get_u64_arg(env, argv[0]);
  uint64_t n = get_u64_arg(env, argv[1]);
  if (n > 2048) n = 2048;
  char buf[2048 * 2 + 8];
  size_t pos = 0;
  for (uint64_t i = 0; i < n; i++) {
    unsigned char b = p ? *(unsigned char *)(uintptr_t)(p + i) : 0;
    pos += (size_t)snprintf(buf + pos, sizeof(buf) - pos, "%02x", b);
  }
  napi_value s = NULL;
  if (g_create_string && g_create_string(env, buf, pos, &s) == NAPI_OK) return s;
  return NULL;
}

static napi_value graft_cb (napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {0};
  if (!g_get_cb_info || g_get_cb_info(env, info, &argc, argv, NULL, NULL) != NAPI_OK || argc < 3) return NULL;
  void *dst = NULL;
  if (!g_unwrap || g_unwrap(env, argv[0], &dst) != NAPI_OK) dst = NULL;
  uint64_t src = get_u64_arg(env, argv[1]);
  uint64_t n = get_u64_arg(env, argv[2]);
  if (n > 4096) n = 4096;
  if (dst && src && n) memcpy(dst, (void *)(uintptr_t)src, (size_t)n);
  napi_value out = NULL;
  if (g_bigint_new && g_bigint_new(env, (uint64_t)(uintptr_t)dst, &out) == NAPI_OK) return out;
  return NULL;
}

static napi_value rewrap_cb (napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {0};
  if (!g_get_cb_info || g_get_cb_info(env, info, &argc, argv, NULL, NULL) != NAPI_OK || argc < 2) return NULL;
  uint64_t np = get_u64_arg(env, argv[1]);
  void *old = NULL;
  if (g_remove_wrap) g_remove_wrap(env, argv[0], &old);
  if (g_wrap && np) g_wrap(env, argv[0], (void *)(uintptr_t)np, NULL, NULL, NULL);
  napi_value out = NULL;
  if (g_bigint_new && g_bigint_new(env, (uint64_t)(uintptr_t)old, &out) == NAPI_OK) return out;
  return NULL;
}

/* 扫私有可写映射找 vptr == vtable 的对象起点（Linux 用 /proc/self/maps，
   不去读不可写页：读 /proc/self/mem 失败就跳过，宁可少扫不许崩） */
static napi_value scan_cb (napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {0};
  if (!g_get_cb_info || g_get_cb_info(env, info, &argc, argv, NULL, NULL) != NAPI_OK || argc < 1) return NULL;
  uint64_t vt = get_u64_arg(env, argv[0]);
  uint64_t max = argc > 1 ? get_u64_arg(env, argv[1]) : 64;
  if (!max || max > 512) max = 64;

  napi_value arr = NULL;
  if (!g_array_new || !g_set_element || g_array_new(env, &arr) != NAPI_OK) return NULL;
  if (!vt) return arr;

  FILE *f = fopen("/proc/self/maps", "r");
  if (!f) return arr;
  char line[512];
  uint32_t idx = 0;
  size_t bufcap = 1 << 16;
  unsigned char *buf = (unsigned char *)malloc(bufcap);
  if (!buf) { fclose(f); return arr; }

  while (fgets(line, sizeof(line), f) && idx < max) {
    unsigned long lo = 0, hi = 0;
    char perms[8] = {0};
    if (sscanf(line, "%lx-%lx %7s", &lo, &hi, perms) != 3) continue;
    if (strncmp(perms, "rw", 2) != 0) continue;          /* 只要私有可写匿名映射 */
    if (strstr(line, "/dev/") || strstr(line, "/mem")) continue;
    if (hi <= lo || (hi - lo) > (256u << 20)) continue;
    size_t size = (size_t)(hi - lo);
    unsigned char *local = buf;
    if (size > bufcap) { local = (unsigned char *)malloc(size); if (!local) continue; }
    memcpy(local, (void *)(uintptr_t)lo, size);          /* 同进程读自己的可写页，安全 */
    for (size_t i = 0; i + 8 <= size && idx < max; i += 8) {
      if (*(uint64_t *)(local + i) == vt) {
        napi_value bv = NULL;
        if (g_bigint_new && g_bigint_new(env, (uint64_t)(lo + i), &bv) == NAPI_OK)
          g_set_element(env, arr, idx++, bv);
      }
    }
    if (local != buf) free(local);
  }
  free(buf);
  fclose(f);
  plog("[scan] vt=%p hits=%u", (void *)(uintptr_t)vt, (unsigned)idx);
  return arr;
}

/* ---------------- 读 bridge.js 并执行 ---------------- */

static char *read_file (const char *name, size_t *out_len) {
  char path[PATH_MAX + 64];
  snprintf(path, sizeof(path), "%s/%s", g_self_dir, name);
  int fd = open(path, O_RDONLY);
  if (fd < 0) {
    char e[600];
    snprintf(e, sizeof(e), "{\"evt\":\"error\",\"where\":\"open-%s\",\"err\":%d}", name, errno);
    emit_json(e);
    return NULL;
  }
  struct stat st;
  if (fstat(fd, &st) != 0 || st.st_size <= 0) { close(fd); return NULL; }
  char *buf = (char *)malloc((size_t)st.st_size + 1);
  if (!buf) { close(fd); return NULL; }
  ssize_t got = 0, off = 0;
  while (off < st.st_size) {
    got = read(fd, buf + off, (size_t)st.st_size - (size_t)off);
    if (got <= 0) break;
    off += got;
  }
  close(fd);
  buf[off] = 0;
  *out_len = (size_t)off;
  return buf;
}

static void run_bridge (napi_env env) {
  if (__sync_lock_test_and_set(&g_bridge_done, 1)) return;
  plog("[bridge] start");

  napi_value fn = NULL, glob = NULL;
  if (g_create_function && g_get_global && g_set_named_property) {
    if (g_create_function(env, "__fl_emit", NAPI_AUTO_LENGTH, emit_cb, NULL, &fn) == NAPI_OK) {
      if (g_get_global(env, &glob) == NAPI_OK && glob) g_set_named_property(env, glob, "__fl_emit", fn);
    }
    if (g_create_function(env, "__fl_poll", NAPI_AUTO_LENGTH, poll_cb, NULL, &fn) == NAPI_OK) {
      if (glob) g_set_named_property(env, glob, "__fl_poll", fn);
    }
    struct { const char *name; napi_callback cb; } nbridge[] = {
      {"__fl_unwrap", unwrap_cb}, {"__fl_read64", read64_cb}, {"__fl_write64", write64_cb},
      {"__fl_dump", dump_cb}, {"__fl_graft", graft_cb}, {"__fl_rewrap", rewrap_cb},
      {"__fl_scan", scan_cb}
    };
    for (unsigned i = 0; i < sizeof(nbridge) / sizeof(nbridge[0]); i++) {
      napi_value f = NULL;
      if (g_create_function(env, nbridge[i].name, NAPI_AUTO_LENGTH, nbridge[i].cb, NULL, &f) == NAPI_OK && glob)
        g_set_named_property(env, glob, nbridge[i].name, f);
    }
    if (glob) {
      napi_value sv = NULL;
      if (g_create_string(env, g_self_dir, strlen(g_self_dir), &sv) == NAPI_OK)
        g_set_named_property(env, glob, "__fl_dir", sv);
    }
  }
  emit_json("{\"evt\":\"napi-bind\",\"stage\":\"linux\"}");

  size_t jlen = 0;
  char *js = read_file("bridge.js", &jlen);
  if (!js) return;
  napi_value src = NULL, glob2 = NULL;
  if (g_create_string(env, js, jlen, &src) == NAPI_OK && g_get_global(env, &glob2) == NAPI_OK && glob2)
    g_set_named_property(env, glob2, "__fl_bridge_src", src);
  free(js);

  /* 不在 hook 的调用栈里同步跑大脚本：交给事件循环（与 Windows 侧同策） */
  static const char boot_js[] =
    "(function(){try{var s=globalThis.__fl_bridge_src;delete globalThis.__fl_bridge_src;"
    "setTimeout(function(){try{eval(s)}catch(e){try{__fl_emit(JSON.stringify({evt:'bridge-exec-err',"
    "e:String(e&&e.message||e)}))}catch(x){}}},0)}catch(e){try{__fl_emit(JSON.stringify({evt:'bridge-exec-err',"
    "e:String(e&&e.message||e)}))}catch(x){}}})()";
  napi_value script = NULL, result = NULL;
  if (g_create_string(env, boot_js, sizeof(boot_js) - 1, &script) != NAPI_OK) {
    emit_json("{\"evt\":\"error\",\"where\":\"create-boot-string\"}");
    return;
  }
  int st = g_run_script(env, script, &result);
  {
    char e[200];
    snprintf(e, sizeof(e), "{\"evt\":\"bridge-scheduled\",\"status\":%d}", st);
    emit_json(e);
  }
  plog("[bridge] scheduled st=%d", st);
}

/* ---------------- 一次性 detour ----------------
 *
 * 目标函数首字节长什么样，由编译器决定：可能是 endbr64，也可能是
 * "test rdi,rdi; je ..." 这类空指针卫语句。只按白名单搬指令的做法在
 * 换一个构建就失效（Node 22 + gcc 12 就是这样拒绝安装的）。
 *
 * 这里改成：认得指令边界 + 会重定位相对跳转 / RIP 相对寻址，并且
 * 跳板内存申请在目标 ±2GB 内，保证 rel32 一定放得下。
 * 唯一跳过的情况是最前面的卫语句（test/cmp + jcc）：那几条只负责
 * "env 为空就早退"，从卫语句之后进入等价于 env 非空路径；
 * 而 hook_entry 自己会对 env==NULL 直接返回，不会掉进空指针路径。
 */

#define HOOK_LEN 12

typedef struct {
  size_t  len;
  int     is_branch;      /* 相对跳转：disp 在 off 处，宽度 w（1/4） */
  int     is_rip;         /* RIP 相对寻址：disp 在 off 处，宽度 4 */
  size_t  off;
  int     w;
  int64_t target;         /* is_branch 时的绝对目标（安装时填） */
  int     guard;          /* test / cmp：卫语句成分 */
  int     jcc;            /* 条件跳转 */
} insn_info;

static void *mmap_near (void *want, size_t size);

/* ModRM（含 SIB / disp）解析：返回整段字节数，0 = 不认识或不完整 */
static int modrm_parse (const unsigned char *p, size_t avail, int *rip, size_t *disp_off)
{
  *rip = 0;
  if (avail < 1) return 0;
  int mod = p[0] >> 6, rm = p[0] & 7;
  size_t i = 1;
  if (mod == 3) return (int)i;
  if (rm == 4) {                            /* SIB */
    if (avail < 2) return 0;
    int base = p[1] & 7;
    i = 2;
    if (mod == 0 && base == 5) { i += 4; }
  } else if (mod == 0 && rm == 5) {         /* RIP 相对 */
    *rip = 1;
    *disp_off = i;
    i += 4;
    return (int)i;
  }
  if (mod == 1) i += 1;
  else if (mod == 2) i += 4;
  if (i > avail) return 0;
  return (int)i;
}

/* 取一条指令的长度与可重定位信息。0 = 不认识（调用方据此放弃这段窗口） */
static int decode_insn (const unsigned char *p, size_t avail, insn_info *o)
{
  if (avail < 1) return 0;
  memset(o, 0, sizeof(*o));
  if (avail >= 4 && p[0] == 0xF3 && p[1] == 0x0F && p[2] == 0x1E && p[3] == 0xFA) {
    o->len = 4; return 1;                  /* endbr64 */
  }
  size_t i = 0;
  int rex_w = 0;
  while (i < avail) {
    unsigned char b = p[i];
    if (b == 0x66 || b == 0x67 || b == 0xF0 || b == 0xF2 || b == 0xF3 ||
        b == 0x2E || b == 0x36 || b == 0x3E || b == 0x26 || b == 0x64 || b == 0x65) { i++; continue; }
    if (b >= 0x40 && b <= 0x4F) { if (b & 8) rex_w = 1; i++; continue; }
    break;
  }
  if (i >= avail) return 0;
  unsigned char op = p[i++];

  size_t modrm_len = 0, disp_off = 0;
  int rip = 0, has_modrm = 0, imm = 0;

  if (op >= 0x50 && op <= 0x5F) { /* push/pop r64 */ }
  else if (op >= 0x90 && op <= 0x97) { /* nop / xchg eax */ }
  else if (op >= 0x70 && op <= 0x7F) { o->is_branch = 1; o->jcc = 1; o->off = i; o->w = 1; i += 1; }
  else if (op >= 0xB0 && op <= 0xB7) { imm = 1; }
  else if (op >= 0xB8 && op <= 0xBF) { imm = rex_w ? 8 : 4; }
  else if (op == 0xE8 || op == 0xE9) { o->is_branch = 1; o->off = i; o->w = 4; i += 4; }
  else if (op == 0xEB) { o->is_branch = 1; o->off = i; o->w = 1; i += 1; }
  else if (op == 0x6A) { imm = 1; }
  else if (op == 0x68) { imm = 4; }
  else if (op == 0xC3 || op == 0xC2 || op == 0xFF || op == 0xE0 || op == 0xE1 ||
           op == 0xE2 || op == 0xE3) {
    return 0;                              /* ret / 间接跳转 / loop：不搬 */
  } else if (op == 0x0F) {
    if (i >= avail) return 0;
    unsigned char o2 = p[i++];
    if (o2 >= 0x80 && o2 <= 0x8F) { o->is_branch = 1; o->jcc = 1; o->off = i; o->w = 4; i += 4; }
    else if (o2 == 0x1F || o2 == 0x28 || o2 == 0x29 || o2 == 0x10 || o2 == 0x11 ||
             o2 == 0x54 || o2 == 0x57 || o2 == 0xAF || o2 == 0xB6 || o2 == 0xB7 ||
             o2 == 0xBE || o2 == 0xBF) { has_modrm = 1; }
    else if (o2 == 0x1E) { if (i < avail && p[i] == 0xFA) i++; else return 0; }
    else if (o2 == 0x05 || o2 == 0x0B || o2 == 0x31) { /* syscall / ud2 / rdtsc */ }
    else return 0;
  } else if (op == 0x85 || op == 0x84 || op == 0x89 || op == 0x8B || op == 0x8D ||
             op == 0x88 || op == 0x8A || op == 0x01 || op == 0x03 || op == 0x09 ||
             op == 0x0B || op == 0x21 || op == 0x23 || op == 0x29 || op == 0x2B ||
             op == 0x31 || op == 0x33 || op == 0x39 || op == 0x3B || op == 0x63 ||
             op == 0xD1 || op == 0xD3 || op == 0x03) { has_modrm = 1; }
  else if (op == 0xC1) { has_modrm = 1; imm = 1; }
  else if (op == 0x83) { has_modrm = 1; imm = 1; }
  else if (op == 0x80 || op == 0xC6) { has_modrm = 1; imm = 1; }
  else if (op == 0x81 || op == 0xC7) { has_modrm = 1; imm = 4; }
  else if (op == 0xF7) { has_modrm = 1; imm = 4; }
  else return 0;

  if (has_modrm) {
    int m = modrm_parse(p + i, avail - i, &rip, &disp_off);
    if (!m) return 0;
    modrm_len = (size_t)m;
    if (rip) { o->is_rip = 1; o->off = i + disp_off; o->w = 4; }
    i += modrm_len;
  }
  i += (size_t)imm;
  if (i > avail) return 0;
  o->len = i;
  if (op == 0x85 || op == 0x84 || op == 0x39 || op == 0x3B || op == 0x81 || op == 0x83) o->guard = 1;
  return 1;
}

/* 在目标附近找一块跳板内存：必须落在 ±2GB 内，rel32 才放得下 */
#ifndef MAP_FIXED_NOREPLACE
#define MAP_FIXED_NOREPLACE 0x100000
#endif

static void *mmap_near (void *want, size_t size)
{
  long pg = sysconf(_SC_PAGESIZE);
  uintptr_t base = (uintptr_t)want & ~(uintptr_t)(pg - 1);
  const uintptr_t step = 0x10000, limit = 0x7FFF0000UL;
  for (uintptr_t d = 0; d <= limit; d += step) {
    for (int s = 0; s < 2; s++) {
      uintptr_t cand = s == 0 ? base + d : base - d;
      void *r = mmap((void *)cand, size, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
      if (r != MAP_FAILED) {
        if ((uintptr_t)r == cand) return r;
        munmap(r, size);
      }
      if (d == 0) break;
    }
  }
  return NULL;
}

static int mprotect_rwx (void *addr)
{
  long pg = sysconf(_SC_PAGESIZE);
  void *base = (void *)((uintptr_t)addr & ~(uintptr_t)(pg - 1));
  return mprotect(base, (size_t)pg * 2, PROT_READ | PROT_WRITE | PROT_EXEC);
}

static int g_guard_skipped;

/* 把 [src, src+steal) 搬到 tramp，并修正其中的相对引用 */
static int relocate (unsigned char *tramp, size_t off, const unsigned char *src,
                     size_t steal, const insn_info *infos, size_t n)
{
  memcpy(tramp + off, src, steal);
  size_t cur = 0;
  for (size_t k = 0; k < n; k++) {
    const insn_info *in = &infos[k];
    if (in->is_rip) {
      int32_t old = *(int32_t *)(src + cur + in->off);
      int64_t tgt = (int64_t)(uintptr_t)(src + cur) + (int64_t)in->len + old;
      int64_t nd  = tgt - ((int64_t)(uintptr_t)(tramp + off + cur) + (int64_t)in->len);
      if (nd > INT32_MAX || nd < INT32_MIN) return 0;
      *(int32_t *)(tramp + off + cur + in->off) = (int32_t)nd;
    } else if (in->is_branch) {
      int64_t tgt;
      if (in->w == 1) tgt = (int64_t)(uintptr_t)(src + cur) + (int64_t)in->len + *(int8_t *)(src + cur + in->off);
      else            tgt = (int64_t)(uintptr_t)(src + cur) + (int64_t)in->len + *(int32_t *)(src + cur + in->off);
      int64_t nd = tgt - ((int64_t)(uintptr_t)(tramp + off + cur) + (int64_t)in->len);
      if (in->w == 1) {
        if (nd > 127 || nd < -128) return 0;
        *(int8_t *)(tramp + off + cur + in->off) = (int8_t)nd;
      } else {
        if (nd > INT32_MAX || nd < INT32_MIN) return 0;
        *(int32_t *)(tramp + off + cur + in->off) = (int32_t)nd;
      }
    }
    cur += in->len;
  }
  return 1;
}

/* 把 target 起 12 字节改成 mov rax,imm64; jmp rax，原指令搬进 trampoline。
   成功返回 trampoline（可直接当原函数调用），并把真实落点写回 *site。 */
static void *install_detour_at (void *target, void *entry, void **site, unsigned char *saved)
{
  const unsigned char *base = (const unsigned char *)target;
  size_t skip = 0;

  /* 跳过最前面的卫语句：test/cmp [ ... ] + jcc（只跳这一组） */
  for (;;) {
    insn_info a;
    if (!decode_insn(base + skip, 64, &a)) break;
    if (a.guard) { skip += a.len; continue; }
    if (a.jcc) { skip += a.len; g_guard_skipped = 1; break; }
    break;
  }

  insn_info infos[16];
  size_t n = 0, steal = 0;
  while (steal < HOOK_LEN) {
    if (n >= 16) return NULL;
    insn_info in;
    if (!decode_insn(base + skip + steal, 64, &in)) { plog("[hook] 序言不认识 off=%zu", skip + steal); return NULL; }
    if (in.is_branch) {
      int64_t tgt = (int64_t)(uintptr_t)(base + skip + steal) + (int64_t)in.len +
                    (int64_t)(in.w == 1 ? *(int8_t *)(base + skip + steal + in.off)
                                        : *(int32_t *)(base + skip + steal + in.off));
      /* 跳到窗口内部 = 搬走会断，放弃 */
      int64_t lo = (int64_t)(uintptr_t)(base + skip), hi = lo + 64;
      if (tgt >= lo && tgt < hi) { plog("[hook] 分支指向窗口内 off=%zu", skip + steal); return NULL; }
    }
    infos[n++] = in;
    steal += in.len;
  }

  unsigned char *tramp = (unsigned char *)mmap_near((void *)base, 4096);
  if (!tramp) { plog("[hook] 跳板内存申请失败"); return NULL; }
  if (!relocate(tramp, 0, base + skip, steal, infos, n)) {
    munmap(tramp, 4096);
    plog("[hook] 相对引用重定位失败");
    return NULL;
  }
  tramp[steal] = 0x48; tramp[steal + 1] = 0xB8;
  *(uint64_t *)(tramp + steal + 2) = (uint64_t)(uintptr_t)(base + skip + steal);
  tramp[steal + 10] = 0xFF; tramp[steal + 11] = 0xE0;
  mprotect(tramp, 4096, PROT_READ | PROT_EXEC);

  if (saved) memcpy(saved, base + skip, HOOK_LEN);      /* 打补丁前留原字节 */
  if (mprotect_rwx((void *)(base + skip)) != 0) { munmap(tramp, 4096); return NULL; }
  unsigned char patch[HOOK_LEN];
  patch[0] = 0x48; patch[1] = 0xB8;
  *(uint64_t *)(patch + 2) = (uint64_t)(uintptr_t)entry;
  patch[10] = 0xFF; patch[11] = 0xE0;
  memcpy((void *)(base + skip), patch, HOOK_LEN);
  __builtin___clear_cache((char *)(base + skip), (char *)(base + skip) + HOOK_LEN);

  if (site) *site = (void *)(base + skip);
  return tramp;
}

static unsigned char g_saved[HOOK_LEN];
static void      *g_target;
static void      *g_tramp;
static volatile int g_hook_state;         /* 0=已装 1=恢复中 2=已恢复 */

static void restore_original (void)
{
  int prev = __sync_val_compare_and_swap(&g_hook_state, 0, 1);
  if (prev == 2) return;
  if (prev == 1) {                 /* 别的线程正在恢复：等它写完再放行 */
    while (g_hook_state != 2) sched_yield();
    return;
  }
  if (g_target && mprotect_rwx(g_target) == 0) {
    memcpy(g_target, g_saved, HOOK_LEN);
    __builtin___clear_cache((char *)g_target, (char *)g_target + HOOK_LEN);
  }
  __sync_lock_test_and_set(&g_hook_state, 2);
}

static napi_status hook_entry (napi_env env, const char *s, size_t len, napi_value *result) {
  /* 卫语句被跳过时，env 为空的原早退路径不再执行，这里补上（等价 napi_invalid_arg） */
  if (g_guard_skipped && !env) return (napi_status)1;
  /* 先恢复再执行：入口已在原函数体内，等价原行为；trampoline 是原序言 + 跳回 */
  restore_original();
  napi_status st;
  if (g_tramp) {
    st = ((p_create_string_utf8)g_tramp)(env, s, len, result);
  } else {
    st = g_create_string ? g_create_string(env, s, len, result) : 1;
  }
  if (!g_env && env) {
    g_env = env;
    g_v8_tid = (pid_t)fl_tid();
    emit_json("{\"evt\":\"env-captured\"}");
    plog("[hook] env=%p tid=%d", (void *)env, (int)g_v8_tid);
    run_bridge(env);
  }
  return st;
}

/* 可选：napi_get_cb_info 持久 hook（默认关闭，见文件头说明） */
static napi_status (*g_cb_orig)(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
static volatile int g_cb_persistent;
static void *g_cb_target;
static void *g_cb_tramp;
static pthread_mutex_t g_catch_mtx = PTHREAD_MUTEX_INITIALIZER;

static void fire_catch (napi_env env, napi_value this_val) {
  if (g_v8_tid && (pid_t)fl_tid() != g_v8_tid) return;
  if (!g_get_global || !g_create_string) return;
  napi_value glob = NULL, fn = NULL, ret = NULL;
  if (g_get_global(env, &glob) != NAPI_OK || !glob) return;
  /* __fl_catch 由 bridge.js 挂上；没挂就静默跳过 */
  typedef napi_status (*p_get_named)(napi_env, napi_value, const char *, napi_value *);
  typedef napi_status (*p_call)(napi_env, napi_value, napi_value, size_t, const napi_value *, napi_value *);
  static p_get_named gnp;
  static p_call cf;
  if (!gnp) gnp = (p_get_named)dlsym(RTLD_DEFAULT, "napi_get_named_property");
  if (!cf) cf = (p_call)dlsym(RTLD_DEFAULT, "napi_call_function");
  if (!gnp || !cf) return;
  if (gnp(env, glob, "__fl_catch", &fn) != NAPI_OK || !fn) return;
  pthread_mutex_lock(&g_catch_mtx);
  cf(env, glob, fn, 1, &this_val, &ret);
  pthread_mutex_unlock(&g_catch_mtx);
}

static napi_status cb_info_hook (napi_env env, napi_callback_info info, size_t *argc,
                                 napi_value *argv, napi_value *this_arg, void **data) {
  napi_status st = g_cb_orig ? g_cb_orig(env, info, argc, argv, this_arg, data) : 1;
  if (g_cb_persistent && data && *data && this_arg && *this_arg && env) fire_catch(env, *this_arg);
  return st;
}

/* ---------------- 解析 napi 与安装 ---------------- */

static void *resolve_sym (const char *name) {
  void *p = dlsym(RTLD_DEFAULT, name);
  if (p) return p;
  /* 某些构建导出的符号在主程序里，RTLD_DEFAULT 拿不到时逐个模块找 */
  return NULL;
}

static int resolve_all (void) {
  g_create_string      = (p_create_string_utf8)resolve_sym("napi_create_string_utf8");
  g_run_script         = (p_run_script)resolve_sym("napi_run_script");
  g_create_function    = (p_create_function)resolve_sym("napi_create_function");
  g_get_global         = (p_get_global)resolve_sym("napi_get_global");
  g_set_named_property = (p_set_named_property)resolve_sym("napi_set_named_property");
  g_get_cb_info        = (p_get_cb_info)resolve_sym("napi_get_cb_info");
  g_get_value_string   = (p_get_value_string_utf8)resolve_sym("napi_get_value_string_utf8");
  g_unwrap             = (p_unwrap)resolve_sym("napi_unwrap");
  g_wrap               = (p_wrap)resolve_sym("napi_wrap");
  g_remove_wrap        = (p_remove_wrap)resolve_sym("napi_remove_wrap");
  g_bigint_new         = (p_create_bigint_uint64)resolve_sym("napi_create_bigint_uint64");
  g_bigint_get         = (p_get_value_bigint_uint64)resolve_sym("napi_get_value_bigint_uint64");
  g_num_get            = (p_get_value_double)resolve_sym("napi_get_value_double");
  g_array_new          = (p_create_array)resolve_sym("napi_create_array");
  g_set_element        = (p_set_element)resolve_sym("napi_set_element");
  g_get_undefined      = (p_get_undefined)resolve_sym("napi_get_undefined");
  g_get_boolean        = (p_get_boolean)resolve_sym("napi_get_boolean");

  return (g_create_string && g_run_script && g_create_function && g_get_global &&
          g_set_named_property && g_get_cb_info && g_get_value_string) ? 1 : 0;
}

static void *hook_thread (void *arg) {
  (void)arg;
  for (int i = 0; i < 600; i++) {          /* 最多等 60 秒：宿主可能还没把符号加载进来 */
    if (resolve_all()) break;
    usleep(100 * 1000);
  }
  if (!g_create_string) {
    emit_json("{\"evt\":\"error\",\"where\":\"resolve-napi\",\"hint\":\"宿主未导出 napi_* 符号\"}");
    return NULL;
  }
  void *site = NULL;
  g_tramp = install_detour_at((void *)(uintptr_t)g_create_string, (void *)hook_entry, &site, g_saved);
  if (!g_tramp) {
    emit_json("{\"evt\":\"error\",\"where\":\"install-detour\",\"hint\":\"序言校验失败或 mprotect 被拒\"}");
    return NULL;
  }
  g_target = site; g_hook_state = 0;
  plog("[hook] installed site=%p tramp=%p guard=%d", g_target, g_tramp, g_guard_skipped);
  emit_json("{\"evt\":\"hook-installed\"}");

  /* 可选持久 hook：只在显式开启时尝试，失败就退回「仅抓 env」 */
  if (getenv("FL_LINUX_HOOK2") && getenv("FL_LINUX_HOOK2")[0] == '1' && g_get_cb_info) {
    g_cb_target = (void *)(uintptr_t)g_get_cb_info;
    g_cb_persistent = 1;
    g_cb_tramp = install_detour_at(g_cb_target, (void *)cb_info_hook, NULL, NULL);
    if (g_cb_tramp) {
      g_cb_orig = (napi_status (*)(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **))g_cb_tramp;
      emit_json("{\"evt\":\"hook2-installed\"}");
    } else {
      g_cb_persistent = 0;
      emit_json("{\"evt\":\"hook2-skipped\"}");
    }
  }
  return NULL;
}

/* ---------------- 模块入口 ---------------- */

__attribute__((constructor)) static void fl_ctor (void) {
  Dl_info di;
  if (dladdr((void *)fl_ctor, &di) && di.dli_fname) {
    snprintf(g_self_dir, sizeof(g_self_dir), "%s", di.dli_fname);
    char *slash = strrchr(g_self_dir, '/');
    if (slash) *slash = 0;
  }
  const char *dbg = getenv("FL_DEBUG");
  g_verbose = (dbg && dbg[0] && dbg[0] != '0') ? 1 : 0;
  plog("[ctor] dir=%s pid=%d", g_self_dir, (int)getpid());

  if (__sync_val_compare_and_swap(&g_booted, 0, 1) != 0) return;

  /* 子进程（渲染 / GPU / zygote / crashpad）不参与：不建 socket 也不装 hook。
   * 否则多出来的 socket 会在子进程退出后变成死节点，面板连上去只会无限重连。 */
  if (!is_host_process()) {
    plog("[ctor] 非主进程，跳过（pid=%d）", (int)getpid());
    return;
  }

  start_server();
  pthread_t t;
  if (pthread_create(&t, NULL, hook_thread, NULL) == 0) pthread_detach(t);
}

/* N-API 模块入口：宿主若把本 .so 当 addon 载入，也能拿到 initHook（与 Windows 侧同名） */
__attribute__((visibility("default"))) napi_value napi_register_module_v1 (napi_env env, napi_value exports) {
  (void)env;
  return exports;
}

__attribute__((visibility("default"))) int node_api_module_get_api_version_v1 (void) {
  return 8;
}
