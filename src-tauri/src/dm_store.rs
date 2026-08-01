//! ChaChaBox DM keypair sealed at rest (not webview localStorage).
//!
//! Ciphertext is AES-256-GCM under a key derived from the unlocked SQLCipher
//! `wallet_pass`. File lives under the active wallet profile root.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmKeypairStored {
    pub secret_b58: String,
    pub public_b58: String,
}

fn path() -> PathBuf {
    crate::paths::wallet_data_root().join("dm_keypair.sealed")
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
    let root = crate::paths::wallet_data_root();
    fs::create_dir_all(&root).context("create wallet data root")?;
    let plain = serde_json::to_vec(keys)?;
    let key = derive_key(wallet_pass);
    let sealed = seal(&key, &plain)?;
    fs::write(path(), sealed).context("write dm_keypair.sealed")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path(), fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn load(wallet_pass: &str) -> Result<Option<DmKeypairStored>> {
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

pub fn clear() {
    let _ = fs::remove_file(path());
}
