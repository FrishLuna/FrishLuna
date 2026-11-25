# FrishLuna

适用于 QQNT 版 QQ 客户端的本地消息控制台与 OneBot v11 协议端。
包含注入器、C 载荷、内置协议端和原生 WebUI，没有 npm 运行时依赖。

> 用之前先知道几件事。
>
> 1. 本项目与腾讯没有任何关系，也没有获得授权或背书。「QQ」「QQNT」等名称仅用于描述兼容对象，不构成商标使用许可，也不代表获得官方支持。
> 2. 要稳定请用官方 QQ 机器人：[QQ 机器人开放平台（q.qq.com）](https://q.qq.com/) 与 [QQ 机器人文档（bot.qq.com）](https://bot.qq.com/)。官方方案经过审核，接口稳定且不影响账号。本项目属于官方渠道之外对客户端行为的实验性研究，功能可能随客户端版本更新失效。
> 3. 本项目仅供个人学习与研究。使用可能导致账号被警告、限制功能、封禁或冻结，也可能丢失聊天记录等本地数据，相关风险由使用者自行承担，作者不承担责任也不提供解封协助。
> 4. 严禁用于批量加好友、群发营销、自动化营销、抢红包、刷赞刷量、骚扰他人、欺诈或抓取传播数据等违法用途。相关能力已在代码与文档中受限或移除。
> 5. 作者保留随时停止分发、删除仓库或变更许可证的权利。

---

## 双击使用

```
app\启动 FrishLuna.vbs     ← 日常入口：后台拉起面板（关窗口不会停）+ 自动开浏览器 + 自动拉起 QQ 并注入
app\前台运行.cmd           ← 前台跑面板，实时滚日志（首次运行用它能看见打印出来的初始令牌；关窗口即停）
app\停止面板.cmd           ← 按 PID 精确停止面板
```

面板挂后台，关窗口不会停。

真挂了有计划任务 `FrishLuna Keepalive` 兜底，每分钟会读 `app\data\panel.port` 探测真实端口（端口顺延也能识别），服务不在就静默拉起，日志写在 `app\data\keepalive.log`。

看门狗直接跑 `node tools/keepalive.mjs` 即可；如果想要没有控制台窗口的启动器，用 `tools/keepalive-host.c` 自行编译，仓库不提供预编译二进制。

面板地址 `http://127.0.0.1:5701`（端口被占自动 +1）。

访问令牌长度在 8 到 64 位之间，必须同时包含字母和数字，允许使用 `!@#$%^&*()-_+=[]{};:,.?/~` 这些符号，面板自动生成的是 16 位。缺少字母或数字、长度不对、含不允许的字符，前后端都会拦下。设置页有强度提示：字母加数字为低，大写加小写加数字为中，再加特殊字符为高。

项目根目录的 `.env` 只存 16 字节盐和 scrypt 哈希（N=16384/r=8/p=1，64 字节输出），没有明文，也没有能解密回来的副本。首次启动会生成初始令牌并在控制台打印一次；输出被重定向时看不到，跑一遍 `app\前台运行.cmd` 就行。用它登录后必须先改设自己的令牌，改完换盐换哈希，初始令牌立刻作废。

令牌忘了就删掉 `.env` 里 `FL_AUTH_*` 那几行重启，会重新发一个初始令牌。登录态只保存在浏览器 sessionStorage，关浏览器失效；在「面板设置 → 访问令牌」可以重置，新令牌只显示一次。

## 面板页面

| 页面 | 内容 |
|------|------|
| 登录页 | 输入访问令牌进入（可粘贴令牌，也支持 URL `?token=`） |
| 概览 | 连接状态、QQ 进程、消息服务与最近事件 |
| 实验台 | 发消息；戳一戳、撤回、表情回应、名片赞等互动；群禁言、踢人、设管理、改名片、改群名、公告等群管理；查看修改昵称签名与好友列表；群列表、群成员、最近会话与服务可用性查询 |
| 控制台 | 日志查看：按级别与关键字过滤、暂停刷新、导出、清空 |
| 诊断 | 运行状态与诊断信息复制 |
| 运行设置 | QQ 路径、自动启动、端口与禁止发送的群号 |
| 面板设置 | 主题、主色调、动画、字号；访问令牌重置与退出 |

个性化偏好存浏览器 localStorage；令牌只存根目录 `.env`（盐 + 哈希）；面板仅监听 127.0.0.1。

## 运行方式

QQ 正常启动并登录，界面照常使用。面板启动后旁挂注入，提供通道、状态获取与注入式调用。

调用链路如下：

```
QQ 客户端   ← 本体登录，UI 正常用
C 载荷      ← 旁挂注入：抓 napi_env、借 V8 跑 bridge.js/ops.js、监听入站消息
本面板      ← 业务与展示：op → kernel.call → {cmd:'op'} → 命名管道 → payload/ops.js
本机其它程序 ← 内置 OneBot v11（HTTP action / WS 均在 5760）：事件推送与 action 调用
```

`app/server/kernel.js` 把 OneBot action 转成 `{cmd:'op', name, args, seq}`，由 `payload/ops.js` 在 QQ 进程内执行，回执按 seq 配对。入站方向由 `payload/inbound.js` 把真实的群消息和私聊消息推上来，喂给内核和面板命令链路。HTTP 和 WS 服务端均为手写，没有 npm 运行时依赖。

## 对接外部机器人框架（AstrBot 等）

协议端在 `app/server/onebot-server.js`，内置三种接入方式：

| 方式 | 说明 | 配置 |
|---|---|---|
| HTTP API | `POST http://127.0.0.1:5760`，`{action, params, echo}` | 面板设置 → 协议端令牌 |
| 正向 WS | 客户端连 `ws://127.0.0.1:5760` | 同上 |
| 反向 WS | 本端作为客户端连到外部框架（如 AstrBot 的 aiocqhttp 服务） | 面板设置 → 反向 WS 地址 |

反向 WS 是手写的 RFC6455 客户端，因为 Node 原生 WebSocket 无法自定义请求头。握手按 aiocqhttp 的校验要求带 `Authorization: Bearer`、`X-Self-ID` 和 `X-Client-Role: Universal` 三个头，令牌也可以直接写进 URL 的 `access_token=`；`get_login_info` 与 `get_status` 会按规范返回。

OneBot 的 `self_id` 要等本号发过一条消息，才能从消息记录里认出自己。补全前后反向 WS 会重连换请求头，面板重启后一般半分钟内恢复。

自己发出的消息拿不到回显（QQ 只推它收到的消息），所以外部框架不会响应当前账号自己发的内容。

## 结构

```
app/server/    Node host：HTTP+SSE 面板服务、访问令牌鉴权、进程管理、入站消息处理
app/server/kernel.js          内核调用层：OneBot action → payload op 的唯一出口（按 seq 配对回执）
app/server/onebot-server.js   OneBot v11 服务端：HTTP action + 手写 RFC6455 WS + 反向 WS
app/server/protocol/onebot11.js  OneBot 11 编解码（消息段 ↔ 文本/图片/at）
app/server/msgid.js           消息 ID 映射（短 id ↔ 内核 msgId）
app/server/lab.js             实验台操作 → action 名 → kernel.call 的映射与参数校验
app/server/marshal.js         1C 封送层 host 侧驱动（op/seq 配对）
app/web/       WebUI（原生 HTML/CSS/JS：登录页、实验台、调试、个性化、深浅色）
payload/       bridge.js + ops.js + inbound.js + watch.js + longmsg.js + media.js + qzone.js
payload/native/pkt.c          hook 原生模块源码（send/recv 字节直通）
injector/      inject.py（LoadLibrary 注入）+ launch.py（挂起创建注入）+ 权限探测脚本
tools/         构建、自检、离线验收脚本（离线自测 selftest）
docs/EULA.md                使用须知与免责声明
```

## 配置项

`app/data/config.json`（可在设置页修改）：

| 键 | 说明 |
|---|---|
| `port` / `host` | 面板监听，默认 `127.0.0.1:5701` |
| `qqExe` | QQ 可执行文件路径，需在设置页手动指定 |
| `autoInject` | 面板发现 QQ 在跑但没注入时自动注入 |
| `blockedGroups` | 禁止发送的群号列表，只拦发送、收消息照常，默认空数组（不拦截任何群），用之前务必填上 |
| `obServerPort` / `obServerToken` / `obServerReverse` | 内置 OneBot v11 服务端：端口（默认 5760）、令牌、反向 WS 列表 |

可选外部依赖：群相册上传视频需要用 ffmpeg 抽首帧封面。默认在 `PATH` 中找 `ffmpeg` 和 `ffprobe`，装在别处可以用环境变量 `FL_FFMPEG` 与 `FL_FFPROBE` 指定完整路径。纯文本和图片链路用不上。

## 通信链路

```
双击 → Node host(127.0.0.1:5701) → 面板 REST/SSE
     → 业务 op → kernel.call → {cmd:'op',name,args,seq}
     → \\.\pipe\frishluna.<qqPid>.cmd → payload/ops.js（在 QQ 进程内执行）
     ← \\.\pipe\frishluna.<qqPid>.evt ← 回执 / 入站消息 / 内核事件
     ↔ 同一批事件经内置 OneBot v11 服务端推给本机订阅方
```

## 实现边界

| 层 | 实现 | 说明 |
|---|---|---|
| ① 注入进宿主进程 | `injector/inject.py`（OpenProcess → VirtualAllocEx → WriteProcessMemory → CreateRemoteThread/LoadLibraryW），`launch.py` 挂起注入 | 标准 Win32 注入路径 |
| ② 进程内取执行权 | 双 detour（`napi_create_string_utf8` 一次性 + `napi_get_cb_info` 持久 trampoline），只借 V8 跑 JS，不碰协议 | `payload/native/pkt.c` |
| ③ 消息通道 | `\\.\pipe\frishluna.<pid>.evt/.cmd`，uint32 长度 + JSON | `payload/bridge.js`、`app/server/pipe.js` |
| ④ QQ 协议 → OneBot 11 | 编解码 `protocol/onebot11.js`，服务端 `app/server/onebot-server.js`，动作分发 `app/server/kernel.js` → `payload/ops.js` | — |
| ⑤ 面板与业务 | `app/server/*`、`app/web/*` | — |
| ⑥ 封送层（C 侧直调内核对象） | `app/server/marshal.js`，调用目标运行时解析，不绑定具体版本 | 目前只用于只读调用 |

## 行为约束

- `NodeIQQNTWrapperSession.getNTWrapperSession(name)` 读的是本线程注册过的缓存，不是全局工厂。直接按名字取往往只拿到未初始化的空壳，`getMsgService()` 底层服务为空；必须复用宿主已有的实例，不能按名字新建。
- JS 侧 `sendMsg` 的参数位置很严格：入参形式为 `sendMsg('0', peer, msgElements, new Map())`，且 `peer.guildId` 要填本次 `generateMsgUniqueId` 的返回值。把整包消息直接当第一个参数会返回 `{result:5}`，`errMsg` 为空。
- 主进程业务在 native 层（`isByteCodeShell: true`），`application.asar` 里没有任何 wrapper 调用，JS 层拿不到宿主正在用的 session。
- 普通启动后再注入，`engine.getDeviceInfo()` 字段为空；挂起注入能更早拿到 wrapper 对象。
- 改动 Electron 入口（`package.json` 的 `main`）会被完整性校验拦截，旁挂注入不触碰 QQ 安装目录。
- 封送层目前只验证过只读调用。写操作未经测试，调用即使没抛异常也不代表可用。

## 致谢

部分实现思路参考了 [SnowLuma](https://github.com/SnowLuma/SnowLuma/)。协议字段号、wire 布局这类事实性内容来自对客户端行为的实测比对，代码由本项目自行编写；思路相同不等于代码相同，仓库中不包含任何其他项目的源码副本。

---

## 免责声明

- 本项目是非官方的第三方研究项目，与腾讯公司、QQ 及其关联方不存在任何隶属、合作、授权或背书关系。
- 本项目按现状提供，不附带任何明示或默示担保。功能随时可能随 QQ 版本更新失效，不承诺持续可用。
- 使用本项目产生的一切后果（包括但不限于账号受限、封禁、数据丢失或违反服务协议）由使用者自行承担，作者不承担责任也不提供解封协助。
- 严禁用于违法用途或侵犯他人权益的场景。发现被用于此类用途的，作者保留拒绝支持和停止分发的权利。
- 如需稳定、合规的机器人能力，请使用官方方案：[QQ 机器人开放平台](https://q.qq.com/) / [官方接入文档](https://bot.qq.com/)。

## 许可

源代码以 [MIT](LICENSE) 许可证开源。使用层面的免责声明与可接受使用条款见 [docs/EULA.md](docs/EULA.md)，第三方组件与运行时域名说明见 [NOTICE](NOTICE)。仓库不包含腾讯专有源码、反编译产物、内部接口表或测试报告；实现依据的接口行为是在自有设备上按互操作目的取得的，功能可能随 QQ 版本更新失效。
