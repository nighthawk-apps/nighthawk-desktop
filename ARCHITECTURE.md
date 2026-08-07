# Architecture

- Frontend: Lit web components (`src/web`) → Tauri IPC
- Backend: Tauri commands wrap sibling `darkfi-mobile-ffi` (same UniFFI crate as mobile)
- Secrets: local disk vault (`secure_store.rs`) — desktop-sealed AES-GCM, no user PIN / not OS keyring
- Mining: spawns bundled/system xmrig with payout = wallet deposit address
- Networks: isolated encrypted `wallet.db` dirs under Application Support (upstream turso/aegis256 via FFI)
