fn main() {
    link_macos_swift_runtime();
    const COMMANDS: &[&str] = &[
        "bootstrap",
        "build_info",
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

/// tauri-plugin-notifications links a Swift static library into us, but nothing
/// adds an rpath for the Swift runtime it pulls in. Bundled apps get one from
/// the bundler; plain `cargo run` and `cargo test` binaries do not, so they die
/// at load with `Library not loaded: @rpath/libswift_Concurrency.dylib`. Point
/// them at the OS runtime so the test suite is runnable on macOS.
fn link_macos_swift_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
