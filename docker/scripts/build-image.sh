#!/usr/bin/env bash
# 本地构建单平台镜像的辅助脚本。多架构走 CI（.github/workflows/docker-image.yml）。
#
# 用法：
#   ./scripts/build-image.sh                                # 用 artifacts/ 里已有的 zip
#   TAG=v0.1.1 ./scripts/build-image.sh                     # 自动从 Release 下载
#   PLATFORM=linux/arm64 TAG=v0.1.1 PUSH=1 ./scripts/build-image.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DOCKER_DIR}/.." && pwd)"

IMAGE="${IMAGE:-frishluna:latest}"
PUSH="${PUSH:-0}"
REPO="${REPO:-FrishLuna/FrishLuna}"
PLATFORM="${PLATFORM:-linux/amd64}"
ARTIFACTS_DIR="${DOCKER_DIR}/artifacts"

mkdir -p "${ARTIFACTS_DIR}"

case "${PLATFORM}" in
  linux/amd64) asset_arch="linux-x64" ;;
  linux/arm64) asset_arch="linux-arm64" ;;
  *) echo "PLATFORM 只支持单个值（linux/amd64 或 linux/arm64），多架构交给 CI。" >&2; exit 1 ;;
esac

ARTIFACT="${ARTIFACTS_DIR}/frishluna-${asset_arch}.zip"

if [ -n "${TAG:-}" ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "没找到 gh CLI，装好后重试：https://cli.github.com/" >&2
    exit 1
  fi
  asset="FrishLuna-${TAG#v}-${asset_arch}.zip"
  echo "从 ${REPO}@${TAG} 下载 ${asset}"
  gh release download "${TAG}" --repo "${REPO}" --pattern "${asset}" --output "${ARTIFACT}" --clobber
elif [ ! -f "${ARTIFACT}" ]; then
  echo "缺 ${ARTIFACT}。" >&2
  echo "两种来源任选：设 TAG=vX.Y.Z 自动下载 Release；或自己把发布 zip 放进 artifacts/。" >&2
  exit 1
fi

# Dockerfile 固定读取根目录的 frishluna-linux-x64.zip
cp -f "${ARTIFACT}" "${DOCKER_DIR}/frishluna-linux-x64.zip"

OUTPUT="--load"
if [ "${PUSH}" = "1" ]; then
  OUTPUT="--push"
fi

docker buildx build \
  --platform "${PLATFORM}" \
  --tag "${IMAGE}" \
  --file "${DOCKER_DIR}/Dockerfile" \
  ${OUTPUT} \
  "${DOCKER_DIR}"

rm -f "${DOCKER_DIR}/frishluna-linux-x64.zip"
echo "镜像已就绪：${IMAGE}（${PLATFORM}）"
