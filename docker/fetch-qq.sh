#!/usr/bin/env bash
# 构建期获取 Linux QQ 安装包：官方配置接口实时解析当前版本 + GetSign 换带签名的下载直链。
# 腾讯 CDN 的原始链接（qqdl.gtimg.cn）不带签名会被 403，且路径 hash 会随版本轮换，写死必 404。
set -euo pipefail

ARCH_TAG="${1:-amd64}"          # amd64 | arm64
OUT="${2:-/tmp/linuxqq.deb}"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
CONFIG_URL="https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js"
COOKIE_URL="https://im.qq.com/index/"
SIGN_URL="https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign"

key="x64DownloadUrl"
[ "$ARCH_TAG" = "arm64" ] && key="armDownloadUrl"

# 1) 配置接口：linuxConfig.js 是 JS 字面量，抠出大括号 JSON 段解析
deb_url="$(curl -fsSL -A "$UA" "$CONFIG_URL" | node -e '
let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
  const m = s.match(/params\s*=\s*(\{.*\})\s*;/s)
  if (!m) process.exit(1)
  const p = JSON.parse(m[1])
  const k = process.argv[1]
  const u = p[k] && p[k].deb
  if (!u) process.exit(1)
  process.stdout.write(u)
})' "$key")"
[ -n "$deb_url" ] || { echo "配置接口里解析不到 $key.deb" >&2; exit 1; }
echo "QQ 版本安装包：$deb_url"

# 2) 入口页拿 tgw_l7_route cookie
cookie="$(curl -fsSL -A "$UA" -c - "$COOKIE_URL" | awk '/tgw_l7_route/ {print $NF; exit}')"
[ -n "$cookie" ] || { echo "拿不到 tgw_l7_route" >&2; exit 1; }

# 3) GetSign 换带签名直链
signed_url="$(curl -fsSL -A "$UA" \
  -H "Content-Type: application/json" \
  -H "Origin: https://im.qq.com" \
  -H "Referer: https://im.qq.com/index/" \
  -H 'x-oidb: {"uint32_command":"0x9b8e","uint32_service_type":1}' \
  -b "tgw_l7_route=$cookie" \
  --data-binary "{\"url\":$(printf '%s' "$deb_url" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.stringify(s)))')}" \
  "$SIGN_URL" | node -e '
let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
  const j = JSON.parse(s)
  process.stdout.write((j.data && j.data.url) || "")
})')"
[ -n "$signed_url" ] || { echo "GetSign 没返回 data.url" >&2; exit 1; }

# 4) 下载
curl -fSL -A "$UA" --retry 3 --retry-delay 5 -o "$OUT" "$signed_url"
echo "已下载：$OUT ($(wc -c < "$OUT") 字节)"
