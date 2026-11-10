//! Local encrypted address book (desktop-only; not part of UniFFI).
//!
//! Stored in `address_book.db` with authenticated encryption (AES-256-GCM)
//! using an OS keychain-backed key (with automatic fallback to a local machine key).
//! Automatically migrates legacy plaintext `address_book.json` if present.

use crate::paths::{address_book_path, legacy_address_book_path};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;

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

/// Derive or load the 32-byte AES-256 key for the active wallet data root.
fn get_address_book_key() -> Result<[u8; 32]> {
    let data_root = crate::paths::wallet_data_root();
    let account = format!(
        "addr_{}",
        hex::encode(&Sha256::digest(data_root.to_string_lossy().as_bytes())[..8])
    );

    // Try OS keychain first
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
        if let Ok(pw) = entry.get_password() {
            if let Ok(bytes) = hex::decode(pw.trim()) {
                if bytes.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&bytes);
                    return Ok(key);
                }
            }
        }

        // Generate and save to keyring if writable
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        if entry.set_password(&hex::encode(key)).is_ok() {
            return Ok(key);
        }
    }

    // Fallback: machine-local key in wallet_data_root() (e.g. headless/CI)
    let key_file = data_root.join(".addrbook.key");
    if key_file.exists() {
        if let Ok(bytes) = fs::read(&key_file) {
            if bytes.len() == 32 {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                return Ok(key);
            }
        }
    }

    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    let _ = fs::write(&key_file, key);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&key_file, fs::Permissions::from_mode(0o600));
    }
    Ok(key)
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

        let key = get_address_book_key()?;
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
    if legacy_path.exists() {
        if let Ok(s) = fs::read_to_string(&legacy_path) {
            if let Ok(file) = serde_json::from_str::<AddressBookFile>(&s) {
                save(&file)?;
                let _ = fs::remove_file(&legacy_path);
                return Ok(file);
            }
        }
    }

    Ok(AddressBookFile::default())
}

fn save(book: &AddressBookFile) -> Result<()> {
    let db_path = address_book_path();
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let plaintext = serde_json::to_vec_pretty(book)?;
    let key = get_address_book_key()?;
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

    // Atomic write
    let tmp_path = db_path.with_extension("tmp");
    fs::write(&tmp_path, out).context("write address book tmp")?;
    fs::rename(&tmp_path, &db_path).context("atomic rename address book db")?;
    Ok(())
}

pub fn list_entries() -> Result<Vec<AddressBookEntry>> {
    Ok(load()?.entries)
}

/// Newest first. The same address (case-insensitive) replaces the older row.
pub fn apply_upsert(entries: &mut Vec<AddressBookEntry>, entry: AddressBookEntry) {
    let label = entry.label.trim();
    let address = entry.address.trim();
    if label.is_empty() || address.is_empty() {
        return;
    }
    let key = address.to_lowercase();
    entries.retain(|e| e.address.trim().to_lowercase() != key);
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
    let mut book = load()?;
    apply_upsert(&mut book.entries, entry);
    save(&book)?;
    Ok(book.entries)
}

pub fn remove_entry(id: &str) -> Result<Vec<AddressBookEntry>> {
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
    fn upsert_replaces_same_address_and_keeps_newest_first() {
        let mut rows = vec![entry("old", "Drk1abc")];
        apply_upsert(&mut rows, entry("Ada", "drk1abc"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Ada");
        apply_upsert(&mut rows, entry("Bea", "drk1other"));
        assert_eq!(rows[0].label, "Bea");
        assert_eq!(rows[1].label, "Ada");
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

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
