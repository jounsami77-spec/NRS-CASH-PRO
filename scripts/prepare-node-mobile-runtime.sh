#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="24.22.1-0"
TAG="v${VERSION}"
REPO="fogtape/nodejs-mobile"
ROOT="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v curl >/dev/null
command -v python3 >/dev/null
command -v unzip >/dev/null
command -v sha256sum >/dev/null

API="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"
curl -fsSL --retry 3 --max-time 90 "$API" -o "$TMP/release.json"

ASSET="nodejs-mobile-android-${VERSION}.zip"

python3 - "$TMP/release.json" "$ASSET" "$TMP/urls.txt" <<'PY'
import json, sys
d=json.load(open(sys.argv[1]))
wanted=sys.argv[2]
assets=d.get("assets", [])
archive=[a for a in assets if a.get("name")==wanted]
sums=[a for a in assets if "sha256" in a.get("name","").lower()
      or "checksum" in a.get("name","").lower()]
if len(archive)!=1:
    raise SystemExit("لم أجد ملف runtime الكامل المتوقع: "+wanted)
if not sums:
    raise SystemExit("لا يوجد ملف checksums منشور؛ رفض تنزيل runtime دون تحقق")
with open(sys.argv[3],"w") as f:
    f.write(archive[0]["browser_download_url"]+"\n")
    f.write(sums[0]["browser_download_url"]+"\n")
print("Runtime:", wanted)
print("Release:", d.get("html_url"))
print("Prerelease:", d.get("prerelease"))
PY

mapfile -t URLS < "$TMP/urls.txt"
curl -fL --retry 3 --max-time 600 "${URLS[0]}" -o "$TMP/runtime.zip"
curl -fL --retry 3 --max-time 120 "${URLS[1]}" -o "$TMP/checksums"

python3 - "$TMP/checksums" "$ASSET" "$TMP/expected.sha" <<'PY'
import re, sys
text=open(sys.argv[1],errors="replace").read()
name=sys.argv[2]
for line in text.splitlines():
    m=re.match(r"^\s*([a-fA-F0-9]{64})\s+\*?(.+?)\s*$",line)
    if m and m.group(2).split("/")[-1]==name:
        open(sys.argv[3],"w").write(m.group(1).lower())
        print("وجدت SHA-256 المنشور.")
        break
else:
    raise SystemExit("لم يتطابق اسم ملف runtime مع ملف SHA-256")
PY

EXPECTED="$(cat "$TMP/expected.sha")"
ACTUAL="$(sha256sum "$TMP/runtime.zip" | awk '{print $1}')"
[[ "$EXPECTED" == "$ACTUAL" ]] || {
  echo "EXPECTED=$EXPECTED"
  echo "ACTUAL=$ACTUAL"
  exit 1
}
echo "SHA-256: OK"

mkdir -p "$TMP/unpack"
unzip -q "$TMP/runtime.zip" -d "$TMP/unpack"

LIB="$(find "$TMP/unpack" -type f \
  -path '*/arm64-v8a/libnode.so' -print -quit)"
HEADER="$(find "$TMP/unpack" -type f \
  -path '*/include/node/node.h' -print -quit)"

[[ -n "$LIB" && -f "$LIB" ]] || {
  echo "لم أجد libnode.so لمعمارية arm64-v8a"
  exit 1
}
[[ -n "$HEADER" && -f "$HEADER" ]] || {
  echo "لم أجد include/node/node.h"
  exit 1
}

DEST="$ROOT/android/app/src/main"
mkdir -p "$DEST/jniLibs/arm64-v8a" "$DEST/cpp/include"
install -m 0644 "$LIB" "$DEST/jniLibs/arm64-v8a/libnode.so"

rm -rf "$DEST/cpp/include/node"
cp -a "$(dirname "$HEADER")" "$DEST/cpp/include/node"

[[ -s "$DEST/jniLibs/arm64-v8a/libnode.so" ]]
[[ -s "$DEST/cpp/include/node/node.h" ]]

echo "Runtime جاهز: arm64-v8a"
