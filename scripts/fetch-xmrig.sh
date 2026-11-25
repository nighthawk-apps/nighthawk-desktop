#!/usr/bin/env bash
# Fetch / copy xmrig sidecars into src-tauri/binaries/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/binaries"
mkdir -p "$BIN"

triple="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
# Tauri externalBin looks for binaries/xmrig-<triple>
dest="$BIN/xmrig-$triple"

copy_if_distinct() {
  local src="$1"
  local dst="$2"
  local src_real dst_real
  src_real="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
  dst_real="$(cd "$(dirname "$dst")" && pwd)/$(basename "$dst")"
  if [[ "$src_real" != "$dst_real" ]]; then
    cp -f "$src" "$dst"
  fi
  chmod +x "$dst"
}

if [[ -x /opt/homebrew/bin/xmrig ]]; then
  copy_if_distinct /opt/homebrew/bin/xmrig "$dest"
  echo "Copied Homebrew xmrig -> $dest"
elif command -v xmrig >/dev/null; then
  src="$(command -v xmrig)"
  copy_if_distinct "$src" "$dest"
  echo "Copied PATH xmrig -> $dest"
else
  echo "Install xmrig (brew install xmrig) or place binary at $dest" >&2
  exit 1
fi

ls -la "$BIN"
