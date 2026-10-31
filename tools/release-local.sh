#!/usr/bin/env bash
# 本地发版：构建 → 签名 → 校验证书 → 发布 Release。不走 CI。
#
#   bash tools/release-local.sh build     # 检查版本一致 + 跑测试 + 构建并签名 APK
#   bash tools/release-local.sh publish   # 上传到 GitHub Release（建或更新，正文取 release-notes/vX.Y.Z.md）
#
# 硬约束：
#   - 只上传「已签名」的 dyapp-X.Y.Z-universal.apk，绝不上传 -unsigned。
#   - 必须用 ~/.android/debug.keystore 签：证书与旧版不同，系统会拒绝覆盖安装，用户只能卸载重装（存档会丢）。
#   - 令牌只从 git 凭据管理器取，单条命令内用完即弃，不 export、不写文件、不打印。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
REPO="wacilimonster-source/dyapp"
VER="$(tr -d '[:space:]' < VERSION)"
TAG="v$VER"
APK_DIR="$ROOT/app/src-tauri/gen/android/app/build/outputs/apk/universal/release"
OUT_APK="$APK_DIR/dyapp-$VER-universal.apk"
OUT_ZIP="$ROOT/dist/dyapp-prototype-$TAG.zip"
BT="${BUILD_TOOLS:-G:/Android/build-tools/35.0.0}"
KS="$HOME/.android/debug.keystore"
# debug.keystore 的 SHA-256 证书指纹（去掉冒号，小写）。换了证书这里会拦住。
EXPECT_SHA256="e436a586cde571929d012c964d02a1cca45632abcdb662745b734ddfdb274f06"

die() { echo "错误：$*" >&2; exit 1; }

check_versions() {
  local js tauri cargo
  js="$(sed -n "s/.*const VERSION = '\([^']*\)'.*/\1/p" prototype/update.js | head -1)"
  tauri="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' app/src-tauri/tauri.conf.json | head -1)"
  cargo="$(sed -n 's/^version = "\([^"]*\)".*/\1/p' app/src-tauri/Cargo.toml | head -1)"
  echo "VERSION=$VER  update.js=$js  tauri.conf.json=$tauri  Cargo.toml=$cargo"
  [ "$js" = "$VER" ] && [ "$tauri" = "$VER" ] && [ "$cargo" = "$VER" ] || die "四处版本号不一致"
  [ -f "release-notes/$TAG.md" ] || die "缺少 release-notes/$TAG.md"
}

do_build() {
  check_versions
  echo "== 前端测试 =="
  node --experimental-vm-modules tools/check-syntax.mjs | tail -1
  node --test tests/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"
  echo "== Rust 检查 =="
  export PATH="$HOME/.cargo/bin:$PATH"
  (cd app/src-tauri && cargo fmt --check && cargo test 2>&1 | grep -E "^test result")

  echo "== 构建 APK =="
  export ANDROID_HOME="${ANDROID_HOME:-G:\\Android}"
  export NDK_HOME="${NDK_HOME:-G:/Android/ndk/27.0.12077973}"
  (cd app && cargo tauri android build --apk)

  local unsigned="$APK_DIR/app-universal-release-unsigned.apk"
  [ -f "$unsigned" ] || die "没找到未签名产物：$unsigned"
  [ "$unsigned" -nt VERSION ] || die "未签名产物比 VERSION 还旧，构建可能没有真正执行"

  echo "== 对齐并签名 =="
  local tmp; tmp="$(mktemp -d)"
  cp "$unsigned" "$tmp/aligned.apk"
  "$BT/zipalign.exe" -f -p 4 "$tmp/aligned.apk" "$tmp/signed.apk"
  rm -f "$OUT_APK" "$OUT_APK.idsig"
  "$BT/apksigner.bat" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
    --ks-key-alias androiddebugkey --out "$OUT_APK" "$tmp/signed.apk"
  rm -rf "$tmp"
  verify_apk
}

verify_apk() {
  [ -f "$OUT_APK" ] || die "没有 $OUT_APK，先跑 build"
  echo "== 校验签名与证书 =="
  local certs; certs="$("$BT/apksigner.bat" verify --print-certs "$OUT_APK" | tr -d '\r')"
  echo "$certs" | head -3
  echo "$certs" | grep -qi "SHA-256 digest: $EXPECT_SHA256" \
    || die "证书指纹与 debug.keystore 不符：覆盖安装会失败，停止"
  local ver; ver="$("$BT/aapt2.exe" dump badging "$OUT_APK" | tr -d '\r' | sed -n "s/.*versionName='\([^']*\)'.*/\1/p" | head -1)"
  [ "$ver" = "$VER" ] || die "APK 的 versionName=$ver，与 VERSION=$VER 不符"
  echo "OK：versionName=$ver，证书指纹一致"
  ls -l "$OUT_APK"
}

do_publish() {
  check_versions
  verify_apk
  git diff --quiet && git diff --cached --quiet || die "工作区有未提交改动，先提交再发布"
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "本地没有 tag $TAG"
  [ "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse HEAD)" ] || die "tag $TAG 不在当前提交上"
  git ls-remote --exit-code origin "refs/tags/$TAG" >/dev/null 2>&1 || die "tag $TAG 还没推到远端，先 git push origin main $TAG"

  mkdir -p dist
  rm -f "$OUT_ZIP"
  (cd prototype && zip -qr "$OUT_ZIP" . -x '*.DS_Store' '*/__MACOSX/*')

  local token
  token="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')"
  [ -n "$token" ] || die "取不到 GitHub 凭据"
  if GH_TOKEN="$token" gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    GH_TOKEN="$token" gh release edit "$TAG" --repo "$REPO" --draft=false --notes-file "release-notes/$TAG.md"
  else
    GH_TOKEN="$token" gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes-file "release-notes/$TAG.md" --verify-tag
  fi
  GH_TOKEN="$token" gh release upload "$TAG" "$OUT_APK" "$OUT_ZIP" --repo "$REPO" --clobber
  GH_TOKEN="$token" gh release view "$TAG" --repo "$REPO" --json tagName,isDraft,url,assets \
    --jq '{tag:.tagName,draft:.isDraft,url:.url,assets:[.assets[]|{name,size}]}'
}

case "${1:-}" in
  build) do_build ;;
  publish) do_publish ;;
  *) echo "用法：bash tools/release-local.sh build|publish"; exit 2 ;;
esac
