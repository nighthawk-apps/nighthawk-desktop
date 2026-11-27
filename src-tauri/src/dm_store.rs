//! ChaChaBox DM keypair sealed at rest (not webview localStorage).
//!
//! Ciphertext is AES-256-GCM under a key derived from the unlocked SQLCipher
//! `wallet_pass`. File lives under the active wallet profile root.

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
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_DM_CONTACTS: usize = 200;

static DM_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmKeypairStored {
    pub secret_b58: String,
    pub public_b58: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DmContactStored {
    pub id: String,
    pub label: String,
    pub public_b58: String,
    #[serde(default)]
    pub last_seen_at: u64,
    #[serde(default)]
    pub unread: u32,
    #[serde(default)]
    pub ratchet_capable: bool,
}

fn path() -> PathBuf {
    crate::paths::wallet_data_root().join("dm_keypair.sealed")
}

fn contacts_path() -> PathBuf {
    crate::paths::wallet_data_root().join("dm_contacts.sealed")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn derive_key(wallet_pass: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"nighthawk-desktop-dm-v1");
    h.update(wallet_pass.as_bytes());
    let dig = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&dig);
    out
}

fn derive_contacts_key(wallet_pass: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"nighthawk-desktop-dm-contacts-v1");
    h.update(wallet_pass.as_bytes());
    let dig = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&dig);
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
            .map_err(|e| anyhow!("encrypt dm keys: {e}"))?,
    );
    Ok(out)
}

fn open_seal(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 13 {
        return Err(anyhow!("corrupt dm keystore"));
    }
    let (nonce_bytes, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| anyhow!("{e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ct)
        .map_err(|_| anyhow!("Failed to decrypt DM keys (wrong wallet session?)"))
}

pub fn save(wallet_pass: &str, keys: &DmKeypairStored) -> Result<()> {
    let _guard = DM_STORE_LOCK.lock();
    let plain = serde_json::to_vec(keys)?;
    let key = derive_key(wallet_pass);
    let sealed = seal(&key, &plain)?;
    crate::paths::write_atomic(&path(), &sealed, true).context("write dm_keypair.sealed")?;
    Ok(())
}

pub fn load(wallet_pass: &str) -> Result<Option<DmKeypairStored>> {
    let _guard = DM_STORE_LOCK.lock();
    let p = path();
    if !p.exists() {
        return Ok(None);
    }
    let blob = fs::read(&p).context("read dm_keypair.sealed")?;
    let key = derive_key(wallet_pass);
    let plain = open_seal(&key, &blob)?;
    let keys: DmKeypairStored = serde_json::from_slice(&plain).context("parse dm keys")?;
    Ok(Some(keys))
}

fn save_contacts_unlocked(wallet_pass: &str, contacts: &[DmContactStored]) -> Result<()> {
    let capped: Vec<&DmContactStored> = contacts.iter().take(MAX_DM_CONTACTS).collect();
    let plain = serde_json::to_vec(&capped)?;
    let key = derive_contacts_key(wallet_pass);
    let sealed = seal(&key, &plain)?;
    crate::paths::write_atomic(&contacts_path(), &sealed, true)
        .context("write dm_contacts.sealed")?;
    Ok(())
}

fn load_contacts_unlocked(wallet_pass: &str) -> Result<Vec<DmContactStored>> {
    let p = contacts_path();
    if !p.exists() {
        return Ok(Vec::new());
    }
    let blob = fs::read(&p).context("read dm_contacts.sealed")?;
    let key = derive_contacts_key(wallet_pass);
    let plain = open_seal(&key, &blob)?;
    let contacts: Vec<DmContactStored> =
        serde_json::from_slice(&plain).context("parse dm contacts")?;
    Ok(contacts)
}

pub fn load_contacts(wallet_pass: &str) -> Result<Vec<DmContactStored>> {
    let _guard = DM_STORE_LOCK.lock();
    load_contacts_unlocked(wallet_pass)
}

pub fn upsert_contact(
    wallet_pass: &str,
    label: &str,
    public_b58: &str,
    ratchet_capable: bool,
) -> Result<Vec<DmContactStored>> {
    let _guard = DM_STORE_LOCK.lock();
    let pk = public_b58.trim();
    if pk.is_empty() {
        return Err(anyhow!("Peer public key cannot be empty"));
    }
    let decoded = bs58::decode(pk)
        .into_vec()
        .map_err(|e| anyhow!("invalid peer public key base58: {e}"))?;
    if decoded.len() != 32 {
        return Err(anyhow!(
            "invalid peer public key length: expected 32 bytes, got {}",
            decoded.len()
        ));
    }
    let clean_label: String = {
        let t = label.trim();
        if t.starts_with('#') {
            return Err(anyhow!("DM contact label cannot start with '#'"));
        }
        if t.is_empty() {
            pk.chars().take(12).collect()
        } else {
            t.chars().take(64).collect()
        }
    };
    let mut contacts = load_contacts_unlocked(wallet_pass)?;
    if contacts
        .iter()
        .any(|c| c.public_b58 != pk && c.label.eq_ignore_ascii_case(&clean_label))
    {
        return Err(anyhow!(
            "A DM contact named '{clean_label}' already exists — choose a unique label"
        ));
    }
    let now = now_millis();
    if let Some(existing) = contacts.iter_mut().find(|c| c.public_b58 == pk) {
        existing.label = clean_label;
        existing.last_seen_at = now;
        if ratchet_capable {
            existing.ratchet_capable = true;
        }
    } else {
        contacts.insert(
            0,
            DmContactStored {
                id: format!("dm-{now}-{:08x}", rand::random::<u32>()),
                label: clean_label,
                public_b58: pk.to_string(),
                last_seen_at: now,
                unread: 0,
                ratchet_capable,
            },
        );
        contacts.truncate(MAX_DM_CONTACTS);
    }
    save_contacts_unlocked(wallet_pass, &contacts)?;
    Ok(contacts)
}

pub fn remove_contact(
    wallet_pass: &str,
    id: &str,
) -> Result<(Vec<DmContactStored>, Option<DmContactStored>)> {
    let _guard = DM_STORE_LOCK.lock();
    let mut contacts = load_contacts_unlocked(wallet_pass)?;
    let removed = contacts.iter().find(|c| c.id == id).cloned();
    contacts.retain(|c| c.id != id);
    save_contacts_unlocked(wallet_pass, &contacts)?;
    Ok((contacts, removed))
}

pub fn clear_unread(wallet_pass: &str, public_b58: &str) -> Result<Vec<DmContactStored>> {
    let _guard = DM_STORE_LOCK.lock();
    let mut contacts = load_contacts_unlocked(wallet_pass)?;
    let pk = public_b58.trim();
    let mut changed = false;
    for c in &mut contacts {
        if c.public_b58 == pk && c.unread > 0 {
            c.unread = 0;
            changed = true;
        }
    }
    if changed {
        save_contacts_unlocked(wallet_pass, &contacts)?;
    }
    Ok(contacts)
}

pub fn bump_unread(wallet_pass: &str, public_b58: &str) -> Result<Vec<DmContactStored>> {
    let _guard = DM_STORE_LOCK.lock();
    let mut contacts = load_contacts_unlocked(wallet_pass)?;
    let pk = public_b58.trim();
    let mut changed = false;
    let now = now_millis();
    for c in &mut contacts {
        if c.public_b58 == pk {
            c.unread = c.unread.saturating_add(1);
            c.last_seen_at = now;
            changed = true;
        }
    }
    if changed {
        save_contacts_unlocked(wallet_pass, &contacts)?;
    }
    Ok(contacts)
}

pub fn migrate_legacy_contacts(
    wallet_pass: &str,
    legacy: Vec<DmContactStored>,
) -> Result<Vec<DmContactStored>> {
    let _guard = DM_STORE_LOCK.lock();
    let mut contacts = load_contacts_unlocked(wallet_pass)?;
    let mut changed = false;
    for entry in legacy {
        let pk = entry.public_b58.trim().to_string();
        if pk.is_empty() {
            continue;
        }
        let Ok(bytes) = bs58::decode(&pk).into_vec() else {
            continue;
        };
        if bytes.len() != 32 {
            continue;
        }
        if contacts.iter().any(|c| c.public_b58 == pk) {
            continue;
        }
        let raw_lbl = entry.label.trim().trim_start_matches('#').trim();
        let mut label: String = if raw_lbl.is_empty() {
            pk.chars().take(12).collect()
        } else {
            raw_lbl.chars().take(64).collect()
        };
        if contacts
            .iter()
            .any(|c| c.label.eq_ignore_ascii_case(&label))
        {
            let suffix: String = pk.chars().take(6).collect();
            label = format!("{} ({suffix})", label.chars().take(54).collect::<String>());
        }
        let id = if entry.id.trim().is_empty() {
            format!("dm-{}-{:08x}", now_millis(), rand::random::<u32>())
        } else {
            entry.id
        };
        contacts.push(DmContactStored {
            id,
            label,
            public_b58: pk,
            last_seen_at: entry.last_seen_at,
            unread: entry.unread,
            ratchet_capable: entry.ratchet_capable,
        });
        changed = true;
    }
    contacts.truncate(MAX_DM_CONTACTS);
    if changed {
        save_contacts_unlocked(wallet_pass, &contacts)?;
    }
    Ok(contacts)
}

pub fn clear() {
    let _guard = DM_STORE_LOCK.lock();
    let _ = fs::remove_file(path());
    let _ = fs::remove_file(contacts_path());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contacts_encryption_roundtrip_and_no_plaintext_leak() {
        let _guard = crate::paths::test_wallet_root_guard();
        let tmp_dir = std::env::temp_dir().join(format!("nh_dm_test_{}", rand::random::<u64>()));
        let _ = fs::create_dir_all(&tmp_dir);
        crate::paths::set_wallet_data_root(Some(tmp_dir.clone()));

        let pk1 = bs58::encode([0x11u8; 32]).into_string();
        let pk2 = bs58::encode([0x22u8; 32]).into_string();
        let pass = "test-wallet-pass";

        let list = upsert_contact(pass, "AliceSecretLabel", &pk1, false).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "AliceSecretLabel");
        assert_eq!(list[0].public_b58, pk1);

        let list = upsert_contact(pass, "Bob", &pk2, true).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].ratchet_capable);

        let loaded = load_contacts(pass).unwrap();
        assert_eq!(loaded, list);

        let bumped = bump_unread(pass, &pk1).unwrap();
        assert_eq!(
            bumped.iter().find(|c| c.public_b58 == pk1).unwrap().unread,
            1
        );
        let cleared = clear_unread(pass, &pk1).unwrap();
        assert_eq!(
            cleared.iter().find(|c| c.public_b58 == pk1).unwrap().unread,
            0
        );

        let raw = fs::read(contacts_path()).unwrap();
        let raw_lossy = String::from_utf8_lossy(&raw);
        assert!(!raw_lossy.contains("AliceSecretLabel"));
        assert!(!raw_lossy.contains(&pk1));

        let (after_rm, removed) = remove_contact(pass, &loaded[0].id).unwrap();
        assert_eq!(after_rm.len(), 1);
        assert!(removed.is_some());

        clear();
        assert!(!contacts_path().exists());
        crate::paths::set_wallet_data_root(None);
        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn contacts_migration_skips_invalid_and_dedups() {
        let _guard = crate::paths::test_wallet_root_guard();
        let tmp_dir = std::env::temp_dir().join(format!("nh_dm_mig_{}", rand::random::<u64>()));
        let _ = fs::create_dir_all(&tmp_dir);
        crate::paths::set_wallet_data_root(Some(tmp_dir.clone()));

        let pk1 = bs58::encode([0x33u8; 32]).into_string();
        let pass = "test-wallet-pass-mig";
        upsert_contact(pass, "Existing", &pk1, false).unwrap();

        let pk2 = bs58::encode([0x44u8; 32]).into_string();
        let merged = migrate_legacy_contacts(
            pass,
            vec![
                DmContactStored {
                    id: "old-1".into(),
                    label: "Dup".into(),
                    public_b58: pk1.clone(),
                    last_seen_at: 1,
                    unread: 2,
                    ratchet_capable: false,
                },
                DmContactStored {
                    id: "bad-len".into(),
                    label: "Bad".into(),
                    public_b58: bs58::encode([0x55u8; 16]).into_string(),
                    last_seen_at: 1,
                    unread: 0,
                    ratchet_capable: false,
                },
                DmContactStored {
                    id: "leg-2".into(),
                    label: "Migrated".into(),
                    public_b58: pk2.clone(),
                    last_seen_at: 99,
                    unread: 3,
                    ratchet_capable: false,
                },
            ],
        )
        .unwrap();

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].label, "Existing");
        assert_eq!(merged[1].label, "Migrated");
        assert_eq!(merged[1].public_b58, pk2);

        clear();
        crate::paths::set_wallet_data_root(None);
        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
