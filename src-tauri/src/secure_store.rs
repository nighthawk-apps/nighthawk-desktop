//! Local vault with OS keychain–backed master key.
//!
//! Secrets live in `vault.dat` (AES-256-GCM). The encryption key is stored in
//! the OS keychain (macOS Keychain / Windows Credential Manager / Linux
//! SecretService) via the `keyring` crate. If the keychain is unavailable,
//! a random 32-byte master key is written to `vault.key` (mode 0600).
//! The static PBKDF2 constant is used only to open legacy v2 vaults.
//!
//! The app opens the wallet automatically on launch — no unlock screen.

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
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Version 3 = keychain-backed vault key. Version 2 = legacy PBKDF2 constant.
const META_VERSION: u32 = 3;
/// Legacy version for migration detection.
const LEGACY_META_VERSION: u32 = 2;
const PBKDF2_ITERS: u32 = 100_000;
/// Legacy fallback — only used when keyring is unavailable.
const DESKTOP_VAULT_SECRET: &str = "nighthawk-desktop-local-vault-v2";

const KEYRING_SERVICE: &str = "com.nighthawkapps.desktop.vault";
const KEYRING_MASTER_KEY: &str = "master_key";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultMeta {
    version: u32,
    salt_hex: String,
    /// SHA-256 of the derived AES key (integrity check). Older vaults may
    /// store the raw key hex here; both forms are accepted on read.
    key_hash: String,
    /// `true` when the master key lives in OS keychain rather than PBKDF2.
    #[serde(default)]
    keychain_backed: bool,
    /// Random 32-byte master key in `vault.key` (0600) when keychain is down.
    #[serde(default)]
    file_backed: bool,
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

fn file_key_path() -> PathBuf {
    vault_dir().join("vault.key")
}

fn ensure_vault_dir() -> Result<()> {
    fs::create_dir_all(vault_dir()).context("create app data dir")
}

/// Derive a key from a static constant (legacy path).
fn derive_key_pbkdf2(salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha256>(DESKTOP_VAULT_SECRET.as_bytes(), salt, PBKDF2_ITERS, &mut out);
    out
}

/// Get or create a master key from the OS keychain.
/// Returns `None` if the keychain is unavailable.
fn keychain_master_key() -> Option<[u8; 32]> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_MASTER_KEY).ok()?;
    match entry.get_password() {
        Ok(hex_str) => {
            let bytes = hex::decode(hex_str.trim()).ok()?;
            if bytes.len() != 32 {
                return None;
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Some(key)
        }
        Err(keyring::Error::NoEntry) => {
            // Generate a new master key and store it.
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            if entry.set_password(&hex::encode(key)).is_ok() {
                Some(key)
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

fn key_fingerprint(key: &[u8; 32]) -> String {
    hex::encode(Sha256::digest(key))
}

/// Accept SHA-256 fingerprints and the raw-key hex some older writers stored.
fn key_matches_meta(key: &[u8; 32], key_hash: &str) -> bool {
    key_fingerprint(key) == key_hash || hex::encode(key) == key_hash
}

fn mix_master(master: &[u8; 32], salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha256>(master, salt, 1, &mut out);
    out
}

fn write_secret_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .context("create vault.key")?;
        f.write_all(bytes).context("write vault.key")?;
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes).context("write vault.key")?;
    }
    Ok(())
}

/// Random master key on disk. Used only when the OS keychain is unavailable.
fn file_master_key() -> Option<[u8; 32]> {
    let path = file_key_path();
    if path.exists() {
        let bytes = fs::read(&path).ok()?;
        if bytes.len() != 32 {
            return None;
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Some(key);
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    ensure_vault_dir().ok()?;
    write_secret_file(&path, &key).ok()?;
    Some(key)
}

/// New vaults: OS keychain, else a random `vault.key`. Never the static PBKDF2 string.
fn derive_key_for_write(salt: &[u8]) -> Result<([u8; 32], bool, bool)> {
    if let Some(master) = keychain_master_key() {
        return Ok((mix_master(&master, salt), true, false));
    }
    if let Some(master) = file_master_key() {
        return Ok((mix_master(&master, salt), false, true));
    }
    Err(anyhow!(
        "unable to persist vault key (OS keychain and vault.key both failed)"
    ))
}

fn derive_key_for_read(salt: &[u8], meta: &VaultMeta) -> [u8; 32] {
    if meta.keychain_backed {
        if let Some(master) = keychain_master_key() {
            return mix_master(&master, salt);
        }
    }
    if meta.file_backed {
        if let Some(master) = file_master_key() {
            return mix_master(&master, salt);
        }
    }
    derive_key_pbkdf2(salt)
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
    // Accept current version and legacy v2 (PBKDF2-only).
    if version != META_VERSION && version != LEGACY_META_VERSION {
        // PIN-era (v1) or unknown — drop so the user re-creates.
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
    let (key, keychain_backed, file_backed) = derive_key_for_write(&salt)?;
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
        key_hash: key_fingerprint(&key),
        keychain_backed,
        file_backed,
    })?;
    Ok(())
}

fn decrypt_payload() -> Result<VaultPayload> {
    let meta = read_meta()?.ok_or_else(|| anyhow!("No wallet on this device"))?;
    let salt = hex::decode(&meta.salt_hex).context("bad salt")?;
    let key = derive_key_for_read(&salt, &meta);
    if !key_matches_meta(&key, &meta.key_hash) {
        // Lost keychain / file key: try the other sources, then legacy PBKDF2.
        for candidate in [
            keychain_master_key().map(|m| mix_master(&m, &salt)),
            file_master_key().map(|m| mix_master(&m, &salt)),
            Some(derive_key_pbkdf2(&salt)),
        ]
        .into_iter()
        .flatten()
        {
            if key_matches_meta(&candidate, &meta.key_hash) {
                let blob = fs::read(data_path()).context("read vault.dat")?;
                let plain = open_seal(&candidate, &blob)?;
                return serde_json::from_slice(&plain).context("parse vault payload");
            }
        }
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

/// True when the active profile has a current vault.
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
    let _ = fs::remove_file(file_key_path());
    // Also remove the keychain master key.
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_MASTER_KEY) {
        let _ = entry.delete_credential();
    }
    legacy_delete_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_fingerprint_is_not_the_raw_key() {
        let key = [7u8; 32];
        let fp = key_fingerprint(&key);
        assert_ne!(fp, hex::encode(key));
        assert_eq!(fp.len(), 64);
        assert!(key_matches_meta(&key, &fp));
        assert!(key_matches_meta(&key, &hex::encode(key)));
        assert!(!key_matches_meta(&key, "00"));
    }

    #[test]
    fn mix_master_changes_with_salt() {
        let master = [9u8; 32];
        let a = mix_master(&master, &[1u8; 16]);
        let b = mix_master(&master, &[2u8; 16]);
        assert_ne!(a, b);
        assert_ne!(a, master);
    }
}
