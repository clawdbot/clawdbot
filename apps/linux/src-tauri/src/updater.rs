use serde::Serialize;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

pub(crate) const NOT_AVAILABLE_EVENT: &str = "updater://not-available";
pub(crate) const AVAILABLE_EVENT: &str = "updater://available";
pub(crate) const AVAILABLE_MANUAL_EVENT: &str = "updater://available-manual";
pub(crate) const PROGRESS_EVENT: &str = "updater://progress";
pub(crate) const READY_EVENT: &str = "updater://ready";
pub(crate) const ERROR_EVENT: &str = "updater://error";

const RELEASE_URL: &str = "https://github.com/openclaw/openclaw/releases/latest";
const AUTO_CHECK_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InstallKind {
    AppImage,
    SystemPackage,
}

#[derive(Default)]
pub struct UpdaterState {
    auto_check_started: AtomicBool,
    check_in_progress: Arc<AtomicBool>,
    // Set when a manual (tray/command) check is requested. The one in-flight
    // check reads this at emit time so a manual click that lands while the
    // silent startup auto-check is running still surfaces a result instead of
    // being coalesced away into silence.
    manual_pending: Arc<AtomicBool>,
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
    app.restart();
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
    let updater = match app.updater() {
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

    if install_kind() == InstallKind::SystemPackage {
        emit(
            &app,
            AVAILABLE_MANUAL_EVENT,
            ManualUpdateInfo {
                version: info.version,
                notes: info.notes,
                release_url: RELEASE_URL,
            },
        );
        return;
    }

    emit(&app, AVAILABLE_EVENT, info.clone());
    let Some(window) = main_window(&app) else {
        return;
    };
    let progress_window = window.clone();
    let mut downloaded = 0_u64;
    let result = update
        .download_and_install(
            move |chunk_size, total| {
                downloaded = downloaded.saturating_add(chunk_size as u64);
                let _ = progress_window.emit(PROGRESS_EVENT, Progress { downloaded, total });
            },
            || {},
        )
        .await;
    match result {
        Ok(()) => {
            let _ = window.emit(READY_EVENT, info);
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
    install_kind_from_appimage_env(std::env::var_os("APPIMAGE"))
}

fn install_kind_from_appimage_env(appimage: Option<OsString>) -> InstallKind {
    if appimage.is_some() {
        InstallKind::AppImage
    } else {
        // Package managers own deb/rpm installs; replacing their files would corrupt that contract.
        InstallKind::SystemPackage
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_kind_follows_appimage_env_presence() {
        assert_eq!(
            install_kind_from_appimage_env(None),
            InstallKind::SystemPackage
        );
        assert_eq!(
            install_kind_from_appimage_env(Some(OsString::from("/tmp/OpenClaw.AppImage"))),
            InstallKind::AppImage
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
}
