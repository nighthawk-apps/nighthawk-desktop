# Fable 5.1 security audit — nighthawk-app-desktop

**Audit date:** 2026-09-20  
**Model:** Claude Fable 5.1  
**Review date:** 2026-09-21  
**Shipped revision:** `7ca773a` (v3.0.14)  

Full auditor transcript:

- [`fable-5.1-audit-desktop-moonshine-lwd-source.md`](fable-5.1-audit-desktop-moonshine-lwd-source.md) — subagent `7747fe26`

---

## MUST-FIX status (this repo)

| ID | Finding | Status | Evidence |
|----|---------|--------|----------|
| D1 | openWallet fail → Create overwrites vault | **FIXED** | `secure_store.rs` `write_vault_files(..., overwrite)`; refuses if vault exists |
| D2 | Sync / prove on main thread freezes UI | **FIXED** | Wallet open / sync / prove via `spawn_blocking` in `commands.rs` (2026-09-21: added missing `move` on DAO/reorg closures so `cargo check --release` passes) |
| D3 | `remove_profile` path traversal | **FIXED** | `wallets.rs` canonicalize + root containment check |
| D4 | create doesn’t clear old wallet/session | **PARTIAL** | Overwrite guard landed; confirm create path clears session on switch |
| D5 | loopback LWD + `use_tor: false` defaults | **FIXED** | `prefs.rs` `use_tor: true` (default + test) |

## SHOULD-FIX (deferred)

Legacy plaintext key in meta; `file_master_key` create-on-read; no zeroize; DM secret in webview; ungated `backup_mnemonic`; create/restore skip `validate_lwd_url`; stratum cleartext; unbounded xmrig.log; CSP / seed in DOM; machine-specific FFI path — see source audit § D6–D23.
