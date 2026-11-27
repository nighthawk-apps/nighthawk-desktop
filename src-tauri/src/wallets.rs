//! Multi-wallet profile registry (desktop-only).

use crate::paths::{app_root, apply_wallet_profile, wallets_registry_path};
use crate::prefs::{load_prefs, load_prefs_checked, save_prefs};
use anyhow::{Context, Result, anyhow};
use parking_lot::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

static WALLETS_LOCK: Mutex<()> = Mutex::new(());

/// Valid profile id: `"default"` or a created profile id (`w{unix_secs}` / `w{unix_secs}_{hex}`).
pub fn is_valid_wallet_id(id: &str) -> bool {
    id == "default" || is_valid_created_wallet_id(id)
}

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
            && suffix
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
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
    let s = serde_json::to_string_pretty(reg)?;
    crate::paths::write_atomic(&wallets_registry_path(), s.as_bytes(), true)
        .context("write wallets.json")?;
    Ok(())
}

/// Ensure registry exists and apply active profile paths.
pub fn bootstrap_from_prefs() -> Result<()> {
    let _guard = WALLETS_LOCK.lock();
    let (mut prefs, prefs_corrupt) = load_prefs_checked();
    let mut reg = load_raw()?;
    if reg.wallets.is_empty() {
        reg = ensure_default_registry();
    }
    if !reg.wallets.iter().any(|w| w.id == prefs.active_wallet_id) {
        prefs.active_wallet_id = reg.active_id.clone();
        if !prefs_corrupt {
            let _ = save_prefs(&prefs);
        }
    }
    reg.active_id = prefs.active_wallet_id.clone();
    save_raw(&reg)?;
    apply_wallet_profile(&reg.active_id);
    Ok(())
}

pub fn list_profiles() -> Result<(String, Vec<WalletProfile>)> {
    let _guard = WALLETS_LOCK.lock();
    let reg = load_raw()?;
    Ok((reg.active_id, reg.wallets))
}

pub fn create_profile(label: String) -> Result<WalletProfile> {
    let _guard = WALLETS_LOCK.lock();
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
    let _guard = WALLETS_LOCK.lock();
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
    let _guard = WALLETS_LOCK.lock();
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
    let _guard = WALLETS_LOCK.lock();
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
            return Err(anyhow!(
                "Refusing to remove a path outside the wallets directory"
            ));
        }
        crate::secure_store::delete_vault_key_for_root(&dir);
        crate::address_book::delete_key_for_root(&dir);
        fs::remove_dir_all(&target).context("remove wallet profile directory")?;
    } else {
        crate::secure_store::delete_vault_key_for_root(&dir);
        crate::address_book::delete_key_for_root(&dir);
    }
    reg.wallets.retain(|w| w.id != wallet_id);
    save_raw(&reg)?;
    Ok(reg.wallets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn created_wallet_id_rejects_traversal() {
        assert!(is_valid_wallet_id("default"));
        assert!(is_valid_created_wallet_id("w1712345678"));
        assert!(is_valid_created_wallet_id("w1712345678_deadbeef"));
        assert!(!is_valid_created_wallet_id("default"));
        assert!(!is_valid_created_wallet_id("w"));
        assert!(!is_valid_created_wallet_id("w1/../etc"));
        assert!(!is_valid_created_wallet_id("../w1"));
        assert!(!is_valid_created_wallet_id("w1/../../tmp"));
        assert!(!is_valid_created_wallet_id("w1;rm"));
    }

    #[test]
    fn wallets_lifecycle_create_rename_switch_and_remove() {
        let _guard = crate::paths::test_wallet_root_guard();
        let tmp_root =
            std::env::temp_dir().join(format!("nh_wallets_test_{}", rand::random::<u64>()));
        fs::create_dir_all(&tmp_root).unwrap();
        crate::paths::set_app_root_override(Some(tmp_root.clone()));
        crate::paths::set_wallet_data_root(None);

        bootstrap_from_prefs().unwrap();
        let (active, list) = list_profiles().unwrap();
        assert_eq!(active, "default");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "Primary");

        let created = create_profile("Savings".into()).unwrap();
        assert!(is_valid_created_wallet_id(&created.id));
        assert!(crate::paths::wallet_profile_dir(&created.id).exists());
        let (active, list) = list_profiles().unwrap();
        assert_eq!(active, created.id);
        assert_eq!(list.len(), 2);

        let renamed = rename_profile(&created.id, "Vault 2".into()).unwrap();
        assert_eq!(
            renamed.iter().find(|w| w.id == created.id).unwrap().label,
            "Vault 2"
        );

        // Active and primary profiles cannot be removed.
        assert!(remove_profile(&created.id).is_err());
        assert!(remove_profile("default").is_err());

        // Switching away allows removing the created profile and deletes its directory.
        switch_profile("default").unwrap();
        let remaining = remove_profile(&created.id).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "default");
        assert!(!crate::paths::wallet_profile_dir(&created.id).exists());

        crate::paths::set_wallet_data_root(None);
        crate::paths::set_app_root_override(None);
        let _ = fs::remove_dir_all(&tmp_root);
    }
}
