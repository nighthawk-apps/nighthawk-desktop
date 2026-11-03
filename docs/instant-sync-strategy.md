# Instant Sync Strategy — Nighthawk Desktop (Tauri)

> **Last updated**: 2026-09-07
>
> This document describes the instant sync changes planned across all Nighthawk
> platforms. The Desktop app **consumes** the `darkfi-mobile-ffi` Rust crate
> from the Android repo via a Cargo path dependency
> (`../../nighthawk-android-wallet/rust/darkfi-mobile-ffi`).

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
| `nighthawk-android-wallet/rust/darkfi-mobile-ffi/proto/lightwallet.proto` | source | Desktop does not compile a local proto copy |

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

## Proto

The Tauri app does not compile a proto. `src-tauri/build.rs` only calls
`tauri_build::build()`. Live gRPC types come from
`nighthawk-android-wallet/rust/darkfi-mobile-ffi/proto/lightwallet.proto`.
There is no desktop proto copy to keep in sync.

## Execution Order

1. Land proto changes in the Android FFI crate
2. `cargo build` in `src-tauri/` to verify compilation
3. Update `commands.rs` for new `LightSyncDto` fields
4. Update `settings-screen.ts` for proto mismatch banner

## `scan_blocks` Rejection

Desktop inherits the `darkfi-mobile-ffi` gate — `scan_blocks` is not callable.

## See Also

- [ARCHITECTURE.md](../ARCHITECTURE.md) — Desktop architecture overview
