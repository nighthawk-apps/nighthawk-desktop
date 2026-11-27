use super::*;

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

pub(super) async fn persist_and_open(
    app: &AppHandle,
    state: &AppState,
    mnemonic: Vec<String>,
    network: Network,
    birthday_height: i64,
    lightwallet_url: Option<String>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle_lock.lock().await;
    if !validate_darkfi_mnemonic(mnemonic.clone()) {
        return Err("Invalid mnemonic".into());
    }
    // Never replace or silently bypass an existing vault from create/restore.
    if secure_store::wallet_exists() {
        return Err("Wallet vault already exists — wipe or switch profile first.".into());
    }
    let overwrite = false;
    let mut prefs = state.prefs.lock().clone();
    let network_changed = prefs.network != network;
    prefs.network = network;
    prefs.birthday_height = birthday_height;
    match lightwallet_url.as_deref().map(str::trim) {
        Some(url) if !url.is_empty() => {
            validate_lwd_url(url)?;
            if prefs.lightwallet_url != url {
                prefs.lightwallet_tls_pin_sha256 = None;
            }
            prefs.lightwallet_url = url.to_string();
        }
        _ => {
            // Reset URL + leaf TLS pin to the target network's defaults when omitted/blank
            // (prevents a new Mainnet wallet from inheriting Testnet's default LWD/pin).
            prefs.lightwallet_url = network.default_lwd().to_string();
            prefs.lightwallet_tls_pin_sha256 = network.default_lwd_tls_pin().map(str::to_string);
        }
    }
    if network_changed || prefs.stratum_url.trim().is_empty() {
        prefs.stratum_url = network.default_stratum().to_string();
    }
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
    state
        .lifecycle_gen
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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

pub(super) async fn open_existing_wallet(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let _lifecycle = state.lifecycle_lock.lock().await;
    open_existing_wallet_locked(app, state).await
}

pub(super) async fn open_existing_wallet_locked(
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let _ = wallets::bootstrap_from_prefs();
    if state.wallet.lock().is_some() {
        return Ok(());
    }
    let gen_before = state
        .lifecycle_gen
        .load(std::sync::atomic::Ordering::SeqCst);

    let (mnemonic, wallet_pass, migration_warning) =
        tauri::async_runtime::spawn_blocking(move || {
            let migration_warning = secure_store::unlock_session().map_err(map_err)?;
            let mnemonic = secure_store::load_mnemonic().map_err(map_err)?;
            let wallet_pass = secure_store::load_wallet_pass().map_err(map_err)?;
            Ok::<_, String>((mnemonic, wallet_pass, migration_warning))
        })
        .await
        .map_err(|e| format!("Open interrupted: {e}"))??;

    let prefs = state.prefs.lock().clone();
    let network = prefs.network;
    let cfg = build_bootstrap(mnemonic, network, wallet_pass, &prefs)?;
    let handle = tauri::async_runtime::spawn_blocking(move || open_handle(cfg))
        .await
        .map_err(|e| format!("Wallet open interrupted: {e}"))??;
    if state
        .lifecycle_gen
        .load(std::sync::atomic::Ordering::SeqCst)
        != gen_before
    {
        let _ = handle.close();
        return Err("Wallet state changed while opening".into());
    }
    attach_reorg_callback(app, &handle);
    *state.wallet.lock() = Some(handle);
    sync_dm_contacts_if_unlocked();
    if let Some(warning) = migration_warning {
        return Err(map_err(warning));
    }
    Ok(())
}

pub(super) fn wallet_arc(state: &AppState) -> Result<Arc<DarkfiWalletHandle>, String> {
    state
        .wallet
        .lock()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Wallet locked".to_string())
}

pub(super) async fn with_wallet_blocking<T, F>(state: &AppState, f: F) -> Result<T, String>
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
pub async fn wallet_balance(state: State<'_, AppState>) -> Result<String, String> {
    with_wallet_blocking(&state, |w| {
        w.confirmed_balance_atomic()
            .map(|atomic| atomic.to_string())
            .map_err(ffi_err)
    })
    .await
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
pub(super) fn spend_ready(status: &str, scanned: i64, tip: i64, proto_mismatch: bool) -> bool {
    if proto_mismatch || tip <= 0 || scanned < tip {
        return false;
    }
    status.eq_ignore_ascii_case("Synced") || status.eq_ignore_ascii_case("Degraded")
}

pub(super) fn reject_until_spend_ready(w: &DarkfiWalletHandle) -> Result<(), String> {
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
    // schedule constant (5_420_000 atomic), not a darkfid gas measurement.
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
    /// Decimal string so atomic units survive JSON numbers past 2^53.
    pub balance_atomic: String,
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
                balance_atomic: t.balance_atomic.to_string(),
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
