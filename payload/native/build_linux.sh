#!/usr/bin/env bash
# 编译 Linux 进程内载荷（.so）。产物不入库，发布包由 tools/package.py 带上。
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/payload/libfrishluna-payload.so"

CC="${CC:-gcc}"
CFLAGS="${CFLAGS:--O2 -fPIC -fvisibility=hidden -Wall -Wextra -Wno-unused-parameter}"

echo "[1/2] 检查编译器：$($CC --version | head -1)"
echo "[2/2] 编译 $OUT"
# shellcheck disable=SC2086
$CC $CFLAGS -shared -o "$OUT" "$HERE/payload_linux.c" -ldl -lpthread

ls -l "$OUT"
echo "[ok] 完成。用 LD_PRELOAD=$OUT <qq> 启动，或 injector/linux/inject.py --pid <pid> 注入"
