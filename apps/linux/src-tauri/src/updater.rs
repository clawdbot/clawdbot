use serde::Serialize;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

pub(crate) const NOT_AVAILABLE_EVENT: &str = "updater://not-available";
pub(crate) const AVAILABLE_EVENT: &str = "updater://available";
pub(crate) const AVAILABLE_MANUAL_EVENT: &str = "updater://available-manual";
pub(crate) const PROGRESS_EVENT: &str = "updater://progress";
pub(crate) const READY_EVENT: &str = "updater://ready";
pub(crate) const ERROR_EVENT: &str = "updater://error";

const RELEASE_URL: &str = "https://github.com/openclaw/openclaw/releases/latest";
#[cfg(any(target_os = "macos", target_os = "windows"))]
// Test desktop builds need a channel that Linux-only releases never replace.
const DESKTOP_TEST_UPDATE_ENDPOINT: &str =
    "https://github.com/openclaw/openclaw/releases/download/desktop-test/latest-desktop-test.json";
const AUTO_CHECK_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InstallKind {
    SelfInstall,
    DeferredInstall,
    NotifyOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
// Keep every discriminator available so one host can test all platform rules.
#[allow(dead_code)]
enum Platform {
    Linux,
    Macos,
    Windows,
}

#[derive(Default)]
pub struct UpdaterState {
    auto_check_started: AtomicBool,
    check_in_progress: Arc<AtomicBool>,
    deferred_update: Mutex<Option<DeferredUpdate>>,
    // Set when a manual (tray/command) check is requested. The one in-flight
    // check reads this at emit time so a manual click that lands while the
    // silent startup auto-check is running still surfaces a result instead of
    // being coalesced away into silence.
    manual_pending: Arc<AtomicBool>,
}

struct DeferredUpdate {
    update: Update,
    bytes: Vec<u8>,
}

struct CheckGuard {
    in_progress: Arc<AtomicBool>,
    manual_pending: Arc<AtomicBool>,
}

impl Drop for CheckGuard {
    fn drop(&mut self) {
        self.manual_pending.store(false, Ordering::Release);
        self.in_progress.store(false, Ordering::Release);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManualUpdateInfo {
    version: String,
    notes: Option<String>,
    release_url: &'static str,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
struct UpdateError {
    message: String,
}

pub fn schedule_auto_check(app: AppHandle) {
    let state = app.state::<UpdaterState>();
    if state.auto_check_started.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(AUTO_CHECK_DELAY);
        // Auto-check is silent: a launch that finds no update (or hits a
        // transient network error) must not nag with a banner every time.
        tauri::async_runtime::block_on(run_check(app, false));
    });
}

pub fn spawn_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_check(app, true).await;
    });
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) {
    run_check(app, true).await;
}

#[tauri::command]
pub fn updater_ready(app: AppHandle) {
    schedule_auto_check(app);
}

#[tauri::command]
pub fn relaunch(app: AppHandle) {
    let state = app.state::<UpdaterState>();
    let deferred = state
        .deferred_update
        .lock()
        .expect("deferred updater state lock poisoned")
        .take();
    let Some(deferred) = deferred else {
        app.restart();
    };

    let result = deferred.update.install(&deferred.bytes);
    match result {
        Ok(()) => app.restart(),
        Err(error) => {
            state
                .deferred_update
                .lock()
                .expect("deferred updater state lock poisoned")
                .replace(deferred);
            emit_error(&app, error);
        }
    }
}

#[tauri::command]
pub fn open_release_page(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(RELEASE_URL, None::<&str>)
        .map_err(|error| format!("Could not open release page: {error}"))
}

// A manual (tray/command) check surfaces the "up to date" and check-error
// notices; the launch auto-check runs silent. Manual intent is recorded on the
// shared state before racing for the single-flight guard, so a manual click
// that lands while the silent auto-check is running still gets a response
// (`should_notify` reads it). Once an update is found, download
// progress/ready/errors always surface, since the user has been told an update
// is coming.
async fn run_check(app: AppHandle, manual: bool) {
    let manual_pending = Arc::clone(&app.state::<UpdaterState>().manual_pending);
    if manual {
        manual_pending.store(true, Ordering::Release);
    }
    let Some(_guard) = begin_check(&app) else {
        return;
    };
    let should_notify = || manual_pending.load(Ordering::Acquire);
    #[cfg(target_os = "linux")]
    let updater = app.updater();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let updater = app
        .updater_builder()
        .endpoints(vec![DESKTOP_TEST_UPDATE_ENDPOINT
            .parse()
            .expect("desktop test updater endpoint is valid")])
        .and_then(|builder| builder.build());
    let updater = match updater {
        Ok(updater) => updater,
        Err(error) => {
            if should_notify() {
                emit_error(&app, error);
            }
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            if should_notify() {
                emit(&app, NOT_AVAILABLE_EVENT, ());
            }
            return;
        }
        Err(error) => {
            if should_notify() {
                emit_error(&app, error);
            }
            return;
        }
    };
    let info = UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    };

    let install_kind = install_kind();
    if install_kind == InstallKind::NotifyOnly {
        let version = info.version.clone();
        emit(
            &app,
            AVAILABLE_MANUAL_EVENT,
            ManualUpdateInfo {
                version: info.version,
                notes: info.notes,
                release_url: RELEASE_URL,
            },
        );
        if main_window(&app).is_some_and(|window| matches!(window.is_focused(), Ok(false))) {
            crate::notify::notify(&app, "OpenClaw", &manual_notification_body(&version));
        }
        return;
    }

    emit(&app, AVAILABLE_EVENT, info.clone());
    let Some(window) = main_window(&app) else {
        return;
    };
    let result = match install_kind {
        InstallKind::SelfInstall => update
            .download_and_install(progress_callback(window.clone()), || {})
            .await
            .map(|()| None),
        InstallKind::DeferredInstall => update
            .download(progress_callback(window.clone()), || {})
            .await
            .map(Some),
        InstallKind::NotifyOnly => unreachable!("notify-only updates return before downloading"),
    };
    match result {
        Ok(deferred_bytes) => {
            let version = info.version.clone();
            if let Some(bytes) = deferred_bytes {
                app.state::<UpdaterState>()
                    .deferred_update
                    .lock()
                    .expect("deferred updater state lock poisoned")
                    .replace(DeferredUpdate { update, bytes });
            }
            let _ = window.emit(READY_EVENT, info);
            if matches!(window.is_focused(), Ok(false)) {
                crate::notify::notify(&app, "OpenClaw", &ready_notification_body(&version));
            }
        }
        Err(error) => emit_error(&app, error),
    }
}

fn begin_check(app: &AppHandle) -> Option<CheckGuard> {
    let state = app.state::<UpdaterState>();
    let in_progress = Arc::clone(&state.check_in_progress);
    let manual_pending = Arc::clone(&state.manual_pending);
    in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| CheckGuard {
            in_progress,
            manual_pending,
        })
}

fn install_kind() -> InstallKind {
    #[cfg(target_os = "linux")]
    let platform = Platform::Linux;
    #[cfg(target_os = "macos")]
    let platform = Platform::Macos;
    #[cfg(target_os = "windows")]
    let platform = Platform::Windows;

    install_kind_from_appimage_env(std::env::var_os("APPIMAGE"), platform)
}

fn install_kind_from_appimage_env(appimage: Option<OsString>, platform: Platform) -> InstallKind {
    match platform {
        Platform::Linux if appimage.is_some() => InstallKind::SelfInstall,
        Platform::Linux => {
            // Package managers own deb/rpm files, so replacing them would corrupt their contract.
            InstallKind::NotifyOnly
        }
        Platform::Macos => {
            // Tauri owns .app replacement and returns after installing, like the AppImage path.
            InstallKind::SelfInstall
        }
        Platform::Windows => {
            // Tauri's NSIS install exits the process, so wait for user-confirmed relaunch.
            InstallKind::DeferredInstall
        }
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn progress_callback(window: WebviewWindow) -> impl FnMut(usize, Option<u64>) {
    let mut downloaded = 0_u64;
    move |chunk_size, total| {
        downloaded = downloaded.saturating_add(chunk_size as u64);
        let _ = window.emit(PROGRESS_EVENT, Progress { downloaded, total });
    }
}

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Some(window) = main_window(app) {
        let _ = window.emit(event, payload);
    }
}

fn emit_error(app: &AppHandle, error: impl std::fmt::Display) {
    emit(
        app,
        ERROR_EVENT,
        UpdateError {
            message: error.to_string(),
        },
    );
}

fn ready_notification_body(version: &str) -> String {
    format!("Update ready — restart OpenClaw to install v{version}")
}

fn manual_notification_body(version: &str) -> String {
    format!("Update available: v{version} — download from the release page")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_kind_covers_every_platform_path() {
        assert_eq!(
            install_kind_from_appimage_env(None, Platform::Linux),
            InstallKind::NotifyOnly
        );
        assert_eq!(
            install_kind_from_appimage_env(
                Some(OsString::from("/tmp/OpenClaw.AppImage")),
                Platform::Linux,
            ),
            InstallKind::SelfInstall
        );
        assert_eq!(
            install_kind_from_appimage_env(None, Platform::Macos),
            InstallKind::SelfInstall
        );
        assert_eq!(
            install_kind_from_appimage_env(None, Platform::Windows),
            InstallKind::DeferredInstall
        );
    }

    #[test]
    fn updater_event_names_are_stable() {
        assert_eq!(NOT_AVAILABLE_EVENT, "updater://not-available");
        assert_eq!(AVAILABLE_EVENT, "updater://available");
        assert_eq!(AVAILABLE_MANUAL_EVENT, "updater://available-manual");
        assert_eq!(PROGRESS_EVENT, "updater://progress");
        assert_eq!(READY_EVENT, "updater://ready");
        assert_eq!(ERROR_EVENT, "updater://error");
    }

    #[test]
    fn notification_copy_includes_update_version() {
        assert_eq!(
            ready_notification_body("2026.7.16"),
            "Update ready — restart OpenClaw to install v2026.7.16"
        );
        assert_eq!(
            manual_notification_body("2026.7.16"),
            "Update available: v2026.7.16 — download from the release page"
        );
    }
}
