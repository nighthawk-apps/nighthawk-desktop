use crate::paths::Network;
use crate::prefs::Prefs;
use blackhawk::DarkfiWalletHandle;
use parking_lot::Mutex;
use std::process::Child;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

pub struct AppState {
    pub prefs: Mutex<Prefs>,
    pub wallet: Mutex<Option<Arc<DarkfiWalletHandle>>>,
    pub network: Mutex<Network>,
    pub miner: Mutex<Option<MinerHandle>>,
    pub lifecycle_lock: tauri::async_runtime::Mutex<()>,
    pub lifecycle_gen: AtomicU64,
}

pub struct MinerHandle {
    pub child: Child,
    pub threads: u32,
    pub stratum_url: String,
    pub address: String,
    pub log_path: std::path::PathBuf,
}

impl Drop for MinerHandle {
    fn drop(&mut self) {
        blackhawk::transport_manager::set_allow_unauth_socks_for_miner(false);
    }
}

impl AppState {
    pub fn new(prefs: Prefs) -> Self {
        let network = prefs.network;
        Self {
            prefs: Mutex::new(prefs),
            wallet: Mutex::new(None),
            network: Mutex::new(network),
            miner: Mutex::new(None),
            lifecycle_lock: tauri::async_runtime::Mutex::new(()),
            lifecycle_gen: AtomicU64::new(0),
        }
    }
}
