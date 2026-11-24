#!/usr/bin/env bash
# FrishLuna / injector / shell-mode.sh
# 把 QQ 变成「纯 shell」：替换 resources/app/package.json 的 main 指向我们的 loader。
#   bash shell-mode.sh install   备份 + 改成我们的入口
#   bash shell-mode.sh restore   还原官方入口
#   bash shell-mode.sh show      看当前 main
# 注意：本脚本会改动 QQ 安装目录内的 package.json，属于实验路线，
#       不是推荐用法（推荐用法是 boot-inject.sh + 旁挂注入，完全不改安装目录）。
#       使用前必须备份，restore 依赖它自己生成的 .frishluna.bak。
set -u
APP="${FL_QQ_APP:-/c/Program Files/Tencent/QQNT/versions/${FL_QQ_VER:-9.9.36-53644}/resources/app}"
PKG="$APP/package.json"
BAK="$APP/package.json.frishluna.bak"
OUR_MAIN="./frishluna/loader.js"

case "${1:-show}" in
  install)
    if [ ! -f "$BAK" ]; then
      cp -f "$PKG" "$BAK" && echo "已备份 -> package.json.frishluna.bak"
    else
      echo "备份已存在，跳过（避免用改过的文件覆盖真备份）"
    fi
    python - "$PKG" "$OUR_MAIN" <<'PY'
import json, sys, io
p, main = sys.argv[1], sys.argv[2]
d = json.load(io.open(p, encoding='utf-8'))
d['main'] = main
io.open(p, 'w', encoding='utf-8', newline='').write(json.dumps(d, ensure_ascii=False, indent=2))
print('main ->', main)
PY
    ;;
  restore)
    if [ -f "$BAK" ]; then
      cp -f "$BAK" "$PKG" && echo "已还原官方 main"
      grep -o '"main":[^,]*' "$PKG"
    else
      echo "!! 没有备份，无法还原"
      exit 1
    fi
    ;;
  *)
    grep -o '"main":[^,]*' "$PKG"
    [ -f "$BAK" ] && echo "(备份存在)" || echo "(无备份)"
    ;;
esac
