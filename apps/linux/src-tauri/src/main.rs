mod cli;
mod discovery;
mod gateway;
mod gateway_device_identity;
mod gateway_operation_queue;
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
mod gateway_sleep;
#[cfg(target_os = "linux")]
mod gateway_sleep_logind;
#[cfg(target_os = "linux")]
mod gateway_sleep_logind_listener;
mod gateway_ws;
mod installer;
mod notify;
mod pending_approvals;
mod quickchat;
mod quickchat_widgets;
mod remote_gateway;
mod tray;
mod updater;

use cli::{CliError, OpenClawCli};
use gateway::{GatewayAction, GatewaySnapshot, ReadyGateway};
use gateway_operation_queue::{GatewayOperation, GatewayOperationQueue};
use installer::InstallChannel;
use remote_gateway::RemoteGatewayRequest;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, State, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{Code, Modifiers};
use tauri_plugin_opener::OpenerExt;

const CONNECTED_WATCH_INTERVAL: Duration = Duration::from_secs(15);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);
fn external_browser_url_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
}

fn native_auth_initialization_script(
    dashboard: &Url,
    gateway: &Url,
    request: &RemoteGatewayRequest,
) -> Result<String, String> {
    if request.transport == "direct" && request.tls_fingerprint.is_some() {
        return Err(
            "The desktop dashboard cannot securely verify a pinned Gateway TLS certificate. \
             Connect using Remote over SSH instead."
                .to_string(),
        );
    }
    let path = dashboard.path().trim_end_matches('/');
    let origin = serde_json::to_string(&dashboard.origin().ascii_serialization())
        .map_err(|_| "Could not prepare secure Gateway authentication.".to_string())?;
    let path = serde_json::to_string(if path.is_empty() { "/" } else { path })
        .map_err(|_| "Could not prepare secure Gateway authentication.".to_string())?;
    let auth = serde_json::json!({
        "gatewayUrl": gateway.as_str(),
        "token": request.token,
        "password": request.password,
    });
    let auth = serde_json::to_string(&auth)
        .map_err(|_| "Could not prepare secure Gateway authentication.".to_string())?;
    Ok(format!(
        r#"(() => {{
  try {{
    if (location.origin !== {origin}) return;
    const base = {path};
    if (base !== "/" && location.pathname !== base && !location.pathname.startsWith(`${{base}}/`)) return;
    Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {{
      value: {auth},
      configurable: true,
    }});
  }} catch {{}}
}})();"#
    ))
}

fn open_external_browser(app: &AppHandle, url: &Url) {
    if external_browser_url_allowed(url)
        && app.opener().open_url(url.as_str(), None::<&str>).is_err()
    {
        eprintln!("Could not open the external sign-in page.");
    }
}

fn is_active_onboarding_url(url: &Url) -> bool {
    let path = url.path().trim_end_matches('/');
    let query_key = if path.ends_with("/settings/model-setup") {
        "firstRun"
    } else if path.ends_with("/custodian") {
        "onboarding"
    } else {
        return false;
    };
    url.query_pairs()
        .find(|(key, _)| key == query_key)
        .is_some_and(|(_, value)| {
            if query_key == "firstRun" {
                return value == "1";
            }
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

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
                tray::open_dashboard(app);
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

#[cfg(test)]
mod native_browser_tests {
    use super::{
        external_browser_url_allowed, native_auth_initialization_script, RemoteGatewayRequest, Url,
    };
    use std::process::Command;

    #[test]
    fn oauth_browser_accepts_http_urls_but_never_unsafe_schemes_or_userinfo() {
        for (candidate, allowed) in [
            (
                "https://auth.openai.com/oauth/authorize?state=fixture",
                true,
            ),
            ("http://127.0.0.1:1455/auth/callback", true),
            ("file:///etc/passwd", false),
            ("javascript:alert(1)", false),
            ("data:text/html,fixture", false),
            ("openclaw://dashboard", false),
        ] {
            assert_eq!(
                external_browser_url_allowed(&Url::parse(candidate).expect("URL")),
                allowed,
                "unexpected external-browser decision for {candidate}"
            );
        }
        let userinfo = ["operator", "fixture"].join(":");
        let credentialed = format!("https://{userinfo}@gateway.example.com");
        assert!(!external_browser_url_allowed(
            &Url::parse(&credentialed).expect("credentialed URL")
        ));
    }

    #[test]
    fn native_password_handoff_is_origin_scoped_and_consumed_before_page_code() {
        let request = RemoteGatewayRequest {
            transport: "direct".to_string(),
            url: Some("https://gateway.example.com/openclaw".to_string()),
            ssh_target: None,
            token: None,
            password: Some("fixture-password".to_string()),
            remote_port: None,
            tls_fingerprint: None,
        };
        let dashboard = Url::parse("https://gateway.example.com/openclaw").expect("dashboard");
        let gateway = Url::parse("wss://gateway.example.com/openclaw").expect("Gateway");
        let initialization_script =
            native_auth_initialization_script(&dashboard, &gateway, &request).expect("auth script");
        assert!(!dashboard.as_str().contains("fixture-password"));
        assert!(!gateway.as_str().contains("fixture-password"));

        let runner = r#"
            const init = new Function('window', 'location', process.argv[1]);
            const cases = [
              ['https://gateway.example.com', '/openclaw', true],
              ['https://gateway.example.com', '/openclaw/settings/model-setup', true],
              ['https://attacker.example.com', '/openclaw', false],
              ['https://gateway.example.com', '/openclaw-other', false],
              ['https://gateway.example.com', '/other', false],
            ];
            for (const [origin, pathname, allowed] of cases) {
              const window = {};
              init(window, {origin, pathname});
              const auth = window.__OPENCLAW_NATIVE_CONTROL_AUTH__;
              if (Boolean(auth) !== allowed) throw new Error('origin/path policy failed');
              if (allowed && (auth.gatewayUrl !== 'wss://gateway.example.com/openclaw' || auth.password !== 'fixture-password')) {
                throw new Error('native password was not delivered');
              }
            }
        "#;
        let output = Command::new("node")
            .args(["-e", runner, &initialization_script])
            .output()
            .expect("Node is required by the OpenClaw workspace");
        assert!(
            output.status.success(),
            "native auth handoff failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn pinned_remote_gateway_never_receives_credentials_through_an_unpinned_webview() {
        let request: RemoteGatewayRequest = serde_json::from_value(serde_json::json!({
            "transport": "direct",
            "url": "https://gateway.example.com/openclaw",
            "token": "fixture-token",
            "tlsFingerprint": "ab".repeat(32),
        }))
        .expect("pinned remote request");
        let dashboard = Url::parse("https://gateway.example.com/openclaw").expect("dashboard");
        let gateway = Url::parse("wss://gateway.example.com/openclaw").expect("Gateway");
        let result = native_auth_initialization_script(&dashboard, &gateway, &request);

        assert!(
            result.is_err(),
            "a certificate-pinned Gateway must never receive credentials through an unpinned WebView"
        );
        assert!(
            result
                .err()
                .expect("rejected pin")
                .contains("Remote over SSH"),
            "the rejection must explain the secure supported transport"
        );

        let mut tunneled = request;
        tunneled.transport = "ssh".to_string();
        let tunneled_dashboard = Url::parse("http://127.0.0.1:18789").expect("tunneled dashboard");
        let tunneled_gateway = Url::parse("ws://127.0.0.1:18789").expect("tunneled Gateway");
        assert!(
            native_auth_initialization_script(&tunneled_dashboard, &tunneled_gateway, &tunneled)
                .is_ok(),
            "host-key-verified SSH tunneling must remain available"
        );
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
            // Setup owns inference before chat; preserve Gateway base paths and fragment auth.
            url.path_segments_mut()
                .map_err(|_| "Dashboard returned an invalid URL.".to_string())?
                .pop_if_empty()
                .extend(["settings", "model-setup"]);
            url.query_pairs_mut().append_pair("firstRun", "1");
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
    remote_tunnel: Mutex<Option<remote_gateway::SshTunnel>>,
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
                remote_tunnel: Mutex::new(None),
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
        self.connect_selected(app, false)
    }

    fn connect_selected(
        &self,
        app: &AppHandle,
        explicit_local: bool,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Gateway operation lock is unavailable.".to_string())?;
        if !explicit_local {
            if let Some(remote) = remote_gateway::load_saved_remote()? {
                return self.connect_remote_locked(app, remote);
            }
        }
        let cli = self.resolve_cli();
        if !explicit_local && !remote_gateway::has_configured_gateway()? {
            // First-run setup belongs to the pending bootstrap reply. Navigating
            // here replaces its WebView and loses the local/remote choice.
            let snapshot = match cli {
                Ok(_) => GatewaySnapshot::unconfigured(),
                Err(CliError::Missing) => GatewaySnapshot::missing_cli(),
                Err(error) => return Err(error.to_string()),
            };
            self.update_tray(&snapshot);
            return Ok(snapshot);
        }
        let cli = match cli {
            Ok(cli) => cli,
            Err(CliError::Missing) => {
                return self.show_missing_cli(app, explicit_local, None);
            }
            Err(error) => return Err(error.to_string()),
        };
        if explicit_local {
            self.inner
                .remote_tunnel
                .lock()
                .map_err(|_| "Remote Gateway tunnel lock is unavailable.".to_string())?
                .take();
        }
        let ready = gateway::ensure_ready(&cli)?;
        self.finish_local_connection(app, cli, ready)
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
        let cli = OpenClawCli::discover().map_err(|error| {
            format!("OpenClaw is installed, but the CLI could not be found: {error}")
        })?;
        *self.inner.cli.lock().expect("CLI mutex poisoned") = Some(cli.clone());

        // The installed CLI owns config/state migrations; repair before any
        // Gateway readiness checks consume an outdated home.
        let repair_error = match cli.output(["doctor", "--fix", "--non-interactive"]) {
            Ok(output) if !output.status.success() => Some(
                cli::output_tail(&output.stderr)
                    .unwrap_or_else(|| format!("OpenClaw repair exited with {}", output.status)),
            ),
            Err(error) => Some(format!("OpenClaw repair could not start: {error}")),
            _ => None,
        };
        if let Some(error) = repair_error {
            for line in error.lines() {
                let _ = app.emit_to(
                    "main",
                    "install-progress",
                    serde_json::json!({ "stream": "stderr", "line": line }),
                );
            }
        }

        self.inner
            .navigation
            .lock()
            .map_err(|_| {
                "OpenClaw is installed, but preparing the Gateway dashboard failed: \
                 Dashboard navigation lock is unavailable."
                    .to_string()
            })?
            .mark_onboarding_pending();
        let ready = gateway::ensure_ready(&cli).map_err(|error| {
            format!("OpenClaw is installed, but connecting to the Gateway failed: {error}")
        })?;
        self.finish_local_connection(app, cli, ready)
            .map_err(|error| {
                format!("OpenClaw is installed, but opening the Gateway dashboard failed: {error}")
            })
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
        self.finish_local_connection(app, cli, ready)
    }

    fn finish_local_connection(
        &self,
        app: &AppHandle,
        cli: OpenClawCli,
        ready: ReadyGateway,
    ) -> Result<GatewaySnapshot, String> {
        app.state::<gateway_ws::GatewayClient>()
            .configure(app, ready.gateway_ws);
        let navigated = self.navigate_local(app, &ready.dashboard_url, false, None, true, true)?;
        self.update_tray(&ready.snapshot);
        if navigated {
            self.start_watchdog(app.clone(), cli);
        }
        Ok(ready.snapshot)
    }

    pub fn connect_explicit_local(&self, app: &AppHandle) -> Result<GatewaySnapshot, String> {
        let mut navigation = self
            .inner
            .navigation
            .lock()
            .map_err(|_| "Dashboard navigation lock is unavailable.".to_string())?;
        navigation.permit_local(true, None);
        // First-run setup owns the pending bootstrap reply. Replacing its page
        // drops the error callback and leaves a reconnect screen with no watchdog.
        if !self.main_window_has_local_content(&main_window(app)?) {
            let mut url = self.inner.local_url.clone();
            url.query_pairs_mut()
                .clear()
                .append_pair("mode", "reconnecting");
            self.navigate_locked(app, url, false)?;
        }
        drop(navigation);
        self.connect_selected(app, true)
    }

    pub(crate) fn connect_remote(
        &self,
        app: &AppHandle,
        request: RemoteGatewayRequest,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Gateway operation lock is unavailable.".to_string())?;
        self.connect_remote_locked(app, request)
    }

    fn connect_remote_locked(
        &self,
        app: &AppHandle,
        mut request: RemoteGatewayRequest,
    ) -> Result<GatewaySnapshot, String> {
        remote_gateway::validate_request(&request)?;
        let mut active_tunnel = self
            .inner
            .remote_tunnel
            .lock()
            .map_err(|_| "Remote Gateway tunnel lock is unavailable.".to_string())?;
        active_tunnel.take();
        let (tunnel, gateway_url) = if request.transport == "ssh" {
            let saved_url = request
                .url
                .as_deref()
                .map(remote_gateway::normalize_gateway_url)
                .transpose()?;
            let (tunnel, url) = remote_gateway::start_tunnel(&request, saved_url.as_ref())?;
            (Some(tunnel), url)
        } else {
            let raw = request
                .url
                .as_deref()
                .ok_or_else(|| "Enter the URL of your remote Gateway.".to_string())?;
            (None, remote_gateway::normalize_gateway_url(raw)?)
        };
        remote_gateway::resolve_remote_tls_fingerprint(&mut request, &gateway_url)?;
        let target = remote_gateway::dashboard_url(&gateway_url)?;
        let script = native_auth_initialization_script(&target, &gateway_url, &request)?;
        remote_gateway::save_config_at(&remote_gateway::config_path()?, &request, &gateway_url)?;
        *active_tunnel = tunnel;
        drop(active_tunnel);

        app.state::<gateway_ws::GatewayClient>().configure(
            app,
            gateway_ws::GatewayWsConfig::new(
                gateway_url.to_string(),
                request.token.clone(),
                request.password.clone(),
                if gateway_url.scheme() == "wss" {
                    request.tls_fingerprint.clone()
                } else {
                    None
                },
            ),
        );
        self.navigate_authenticated_remote(app, target, script)?;
        let snapshot = GatewaySnapshot {
            phase: "connected",
            installed: false,
            running: false,
            reachable: true,
            status: "Connected to remote Gateway".to_string(),
            detail: None,
        };
        self.update_tray(&snapshot);
        Ok(snapshot)
    }

    fn navigate_authenticated_remote(
        &self,
        app: &AppHandle,
        dashboard: Url,
        script: String,
    ) -> Result<(), String> {
        let window = app
            .get_window("main")
            .ok_or_else(|| "Main window is unavailable.".to_string())?;
        let size = window
            .inner_size()
            .map_err(|_| "Could not measure the Gateway window.".to_string())?;
        let mut navigation = self
            .inner
            .navigation
            .lock()
            .map_err(|_| "Dashboard navigation lock is unavailable.".to_string())?;
        let old_webview = app
            .get_webview("main")
            .ok_or_else(|| "Main dashboard view is unavailable.".to_string())?;
        navigation.select_remote();
        // Keep the native window alive: only its child changes so tray ownership,
        // geometry and close-to-tray behavior survive auth-bound script injection.
        old_webview
            .close()
            .map_err(|_| "Could not replace the Gateway dashboard view.".to_string())?;
        let browser_app = app.clone();
        let builder = WebviewBuilder::new("main", WebviewUrl::External(dashboard))
            .initialization_script(script)
            .on_new_window(move |url, _features| {
                open_external_browser(&browser_app, &url);
                NewWindowResponse::Deny
            })
            .auto_resize();
        if window
            .add_child(builder, LogicalPosition::new(0, 0), size)
            .is_err()
        {
            navigation.remote_dashboard = false;
            let browser_app = app.clone();
            let restore = WebviewBuilder::new("main", WebviewUrl::App("index.html".into()))
                .on_new_window(move |url, _features| {
                    open_external_browser(&browser_app, &url);
                    NewWindowResponse::Deny
                })
                .auto_resize();
            let _ = window.add_child(restore, LogicalPosition::new(0, 0), size);
            return Err(
                "Could not open the remote Gateway dashboard. Try connecting again.".to_string(),
            );
        }
        drop(navigation);
        tray::show_window(app);
        Ok(())
    }

    pub fn show_error(&self, app: &AppHandle, _error: &str) {
        let _ = self.show_local(app, "error", false, None);
        self.update_tray(&GatewaySnapshot::reconnecting("Gateway action failed."));
        tray::show_window(app);
    }

    pub fn quit(&self) {
        self.inner.quitting.store(true, Ordering::SeqCst);
        self.cancel_watchdog();
        if let Ok(mut tunnel) = self.inner.remote_tunnel.lock() {
            tunnel.take();
        }
    }

    fn is_quitting(&self) -> bool {
        self.inner.quitting.load(Ordering::SeqCst)
    }

    pub(crate) fn resolve_cli(&self) -> Result<OpenClawCli, CliError> {
        if let Some(cli) = self
            .inner
            .cli
            .lock()
            .expect("CLI mutex poisoned")
            .clone()
            .filter(OpenClawCli::is_available)
        {
            return Ok(cli);
        }
        let cli = OpenClawCli::discover()?;
        *self.inner.cli.lock().expect("CLI mutex poisoned") = Some(cli.clone());
        Ok(cli)
    }

    pub(crate) fn main_window_has_local_content(&self, window: &WebviewWindow) -> bool {
        window.url().is_ok_and(|mut current_url| {
            let mut local_url = self.inner.local_url.clone();
            current_url.set_query(None);
            current_url.set_fragment(None);
            local_url.set_query(None);
            local_url.set_fragment(None);
            current_url == local_url
        })
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

    fn show_missing_cli(
        &self,
        app: &AppHandle,
        force: bool,
        expected_generation: Option<u64>,
    ) -> Result<GatewaySnapshot, String> {
        let snapshot = GatewaySnapshot::missing_cli();
        let navigation = self.show_local(app, "missingCli", force, expected_generation);
        if !local_recovery_owns_gateway(&navigation) {
            return Ok(snapshot);
        }
        app.state::<gateway_ws::GatewayClient>()
            .clear_configuration(app);
        self.update_tray(&snapshot);
        navigation.map(|_| snapshot)
    }

    fn show_cli_recovery_error(&self, app: &AppHandle, generation: u64, error: CliError) {
        let mut snapshot = GatewaySnapshot::missing_cli();
        snapshot.status = "CLI unavailable".to_string();
        snapshot.detail = Some(error.to_string());
        let navigation = self.show_local(app, "error", false, Some(generation));
        if local_recovery_owns_gateway(&navigation) {
            app.state::<gateway_ws::GatewayClient>()
                .clear_configuration(app);
            self.update_tray(&snapshot);
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
            .update(pending);
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

    fn start_watchdog(&self, app: AppHandle, mut cli: OpenClawCli) {
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

            // Onboarding keeps verification and guided-session state in its live page. Latch it
            // for this outage so neither recovery screen nor dashboard reload erases that state.
            let preserve_dashboard = main_window(&app)
                .ok()
                .and_then(|window| window.url().ok())
                .is_some_and(|url| is_active_onboarding_url(&url));
            let mut displayed_phase = snapshot.phase;
            if !preserve_dashboard
                && matches!(
                    state.show_local(&app, local_mode(&snapshot), false, Some(generation)),
                    Ok(false)
                )
            {
                return;
            }
            state.update_tray(&snapshot);
            drop(_operation);
            loop {
                if !state.watchdog_is_current(generation) {
                    return;
                }
                if let Ok(_operation) = state.inner.operation.try_lock() {
                    if !cli.is_available() {
                        match state.resolve_cli() {
                            Ok(discovered) => cli = discovered,
                            Err(error) => {
                                if matches!(error, CliError::Missing) {
                                    let _ = state.show_missing_cli(&app, false, Some(generation));
                                } else {
                                    state.show_cli_recovery_error(&app, generation, error);
                                }
                                return;
                            }
                        }
                    }
                    let snapshot = match gateway::status(&cli) {
                        Ok(snapshot) => snapshot,
                        Err(error) => GatewaySnapshot::reconnecting(error),
                    };
                    state.update_tray(&snapshot);
                    if snapshot.reachable {
                        if let Ok(ready) = gateway::dashboard(&cli, snapshot) {
                            app.state::<gateway_ws::GatewayClient>()
                                .configure(&app, ready.gateway_ws.clone());
                            if preserve_dashboard {
                                state.update_tray(&ready.snapshot);
                                break;
                            }
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
                    } else if !preserve_dashboard && snapshot.phase != displayed_phase {
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

fn local_recovery_owns_gateway(navigation: &Result<bool, String>) -> bool {
    !matches!(navigation, Ok(false))
}

#[cfg(test)]
mod navigation_tests {
    use super::{
        is_active_onboarding_url, is_release_version, local_recovery_owns_gateway, NavigationState,
        Url,
    };

    #[test]
    fn only_active_onboarding_preserves_the_dashboard_during_reconnect() {
        for (url, preserve) in [
            ("http://127.0.0.1/settings/model-setup?firstRun=1", true),
            (
                "http://127.0.0.1/openclaw/settings/model-setup/?tab=ai&firstRun=1#token=redacted",
                true,
            ),
            ("http://127.0.0.1/settings/model-setup", false),
            ("http://127.0.0.1/settings/model-setup?firstRun=0", false),
            (
                "http://127.0.0.1/settings/model-setup?firstRun=0&firstRun=1",
                false,
            ),
            ("http://127.0.0.1/settings/providers?firstRun=1", false),
            ("http://127.0.0.1/custodian?onboarding=1", true),
            (
                "http://127.0.0.1/openclaw/custodian/?tab=chat&onboarding=YES",
                true,
            ),
            ("http://127.0.0.1/custodian", false),
            ("http://127.0.0.1/custodian?onboarding=0", false),
            (
                "http://127.0.0.1/custodian?onboarding=0&onboarding=1",
                false,
            ),
            ("http://127.0.0.1/chat?onboarding=1", false),
        ] {
            assert_eq!(
                is_active_onboarding_url(&Url::parse(url).expect("dashboard URL")),
                preserve,
                "unexpected reconnect policy for {url}"
            );
        }
    }

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
    fn local_recovery_clears_retained_gateway_unless_remote_navigation_won() {
        assert!(local_recovery_owns_gateway(&Ok(true)));
        assert!(local_recovery_owns_gateway(&Err(
            "local navigation failed".to_string()
        )));
        assert!(!local_recovery_owns_gateway(&Ok(false)));
    }

    #[test]
    fn first_run_url_preserves_gateway_base_path_query_and_auth_fragment() {
        let mut navigation = NavigationState::default();
        navigation.mark_onboarding_pending();

        let url = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/openclaw/?foo=bar#token=secret")
            .expect("dashboard URL");

        assert_eq!(url.path(), "/openclaw/settings/model-setup");
        assert_eq!(url.query(), Some("foo=bar&firstRun=1"));
        assert_eq!(url.fragment(), Some("token=secret"));
    }

    #[test]
    fn first_run_model_setup_is_opened_only_once() {
        let mut navigation = NavigationState::default();
        navigation.mark_onboarding_pending();

        let first = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/#token=secret")
            .expect("first dashboard URL");
        let second = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/#token=secret")
            .expect("second dashboard URL");

        assert_eq!(first.path(), "/settings/model-setup");
        assert_eq!(first.query(), Some("firstRun=1"));
        assert!(is_active_onboarding_url(&first));
        assert_eq!(second.path(), "/");
        assert_eq!(second.query(), None);
        assert!(!is_active_onboarding_url(&second));
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
    operations: State<'_, GatewayOperationQueue>,
    explicit_local: Option<bool>,
) -> Result<GatewaySnapshot, String> {
    let operation = if explicit_local == Some(true) {
        GatewayOperation::ConnectExplicitLocal
    } else {
        GatewayOperation::Connect
    };
    operations.execute(operation).await
}

#[tauri::command]
async fn connect_remote_gateway(
    operations: State<'_, GatewayOperationQueue>,
    transport: String,
    url: Option<String>,
    ssh_target: Option<String>,
    token: Option<String>,
    password: Option<String>,
    remote_port: Option<u16>,
) -> Result<GatewaySnapshot, String> {
    operations
        .execute(GatewayOperation::ConnectRemote(RemoteGatewayRequest {
            transport,
            url,
            ssh_target,
            token,
            password,
            remote_port,
            tls_fingerprint: None,
        }))
        .await
}

#[tauri::command]
async fn install_cli(
    operations: State<'_, GatewayOperationQueue>,
    channel: InstallChannel,
) -> Result<GatewaySnapshot, String> {
    operations.execute(GatewayOperation::Install(channel)).await
}

#[tauri::command]
async fn gateway_action(
    operations: State<'_, GatewayOperationQueue>,
    action: GatewayAction,
) -> Result<GatewaySnapshot, String> {
    operations.execute(GatewayOperation::Action(action)).await
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
        .plugin(
            tauri_plugin_opener::Builder::new()
                // Dashboard links use the native handler; its renderer has no opener IPC grant.
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&[quickchat::QUICKCHAT_LABEL])
                .build(),
        );

    let builder = builder.setup(move |app| {
        let window_config = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .cloned()
            .expect("tauri.conf.json must define the main window");
        let browser_app = app.handle().clone();
        let window = WebviewWindowBuilder::from_config(app.handle(), &window_config)?
            .on_new_window(move |url, _features| {
                open_external_browser(&browser_app, &url);
                NewWindowResponse::Deny
            })
            .build()?;
        let state = DesktopState::new(window.url()?);
        app.manage(state.clone());
        app.manage(gateway_ws::GatewayClient::new());
        #[cfg(target_os = "linux")]
        app.manage(gateway_sleep_logind::SleepBridge::start(
            app.handle().clone(),
        ));
        let operation_app = app.handle().clone();
        let operation_state = state.clone();
        let error_app = app.handle().clone();
        let error_state = state.clone();
        // Every caller of the operation mutex enters this queue so UI source cannot reorder work.
        app.manage(GatewayOperationQueue::new(
            move |operation| match operation {
                GatewayOperation::Connect => operation_state.connect(&operation_app),
                GatewayOperation::ConnectExplicitLocal => {
                    operation_state.connect_explicit_local(&operation_app)
                }
                GatewayOperation::ConnectRemote(request) => {
                    operation_state.connect_remote(&operation_app, request)
                }
                GatewayOperation::Install(channel) => {
                    operation_state.install_cli(&operation_app, channel)
                }
                GatewayOperation::Action(action) => {
                    operation_state.gateway_action(&operation_app, action)
                }
            },
            move |error| error_state.show_error(&error_app, error),
        ));
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
        state.set_tray(tray::build(app, state.clone(), global_shortcuts_supported)?);
        Ok(())
    });
    let builder = builder.invoke_handler(tauri::generate_handler![
        bootstrap,
        build_info,
        updater::check_for_updates,
        discovery::connect_discovered_gateway,
        connect_remote_gateway,
        discovery::discover_gateways,
        install_cli,
        gateway_action,
        quickchat::quickchat_activate,
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
                        // GTK queues focus events; a stale blur must not hide a refocused window.
                        if cfg!(target_os = "linux") && window.is_focused().unwrap_or(false) {
                            return;
                        }
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
            if let Some(bridge) = app.try_state::<gateway_sleep_logind::SleepBridge>() {
                bridge.shutdown();
            }
            if let Some(state) = app.try_state::<DesktopState>() {
                state.quit();
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (app, event);
    });
}
