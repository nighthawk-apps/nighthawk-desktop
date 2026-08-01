# UnifOMR limits (nighthawk-app-desktop)

**Active crypto profile:** paper Table-1 **Param2** (ePrint 2026/910), with noted interim gaps below.

**SHIP NOTICE — `R_PRIME`:** Active code uses interim `R_PRIME = 32768`. Paper Param2 lists `r′ = 149` **after** digest modulus-switch (`Q→Q′=q`). That mod-switch is **not** wired yet. **Do not cite paper `ϵp` / `ϵn` (or any paper FP/FN rates) in release notes, audits, or marketing until mod-switch lands and FP is re-measured on this stack.**

**Archived MVP profile:** see [`unifomr_mvp_archive.md`](./unifomr_mvp_archive.md) (fork reference; constants are not kept in source).

## Ops hardening (retained across Param2 — do not remove)

These are independent of Table-1 parameters:

- UnifOMR-only / no silent PerfOMR fallback
- Detection-key count cap (**16**)
- Per-peer OMR / clue rate limits
- Hard gRPC / detection-key **size ceilings** (raised for Param2 keys; still enforced)
- TLS pin / remote HTTPS fail-closed on clients
- Clue PK directory decoys + ≥250 ms timing pad
- Clue hint TTL (**24h**) + SendTransaction peer bind
- Malformed-clue rejection (LWEmongrass)
- Multi `detection_keys` + framed multi-digest
- Supplemental trial decrypt on empty OMR (clients)
- MoneyNote memo on wire + sparse sync / tip notify

## Protocol deviations still in place (not Param2 table params)

1. **Any-match multi-clue** — per-clue BFV layers + client OR (not homomorphic product).
2. **SealPIR-style striped PIR** — BFV stripes, length-prefixed limbs; windows up to `8 × D` (`D=4096` under Param2). Not a full SealPIR Galois expander.
3. **Clue PK directory** — always `found=true` + decoy PK + timing pad; unregistered receivers use supplemental trial decrypt.
4. **Digest modulus-switch** — paper Param2 uses `Q→Q′=q` so `r′=149`. The current `fhe` path does **not** yet apply free-standing digest mod-switch; `R_PRIME` is an **interim** ceiling. **Do not cite paper `ϵp`/`ϵn` until mod-switch lands and FP is re-measured.**
5. **`ℓ=2`** — constant is Param2; Round-1 partial decrypt still evaluates coefficient 0 first (multi-bit AND follow-up).

## Active Param2 structural parameters

| Param | Value |
|-------|--------|
| `n` (`CLUE_N`) | 1024 |
| `q` (`CLUE_Q` = BFV `t`) | 1032193 |
| `h` (`CLUE_H`) | 80 |
| `r` (`CLUE_ERROR_BOUND`) | 84 |
| `ℓ` | 2 |
| BFV `D` | 4096 |
| BFV moduli sizes | `[40, 40, 40]` |
| `R_PRIME` (`r′`) | **32768 interim** (paper 149 after mod-switch — **not claimed**) |

Detection keys are larger than MVP (~2× BFV degree); gRPC decode/encode limits are **128 MB**; detection-key count remains capped at **16**.

## Cross-client parity (required)

| Component | LWD | Moonshine | iOS FFI | Android FFI | Desktop |
|-----------|-----|-----------|---------|-------------|---------|
| Param2 `unifomr` constants | ✓ | via LWD | ✓ (synced copy) | ✓ (synced copy) | via Android FFI |
| Length-prefixed PIR limbs | ✓ | via LWD | ✓ | ✓ | via FFI |
| Ops hardening above | ✓ | ✓ | ✓ | ✓ | ✓ (TLS pin via prefs) |
| Supplemental trial on empty OMR | — | ✓ | ✓ | ✓ | via FFI |

Malformed UnifOMR clues are rejected at validation; clients fall back to trial decrypt over the window when OMR returns no matches (including decoy-directory / unregistered receivers).

## TLS for funded / remote e2e

See [`TLS_PINNING.md`](./TLS_PINNING.md) and:

```bash
./scripts/generate_tls_cert.sh self-signed --domain studio.local
# or: ./scripts/generate_tls_cert.sh letsencrypt --domain lw.example.com --email ops@example.com
```

Distribute `scripts/certs/LIGHTWALLET_TLS_PIN_SHA256.txt` to every client before HTTPS e2e.


## Desktop note

Desktop uses the sibling `darkfi-mobile-ffi` path dependency (`../../darkfi-mobile-ffi` from `src-tauri`) for UnifOMR/PIR (same Param2 constants as LWD). Ops hardening (TLS pin, multi detection keys, memo) is wired through Tauri prefs/bootstrap.
