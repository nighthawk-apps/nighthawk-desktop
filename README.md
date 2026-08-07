# Nighthawk Desktop

Cross-platform DarkFi wallet for desktop ([`nighthawk-apps/nighthawk-desktop`](https://github.com/nighthawk-apps/nighthawk-desktop)):

- **Lit** UI (Chat · Wallet · Transfer · **Mine** · Settings)
- **Tauri 2** Rust host
- Same **`darkfi-mobile-ffi`** UniFFI crate as Android (tip `drk` turso/aegis256 wallet, UnifOMR sync, DarkIRC, send/receive)
- Local **disk vault** (AES-GCM + PBKDF2) for seed + `wallet_pass` — **no app PIN**; the wallet opens automatically. Treat the data directory as sensitive (anyone with the files can decrypt).
- Separate data dirs per **testnet / mainnet**, plus optional **multi-wallet** profiles
- Product surface: tokens, memos, DAO, Arti Tor, DarkIRC E2E DM, address book
- Bundled **xmrig** mining to your deposit address via local darkfid stratum
- **Tor on by default** for remote lightwalletd / chat (embedded Arti). Default testnet LWD is the Studio ngrok HTTPS endpoint (with TLS pin); switch URL in Settings if needed.
- **Trial-decrypt fallback (default on):** receives payments from non-UnifOMR wallets (e.g. upstream `drk`) by trial-decrypting compact blocks when UnifOMR finds no matches. Toggle **Strict UnifOMR sync** in Settings to make sync UnifOMR-only (more private / faster when counterparties also use UnifOMR).
- UnifOMR Param2 limits: [`docs/unifomr_mvp_limits.md`](docs/unifomr_mvp_limits.md)

## Prerequisites

- Rust toolchain, Node 20+, `pnpm`
- macOS: Xcode CLT (for local macOS builds)
- Reachable **darkfi-lightwalletd** (default testnet: Studio ngrok HTTPS; or local `http://127.0.0.1:9067`)
- For mining: **darkfid** with stratum (`:18347` testnet / `:8347` mainnet)

## Repository layout

Path dependencies use **sibling directory names** (see `src-tauri/Cargo.toml`):

```text
parent/
  darkfi/                          # upstream DarkFi (via mobile FFI third_party)
  darkfi-lightwalletd/             # lightwalletd + UnifOMR reference
  new-nighthawk-android-wallet/    # provides rust/darkfi-mobile-ffi (required)
  nighthawk-app-desktop/           # this repo
  # optional:
  nighthawk-ios-wallet/
  moonshine/
```

`src-tauri/Cargo.toml` path-depends on:

```text
../../new-nighthawk-android-wallet/rust/darkfi-mobile-ffi
```

Do **not** point at a `darkfi-mobile-ffi` symlink at the GitHub root — Cargo resolves the FFI crate’s relative `third_party/darkfi` from the real Android tree path.

`src-tauri/Cargo.lock` is committed so release builds stay reproducible.

## Develop

```bash
cd nighthawk-app-desktop
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
- Local vault: `vault.meta.json` + `vault.dat` (desktop-sealed, **not** a user PIN)

## Privacy / Tor

`use_tor` defaults to **true**. Remote lightwalletd and DarkIRC exit via Arti SOCKS. Disable Tor in Settings only for loopback/dev testing.

Changing LWD URL, TLS pin, Tor, or network closes the open wallet handle — reopen the wallet after Save.

## Mine tab

Unlock wallet → Mine → set threads → Start. Payouts go to `primary_deposit_address`. Stratum URL is editable in Settings.
