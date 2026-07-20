#[cfg(target_os = "linux")]
mod canvas;
mod cli;
mod discovery;
mod gateway;
mod gateway_device_identity;
mod gateway_ws;
mod installer;
mod notify;
mod pending_approvals;
mod quickchat;
mod quickchat_widgets;
mod tray;
mod updater;

use cli::{CliError, OpenClawCli};
use gateway::{GatewayAction, GatewaySnapshot};
use installer::InstallChannel;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, Url, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{Code, Modifiers};

const CONNECTED_WATCH_INTERVAL: Duration = Duration::from_secs(15);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    version: String,
    release_build: bool,
}

fn is_release_version(version: &str) -> bool {
    // The committed 0.1.0 version identifies branch builds; release builds are stamped by CI.
    version != "0.1.0"
}

// The openclaw:// URL contract is deliberately tiny and handled entirely in
// Rust: `openclaw://dashboard` opens/connects the dashboard; anything else
// just focuses the app. New routes are added to this enum — the renderer
// (which is often navigated away to the remote dashboard) never sees URLs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DeepLinkRoute {
    Dashboard,
    FocusOnly,
}

fn deep_link_route(url: &Url) -> DeepLinkRoute {
    if url.scheme() == "openclaw" && url.host_str() == Some("dashboard") {
        DeepLinkRoute::Dashboard
    } else {
        DeepLinkRoute::FocusOnly
    }
}

fn handle_deep_links(app: &AppHandle, urls: Vec<Url>) {
    for url in urls {
        match deep_link_route(&url) {
            DeepLinkRoute::Dashboard => {
                let desktop = app.state::<DesktopState>();
                tray::open_dashboard(app, desktop.inner());
            }
            DeepLinkRoute::FocusOnly => tray::show_window(app),
        }
    }
}

#[cfg(test)]
mod deep_link_tests {
    use super::{deep_link_route, DeepLinkRoute, Url};

    #[test]
    fn dashboard_route_matches_only_the_openclaw_dashboard_host() {
        let dashboard = Url::parse("openclaw://dashboard/ignored?source=test").unwrap();
        let other = Url::parse("openclaw://settings/dashboard").unwrap();
        let other_scheme = Url::parse("https://dashboard/").unwrap();

        assert_eq!(deep_link_route(&dashboard), DeepLinkRoute::Dashboard);
        assert_eq!(deep_link_route(&other), DeepLinkRoute::FocusOnly);
        assert_eq!(deep_link_route(&other_scheme), DeepLinkRoute::FocusOnly);
    }
}

#[derive(Default)]
struct NavigationState {
    // One lock owns both fields so the intent check and WebView navigation cannot interleave.
    remote_dashboard: bool,
    watch_generation: u64,
    onboarding_pending: bool,
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

    fn mark_onboarding_pending(&mut self) {
        self.onboarding_pending = true;
    }

    fn prepare_dashboard_url(&mut self, target: &str) -> Result<Url, String> {
        let mut url =
            Url::parse(target).map_err(|_| "Dashboard returned an invalid URL.".to_string())?;
        if self.onboarding_pending {
            // Dashboard auth lives in the fragment, so the marker must be added through URL pairs.
            url.query_pairs_mut().append_pair("onboarding", "1");
            self.onboarding_pending = false;
        }
        Ok(url)
    }
}

struct DesktopInner {
    cli: Mutex<Option<OpenClawCli>>,
    navigation: Mutex<NavigationState>,
    operation: Mutex<()>,
    pending_approvals: Mutex<pending_approvals::PendingApprovalState>,
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
                pending_approvals: Mutex::new(pending_approvals::PendingApprovalState::default()),
                local_url,
                tray: Mutex::new(None),
                quitting: AtomicBool::new(false),
            }),
        }
    }

    fn set_tray(&self, handles: tray::TrayHandles) {
        *self.inner.tray.lock().expect("tray mutex poisoned") = Some(handles);
    }

    pub(crate) fn set_quickchat_shortcut_checked(&self, checked: bool) {
        if let Some(tray) = self
            .inner
            .tray
            .lock()
            .expect("tray mutex poisoned")
            .as_ref()
        {
            tray.set_quickchat_shortcut_checked(checked);
        }
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
                app.state::<gateway_ws::GatewayClient>()
                    .clear_configuration(app);
                let snapshot = GatewaySnapshot::missing_cli();
                self.update_tray(&snapshot);
                return Ok(snapshot);
            }
            Err(error) => return Err(error.to_string()),
        };
        let ready = gateway::ensure_ready(&cli)?;
        app.state::<gateway_ws::GatewayClient>()
            .configure(app, ready.gateway_ws.clone());
        let navigated = self.navigate_local(app, &ready.dashboard_url, false, None, true, true)?;
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
        self.inner
            .navigation
            .lock()
            .map_err(|_| "Dashboard navigation lock is unavailable.".to_string())?
            .mark_onboarding_pending();
        let cli = OpenClawCli::discover().map_err(|error| error.to_string())?;
        *self.inner.cli.lock().expect("CLI mutex poisoned") = Some(cli.clone());
        let ready = gateway::ensure_ready(&cli)?;
        app.state::<gateway_ws::GatewayClient>()
            .configure(app, ready.gateway_ws.clone());
        let navigated = self.navigate_local(app, &ready.dashboard_url, false, None, true, true)?;
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
            app.state::<gateway_ws::GatewayClient>()
                .clear_configuration(app);
            self.show_local(app, "stopped", false, None)?;
            self.update_tray(&snapshot);
            return Ok(snapshot);
        }

        let ready = gateway::dashboard(&cli, snapshot)?;
        app.state::<gateway_ws::GatewayClient>()
            .configure(app, ready.gateway_ws.clone());
        let navigated = self.navigate_local(app, &ready.dashboard_url, false, None, true, true)?;
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

    pub(crate) fn resolve_cli(&self) -> Result<OpenClawCli, CliError> {
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

    fn poll_pending_approvals(&self, app: &AppHandle, cli: &OpenClawCli, generation: u64) {
        let pending = match pending_approvals::fetch(cli) {
            Ok(pending) => pending,
            Err(error) => {
                eprintln!("Could not poll pending approvals: {error}");
                return;
            }
        };
        if !self.watchdog_is_current(generation) {
            return;
        }
        let diff = self
            .inner
            .pending_approvals
            .lock()
            .expect("pending approval mutex poisoned")
            .update(&pending);
        if let Some(tray) = self
            .inner
            .tray
            .lock()
            .expect("tray mutex poisoned")
            .as_ref()
        {
            tray.update_pending_count(diff.count);
        }
        if !main_window(app).is_ok_and(|window| matches!(window.is_focused(), Ok(false))) {
            return;
        }
        // Notifications are a doorbell only; approval stays in the dashboard or CLI.
        for request in diff.new {
            notify::notify(app, "OpenClaw", &request.notification_body());
        }
    }

    // Caller holds the navigation lock, keeping the final arbitration check and navigation atomic.
    fn navigate_locked(
        &self,
        app: &AppHandle,
        url: Url,
        reveal_window: bool,
    ) -> Result<(), String> {
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
        dashboard: bool,
    ) -> Result<bool, String> {
        let mut navigation = self
            .inner
            .navigation
            .lock()
            .map_err(|_| "Dashboard navigation lock is unavailable.".to_string())?;
        if !navigation.permit_local(force, expected_generation) {
            return Ok(false);
        }
        let onboarding_was_pending = dashboard && navigation.onboarding_pending;
        let url = if dashboard {
            navigation.prepare_dashboard_url(target)?
        } else {
            Url::parse(target).map_err(|_| "Dashboard returned an invalid URL.".to_string())?
        };
        if let Err(error) = self.navigate_locked(app, url, reveal_window) {
            if onboarding_was_pending {
                navigation.mark_onboarding_pending();
            }
            return Err(error);
        }
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
        self.navigate_local(app, url.as_str(), force, expected_generation, false, false)
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
                drop(_operation);
                // Pairing polls ride connected watchdog ticks; the reconnect loop never runs them.
                state.poll_pending_approvals(&app, &cli, generation);
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
                            app.state::<gateway_ws::GatewayClient>()
                                .configure(&app, ready.gateway_ws.clone());
                            match state.navigate_local(
                                &app,
                                &ready.dashboard_url,
                                false,
                                Some(generation),
                                false,
                                true,
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
    use super::{is_release_version, NavigationState};

    #[test]
    fn committed_package_version_is_a_development_build() {
        assert!(!is_release_version("0.1.0"));
    }

    #[test]
    fn stamped_package_versions_are_release_builds() {
        assert!(is_release_version("2026.7.2"));
        assert!(is_release_version("2026.7.2-beta.1"));
    }

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

    #[test]
    fn onboarding_url_preserves_existing_query_and_fragment() {
        let mut navigation = NavigationState::default();
        navigation.mark_onboarding_pending();

        let url = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/?foo=bar#token=secret")
            .expect("dashboard URL");

        assert_eq!(url.query(), Some("foo=bar&onboarding=1"));
        assert_eq!(url.fragment(), Some("token=secret"));
    }

    #[test]
    fn onboarding_flag_is_consumed_once() {
        let mut navigation = NavigationState::default();
        navigation.mark_onboarding_pending();

        let first = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/#token=secret")
            .expect("first dashboard URL");
        let second = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/#token=secret")
            .expect("second dashboard URL");

        assert_eq!(first.query(), Some("onboarding=1"));
        assert_eq!(second.query(), None);
    }

    #[test]
    fn regular_navigation_has_no_onboarding_marker() {
        let mut navigation = NavigationState::default();

        let url = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/?foo=bar#token=secret")
            .expect("dashboard URL");

        assert_eq!(url.query(), Some("foo=bar"));
        assert_eq!(url.fragment(), Some("token=secret"));
    }
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable.".to_string())
}

#[tauri::command]
fn build_info(app: AppHandle) -> BuildInfo {
    let version = app.package_info().version.to_string();
    BuildInfo {
        release_build: is_release_version(&version),
        version,
    }
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
    let global_shortcuts_supported = tray::global_shortcuts_supported();
    let quickchat_state = quickchat::QuickChatState::new(global_shortcuts_supported);
    let quickchat_shortcut_state = quickchat_state.clone();
    // Single-instance must run first so it can pass deep-link argv to the primary process.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    // global-hotkey's Linux backend is X11-only; omit it on Wayland instead of using XWayland.
    // A GlobalShortcuts portal can follow later.
    let builder = if global_shortcuts_supported {
        builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if quickchat_shortcut_state.matches_shortcut(shortcut) {
                            quickchat::toggle_quickchat(app);
                        } else if shortcut
                            .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyO)
                        {
                            tray::show_window(app);
                        }
                    }
                })
                .build(),
        )
    } else {
        builder
    };
    let builder = notify::register(builder)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["canvas", quickchat::QUICKCHAT_LABEL])
                .build(),
        );
    #[cfg(target_os = "linux")]
    let builder = canvas::register_protocol(builder);

    let builder = builder.setup(move |app| {
        let window = app
            .get_webview_window("main")
            .expect("tauri.conf.json must define the main window");
        let state = DesktopState::new(window.url()?);
        app.manage(state.clone());
        app.manage(gateway_ws::GatewayClient::new());
        let deep_link_app = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            handle_deep_links(&deep_link_app, event.urls());
        });
        if let Some(urls) = app.deep_link().get_current()? {
            handle_deep_links(app.handle(), urls);
        }
        #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
        if let Err(error) = app.deep_link().register_all() {
            eprintln!("Deep-link registration unavailable: {error}");
        }

        app.manage(discovery::GatewayDiscovery::default());
        app.manage(quickchat_state.clone());
        app.manage(updater::UpdaterState::default());
        #[cfg(target_os = "linux")]
        match canvas::CanvasBridge::start(app.handle().clone()) {
            Ok(bridge) => {
                app.manage(bridge);
            }
            Err(error) => eprintln!("Canvas bridge unavailable: {error}"),
        }
        state.set_tray(tray::build(app, state.clone(), global_shortcuts_supported)?);
        Ok(())
    });
    #[cfg(target_os = "linux")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        bootstrap,
        build_info,
        canvas::canvas_a2ui_action,
        updater::check_for_updates,
        discovery::connect_discovered_gateway,
        discovery::discover_gateways,
        install_cli,
        gateway_action,
        quickchat::quickchat_agents,
        quickchat::quickchat_hide,
        quickchat::quickchat_identity,
        quickchat::quickchat_ready,
        quickchat::quickchat_select_agent,
        quickchat::quickchat_send,
        quickchat::quickchat_set_expanded,
        quickchat::quickchat_set_shortcut,
        quickchat::quickchat_shortcut,
        quickchat::quickchat_show_dashboard,
        quickchat_widgets::quickchat_refresh_widget_surface,
        quickchat_widgets::quickchat_sync_widgets,
        updater::open_release_page,
        updater::relaunch,
        updater::updater_ready
    ]);
    #[cfg(not(target_os = "linux"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        bootstrap,
        build_info,
        updater::check_for_updates,
        discovery::connect_discovered_gateway,
        discovery::discover_gateways,
        install_cli,
        gateway_action,
        quickchat::quickchat_agents,
        quickchat::quickchat_hide,
        quickchat::quickchat_identity,
        quickchat::quickchat_ready,
        quickchat::quickchat_select_agent,
        quickchat::quickchat_send,
        quickchat::quickchat_set_expanded,
        quickchat::quickchat_set_shortcut,
        quickchat::quickchat_shortcut,
        quickchat::quickchat_show_dashboard,
        quickchat_widgets::quickchat_refresh_widget_surface,
        quickchat_widgets::quickchat_sync_widgets,
        updater::open_release_page,
        updater::relaunch,
        updater::updater_ready
    ]);

    let app = builder
        .on_window_event(|window, event| {
            if window.label() == quickchat::QUICKCHAT_LABEL {
                match event {
                    tauri::WindowEvent::Focused(false) => {
                        quickchat::request_hide(window.app_handle());
                        return;
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        quickchat::request_hide(window.app_handle());
                        return;
                    }
                    _ => {}
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label().starts_with("gateway-") {
                    return;
                }
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
