fn main() {
    // Command metadata generates capability permissions independently of the
    // target's invoke handler, so keep the Linux-only command permission known.
    const COMMANDS: &[&str] = &[
        "bootstrap",
        "canvas_a2ui_action",
        "check_for_updates",
        "connect_discovered_gateway",
        "discover_gateways",
        "gateway_action",
        "install_cli",
        "open_release_page",
        "relaunch",
        "updater_ready",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("Tauri build configuration should be valid");
}
