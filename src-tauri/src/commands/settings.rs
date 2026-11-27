use super::*;

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

pub(super) fn validate_socks_port(port: u32, label: &str) -> Result<(), String> {
    if (1..=65535).contains(&port) {
        Ok(())
    } else {
        Err(format!("{label} must be between 1 and 65535"))
    }
}

pub(super) fn validate_prefs_for_save(prefs: &Prefs) -> Result<(), String> {
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
        let parsed = endpoint_url(rpc).map_err(|e| format!("invalid darkfid RPC: {e}"))?;
        if !url_host_loopback(&parsed) {
            return Err(
                "darkfid RPC URL must be a loopback address (clearnet remote RPC is disallowed)"
                    .into(),
            );
        }
    }
    // `Prefs` stores ports as `u16`, so serde already rejects values above 65535
    // and negatives. `0` is the in-range value this check still has to refuse.
    validate_socks_port(u32::from(prefs.tor_socks_port), "Tor SOCKS port")?;
    validate_socks_port(u32::from(prefs.nym_socks_port), "Nym SOCKS port")?;
    if prefs.birthday_height < 0 {
        return Err("birthday height must be zero or positive".into());
    }
    if let Some(pin) = &prefs.lightwallet_tls_pin_sha256
        && !pin.trim().is_empty()
    {
        decode_tls_pin_bytes(pin)?;
    }
    if prefs.disable_direct_connection && !prefs.use_tor && !prefs.use_nym {
        return Err(
            "Direct connections are disabled in Advanced settings; choose Tor or Nym".into(),
        );
    }
    Ok(())
}

pub(super) fn stop_miner_if_running(state: &AppState) {
    let mut miner = state.miner.lock();
    if let Some(mut m) = miner.take() {
        let _ = m.child.kill();
        let _ = m.child.wait();
    }
    transport_manager::set_allow_unauth_socks_for_miner(false);
}

#[tauri::command]
pub async fn set_prefs(
    app: AppHandle,
    state: State<'_, AppState>,
    mut prefs: Prefs,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle_lock.lock().await;
    validate_prefs_for_save(&prefs)?;
    prefs.chat_nick = sanitize_nickname(prefs.chat_nick.trim())?;
    // Hold the prefs lock across the read, disk write, and memory update.
    // Drop it before taking the wallet lock or awaiting.
    let (old, transport_changed, needs_wallet_reopen, stop_miner_needed) = {
        let mut guard = state.prefs.lock();
        if !wallets::is_valid_wallet_id(&prefs.active_wallet_id) {
            return Err("Invalid active wallet profile id".into());
        }
        if prefs.active_wallet_id != guard.active_wallet_id {
            return Err("Use the wallet profile switcher to change the active wallet".into());
        }
        let old = guard.clone();
        let transport_changed = old.use_tor != prefs.use_tor
            || old.tor_socks_port != prefs.tor_socks_port
            || old.use_nym != prefs.use_nym
            || old.nym_socks_port != prefs.nym_socks_port
            || old.disable_direct_connection != prefs.disable_direct_connection
            || old.network != prefs.network;
        let needs_wallet_reopen = old.lightwallet_url != prefs.lightwallet_url
            || old.lightwallet_tls_pin_sha256 != prefs.lightwallet_tls_pin_sha256
            || transport_changed;
        let stop_miner_needed = transport_changed || old.stratum_url != prefs.stratum_url;
        transport_manager::set_direct_disabled(prefs.disable_direct_connection);
        save_prefs(&prefs).map_err(map_err)?;
        *guard = prefs.clone();
        (
            old,
            transport_changed,
            needs_wallet_reopen,
            stop_miner_needed,
        )
    };
    *state.network.lock() = prefs.network;
    if stop_miner_needed {
        stop_miner_if_running(&state);
    }
    if needs_wallet_reopen {
        // LWD / transport / TLS pin only apply at bootstrap — close the open handle.
        close_wallet_and_clear_session(&state);
        state
            .lifecycle_gen
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    } else if let Some(handle) = state.wallet.lock().as_ref().cloned() {
        handle.set_strict_omr_only(prefs.strict_omr_only);
    }

    let mut was_darkirc_active = false;
    if transport_changed {
        let prefs_for_transport = prefs.clone();
        was_darkirc_active = tauri::async_runtime::spawn_blocking(move || {
            let active = darkirc_is_active();
            if active {
                let _ = stop_darkirc();
                wait_for_darkirc_idle(Duration::from_secs(5));
            }
            apply_transport_for_prefs(Some(&old), &prefs_for_transport)?;
            Ok::<bool, String>(active)
        })
        .await
        .map_err(|e| format!("Transport reconfigure interrupted: {e}"))??;
    }
    if needs_wallet_reopen && secure_store::wallet_exists() {
        open_existing_wallet_locked(&app, state.inner())
            .await
            .map_err(|e| format!("Preferences saved, but failed to reopen wallet: {e}"))?;
    }
    if was_darkirc_active {
        let app_clone = app.clone();
        let prefs_for_chat = prefs.clone();
        tauri::async_runtime::spawn_blocking(move || {
            sync_dm_contacts_if_unlocked();
            restart_darkirc_for_prefs(&app_clone, &prefs_for_chat)
        })
        .await
        .map_err(|e| format!("Chat restart interrupted: {e}"))??;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_network(
    app: AppHandle,
    state: State<'_, AppState>,
    network: String,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle_lock.lock().await;
    let network: Network = network.parse()?;
    stop_miner_if_running(&state);
    let old_prefs = state.prefs.lock().clone();
    let mut prefs = old_prefs.clone();
    let network_changed = prefs.network != network;
    prefs.network = network;
    prefs.stratum_url = network.default_stratum().to_string();
    prefs.lightwallet_url = network.default_lwd().to_string();
    prefs.lightwallet_tls_pin_sha256 = network.default_lwd_tls_pin().map(str::to_string);
    save_prefs(&prefs).map_err(map_err)?;
    *state.prefs.lock() = prefs.clone();
    *state.network.lock() = network;
    close_wallet_and_clear_session(&state);
    state
        .lifecycle_gen
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

    let was_darkirc_active = if network_changed {
        let prefs_for_transport = prefs.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let active = darkirc_is_active();
            if active {
                let _ = stop_darkirc();
                wait_for_darkirc_idle(Duration::from_secs(5));
            }
            apply_transport_for_prefs(Some(&old_prefs), &prefs_for_transport)?;
            Ok::<bool, String>(active)
        })
        .await
        .map_err(|e| format!("Network transport switch interrupted: {e}"))??
    } else {
        false
    };

    let reopen_res = if secure_store::wallet_exists() {
        open_existing_wallet_locked(&app, state.inner()).await
    } else {
        Ok(())
    };
    if was_darkirc_active {
        let app_clone = app.clone();
        let prefs_for_chat = prefs.clone();
        tauri::async_runtime::spawn_blocking(move || {
            sync_dm_contacts_if_unlocked();
            restart_darkirc_for_prefs(&app_clone, &prefs_for_chat)
        })
        .await
        .map_err(|e| format!("Network chat restart interrupted: {e}"))??;
    }
    reopen_res.map_err(|e| {
        format!(
            "Network switched to {}, but failed to reopen wallet: {e}",
            network.as_str()
        )
    })?;
    Ok(())
}

pub(super) fn validate_lwd_url(url: &str) -> Result<(), String> {
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
    let _lifecycle = state.lifecycle_lock.lock().await;
    stop_miner_if_running(&state);
    tauri::async_runtime::spawn_blocking(stop_darkirc_if_active)
        .await
        .map_err(|e| format!("Chat stop interrupted: {e}"))?;
    close_wallet_and_clear_session(&state);
    state
        .lifecycle_gen
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let root = crate::paths::app_root();
    let _ = std::fs::remove_file(root.join("xmrig.json"));
    let _ = std::fs::remove_file(root.join("xmrig.log"));
    let dir = crate::paths::wallet_data_root();
    let _ = std::fs::remove_file(dir.join("xmrig.json"));
    let _ = std::fs::remove_file(dir.join("xmrig.log"));
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

#[tauri::command]
pub fn open_external_url(
    state: State<'_, AppState>,
    app: AppHandle,
    url: String,
) -> Result<(), String> {
    if state.prefs.lock().disable_direct_connection || transport_manager::direct_disabled() {
        return Err(
            "Direct connections are disabled in Advanced settings; refusing to open external browser links."
                .into(),
        );
    }
    let parsed = url::Url::parse(url.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http:// and https:// URLs can be opened externally".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(map_err)
}

#[tauri::command]
pub fn clear_os_clipboard() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/pbcopy")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("wl-copy")
            .arg("--clear")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = std::process::Command::new("xclip")
            .args(["-selection", "clipboard", "/dev/null"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub fn initial_prefs() -> Prefs {
    load_prefs_file()
}
