use crate::address_book::{self, AddressBookEntry};
use crate::paths::{Network, cache_path, darkirc_path, ensure_dirs, wallet_db_path};
use crate::prefs::{Prefs, load_prefs as load_prefs_file, save_prefs};
use crate::secure_store;
use crate::state::{AppState, MinerHandle};
use crate::wallets;
use darkfi_mobile_ffi::{
    DarkfiWalletHandle, DarkfiWalletNativeError, DarkircEventCallback, DarkircTransport,
    DrkBootstrapConfig, ReorgEvent, ReorgEventCallback, chacha_decrypt_dm, chacha_encrypt_dm,
    clear_dm_contacts, darkirc_connection_phase, darkirc_status, generate_darkfi_mnemonic,
    generate_dm_keypair, is_arti_running, is_nym_running, nym_status as ffi_nym_status,
    redact_sync_error, register_dm_contact, send_chat_message, set_network_storage_dir,
    start_arti_proxy, start_darkirc, stop_arti_proxy, stop_darkirc, stop_nym_proxy,
    transport_continue_without_nym as ffi_transport_continue_without_nym,
    transport_manager::{self, TransportKind},
    transport_snapshot_json, unregister_dm_contact, validate_darkfi_mnemonic,
};
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

fn map_err(e: impl ToString) -> String {
    redact_sync_error(&e.to_string())
}

fn ffi_err(e: DarkfiWalletNativeError) -> String {
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

struct TauriChatCb {
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

struct TauriReorgCb {
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

fn attach_reorg_callback(app: &AppHandle, handle: &DarkfiWalletHandle) {
    let cb: Box<dyn ReorgEventCallback> = Box::new(TauriReorgCb { app: app.clone() });
    handle.set_reorg_callback(Some(cb));
}

fn build_bootstrap(
    mnemonic: Vec<String>,
    network: Network,
    wallet_pass: String,
    prefs: &Prefs,
) -> Result<DrkBootstrapConfig, String> {
    ensure_dirs(network).map_err(map_err)?;
    let tls_pin = match &prefs.lightwallet_tls_pin_sha256 {
        None => None,
        Some(s) if s.trim().is_empty() => None,
        Some(s) => {
            let bytes = hex::decode(s.trim()).map_err(|e| format!("TLS pin hex: {e}"))?;
            if bytes.is_empty() || bytes.len() % 32 != 0 || bytes.len() > 128 {
                return Err(format!(
                    "TLS pin must be 32–128 bytes in 32-byte pins (64–256 hex chars), got {}",
                    bytes.len()
                ));
            }
            Some(bytes)
        }
    };
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

fn transport_kind_for_prefs(prefs: &Prefs) -> TransportKind {
    if prefs.use_nym {
        TransportKind::Nym
    } else if prefs.use_tor {
        TransportKind::Tor
    } else {
        TransportKind::Direct
    }
}

fn darkirc_transport_for_prefs(prefs: &Prefs) -> (DarkircTransport, u16) {
    if transport_manager::session_direct() {
        return (DarkircTransport::Direct, 0);
    }
    match transport_kind_for_prefs(prefs) {
        TransportKind::Nym => (DarkircTransport::Nym, prefs.nym_socks_port),
        TransportKind::Tor => (DarkircTransport::Tor, prefs.tor_socks_port),
        TransportKind::Direct => (DarkircTransport::Direct, 0),
    }
}

fn darkirc_is_active() -> bool {
    !matches!(
        darkirc_status().as_str(),
        "not_running" | "stopped" | "failed" | "disabled"
    )
}

fn wait_for_darkirc_idle(timeout: Duration) {
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

fn stop_darkirc_if_active() {
    if darkirc_is_active() {
        let _ = stop_darkirc();
        wait_for_darkirc_idle(Duration::from_secs(5));
    }
}

fn apply_transport_for_prefs(old: Option<&Prefs>, prefs: &Prefs) -> Result<(), String> {
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

fn restart_darkirc_for_prefs(app: &AppHandle, prefs: &Prefs) -> Result<(), String> {
    ensure_dirs(prefs.network).map_err(map_err)?;
    let path = darkirc_path(prefs.network).to_string_lossy().to_string();
    let (transport, socks_port) = darkirc_transport_for_prefs(prefs);
    let cb: Option<Box<dyn DarkircEventCallback>> =
        Some(Box::new(TauriChatCb { app: app.clone() }));
    start_darkirc(path, transport, socks_port, cb).map_err(ffi_err)
}

fn sync_dm_contacts_to_ffi(wallet_pass: &str) -> Result<(), String> {
    clear_dm_contacts();
    let Some(keys) = crate::dm_store::load(wallet_pass).map_err(map_err)? else {
        return Ok(());
    };
    let my_secret = Zeroizing::new(bs58_decode(&keys.secret_b58)?);
    let contacts = crate::dm_store::load_contacts(wallet_pass).map_err(map_err)?;
    for contact in contacts {
        if let Ok(their_public) = bs58_decode(&contact.public_b58)
            && their_public.len() == 32
        {
            register_dm_contact(contact.label.clone(), my_secret.to_vec(), their_public)
                .map_err(|e| format!("DM contact {} was not registered: {e}", contact.label))?;
        }
    }
    Ok(())
}

fn sync_dm_contacts_if_unlocked() {
    if let Ok(wallet_pass) = secure_store::load_wallet_pass() {
        let _ = sync_dm_contacts_to_ffi(&wallet_pass);
    }
}

fn close_wallet_and_clear_session(state: &AppState) {
    let old_handle = state.wallet.lock().take();
    if let Some(handle) = old_handle {
        let _ = handle.close();
    }
    clear_dm_contacts();
    secure_store::clear_session();
}

fn open_handle(config: DrkBootstrapConfig) -> Result<Arc<DarkfiWalletHandle>, String> {
    DarkfiWalletHandle::new(config)
        .map(Arc::new)
        .map_err(ffi_err)
}

#[tauri::command]
pub fn app_status(state: State<'_, AppState>) -> Result<AppStatusDto, String> {
    let network = *state.network.lock();
    Ok(AppStatusDto {
        wallet_open: state.wallet.lock().is_some(),
        network: network.as_str().to_string(),
        has_pin: secure_store::has_pin().unwrap_or(false),
    })
}

// Note: has_pin / wallet_exists use vault.meta on disk — no Keychain prompts.

#[tauri::command]
pub fn get_prefs(state: State<'_, AppState>) -> Prefs {
    state.prefs.lock().clone()
}

#[tauri::command]
pub async fn set_prefs(
    app: AppHandle,
    state: State<'_, AppState>,
    mut prefs: Prefs,
) -> Result<(), String> {
    if !prefs.lightwallet_url.trim().is_empty() {
        validate_lwd_url(&prefs.lightwallet_url)?;
    }
    if !prefs.stratum_url.trim().is_empty() {
        validate_host_port(&prefs.stratum_url, "stratum")?;
    }
    if let Some(rpc) = &prefs.darkfid_rpc_url
        && !rpc.trim().is_empty()
    {
        validate_host_port(rpc, "darkfid RPC")?;
    }
    prefs.chat_nick = sanitize_nickname(prefs.chat_nick.trim())?;
    let old = state.prefs.lock().clone();
    if !wallets::is_valid_wallet_id(&prefs.active_wallet_id) {
        return Err("Invalid active wallet profile id".into());
    }
    if prefs.active_wallet_id != old.active_wallet_id {
        return Err("Use the wallet profile switcher to change the active wallet".into());
    }
    let transport_changed = old.use_tor != prefs.use_tor
        || old.tor_socks_port != prefs.tor_socks_port
        || old.use_nym != prefs.use_nym
        || old.nym_socks_port != prefs.nym_socks_port
        || old.network != prefs.network;
    let needs_wallet_reopen = old.lightwallet_url != prefs.lightwallet_url
        || old.lightwallet_tls_pin_sha256 != prefs.lightwallet_tls_pin_sha256
        || transport_changed;
    save_prefs(&prefs).map_err(map_err)?;
    *state.network.lock() = prefs.network;
    if needs_wallet_reopen {
        // LWD / transport / TLS pin only apply at bootstrap — close the open handle.
        close_wallet_and_clear_session(&state);
    } else if let Some(handle) = state.wallet.lock().as_ref().cloned() {
        handle.set_strict_omr_only(prefs.strict_omr_only);
    }
    *state.prefs.lock() = prefs.clone();

    if transport_changed {
        let app_clone = app.clone();
        let prefs_for_transport = prefs.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let was_darkirc_active = darkirc_is_active();
            if was_darkirc_active {
                let _ = stop_darkirc();
                wait_for_darkirc_idle(Duration::from_secs(5));
            }
            apply_transport_for_prefs(Some(&old), &prefs_for_transport)?;
            if was_darkirc_active {
                sync_dm_contacts_if_unlocked();
                restart_darkirc_for_prefs(&app_clone, &prefs_for_transport)?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|e| format!("Transport reconfigure interrupted: {e}"))??;
    }
    if needs_wallet_reopen && secure_store::wallet_exists() {
        open_existing_wallet(&app, state.inner())
            .await
            .map_err(|e| format!("Preferences saved, but failed to reopen wallet: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn wallet_exists() -> bool {
    secure_store::wallet_exists()
}

#[tauri::command]
pub fn generate_mnemonic() -> Vec<String> {
    generate_darkfi_mnemonic()
}

/// One-shot e2e helper: if `e2e_restore_mnemonic.txt` is in the app data dir and
/// no vault exists, create the vault from that phrase and delete the file.
/// Never logs the phrase. Debug-only — omitted from release binaries.
#[cfg(debug_assertions)]
pub(crate) fn maybe_e2e_restore_from_file() {
    let path = crate::paths::app_root().join("e2e_restore_mnemonic.txt");
    if !path.is_file() || secure_store::wallet_exists() {
        return;
    }
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    let mnemonic: Vec<String> = text
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if !validate_darkfi_mnemonic(mnemonic.clone()) {
        tracing::error!("e2e restore file was present but the phrase is invalid");
        return;
    }
    let pass = secure_store::wallet_pass_for_mnemonic(&mnemonic);
    match secure_store::create_vault(&mnemonic, &pass, false) {
        Ok(()) => tracing::info!("e2e restore: vault created"),
        Err(e) => tracing::error!("e2e restore failed: {e}"),
    }
}

async fn persist_and_open(
    app: &AppHandle,
    state: &AppState,
    mnemonic: Vec<String>,
    network: Network,
    birthday_height: i64,
    lightwallet_url: Option<String>,
) -> Result<(), String> {
    if !validate_darkfi_mnemonic(mnemonic.clone()) {
        return Err("Invalid mnemonic".into());
    }
    // An existing vault is opened, never replaced, from the create/restore screen.
    if secure_store::wallet_exists() {
        return open_existing_wallet(app, state).await;
    }
    let overwrite = false;
    let mut prefs = state.prefs.lock().clone();
    prefs.network = network;
    prefs.birthday_height = birthday_height;
    if let Some(url) = lightwallet_url {
        if !url.trim().is_empty() {
            validate_lwd_url(&url)?;
        }
        prefs.lightwallet_url = url;
    }
    prefs.stratum_url = network.default_stratum().to_string();
    let wallet_pass = secure_store::wallet_pass_for_mnemonic(&mnemonic);
    secure_store::create_vault(&mnemonic, &wallet_pass, overwrite).map_err(map_err)?;
    save_prefs(&prefs).map_err(map_err)?;
    *state.prefs.lock() = prefs.clone();
    *state.network.lock() = network;
    let _ = wallets::bootstrap_from_prefs();

    let cfg = build_bootstrap(mnemonic, network, wallet_pass, &prefs)?;
    let handle = match tauri::async_runtime::spawn_blocking(move || open_handle(cfg))
        .await
        .map_err(|e| format!("Wallet open interrupted: {e}"))?
    {
        Ok(h) => h,
        Err(e) => {
            secure_store::clear_session();
            return Err(e);
        }
    };
    attach_reorg_callback(app, &handle);
    *state.wallet.lock() = Some(handle);
    sync_dm_contacts_if_unlocked();
    Ok(())
}

#[tauri::command]
pub async fn create_wallet(
    app: AppHandle,
    state: State<'_, AppState>,
    mnemonic: Vec<String>,
    network: String,
    birthday_height: i64,
    lightwallet_url: Option<String>,
) -> Result<(), String> {
    let network: Network = network.parse()?;
    persist_and_open(
        &app,
        &state,
        mnemonic,
        network,
        birthday_height,
        lightwallet_url,
    )
    .await
}

#[tauri::command]
pub async fn restore_wallet(
    app: AppHandle,
    state: State<'_, AppState>,
    mnemonic: Vec<String>,
    network: String,
    birthday_height: i64,
    lightwallet_url: Option<String>,
) -> Result<(), String> {
    let network: Network = network.parse()?;
    persist_and_open(
        &app,
        &state,
        mnemonic,
        network,
        birthday_height,
        lightwallet_url,
    )
    .await
}

/// Open an existing vault (no PIN). Called automatically on app start.
#[tauri::command]
pub async fn open_wallet(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    open_existing_wallet(&app, state.inner()).await
}

async fn open_existing_wallet(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let _ = wallets::bootstrap_from_prefs();
    if state.wallet.lock().is_some() {
        return Ok(());
    }

    let (mnemonic, wallet_pass) = tauri::async_runtime::spawn_blocking(move || {
        secure_store::unlock_session().map_err(map_err)?;
        let mnemonic = secure_store::load_mnemonic().map_err(map_err)?;
        let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
        Ok::<_, String>((mnemonic, wallet_pass))
    })
    .await
    .map_err(|e| format!("Open interrupted: {e}"))??;

    let prefs = state.prefs.lock().clone();
    let network = prefs.network;
    let cfg = build_bootstrap(mnemonic, network, wallet_pass, &prefs)?;
    let handle = tauri::async_runtime::spawn_blocking(move || open_handle(cfg))
        .await
        .map_err(|e| format!("Wallet open interrupted: {e}"))??;
    attach_reorg_callback(app, &handle);
    *state.wallet.lock() = Some(handle);
    sync_dm_contacts_if_unlocked();
    Ok(())
}

fn wallet_arc(state: &AppState) -> Result<Arc<DarkfiWalletHandle>, String> {
    state
        .wallet
        .lock()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Wallet locked".to_string())
}

async fn with_wallet_blocking<T, F>(state: &AppState, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Arc<DarkfiWalletHandle>) -> Result<T, String> + Send + 'static,
{
    let handle = wallet_arc(state)?;
    tauri::async_runtime::spawn_blocking(move || f(handle))
        .await
        .map_err(|e| format!("Wallet operation interrupted: {e}"))?
}

#[tauri::command]
pub async fn wallet_balance(state: State<'_, AppState>) -> Result<i64, String> {
    with_wallet_blocking(&state, |w| w.confirmed_balance_atomic().map_err(ffi_err)).await
}

#[tauri::command]
pub async fn wallet_address(state: State<'_, AppState>) -> Result<String, String> {
    with_wallet_blocking(&state, |w| w.primary_deposit_address().map_err(ffi_err)).await
}

#[tauri::command]
pub async fn wallet_addresses(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    with_wallet_blocking(&state, |w| w.list_addresses().map_err(ffi_err)).await
}

#[tauri::command]
pub async fn generate_address(state: State<'_, AppState>) -> Result<String, String> {
    with_wallet_blocking(&state, |w| w.generate_new_address().map_err(ffi_err)).await
}

#[tauri::command]
pub async fn wallet_refresh(state: State<'_, AppState>) -> Result<SyncSnapshotDto, String> {
    with_wallet_blocking(&state, |w| {
        let s = w.refresh_now().map_err(ffi_err)?;
        Ok(SyncSnapshotDto {
            scanned_blocks: s.scanned_blocks,
            chain_tip: s.chain_tip,
        })
    })
    .await
}

#[tauri::command]
pub async fn wallet_sync_snapshot(state: State<'_, AppState>) -> Result<SyncSnapshotDto, String> {
    with_wallet_blocking(&state, |w| {
        let s = w.sync_snapshot().map_err(ffi_err)?;
        Ok(SyncSnapshotDto {
            scanned_blocks: s.scanned_blocks,
            chain_tip: s.chain_tip,
        })
    })
    .await
}

#[tauri::command]
pub async fn wallet_light_sync(state: State<'_, AppState>) -> Result<LightSyncDto, String> {
    with_wallet_blocking(&state, |w| {
        let s = w.light_sync_snapshot();
        Ok(LightSyncDto {
            status: s.status,
            sync_type: s.sync_type,
            status_message: s.status_message,
            sync_type_message: s.sync_type_message,
            scanned_height: s.scanned_height,
            chain_tip: s.chain_tip,
            omr_available: s.omr_available,
            sync_method: format!("{:?}", s.sync_method),
            fallback_reason: format!("{:?}", s.fallback_reason),
            fallback_user_message: s.fallback_user_message,
            proto_version_mismatch: s.proto_version_mismatch,
        })
    })
    .await
}

#[tauri::command]
pub async fn wallet_list_txs(state: State<'_, AppState>) -> Result<Vec<TxDto>, String> {
    with_wallet_blocking(&state, |w| {
        let list = w.list_transactions().map_err(ffi_err)?;
        Ok(list
            .into_iter()
            .map(|t| TxDto {
                tx_hash: t.tx_hash,
                height: t.block_height,
                timestamp: 0,
                status: t.status,
                summary: t.contract_summary,
            })
            .collect())
    })
    .await
}

/// Spends need a Money tree that includes genesis and a cursor at the tip.
/// Notes can show up earlier; sending before that builds a proof against a short tree.
/// `Degraded` is the caught-up state when UnifOMR is down; the cursor check
/// still refuses a wallet that has not reached the tip.
fn spend_ready(status: &str, scanned: i64, tip: i64, proto_mismatch: bool) -> bool {
    if proto_mismatch || tip <= 0 || scanned < tip {
        return false;
    }
    status.eq_ignore_ascii_case("Synced") || status.eq_ignore_ascii_case("Degraded")
}

fn reject_until_spend_ready(w: &DarkfiWalletHandle) -> Result<(), String> {
    let s = w.light_sync_snapshot();
    if spend_ready(
        &s.status,
        s.scanned_height,
        s.chain_tip,
        s.proto_version_mismatch,
    ) {
        return Ok(());
    }
    Err(
        "Wallet is still scanning. Send stays off until the Money tree is caught up to the tip."
            .into(),
    )
}

#[tauri::command]
pub async fn estimate_fee(
    state: State<'_, AppState>,
    recipient: String,
    amount: String,
    memo: Option<String>,
    token_id: Option<String>,
) -> Result<i64, String> {
    // Validates inputs and returns the fixed SCHEDULE_TRANSFER_FEE_ATOMIC
    // schedule constant (5_000_000 atomic), not a darkfid gas measurement.
    with_wallet_blocking(&state, |w| {
        reject_until_spend_ready(&w)?;
        w.estimate_transfer_fee(recipient, amount, token_id, memo)
            .map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn send_drk(
    state: State<'_, AppState>,
    recipient: String,
    amount: String,
    memo: Option<String>,
    token_id: Option<String>,
) -> Result<String, String> {
    with_wallet_blocking(&state, |w| {
        reject_until_spend_ready(&w)?;
        let bytes = w
            .build_transfer(recipient.clone(), amount, token_id, memo.clone())
            .map_err(ffi_err)?;
        w.broadcast_transfer(bytes, memo, Some(recipient))
            .map_err(ffi_err)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBalanceDto {
    pub token_id: String,
    pub display_label: Option<String>,
    pub balance_atomic: i64,
}

#[tauri::command]
pub async fn list_token_balances(
    state: State<'_, AppState>,
) -> Result<Vec<TokenBalanceDto>, String> {
    with_wallet_blocking(&state, |w| {
        let list = w.list_token_balances().map_err(ffi_err)?;
        Ok(list
            .into_iter()
            .map(|t| TokenBalanceDto {
                token_id: t.token_id,
                display_label: t.display_label,
                balance_atomic: t.balance_atomic,
            })
            .collect())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintAuthorityDto {
    pub token_id: String,
    pub alias: Option<String>,
    pub frozen: bool,
}

#[tauri::command]
pub async fn token_generate(
    state: State<'_, AppState>,
    alias: Option<String>,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| w.token_generate(alias).map_err(ffi_err)).await
}

#[tauri::command]
pub async fn token_mint(
    state: State<'_, AppState>,
    token_id: String,
    amount: String,
    recipient_address: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.token_mint(token_id, amount, recipient_address)
            .map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn token_freeze(state: State<'_, AppState>, token_id: String) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.token_freeze(token_id).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn list_mint_authorities(
    state: State<'_, AppState>,
) -> Result<Vec<MintAuthorityDto>, String> {
    with_wallet_blocking(&state, |w| {
        let list = w.list_mint_authorities().map_err(ffi_err)?;
        Ok(list
            .into_iter()
            .map(|a| MintAuthorityDto {
                token_id: a.token_id,
                alias: a.alias,
                frozen: a.frozen,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn transaction_payment_memo(
    state: State<'_, AppState>,
    tx_hash: String,
) -> Result<Option<String>, String> {
    with_wallet_blocking(&state, |w| {
        w.transaction_payment_memo(tx_hash).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn transaction_recipient(
    state: State<'_, AppState>,
    tx_hash: String,
) -> Result<Option<String>, String> {
    with_wallet_blocking(&state, |w| {
        w.transaction_recipient(tx_hash).map_err(ffi_err)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaoSummaryDto {
    pub name: String,
    pub bulla_b58: String,
    pub gov_token_id: String,
    pub quorum_display: String,
    pub proposer_limit_display: String,
    pub approval_ratio_percent: f64,
    pub mint_height: i64,
    pub can_propose: bool,
    pub can_vote: bool,
    pub can_exec: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaoProposalSummaryDto {
    pub proposal_bulla_b58: String,
    pub dao_name: String,
    pub dao_bulla_b58: String,
    pub auth_call_count: u32,
    pub duration_blockwindows: u64,
    pub creation_blockwindow: u64,
    pub mint_height: i64,
    pub exec_height: i64,
    pub is_executed: bool,
    pub summary_line: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaoProposalDetailDto {
    pub proposal_bulla_b58: String,
    pub dao_name: String,
    pub dao_bulla_b58: String,
    pub auth_call_count: u32,
    pub duration_blockwindows: u64,
    pub creation_blockwindow: u64,
    pub mint_height: i64,
    pub exec_height: i64,
    pub is_executed: bool,
    pub summary_line: String,
    pub propose_tx_hash: Option<String>,
    pub exec_tx_hash: Option<String>,
    pub has_plaintext_data: bool,
}

#[tauri::command]
pub async fn list_daos(state: State<'_, AppState>) -> Result<Vec<DaoSummaryDto>, String> {
    with_wallet_blocking(&state, |w| {
        let list = w.list_daos().map_err(ffi_err)?;
        Ok(list
            .into_iter()
            .map(|d| DaoSummaryDto {
                name: d.name,
                bulla_b58: d.bulla_b58,
                gov_token_id: d.gov_token_id,
                quorum_display: d.quorum_display,
                proposer_limit_display: d.proposer_limit_display,
                approval_ratio_percent: d.approval_ratio_percent,
                mint_height: d.mint_height,
                can_propose: d.can_propose,
                can_vote: d.can_vote,
                can_exec: d.can_exec,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn list_proposals(
    state: State<'_, AppState>,
    dao_name: Option<String>,
) -> Result<Vec<DaoProposalSummaryDto>, String> {
    with_wallet_blocking(&state, |w| {
        let list = w.list_proposals(dao_name).map_err(ffi_err)?;
        Ok(list
            .into_iter()
            .map(|p| DaoProposalSummaryDto {
                proposal_bulla_b58: p.proposal_bulla_b58,
                dao_name: p.dao_name,
                dao_bulla_b58: p.dao_bulla_b58,
                auth_call_count: p.auth_call_count,
                duration_blockwindows: p.duration_blockwindows,
                creation_blockwindow: p.creation_blockwindow,
                mint_height: p.mint_height,
                exec_height: p.exec_height,
                is_executed: p.is_executed,
                summary_line: p.summary_line,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn get_proposal(
    state: State<'_, AppState>,
    proposal_bulla_b58: String,
) -> Result<DaoProposalDetailDto, String> {
    with_wallet_blocking(&state, |w| {
        let p = w.get_proposal(proposal_bulla_b58).map_err(ffi_err)?;
        Ok(DaoProposalDetailDto {
            proposal_bulla_b58: p.proposal_bulla_b58,
            dao_name: p.dao_name,
            dao_bulla_b58: p.dao_bulla_b58,
            auth_call_count: p.auth_call_count,
            duration_blockwindows: p.duration_blockwindows,
            creation_blockwindow: p.creation_blockwindow,
            mint_height: p.mint_height,
            exec_height: p.exec_height,
            is_executed: p.is_executed,
            summary_line: p.summary_line,
            propose_tx_hash: p.propose_tx_hash,
            exec_tx_hash: p.exec_tx_hash,
            has_plaintext_data: p.has_plaintext_data,
        })
    })
    .await
}

#[tauri::command]
pub async fn dao_create(
    state: State<'_, AppState>,
    name: String,
    proposer_limit: String,
    quorum: String,
    early_exec_quorum: String,
    approval_ratio: f64,
    gov_token_id: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_create(
            name,
            proposer_limit,
            quorum,
            early_exec_quorum,
            approval_ratio,
            gov_token_id,
        )
        .map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_import(
    state: State<'_, AppState>,
    name: String,
    toml: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| w.dao_import(name, toml).map_err(ffi_err)).await
}

#[tauri::command]
pub async fn dao_export_role(
    state: State<'_, AppState>,
    dao_name: String,
    role: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        w.dao_export_role(dao_name, role).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_fund(
    state: State<'_, AppState>,
    dao_name: String,
    amount: String,
    token_id: Option<String>,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_fund(dao_name, amount, token_id).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_treasury(state: State<'_, AppState>, dao_name: String) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| w.dao_treasury(dao_name).map_err(ffi_err)).await
}

#[tauri::command]
pub async fn dao_propose_transfer(
    state: State<'_, AppState>,
    dao_name: String,
    duration_blockwindows: u64,
    amount: String,
    token_id: Option<String>,
    recipient_address: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_propose_transfer(
            dao_name,
            duration_blockwindows,
            amount,
            token_id,
            recipient_address,
        )
        .map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_vote(
    state: State<'_, AppState>,
    proposal_bulla_b58: String,
    vote_yes: bool,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_vote(proposal_bulla_b58, vote_yes).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_exec_proposal(
    state: State<'_, AppState>,
    proposal_bulla_b58: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_exec(proposal_bulla_b58).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn handle_reorg_recovery(
    state: State<'_, AppState>,
    rewind_to_height: u32,
) -> Result<ReorgDto, String> {
    with_wallet_blocking(&state, move |w| {
        let e = w.handle_reorg_recovery(rewind_to_height).map_err(ffi_err)?;
        Ok(ReorgDto {
            detected_at_height: e.detected_at_height,
            rewound_to: e.rewound_to,
            blocks_invalidated: e.blocks_invalidated,
            txs_affected: e.txs_affected,
            summary_message: e.summary_message,
        })
    })
    .await
}

#[tauri::command]
pub fn arti_start(state: State<'_, AppState>) -> Result<bool, String> {
    let network = *state.network.lock();
    let port = state.prefs.lock().tor_socks_port;
    let cache = cache_path(network);
    set_network_storage_dir(cache.to_string_lossy().to_string());
    start_arti_proxy(port.to_string()).map_err(ffi_err)
}

#[tauri::command]
pub fn arti_stop() {
    stop_arti_proxy();
}

#[tauri::command]
pub fn arti_status() -> bool {
    is_arti_running()
}

#[tauri::command]
pub fn nym_status() -> String {
    ffi_nym_status()
}

#[tauri::command]
pub fn transport_snapshot() -> String {
    transport_snapshot_json()
}

#[tauri::command]
pub async fn set_transport(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Result<String, String> {
    let mut prefs = state.prefs.lock().clone();
    match mode.trim().to_ascii_lowercase().as_str() {
        "nym" => {
            prefs.use_nym = true;
            prefs.use_tor = false;
        }
        "tor" => {
            prefs.use_nym = false;
            prefs.use_tor = true;
        }
        "direct" => {
            prefs.use_nym = false;
            prefs.use_tor = false;
        }
        other => return Err(format!("unknown transport mode: {other}")),
    }
    set_prefs(app, state, prefs).await?;
    Ok(transport_snapshot_json())
}

#[tauri::command]
pub async fn transport_continue_without_nym(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let prefs = state.prefs.lock().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let was_darkirc_active = darkirc_is_active();
        if was_darkirc_active {
            let _ = stop_darkirc();
            wait_for_darkirc_idle(Duration::from_secs(5));
        }
        ffi_transport_continue_without_nym();
        if was_darkirc_active {
            restart_darkirc_for_prefs(&app, &prefs)?;
        }
        Ok::<_, String>(transport_snapshot_json())
    })
    .await
    .map_err(|e| format!("Transport override interrupted: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmKeypairDto {
    pub public_b58: String,
}

fn load_dm_secret() -> Result<Vec<u8>, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    let keys = crate::dm_store::load(&wallet_pass)
        .map_err(map_err)?
        .ok_or_else(|| "No DM key on this profile".to_string())?;
    bs58_decode(&keys.secret_b58)
}

#[tauri::command]
pub fn dm_generate_keypair() -> Result<DmKeypairDto, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    let k = generate_dm_keypair();
    let stored = crate::dm_store::DmKeypairStored {
        secret_b58: k.secret_b58,
        public_b58: k.public_b58.clone(),
    };
    crate::dm_store::save(&wallet_pass, &stored).map_err(map_err)?;
    sync_dm_contacts_to_ffi(&wallet_pass)?;
    Ok(DmKeypairDto {
        public_b58: k.public_b58,
    })
}

#[tauri::command]
pub fn dm_load_keypair() -> Result<Option<DmKeypairDto>, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    let keys = crate::dm_store::load(&wallet_pass).map_err(map_err)?;
    if keys.is_some() {
        sync_dm_contacts_to_ffi(&wallet_pass)?;
    }
    Ok(keys.map(|k| DmKeypairDto {
        public_b58: k.public_b58,
    }))
}

#[tauri::command]
pub fn dm_contacts_list() -> Result<Vec<crate::dm_store::DmContactStored>, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    let contacts = crate::dm_store::load_contacts(&wallet_pass).map_err(map_err)?;
    sync_dm_contacts_to_ffi(&wallet_pass)?;
    Ok(contacts)
}

#[tauri::command]
pub fn dm_contacts_upsert(
    label: String,
    public_b58: String,
) -> Result<Vec<crate::dm_store::DmContactStored>, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    if crate::dm_store::load(&wallet_pass)
        .map_err(map_err)?
        .is_none()
    {
        let k = generate_dm_keypair();
        let stored = crate::dm_store::DmKeypairStored {
            secret_b58: k.secret_b58,
            public_b58: k.public_b58,
        };
        crate::dm_store::save(&wallet_pass, &stored).map_err(map_err)?;
    }
    let contacts =
        crate::dm_store::upsert_contact(&wallet_pass, &label, &public_b58).map_err(map_err)?;
    sync_dm_contacts_to_ffi(&wallet_pass)?;
    Ok(contacts)
}

#[tauri::command]
pub fn dm_contacts_remove(id: String) -> Result<Vec<crate::dm_store::DmContactStored>, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    let (contacts, removed) =
        crate::dm_store::remove_contact(&wallet_pass, &id).map_err(map_err)?;
    if let Some(c) = removed {
        unregister_dm_contact(c.label);
    }
    sync_dm_contacts_to_ffi(&wallet_pass)?;
    Ok(contacts)
}

#[tauri::command]
pub fn dm_contacts_clear_unread(
    public_b58: String,
) -> Result<Vec<crate::dm_store::DmContactStored>, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    crate::dm_store::clear_unread(&wallet_pass, &public_b58).map_err(map_err)
}

#[tauri::command]
pub fn dm_contacts_bump_unread(
    public_b58: String,
) -> Result<Vec<crate::dm_store::DmContactStored>, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    crate::dm_store::bump_unread(&wallet_pass, &public_b58).map_err(map_err)
}

#[tauri::command]
pub fn dm_contacts_migrate(
    legacy: Vec<crate::dm_store::DmContactStored>,
) -> Result<Vec<crate::dm_store::DmContactStored>, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    let contacts =
        crate::dm_store::migrate_legacy_contacts(&wallet_pass, legacy).map_err(map_err)?;
    sync_dm_contacts_to_ffi(&wallet_pass)?;
    Ok(contacts)
}

#[tauri::command]
pub fn dm_encrypt(their_public_b58: String, plaintext: String) -> Result<String, String> {
    let my_secret = Zeroizing::new(load_dm_secret()?);
    let their_public = bs58_decode(&their_public_b58)?;
    chacha_encrypt_dm(my_secret.to_vec(), their_public, plaintext).map_err(ffi_err)
}

#[tauri::command]
pub fn dm_decrypt(their_public_b58: String, ciphertext_b58: String) -> Result<String, String> {
    let my_secret = Zeroizing::new(load_dm_secret()?);
    let their_public = bs58_decode(&their_public_b58)?;
    chacha_decrypt_dm(my_secret.to_vec(), their_public, ciphertext_b58).map_err(ffi_err)
}

fn bs58_decode(s: &str) -> Result<Vec<u8>, String> {
    bs58::decode(s)
        .into_vec()
        .map_err(|e| format!("invalid base58: {e}"))
}

#[tauri::command]
pub fn address_book_list() -> Result<Vec<AddressBookEntry>, String> {
    address_book::list_entries().map_err(map_err)
}

#[tauri::command]
pub fn address_book_upsert(entry: AddressBookEntry) -> Result<Vec<AddressBookEntry>, String> {
    address_book::upsert_entry(entry).map_err(map_err)
}

#[tauri::command]
pub fn address_book_remove(id: String) -> Result<Vec<AddressBookEntry>, String> {
    address_book::remove_entry(&id).map_err(map_err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletProfilesDto {
    pub active_id: String,
    pub wallets: Vec<wallets::WalletProfile>,
}

#[tauri::command]
pub fn wallets_list() -> Result<WalletProfilesDto, String> {
    let _ = wallets::bootstrap_from_prefs();
    let (active_id, wallets) = wallets::list_profiles().map_err(map_err)?;
    Ok(WalletProfilesDto { active_id, wallets })
}

#[tauri::command]
pub async fn wallets_create(
    state: State<'_, AppState>,
    label: String,
) -> Result<wallets::WalletProfile, String> {
    {
        let mut miner = state.miner.lock();
        if let Some(mut m) = miner.take() {
            let _ = m.child.kill();
            let _ = m.child.wait();
        }
    }
    tauri::async_runtime::spawn_blocking(stop_darkirc_if_active)
        .await
        .map_err(|e| format!("Chat stop interrupted: {e}"))?;
    close_wallet_and_clear_session(&state);
    let profile = wallets::create_profile(label).map_err(map_err)?;
    let mut prefs = state.prefs.lock().clone();
    prefs.active_wallet_id = profile.id.clone();
    *state.prefs.lock() = prefs;
    Ok(profile)
}

#[tauri::command]
pub async fn wallets_switch(state: State<'_, AppState>, wallet_id: String) -> Result<(), String> {
    {
        let mut miner = state.miner.lock();
        if let Some(mut m) = miner.take() {
            let _ = m.child.kill();
            let _ = m.child.wait();
        }
    }
    tauri::async_runtime::spawn_blocking(stop_darkirc_if_active)
        .await
        .map_err(|e| format!("Chat stop interrupted: {e}"))?;
    close_wallet_and_clear_session(&state);
    wallets::switch_profile(&wallet_id).map_err(map_err)?;
    let mut prefs = state.prefs.lock().clone();
    prefs.active_wallet_id = wallet_id;
    *state.prefs.lock() = prefs;
    Ok(())
}

#[tauri::command]
pub fn wallets_rename(
    wallet_id: String,
    label: String,
) -> Result<Vec<wallets::WalletProfile>, String> {
    wallets::rename_profile(&wallet_id, label).map_err(map_err)
}

#[tauri::command]
pub fn wallets_remove(wallet_id: String) -> Result<Vec<wallets::WalletProfile>, String> {
    wallets::remove_profile(&wallet_id).map_err(map_err)
}

#[tauri::command]
pub async fn chat_start(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let network = *state.network.lock();
    let prefs = state.prefs.lock().clone();
    ensure_dirs(network).map_err(map_err)?;
    let path = darkirc_path(network).to_string_lossy().to_string();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        set_network_storage_dir(cache_path(network).to_string_lossy().to_string());
        let desired = transport_kind_for_prefs(&prefs);
        if !transport_manager::session_direct() {
            let proxy_missing = match desired {
                TransportKind::Tor => !is_arti_running(),
                TransportKind::Nym => !is_nym_running(),
                TransportKind::Direct => false,
            };
            if transport_manager::effective_kind() != desired || proxy_missing {
                transport_manager::apply(desired, prefs.nym_socks_port, prefs.tor_socks_port)?;
            }
        }
        sync_dm_contacts_if_unlocked();
        let cb: Option<Box<dyn DarkircEventCallback>> = Some(Box::new(TauriChatCb { app }));
        let (transport, socks_port) = darkirc_transport_for_prefs(&prefs);
        start_darkirc(path, transport, socks_port, cb).map_err(ffi_err)
    })
    .await
    .map_err(|e| format!("Chat start interrupted: {e}"))?
}

#[tauri::command]
pub async fn chat_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| stop_darkirc().map_err(ffi_err))
        .await
        .map_err(|e| format!("Chat stop interrupted: {e}"))?
}

#[tauri::command]
pub fn chat_status() -> String {
    // Prefer fine-grained connect/DAG-sync phase for the chat UI.
    // Falls back to coarse lifecycle if the phase helper is unavailable.
    let phase = darkirc_connection_phase();
    if phase.is_empty() {
        darkirc_status()
    } else {
        phase
    }
}

#[tauri::command]
pub fn get_chat_nick(state: State<'_, AppState>) -> String {
    state.prefs.lock().chat_nick.clone()
}

/// Sanitize a nickname to only contain safe characters: `[a-zA-Z0-9_]`.
/// Matches Android/iOS sanitization for cross-platform consistency.
fn sanitize_nickname(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(24)
        .collect();
    if cleaned.is_empty() {
        return Err(
            "Nickname must contain at least one alphanumeric or underscore character".into(),
        );
    }
    Ok(cleaned)
}

#[tauri::command]
pub fn set_chat_nick(state: State<'_, AppState>, nickname: String) -> Result<(), String> {
    let sanitized = sanitize_nickname(nickname.trim())?;
    let mut prefs = state.prefs.lock();
    prefs.chat_nick = sanitized;
    save_prefs(&prefs).map_err(map_err)?;
    Ok(())
}

#[tauri::command]
pub async fn chat_send(
    state: State<'_, AppState>,
    channel: String,
    message: String,
) -> Result<(), String> {
    let nick = state.prefs.lock().chat_nick.clone();
    let body = message.trim();
    if body.starts_with('/') {
        let parts: Vec<&str> = body.splitn(2, ' ').collect();
        let cmd = parts[0].to_lowercase();
        let arg = parts.get(1).map(|s| s.trim()).unwrap_or("");
        match cmd.as_str() {
            "/nick" => {
                if !arg.is_empty() {
                    let sanitized = sanitize_nickname(arg)?;
                    let mut prefs = state.prefs.lock();
                    prefs.chat_nick = sanitized;
                    save_prefs(&prefs).map_err(map_err)?;
                    return Ok(());
                }
                return Err("Invalid nickname. Usage: /nick <name> (1–24 alphanumeric/underscore characters)".into());
            }
            "/me" => {
                if !arg.is_empty() {
                    let action_msg = format!("* {} {}", nick, arg);
                    return tauri::async_runtime::spawn_blocking(move || {
                        send_chat_message(channel, nick, action_msg).map_err(ffi_err)
                    })
                    .await
                    .map_err(|e| format!("Chat send interrupted: {e}"))?;
                }
                return Err("Usage: /me <action>".into());
            }
            "/msg" => {
                let msg_parts: Vec<&str> = arg.splitn(2, ' ').collect();
                if msg_parts.len() == 2 {
                    let target = msg_parts[0].trim();
                    let text = msg_parts[1].trim();
                    let target = target.to_string();
                    let text = text.to_string();
                    return tauri::async_runtime::spawn_blocking(move || {
                        send_chat_message(target, nick, text).map_err(ffi_err)
                    })
                    .await
                    .map_err(|e| format!("Chat send interrupted: {e}"))?;
                }
                return Err("Usage: /msg <target> <message>".into());
            }
            "/clear" | "/join" | "/part" | "/leave" | "/help" => {
                return Ok(());
            }
            _ => {
                return Err(format!(
                    "Unknown command '{}'. Type /help for DarkIRC commands.",
                    cmd
                ));
            }
        }
    }

    let body = body.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        send_chat_message(channel, nick, body).map_err(ffi_err)
    })
    .await
    .map_err(|e| format!("Chat send interrupted: {e}"))?
}

/// Read at most `max_bytes` from the end of a miner log so status polls
/// do not load an unbounded file into memory.
fn read_log_tail(path: &std::path::Path, max_bytes: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    if start > 0
        && let Some(idx) = buf.find('\n')
    {
        buf.drain(..=idx);
    }
    Some(buf)
}

fn parse_hashrate(log: &str) -> Option<f64> {
    // miner    speed 10s/60s/15m 6990.2 6976.5 6986.6 H/s
    // Some XMRig builds report in kH/s or MH/s.
    for line in log.lines().rev() {
        if line.contains("speed") && (line.contains("H/s") || line.contains("h/s")) {
            let multiplier = if line.contains("MH/s") || line.contains("Mh/s") {
                1_000_000.0
            } else if line.contains("kH/s") || line.contains("kh/s") || line.contains("KH/s") {
                1_000.0
            } else {
                1.0
            };
            for part in line.split_whitespace() {
                if let Ok(v) = part.parse::<f64>() {
                    let hs = v * multiplier;
                    // L6: reject non-finite and unreasonably large values
                    if hs.is_finite() && hs > 10.0 && hs < 1_000_000_000.0 {
                        return Some(hs);
                    }
                }
            }
        }
    }
    None
}

fn xmrig_sidecar_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "xmrig.exe"
    } else {
        "xmrig"
    }
}

fn current_target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "aarch64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "aarch64-pc-windows-msvc"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
    )))]
    {
        "unknown"
    }
}

fn xmrig_triple_filename() -> String {
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    format!("xmrig-{}{ext}", current_target_triple())
}

/// Resolve the bundled xmrig sidecar path.
///
/// Tauri 2 places `externalBin` sidecars adjacent to `std::env::current_exe()`
/// (`xmrig` on Linux/macOS, `xmrig.exe` on Windows). Checks that location first,
/// then falls back to `BaseDirectory::Resource` and the dev `binaries/` directory.
fn resolve_xmrig_candidate(
    current_exe: Option<&std::path::Path>,
    resource_path: Option<&std::path::Path>,
    dev_binaries_dir: Option<&std::path::Path>,
) -> Option<PathBuf> {
    if let Some(exe) = current_exe
        && let Some(dir) = exe.parent()
    {
        let adjacent = dir.join(xmrig_sidecar_filename());
        if adjacent.is_file() {
            return Some(adjacent);
        }
        let adjacent_triple = dir.join(xmrig_triple_filename());
        if adjacent_triple.is_file() {
            return Some(adjacent_triple);
        }
    }
    if let Some(res) = resource_path
        && res.is_file()
    {
        return Some(res.to_path_buf());
    }
    if let Some(bin_dir) = dev_binaries_dir {
        let dev_triple = bin_dir.join(xmrig_triple_filename());
        if dev_triple.is_file() {
            return Some(dev_triple);
        }
        let dev_plain = bin_dir.join(xmrig_sidecar_filename());
        if dev_plain.is_file() {
            return Some(dev_plain);
        }
    }
    None
}

fn xmrig_bin(app: &AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let current_exe = std::env::current_exe().ok();
    let res_rel = format!("binaries/{}", xmrig_sidecar_filename());
    let resource_path = app
        .path()
        .resolve(&res_rel, tauri::path::BaseDirectory::Resource)
        .ok();
    let dev_binaries =
        cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    let p = resolve_xmrig_candidate(
        current_exe.as_deref(),
        resource_path.as_deref(),
        dev_binaries.as_deref(),
    )
    .ok_or_else(|| "bundled xmrig sidecar is missing from the app bundle".to_string())?;
    verify_xmrig_hash(&p)?;
    Ok(p)
}

/// SHA-256 of the xmrig builds shipped in `src-tauri/binaries`.
fn verify_xmrig_hash(path: &std::path::Path) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    const ALLOWED: &[&str] = &[
        "f3ec92e5937bc2510e074e28fb1811215f76229fa08067adc5b2e2848fa8e845",
        "3bf7a353daa4af0f4d2aa4c5a0294fd14d3a330b0abf2e2e4dd23e14650aa527",
        "2378ed17a514a54d06b000f82ea1372d046d79d5cfbdb7ac5ac9a99c22ee2d0b",
        "6fa80698d7268f6e88aa88c06fb27ee99e1bcee747c2e76911e6206a5b1aeeb3",
        "b20f39fc00d242e706b6c30367ad811c676e0575050a4ec2f30104b696944b49",
    ];
    let bytes = std::fs::read(path).map_err(|e| format!("read xmrig: {e}"))?;
    let digest = hex::encode(Sha256::digest(bytes));
    if ALLOWED.iter().any(|known| *known == digest) {
        Ok(())
    } else {
        Err(format!(
            "xmrig at {} has hash {digest}, which is not a known Nighthawk build",
            path.display()
        ))
    }
}

fn endpoint_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    url::Url::parse(&with_scheme).map_err(|e| e.to_string())
}

fn ip_is_blocked(ip: std::net::IpAddr) -> bool {
    let ip = match ip {
        std::net::IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(std::net::IpAddr::V4)
            .unwrap_or(std::net::IpAddr::V6(v6)),
        other => other,
    };
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return true;
            }
            let o = v6.octets();
            // fc00::/7 unique-local, fe80::/10 link-local.
            (o[0] & 0xfe) == 0xfc || (o[0] == 0xfe && (o[1] & 0xc0) == 0x80)
        }
    }
}

fn url_host_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(v4)) => v4.is_loopback(),
        Some(url::Host::Ipv6(v6)) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        None => false,
    }
}

fn url_host_blocked(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(v4)) => ip_is_blocked(std::net::IpAddr::V4(v4)),
        Some(url::Host::Ipv6(v6)) => ip_is_blocked(std::net::IpAddr::V6(v6)),
        None => true,
    }
}

fn validate_host_port(raw: &str, label: &str) -> Result<(), String> {
    let parsed = endpoint_url(raw).map_err(|e| format!("invalid {label}: {e}"))?;
    if !url_host_loopback(&parsed) && url_host_blocked(&parsed) {
        return Err(format!(
            "{label} host is private, link-local, or an IPv4-mapped loopback"
        ));
    }
    Ok(())
}

fn miner_socks5_proxy(prefs: &Prefs, stratum_loopback: bool) -> Option<String> {
    if stratum_loopback || transport_manager::session_direct() {
        return None;
    }
    match transport_kind_for_prefs(prefs) {
        TransportKind::Nym => {
            let port = if prefs.nym_socks_port == 0 {
                1080
            } else {
                prefs.nym_socks_port
            };
            Some(format!("127.0.0.1:{port}"))
        }
        TransportKind::Tor => {
            let port = if prefs.tor_socks_port == 0 {
                9050
            } else {
                prefs.tor_socks_port
            };
            Some(format!("127.0.0.1:{port}"))
        }
        TransportKind::Direct => None,
    }
}

#[tauri::command]
pub async fn mine_status(state: State<'_, AppState>) -> Result<MineStatusDto, String> {
    let prefs = state.prefs.lock().clone();
    let address = if state.wallet.lock().is_some() {
        with_wallet_blocking(&state, |w| {
            Ok(w.primary_deposit_address().unwrap_or_default())
        })
        .await
        .unwrap_or_default()
    } else {
        String::new()
    };
    let mut miner = state.miner.lock();

    if let Some(m) = miner.as_mut() {
        // Reap exited child
        if let Ok(Some(_)) = m.child.try_wait() {
            *miner = None;
        }
    }

    let running = miner.is_some();
    let (threads, stratum, addr, log_path) = if let Some(m) = miner.as_ref() {
        (
            m.threads,
            m.stratum_url.clone(),
            m.address.clone(),
            Some(m.log_path.clone()),
        )
    } else {
        (prefs.mine_threads, prefs.stratum_url.clone(), address, None)
    };

    let last_log = log_path
        .as_ref()
        .and_then(|p| read_log_tail(p, 64 * 1024))
        .unwrap_or_default();
    let last_tail: String = last_log
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let hashrate_hs = parse_hashrate(&last_log);

    Ok(MineStatusDto {
        running,
        threads,
        stratum_url: stratum,
        address: addr,
        hashrate_hs,
        last_log: last_tail,
    })
}

#[tauri::command]
pub async fn mine_start(
    app: AppHandle,
    state: State<'_, AppState>,
    threads: Option<u32>,
) -> Result<(), String> {
    {
        let mut miner = state.miner.lock();
        if let Some(m) = miner.as_mut()
            && m.child.try_wait().ok().flatten().is_none()
        {
            return Err("Miner already running".into());
        }
        *miner = None;
    }

    let mut prefs = state.prefs.lock().clone();
    let threads = threads.unwrap_or(prefs.mine_threads).clamp(1, 64);
    prefs.mine_threads = threads;
    save_prefs(&prefs).map_err(map_err)?;
    *state.prefs.lock() = prefs.clone();

    let handle = wallet_arc(&state)?;
    let address = tauri::async_runtime::spawn_blocking(move || {
        handle.primary_deposit_address().map_err(ffi_err)
    })
    .await
    .map_err(|e| format!("Wallet operation interrupted: {e}"))??;

    let stratum = prefs.stratum_url.clone();
    validate_host_port(&stratum, "stratum")?;
    let stratum_loopback = endpoint_url(&stratum)
        .map(|u| url_host_loopback(&u))
        .unwrap_or(false);
    let proxy = miner_socks5_proxy(&prefs, stratum_loopback);
    if proxy.is_some() {
        let prefs_for_proxy = prefs.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let desired = transport_kind_for_prefs(&prefs_for_proxy);
            let proxy_missing = match desired {
                TransportKind::Nym => !is_nym_running(),
                TransportKind::Tor => !is_arti_running(),
                TransportKind::Direct => false,
            };
            if proxy_missing {
                apply_transport_for_prefs(None, &prefs_for_proxy)?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|e| format!("Transport start interrupted: {e}"))??;
    }

    let log_path = crate::paths::app_root().join("xmrig.log");
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).map_err(map_err)?;
    }
    let cfg_path = crate::paths::app_root().join("xmrig.json");
    let mut pool = serde_json::json!({
        "url": stratum,
        "user": address,
        "pass": "x",
        "keepalive": true,
        "tls": !stratum_loopback
    });
    if let Some(socks5) = proxy {
        pool["socks5"] = serde_json::json!(socks5);
    }
    let cfg = serde_json::json!({
        "donate-level": 0,
        "donate-over-proxy": 0,
        "cpu": {
            "enabled": true,
            "yield": false,
            "max-threads-hint": 100
        },
        "pools": [pool],
        "print-time": 15
    });
    std::fs::write(&cfg_path, serde_json::to_string_pretty(&cfg).unwrap()).map_err(map_err)?;

    let bin = xmrig_bin(&app)?;
    let mut cmd = Command::new(&bin);
    cmd.arg("-c")
        .arg(&cfg_path)
        .arg("--log-file")
        .arg(&log_path)
        .arg(format!("--threads={threads}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start xmrig ({bin:?}): {e}"))?;

    *state.miner.lock() = Some(MinerHandle {
        child,
        threads,
        stratum_url: stratum,
        address,
        log_path,
    });
    Ok(())
}

#[tauri::command]
pub fn mine_stop(state: State<'_, AppState>) -> Result<(), String> {
    let mut miner = state.miner.lock();
    if let Some(mut m) = miner.take() {
        let _ = m.child.kill();
        let _ = m.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub async fn set_network(
    app: AppHandle,
    state: State<'_, AppState>,
    network: String,
) -> Result<(), String> {
    let network: Network = network.parse()?;
    let mut prefs = state.prefs.lock().clone();
    let network_changed = prefs.network != network;
    prefs.network = network;
    prefs.stratum_url = network.default_stratum().to_string();
    prefs.lightwallet_url = network.default_lwd().to_string();
    prefs.lightwallet_tls_pin_sha256 = network.default_lwd_tls_pin().map(str::to_string);
    save_prefs(&prefs).map_err(map_err)?;
    *state.prefs.lock() = prefs.clone();
    *state.network.lock() = network;
    close_wallet_and_clear_session(&state);
    let reopen_res = if secure_store::wallet_exists() {
        open_existing_wallet(&app, state.inner()).await
    } else {
        Ok(())
    };
    if network_changed {
        let app_clone = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if darkirc_is_active() {
                let _ = stop_darkirc();
                wait_for_darkirc_idle(Duration::from_secs(5));
                sync_dm_contacts_if_unlocked();
                restart_darkirc_for_prefs(&app_clone, &prefs)?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|e| format!("Network switch interrupted: {e}"))??;
    }
    reopen_res.map_err(|e| {
        format!(
            "Network switched to {}, but failed to reopen wallet: {e}",
            network.as_str()
        )
    })?;
    Ok(())
}

#[tauri::command]
pub fn set_lwd_url(state: State<'_, AppState>, url: String) -> Result<(), String> {
    validate_lwd_url(&url)?;
    let mut prefs = state.prefs.lock().clone();
    prefs.lightwallet_url = url;
    save_prefs(&prefs).map_err(map_err)?;
    *state.prefs.lock() = prefs;
    close_wallet_and_clear_session(&state);
    Ok(())
}

fn validate_lwd_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|e| format!("invalid LWD URL: {e}"))?;
    let scheme = parsed.scheme();
    let port = parsed.port_or_known_default().unwrap_or(0);
    let loopback = url_host_loopback(&parsed);
    match scheme {
        "http" | "tcp" => {
            if !loopback {
                return Err("cleartext LWD URL only allowed for loopback".into());
            }
        }
        "https" => {}
        other => return Err(format!("unsupported LWD URL scheme: {other}")),
    }
    if !loopback && ![9067, 9068, 443].contains(&port) {
        return Err(format!(
            "LWD port {port} not allowed (use 9067, 9068, or 443)"
        ));
    }
    if !loopback && url_host_blocked(&parsed) {
        return Err("private/loopback host not allowed for remote LWD".into());
    }
    Ok(())
}

#[tauri::command]
pub fn backup_mnemonic() -> Result<Vec<String>, String> {
    secure_store::backup_mnemonic().map_err(map_err)
}

#[tauri::command]
pub async fn wipe_wallet(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut miner = state.miner.lock();
        if let Some(mut m) = miner.take() {
            let _ = m.child.kill();
            let _ = m.child.wait();
        }
    }
    tauri::async_runtime::spawn_blocking(stop_darkirc_if_active)
        .await
        .map_err(|e| format!("Chat stop interrupted: {e}"))?;
    close_wallet_and_clear_session(&state);
    let dir = crate::paths::wallet_data_root();
    let _ = std::fs::remove_dir_all(crate::paths::network_dir(Network::Testnet));
    let _ = std::fs::remove_dir_all(crate::paths::network_dir(Network::Mainnet));
    let _ = std::fs::remove_file(crate::paths::address_book_path());
    let _ = std::fs::remove_file(crate::paths::legacy_address_book_path());
    let _ = std::fs::remove_file(dir.join("vault.dat"));
    let _ = std::fs::remove_file(dir.join("vault.meta.json"));
    let _ = std::fs::remove_file(dir.join("vault.key"));
    crate::dm_store::clear();
    address_book::delete_key_for_root(&dir);
    secure_store::wipe_secrets().map_err(map_err)?;
    Ok(())
}

pub fn initial_prefs() -> Prefs {
    load_prefs_file()
}

#[cfg(test)]
mod tests {
    use super::{
        darkirc_transport_for_prefs, miner_socks5_proxy, parse_hashrate, resolve_xmrig_candidate,
        sanitize_nickname, transport_kind_for_prefs, validate_host_port, validate_lwd_url,
        xmrig_sidecar_filename, xmrig_triple_filename,
    };
    use crate::prefs::Prefs;
    use darkfi_mobile_ffi::{DarkircTransport, transport_manager::TransportKind};

    #[test]
    fn transport_selection_prefers_nym_then_tor_then_direct() {
        let mut prefs = Prefs::default();
        assert!(prefs.use_tor);
        assert!(!prefs.use_nym);
        assert_eq!(transport_kind_for_prefs(&prefs), TransportKind::Tor);
        assert_eq!(
            darkirc_transport_for_prefs(&prefs),
            (DarkircTransport::Tor, prefs.tor_socks_port)
        );

        prefs.use_nym = true;
        assert_eq!(transport_kind_for_prefs(&prefs), TransportKind::Nym);
        assert_eq!(
            darkirc_transport_for_prefs(&prefs),
            (DarkircTransport::Nym, prefs.nym_socks_port)
        );

        prefs.use_nym = false;
        prefs.use_tor = false;
        assert_eq!(transport_kind_for_prefs(&prefs), TransportKind::Direct);
        assert_eq!(
            darkirc_transport_for_prefs(&prefs),
            (DarkircTransport::Direct, 0)
        );
    }

    #[test]
    fn parse_hashrate_h_per_s() {
        let log = "miner    speed 10s/60s/15m 6990.2 6976.5 6986.6 H/s";
        assert_eq!(parse_hashrate(log), Some(6990.2));
    }

    #[test]
    fn parse_hashrate_kh_per_s() {
        let log = "miner    speed 10s/60s/15m 6.99 6.97 6.98 kH/s";
        let v = parse_hashrate(log).expect("kH/s");
        assert!((v - 6990.0).abs() < 1.0);
    }

    #[test]
    fn parse_hashrate_mh_per_s() {
        let log = "miner    speed 10s/60s/15m 0.00699 0.00697 0.00698 MH/s";
        let v = parse_hashrate(log).expect("MH/s");
        assert!((v - 6990.0).abs() < 1.0);
    }

    #[test]
    fn parse_hashrate_ignores_non_speed_lines() {
        assert_eq!(parse_hashrate("accepted 1/1 (100%)"), None);
    }

    #[test]
    fn validate_lwd_url_allows_loopback_cleartext() {
        assert!(validate_lwd_url("http://127.0.0.1:9067").is_ok());
        assert!(validate_lwd_url("http://localhost:9067").is_ok());
    }

    #[test]
    fn validate_lwd_url_rejects_ssrf_and_cleartext_remote() {
        assert!(validate_lwd_url("http://example.com:9067").is_err());
        assert!(validate_lwd_url("https://192.168.1.1:9067").is_err());
        assert!(validate_lwd_url("https://172.16.0.1:9067").is_err());
        assert!(validate_lwd_url("https://169.254.1.1:9067").is_err());
        assert!(validate_lwd_url("https://example.com:443").is_ok());
        assert!(validate_lwd_url("https://[::1]:443").is_ok());
        assert!(validate_lwd_url("http://[::1]:9067").is_ok());
        assert!(validate_lwd_url("https://[fc00::1]:443").is_err());
        assert!(validate_lwd_url("https://[::ffff:192.168.0.1]:443").is_err());
        assert!(validate_lwd_url("https://[::ffff:127.0.0.1]:443").is_ok());
    }

    #[test]
    fn sanitize_nickname_enforces_charset_and_length() {
        assert_eq!(sanitize_nickname("alice_42").unwrap(), "alice_42");
        assert_eq!(sanitize_nickname("  Bob-!@# 99  ").unwrap(), "Bob99");
        assert_eq!(
            sanitize_nickname("abcdefghijklmnopqrstuvwxyz012345").unwrap(),
            "abcdefghijklmnopqrstuvwx"
        );
        assert!(sanitize_nickname("").is_err());
        assert!(sanitize_nickname("!!!---   ").is_err());
    }

    #[test]
    fn validate_host_port_allows_loopback_and_public_and_blocks_private() {
        assert!(validate_host_port("127.0.0.1:18347", "stratum").is_ok());
        assert!(validate_host_port("localhost:18347", "stratum").is_ok());
        assert!(validate_host_port("[::1]:18347", "stratum").is_ok());
        assert!(validate_host_port("pool.example.com:18347", "stratum").is_ok());
        assert!(validate_host_port("10.0.0.5:18347", "stratum").is_err());
        assert!(validate_host_port("192.168.1.10:18347", "stratum").is_err());
        assert!(validate_host_port("169.254.169.254:80", "stratum").is_err());
        assert!(validate_host_port("[fc00::1]:18347", "stratum").is_err());
        assert!(validate_host_port("[::ffff:192.168.1.1]:18347", "stratum").is_err());
    }

    #[test]
    fn miner_socks5_proxy_routes_nym_and_tor_for_remote_stratum() {
        let mut prefs = Prefs {
            use_nym: true,
            use_tor: false,
            nym_socks_port: 1080,
            ..Default::default()
        };
        assert_eq!(
            miner_socks5_proxy(&prefs, false).as_deref(),
            Some("127.0.0.1:1080")
        );
        assert_eq!(miner_socks5_proxy(&prefs, true), None);

        prefs.use_nym = false;
        prefs.use_tor = true;
        prefs.tor_socks_port = 9150;
        assert_eq!(
            miner_socks5_proxy(&prefs, false).as_deref(),
            Some("127.0.0.1:9150")
        );
        prefs.tor_socks_port = 0;
        assert_eq!(
            miner_socks5_proxy(&prefs, false).as_deref(),
            Some("127.0.0.1:9050")
        );

        prefs.use_tor = false;
        assert_eq!(miner_socks5_proxy(&prefs, false), None);
    }

    #[test]
    fn xmrig_bin_prefers_adjacent_exe_then_resource_then_dev() {
        let root = std::env::temp_dir().join(format!("nh_xmrig_test_{}", rand::random::<u64>()));
        let exe_dir = root.join("bin");
        let res_dir = root.join("res");
        let dev_dir = root.join("dev");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&res_dir).unwrap();
        std::fs::create_dir_all(&dev_dir).unwrap();

        let fake_exe = exe_dir.join("nighthawk");
        let adjacent = exe_dir.join(xmrig_sidecar_filename());
        let resource = res_dir.join(xmrig_sidecar_filename());
        let dev_triple = dev_dir.join(xmrig_triple_filename());

        // Nothing present yet.
        assert_eq!(
            resolve_xmrig_candidate(Some(&fake_exe), Some(&resource), Some(&dev_dir)),
            None
        );

        // Dev fallback found when only dev triple exists.
        std::fs::write(&dev_triple, b"dev").unwrap();
        assert_eq!(
            resolve_xmrig_candidate(Some(&fake_exe), Some(&resource), Some(&dev_dir)),
            Some(dev_triple.clone())
        );

        // Resource takes precedence over dev fallback.
        std::fs::write(&resource, b"res").unwrap();
        assert_eq!(
            resolve_xmrig_candidate(Some(&fake_exe), Some(&resource), Some(&dev_dir)),
            Some(resource.clone())
        );

        // Adjacent to current_exe() takes highest precedence (Tauri 2 externalBin layout).
        std::fs::write(&adjacent, b"adj").unwrap();
        assert_eq!(
            resolve_xmrig_candidate(Some(&fake_exe), Some(&resource), Some(&dev_dir)),
            Some(adjacent.clone())
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
