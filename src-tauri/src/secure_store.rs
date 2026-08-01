//! PIN-sealed local vault (no macOS Keychain prompts).
//!
//! Secrets live in `vault.dat` (AES-256-GCM), unlocked with the user PIN via PBKDF2.
//! A small `vault.meta.json` holds salt + PIN hash for existence / verify without
//! decrypting. Optional one-time migration from the old multi-item keyring layout.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

const PBKDF2_ITERS: u32 = 600_000;
const META_VERSION: u32 = 1;
const MIN_PIN_LEN: usize = 6;

/// Reject trivially weak PINs (too short or all identical digits).
fn validate_pin_strength(pin: &str) -> Result<()> {
    if pin.len() < MIN_PIN_LEN {
        return Err(anyhow!("PIN must be at least {MIN_PIN_LEN} digits"));
    }
    let chars: Vec<char> = pin.chars().collect();
    if !chars.is_empty() && chars.iter().all(|c| *c == chars[0]) {
        return Err(anyhow!("PIN cannot be all the same digit"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultMeta {
    version: u32,
    salt_hex: String,
    pin_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultPayload {
    mnemonic: String,
    wallet_pass: String,
}

struct Session {
    mnemonic: Vec<String>,
    wallet_pass: String,
}

static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

fn session() -> &'static Mutex<Option<Session>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

fn vault_dir() -> PathBuf {
    crate::paths::wallet_data_root()
}

fn meta_path() -> PathBuf {
    vault_dir().join("vault.meta.json")
}

fn data_path() -> PathBuf {
    vault_dir().join("vault.dat")
}

fn ensure_vault_dir() -> Result<()> {
    fs::create_dir_all(vault_dir()).context("create app data dir")
}

fn derive_key(pin: &str, salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha256>(pin.as_bytes(), salt, PBKDF2_ITERS, &mut out);
    out
}

fn hash_pin(pin: &str, salt: &[u8]) -> String {
    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha256>(pin.as_bytes(), salt, PBKDF2_ITERS, &mut out);
    hex::encode(out)
}

fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| anyhow!("{e}"))?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut out = nonce_bytes.to_vec();
    out.extend(
        cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| anyhow!("encrypt vault: {e}"))?,
    );
    Ok(out)
}

fn open_seal(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 13 {
        return Err(anyhow!("corrupt vault"));
    }
    let (nonce_bytes, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| anyhow!("{e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ct)
        .map_err(|_| anyhow!("Invalid PIN or corrupt vault"))
}

fn read_meta() -> Result<Option<VaultMeta>> {
    let path = meta_path();
    if !path.exists() {
        return Ok(None);
    }
    let s = fs::read_to_string(&path).context("read vault meta")?;
    Ok(Some(serde_json::from_str(&s).context("parse vault meta")?))
}

fn write_meta(meta: &VaultMeta) -> Result<()> {
    ensure_vault_dir()?;
    let s = serde_json::to_string_pretty(meta)?;
    fs::write(meta_path(), s).context("write vault meta")
}

fn write_vault_files(pin: &str, mnemonic: &[String], wallet_pass: &str) -> Result<()> {
    ensure_vault_dir()?;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(pin, &salt);
    let payload = VaultPayload {
        mnemonic: mnemonic.join(" "),
        wallet_pass: wallet_pass.to_string(),
    };
    let plain = serde_json::to_vec(&payload)?;
    let sealed = seal(&key, &plain)?;
    fs::write(data_path(), sealed).context("write vault.dat")?;
    write_meta(&VaultMeta {
        version: META_VERSION,
        salt_hex: hex::encode(salt),
        pin_hash: hash_pin(pin, &salt),
    })?;
    Ok(())
}

fn decrypt_payload(pin: &str) -> Result<VaultPayload> {
    let meta = read_meta()?.ok_or_else(|| anyhow!("No wallet on this device"))?;
    let salt = hex::decode(&meta.salt_hex).context("bad salt")?;
    if hash_pin(pin, &salt) != meta.pin_hash {
        return Err(anyhow!("Invalid PIN"));
    }
    let blob = fs::read(data_path()).context("read vault.dat")?;
    let key = derive_key(pin, &salt);
    let plain = open_seal(&key, &blob)?;
    serde_json::from_slice(&plain).context("parse vault payload")
}

fn lock_session() {
    *session().lock() = None;
}

fn unlock_into_session(pin: &str) -> Result<()> {
    let payload = decrypt_payload(pin)?;
    *session().lock() = Some(Session {
        mnemonic: payload
            .mnemonic
            .split_whitespace()
            .map(|w| w.to_string())
            .collect(),
        wallet_pass: payload.wallet_pass,
    });
    Ok(())
}

// --- Legacy keyring migration (one-time; then keyring is unused) ---

const LEGACY_SERVICE: &str = "com.nighthawkapps.desktop";
const LEGACY_PASS: &str = "wallet_pass";
const LEGACY_SEED: &str = "seed_mnemonic";
const LEGACY_PIN: &str = "pin_hash";
const LEGACY_NETWORK: &str = "active_network";

fn legacy_get(key: &str) -> Result<Option<String>> {
    match keyring::Entry::new(LEGACY_SERVICE, key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn legacy_delete(key: &str) {
    if let Ok(e) = keyring::Entry::new(LEGACY_SERVICE, key) {
        let _ = e.delete_credential();
    }
}

fn legacy_verify_pin(pin: &str) -> Result<bool> {
    let Some(payload) = legacy_get(LEGACY_PIN)? else {
        return Ok(false);
    };
    let (salt_hex, hash) = payload
        .split_once(':')
        .ok_or_else(|| anyhow!("corrupt legacy pin"))?;
    let salt = hex::decode(salt_hex)?;
    Ok(hash_pin(pin, &salt) == hash)
}

/// If old Keychain secrets exist and no file vault yet, migrate after PIN check.
fn migrate_legacy_if_needed(pin: &str) -> Result<bool> {
    if meta_path().exists() && data_path().exists() {
        return Ok(false);
    }
    if legacy_get(LEGACY_SEED)?.is_none() {
        return Ok(false);
    }
    if !legacy_verify_pin(pin)? {
        return Err(anyhow!("Invalid PIN"));
    }
    let mnemonic = legacy_get(LEGACY_SEED)?
        .ok_or_else(|| anyhow!("legacy seed missing"))?
        .split_whitespace()
        .map(|w| w.to_string())
        .collect::<Vec<_>>();
    let wallet_pass = legacy_get(LEGACY_PASS)?.ok_or_else(|| anyhow!("legacy pass missing"))?;
    write_vault_files(pin, &mnemonic, &wallet_pass)?;
    for k in [LEGACY_PASS, LEGACY_SEED, LEGACY_PIN, LEGACY_NETWORK] {
        legacy_delete(k);
    }
    Ok(true)
}

// --- Public API (keeps command glue simple) ---

/// Random 32-byte wallet pass (SQLCipher), Base64 — same pattern as mobile.
pub fn generate_wallet_pass() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    B64.encode(buf)
}

/// Persist a new wallet vault (create / restore). Replaces any existing vault.
pub fn create_vault(mnemonic: &[String], wallet_pass: &str, pin: &str) -> Result<()> {
    validate_pin_strength(pin)?;
    write_vault_files(pin, mnemonic, wallet_pass)?;
    *session().lock() = Some(Session {
        mnemonic: mnemonic.to_vec(),
        wallet_pass: wallet_pass.to_string(),
    });
    Ok(())
}

pub fn wallet_exists() -> bool {
    if vault_ready() {
        return true;
    }
    // Prior install with on-disk wallet — do NOT touch Keychain here.
    // A Keychain read on launch blocks the main thread behind a permission
    // dialog and leaves a blank/"Starting…" screen.
    wallet_db_present()
}

pub fn has_pin() -> Result<bool> {
    if read_meta()?.is_some() {
        return Ok(true);
    }
    Ok(wallet_db_present())
}

fn vault_ready() -> bool {
    meta_path().exists() && data_path().exists()
}

fn wallet_db_present() -> bool {
    let root = crate::paths::wallet_data_root();
    for net in ["testnet", "mainnet"] {
        if root.join(net).join("wallet.db").exists() {
            return true;
        }
    }
    // Legacy / other profiles under app root
    let app = crate::paths::app_root();
    for net in ["testnet", "mainnet"] {
        if app.join(net).join("wallet.db").exists() {
            return true;
        }
    }
    if let Ok(entries) = fs::read_dir(app.join("wallets")) {
        for e in entries.flatten() {
            for net in ["testnet", "mainnet"] {
                if e.path().join(net).join("wallet.db").exists() {
                    return true;
                }
            }
        }
    }
    false
}

pub fn verify_pin(pin: &str) -> Result<bool> {
    if let Some(meta) = read_meta()? {
        let salt = hex::decode(&meta.salt_hex)?;
        return Ok(hash_pin(pin, &salt) == meta.pin_hash);
    }
    legacy_verify_pin(pin)
}

/// Unlock secrets into the in-memory session (call after PIN OK).
pub fn unlock_session(pin: &str) -> Result<()> {
    if migrate_legacy_if_needed(pin)? {
        // migrated + files written; fall through to unlock
    }
    unlock_into_session(pin)
}

pub fn clear_session() {
    lock_session();
}

pub fn load_mnemonic() -> Result<Vec<String>> {
    session()
        .lock()
        .as_ref()
        .map(|s| s.mnemonic.clone())
        .ok_or_else(|| anyhow!("Wallet locked"))
}

pub fn load_wallet_pass() -> Result<String> {
    session()
        .lock()
        .as_ref()
        .map(|s| s.wallet_pass.clone())
        .ok_or_else(|| anyhow!("Wallet locked"))
}

/// Re-seal vault with a new PIN (session must already be unlocked).
pub fn set_pin(old_pin: &str, new_pin: &str) -> Result<()> {
    validate_pin_strength(new_pin)?;
    if !verify_pin(old_pin)? {
        return Err(anyhow!("Invalid PIN"));
    }
    // Ensure session has secrets (unlock if needed).
    if session().lock().is_none() {
        unlock_into_session(old_pin)?;
    }
    let (mnemonic, wallet_pass) = {
        let g = session().lock();
        let s = g.as_ref().ok_or_else(|| anyhow!("Wallet locked"))?;
        (s.mnemonic.clone(), s.wallet_pass.clone())
    };
    write_vault_files(new_pin, &mnemonic, &wallet_pass)?;
    *session().lock() = Some(Session {
        mnemonic,
        wallet_pass,
    });
    Ok(())
}

/// Unlock with PIN and return mnemonic (settings backup).
pub fn backup_mnemonic(pin: &str) -> Result<Vec<String>> {
    unlock_session(pin)?;
    load_mnemonic()
}

pub fn wipe_secrets() -> Result<()> {
    lock_session();
    let _ = fs::remove_file(meta_path());
    let _ = fs::remove_file(data_path());
    for k in [LEGACY_PASS, LEGACY_SEED, LEGACY_PIN, LEGACY_NETWORK] {
        legacy_delete(k);
    }
    Ok(())
}
