//! Multi-wallet profile registry (desktop-only).

use crate::paths::{
    apply_wallet_profile, app_root, wallets_registry_path,
};
use crate::prefs::{load_prefs, save_prefs};
use anyhow::{anyhow, Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

/// Created profile ids: `w{unix_secs}` or `w{unix_secs}_{hex}` (D16 suffix).
fn is_valid_created_wallet_id(id: &str) -> bool {
    let rest = match id.strip_prefix('w') {
        Some(r) if !r.is_empty() => r,
        _ => return false,
    };
    if let Some((digits, suffix)) = rest.split_once('_') {
        !digits.is_empty()
            && digits.bytes().all(|b| b.is_ascii_digit())
            && !suffix.is_empty()
            && suffix.len() <= 16
            && suffix.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    } else {
        rest.bytes().all(|b| b.is_ascii_digit())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletProfile {
    pub id: String,
    pub label: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    active_id: String,
    wallets: Vec<WalletProfile>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_raw() -> Result<RegistryFile> {
    let path = wallets_registry_path();
    if !path.exists() {
        return Ok(ensure_default_registry());
    }
    let s = fs::read_to_string(&path).context("read wallets.json")?;
    Ok(serde_json::from_str(&s).unwrap_or_else(|_| ensure_default_registry()))
}

fn ensure_default_registry() -> RegistryFile {
    RegistryFile {
        active_id: "default".into(),
        wallets: vec![WalletProfile {
            id: "default".into(),
            label: "Primary".into(),
            created_at: now_secs(),
        }],
    }
}

fn save_raw(reg: &RegistryFile) -> Result<()> {
    if let Some(parent) = wallets_registry_path().parent() {
        fs::create_dir_all(parent)?;
    }
    let s = serde_json::to_string_pretty(reg)?;
    fs::write(wallets_registry_path(), s).context("write wallets.json")?;
    Ok(())
}

/// Ensure registry exists and apply active profile paths.
pub fn bootstrap_from_prefs() -> Result<()> {
    let mut prefs = load_prefs();
    let mut reg = load_raw()?;
    if reg.wallets.is_empty() {
        reg = ensure_default_registry();
    }
    if !reg.wallets.iter().any(|w| w.id == prefs.active_wallet_id) {
        prefs.active_wallet_id = reg.active_id.clone();
        let _ = save_prefs(&prefs);
    }
    reg.active_id = prefs.active_wallet_id.clone();
    save_raw(&reg)?;
    apply_wallet_profile(&reg.active_id);
    Ok(())
}

pub fn list_profiles() -> Result<(String, Vec<WalletProfile>)> {
    let reg = load_raw()?;
    Ok((reg.active_id, reg.wallets))
}

pub fn create_profile(label: String) -> Result<WalletProfile> {
    let mut reg = load_raw()?;
    let mut suffix = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut suffix);
    let id = format!("w{}_{}", now_secs(), hex::encode(suffix));
    let profile = WalletProfile {
        id: id.clone(),
        label: if label.trim().is_empty() {
            format!("Wallet {}", reg.wallets.len() + 1)
        } else {
            label.trim().to_string()
        },
        created_at: now_secs(),
    };
    fs::create_dir_all(crate::paths::wallet_profile_dir(&id))?;
    reg.wallets.push(profile.clone());
    reg.active_id = id.clone();
    save_raw(&reg)?;
    apply_wallet_profile(&id);
    let mut prefs = load_prefs();
    prefs.active_wallet_id = id;
    save_prefs(&prefs)?;
    Ok(profile)
}

/// Switch active profile paths (caller must lock wallet / clear session).
pub fn switch_profile(wallet_id: &str) -> Result<()> {
    let mut reg = load_raw()?;
    if !reg.wallets.iter().any(|w| w.id == wallet_id) {
        return Err(anyhow!("Unknown wallet profile"));
    }
    reg.active_id = wallet_id.to_string();
    save_raw(&reg)?;
    apply_wallet_profile(wallet_id);
    let mut prefs = load_prefs();
    prefs.active_wallet_id = wallet_id.to_string();
    save_prefs(&prefs)?;
    Ok(())
}

pub fn rename_profile(wallet_id: &str, label: String) -> Result<Vec<WalletProfile>> {
    let mut reg = load_raw()?;
    let Some(w) = reg.wallets.iter_mut().find(|w| w.id == wallet_id) else {
        return Err(anyhow!("Unknown wallet profile"));
    };
    w.label = label.trim().to_string();
    save_raw(&reg)?;
    Ok(reg.wallets)
}

/// Remove a non-active, non-default profile directory.
pub fn remove_profile(wallet_id: &str) -> Result<Vec<WalletProfile>> {
    if wallet_id == "default" {
        return Err(anyhow!("Cannot remove the primary wallet profile"));
    }
    if !is_valid_created_wallet_id(wallet_id) {
        return Err(anyhow!("Invalid wallet profile id"));
    }
    let mut reg = load_raw()?;
    if !reg.wallets.iter().any(|w| w.id == wallet_id) {
        return Err(anyhow!("Unknown wallet profile"));
    }
    if reg.active_id == wallet_id {
        return Err(anyhow!("Switch away from this wallet before removing it"));
    }
    let wallets_root = app_root().join("wallets");
    let dir = crate::paths::wallet_profile_dir(wallet_id);
    if dir.exists() {
        let wallets_root_canon = wallets_root
            .canonicalize()
            .context("canonicalize wallets root")?;
        let target = dir.canonicalize().context("canonicalize profile dir")?;
        if !target.starts_with(&wallets_root_canon) {
            return Err(anyhow!("Refusing to remove a path outside the wallets directory"));
        }
        fs::remove_dir_all(&target).context("remove wallet profile directory")?;
    }
    reg.wallets.retain(|w| w.id != wallet_id);
    save_raw(&reg)?;
    Ok(reg.wallets)
}

#[cfg(test)]
mod tests {
    use super::is_valid_created_wallet_id;

    #[test]
    fn created_wallet_id_rejects_traversal() {
        assert!(is_valid_created_wallet_id("w1712345678"));
        assert!(is_valid_created_wallet_id("w1712345678_deadbeef"));
        assert!(!is_valid_created_wallet_id("default"));
        assert!(!is_valid_created_wallet_id("w"));
        assert!(!is_valid_created_wallet_id("w1/../etc"));
        assert!(!is_valid_created_wallet_id("../w1"));
        assert!(!is_valid_created_wallet_id("w1/../../tmp"));
        assert!(!is_valid_created_wallet_id("w1;rm"));
    }
}
