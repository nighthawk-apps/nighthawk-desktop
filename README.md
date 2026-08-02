# Nighthawk Desktop

Cross-platform DarkFi wallet for desktop ([`nighthawk-apps/nighthawk-desktop`](https://github.com/nighthawk-apps/nighthawk-desktop)):

- **Lit** UI (Chat · Wallet · Transfer · **Mine** · Settings)
- **Tauri 2** Rust host
- Same **`darkfi-mobile-ffi`** UniFFI crate as Android / iOS (tip `drk` turso/aegis256 wallet, UnifOMR sync, DarkIRC, send/receive)
- Local **PIN vault** (AES-GCM + PBKDF2-HMAC-SHA256, 600k iterations) for seed + `wallet_pass`
- Separate data dirs per **testnet / mainnet**, plus optional **multi-wallet** profiles
- Product surface: tokens, memos, DAO, Arti Tor, DarkIRC E2E DM, address book, fee tiers
- Bundled **xmrig** mining to your deposit address via local darkfid stratum
- UnifOMR Param2 limits: [`docs/unifomr_mvp_limits.md`](docs/unifomr_mvp_limits.md)

## Prerequisites

- Rust toolchain, Node 20+, `pnpm`
- macOS: Xcode CLT (for local macOS builds)
- Running **darkfi-lightwalletd** (default `http://127.0.0.1:9067`) for sync
- For mining: **darkfid** with stratum (`:18347` testnet / `:8347` mainnet)

## Repository layout

Path dependencies use **sibling directory names** (see `src-tauri/Cargo.toml`):

```text
parent/
  darkfi/                 # upstream DarkFi (pulled in by darkfi-mobile-ffi)
  darkfi-lightwalletd/    # lightwalletd + UnifOMR reference
  darkfi-mobile-ffi/      # shared UniFFI crate (required to build)
  nighthawk-desktop/      # this repo
  # optional:
  nighthawk-android-wallet/
  nighthawk-ios-wallet/
  moonshine/
```

Place or symlink the mobile UniFFI crate at `../darkfi-mobile-ffi` next to this repo
(`src-tauri/Cargo.toml` resolves it as `../../darkfi-mobile-ffi`). You can symlink from a
mobile client tree’s `rust/darkfi-mobile-ffi` directory.

`src-tauri/Cargo.lock` is committed so release builds stay reproducible.

## Develop

```bash
cd nighthawk-desktop
pnpm install
# Optional if the default cargo git cache is not writable:
#   export CARGO_HOME=$HOME/.cargo-nh
pnpm tauri dev
```

## Build

```bash
pnpm tauri build
```

## xmrig sidecar

Place platform binaries under `src-tauri/binaries/` named for Tauri externals:

- `xmrig-aarch64-apple-darwin`
- `xmrig-x86_64-apple-darwin`
- `xmrig-x86_64-unknown-linux-gnu`
- `xmrig-x86_64-pc-windows-msvc.exe`

Or install system `xmrig` — the app can fall back to `/opt/homebrew/bin/xmrig` on macOS.

```bash
./scripts/fetch-xmrig.sh
```

## Data paths (macOS)

`~/Library/Application Support/nighthawk-app-desktop/`

- `prefs.json`
- `{testnet,mainnet}/wallet.db` (turso + experimental aegis256; wipe after DarkFi pin bumps that change wallet format)
- `{testnet,mainnet}/cache/`
- `{testnet,mainnet}/darkirc_db/`
- PIN vault: `vault.meta.json` + `vault.dat` (no Keychain prompts)

## Privacy / Tor

`use_tor` defaults to **false** in prefs for local/dev convenience. For any non-loopback lightwalletd or DarkIRC use, **enable Tor** (Settings → Tor / `use_tor: true`) so sync and chat traffic exit via Arti rather than clearnet.

## Mine tab

Unlock wallet → Mine → set threads → Start. Payouts go to `primary_deposit_address`. Stratum URL is editable in Settings.
