mod address_book;
mod commands;
mod dm_store;
mod paths;
mod prefs;
mod secure_store;
mod state;
mod wallets;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .try_init();

    let prefs = commands::initial_prefs();
    let _ = wallets::bootstrap_from_prefs();
    let state = AppState::new(prefs);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::get_prefs,
            commands::set_prefs,
            commands::wallet_exists,
            commands::generate_mnemonic,
            commands::create_wallet,
            commands::restore_wallet,
            commands::open_wallet,
            commands::wallet_balance,
            commands::wallet_address,
            commands::wallet_addresses,
            commands::generate_address,
            commands::wallet_refresh,
            commands::wallet_sync_snapshot,
            commands::wallet_light_sync,
            commands::wallet_list_txs,
            commands::estimate_fee,
            commands::send_drk,
            commands::list_token_balances,
            commands::transaction_payment_memo,
            commands::transaction_recipient,
            commands::list_daos,
            commands::list_proposals,
            commands::get_proposal,
            commands::dao_propose_transfer,
            commands::dao_vote,
            commands::handle_reorg_recovery,
            commands::arti_start,
            commands::arti_stop,
            commands::arti_status,
            commands::dm_generate_keypair,
            commands::dm_load_keypair,
            commands::dm_encrypt,
            commands::dm_decrypt,
            commands::address_book_list,
            commands::address_book_upsert,
            commands::address_book_remove,
            commands::wallets_list,
            commands::wallets_create,
            commands::wallets_switch,
            commands::wallets_rename,
            commands::wallets_remove,
            commands::chat_start,
            commands::chat_stop,
            commands::chat_status,
            commands::chat_send,
            commands::get_chat_nick,
            commands::set_chat_nick,
            commands::mine_status,
            commands::mine_start,
            commands::mine_stop,
            commands::set_network,
            commands::set_lwd_url,
            commands::backup_mnemonic,
            commands::wipe_wallet,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Nighthawk")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill any orphaned xmrig child process on app exit.
                let state: tauri::State<AppState> = app.state();
                let miner = state.miner.lock().take();
                if let Some(mut m) = miner {
                    let _ = m.child.kill();
                    let _ = m.child.wait();
                }
            }
        });
}
