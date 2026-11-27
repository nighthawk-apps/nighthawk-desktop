use crate::address_book::{self, AddressBookEntry};
use crate::paths::{Network, cache_path, darkirc_path, ensure_dirs, wallet_db_path};
use crate::prefs::{Prefs, load_prefs as load_prefs_file, save_prefs};
use crate::secure_store;
use crate::state::{AppState, MinerHandle};
use crate::wallets;
use blackhawk::{
    DarkfiWalletHandle, DarkfiWalletNativeError, DarkircEventCallback, DarkircTransport,
    DrkBootstrapConfig, ReorgEvent, ReorgEventCallback, clear_dm_contacts,
    darkirc_connection_phase, darkirc_status, generate_darkfi_mnemonic, generate_dm_keypair,
    is_arti_running, is_nym_running, redact_sync_error, register_dm_contact_ex, send_chat_message,
    set_network_storage_dir, start_arti_proxy, start_darkirc, stop_arti_proxy, stop_darkirc,
    stop_nym_proxy,
    transport_manager::{self, TransportKind},
    unregister_dm_contact, validate_darkfi_mnemonic,
};
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

mod chat;
mod dao;
mod mining;
mod settings;
#[cfg(test)]
mod tests;
mod wallet;

pub use chat::*;
pub use dao::*;
pub use mining::*;
pub use settings::*;
pub use wallet::*;

pub(super) fn map_err(e: impl ToString) -> String {
    redact_sync_error(&e.to_string())
}

pub(super) fn ffi_err(e: DarkfiWalletNativeError) -> String {
    redact_sync_error(&e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatusDto {
    pub wallet_open: bool,
    pub network: String,
    pub has_pin: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshotDto {
    pub scanned_blocks: i64,
    pub chain_tip: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightSyncDto {
    pub status: String,
    pub sync_type: String,
    pub status_message: String,
    pub sync_type_message: String,
    pub scanned_height: i64,
    pub chain_tip: i64,
    pub omr_available: bool,
    pub sync_method: String,
    pub fallback_reason: String,
    pub fallback_user_message: String,
    pub proto_version_mismatch: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxDto {
    pub tx_hash: String,
    pub height: i64,
    pub timestamp: i64,
    pub status: String,
    pub summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MineStatusDto {
    pub running: bool,
    pub threads: u32,
    pub stratum_url: String,
    pub address: String,
    pub hashrate_hs: Option<f64>,
    pub last_log: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub event_id: String,
    pub channel: String,
    pub nick: String,
    pub message: String,
    pub timestamp: u64,
    pub is_outgoing: bool,
}

pub(super) struct TauriChatCb {
    app: AppHandle,
}

impl DarkircEventCallback for TauriChatCb {
    fn on_message(
        &self,
        event_id: String,
        channel: String,
        nick: String,
        message: String,
        timestamp: u64,
        is_outgoing: bool,
    ) {
        let _ = self.app.emit(
            "chat://message",
            ChatMessageDto {
                event_id,
                channel,
                nick,
                message,
                timestamp,
                is_outgoing,
            },
        );
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorgDto {
    pub detected_at_height: u32,
    pub rewound_to: u32,
    pub blocks_invalidated: u32,
    pub txs_affected: u32,
    pub summary_message: String,
}

pub(super) struct TauriReorgCb {
    app: AppHandle,
}

impl ReorgEventCallback for TauriReorgCb {
    fn on_reorg(&self, event: ReorgEvent) {
        let _ = self.app.emit(
            "wallet://reorg",
            ReorgDto {
                detected_at_height: event.detected_at_height,
                rewound_to: event.rewound_to,
                blocks_invalidated: event.blocks_invalidated,
                txs_affected: event.txs_affected,
                summary_message: event.summary_message,
            },
        );
    }
}

pub(super) fn attach_reorg_callback(app: &AppHandle, handle: &DarkfiWalletHandle) {
    let cb: Box<dyn ReorgEventCallback> = Box::new(TauriReorgCb { app: app.clone() });
    handle.set_reorg_callback(Some(cb));
}

/// SHA-256 leaf pins: one or more 32-byte digests, at most 128 bytes.
pub(super) fn decode_tls_pin_bytes(pin: &str) -> Result<Vec<u8>, String> {
    let bytes = hex::decode(pin.trim()).map_err(|e| format!("TLS pin hex: {e}"))?;
    if bytes.is_empty() || bytes.len() % 32 != 0 || bytes.len() > 128 {
        return Err(format!(
            "TLS pin must be 32–128 bytes in 32-byte pins (64–256 hex chars), got {}",
            bytes.len()
        ));
    }
    Ok(bytes)
}

pub(super) fn build_bootstrap(
    mnemonic: Vec<String>,
    network: Network,
    wallet_pass: String,
    prefs: &Prefs,
) -> Result<DrkBootstrapConfig, String> {
    ensure_dirs(network).map_err(map_err)?;
    let tls_pin = match &prefs.lightwallet_tls_pin_sha256 {
        None => None,
        Some(s) if s.trim().is_empty() => None,
        Some(s) => Some(decode_tls_pin_bytes(s)?),
    };
    if let Some(ref rpc) = prefs.darkfid_rpc_url
        && !rpc.trim().is_empty()
    {
        let parsed = endpoint_url(rpc).map_err(|e| format!("invalid darkfid RPC: {e}"))?;
        if !url_host_loopback(&parsed) {
            return Err("Remote darkfid RPC is disallowed; only loopback darkfid RPC endpoints are permitted".into());
        }
    }
    Ok(DrkBootstrapConfig {
        network: network.as_str().to_string(),
        mnemonic,
        wallet_db_path: wallet_db_path(network).to_string_lossy().to_string(),
        cache_path: cache_path(network).to_string_lossy().to_string(),
        wallet_pass,
        lightwallet_server_url: prefs.lightwallet_url.clone(),
        birthday_height: prefs.birthday_height,
        lightwallet_tls_pin_sha256: tls_pin,
        use_tor: prefs.use_tor,
        tor_socks_port: prefs.tor_socks_port,
        use_nym: prefs.use_nym,
        nym_socks_port: prefs.nym_socks_port,
        darkfid_rpc_url: prefs.darkfid_rpc_url.clone(),
        strict_omr_only: prefs.strict_omr_only,
    })
}

pub(super) fn transport_kind_for_prefs(prefs: &Prefs) -> TransportKind {
    if prefs.use_nym {
        TransportKind::Nym
    } else if prefs.use_tor {
        TransportKind::Tor
    } else {
        TransportKind::Direct
    }
}

pub(super) fn darkirc_transport_for_prefs(prefs: &Prefs) -> (DarkircTransport, u16) {
    if transport_manager::session_direct() {
        return (DarkircTransport::Direct, 0);
    }
    match transport_kind_for_prefs(prefs) {
        TransportKind::Nym => (DarkircTransport::Nym, prefs.nym_socks_port),
        TransportKind::Tor => (DarkircTransport::Tor, prefs.tor_socks_port),
        TransportKind::Direct => (DarkircTransport::Direct, 0),
    }
}

pub(super) fn darkirc_is_active() -> bool {
    !matches!(
        darkirc_status().as_str(),
        "not_running" | "stopped" | "failed" | "disabled"
    )
}

pub(super) fn wait_for_darkirc_idle(timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if matches!(
            darkirc_status().as_str(),
            "not_running" | "stopped" | "failed" | "disabled"
        ) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(super) fn stop_darkirc_if_active() {
    if darkirc_is_active() {
        let _ = stop_darkirc();
        wait_for_darkirc_idle(Duration::from_secs(5));
    }
}

pub(super) fn apply_transport_for_prefs(old: Option<&Prefs>, prefs: &Prefs) -> Result<(), String> {
    ensure_dirs(prefs.network).map_err(map_err)?;
    set_network_storage_dir(cache_path(prefs.network).to_string_lossy().to_string());
    if let Some(prev) = old {
        if prev.tor_socks_port != prefs.tor_socks_port && is_arti_running() {
            stop_arti_proxy();
        }
        if prev.nym_socks_port != prefs.nym_socks_port && is_nym_running() {
            stop_nym_proxy();
        }
    }
    transport_manager::apply(
        transport_kind_for_prefs(prefs),
        prefs.nym_socks_port,
        prefs.tor_socks_port,
    )
}

pub(super) fn restart_darkirc_for_prefs(app: &AppHandle, prefs: &Prefs) -> Result<(), String> {
    ensure_dirs(prefs.network).map_err(map_err)?;
    let path = darkirc_path(prefs.network).to_string_lossy().to_string();
    let (transport, socks_port) = darkirc_transport_for_prefs(prefs);
    let cb: Option<Box<dyn DarkircEventCallback>> =
        Some(Box::new(TauriChatCb { app: app.clone() }));
    start_darkirc(path, transport, socks_port, cb).map_err(ffi_err)
}

pub(super) fn register_single_dm_contact_in_ffi(
    my_secret: &[u8],
    contact: &crate::dm_store::DmContactStored,
) {
    if let Ok(their_public) = bs58_decode(&contact.public_b58)
        && their_public.len() == 32
        && let Err(e) = register_dm_contact_ex(
            contact.label.clone(),
            my_secret.to_vec(),
            their_public,
            contact.ratchet_capable,
        )
    {
        tracing::warn!("DM contact {} registration skipped: {e}", contact.label);
    }
}

pub(super) fn sync_dm_contacts_to_ffi(wallet_pass: &str) -> Result<(), String> {
    let Some(keys) = crate::dm_store::load(wallet_pass).map_err(map_err)? else {
        return Ok(());
    };
    let my_secret = Zeroizing::new(bs58_decode(&keys.secret_b58)?);
    let contacts = crate::dm_store::load_contacts(wallet_pass).map_err(map_err)?;
    for contact in &contacts {
        register_single_dm_contact_in_ffi(&my_secret, contact);
    }
    Ok(())
}

pub(super) fn sync_dm_contacts_if_unlocked() {
    if let Ok(wallet_pass) = secure_store::load_wallet_pass() {
        let _ = sync_dm_contacts_to_ffi(&wallet_pass);
    }
}

pub(super) fn close_wallet_and_clear_session(state: &AppState) {
    let old_handle = state.wallet.lock().take();
    if let Some(handle) = old_handle {
        let _ = handle.close();
    }
    clear_dm_contacts();
    secure_store::clear_session();
}

pub(super) fn open_handle(config: DrkBootstrapConfig) -> Result<Arc<DarkfiWalletHandle>, String> {
    DarkfiWalletHandle::new(config)
        .map(Arc::new)
        .map_err(ffi_err)
}
