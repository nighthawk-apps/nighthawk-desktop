//! Local encrypted address book (desktop-only; not part of UniFFI).
//!
//! Stored in `address_book.db` with authenticated encryption (AES-256-GCM)
//! using an OS keychain-backed key (fails closed if the OS keychain is unavailable).
//! Automatically migrates legacy plaintext `address_book.json` if present.

use crate::paths::{address_book_path, legacy_address_book_path};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use anyhow::{Context, Result, anyhow};
use parking_lot::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

static ADDR_BOOK_LOCK: Mutex<()> = Mutex::new(());

const ADDR_BOOK_MAGIC: &[u8; 12] = b"DRK_ADDR_DB1";
const KEYRING_SERVICE: &str = "com.nighthawkapps.desktop.addressbook";
pub const MAX_ENTRIES: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookEntry {
    pub id: String,
    pub label: String,
    pub address: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AddressBookFile {
    entries: Vec<AddressBookEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyringErr {
    NoEntry,
    Other,
}

fn keyring_account_for_root(data_root: &Path) -> String {
    format!(
        "addr_{}",
        hex::encode(&Sha256::digest(data_root.to_string_lossy().as_bytes())[..8])
    )
}

fn decode_key_hex(raw: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(raw.trim()).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Some(key)
}

/// Delete the address book encryption key from the OS keychain for a specific profile root.
pub fn delete_key_for_root(data_root: &Path) {
    let account = keyring_account_for_root(data_root);
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
        let _ = entry.delete_credential();
    }
}

/// Read-only key lookup helper: NEVER creates or overwrites a keyring entry.
fn read_key_with<G>(mut get: G) -> Result<[u8; 32]>
where
    G: FnMut() -> std::result::Result<String, KeyringErr>,
{
    match get() {
        Ok(pw) => decode_key_hex(&pw)
            .ok_or_else(|| anyhow!("Address book key in OS keychain is malformed")),
        Err(KeyringErr::NoEntry) => Err(anyhow!(
            "Address book key missing from OS keychain — refusing to overwrite"
        )),
        Err(KeyringErr::Other) => Err(anyhow!(
            "OS keychain unavailable or locked for address book key — refusing to overwrite"
        )),
    }
}

/// Write-path key lookup/creation helper: creates a new random key ONLY on
/// `KeyringErr::NoEntry` and verifies read-back persistence. Never overwrites
/// on locked keychain, transient errors, or existing entries.
fn ensure_key_with<G, S, D>(mut get: G, mut set: S, mut delete: D) -> Result<[u8; 32]>
where
    G: FnMut() -> std::result::Result<String, KeyringErr>,
    S: FnMut(&str) -> std::result::Result<(), KeyringErr>,
    D: FnMut(),
{
    match get() {
        Ok(pw) => decode_key_hex(&pw).ok_or_else(|| {
            anyhow!("Address book key in OS keychain is malformed — refusing to overwrite")
        }),
        Err(KeyringErr::NoEntry) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            let encoded = hex::encode(key);
            set(&encoded).map_err(|_| {
                anyhow!("OS keychain rejected saving the address book encryption key")
            })?;
            // Round-trip read-back verification so silent keyring failures cannot
            // leave ciphertext that will never decrypt after restart.
            match get().ok().and_then(|s| decode_key_hex(&s)) {
                Some(stored) if stored == key => Ok(key),
                _ => {
                    delete();
                    anyhow::bail!("OS keychain failed read-back verification for address book key");
                }
            }
        }
        Err(KeyringErr::Other) => anyhow::bail!(
            "OS keychain unavailable or locked for address book encryption key; \
             refusing to overwrite or fall back to plaintext"
        ),
    }
}

fn map_keyring_err(e: keyring::Error) -> KeyringErr {
    match e {
        keyring::Error::NoEntry => KeyringErr::NoEntry,
        _ => KeyringErr::Other,
    }
}

/// Read an existing 32-byte AES-256 key for the active wallet data root.
/// Never creates or overwrites a keyring entry.
fn read_address_book_key() -> Result<[u8; 32]> {
    let data_root = crate::paths::wallet_data_root();
    #[cfg(test)]
    if data_root.to_string_lossy().contains("nh_test_") {
        return Ok([0x42u8; 32]);
    }
    let account = keyring_account_for_root(&data_root);
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account).map_err(|_| {
        anyhow!("OS keychain unavailable for address book encryption key; refusing fallback")
    })?;
    read_key_with(|| entry.get_password().map_err(map_keyring_err))
}

/// Load or create (ONLY on `NoEntry` + read-back verification) the 32-byte
/// AES-256 key for the active wallet data root.
fn ensure_address_book_key() -> Result<[u8; 32]> {
    let data_root = crate::paths::wallet_data_root();
    #[cfg(test)]
    if data_root.to_string_lossy().contains("nh_test_") {
        return Ok([0x42u8; 32]);
    }
    let account = keyring_account_for_root(&data_root);
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account).map_err(|_| {
        anyhow!(
            "OS keychain unavailable for address book encryption key; \
             refusing unkeyed or plaintext-key fallback"
        )
    })?;
    ensure_key_with(
        || entry.get_password().map_err(map_keyring_err),
        |v| entry.set_password(v).map_err(map_keyring_err),
        || {
            let _ = entry.delete_credential();
        },
    )
}

fn load() -> Result<AddressBookFile> {
    let db_path = address_book_path();
    let legacy_path = legacy_address_book_path();

    if db_path.exists() {
        let bytes = fs::read(&db_path).context("read address book db")?;
        if bytes.len() < ADDR_BOOK_MAGIC.len() + 12 {
            return Err(anyhow!("address book db is corrupted or truncated"));
        }
        if &bytes[..ADDR_BOOK_MAGIC.len()] != ADDR_BOOK_MAGIC {
            return Err(anyhow!("invalid address book db magic header"));
        }
        let nonce_slice = &bytes[ADDR_BOOK_MAGIC.len()..ADDR_BOOK_MAGIC.len() + 12];
        let ciphertext = &bytes[ADDR_BOOK_MAGIC.len() + 12..];

        let key = read_address_book_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| anyhow!("{e}"))?;
        let nonce = Nonce::from_slice(nonce_slice);
        let decrypted = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| anyhow!("failed to decrypt address book db: {e}"))?;

        let file: AddressBookFile =
            serde_json::from_slice(&decrypted).context("parse address book")?;
        return Ok(file);
    }

    // One-time automatic migration from legacy plaintext JSON
    if legacy_path.exists()
        && let Ok(s) = fs::read_to_string(&legacy_path)
        && let Ok(file) = serde_json::from_str::<AddressBookFile>(&s)
    {
        save(&file)?;
        let _ = fs::remove_file(&legacy_path);
        return Ok(file);
    }

    Ok(AddressBookFile::default())
}

fn save(book: &AddressBookFile) -> Result<()> {
    let db_path = address_book_path();
    let plaintext = serde_json::to_vec_pretty(book)?;
    let key = ensure_address_book_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| anyhow!("{e}"))?;

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_slice())
        .map_err(|e| anyhow!("failed to encrypt address book: {e}"))?;

    let mut out = Vec::with_capacity(ADDR_BOOK_MAGIC.len() + 12 + ciphertext.len());
    out.extend_from_slice(ADDR_BOOK_MAGIC);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);

    crate::paths::write_atomic(&db_path, &out, true).context("write address book db")?;
    Ok(())
}

pub fn list_entries() -> Result<Vec<AddressBookEntry>> {
    let _guard = ADDR_BOOK_LOCK.lock();
    Ok(load()?.entries)
}

/// Newest first. The same address (exact-case Base58) replaces the older row.
pub fn apply_upsert(entries: &mut Vec<AddressBookEntry>, entry: AddressBookEntry) {
    let label = entry.label.trim();
    let address = entry.address.trim();
    if label.is_empty() || address.is_empty() {
        return;
    }
    entries.retain(|e| e.address.trim() != address);
    entries.insert(
        0,
        AddressBookEntry {
            id: entry.id,
            label: label.chars().take(64).collect(),
            address: address.to_string(),
            notes: entry.notes,
        },
    );
    entries.truncate(MAX_ENTRIES);
}

pub fn upsert_entry(entry: AddressBookEntry) -> Result<Vec<AddressBookEntry>> {
    let _guard = ADDR_BOOK_LOCK.lock();
    let mut book = load()?;
    apply_upsert(&mut book.entries, entry);
    save(&book)?;
    Ok(book.entries)
}

pub fn remove_entry(id: &str) -> Result<Vec<AddressBookEntry>> {
    let _guard = ADDR_BOOK_LOCK.lock();
    let mut book = load()?;
    book.entries.retain(|e| e.id != id);
    save(&book)?;
    Ok(book.entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, address: &str) -> AddressBookEntry {
        AddressBookEntry {
            id: format!("id-{label}"),
            label: label.into(),
            address: address.into(),
            notes: String::new(),
        }
    }

    #[test]
    fn upsert_preserves_case_distinct_base58_and_replaces_exact_match() {
        let mut rows = vec![entry("old", "Drk1abc")];
        apply_upsert(&mut rows, entry("Ada", "drk1abc"));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].label, "Ada");
        assert_eq!(rows[0].address, "drk1abc");
        assert_eq!(rows[1].label, "old");
        assert_eq!(rows[1].address, "Drk1abc");

        apply_upsert(&mut rows, entry("AdaUpdated", "drk1abc"));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].label, "AdaUpdated");
        assert_eq!(rows[1].label, "old");

        apply_upsert(&mut rows, entry("Bea", "drk1other"));
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].label, "Bea");
        assert_eq!(rows[1].label, "AdaUpdated");
        assert_eq!(rows[2].label, "old");
    }

    #[test]
    fn upsert_caps_at_fifty() {
        let mut rows = Vec::new();
        for i in 0..60 {
            apply_upsert(&mut rows, entry(&format!("n{i}"), &format!("addr{i}")));
        }
        assert_eq!(rows.len(), MAX_ENTRIES);
        assert_eq!(rows[0].label, "n59");
    }

    #[test]
    fn encryption_roundtrip_and_no_plaintext_leak() {
        let _guard = crate::paths::test_wallet_root_guard();
        let tmp_dir = std::env::temp_dir().join(format!("nh_test_{}", rand::random::<u64>()));
        let _ = fs::create_dir_all(&tmp_dir);
        crate::paths::set_wallet_data_root(Some(tmp_dir.clone()));

        let entry1 = entry("Alice", "drk1secretaddress123");
        upsert_entry(entry1.clone()).unwrap();

        let entries = list_entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].label, "Alice");
        assert_eq!(entries[0].address, "drk1secretaddress123");

        // Verify file is not plaintext json
        let db_bytes = fs::read(address_book_path()).unwrap();
        assert!(db_bytes.starts_with(ADDR_BOOK_MAGIC));
        let content_str = String::from_utf8_lossy(&db_bytes);
        assert!(!content_str.contains("drk1secretaddress123"));
        assert!(!content_str.contains("Alice"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(address_book_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        crate::paths::set_wallet_data_root(None);
        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn read_key_fails_closed_on_missing_or_locked_without_overwriting() {
        assert!(read_key_with(|| Err(KeyringErr::NoEntry)).is_err());
        assert!(read_key_with(|| Err(KeyringErr::Other)).is_err());
        assert!(read_key_with(|| Ok("not-hex".into())).is_err());

        let expected = [0xab_u8; 32];
        let hex_key = hex::encode(expected);
        assert_eq!(read_key_with(|| Ok(hex_key.clone())).unwrap(), expected);
    }

    #[test]
    fn ensure_key_creates_only_on_no_entry_and_verifies_readback() {
        use std::cell::RefCell;

        let stored = RefCell::new(None::<String>);
        let mut set_calls = 0usize;
        let mut delete_calls = 0usize;

        let created = ensure_key_with(
            || stored.borrow().clone().ok_or(KeyringErr::NoEntry),
            |val| {
                set_calls += 1;
                *stored.borrow_mut() = Some(val.to_string());
                Ok(())
            },
            || {
                delete_calls += 1;
                *stored.borrow_mut() = None;
            },
        )
        .unwrap();
        assert_eq!(set_calls, 1);
        assert_eq!(delete_calls, 0);
        assert_eq!(
            stored.borrow().as_deref(),
            Some(hex::encode(created).as_str())
        );

        // Second call returns the existing key without writing again.
        let again = ensure_key_with(
            || stored.borrow().clone().ok_or(KeyringErr::NoEntry),
            |_| {
                set_calls += 1;
                Ok(())
            },
            || delete_calls += 1,
        )
        .unwrap();
        assert_eq!(again, created);
        assert_eq!(set_calls, 1);
    }

    #[test]
    fn ensure_key_refuses_overwrite_on_locked_or_corrupt_and_cleans_bad_readback() {
        let mut set_calls = 0usize;
        let locked = ensure_key_with(
            || Err(KeyringErr::Other),
            |_| {
                set_calls += 1;
                Ok(())
            },
            || {},
        );
        assert!(locked.is_err());
        assert_eq!(
            set_calls, 0,
            "locked keychain must never trigger set_password"
        );

        let corrupt = ensure_key_with(
            || Ok("deadbeef".into()),
            |_| {
                set_calls += 1;
                Ok(())
            },
            || {},
        );
        assert!(corrupt.is_err());
        assert_eq!(
            set_calls, 0,
            "corrupt entry must never be blindly overwritten"
        );

        // Silent drop / read-back mismatch must delete and fail.
        let mut deleted = false;
        let bad_readback =
            ensure_key_with(|| Err(KeyringErr::NoEntry), |_| Ok(()), || deleted = true);
        assert!(bad_readback.is_err());
        assert!(deleted);
    }
}
