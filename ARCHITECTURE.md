# Architecture

- Frontend: Lit web components (`src/web`) → Tauri IPC
- Backend: Tauri commands wrap sibling `darkfi-mobile-ffi` (same UniFFI crate as mobile)
- Secrets: OS keyring (`secure_store.rs`)
- Mining: spawns bundled/system xmrig with payout = wallet deposit address
- Networks: isolated encrypted `wallet.db` dirs under Application Support (upstream turso/aegis256 via FFI)
