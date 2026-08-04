use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Testnet,
    Mainnet,
}

impl Network {
    pub fn as_str(self) -> &'static str {
        match self {
            Network::Testnet => "testnet",
            Network::Mainnet => "mainnet",
        }
    }

    pub fn default_stratum(self) -> &'static str {
        match self {
            Network::Testnet => "127.0.0.1:18347",
            Network::Mainnet => "127.0.0.1:8347",
        }
    }

    pub fn default_lwd(self) -> &'static str {
        match self {
            // Studio testnet LWD via ngrok (see ~/.local/share/darkfi/studio-lwd-endpoint.env).
            Network::Testnet => "https://epidermis-sandbox-marshland.ngrok-free.dev",
            Network::Mainnet => "http://127.0.0.1:9067",
        }
    }

    /// Leaf-cert SHA-256 pin for [`Self::default_lwd`] when it is remote HTTPS.
    pub fn default_lwd_tls_pin(self) -> Option<&'static str> {
        match self {
            Network::Testnet => {
                Some("9f8f3877f312cb48e4d8d050b5c7b70f6144f1c31812d7ec299c32793a274985")
            }
            Network::Mainnet => None,
        }
    }
}

impl std::str::FromStr for Network {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "testnet" => Ok(Network::Testnet),
            "mainnet" => Ok(Network::Mainnet),
            other => Err(format!("unknown network: {other}")),
        }
    }
}

pub fn app_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("nighthawk-app-desktop")
}

/// Active wallet profile root. `None` = legacy single-wallet layout at [`app_root`].
fn active_wallet_override() -> &'static Mutex<Option<PathBuf>> {
    static O: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    O.get_or_init(|| Mutex::new(None))
}

pub fn set_wallet_data_root(path: Option<PathBuf>) {
    *active_wallet_override().lock() = path;
}

/// Per-wallet data root (vault, network DBs, address book).
pub fn wallet_data_root() -> PathBuf {
    active_wallet_override()
        .lock()
        .clone()
        .unwrap_or_else(app_root)
}

pub fn wallet_profile_dir(wallet_id: &str) -> PathBuf {
    if wallet_id == "default" {
        app_root()
    } else {
        app_root().join("wallets").join(wallet_id)
    }
}

pub fn apply_wallet_profile(wallet_id: &str) {
    if wallet_id == "default" {
        set_wallet_data_root(None);
    } else {
        set_wallet_data_root(Some(wallet_profile_dir(wallet_id)));
    }
}

pub fn network_dir(network: Network) -> PathBuf {
    wallet_data_root().join(network.as_str())
}

pub fn wallet_db_path(network: Network) -> PathBuf {
    network_dir(network).join("wallet.db")
}

pub fn cache_path(network: Network) -> PathBuf {
    network_dir(network).join("cache")
}

pub fn darkirc_path(network: Network) -> PathBuf {
    network_dir(network).join("darkirc_db")
}

pub fn prefs_path() -> PathBuf {
    app_root().join("prefs.json")
}

pub fn wallets_registry_path() -> PathBuf {
    app_root().join("wallets.json")
}

pub fn address_book_path() -> PathBuf {
    wallet_data_root().join("address_book.json")
}

pub fn ensure_dirs(network: Network) -> std::io::Result<()> {
    std::fs::create_dir_all(wallet_data_root())?;
    std::fs::create_dir_all(network_dir(network))?;
    std::fs::create_dir_all(cache_path(network))?;
    std::fs::create_dir_all(darkirc_path(network))?;
    Ok(())
}
