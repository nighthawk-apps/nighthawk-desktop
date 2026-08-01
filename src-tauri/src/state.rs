use crate::paths::Network;
use crate::prefs::Prefs;
use darkfi_mobile_ffi::DarkfiWalletHandle;
use parking_lot::Mutex;
use std::process::Child;
use std::sync::Arc;

pub struct AppState {
    pub prefs: Mutex<Prefs>,
    pub wallet: Mutex<Option<Arc<DarkfiWalletHandle>>>,
    pub network: Mutex<Network>,
    pub miner: Mutex<Option<MinerHandle>>,
}

pub struct MinerHandle {
    pub child: Child,
    pub threads: u32,
    pub stratum_url: String,
    pub address: String,
    pub log_path: std::path::PathBuf,
}

impl AppState {
    pub fn new(prefs: Prefs) -> Self {
        let network = prefs.network;
        Self {
            prefs: Mutex::new(prefs),
            wallet: Mutex::new(None),
            network: Mutex::new(network),
            miner: Mutex::new(None),
        }
    }
}
