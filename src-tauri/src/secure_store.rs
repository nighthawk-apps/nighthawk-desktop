//! Local vault without a user PIN lock.
//!
//! Secrets live in `vault.dat` (AES-256-GCM) under a desktop-local key. The app
//! opens the wallet automatically on launch — no unlock screen.

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

/// Bumped when PIN-sealed vaults were retired. Older metas are wiped on sight.
const META_VERSION: u32 = 2;
const PBKDF2_ITERS: u32 = 100_000;
/// Not a user secret — seals the vault on disk so a casual file copy is opaque.
const DESKTOP_VAULT_SECRET: &str = "nighthawk-desktop-local-vault-v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultMeta {
    version: u32,
    salt_hex: String,
    /// Hex of derived key (integrity check).
    key_hash: String,
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

fn derive_key(salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha256>(DESKTOP_VAULT_SECRET.as_bytes(), salt, PBKDF2_ITERS, &mut out);
    out
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
        .map_err(|_| anyhow!("Corrupt vault"))
}

fn read_meta_raw() -> Result<Option<serde_json::Value>> {
    let path = meta_path();
    if !path.exists() {
        return Ok(None);
    }
    let s = fs::read_to_string(&path).context("read vault meta")?;
    Ok(Some(serde_json::from_str(&s).context("parse vault meta")?))
}

fn read_meta() -> Result<Option<VaultMeta>> {
    let Some(raw) = read_meta_raw()? else {
        return Ok(None);
    };
    let version = raw.get("version").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if version != META_VERSION {
        // PIN-era (v1) or unknown — drop so the user re-creates without unlock.
        let _ = fs::remove_file(meta_path());
        let _ = fs::remove_file(data_path());
        return Ok(None);
    }
    Ok(Some(serde_json::from_value(raw).context("parse vault meta")?))
}

fn write_meta(meta: &VaultMeta) -> Result<()> {
    ensure_vault_dir()?;
    let s = serde_json::to_string_pretty(meta)?;
    fs::write(meta_path(), s).context("write vault meta")
}

fn write_vault_files(mnemonic: &[String], wallet_pass: &str) -> Result<()> {
    ensure_vault_dir()?;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(&salt);
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
        key_hash: hex::encode(key),
    })?;
    Ok(())
}

fn decrypt_payload() -> Result<VaultPayload> {
    let meta = read_meta()?.ok_or_else(|| anyhow!("No wallet on this device"))?;
    let salt = hex::decode(&meta.salt_hex).context("bad salt")?;
    let key = derive_key(&salt);
    if hex::encode(key) != meta.key_hash {
        return Err(anyhow!("Corrupt vault"));
    }
    let blob = fs::read(data_path()).context("read vault.dat")?;
    let plain = open_seal(&key, &blob)?;
    serde_json::from_slice(&plain).context("parse vault payload")
}

fn lock_session() {
    *session().lock() = None;
}

fn unlock_into_session() -> Result<()> {
    let payload = decrypt_payload()?;
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

// --- Legacy keyring cleanup (no migration; PIN path is gone) ---

const LEGACY_SERVICE: &str = "com.nighthawkapps.desktop";
const LEGACY_KEYS: [&str; 4] = ["wallet_pass", "seed_mnemonic", "pin_hash", "active_network"];

fn legacy_delete_all() {
    for key in LEGACY_KEYS {
        if let Ok(e) = keyring::Entry::new(LEGACY_SERVICE, key) {
            let _ = e.delete_credential();
        }
    }
}

/// Random 32-byte wallet pass (SQLCipher), Base64 — same pattern as mobile.
pub fn generate_wallet_pass() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    B64.encode(buf)
}

/// Persist a new wallet vault (create / restore). Replaces any existing vault.
pub fn create_vault(mnemonic: &[String], wallet_pass: &str) -> Result<()> {
    write_vault_files(mnemonic, wallet_pass)?;
    *session().lock() = Some(Session {
        mnemonic: mnemonic.to_vec(),
        wallet_pass: wallet_pass.to_string(),
    });
    Ok(())
}

/// True when the active profile has a current (PIN-less) vault.
pub fn wallet_exists() -> bool {
    vault_ready()
}

pub fn has_pin() -> Result<bool> {
    // Kept for AppStatusDto compatibility — always false (no user PIN).
    Ok(false)
}

pub fn vault_ready() -> bool {
    match read_meta() {
        Ok(Some(_)) => data_path().exists(),
        _ => false,
    }
}

/// Load secrets into the in-memory session (no user PIN).
pub fn unlock_session() -> Result<()> {
    if !vault_ready() {
        return Err(anyhow!("No wallet on this device — create or restore first"));
    }
    unlock_into_session()
}

pub fn clear_session() {
    lock_session();
}

pub fn load_mnemonic() -> Result<Vec<String>> {
    session()
        .lock()
        .as_ref()
        .map(|s| s.mnemonic.clone())
        .ok_or_else(|| anyhow!("Wallet not open"))
}

pub fn load_wallet_pass() -> Result<String> {
    session()
        .lock()
        .as_ref()
        .map(|s| s.wallet_pass.clone())
        .ok_or_else(|| anyhow!("Wallet not open"))
}

/// Return mnemonic (opens vault session if needed).
pub fn backup_mnemonic() -> Result<Vec<String>> {
    if session().lock().is_none() {
        unlock_session()?;
    }
    load_mnemonic()
}

pub fn wipe_secrets() -> Result<()> {
    lock_session();
    let _ = fs::remove_file(meta_path());
    let _ = fs::remove_file(data_path());
    legacy_delete_all();
    Ok(())
}
