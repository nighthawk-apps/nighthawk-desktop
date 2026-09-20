# Architecture

- Frontend: Lit web components (`src/web`) → Tauri IPC
- Backend: Tauri commands wrap sibling `darkfi-mobile-ffi` (same UniFFI crate as mobile)
- Secrets: local vault (`secure_store.rs`) — AES-256-GCM ciphertext on disk; master key in the OS keychain (`keyring`). No user PIN. Legacy v2 vaults used PBKDF2.
- Mining: spawns bundled/system xmrig with payout = wallet deposit address
- Networks: isolated encrypted `wallet.db` dirs under Application Support (upstream turso/aegis256 via FFI)
