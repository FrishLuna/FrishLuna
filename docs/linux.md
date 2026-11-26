# Linux 运行说明

面板与载荷在 Linux 上走的是另一套底层通道：命名管道换成 **unix domain socket**，
进程内载荷从 `payload.dll` 换成 `payload/libfrishluna-payload.so`。
上层（OneBot 动作、面板界面、配置格式）与 Windows 完全一致。

> **当前状态：可运行，但尚未在真实 Linux 版 QQ 上做过端到端验收。**
> 已验证的部分见文末「验证记录」，请以那几条为准，别把「能启动」当成「已经稳了」。

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | x86_64 Linux | glibc ≥ 2.31（RHEL 9 / Ubuntu 20.04 及以后都行） |
| Node.js | **≥ 22** | 面板用内置 `node:sqlite`，20 及以下直接起不来 |
| Python | 3.7+ | 只有「对已运行进程注入」这条路才需要 |
| gcc | 12+ | 只有自己从源码重新编译载荷时才需要 |

```bash
node -v            # 需要 v22.x 或更高
python3 -V
```

## 2. 解压与首次启动

```bash
unzip FrishLuna-0.1.1-linux-x64.zip
cd FrishLuna-0.1.1-linux-x64
chmod +x app/start.sh app/stop.sh
./app/start.sh
```

首次启动会打印**一次**初始令牌，用它登录 `http://127.0.0.1:5701`，
登录后立刻在设置里换成自己的令牌（初始令牌随即作废）。令牌只存盐和哈希，
忘了只能删掉 `.env` 里的 `FL_AUTH_*` 几行重启。

想让面板在后台常驻，两个办法：

```bash
# A. nohup（简单）
nohup ./app/start.sh > app/data/panel.out 2>&1 &
./app/stop.sh                      # 停止

# B. systemd（推荐，能开机自启、崩了自动拉起）
sudo tee /etc/systemd/system/frishluna.service >/dev/null <<'EOF'
[Unit]
Description=FrishLuna panel
After=network.target

[Service]
Type=simple
User=你的用户名
WorkingDirectory=/opt/FrishLuna-0.1.1-linux-x64
ExecStart=/usr/bin/node app/server/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now frishluna
```

> 面板默认只监听 `127.0.0.1:5701`。要在别的机器上用浏览器打开，
> 用 SSH 隧道 `ssh -L 5701:127.0.0.1:5701 用户@主机`，不要改成 `0.0.0.0`
> ——那等于把机器人的控制权挂到公网上。

## 3. 让载荷进到 QQ 进程里

Linux 版 QQ 是 Electron 应用，主进程里才有 JS 运行时。两种注入方式：

### 方式 A：带着载荷启动 QQ（推荐，最稳）

```bash
FL_RUNTIME_DIR=/tmp/frishluna-$(id -u) \
LD_PRELOAD=$PWD/payload/libfrishluna-payload.so \
  qq
```

载荷的构造函数会先建好两个 socket，再挂钩 `napi_create_string_utf8`，
等 QQ 第一次调用 N-API 时拿到 `napi_env`，随后把 `bridge.js` 执行进去。

`FL_RUNTIME_DIR` 是 socket 目录，**面板和 QQ 必须一致**。不设的话双方各自按
`XDG_RUNTIME_DIR/frishluna` 或 `/tmp/frishluna-<uid>` 推导，通常也能对上。

### 方式 B：对已经在跑的 QQ 注入

```bash
python3 injector/linux/inject.py --pid <QQ主进程pid> \
  --lib payload/libfrishluna-payload.so
```

原理是 ptrace 远程 `dlopen`：先 attach 该进程**所有线程**并全部停住
（只停一个线程就往共享代码里写断点，别的线程跑过来会直接崩），
再把路径写进对方栈、把 RIP 指到 `dlopen`，返回后恢复现场再放行。

前提：

```bash
cat /proc/sys/kernel/yama/ptrace_scope
# 0 或 1 = 可以；2 = 只有 root 能注入
```

面板里的「注入」按钮走的就是这条路，会自动把 pid 传给这个脚本。

### 找 QQ 主进程 pid

```bash
pgrep -af '/opt/QQ/qq|linuxqq|QQ.AppImage' | grep -v -- '--type='
```

`--type=renderer/gpu/utility/zygote` 都是子进程，别注入它们。

## 4. socket 在哪

```
${FL_RUNTIME_DIR}/frishluna-<pid>.evt.sock   # 上行事件
${FL_RUNTIME_DIR}/frishluna-<pid>.cmd.sock   # 下行命令
```

目录权限 `0700`、socket 权限 `0600`，同机其他用户连不上。
两条都用「4 字节小端长度 + UTF-8 JSON」分帧——流式 socket 没有消息边界，
不带长度前缀会出现半条 JSON。

## 5. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板起来了，但一直显示未连接 | QQ 没注入，或两边 `FL_RUNTIME_DIR` 不一致 | `ls $FL_RUNTIME_DIR/frishluna-*` 看 socket 是否成对存在 |
| 面板日志出现「连接成功」，动作却全部超时 | 载荷进去了但 JS 桥没跑起来（QQ 还没调过 N-API） | 等 QQ 主界面加载完；或看 `payload/frishluna-payload.log` 有没有 `[hook] env=` |
| 载荷日志 `序言不认识` | 目标函数开头是编译器版本相关的指令序列 | 换 `FL_LINUX_HOOK2=1` 再试；仍失败请带日志提 Issue |
| 注入脚本报 `ptrace(2)` 失败 | `ptrace_scope=2`，或目标已在被别的调试器跟踪 | `sudo sysctl -w kernel.yama.ptrace_scope=0` |
| `Cannot find module .../wrapper.node` | 非 QQ 进程里执行了桥（比如你自己 require 了载荷） | 属正常降级，忽略 |
| 面板打不开 | 端口被占，面板顺延到了下一个 | 看 `app/data/panel.port` 里的真实端口 |

打开 `FL_DEBUG=1` 会往 `payload/frishluna-payload.log` 写载荷侧日志。

## 6. 与 Windows 版的差异

| 能力 | Windows | Linux |
|---|---|---|
| 通道 | 命名管道 | unix domain socket |
| 注入 | `inject.py`（CreateRemoteThread + LoadLibrary） | ptrace 远程 dlopen，或 LD_PRELOAD |
| `pkt` 原生模块（wrapper.node RVA hook） | 有 | **没有**：Linux 版 QQ 的 wrapper.node 是另一个二进制，没有对应偏移表；相关动作会自动降级 |
| 托盘 / VBS 启动器 | 有 | 无，用 `app/start.sh` 或 systemd |
| 查找 QQ 进程 | PowerShell 查 `QQ.exe` | 扫 `/proc`，排除 `--type=` 子进程 |

## 7. 验证记录

以下都在真机（OpenCloudOS 9.6 / 内核 6.6 / glibc 2.38 / Node 22.22 / gcc 12.3）上实测：

- **编译**：`payload/native/build_linux.sh` 通过，产出 `libfrishluna-payload.so`（约 32 KB）
- **LD_PRELOAD 启动**：`napi_create_string_utf8` 挂钩成功（`site=0xf2c579 tramp=0x3fc000`），
  env 捕获 → `bridge.js` 执行 → `ops-ready n=34`，全程无异常
- **双向通道**：`{"cmd":"eval","js":"1+1"}` → 回 `2`；`__fl_ops` 共 64 个键
- **ptrace 注入**：对已运行的 node 进程注入，0.33 秒完成，两个 socket 立刻出现，进程存活
- **面板**：`/api/state` 报告 `evtUp/cmdUp/ready` 全为真；OneBot HTTP 端口正常；
  `devEval 2+3` 经面板 → socket → 载荷 → JS 往返 **268 ms 返回 5**
- **事件不丢**：客户端晚连时，启动期事件（`listen-ok` / `hook-installed`）仍会补发

**尚未验证**：真实 Linux 版 QQ 客户端上的收发消息、媒体上传、群操作。
这些依赖 QQ 内部对象，Windows 侧的经验只能参考，不能直接照搬结论。
