#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

upstream="$work/eccodes-wasm"
git clone https://github.com/meri-imperiumi/eccodes-wasm.git "$upstream"
git -C "$upstream" checkout --detach 759ca8e5c9b55883afff8cea5f9fe4d333e5b970
git -C "$upstream" apply "$root/tools/eccodes-encoding.patch"
git clone --depth 1 --branch 2.48.1 https://github.com/ecmwf/eccodes.git "$upstream/eccodes"
test "$(git -C "$upstream/eccodes" rev-parse HEAD)" = cbe16e978f14654ebec4610c9d566089e4ee771e

cd "$upstream"
openjpeg="$upstream/build/build/src/openjpeg"
mkdir -p "$openjpeg"
git -C "$openjpeg" init --quiet
git -C "$openjpeg" fetch --depth 1 https://github.com/uclouvain/openjpeg.git 8314119b067c0fc77834731168daaebd379fdb12
git -C "$openjpeg" checkout --detach FETCH_HEAD
python3 wasm/build_wasm.py --release --enable-jpg
mkdir -p "$root/vendor/licenses"
cp build/eccodes/eccodes.js "$root/vendor/eccodes-module.cjs"
cp build/eccodes/index.js "$root/vendor/eccodes-wrapper.cjs"
gzip -n -9 -c build/eccodes/eccodes.wasm > "$root/vendor/eccodes.wasm.gz"
cp eccodes/NOTICE "$root/vendor/licenses/ecCodes-NOTICE"
cp build/build/src/libaec/LICENSE.txt "$root/vendor/licenses/libaec-LICENSE"
cp build/build/src/openjpeg/LICENSE "$root/vendor/licenses/OpenJPEG-LICENSE"
python3 - "$root/vendor/licenses" <<'PY'
from pathlib import Path
import sys

for notice in Path(sys.argv[1]).iterdir():
    text = "\n".join(line.rstrip() for line in notice.read_text().splitlines())
    notice.write_text(text.rstrip() + "\n")
PY
