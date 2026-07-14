mod cli;
mod gateway;
mod installer;
mod tray;

use cli::{CliError, OpenClawCli};
use gateway::{GatewayAction, GatewaySnapshot};
use installer::InstallChannel;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, Url, WebviewWindow};

const CONNECTED_WATCH_INTERVAL: Duration = Duration::from_secs(15);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

struct DesktopInner {
    cli: Mutex<Option<OpenClawCli>>,
    operation: Mutex<()>,
    local_url: Url,
    tray: Mutex<Option<tray::TrayHandles>>,
    watch_generation: AtomicU64,
    quitting: AtomicBool,
}

#[derive(Clone)]
pub struct DesktopState {
    inner: Arc<DesktopInner>,
}

impl DesktopState {
    fn new(local_url: Url) -> Self {
        Self {
            inner: Arc::new(DesktopInner {
                cli: Mutex::new(None),
                operation: Mutex::new(()),
                local_url,
                tray: Mutex::new(None),
                watch_generation: AtomicU64::new(0),
                quitting: AtomicBool::new(false),
            }),
        }
    }

    fn set_tray(&self, handles: tray::TrayHandles) {
        *self.inner.tray.lock().expect("tray mutex poisoned") = Some(handles);
    }

    pub fn connect(&self, app: &AppHandle) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Gateway operation lock is unavailable.".to_string())?;
        let cli = match self.resolve_cli() {
            Ok(cli) => cli,
            Err(CliError::Missing) => {
                let snapshot = GatewaySnapshot::missing_cli();
                self.update_tray(&snapshot);
                return Ok(snapshot);
            }
            Err(error) => return Err(error.to_string()),
        };
        let ready = gateway::ensure_ready(&cli)?;
        self.navigate(app, &ready.dashboard_url)?;
        self.update_tray(&ready.snapshot);
        self.start_watchdog(app.clone());
        Ok(ready.snapshot)
    }

    pub fn install_cli(
        &self,
        app: &AppHandle,
        channel: InstallChannel,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Installer lock is unavailable.".to_string())?;
        installer::install(app, channel)?;
        let cli = OpenClawCli::discover().map_err(|error| error.to_string())?;
        *self.inner.cli.lock().expect("CLI mutex poisoned") = Some(cli.clone());
        let ready = gateway::ensure_ready(&cli)?;
        self.navigate(app, &ready.dashboard_url)?;
        self.update_tray(&ready.snapshot);
        self.start_watchdog(app.clone());
        Ok(ready.snapshot)
    }

    pub fn gateway_action(
        &self,
        app: &AppHandle,
        action: GatewayAction,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Gateway operation lock is unavailable.".to_string())?;
        if matches!(action, GatewayAction::Stop) {
            self.cancel_watchdog();
        }
        let cli = self.resolve_cli().map_err(|error| error.to_string())?;
        let snapshot = gateway::act(&cli, action)?;
        if matches!(action, GatewayAction::Stop) {
            self.show_local(app, "stopped")?;
            self.update_tray(&snapshot);
            return Ok(snapshot);
        }

        let ready = gateway::dashboard(&cli, snapshot)?;
        self.navigate(app, &ready.dashboard_url)?;
        self.update_tray(&ready.snapshot);
        self.start_watchdog(app.clone());
        Ok(ready.snapshot)
    }

    pub fn show_error(&self, app: &AppHandle, _error: &str) {
        let _ = self.show_local(app, "error");
        self.update_tray(&GatewaySnapshot::reconnecting("Gateway action failed."));
        tray::show_window(app);
    }

    pub fn quit(&self) {
        self.inner.quitting.store(true, Ordering::SeqCst);
        self.cancel_watchdog();
    }

    fn is_quitting(&self) -> bool {
        self.inner.quitting.load(Ordering::SeqCst)
    }

    fn resolve_cli(&self) -> Result<OpenClawCli, CliError> {
        if let Some(cli) = self.inner.cli.lock().expect("CLI mutex poisoned").clone() {
            return Ok(cli);
        }
        let cli = OpenClawCli::discover()?;
        *self.inner.cli.lock().expect("CLI mutex poisoned") = Some(cli.clone());
        Ok(cli)
    }

    fn update_tray(&self, snapshot: &GatewaySnapshot) {
        if let Some(tray) = self
            .inner
            .tray
            .lock()
            .expect("tray mutex poisoned")
            .as_ref()
        {
            tray.update(snapshot);
        }
    }

    fn navigate(&self, app: &AppHandle, target: &str) -> Result<(), String> {
        let url =
            Url::parse(target).map_err(|_| "Dashboard returned an invalid URL.".to_string())?;
        main_window(app)?
            .navigate(url)
            .map_err(|error| format!("Could not open dashboard: {error}"))?;
        tray::show_window(app);
        Ok(())
    }

    fn show_local(&self, app: &AppHandle, mode: &str) -> Result<(), String> {
        let mut url = self.inner.local_url.clone();
        url.query_pairs_mut().clear().append_pair("mode", mode);
        main_window(app)?
            .navigate(url)
            .map_err(|error| format!("Could not open local screen: {error}"))
    }

    fn cancel_watchdog(&self) {
        self.inner.watch_generation.fetch_add(1, Ordering::SeqCst);
    }

    fn start_watchdog(&self, app: AppHandle) {
        let generation = self.inner.watch_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let state = self.clone();
        thread::spawn(move || loop {
            thread::sleep(CONNECTED_WATCH_INTERVAL);
            if state.inner.watch_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let Ok(_operation) = state.inner.operation.try_lock() else {
                continue;
            };
            let Ok(cli) = state.resolve_cli() else {
                continue;
            };
            let snapshot = match gateway::status(&cli) {
                Ok(snapshot) => snapshot,
                Err(error) => GatewaySnapshot::reconnecting(error),
            };
            if snapshot.reachable {
                state.update_tray(&snapshot);
                continue;
            }

            let mut displayed_phase = snapshot.phase;
            let _ = state.show_local(&app, local_mode(&snapshot));
            state.update_tray(&snapshot);
            drop(_operation);
            loop {
                if state.inner.watch_generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                if let Ok(_operation) = state.inner.operation.try_lock() {
                    let snapshot = match gateway::status(&cli) {
                        Ok(snapshot) => snapshot,
                        Err(error) => GatewaySnapshot::reconnecting(error),
                    };
                    state.update_tray(&snapshot);
                    if snapshot.reachable {
                        if let Ok(ready) = gateway::dashboard(&cli, snapshot) {
                            if state.navigate(&app, &ready.dashboard_url).is_ok() {
                                state.update_tray(&ready.snapshot);
                                break;
                            }
                        }
                    } else if snapshot.phase != displayed_phase {
                        displayed_phase = snapshot.phase;
                        let _ = state.show_local(&app, local_mode(&snapshot));
                    }
                }
                thread::sleep(RECONNECT_INTERVAL);
            }
        });
    }
}

fn local_mode(snapshot: &GatewaySnapshot) -> &'static str {
    if snapshot.installed && !snapshot.running {
        "stopped"
    } else {
        "reconnecting"
    }
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable.".to_string())
}

#[tauri::command]
async fn bootstrap(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<GatewaySnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.connect(&app))
        .await
        .map_err(|error| format!("Gateway task failed: {error}"))?
}

#[tauri::command]
async fn install_cli(
    app: AppHandle,
    state: State<'_, DesktopState>,
    channel: InstallChannel,
) -> Result<GatewaySnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.install_cli(&app, channel))
        .await
        .map_err(|error| format!("Installer task failed: {error}"))?
}

#[tauri::command]
async fn gateway_action(
    app: AppHandle,
    state: State<'_, DesktopState>,
    action: GatewayAction,
) -> Result<GatewaySnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.gateway_action(&app, action))
        .await
        .map_err(|error| format!("Gateway task failed: {error}"))?
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("tauri.conf.json must define the main window");
            let state = DesktopState::new(window.url()?);
            app.manage(state.clone());
            state.set_tray(tray::build(app, state.clone())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            install_cli,
            gateway_action
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<DesktopState>();
                if !state.is_quitting() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("OpenClaw desktop app failed");
}
