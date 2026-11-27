//! Local vault with OS keychain–backed master key.
//!
//! Secrets live in `vault.dat` (AES-256-GCM). The encryption key is stored in
//! the OS keychain (macOS Keychain / Windows Credential Manager / Linux
//! SecretService) via the `keyring` crate. If the keychain is unavailable,
//! New vaults require the OS keychain. Legacy `vault.key` files are still
//! readable. The static PBKDF2 constant is used only to open vaults sealed
//! with it. A successful open rewrites those vaults through the keychain
//! path. If that rewrite fails, the previous files are restored.
//!
//! The app opens the wallet automatically on launch — no unlock screen.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use anyhow::{Context, Result, anyhow};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use parking_lot::Mutex;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Version 3 = keychain-backed vault key. Version 2 = legacy PBKDF2 constant.
const META_VERSION: u32 = 3;
/// Legacy version for migration detection.
const LEGACY_META_VERSION: u32 = 2;
const PBKDF2_ITERS: u32 = 100_000;
/// Legacy static secret. Reads still try it so an old vault can be opened.
/// A successful open rewrites the vault with the OS keychain key.
const DESKTOP_VAULT_SECRET: &str = "nighthawk-desktop-local-vault-v2";

const KEYRING_SERVICE: &str = "com.nighthawkapps.desktop.vault";
/// Legacy account shared by every profile. Reads fall back to it and copy
/// the key into the profile-scoped account. Wiping one profile must not
/// delete this entry, or every other profile loses its vault.
const KEYRING_MASTER_KEY_LEGACY: &str = "master_key";

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

#[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct VaultPayload {
    mnemonic: String,
    wallet_pass: String,
}

#[derive(Zeroize, ZeroizeOnDrop)]
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
    pbkdf2_hmac::<Sha256>(
        DESKTOP_VAULT_SECRET.as_bytes(),
        salt,
        PBKDF2_ITERS,
        &mut out,
    );
    out
}

pub fn keyring_account_for_root(root: &Path) -> String {
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    format!("master_key:{}", hex::encode(&digest[..8]))
}

fn keyring_account() -> String {
    keyring_account_for_root(&crate::paths::wallet_data_root())
}

/// Delete the vault master key from the OS keychain for a specific profile root.
/// Leaves the legacy shared entry intact so other profiles remain readable.
pub fn delete_vault_key_for_root(root: &Path) {
    let account = keyring_account_for_root(root);
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
        let _ = entry.delete_credential();
    }
}

fn read_keyring_secret(account: &str) -> Option<[u8; 32]> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, account).ok()?;
    let hex_str = entry.get_password().ok()?;
    let bytes = hex::decode(hex_str.trim()).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Some(key)
}

/// Read an existing master key from the OS keychain. Never creates one —
/// minting during decrypt replaces a lost key with a random mismatch and
/// surfaces as "Corrupt vault" while poisoning the keyring entry.
fn read_keychain_master_key() -> Option<[u8; 32]> {
    let account = keyring_account();
    if let Some(key) = read_keyring_secret(&account) {
        return Some(key);
    }
    // One-time copy so this profile survives a wipe of a different profile
    // that used to share the global keychain entry.
    if let Some(key) = read_keyring_secret(KEYRING_MASTER_KEY_LEGACY) {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
            let _ = entry.set_password(&hex::encode(key));
        }
        return Some(key);
    }
    None
}

/// Get or create a master key from the OS keychain (write / create path only).
/// Returns `None` if the keychain is unavailable.
fn ensure_keychain_master_key() -> Option<[u8; 32]> {
    if let Some(key) = read_keychain_master_key() {
        return Some(key);
    }
    let account = keyring_account();
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account).ok()?;
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
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            if entry.set_password(&hex::encode(key)).is_ok() {
                // Round-trip so a silent Secret Service failure cannot leave
                // ciphertext that will never decrypt after restart.
                match read_keyring_secret(&account) {
                    Some(stored) if stored == key => Some(key),
                    _ => {
                        let _ = entry.delete_credential();
                        None
                    }
                }
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
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn key_matches_meta(key: &[u8; 32], key_hash: &str) -> bool {
    let fp = key_fingerprint(key);
    let raw = hex::encode(key);
    ct_eq(fp.as_bytes(), key_hash.as_bytes()) || ct_eq(raw.as_bytes(), key_hash.as_bytes())
}

fn mix_master(master: &[u8; 32], salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha256>(master, salt, 1, &mut out);
    out
}

/// Read a legacy `vault.key`. Never creates one: a missing file must not
/// mint a new key during decrypt, which used to write the key beside the
/// ciphertext whenever the primary key check failed.
fn file_master_key() -> Option<[u8; 32]> {
    let path = file_key_path();
    if !path.exists() {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Some(key)
}

/// New vaults require the OS keychain. `vault.key` is read-only for legacy files
/// so we never write the master key next to the ciphertext.
fn derive_key_for_write(salt: &[u8]) -> Result<([u8; 32], bool, bool)> {
    if let Some(master) = ensure_keychain_master_key() {
        return Ok((mix_master(&master, salt), true, false));
    }
    Err(anyhow!(
        "OS keychain is required to create or update the vault; \
         refusing to write vault.key beside the ciphertext"
    ))
}

/// Second value is true when the key is the static PBKDF2 secret.
fn derive_key_for_read(salt: &[u8], meta: &VaultMeta) -> ([u8; 32], bool) {
    if meta.keychain_backed
        && let Some(master) = read_keychain_master_key()
    {
        return (mix_master(&master, salt), false);
    }
    if meta.file_backed
        && let Some(master) = file_master_key()
    {
        return (mix_master(&master, salt), false);
    }
    (derive_key_pbkdf2(salt), true)
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
    if version == 1 {
        // One-time cleanup of obsolete PIN-era v1 vaults.
        let _ = fs::remove_file(meta_path());
        let _ = fs::remove_file(data_path());
        return Ok(None);
    }
    // Accept current version and legacy v2 (PBKDF2-only). Never delete unknown/future vaults.
    if version != META_VERSION && version != LEGACY_META_VERSION {
        return Err(anyhow!(
            "Unsupported or corrupted vault metadata (version {version})"
        ));
    }
    Ok(Some(
        serde_json::from_value(raw).context("parse vault meta")?,
    ))
}

fn write_meta(meta: &VaultMeta) -> Result<()> {
    ensure_vault_dir()?;
    let s = serde_json::to_string_pretty(meta)?;
    crate::paths::write_atomic(&meta_path(), s.as_bytes(), true).context("write vault meta")
}

fn write_vault_files(mnemonic: &[String], wallet_pass: &str, overwrite: bool) -> Result<()> {
    if vault_ready() && !overwrite {
        return Err(anyhow!(
            "Wallet vault already exists — refusing to overwrite. Wipe or switch profile first."
        ));
    }
    ensure_vault_dir()?;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let (key, keychain_backed, file_backed) = derive_key_for_write(&salt)?;
    let key = Zeroizing::new(key);
    let payload = VaultPayload {
        mnemonic: mnemonic.join(" "),
        wallet_pass: wallet_pass.to_string(),
    };
    let plain = Zeroizing::new(serde_json::to_vec(&payload)?);
    let sealed = seal(&key, &plain)?;
    crate::paths::write_atomic(&data_path(), &sealed, true).context("write vault.dat")?;
    write_meta(&VaultMeta {
        version: META_VERSION,
        salt_hex: hex::encode(salt),
        key_hash: key_fingerprint(&key),
        keychain_backed,
        file_backed,
    })?;
    Ok(())
}

struct OpenedVault {
    payload: VaultPayload,
    /// True when the key that opened the vault was `derive_key_pbkdf2`.
    legacy_pbkdf2: bool,
}

fn read_sealed_payload(key: &[u8; 32]) -> Result<VaultPayload> {
    let blob = fs::read(data_path()).context("read vault.dat")?;
    let plain = Zeroizing::new(open_seal(key, &blob)?);
    serde_json::from_slice(&plain).context("parse vault payload")
}

/// Fingerprint match means this is the key. A later decrypt error is fatal
/// and must not fall through to another candidate.
fn open_if_key_matches(
    key: [u8; 32],
    meta: &VaultMeta,
    legacy_pbkdf2: bool,
) -> Result<Option<OpenedVault>> {
    if !key_matches_meta(&key, &meta.key_hash) {
        return Ok(None);
    }
    Ok(Some(OpenedVault {
        payload: read_sealed_payload(&key)?,
        legacy_pbkdf2,
    }))
}

fn decrypt_payload() -> Result<OpenedVault> {
    let meta = read_meta()?.ok_or_else(|| anyhow!("No wallet on this device"))?;
    let salt = hex::decode(&meta.salt_hex).context("bad salt")?;
    let (key, legacy) = derive_key_for_read(&salt, &meta);
    if let Some(opened) = open_if_key_matches(key, &meta, legacy)? {
        return Ok(opened);
    }
    // Lost keychain / file key: try the other sources, then legacy PBKDF2.
    // Never call ensure_keychain_master_key here — that would mint a
    // fresh key that cannot open this vault.
    let candidates = [
        read_keychain_master_key().map(|m| (mix_master(&m, &salt), false)),
        file_master_key().map(|m| (mix_master(&m, &salt), false)),
        Some((derive_key_pbkdf2(&salt), true)),
    ];
    for candidate in candidates.into_iter().flatten() {
        let (candidate_key, candidate_legacy) = candidate;
        if let Some(opened) = open_if_key_matches(candidate_key, &meta, candidate_legacy)? {
            return Ok(opened);
        }
    }
    if meta.keychain_backed && read_keychain_master_key().is_none() {
        return Err(anyhow!(
            "Vault key missing from OS keychain — wipe local data and \
             create or restore the wallet again"
        ));
    }
    Err(anyhow!("Corrupt vault"))
}

fn legacy_migration_failure(err: &str, restored: bool) -> String {
    let tail = if restored {
        "The existing vault was left unchanged"
    } else {
        "Restoring the previous vault files also failed"
    };
    format!(
        "Vault unlocked with the legacy key, but migrating it to the OS keychain failed: {err}. \
         {tail}"
    )
}

/// Rewrite a vault that opened with the static PBKDF2 secret. On failure the
/// previous `vault.dat` and `vault.meta.json` bytes are put back.
fn migrate_legacy_vault_files<F>(mnemonic: &[String], wallet_pass: &str, write: F) -> Option<String>
where
    F: FnOnce(&[String], &str) -> Result<()>,
{
    let old_data = match fs::read(data_path()) {
        Ok(bytes) => bytes,
        Err(e) => {
            return Some(legacy_migration_failure(
                &format!("could not read vault.dat ({e})"),
                true,
            ));
        }
    };
    let old_meta = match fs::read(meta_path()) {
        Ok(bytes) => bytes,
        Err(e) => {
            return Some(legacy_migration_failure(
                &format!("could not read vault meta ({e})"),
                true,
            ));
        }
    };
    match write(mnemonic, wallet_pass) {
        Ok(()) => None,
        Err(e) => {
            let data_ok = crate::paths::write_atomic(&data_path(), &old_data, true).is_ok();
            let meta_ok = crate::paths::write_atomic(&meta_path(), &old_meta, true).is_ok();
            Some(legacy_migration_failure(&e.to_string(), data_ok && meta_ok))
        }
    }
}

fn lock_session() {
    *session().lock() = None;
}

fn unlock_into_session() -> Result<Option<String>> {
    let opened = decrypt_payload()?;
    let legacy = opened.legacy_pbkdf2;
    let mnemonic: Vec<String> = opened
        .payload
        .mnemonic
        .split_whitespace()
        .map(|w| w.to_string())
        .collect();
    let wallet_pass = opened.payload.wallet_pass.clone();
    drop(opened);
    *session().lock() = Some(Session {
        mnemonic: mnemonic.clone(),
        wallet_pass: wallet_pass.clone(),
    });
    if !legacy {
        return Ok(None);
    }
    // Keep the PBKDF2 read path until this rewrite succeeds. A failed rewrite
    // restores the previous files and still leaves the session unlocked.
    Ok(migrate_legacy_vault_files(
        &mnemonic,
        &wallet_pass,
        |words, pass| write_vault_files(words, pass, true),
    ))
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

/// Deterministic 32-byte wallet pass (SQLCipher), Base64 — aligned across Android, iOS, and Desktop.
/// Derived as HMAC-SHA256("nighthawk-drk-wallet-pass-v1", normalized_phrase).
pub fn wallet_pass_for_mnemonic(mnemonic: &[String]) -> String {
    use hmac::digest::Mac;
    type HmacSha256 = hmac::Hmac<sha2::Sha256>;

    let phrase = mnemonic.join(" ").trim().to_lowercase();
    let mut mac = <HmacSha256 as Mac>::new_from_slice(b"nighthawk-drk-wallet-pass-v1")
        .expect("HMAC can take key of any size");
    mac.update(phrase.as_bytes());
    let result = mac.finalize().into_bytes();
    B64.encode(result)
}

/// Random 32-byte wallet pass (SQLCipher), Base64 — legacy fallback.
#[allow(dead_code)]
pub fn generate_wallet_pass() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    B64.encode(buf)
}

/// Persist a new wallet vault (create / restore).
///
/// Refuses to replace an existing vault unless `overwrite` is true.
/// Only wipe-then-recreate / a confirmed create on a fresh profile may pass
/// `overwrite = true`.
pub fn create_vault(mnemonic: &[String], wallet_pass: &str, overwrite: bool) -> Result<()> {
    write_vault_files(mnemonic, wallet_pass, overwrite)?;
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
/// `Ok(None)` is a clean unlock. `Ok(Some(warning))` means the session is
/// unlocked and the legacy vault is still on disk because the keychain
/// rewrite failed.
pub fn unlock_session() -> Result<Option<String>> {
    if !vault_ready() {
        return Err(anyhow!(
            "No wallet on this device — create or restore first"
        ));
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

/// Return mnemonic. Requires an already-unlocked session so unauthenticated
/// IPC cannot open the vault and export the seed.
pub fn backup_mnemonic() -> Result<Vec<String>> {
    load_mnemonic()
}

pub fn wipe_secrets() -> Result<()> {
    lock_session();
    let _ = fs::remove_file(meta_path());
    let _ = fs::remove_file(data_path());
    let _ = fs::remove_file(file_key_path());
    // Also remove the keychain master key.
    // Only this profile's key. The legacy global entry stays so other
    // profiles that have not copied it yet can still open.
    delete_vault_key_for_root(&crate::paths::wallet_data_root());
    legacy_delete_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

    #[test]
    fn keychain_round_trip_persists() {
        let account = format!("test_roundtrip:{}", std::process::id());
        let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) else {
            return;
        };
        let _ = entry.delete_credential();
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        if entry.set_password(&hex::encode(key)).is_err() {
            return;
        }
        let stored = read_keyring_secret(&account).expect("read back after set");
        assert_eq!(stored, key);
        let _ = entry.delete_credential();
    }

    struct VaultTestRoot {
        tmp: std::path::PathBuf,
    }

    impl VaultTestRoot {
        fn enter() -> Self {
            let tmp = std::env::temp_dir().join(format!(
                "nh_vault_migrate_{}_{}",
                std::process::id(),
                rand::random::<u64>()
            ));
            fs::create_dir_all(&tmp).unwrap();
            crate::paths::set_wallet_data_root(Some(tmp.clone()));
            lock_session();
            Self { tmp }
        }
    }

    impl Drop for VaultTestRoot {
        fn drop(&mut self) {
            lock_session();
            delete_vault_key_for_root(&self.tmp);
            crate::paths::set_wallet_data_root(None);
            let _ = fs::remove_dir_all(&self.tmp);
        }
    }

    fn write_legacy_pbkdf2_vault(mnemonic: &[String], wallet_pass: &str, salt: &[u8; 16]) {
        let key = derive_key_pbkdf2(salt);
        let payload = VaultPayload {
            mnemonic: mnemonic.join(" "),
            wallet_pass: wallet_pass.to_string(),
        };
        let plain = serde_json::to_vec(&payload).unwrap();
        let sealed = seal(&key, &plain).unwrap();
        crate::paths::write_atomic(&data_path(), &sealed, true).unwrap();
        write_meta(&VaultMeta {
            version: LEGACY_META_VERSION,
            salt_hex: hex::encode(salt),
            key_hash: key_fingerprint(&key),
            keychain_backed: false,
            file_backed: false,
        })
        .unwrap();
    }

    #[test]
    fn legacy_migration_failure_restores_bytes_and_keeps_session() {
        let _guard = crate::paths::test_wallet_root_guard();
        let _root = VaultTestRoot::enter();
        let mnemonic = vec!["alpha".to_string(), "beta".to_string()];
        let pass = "test-pass";
        write_legacy_pbkdf2_vault(&mnemonic, pass, &[9u8; 16]);
        let before_data = fs::read(data_path()).unwrap();
        let before_meta = fs::read(meta_path()).unwrap();
        *session().lock() = Some(Session {
            mnemonic: mnemonic.clone(),
            wallet_pass: pass.to_string(),
        });

        let warning = migrate_legacy_vault_files(&mnemonic, pass, |_words, _pass| {
            fs::write(data_path(), b"truncated").unwrap();
            Err(anyhow::anyhow!("keychain down"))
        });
        let warning = warning.expect("migration warning");
        assert!(warning.contains("keychain down"));
        assert!(warning.contains("left unchanged"));
        assert_eq!(fs::read(data_path()).unwrap(), before_data);
        assert_eq!(fs::read(meta_path()).unwrap(), before_meta);
        assert_eq!(load_mnemonic().unwrap(), mnemonic);
        assert_eq!(load_wallet_pass().unwrap(), pass);
    }

    #[test]
    fn legacy_pbkdf2_unlock_migrates_or_reports_without_destroying_vault() {
        let _guard = crate::paths::test_wallet_root_guard();
        let _root = VaultTestRoot::enter();
        let mnemonic = vec!["one".to_string(), "two".to_string()];
        let pass = "wallet-pass";
        write_legacy_pbkdf2_vault(&mnemonic, pass, &[4u8; 16]);
        let before_data = fs::read(data_path()).unwrap();
        let before_meta = fs::read(meta_path()).unwrap();

        let warning = unlock_session().expect("legacy vault decrypts");
        assert_eq!(load_mnemonic().unwrap(), mnemonic);
        assert_eq!(load_wallet_pass().unwrap(), pass);

        match warning {
            None => {
                let meta = read_meta().unwrap().expect("meta");
                assert!(meta.keychain_backed);
                assert!(!meta.file_backed);
                assert_eq!(meta.version, META_VERSION);
                let salt = hex::decode(meta.salt_hex).unwrap();
                let legacy = derive_key_pbkdf2(&salt);
                assert!(!key_matches_meta(&legacy, &meta.key_hash));
                lock_session();
                assert!(unlock_session().unwrap().is_none());
            }
            Some(msg) => {
                assert!(msg.contains("left unchanged"));
                assert_eq!(fs::read(data_path()).unwrap(), before_data);
                assert_eq!(fs::read(meta_path()).unwrap(), before_meta);
                lock_session();
                let again = unlock_session().expect("fallback still opens");
                assert!(again.is_some());
                assert_eq!(load_mnemonic().unwrap(), mnemonic);
            }
        }
    }
}
