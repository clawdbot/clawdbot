#[cfg(target_os = "linux")]
mod canvas;
mod cli;
mod discovery;
mod gateway;
mod installer;
mod tray;

use cli::{CliError, OpenClawCli};
use gateway::{GatewayAction, GatewaySnapshot};
use installer::InstallChannel;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, Url, WebviewWindow};

const CONNECTED_WATCH_INTERVAL: Duration = Duration::from_secs(15);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Default)]
struct NavigationState {
    // One lock owns both fields so the intent check and WebView navigation cannot interleave.
    remote_dashboard: bool,
    watch_generation: u64,
}

impl NavigationState {
    fn cancel_watchdog(&mut self) {
        self.watch_generation = self.watch_generation.wrapping_add(1);
    }

    fn select_remote(&mut self) {
        self.cancel_watchdog();
        self.remote_dashboard = true;
    }

    fn permit_local(&mut self, force: bool, expected_generation: Option<u64>) -> bool {
        if expected_generation.is_some_and(|expected| expected != self.watch_generation) {
            return false;
        }
        if self.remote_dashboard && !force {
            return false;
        }
        if force {
            self.cancel_watchdog();
            self.remote_dashboard = false;
        }
        true
    }

    fn begin_watchdog(&mut self) -> Option<u64> {
        if self.remote_dashboard {
            return None;
        }
        self.cancel_watchdog();
        Some(self.watch_generation)
    }

    fn watchdog_is_current(&self, generation: u64) -> bool {
        !self.remote_dashboard && self.watch_generation == generation
    }
}

struct DesktopInner {
    cli: Mutex<Option<OpenClawCli>>,
    navigation: Mutex<NavigationState>,
    operation: Mutex<()>,
    local_url: Url,
    tray: Mutex<Option<tray::TrayHandles>>,
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
                navigation: Mutex::new(NavigationState::default()),
                operation: Mutex::new(()),
                local_url,
                tray: Mutex::new(None),
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
        let navigated = self.navigate_local(app, &ready.dashboard_url, false, None, true)?;
        self.update_tray(&ready.snapshot);
        if navigated {
            self.start_watchdog(app.clone());
        }
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
        let navigated = self.navigate_local(app, &ready.dashboard_url, false, None, true)?;
        self.update_tray(&ready.snapshot);
        if navigated {
            self.start_watchdog(app.clone());
        }
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
            self.show_local(app, "stopped", false, None)?;
            self.update_tray(&snapshot);
            return Ok(snapshot);
        }

        let ready = gateway::dashboard(&cli, snapshot)?;
        let navigated = self.navigate_local(app, &ready.dashboard_url, false, None, true)?;
        self.update_tray(&ready.snapshot);
        if navigated {
            self.start_watchdog(app.clone());
        }
        Ok(ready.snapshot)
    }

    pub fn connect_explicit_local(&self, app: &AppHandle) -> Result<GatewaySnapshot, String> {
        // The click returns immediately; a later remote selection still wins while connect runs.
        self.show_local(app, "reconnecting", true, None)?;
        self.connect(app)
    }

    pub fn show_error(&self, app: &AppHandle, _error: &str) {
        let _ = self.show_local(app, "error", false, None);
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

    // Caller holds the navigation lock, keeping the final arbitration check and navigation atomic.
    fn navigate_locked(
        &self,
        app: &AppHandle,
        target: &str,
        reveal_window: bool,
    ) -> Result<(), String> {
        let url =
            Url::parse(target).map_err(|_| "Dashboard returned an invalid URL.".to_string())?;
        main_window(app)?
            .navigate(url)
            .map_err(|error| format!("Could not open dashboard: {error}"))?;
        if reveal_window {
            tray::show_window(app);
        }
        Ok(())
    }

    fn navigate_local(
        &self,
        app: &AppHandle,
        target: &str,
        force: bool,
        expected_generation: Option<u64>,
        reveal_window: bool,
    ) -> Result<bool, String> {
        let mut navigation = self
            .inner
            .navigation
            .lock()
            .map_err(|_| "Dashboard navigation lock is unavailable.".to_string())?;
        if !navigation.permit_local(force, expected_generation) {
            return Ok(false);
        }
        self.navigate_locked(app, target, reveal_window)?;
        Ok(true)
    }

    pub fn navigate_remote(&self, app: &AppHandle, target: Url) -> Result<(), String> {
        let mut navigation = self
            .inner
            .navigation
            .lock()
            .map_err(|_| "Dashboard navigation lock is unavailable.".to_string())?;
        let window = main_window(app)?;
        navigation.select_remote();
        if let Err(error) = window.navigate(target) {
            navigation.remote_dashboard = false;
            return Err(format!("Could not open discovered gateway: {error}"));
        }
        tray::show_window(app);
        Ok(())
    }

    fn show_local(
        &self,
        app: &AppHandle,
        mode: &str,
        force: bool,
        expected_generation: Option<u64>,
    ) -> Result<bool, String> {
        let mut url = self.inner.local_url.clone();
        url.query_pairs_mut().clear().append_pair("mode", mode);
        // Status/watchdog updates may change the hidden WebView, but must not reveal it.
        self.navigate_local(app, url.as_str(), force, expected_generation, false)
    }

    fn cancel_watchdog(&self) {
        if let Ok(mut navigation) = self.inner.navigation.lock() {
            navigation.cancel_watchdog();
        }
    }

    fn watchdog_is_current(&self, generation: u64) -> bool {
        self.inner
            .navigation
            .lock()
            .is_ok_and(|navigation| navigation.watchdog_is_current(generation))
    }

    fn start_watchdog(&self, app: AppHandle) {
        let generation = {
            let Ok(mut navigation) = self.inner.navigation.lock() else {
                return;
            };
            let Some(generation) = navigation.begin_watchdog() else {
                return;
            };
            generation
        };
        let state = self.clone();
        thread::spawn(move || loop {
            thread::sleep(CONNECTED_WATCH_INTERVAL);
            if !state.watchdog_is_current(generation) {
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
            if matches!(
                state.show_local(&app, local_mode(&snapshot), false, Some(generation)),
                Ok(false)
            ) {
                return;
            }
            state.update_tray(&snapshot);
            drop(_operation);
            loop {
                if !state.watchdog_is_current(generation) {
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
                            match state.navigate_local(
                                &app,
                                &ready.dashboard_url,
                                false,
                                Some(generation),
                                false,
                            ) {
                                Ok(true) => {
                                    state.update_tray(&ready.snapshot);
                                    break;
                                }
                                Ok(false) => return,
                                Err(_) => {}
                            }
                        }
                    } else if snapshot.phase != displayed_phase {
                        displayed_phase = snapshot.phase;
                        if matches!(
                            state.show_local(&app, local_mode(&snapshot), false, Some(generation),),
                            Ok(false)
                        ) {
                            return;
                        }
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

#[cfg(test)]
mod navigation_tests {
    use super::NavigationState;

    #[test]
    fn newer_remote_selection_blocks_older_local_navigation() {
        let mut navigation = NavigationState::default();
        assert!(navigation.permit_local(false, None));

        navigation.select_remote();

        assert!(!navigation.permit_local(false, None));
        assert!(navigation.remote_dashboard);
    }

    #[test]
    fn newer_remote_selection_invalidates_watchdog_navigation() {
        let mut navigation = NavigationState::default();
        let watchdog = navigation.begin_watchdog().expect("watchdog generation");

        navigation.select_remote();

        assert!(!navigation.permit_local(false, Some(watchdog)));
        assert!(!navigation.watchdog_is_current(watchdog));
    }

    #[test]
    fn explicit_local_then_later_remote_preserves_latest_intent() {
        let mut navigation = NavigationState::default();
        navigation.select_remote();
        assert!(navigation.permit_local(true, None));
        assert!(!navigation.remote_dashboard);

        navigation.select_remote();

        assert!(!navigation.permit_local(false, None));
        assert!(navigation.remote_dashboard);
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
    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = canvas::register_protocol(builder);

    let builder = builder.setup(|app| {
        let window = app
            .get_webview_window("main")
            .expect("tauri.conf.json must define the main window");
        let state = DesktopState::new(window.url()?);
        app.manage(state.clone());
        app.manage(discovery::GatewayDiscovery::default());
        #[cfg(target_os = "linux")]
        match canvas::CanvasBridge::start(app.handle().clone()) {
            Ok(bridge) => {
                app.manage(bridge);
            }
            Err(error) => eprintln!("Canvas bridge unavailable: {error}"),
        }
        state.set_tray(tray::build(app, state.clone())?);
        Ok(())
    });
    #[cfg(target_os = "linux")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        bootstrap,
        canvas::canvas_a2ui_action,
        discovery::connect_discovered_gateway,
        discovery::discover_gateways,
        install_cli,
        gateway_action
    ]);
    #[cfg(not(target_os = "linux"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        bootstrap,
        discovery::connect_discovered_gateway,
        discovery::discover_gateways,
        install_cli,
        gateway_action
    ]);

    let app = builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<DesktopState>();
                if !state.is_quitting() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("OpenClaw desktop app failed");
    app.run(|app, event| {
        #[cfg(target_os = "linux")]
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(bridge) = app.try_state::<canvas::CanvasBridge>() {
                bridge.shutdown();
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (app, event);
    });
}
