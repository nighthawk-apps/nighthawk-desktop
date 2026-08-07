use crate::paths::{prefs_path, Network};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub network: Network,
    /// Alias keeps older on-disk `prefs.json` (snake_case) loadable.
    #[serde(alias = "lightwallet_url")]
    pub lightwallet_url: String,
    #[serde(alias = "darkfid_rpc_url")]
    pub darkfid_rpc_url: Option<String>,
    #[serde(alias = "stratum_url")]
    pub stratum_url: String,
    #[serde(alias = "use_tor")]
    /// Route wallet sync + chat through the embedded arti Tor client.
    /// Default ON (privacy-first production default); localhost endpoints
    /// always connect directly.
    pub use_tor: bool,
    #[serde(alias = "tor_socks_port")]
    pub tor_socks_port: u16,
    #[serde(alias = "mine_threads")]
    pub mine_threads: u32,
    #[serde(alias = "chat_nick")]
    pub chat_nick: String,
    #[serde(alias = "birthday_height")]
    pub birthday_height: i64,
    /// Hex-encoded SHA-256 of LWD leaf cert DER (required for remote HTTPS).
    #[serde(default, alias = "lightwallet_tls_pin_sha256")]
    pub lightwallet_tls_pin_sha256: Option<String>,
    /// Fee preference: economy | normal | priority (UI multiplier; protocol fee is authoritative).
    #[serde(default = "default_fee_tier", alias = "fee_tier")]
    pub fee_tier: String,
    /// Active multi-wallet profile id (`default` = legacy app-root layout).
    #[serde(default = "default_wallet_id", alias = "active_wallet_id")]
    pub active_wallet_id: String,
    /// When true, UnifOMR-only sync (no supplemental/gap trial decrypt).
    /// Default false so Nighthawk can receive from non-UnifOMR wallets (e.g. `drk`).
    #[serde(default = "default_strict_omr_only", alias = "strict_omr_only")]
    pub strict_omr_only: bool,
}

fn default_strict_omr_only() -> bool {
    false
}

fn default_fee_tier() -> String {
    "normal".into()
}

fn default_wallet_id() -> String {
    "default".into()
}

impl Default for Prefs {
    fn default() -> Self {
        let network = Network::Testnet;
        Self {
            network,
            lightwallet_url: network.default_lwd().to_string(),
            darkfid_rpc_url: None,
            stratum_url: network.default_stratum().to_string(),
            // Direct to Studio ngrok for testnet; enable Tor in settings if desired.
            use_tor: true,
            tor_socks_port: 9150,
            mine_threads: 12,
            chat_nick: "nighthawk".to_string(),
            birthday_height: 0,
            lightwallet_tls_pin_sha256: network.default_lwd_tls_pin().map(str::to_string),
            fee_tier: default_fee_tier(),
            active_wallet_id: default_wallet_id(),
            strict_omr_only: default_strict_omr_only(),
        }
    }
}

pub fn load_prefs() -> Prefs {
    let path = prefs_path();
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Prefs::default(),
    }
}

pub fn save_prefs(prefs: &Prefs) -> Result<()> {
    if let Some(parent) = prefs_path().parent() {
        fs::create_dir_all(parent)?;
    }
    let s = serde_json::to_string_pretty(prefs)?;
    fs::write(prefs_path(), s).context("write prefs")?;
    Ok(())
}
