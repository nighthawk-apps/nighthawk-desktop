use super::*;

/// Read at most `max_bytes` from the end of a miner log so status polls
/// do not load an unbounded file into memory.
pub(super) fn read_log_tail(path: &std::path::Path, max_bytes: u64) -> Option<String> {
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

pub(super) fn parse_hashrate(log: &str) -> Option<f64> {
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

pub(super) fn xmrig_sidecar_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "xmrig.exe"
    } else {
        "xmrig"
    }
}

pub(super) fn current_target_triple() -> &'static str {
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

pub(super) fn xmrig_triple_filename() -> String {
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
pub(super) fn resolve_xmrig_candidate(
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

pub(super) fn xmrig_bin(app: &AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let current_exe = std::env::current_exe().ok();
    let res_rel = format!("binaries/{}", xmrig_sidecar_filename());
    let resource_path = app
        .path()
        .resolve(&res_rel, tauri::path::BaseDirectory::Resource)
        .ok();
    let dev_binaries =
        cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    resolve_xmrig_candidate(
        current_exe.as_deref(),
        resource_path.as_deref(),
        dev_binaries.as_deref(),
    )
    .ok_or_else(|| "bundled xmrig sidecar is missing from the app bundle".to_string())
}

/// Pre-sign SHA-256 of sidecars under `src-tauri/binaries`.
///
/// Triples below are the filename that currently hashes to that digest.
/// `scripts/fetch-xmrig.sh` does not record hashes. One older digest does not
/// match any sidecar in the tree.
pub(super) const XMRIG_SHA256_ALLOWLIST: &[&str] = &[
    // aarch64-apple-darwin (xmrig-aarch64-apple-darwin)
    "f3ec92e5937bc2510e074e28fb1811215f76229fa08067adc5b2e2848fa8e845",
    // x86_64-apple-darwin (xmrig-x86_64-apple-darwin)
    "3bf7a353daa4af0f4d2aa4c5a0294fd14d3a330b0abf2e2e4dd23e14650aa527",
    // x86_64-pc-windows-msvc (xmrig-x86_64-pc-windows-msvc.exe)
    "6fa80698d7268f6e88aa88c06fb27ee99e1bcee747c2e76911e6206a5b1aeeb3",
    // x86_64-unknown-linux-gnu (xmrig-x86_64-unknown-linux-gnu)
    "b20f39fc00d242e706b6c30367ad811c676e0575050a4ec2f30104b696944b49",
    // universal-apple-darwin, pre-sign lipo of the two apple-darwin sidecars above
    "3a31f907db0a5b592495eb25b7aae5f952704c0377cb123e9eb233999d185e8b",
];

pub(super) fn file_sha256_hex(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).map_err(|e| format!("read xmrig: {e}"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(super) fn verify_sha256_allowlist(
    path: &std::path::Path,
    allowed: &[&str],
) -> Result<(), String> {
    let digest = file_sha256_hex(path)?;
    if allowed.iter().any(|known| *known == digest) {
        Ok(())
    } else {
        Err(format!(
            "xmrig at {} has hash {digest}, which is not a known Nighthawk build",
            path.display()
        ))
    }
}

pub(super) fn verify_xmrig_hash(path: &std::path::Path) -> Result<(), String> {
    verify_sha256_allowlist(path, XMRIG_SHA256_ALLOWLIST)
}

/// macOS: verify `xmrig` against the running app bundle's Apple Team ID requirement
/// (`anchor apple generic and certificate leaf[subject.OU] = "<team>"`) so arbitrary
/// third-party or ad-hoc signed binaries cannot pass. Unsigned/ad-hoc dev builds fall
/// through to `verify_xmrig_hash`.
#[cfg(target_os = "macos")]
pub(super) fn macos_codesign_verify_strict(path: &std::path::Path) -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Ok(out) = Command::new("/usr/bin/codesign")
        .args(["-dvvv"])
        .arg(&exe)
        .stdin(Stdio::null())
        .output()
    else {
        return false;
    };
    let info = String::from_utf8_lossy(&out.stderr);
    let Some(team_id) = info.lines().find_map(|l| {
        let rest = l.strip_prefix("TeamIdentifier=")?.trim();
        if rest.is_empty() || rest.eq_ignore_ascii_case("not set") {
            None
        } else {
            Some(rest.to_string())
        }
    }) else {
        return false;
    };
    if !team_id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return false;
    }
    let req = format!("anchor apple generic and certificate leaf[subject.OU] = \"{team_id}\"");
    Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict", "-R", &req])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Check `path`, then the caller must spawn that same path. Do not resolve a
/// different path between this call and `Command::spawn`.
pub(super) fn verify_xmrig_for_spawn(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if macos_codesign_verify_strict(path) {
        return Ok(());
    }
    verify_xmrig_hash(path)
}

pub(super) fn endpoint_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    url::Url::parse(&with_scheme).map_err(|e| e.to_string())
}

pub(super) fn ip_is_blocked(ip: std::net::IpAddr) -> bool {
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

pub(super) fn url_host_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(v4)) => v4.is_loopback(),
        Some(url::Host::Ipv6(v6)) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        None => false,
    }
}

pub(super) fn url_host_blocked(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(v4)) => ip_is_blocked(std::net::IpAddr::V4(v4)),
        Some(url::Host::Ipv6(v6)) => ip_is_blocked(std::net::IpAddr::V6(v6)),
        None => true,
    }
}

pub(super) fn validate_host_port(raw: &str, label: &str) -> Result<(), String> {
    let parsed = endpoint_url(raw).map_err(|e| format!("invalid {label}: {e}"))?;
    if !url_host_loopback(&parsed) && url_host_blocked(&parsed) {
        return Err(format!(
            "{label} host is private, link-local, or an IPv4-mapped loopback"
        ));
    }
    Ok(())
}

pub(super) fn miner_socks5_proxy(prefs: &Prefs, stratum_loopback: bool) -> Option<String> {
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
            transport_manager::set_allow_unauth_socks_for_miner(false);
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
    if !stratum_loopback
        && proxy.is_none()
        && (prefs.disable_direct_connection || transport_manager::direct_disabled())
    {
        return Err(
            "Direct connections are disabled; enable Tor or Nym before mining on a remote stratum pool."
                .into(),
        );
    }
    if proxy.is_some() {
        transport_manager::set_allow_unauth_socks_for_miner(true);
        let prefs_for_proxy = prefs.clone();
        if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
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
        .map_err(|e| format!("Transport start interrupted: {e}"))
        .and_then(|r| r)
        {
            transport_manager::set_allow_unauth_socks_for_miner(false);
            return Err(e);
        }
    }

    let root = crate::paths::wallet_data_root();
    let log_path = root.join("xmrig.log");
    let cfg_path = root.join("xmrig.json");
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
    let cfg_bytes = serde_json::to_vec_pretty(&cfg).map_err(|e| {
        transport_manager::set_allow_unauth_socks_for_miner(false);
        map_err(e)
    })?;
    if let Err(e) = crate::paths::write_atomic(&cfg_path, &cfg_bytes, true) {
        transport_manager::set_allow_unauth_socks_for_miner(false);
        return Err(map_err(e));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&log_path);
    }

    let bin = match xmrig_bin(&app) {
        Ok(b) => b,
        Err(e) => {
            transport_manager::set_allow_unauth_socks_for_miner(false);
            return Err(e);
        }
    };
    let mut cmd = Command::new(&bin);
    cmd.arg("-c")
        .arg(&cfg_path)
        .arg("--log-file")
        .arg(&log_path)
        .arg(format!("--threads={threads}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Verify this path, then spawn it. Do not resolve a different path here.
    if let Err(e) = verify_xmrig_for_spawn(&bin) {
        transport_manager::set_allow_unauth_socks_for_miner(false);
        return Err(e);
    }
    let child = cmd.spawn().map_err(|e| {
        transport_manager::set_allow_unauth_socks_for_miner(false);
        format!("Failed to start xmrig ({bin:?}): {e}")
    })?;

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
    transport_manager::set_allow_unauth_socks_for_miner(false);
    Ok(())
}
