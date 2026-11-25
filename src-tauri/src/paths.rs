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
            Network::Testnet => "https://epidermis-sandbox-marshland.ngrok-free.dev",
            Network::Mainnet => "http://127.0.0.1:9067",
        }
    }

    /// Leaf-cert SHA-256 pin for [`Self::default_lwd`] when it is remote HTTPS.
    pub fn default_lwd_tls_pin(self) -> Option<&'static str> {
        match self {
            Network::Testnet => {
                Some("d8163009e3bb0bac39adbbfeb227827a91a590b96ec33f72576278c492be628e")
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

#[cfg(test)]
fn app_root_override() -> &'static Mutex<Option<PathBuf>> {
    static O: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    O.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
pub(crate) fn set_app_root_override(path: Option<PathBuf>) {
    *app_root_override().lock() = path;
}

pub fn app_root() -> PathBuf {
    #[cfg(test)]
    if let Some(p) = app_root_override().lock().clone() {
        return p;
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("nighthawk-app-desktop")
}

/// Atomically write `bytes` to `path` via a sibling temporary file and rename.
/// On Unix, when `mode_0600` is true, creates the temp file with mode `0o600`
/// before writing so sensitive files are never world-readable.
pub fn write_atomic(path: &std::path::Path, bytes: &[u8], mode_0600: bool) -> std::io::Result<()> {
    use std::io::Write;
    #[cfg(not(unix))]
    let _ = mode_0600;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp_name = format!(
        ".{file_name}.tmp.{}.{:08x}",
        std::process::id(),
        rand::random::<u32>()
    );
    let tmp_path = path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(tmp_name);

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    if mode_0600 {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp_path)?;
    if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    drop(file);
    #[cfg(unix)]
    if mode_0600 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600))?;
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    Ok(())
}

/// Active wallet profile root. `None` = legacy single-wallet layout at [`app_root`].
fn active_wallet_override() -> &'static Mutex<Option<PathBuf>> {
    static O: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    O.get_or_init(|| Mutex::new(None))
}

pub fn set_wallet_data_root(path: Option<PathBuf>) {
    *active_wallet_override().lock() = path;
}

#[cfg(test)]
pub(crate) fn test_wallet_root_guard() -> parking_lot::MutexGuard<'static, ()> {
    static TEST_ROOT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    TEST_ROOT_LOCK.get_or_init(|| Mutex::new(())).lock()
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
    wallet_data_root().join("address_book.db")
}

pub fn legacy_address_book_path() -> PathBuf {
    wallet_data_root().join("address_book.json")
}

pub fn ensure_dirs(network: Network) -> std::io::Result<()> {
    std::fs::create_dir_all(wallet_data_root())?;
    std::fs::create_dir_all(network_dir(network))?;
    std::fs::create_dir_all(cache_path(network))?;
    std::fs::create_dir_all(darkirc_path(network))?;
    Ok(())
}
