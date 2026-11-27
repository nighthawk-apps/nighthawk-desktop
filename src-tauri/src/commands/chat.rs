use super::*;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmKeypairDto {
    pub public_b58: String,
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
    clear_dm_contacts();
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

pub(super) fn parse_contact_card_input(
    label: &str,
    public_b58_or_card: &str,
    ratchet_flag: Option<bool>,
) -> (String, String, bool) {
    let raw = public_b58_or_card.trim();
    if let Ok(parsed) = url::Url::parse(raw)
        && parsed.scheme().eq_ignore_ascii_case("nighthawk")
    {
        let mut pk = None;
        let mut card_name = None;
        let mut card_dr = false;
        for (k, v) in parsed.query_pairs() {
            match k.to_ascii_lowercase().as_str() {
                "k" | "key" | "pk" | "dm" | "pubkey" => {
                    let t = v.trim();
                    if !t.is_empty() {
                        pk = Some(t.to_string());
                    }
                }
                "name" | "nick" | "label" => {
                    let t = v.trim();
                    if !t.is_empty() {
                        card_name = Some(t.to_string());
                    }
                }
                "dr" => {
                    card_dr = v == "1" || v.eq_ignore_ascii_case("true");
                }
                _ => {}
            }
        }
        if let Some(key_b58) = pk {
            let final_label = if label.trim().is_empty() {
                card_name.unwrap_or_default()
            } else {
                label.trim().to_string()
            };
            return (
                final_label,
                key_b58,
                ratchet_flag.unwrap_or(false) || card_dr,
            );
        }
    }
    (
        label.to_string(),
        raw.to_string(),
        ratchet_flag.unwrap_or(false),
    )
}

#[tauri::command]
pub fn dm_contacts_upsert(
    label: String,
    public_b58: String,
    ratchet_capable: Option<bool>,
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
    let (clean_label, clean_pk, dr) =
        parse_contact_card_input(&label, &public_b58, ratchet_capable);
    let contacts = crate::dm_store::upsert_contact(&wallet_pass, &clean_label, &clean_pk, dr)
        .map_err(map_err)?;
    if let Some(keys) = crate::dm_store::load(&wallet_pass).map_err(map_err)?
        && let Ok(my_secret) = bs58_decode(&keys.secret_b58)
        && let Some(updated) = contacts.iter().find(|c| c.public_b58 == clean_pk)
    {
        register_single_dm_contact_in_ffi(&my_secret, updated);
    }
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

pub(super) fn bs58_decode(s: &str) -> Result<Vec<u8>, String> {
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
    let _lifecycle = state.lifecycle_lock.lock().await;
    stop_miner_if_running(&state);
    tauri::async_runtime::spawn_blocking(stop_darkirc_if_active)
        .await
        .map_err(|e| format!("Chat stop interrupted: {e}"))?;
    close_wallet_and_clear_session(&state);
    state
        .lifecycle_gen
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let profile = wallets::create_profile(label).map_err(map_err)?;
    let mut prefs = state.prefs.lock().clone();
    prefs.active_wallet_id = profile.id.clone();
    *state.prefs.lock() = prefs;
    Ok(profile)
}

#[tauri::command]
pub async fn wallets_switch(state: State<'_, AppState>, wallet_id: String) -> Result<(), String> {
    let _lifecycle = state.lifecycle_lock.lock().await;
    if !wallets::is_valid_wallet_id(&wallet_id) {
        return Err("Invalid wallet profile id".into());
    }
    let (_, profiles) = wallets::list_profiles().map_err(map_err)?;
    if !profiles.iter().any(|p| p.id == wallet_id) {
        return Err("Unknown wallet profile".into());
    }
    stop_miner_if_running(&state);
    tauri::async_runtime::spawn_blocking(stop_darkirc_if_active)
        .await
        .map_err(|e| format!("Chat stop interrupted: {e}"))?;
    close_wallet_and_clear_session(&state);
    state
        .lifecycle_gen
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
        if prefs.disable_direct_connection && desired == TransportKind::Direct {
            return Err("Direct connections are disabled in Advanced settings".into());
        }
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
pub(super) fn sanitize_nickname(raw: &str) -> Result<String, String> {
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
