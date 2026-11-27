use super::{
    darkirc_transport_for_prefs, file_sha256_hex, miner_socks5_proxy, parse_contact_card_input,
    parse_hashrate, resolve_xmrig_candidate, sanitize_nickname, transport_kind_for_prefs,
    validate_host_port, validate_lwd_url, validate_prefs_for_save, validate_socks_port,
    verify_sha256_allowlist, verify_xmrig_hash, xmrig_sidecar_filename, xmrig_triple_filename,
};
use crate::prefs::Prefs;
use blackhawk::{DarkircTransport, transport_manager::TransportKind};

#[test]
fn transport_selection_prefers_nym_then_tor_then_direct() {
    let mut prefs = Prefs::default();
    assert!(prefs.use_tor);
    assert!(!prefs.use_nym);
    assert_eq!(transport_kind_for_prefs(&prefs), TransportKind::Tor);
    assert_eq!(
        darkirc_transport_for_prefs(&prefs),
        (DarkircTransport::Tor, prefs.tor_socks_port)
    );

    prefs.use_nym = true;
    assert_eq!(transport_kind_for_prefs(&prefs), TransportKind::Nym);
    assert_eq!(
        darkirc_transport_for_prefs(&prefs),
        (DarkircTransport::Nym, prefs.nym_socks_port)
    );

    prefs.use_nym = false;
    prefs.use_tor = false;
    assert_eq!(transport_kind_for_prefs(&prefs), TransportKind::Direct);
    assert_eq!(
        darkirc_transport_for_prefs(&prefs),
        (DarkircTransport::Direct, 0)
    );
}

#[test]
fn parse_hashrate_h_per_s() {
    let log = "miner    speed 10s/60s/15m 6990.2 6976.5 6986.6 H/s";
    assert_eq!(parse_hashrate(log), Some(6990.2));
}

#[test]
fn parse_hashrate_kh_per_s() {
    let log = "miner    speed 10s/60s/15m 6.99 6.97 6.98 kH/s";
    let v = parse_hashrate(log).expect("kH/s");
    assert!((v - 6990.0).abs() < 1.0);
}

#[test]
fn parse_hashrate_mh_per_s() {
    let log = "miner    speed 10s/60s/15m 0.00699 0.00697 0.00698 MH/s";
    let v = parse_hashrate(log).expect("MH/s");
    assert!((v - 6990.0).abs() < 1.0);
}

#[test]
fn parse_hashrate_ignores_non_speed_lines() {
    assert_eq!(parse_hashrate("accepted 1/1 (100%)"), None);
}

#[test]
fn validate_lwd_url_allows_loopback_cleartext() {
    assert!(validate_lwd_url("http://127.0.0.1:9067").is_ok());
    assert!(validate_lwd_url("http://localhost:9067").is_ok());
}

#[test]
fn validate_lwd_url_rejects_ssrf_and_cleartext_remote() {
    assert!(validate_lwd_url("http://example.com:9067").is_err());
    assert!(validate_lwd_url("https://192.168.1.1:9067").is_err());
    assert!(validate_lwd_url("https://172.16.0.1:9067").is_err());
    assert!(validate_lwd_url("https://169.254.1.1:9067").is_err());
    assert!(validate_lwd_url("https://example.com:443").is_ok());
    assert!(validate_lwd_url("https://[::1]:443").is_ok());
    assert!(validate_lwd_url("http://[::1]:9067").is_ok());
    assert!(validate_lwd_url("https://[fc00::1]:443").is_err());
    assert!(validate_lwd_url("https://[::ffff:192.168.0.1]:443").is_err());
    assert!(validate_lwd_url("https://[::ffff:127.0.0.1]:443").is_ok());
}

#[test]
fn sanitize_nickname_enforces_charset_and_length() {
    assert_eq!(sanitize_nickname("alice_42").unwrap(), "alice_42");
    assert_eq!(sanitize_nickname("  Bob-!@# 99  ").unwrap(), "Bob99");
    assert_eq!(
        sanitize_nickname("abcdefghijklmnopqrstuvwxyz012345").unwrap(),
        "abcdefghijklmnopqrstuvwx"
    );
    assert!(sanitize_nickname("").is_err());
    assert!(sanitize_nickname("!!!---   ").is_err());
}

#[test]
fn validate_host_port_allows_loopback_and_public_and_blocks_private() {
    assert!(validate_host_port("127.0.0.1:18347", "stratum").is_ok());
    assert!(validate_host_port("localhost:18347", "stratum").is_ok());
    assert!(validate_host_port("[::1]:18347", "stratum").is_ok());
    assert!(validate_host_port("pool.example.com:18347", "stratum").is_ok());
    assert!(validate_host_port("10.0.0.5:18347", "stratum").is_err());
    assert!(validate_host_port("192.168.1.10:18347", "stratum").is_err());
    assert!(validate_host_port("169.254.169.254:80", "stratum").is_err());
    assert!(validate_host_port("[fc00::1]:18347", "stratum").is_err());
    assert!(validate_host_port("[::ffff:192.168.1.1]:18347", "stratum").is_err());
}

#[test]
fn miner_socks5_proxy_routes_nym_and_tor_for_remote_stratum() {
    let mut prefs = Prefs {
        use_nym: true,
        use_tor: false,
        nym_socks_port: 1080,
        ..Default::default()
    };
    assert_eq!(
        miner_socks5_proxy(&prefs, false).as_deref(),
        Some("127.0.0.1:1080")
    );
    assert_eq!(miner_socks5_proxy(&prefs, true), None);

    prefs.use_nym = false;
    prefs.use_tor = true;
    prefs.tor_socks_port = 9150;
    assert_eq!(
        miner_socks5_proxy(&prefs, false).as_deref(),
        Some("127.0.0.1:9150")
    );
    prefs.tor_socks_port = 0;
    assert_eq!(
        miner_socks5_proxy(&prefs, false).as_deref(),
        Some("127.0.0.1:9050")
    );

    prefs.use_tor = false;
    assert_eq!(miner_socks5_proxy(&prefs, false), None);
}

#[test]
fn xmrig_bin_prefers_adjacent_exe_then_resource_then_dev() {
    let root = std::env::temp_dir().join(format!("nh_xmrig_test_{}", rand::random::<u64>()));
    let exe_dir = root.join("bin");
    let res_dir = root.join("res");
    let dev_dir = root.join("dev");
    std::fs::create_dir_all(&exe_dir).unwrap();
    std::fs::create_dir_all(&res_dir).unwrap();
    std::fs::create_dir_all(&dev_dir).unwrap();

    let fake_exe = exe_dir.join("nighthawk");
    let adjacent = exe_dir.join(xmrig_sidecar_filename());
    let resource = res_dir.join(xmrig_sidecar_filename());
    let dev_triple = dev_dir.join(xmrig_triple_filename());

    // Nothing present yet.
    assert_eq!(
        resolve_xmrig_candidate(Some(&fake_exe), Some(&resource), Some(&dev_dir)),
        None
    );

    // Dev fallback found when only dev triple exists.
    std::fs::write(&dev_triple, b"dev").unwrap();
    assert_eq!(
        resolve_xmrig_candidate(Some(&fake_exe), Some(&resource), Some(&dev_dir)),
        Some(dev_triple.clone())
    );

    // Resource takes precedence over dev fallback.
    std::fs::write(&resource, b"res").unwrap();
    assert_eq!(
        resolve_xmrig_candidate(Some(&fake_exe), Some(&resource), Some(&dev_dir)),
        Some(resource.clone())
    );

    // Adjacent to current_exe() takes highest precedence (Tauri 2 externalBin layout).
    std::fs::write(&adjacent, b"adj").unwrap();
    assert_eq!(
        resolve_xmrig_candidate(Some(&fake_exe), Some(&resource), Some(&dev_dir)),
        Some(adjacent.clone())
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn verify_xmrig_hash_compares_temp_file_to_allowlist() {
    let root = std::env::temp_dir().join(format!("nh_xmrig_hash_{}", rand::random::<u64>()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("xmrig");
    std::fs::write(&path, b"nighthawk-xmrig-hash-fixture").unwrap();

    let digest = file_sha256_hex(&path).unwrap();
    assert!(verify_sha256_allowlist(&path, &[digest.as_str()]).is_ok());
    let rejected = verify_xmrig_hash(&path).unwrap_err();
    assert!(rejected.contains(digest.as_str()));
    assert!(rejected.contains("not a known Nighthawk build"));
    assert!(
        verify_sha256_allowlist(
            &path,
            &["f3ec92e5937bc2510e074e28fb1811215f76229fa08067adc5b2e2848fa8e845"],
        )
        .is_err()
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn validate_prefs_for_save_rejects_bad_port_and_pin_and_allows_loopback() {
    assert!(validate_socks_port(0, "Tor SOCKS port").is_err());
    assert!(validate_socks_port(70_000, "Tor SOCKS port").is_err());
    assert!(validate_socks_port(1, "Tor SOCKS port").is_ok());
    assert!(validate_socks_port(65535, "Nym SOCKS port").is_ok());

    let mut prefs = Prefs {
        lightwallet_url: "http://127.0.0.1:9067".into(),
        lightwallet_tls_pin_sha256: None,
        tor_socks_port: 0,
        ..Default::default()
    };
    let bad_port = validate_prefs_for_save(&prefs).unwrap_err();
    assert!(bad_port.contains("Tor SOCKS port"));

    prefs.tor_socks_port = 9150;
    prefs.lightwallet_tls_pin_sha256 = Some("abcd".into());
    let bad_pin = validate_prefs_for_save(&prefs).unwrap_err();
    assert!(bad_pin.contains("TLS pin"));

    prefs.lightwallet_tls_pin_sha256 = None;
    prefs.birthday_height = -1;
    assert!(validate_prefs_for_save(&prefs).is_err());

    prefs.birthday_height = 0;
    assert!(validate_prefs_for_save(&prefs).is_ok());

    prefs.disable_direct_connection = true;
    prefs.use_tor = false;
    prefs.use_nym = false;
    assert!(validate_prefs_for_save(&prefs).is_err());
    prefs.use_tor = true;
    assert!(validate_prefs_for_save(&prefs).is_ok());
}

#[test]
fn contact_card_parses_dr_flag_and_preserves_legacy_keys() {
    let (lbl, pk, dr) =
        parse_contact_card_input("", "nighthawk://contact?k=PkTest123&name=Alice&dr=1", None);
    assert_eq!(lbl, "Alice");
    assert_eq!(pk, "PkTest123");
    assert!(dr);

    let (lbl_ios, pk_ios, dr_ios) =
        parse_contact_card_input("", "nighthawk://contact?nick=Alice&dm=PkIos123&dr=1", None);
    assert_eq!(lbl_ios, "Alice");
    assert_eq!(pk_ios, "PkIos123");
    assert!(dr_ios);

    let (lbl2, pk2, dr2) = parse_contact_card_input("Bob", "PkRawLegacy", None);
    assert_eq!(lbl2, "Bob");
    assert_eq!(pk2, "PkRawLegacy");
    assert!(!dr2);
}

#[test]
fn validate_prefs_rejects_remote_darkfid_rpc() {
    let prefs = Prefs {
        darkfid_rpc_url: Some("https://evil.example:8545".into()),
        ..Default::default()
    };
    assert!(validate_prefs_for_save(&prefs).is_err());
}
