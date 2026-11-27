# syntax=docker/dockerfile:1
# FrishLuna 容器镜像：内置 QQ 客户端 + 虚拟桌面（扫码用）+ 面板 + OneBot 协议端
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

# 可选 Debian 镜像源（CI 留空用官方源；国内构建可设 mirrors.tuna.tsinghua.edu.cn 加速）
ARG APT_MIRROR=

ENV DEBIAN_FRONTEND=noninteractive \
    VNC_PASSWD=vncpasswd \
    TZ=Asia/Shanghai \
    FL_HOME=/opt/frishluna \
    FL_PANEL_HOST=0.0.0.0 \
    FL_PANEL_PORT=5701 \
    FL_ONEBOT_PORT=5760 \
    FL_ONEBOT_HOST=0.0.0.0 \
    FL_RUNTIME_DIR=/tmp/frishluna \
    FL_NO_OPEN=1 \
    FL_UID=1000 \
    FL_GID=1000 \
    SCREEN=1920x1080x24 \
    DISPLAY=:1

RUN rm -f /etc/apt/apt.conf.d/docker-clean; \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      mawk \
      gcc \
      libc6-dev \
      dbus-user-session \
      desktop-file-utils \
      ffmpeg \
      fluxbox \
      fonts-wqy-zenhei \
      git \
      gnutls-bin \
      libasound2 \
      libatspi2.0-0 \
      libgbm1 \
      libgtk-3-0 \
      libnotify4 \
      libnss3 \
      libsecret-1-0 \
      openbox \
      procps \
      supervisor \
      tzdata \
      unzip \
      x11vnc \
      xdg-utils \
      xorg \
      xvfb && \
    echo "${TZ}" > /etc/timezone && \
    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime && \
    cd /opt && git clone --depth=1 https://github.com/novnc/noVNC.git && \
    cd /opt/noVNC/utils && git clone --depth=1 https://github.com/novnc/websockify.git && \
    cp /opt/noVNC/vnc.html /opt/noVNC/index.html && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY fetch-qq.sh /root/fetch-qq.sh

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -eux; \
    qq_arch="$(dpkg --print-architecture)"; \
    case "${qq_arch}" in \
      amd64|arm64) deb_arch="${qq_arch}" ;; \
      *) echo "Unsupported architecture: ${qq_arch}" >&2; exit 1 ;; \
    esac; \
    bash /root/fetch-qq.sh "${deb_arch}" /tmp/linuxqq.deb && \
    apt-get update && \
    (dpkg -i /tmp/linuxqq.deb || apt-get -f install -y --no-install-recommends) && \
    rm -f /tmp/linuxqq.deb /root/fetch-qq.sh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 发布包（app/ + payload/ + injector/）。构建前由 scripts/build-image.sh 下载到 artifacts/
COPY frishluna-linux-x64.zip /tmp/frishluna.zip
COPY supervisord.conf /etc/supervisord.conf
COPY start.sh /root/start.sh

RUN set -eux; \
    chmod +x /root/start.sh; \
    groupadd --gid 1001 frishluna && \
    useradd --no-log-init --uid 1001 --gid 1001 --home-dir /app --shell /bin/bash frishluna && \
    mkdir -p /opt/frishluna /app/.cache /app/.config /app/.local/share "${FL_RUNTIME_DIR}" && \
    unzip -q /tmp/frishluna.zip -d /tmp/frishluna-pkg && \
    mv /tmp/frishluna-pkg/*/app /opt/frishluna/app && \
    mv /tmp/frishluna-pkg/*/payload /opt/frishluna/payload && \
    mv /tmp/frishluna-pkg/*/injector /opt/frishluna/injector 2>/dev/null || true; \
    test -f /opt/frishluna/app/start.sh && \
    test -f /opt/frishluna/app/server/index.js && \
    bash /opt/frishluna/payload/native/build_linux.sh && \
    test -f /opt/frishluna/payload/libfrishluna-payload.so && \
    chmod +x /opt/frishluna/app/start.sh && \
    rm -rf /tmp/frishluna.zip /tmp/frishluna-pkg && \
    chown -R frishluna:frishluna /app /opt/frishluna "${FL_RUNTIME_DIR}"

WORKDIR /app

EXPOSE 5900 6081 5701 5760

VOLUME ["/opt/frishluna/app/data", "/app/.config", "/app/.local/share"]

CMD ["/root/start.sh"]
