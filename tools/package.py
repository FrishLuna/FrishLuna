#!/usr/bin/env python3
"""发布打包：把仓库文件 + 不入库的编译产物打成平台专用 zip。

为什么不用 git archive：它按 .gitattributes 做行尾转换，
UTF-16 的 .vbs 会被写坏（用户拿到手 VBScript 直接解析报错）。
这里直接读工作区字节，未提交改动会被拒绝，保证打出来的就是当前 HEAD。

用法：
  python tools/package.py --platform windows-x64
  python tools/package.py --platform linux-x64 --version 0.1.0
"""
import argparse
import json
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 各平台必须随包分发的编译产物（源码库不入库，但用户不能自己去编译）
EXTRAS = {
    'windows-x64': [
        'payload/frishluna-payload.dll',
        'payload/native/frishluna-pkt.node',
    ],
    'linux-x64': [
        'payload/libfrishluna-payload.so',
        'payload/native/libfrishluna-pkt.so',
    ],
}

# 源码里有、但发布包里不要的（开发辅助，用户用不上）
SKIP = [
    'injector/msf.js',
    'injector/online2.js',
    'injector/probe-access.py',
    'injector/check-iat.py',
    'injector/test-debugprocess.mjs',
]


def git(*args):
    return subprocess.run(['git'] + list(args), cwd=ROOT, capture_output=True, check=True).stdout


def tracked_files():
    out = git('ls-files', '-z').decode('utf-8')
    return [p for p in out.split('\0') if p]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--platform', required=True, choices=sorted(EXTRAS))
    ap.add_argument('--version', default='')
    ap.add_argument('--out-dir', default=os.path.join(ROOT, '..', 'tmp', 'release'))
    ap.add_argument('--allow-dirty', action='store_true')
    a = ap.parse_args()

    ver = a.version
    if not ver:
        with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
            ver = json.load(f)['version']

    dirty = git('status', '--porcelain').decode('utf-8').strip()
    if dirty and not a.allow_dirty:
        print('[!!] 工作区有未提交改动，先提交再打包（或用 --allow-dirty）：')
        print(dirty[:2000])
        return 2

    name = f'FrishLuna-{ver}-{a.platform}'
    os.makedirs(a.out_dir, exist_ok=True)
    out = os.path.join(a.out_dir, name + '.zip')

    files = [p for p in tracked_files() if p not in SKIP]
    missing = []
    for extra in EXTRAS[a.platform]:
        if os.path.isfile(os.path.join(ROOT, extra)):
            files.append(extra)
        else:
            missing.append(extra)
    if missing:
        print('[!!] 缺少编译产物：')
        for m in missing:
            print('   ', m)
        print('   先编译（Windows: tools/build-payload.sh，Linux: payload/native/build_linux.sh）')
        return 3

    seen = set()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in sorted(files):
            if rel in seen:
                continue
            seen.add(rel)
            src = os.path.join(ROOT, rel.replace('/', os.sep))
            if not os.path.isfile(src):
                continue
            # 可执行位必须保留：Linux 下的 .sh / inject.py
            st = os.stat(src)
            mode = 0o755 if (st.st_mode & 0o111) else 0o644
            info = zipfile.ZipInfo(f'{name}/{rel}', date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100000 | mode) << 16
            with open(src, 'rb') as f:
                z.writestr(info, f.read())

    size = os.path.getsize(out)
    print(f'[ok] {out}  ({size / 1048576:.2f} MB, {len(seen)} 个文件)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
