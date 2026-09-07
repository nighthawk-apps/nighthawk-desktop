# Instant Sync Strategy — Nighthawk Desktop (Tauri)

> **Last updated**: 2026-09-07
>
> This document describes the instant sync changes planned across all Nighthawk
> platforms. The Desktop app **consumes** the `darkfi-mobile-ffi` Rust crate
> from the Android repo via a Cargo path dependency
> (`../../new-nighthawk-android-wallet/rust/darkfi-mobile-ffi`).

## Philosophy

Port DarkFi contracts + wire formats. Keep UniFFI + LWD. Do **not** port the
official GUI or its `darkfid` JSON-RPC scanner. Official `scan_blocks` into
Nighthawk would be a regression.

## Platform Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                    darkfi-mobile-ffi (Rust)                        │
│  proto/lightwallet.proto · sync.rs · lightwallet_client.rs         │
│  omr.rs · unifomr.rs · bootstrap.rs · birthday.rs                 │
│  NEW: checkpoint.rs · sync_pipeline.rs · zkas_cache.rs             │
├────────────┬────────────┬──────────────┬──────────────────────────┤
│  Android   │    iOS     │   Desktop    │      Moonshine           │
│  UniFFI    │  UniFFI    │  Cargo dep   │  Own sync.rs/client.rs   │
│  (Kotlin)  │  (Swift)   │  (Tauri)     │  (standalone Rust CLI)   │
└────────────┴────────────┴──────────────┴──────────────────────────┘
```

## Desktop Impact

**Most changes auto-propagate** because `Cargo.toml` references
`darkfi-mobile-ffi` from the Android workspace. When Android's FFI crate is
updated, `cargo build` in `src-tauri/` picks up the changes automatically.

### Desktop-Specific Changes

| File | Action | Reason |
|------|--------|--------|
| `src-tauri/src/commands.rs` | MODIFY | Expose `proto_version_mismatch` in `LightSyncDto` |
| `src/web/components/settings-screen.ts` | MODIFY | Show proto mismatch warning banner in UI |
| `src-tauri/proto/lightwallet.proto` | SYNC | Keep in sync with Android's proto for documentation |

### Auto-Propagated Changes (via Cargo path dep)

| # | Change | Auto-propagates? |
|---|--------|:----------------:|
| 1a | Historical `GetTreeState` | ✅ |
| 1b | Concurrent gRPC — remove global lock | ✅ |
| 1c | Checkpoint / snapshot instant restore | ✅ |
| 1d | OMR/PIR metering | ✅ |
| 2a | Birthday enforcement | ✅ |
| 2b | Pipeline OMR prefetch | ✅ |
| 2c | OMR-first audit | ✅ |
| 2d | ZkAS / proving key cache | ✅ |
| 2e | Proto version lockstep | ✅ (Rust), manual (TS UI) |

## Proto Sync

The Desktop repo has its own `src-tauri/proto/lightwallet.proto` which is
currently **divergent** from mobile's (missing streaming `DetectionKeyChunk`,
`omr_metadata_enc` fields). This proto is not compiled by the Tauri app
(it uses `darkfi-mobile-ffi`'s proto), but should be kept in sync for
documentation and any standalone testing tools.

### Proto Divergences to Resolve

| Feature | Mobile (source) | Desktop (current) |
|---------|-----------------|-------------------|
| `GetUnifOmrDigest` | `stream DetectionKeyChunk` | `OmrDigestRequest` |
| `CompactOutput.omr_metadata_enc` | Present (field 6) | Missing |
| `RawTransaction.omr_metadata_enc` | Present (field 4) | Missing |
| `LightInfo.directory_attest_pubkey` | Present (field 9) | Missing |

## Execution Order

1. Sync `src-tauri/proto/lightwallet.proto` from Android
2. Wait for Android FFI changes to land
3. `cargo build` in `src-tauri/` to verify compilation
4. Update `commands.rs` for new `LightSyncDto` fields
5. Update `settings-screen.ts` for proto mismatch banner

## `scan_blocks` Rejection

Desktop inherits the `darkfi-mobile-ffi` gate — `scan_blocks` is not callable.

## See Also

- [ARCHITECTURE.md](../ARCHITECTURE.md) — Desktop architecture overview
