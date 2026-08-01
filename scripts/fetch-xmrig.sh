#!/usr/bin/env bash
# Fetch / copy xmrig sidecars into src-tauri/binaries/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/binaries"
mkdir -p "$BIN"

triple="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
# Tauri externalBin looks for binaries/xmrig-<triple>
dest="$BIN/xmrig-$triple"

if [[ -x /opt/homebrew/bin/xmrig ]]; then
  cp -f /opt/homebrew/bin/xmrig "$dest"
  chmod +x "$dest"
  # Also keep un-suffixed name used in some resource lookups
  cp -f "$dest" "$BIN/xmrig-$triple"
  echo "Copied Homebrew xmrig -> $dest"
elif command -v xmrig >/dev/null; then
  cp -f "$(command -v xmrig)" "$dest"
  chmod +x "$dest"
  echo "Copied PATH xmrig -> $dest"
else
  echo "Install xmrig (brew install xmrig) or place binary at $dest" >&2
  exit 1
fi

ls -la "$BIN"
