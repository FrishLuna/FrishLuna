# 用 Docker 跑

一条命令把「QQ 客户端 + 面板 + 机器人对接」整包跑起来，不用在本机装 QQ 和 Node.js。镜像里带官方 Linux QQ 和一个虚拟桌面，登录用浏览器打开网页扫码即可。

## 快速开始

```bash
git clone https://github.com/FrishLuna/FrishLuna.git
cd FrishLuna/docker
TAG=v0.1.1 ./scripts/build-image.sh      # 从 Release 下载发布包并构建
docker compose up -d
```

或者直接用我们预构建的镜像：

```bash
docker run -d --name frishluna \
  --shm-size 1gb --cap-add SYS_PTRACE --security-opt seccomp=unconfined \
  -p 5701:5701 -p 5760:5760 -p 5900:5900 -p 6081:6081 \
  -v frishluna-data:/opt/frishluna/app/data \
  ghcr.io/FrishLuna/FrishLuna:latest
```

然后：

1. 打开 `http://localhost:6081`（noVNC 网页），首次会启动 QQ，用手机 QQ 扫码登录
2. 打开 `http://localhost:5701`，这就是面板（首次令牌印在 `docker logs frishluna` 里）
3. 机器人对接在 `http://localhost:5760`，OneBot 客户端照常接

## 端口一览

| 端口 | 用途 |
|---|---|
| 5701 | 面板网页 |
| 5760 | OneBot v11（HTTP + WebSocket） |
| 6081 | 浏览器扫码登录（noVNC） |
| 5900 | VNC 直连（可选，用 6081 就不用管它） |

## 常用配置

`docker-compose.yml` 里改环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `VNC_PASSWD` | `vncpasswd` | 扫码网页/VNC 的连接密码，**公网部署务必改** |
| `FL_PANEL_PORT` | 5701 | 容器内面板端口 |
| `FL_ONEBOT_PORT` | 5760 | 容器内 OneBot 端口 |
| `SCREEN` | 1920x1080x16 | 虚拟桌面分辨率 |

数据都在三个卷里：面板配置（`frishluna-data`）、QQ 登录态和聊天数据（`frishluna-qq-config` / `frishluna-qq-data`），容器删了重建也不丢。

## 登录态隔离

镜像内 QQ 以独立用户运行，QQ 登录态落在 `frishluna-qq-*` 两个卷里，与宿主机的 QQ 互不干扰。

## 平台说明

- **Linux**：amd64 与 arm64 都可用（QQ 官方提供双架构 deb）
- **Windows**：Windows 容器无法跑图形登录流程，不做 Windows 镜像；Windows 用户装 Docker Desktop 后运行同一个 Linux 镜像即可（上面 `docker run` 命令原样能用）
- **macOS**：Docker Desktop 同样直接用 Linux 镜像

## 已知限制

- 虚拟桌面里跑的是真实 QQ 客户端，内存占用约 1～2 GB，建议给容器 2 GB 以上
- 构建时从 QQ 官方接口实时解析当前版本并签名下载 deb，QQ 出大版本后重新构建镜像即可跟上，无需手改版本号
