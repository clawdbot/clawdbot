use std::path::PathBuf;
use std::process::Command;

fn main() {
    stage_canvas_a2ui();
    link_macos_swift_runtime();
    // Command metadata generates capability permissions independently of the
    // target's invoke handler, so keep the Linux-only command permission known.
    const COMMANDS: &[&str] = &[
        "bootstrap",
        "build_info",
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

fn stage_canvas_a2ui() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo must set OUT_DIR"))
        .join("canvas-a2ui");
    for input in [
        "package.json",
        "pnpm-lock.yaml",
        "scripts/bundle-a2ui.mts",
        "scripts/sync-native-a2ui.mts",
        "extensions/canvas/package.json",
        "extensions/canvas/scripts/bundle-a2ui.mjs",
        "extensions/canvas/src/host/a2ui/index.html",
        "extensions/canvas/src/host/a2ui-app",
    ] {
        println!("cargo:rerun-if-changed={}", repo_root.join(input).display());
    }

    let status = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/sync-native-a2ui.mts",
            "--write",
            "--output",
        ])
        .arg(&output_dir)
        .current_dir(&repo_root)
        .status()
        .expect("Canvas A2UI staging requires Node.js; run pnpm install from the repository root");
    assert!(
        status.success(),
        "Canvas A2UI resource staging failed; run pnpm install from the repository root"
    );
    println!(
        "cargo:rustc-env=OPENCLAW_CANVAS_A2UI_INDEX_HTML={}",
        output_dir.join("index.html").display()
    );
    println!(
        "cargo:rustc-env=OPENCLAW_CANVAS_A2UI_BUNDLE_JS={}",
        output_dir.join("a2ui.bundle.js").display()
    );
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
