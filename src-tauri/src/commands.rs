use crate::address_book::{self, AddressBookEntry};
use crate::paths::{cache_path, darkirc_path, ensure_dirs, wallet_db_path, Network};
use crate::prefs::{load_prefs as load_prefs_file, save_prefs, Prefs};
use crate::secure_store;
use crate::state::{AppState, MinerHandle};
use crate::wallets;
use darkfi_mobile_ffi::{
    chacha_decrypt_dm, chacha_encrypt_dm, darkirc_connection_phase, darkirc_status,
    generate_darkfi_mnemonic,
    generate_dm_keypair, is_arti_running, send_chat_message, start_arti_proxy, start_darkirc,
    stop_arti_proxy, stop_darkirc, validate_darkfi_mnemonic, DarkfiWalletHandle,
    DarkfiWalletNativeError, DarkircEventCallback, DrkBootstrapConfig, ReorgEvent,
    ReorgEventCallback,
};
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

fn map_err(e: impl ToString) -> String {
    e.to_string()
}

fn ffi_err(e: DarkfiWalletNativeError) -> String {
    e.to_string()
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
    ) {
        let _ = self.app.emit(
            "chat://message",
            ChatMessageDto {
                event_id,
                channel,
                nick,
                message,
                timestamp,
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

fn fee_tier_multiplier(tier: &str) -> f64 {
    match tier.to_ascii_lowercase().as_str() {
        "economy" => 0.85,
        "priority" => 1.25,
        _ => 1.0,
    }
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
            if bytes.len() != 32 {
                return Err(format!(
                    "TLS pin must be 32 bytes (64 hex chars), got {}",
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
        darkfid_rpc_url: prefs.darkfid_rpc_url.clone(),
    })
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
pub fn set_prefs(state: State<'_, AppState>, prefs: Prefs) -> Result<(), String> {
    save_prefs(&prefs).map_err(map_err)?;
    *state.network.lock() = prefs.network;
    *state.prefs.lock() = prefs;
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

fn persist_and_open(
    app: &AppHandle,
    state: &AppState,
    mnemonic: Vec<String>,
    network: Network,
    pin: String,
    birthday_height: i64,
    lightwallet_url: Option<String>,
) -> Result<(), String> {
    if !validate_darkfi_mnemonic(mnemonic.clone()) {
        return Err("Invalid mnemonic".into());
    }
    let mut prefs = state.prefs.lock().clone();
    prefs.network = network;
    prefs.birthday_height = birthday_height;
    if let Some(url) = lightwallet_url {
        prefs.lightwallet_url = url;
    }
    prefs.stratum_url = network.default_stratum().to_string();
    let wallet_pass = secure_store::generate_wallet_pass();
    secure_store::create_vault(&mnemonic, &wallet_pass, &pin).map_err(map_err)?;
    save_prefs(&prefs).map_err(map_err)?;
    *state.prefs.lock() = prefs.clone();
    *state.network.lock() = network;
    let _ = wallets::bootstrap_from_prefs();

    let cfg = build_bootstrap(mnemonic, network, wallet_pass, &prefs)?;
    let handle = open_handle(cfg)?;
    attach_reorg_callback(app, &handle);
    *state.wallet.lock() = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn create_wallet(
    app: AppHandle,
    state: State<'_, AppState>,
    mnemonic: Vec<String>,
    network: String,
    pin: String,
    birthday_height: i64,
    lightwallet_url: Option<String>,
) -> Result<(), String> {
    let network: Network = network.parse()?;
    persist_and_open(
        &app,
        &state,
        mnemonic,
        network,
        pin,
        birthday_height,
        lightwallet_url,
    )
}

#[tauri::command]
pub fn restore_wallet(
    app: AppHandle,
    state: State<'_, AppState>,
    mnemonic: Vec<String>,
    network: String,
    pin: String,
    birthday_height: i64,
    lightwallet_url: Option<String>,
) -> Result<(), String> {
    let network: Network = network.parse()?;
    persist_and_open(
        &app,
        &state,
        mnemonic,
        network,
        pin,
        birthday_height,
        lightwallet_url,
    )
}

#[tauri::command]
pub fn unlock_wallet(
    app: AppHandle,
    state: State<'_, AppState>,
    pin: String,
) -> Result<(), String> {
    let _ = wallets::bootstrap_from_prefs();
    if !secure_store::verify_pin(&pin).map_err(map_err)? {
        return Err("Invalid PIN".into());
    }
    secure_store::unlock_session(&pin).map_err(map_err)?;
    let mnemonic = secure_store::load_mnemonic().map_err(map_err)?;
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    let prefs = state.prefs.lock().clone();
    let network = prefs.network;
    let cfg = build_bootstrap(mnemonic, network, wallet_pass, &prefs)?;
    let handle = open_handle(cfg)?;
    attach_reorg_callback(&app, &handle);
    *state.wallet.lock() = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn lock_wallet(state: State<'_, AppState>) {
    *state.wallet.lock() = None;
    secure_store::clear_session();
}

fn with_wallet<T>(
    state: &AppState,
    f: impl FnOnce(&DarkfiWalletHandle) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state.wallet.lock();
    let w = guard.as_ref().ok_or_else(|| "Wallet locked".to_string())?;
    f(w)
}

#[tauri::command]
pub fn wallet_balance(state: State<'_, AppState>) -> Result<i64, String> {
    with_wallet(&state, |w| w.confirmed_balance_atomic().map_err(ffi_err))
}

#[tauri::command]
pub fn wallet_address(state: State<'_, AppState>) -> Result<String, String> {
    with_wallet(&state, |w| w.primary_deposit_address().map_err(ffi_err))
}

#[tauri::command]
pub fn wallet_addresses(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    with_wallet(&state, |w| w.list_addresses().map_err(ffi_err))
}

#[tauri::command]
pub fn generate_address(state: State<'_, AppState>) -> Result<String, String> {
    with_wallet(&state, |w| w.generate_new_address().map_err(ffi_err))
}

#[tauri::command]
pub fn wallet_refresh(state: State<'_, AppState>) -> Result<SyncSnapshotDto, String> {
    with_wallet(&state, |w| {
        let s = w.refresh_now().map_err(ffi_err)?;
        Ok(SyncSnapshotDto {
            scanned_blocks: s.scanned_blocks,
            chain_tip: s.chain_tip,
        })
    })
}

#[tauri::command]
pub fn wallet_sync_snapshot(state: State<'_, AppState>) -> Result<SyncSnapshotDto, String> {
    with_wallet(&state, |w| {
        let s = w.sync_snapshot().map_err(ffi_err)?;
        Ok(SyncSnapshotDto {
            scanned_blocks: s.scanned_blocks,
            chain_tip: s.chain_tip,
        })
    })
}

#[tauri::command]
pub fn wallet_light_sync(state: State<'_, AppState>) -> Result<LightSyncDto, String> {
    with_wallet(&state, |w| {
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
        })
    })
}

#[tauri::command]
pub fn wallet_list_txs(state: State<'_, AppState>) -> Result<Vec<TxDto>, String> {
    with_wallet(&state, |w| {
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
}

#[tauri::command]
pub fn estimate_fee(
    state: State<'_, AppState>,
    recipient: String,
    amount: String,
    memo: Option<String>,
    token_id: Option<String>,
) -> Result<i64, String> {
    let tier = state.prefs.lock().fee_tier.clone();
    let base = with_wallet(&state, |w| {
        w.estimate_transfer_fee(recipient, amount, token_id, memo)
            .map_err(ffi_err)
    })?;
    let scaled = (base as f64 * fee_tier_multiplier(&tier)).round() as i64;
    Ok(scaled.max(0))
}

#[tauri::command]
pub fn send_drk(
    state: State<'_, AppState>,
    recipient: String,
    amount: String,
    memo: Option<String>,
    token_id: Option<String>,
) -> Result<String, String> {
    with_wallet(&state, |w| {
        let bytes = w
            .build_transfer(recipient.clone(), amount, token_id, memo.clone())
            .map_err(ffi_err)?;
        w.broadcast_transfer(bytes, memo, Some(recipient))
            .map_err(ffi_err)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBalanceDto {
    pub token_id: String,
    pub display_label: Option<String>,
    pub balance_atomic: i64,
}

#[tauri::command]
pub fn list_token_balances(state: State<'_, AppState>) -> Result<Vec<TokenBalanceDto>, String> {
    with_wallet(&state, |w| {
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
}

#[tauri::command]
pub fn transaction_payment_memo(
    state: State<'_, AppState>,
    tx_hash: String,
) -> Result<Option<String>, String> {
    with_wallet(&state, |w| w.transaction_payment_memo(tx_hash).map_err(ffi_err))
}

#[tauri::command]
pub fn transaction_recipient(
    state: State<'_, AppState>,
    tx_hash: String,
) -> Result<Option<String>, String> {
    with_wallet(&state, |w| w.transaction_recipient(tx_hash).map_err(ffi_err))
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
pub fn list_daos(state: State<'_, AppState>) -> Result<Vec<DaoSummaryDto>, String> {
    with_wallet(&state, |w| {
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
}

#[tauri::command]
pub fn list_proposals(
    state: State<'_, AppState>,
    dao_name: Option<String>,
) -> Result<Vec<DaoProposalSummaryDto>, String> {
    with_wallet(&state, |w| {
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
}

#[tauri::command]
pub fn get_proposal(
    state: State<'_, AppState>,
    proposal_bulla_b58: String,
) -> Result<DaoProposalDetailDto, String> {
    with_wallet(&state, |w| {
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
}

#[tauri::command]
pub fn dao_propose_transfer(
    state: State<'_, AppState>,
    dao_name: String,
    duration_blockwindows: u64,
    amount: String,
    token_id: Option<String>,
    recipient_address: String,
) -> Result<String, String> {
    with_wallet(&state, |w| {
        w.dao_propose_transfer(dao_name, duration_blockwindows, amount, token_id, recipient_address)
            .map_err(ffi_err)
    })
}

#[tauri::command]
pub fn dao_vote(
    state: State<'_, AppState>,
    proposal_bulla_b58: String,
    vote_yes: bool,
) -> Result<String, String> {
    with_wallet(&state, |w| {
        w.dao_vote(proposal_bulla_b58, vote_yes).map_err(ffi_err)
    })
}

#[tauri::command]
pub fn handle_reorg_recovery(
    state: State<'_, AppState>,
    rewind_to_height: u32,
) -> Result<ReorgDto, String> {
    with_wallet(&state, |w| {
        let e = w.handle_reorg_recovery(rewind_to_height).map_err(ffi_err)?;
        Ok(ReorgDto {
            detected_at_height: e.detected_at_height,
            rewound_to: e.rewound_to,
            blocks_invalidated: e.blocks_invalidated,
            txs_affected: e.txs_affected,
            summary_message: e.summary_message,
        })
    })
}

#[tauri::command]
pub fn arti_start(state: State<'_, AppState>) -> Result<bool, String> {
    let port = state.prefs.lock().tor_socks_port;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmKeypairDto {
    pub secret_b58: String,
    pub public_b58: String,
}

#[tauri::command]
pub fn dm_generate_keypair() -> Result<DmKeypairDto, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    let k = generate_dm_keypair();
    let stored = crate::dm_store::DmKeypairStored {
        secret_b58: k.secret_b58.clone(),
        public_b58: k.public_b58.clone(),
    };
    crate::dm_store::save(&wallet_pass, &stored).map_err(map_err)?;
    Ok(DmKeypairDto {
        secret_b58: k.secret_b58,
        public_b58: k.public_b58,
    })
}

#[tauri::command]
pub fn dm_load_keypair() -> Result<Option<DmKeypairDto>, String> {
    let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
    let keys = crate::dm_store::load(&wallet_pass).map_err(map_err)?;
    Ok(keys.map(|k| DmKeypairDto {
        secret_b58: k.secret_b58,
        public_b58: k.public_b58,
    }))
}

#[tauri::command]
pub fn dm_encrypt(
    my_secret_b58: String,
    their_public_b58: String,
    plaintext: String,
) -> Result<String, String> {
    let my_secret = bs58_decode(&my_secret_b58)?;
    let their_public = bs58_decode(&their_public_b58)?;
    chacha_encrypt_dm(my_secret, their_public, plaintext).map_err(ffi_err)
}

#[tauri::command]
pub fn dm_decrypt(
    my_secret_b58: String,
    their_public_b58: String,
    ciphertext_b58: String,
) -> Result<String, String> {
    let my_secret = bs58_decode(&my_secret_b58)?;
    let their_public = bs58_decode(&their_public_b58)?;
    chacha_decrypt_dm(my_secret, their_public, ciphertext_b58).map_err(ffi_err)
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
pub fn wallets_create(label: String) -> Result<wallets::WalletProfile, String> {
    wallets::create_profile(label).map_err(map_err)
}

#[tauri::command]
pub fn wallets_switch(
    state: State<'_, AppState>,
    wallet_id: String,
) -> Result<(), String> {
    {
        let mut miner = state.miner.lock();
        if let Some(mut m) = miner.take() {
            let _ = m.child.kill();
            let _ = m.child.wait();
        }
    }
    *state.wallet.lock() = None;
    secure_store::clear_session();
    wallets::switch_profile(&wallet_id).map_err(map_err)?;
    let mut prefs = state.prefs.lock().clone();
    prefs.active_wallet_id = wallet_id;
    *state.prefs.lock() = prefs;
    Ok(())
}

#[tauri::command]
pub fn wallets_rename(wallet_id: String, label: String) -> Result<Vec<wallets::WalletProfile>, String> {
    wallets::rename_profile(&wallet_id, label).map_err(map_err)
}

#[tauri::command]
pub fn wallets_remove(wallet_id: String) -> Result<Vec<wallets::WalletProfile>, String> {
    wallets::remove_profile(&wallet_id).map_err(map_err)
}

#[tauri::command]
pub fn chat_start(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let network = *state.network.lock();
    let prefs = state.prefs.lock().clone();
    ensure_dirs(network).map_err(map_err)?;
    let path = darkirc_path(network).to_string_lossy().to_string();
    let cb: Option<Box<dyn DarkircEventCallback>> =
        Some(Box::new(TauriChatCb { app: app.clone() }));
    start_darkirc(path, prefs.use_tor, prefs.tor_socks_port, cb).map_err(ffi_err)
}

#[tauri::command]
pub fn chat_stop() -> Result<(), String> {
    stop_darkirc().map_err(ffi_err)
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
        return Err("Nickname must contain at least one alphanumeric or underscore character".into());
    }
    Ok(cleaned)
}

#[tauri::command]
pub fn set_chat_nick(
    state: State<'_, AppState>,
    nickname: String,
) -> Result<(), String> {
    let sanitized = sanitize_nickname(nickname.trim())?;
    let mut prefs = state.prefs.lock();
    prefs.chat_nick = sanitized;
    save_prefs(&prefs).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn chat_send(
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
                    save_prefs(&prefs).map_err(|e| e.to_string())?;
                    return Ok(());
                }
                return Err("Invalid nickname. Usage: /nick <name> (1–24 alphanumeric/underscore characters)".into());
            }
            "/me" => {
                if !arg.is_empty() {
                    let action_msg = format!("* {} {}", nick, arg);
                    send_chat_message(channel, nick, action_msg).map_err(ffi_err)?;
                    return Ok(());
                }
                return Err("Usage: /me <action>".into());
            }
            "/msg" => {
                let msg_parts: Vec<&str> = arg.splitn(2, ' ').collect();
                if msg_parts.len() == 2 {
                    let target = msg_parts[0].trim();
                    let text = msg_parts[1].trim();
                    send_chat_message(target.to_string(), nick, text.to_string()).map_err(ffi_err)?;
                    return Ok(());
                }
                return Err("Usage: /msg <target> <message>".into());
            }
            "/clear" | "/join" | "/part" | "/leave" | "/help" => {
                return Ok(());
            }
            _ => {
                return Err(format!("Unknown command '{}'. Type /help for DarkIRC commands.", cmd));
            }
        }
    }

    send_chat_message(channel, nick, body.to_string()).map_err(ffi_err)
}

fn parse_hashrate(log: &str) -> Option<f64> {
    // miner    speed 10s/60s/15m 6990.2 6976.5 6986.6 H/s
    for line in log.lines().rev() {
        if line.contains("speed") && line.contains("H/s") {
            for part in line.split_whitespace() {
                if let Ok(v) = part.parse::<f64>() {
                    // L6: reject non-finite and unreasonably large values
                    if v.is_finite() && v > 10.0 && v < 1_000_000_000.0 {
                        return Some(v);
                    }
                }
            }
        }
    }
    None
}

fn xmrig_bin(app: &AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    // Prefer packaged sidecar / resource; fall back to Homebrew / PATH.
    if let Ok(p) = app
        .path()
        .resolve("binaries/xmrig", tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Ok(p);
        }
    }
    for c in [
        PathBuf::from("/opt/homebrew/bin/xmrig"),
        PathBuf::from("/usr/local/bin/xmrig"),
    ] {
        if c.exists() {
            return Ok(c);
        }
    }
    Err("xmrig binary not found (bundle sidecar or install via Homebrew)".into())
}

#[tauri::command]
pub fn mine_status(state: State<'_, AppState>) -> Result<MineStatusDto, String> {
    let prefs = state.prefs.lock().clone();
    let mut miner = state.miner.lock();
    let address = state
        .wallet
        .lock()
        .as_ref()
        .and_then(|w| w.primary_deposit_address().ok())
        .unwrap_or_default();

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
        .and_then(|p| std::fs::read_to_string(p).ok())
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
pub fn mine_start(
    app: AppHandle,
    state: State<'_, AppState>,
    threads: Option<u32>,
) -> Result<(), String> {
    {
        let mut miner = state.miner.lock();
        if let Some(m) = miner.as_mut() {
            if m.child.try_wait().ok().flatten().is_none() {
                return Err("Miner already running".into());
            }
        }
        *miner = None;
    }

    let mut prefs = state.prefs.lock().clone();
    let threads = threads.unwrap_or(prefs.mine_threads).clamp(1, 64);
    prefs.mine_threads = threads;
    save_prefs(&prefs).map_err(map_err)?;
    *state.prefs.lock() = prefs.clone();

    let address = state
        .wallet
        .lock()
        .as_ref()
        .ok_or_else(|| "Unlock wallet before mining".to_string())?
        .primary_deposit_address()
        .map_err(ffi_err)?;

    let stratum = prefs.stratum_url.clone();
    let log_path = crate::paths::app_root().join("xmrig.log");
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).map_err(map_err)?;
    }
    let cfg_path = crate::paths::app_root().join("xmrig.json");
    let cfg = serde_json::json!({
        "donate-level": 0,
        "donate-over-proxy": 0,
        "cpu": {
            "enabled": true,
            "yield": false,
            "max-threads-hint": 100
        },
        "pools": [{
            "url": stratum,
            "user": address,
            "pass": "x",
            "keepalive": true,
            "tls": false
        }],
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
pub fn set_network(state: State<'_, AppState>, network: String) -> Result<(), String> {
    let network: Network = network.parse()?;
    let mut prefs = state.prefs.lock().clone();
    prefs.network = network;
    prefs.stratum_url = network.default_stratum().to_string();
    save_prefs(&prefs).map_err(map_err)?;
    *state.prefs.lock() = prefs;
    *state.network.lock() = network;
    *state.wallet.lock() = None;
    secure_store::clear_session();
    Ok(())
}

#[tauri::command]
pub fn set_lwd_url(state: State<'_, AppState>, url: String) -> Result<(), String> {
    let mut prefs = state.prefs.lock().clone();
    prefs.lightwallet_url = url;
    save_prefs(&prefs).map_err(map_err)?;
    *state.prefs.lock() = prefs;
    Ok(())
}

#[tauri::command]
pub fn backup_mnemonic(pin: String) -> Result<Vec<String>, String> {
    secure_store::backup_mnemonic(&pin).map_err(map_err)
}

#[tauri::command]
pub fn wipe_wallet(state: State<'_, AppState>, pin: String) -> Result<(), String> {
    if !secure_store::verify_pin(&pin).map_err(map_err)? {
        return Err("Invalid PIN".into());
    }
    {
        let mut miner = state.miner.lock();
        if let Some(mut m) = miner.take() {
            let _ = m.child.kill();
            let _ = m.child.wait();
        }
    }
    *state.wallet.lock() = None;
    secure_store::clear_session();
    let network = *state.network.lock();
    let dir = crate::paths::wallet_data_root();
    let _ = std::fs::remove_dir_all(crate::paths::network_dir(network));
    // Wipe vault for active profile only
    let _ = std::fs::remove_file(dir.join("vault.dat"));
    let _ = std::fs::remove_file(dir.join("vault.meta.json"));
    crate::dm_store::clear();
    secure_store::wipe_secrets().map_err(map_err)?;
    Ok(())
}

#[tauri::command]
pub fn verify_pin(pin: String) -> Result<bool, String> {
    secure_store::verify_pin(&pin).map_err(map_err)
}

#[tauri::command]
pub fn set_pin(old_pin: String, new_pin: String) -> Result<(), String> {
    secure_store::set_pin(&old_pin, &new_pin).map_err(map_err)
}

pub fn initial_prefs() -> Prefs {
    load_prefs_file()
}
