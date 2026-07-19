use crate::gateway_ws::{AgentsListResult, ChatSendResult, GatewayClient};
use crate::{tray, DesktopState};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use uuid::Uuid;

pub const QUICKCHAT_LABEL: &str = "quickchat";
// Alt+Space is GNOME's window-menu grab; a second X11 grab for it always fails.
pub const QUICKCHAT_SHORTCUT: &str = "CmdOrCtrl+Shift+Space";
const QUICKCHAT_SHORTCUT_FILE: &str = "quickchat-shortcut";
const QUICKCHAT_SHORTCUT_DISABLED_MARKER: &str = "quickchat-shortcut-disabled";
const QUICKCHAT_WIDTH: f64 = 640.0;
const QUICKCHAT_HEIGHT: f64 = 92.0;
const QUICKCHAT_EXPANDED_HEIGHT: f64 = 360.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickChatAgent {
    id: String,
    name: String,
    emoji: Option<String>,
    avatar_url: Option<String>,
    is_default: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickChatShortcutStatus {
    supported: bool,
    enabled: bool,
    accelerator: String,
}

#[derive(Clone)]
struct ActiveShortcut {
    accelerator: String,
    shortcut: Shortcut,
    registered: bool,
}

#[derive(Clone)]
struct QuickChatRetryIdentity {
    message: String,
    agent_id: String,
    scope: String,
    main_key: String,
    idempotency_key: String,
}

pub(crate) struct QuickChatShortcutPreference {
    pub accelerator: String,
    pub shortcut: Shortcut,
}

#[derive(Clone)]
pub struct QuickChatState {
    selected_agent_id: Arc<Mutex<Option<String>>>,
    active_shortcut: Arc<Mutex<ActiveShortcut>>,
    shortcuts_supported: bool,
    hide_requested: Arc<AtomicBool>,
    retry_identity: Arc<Mutex<Option<QuickChatRetryIdentity>>>,
}

impl QuickChatState {
    pub fn new(shortcuts_supported: bool) -> Self {
        let shortcut = parse_shortcut(QUICKCHAT_SHORTCUT)
            .expect("the built-in Quick Chat shortcut must be valid");
        Self {
            selected_agent_id: Arc::new(Mutex::new(None)),
            active_shortcut: Arc::new(Mutex::new(ActiveShortcut {
                accelerator: QUICKCHAT_SHORTCUT.to_string(),
                shortcut,
                registered: false,
            })),
            shortcuts_supported,
            hide_requested: Arc::new(AtomicBool::new(true)),
            retry_identity: Arc::new(Mutex::new(None)),
        }
    }

    fn send_idempotency_key(
        &self,
        message: &str,
        agent_id: &str,
        scope: &str,
        main_key: &str,
    ) -> Result<String, String> {
        let mut retry = self
            .retry_identity
            .lock()
            .map_err(|_| "Quick Chat retry state is unavailable.".to_string())?;
        if let Some(current) = retry.as_ref() {
            if current.message == message
                && current.agent_id == agent_id
                && current.scope == scope
                && current.main_key == main_key
            {
                return Ok(current.idempotency_key.clone());
            }
        }
        let idempotency_key = Uuid::new_v4().to_string();
        *retry = Some(QuickChatRetryIdentity {
            message: message.to_string(),
            agent_id: agent_id.to_string(),
            scope: scope.to_string(),
            main_key: main_key.to_string(),
            idempotency_key: idempotency_key.clone(),
        });
        Ok(idempotency_key)
    }

    fn clear_send_retry(&self, idempotency_key: &str) {
        if let Ok(mut retry) = self.retry_identity.lock() {
            if retry
                .as_ref()
                .is_some_and(|current| current.idempotency_key == idempotency_key)
            {
                *retry = None;
            }
        }
    }

    async fn agent_catalog(
        &self,
        gateway: &GatewayClient,
    ) -> Result<(AgentsListResult, Vec<QuickChatAgent>), String> {
        let catalog = gateway.agents_list().await?;
        let agents = build_agents(&catalog)?;
        {
            let mut selection = self
                .selected_agent_id
                .lock()
                .map_err(|_| "Quick Chat agent selection is unavailable.".to_string())?;
            if selection
                .as_ref()
                .is_some_and(|selected| !agents.iter().any(|agent| agent.id == selected.as_str()))
            {
                *selection = None;
            }
        }
        Ok((catalog, agents))
    }

    async fn agents(&self, gateway: &GatewayClient) -> Result<Vec<QuickChatAgent>, String> {
        self.agent_catalog(gateway).await.map(|(_, agents)| agents)
    }

    async fn selected_agent(
        &self,
        gateway: &GatewayClient,
        on_missing: MissingSelection,
    ) -> Result<(QuickChatAgent, AgentsListResult), String> {
        // Snapshot the pin before agents() refreshes the cache: a refresh clears a
        // stale pin, and the send path must see that the pin existed so it can fail
        // instead of silently rerouting the message to the default agent.
        let pinned = self
            .selected_agent_id
            .lock()
            .map_err(|_| "Quick Chat agent selection is unavailable.".to_string())?
            .clone();
        let (catalog, agents) = self.agent_catalog(gateway).await?;
        resolve_selected_agent(pinned.as_deref(), &agents, on_missing).map(|agent| (agent, catalog))
    }

    async fn select_agent(
        &self,
        gateway: &GatewayClient,
        agent_id: &str,
    ) -> Result<QuickChatAgent, String> {
        let agent_id = agent_id.trim();
        let agents = self.agents(gateway).await?;
        let selected = agents
            .iter()
            .find(|agent| agent.id == agent_id)
            .cloned()
            .ok_or_else(|| format!("Unknown Quick Chat agent \"{agent_id}\"."))?;
        *self
            .selected_agent_id
            .lock()
            .map_err(|_| "Quick Chat agent selection is unavailable.".to_string())? =
            if selected.is_default {
                None
            } else {
                Some(selected.id.clone())
            };
        Ok(selected)
    }

    fn shortcut_status(&self) -> Result<QuickChatShortcutStatus, String> {
        let active = self
            .active_shortcut
            .lock()
            .map_err(|_| "Quick Chat shortcut state is unavailable.".to_string())?;
        Ok(QuickChatShortcutStatus {
            supported: self.shortcuts_supported,
            enabled: active.registered,
            accelerator: active.accelerator.clone(),
        })
    }

    fn active_shortcut(&self) -> Result<ActiveShortcut, String> {
        self.active_shortcut
            .lock()
            .map_err(|_| "Quick Chat shortcut state is unavailable.".to_string())
            .map(|active| active.clone())
    }

    pub(crate) fn set_active_shortcut(
        &self,
        accelerator: String,
        shortcut: Shortcut,
        registered: bool,
    ) {
        if let Ok(mut active) = self.active_shortcut.lock() {
            *active = ActiveShortcut {
                accelerator,
                shortcut,
                registered,
            };
        }
    }

    pub(crate) fn set_shortcut_registered(&self, registered: bool) {
        if let Ok(mut active) = self.active_shortcut.lock() {
            active.registered = registered;
        }
    }

    pub(crate) fn shortcut(&self) -> Option<Shortcut> {
        self.active_shortcut
            .lock()
            .ok()
            .map(|active| active.shortcut)
    }

    pub fn matches_shortcut(&self, shortcut: &Shortcut) -> bool {
        self.active_shortcut
            .lock()
            .is_ok_and(|active| active.registered && active.shortcut == *shortcut)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum MissingSelection {
    FallBackToDefault,
    Fail,
}

fn resolve_selected_agent(
    pinned: Option<&str>,
    agents: &[QuickChatAgent],
    on_missing: MissingSelection,
) -> Result<QuickChatAgent, String> {
    if let Some(id) = pinned {
        if let Some(agent) = agents.iter().find(|agent| agent.id == id) {
            return Ok(agent.clone());
        }
        if on_missing == MissingSelection::Fail {
            return Err("The selected agent is no longer available.".to_string());
        }
    }
    agents
        .iter()
        .find(|agent| agent.is_default)
        .cloned()
        .ok_or_else(|| "OpenClaw did not report a default agent.".to_string())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn build_agents(catalog: &AgentsListResult) -> Result<Vec<QuickChatAgent>, String> {
    let agents = catalog
        .agents
        .iter()
        .map(|summary| {
            let id = summary.id.clone();
            let identity = summary.identity.as_ref();
            let name = non_empty(identity.and_then(|identity| identity.name.clone()))
                .or_else(|| non_empty(summary.name.clone()))
                .unwrap_or_else(|| id.clone());
            QuickChatAgent {
                id,
                name,
                emoji: non_empty(identity.and_then(|identity| identity.emoji.clone())),
                avatar_url: non_empty(identity.and_then(|identity| identity.avatar_url.clone())),
                is_default: summary.id == catalog.default_id,
            }
        })
        .collect::<Vec<_>>();
    if agents.iter().any(|agent| agent.is_default) {
        Ok(agents)
    } else {
        Err("OpenClaw did not report a default agent.".to_string())
    }
}

fn parse_shortcut(accelerator: &str) -> Result<Shortcut, String> {
    accelerator
        .parse::<Shortcut>()
        .map_err(|error| format!("Invalid shortcut \"{accelerator}\": {error}"))
}

fn validate_quickchat_shortcut(accelerator: &str) -> Result<Shortcut, String> {
    let shortcut = parse_shortcut(accelerator)?;
    let dashboard_shortcut = parse_shortcut(tray::GLOBAL_SHORTCUT)
        .expect("the built-in dashboard shortcut must be valid");
    if shortcut == dashboard_shortcut {
        return Err(format!(
            "Shortcut \"{accelerator}\" is reserved for Open Dashboard."
        ));
    }
    Ok(shortcut)
}

fn shortcut_preference_from_path(path: &Path) -> QuickChatShortcutPreference {
    let configured = fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(accelerator) = configured {
        if let Ok(shortcut) = validate_quickchat_shortcut(&accelerator) {
            return QuickChatShortcutPreference {
                accelerator,
                shortcut,
            };
        }
    }
    default_shortcut_preference()
}

fn default_shortcut_preference() -> QuickChatShortcutPreference {
    QuickChatShortcutPreference {
        accelerator: QUICKCHAT_SHORTCUT.to_string(),
        shortcut: parse_shortcut(QUICKCHAT_SHORTCUT)
            .expect("the built-in Quick Chat shortcut must be valid"),
    }
}

fn persist_shortcut_preference(path: &Path, accelerator: Option<&str>) -> std::io::Result<()> {
    match accelerator {
        Some(accelerator) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, accelerator.as_bytes())
        }
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        },
    }
}

fn quickchat_config_file(
    app: &impl Manager<tauri::Wry>,
    filename: &str,
) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(filename))
        .map_err(|error| format!("Could not resolve Quick Chat preference path: {error}"))
}

pub(crate) fn load_shortcut_preference(
    app: &impl Manager<tauri::Wry>,
) -> QuickChatShortcutPreference {
    match quickchat_config_file(app, QUICKCHAT_SHORTCUT_FILE) {
        Ok(path) => shortcut_preference_from_path(&path),
        Err(error) => {
            eprintln!("{error}");
            default_shortcut_preference()
        }
    }
}

fn quickchat_shortcut_disabled_marker(app: &impl Manager<tauri::Wry>) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(path) => Some(path.join(QUICKCHAT_SHORTCUT_DISABLED_MARKER)),
        Err(error) => {
            eprintln!("Could not resolve Quick Chat shortcut preference path: {error}");
            None
        }
    }
}

pub(crate) fn quickchat_shortcut_marker_exists(path: &Path) -> bool {
    match path.try_exists() {
        Ok(exists) => exists,
        Err(error) => {
            eprintln!("Could not read Quick Chat shortcut preference: {error}");
            false
        }
    }
}

pub(crate) fn quickchat_shortcut_enabled(app: &impl Manager<tauri::Wry>) -> bool {
    !quickchat_shortcut_disabled_marker(app)
        .as_deref()
        .is_some_and(quickchat_shortcut_marker_exists)
}

pub(crate) fn persist_quickchat_shortcut_state(app: &AppHandle, registered: bool) {
    let Some(marker) = quickchat_shortcut_disabled_marker(app) else {
        return;
    };
    let result = if registered {
        match fs::remove_file(&marker) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    } else {
        marker
            .parent()
            .map(fs::create_dir_all)
            .transpose()
            .and_then(|_| fs::write(&marker, b""))
    };
    if let Err(error) = result {
        eprintln!("Could not persist Quick Chat shortcut preference: {error}");
    }
}

pub fn quickchat_position(
    monitor_pos: (f64, f64),
    monitor_size: (f64, f64),
    window_size: (f64, f64),
) -> (f64, f64) {
    let max_x = monitor_pos.0 + (monitor_size.0 - window_size.0).max(0.0);
    let max_y = monitor_pos.1 + (monitor_size.1 - window_size.1).max(0.0);
    let x = monitor_pos.0 + (monitor_size.0 - window_size.0).max(0.0) / 2.0;
    let y = monitor_pos.1 + monitor_size.1 * 0.22;
    (x.clamp(monitor_pos.0, max_x), y.clamp(monitor_pos.1, max_y))
}

fn ensure_quickchat_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(QUICKCHAT_LABEL) {
        app.state::<GatewayClient>().activate(app.clone());
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        QUICKCHAT_LABEL,
        WebviewUrl::App("quickchat.html".into()),
    )
    .title("Quick Chat")
    .inner_size(QUICKCHAT_WIDTH, QUICKCHAT_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .build()
    .map_err(|error| format!("Could not create Quick Chat window: {error}"))?;
    app.state::<GatewayClient>().activate(app.clone());
    Ok(window)
}

fn position_quickchat(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .ok_or_else(|| "Could not determine a monitor for Quick Chat.".to_string())?;
    let work_area = monitor.work_area();
    let window_size = window
        .inner_size()
        .map_err(|error| format!("Could not read Quick Chat size: {error}"))?;
    let (x, y) = quickchat_position(
        (work_area.position.x as f64, work_area.position.y as f64),
        (work_area.size.width as f64, work_area.size.height as f64),
        (window_size.width as f64, window_size.height as f64),
    );
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|error| format!("Could not position Quick Chat: {error}"))
}

pub fn request_hide(app: &AppHandle) {
    app.state::<QuickChatState>()
        .hide_requested
        .store(true, Ordering::SeqCst);
    let _ = app.emit_to(QUICKCHAT_LABEL, "quickchat:hide-requested", ());
}

pub fn toggle_quickchat(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICKCHAT_LABEL) {
        if window.is_visible().unwrap_or(false) {
            request_hide(app);
            return;
        }
    }
    if let Err(error) = show_quickchat(app) {
        eprintln!("Quick Chat unavailable: {error}");
    }
}

fn show_quickchat(app: &AppHandle) -> Result<(), String> {
    let window = ensure_quickchat_window(app)?;
    app.state::<GatewayClient>().resume_reconnect();
    window
        .set_size(LogicalSize::new(QUICKCHAT_WIDTH, QUICKCHAT_HEIGHT))
        .map_err(|error| format!("Could not reset Quick Chat size: {error}"))?;
    position_quickchat(app, &window)?;
    app.state::<QuickChatState>()
        .hide_requested
        .store(false, Ordering::SeqCst);
    window
        .show()
        .map_err(|error| format!("Could not show Quick Chat: {error}"))?;
    if let Err(error) = window.set_focus() {
        // X11 focus-stealing prevention can reject the focus grab; retract the bar
        // instead of leaving an unfocusable always-on-top window on screen. If even
        // hide fails, destroy the window rather than strand it; the next toggle rebuilds.
        app.state::<QuickChatState>()
            .hide_requested
            .store(true, Ordering::SeqCst);
        if window.hide().is_err() {
            let _ = window.destroy();
        }
        return Err(format!("Could not focus Quick Chat: {error}"));
    }
    window
        .emit("quickchat:shown", ())
        .map_err(|error| format!("Could not activate Quick Chat: {error}"))
}

fn require_quickchat_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == QUICKCHAT_LABEL {
        Ok(())
    } else {
        Err("Quick Chat command is available only to the Quick Chat window.".to_string())
    }
}

#[tauri::command]
pub async fn quickchat_agents(
    window: WebviewWindow,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
) -> Result<Vec<QuickChatAgent>, String> {
    require_quickchat_window(&window)?;
    state.agents(gateway.inner()).await
}

#[tauri::command]
pub async fn quickchat_identity(
    window: WebviewWindow,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
) -> Result<QuickChatAgent, String> {
    require_quickchat_window(&window)?;
    state
        .selected_agent(gateway.inner(), MissingSelection::FallBackToDefault)
        .await
        .map(|(agent, _)| agent)
}

#[tauri::command]
pub async fn quickchat_select_agent(
    window: WebviewWindow,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
    agent_id: String,
) -> Result<QuickChatAgent, String> {
    require_quickchat_window(&window)?;
    state.select_agent(gateway.inner(), &agent_id).await
}

#[tauri::command]
pub async fn quickchat_send(
    window: WebviewWindow,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
    message: String,
) -> Result<ChatSendResult, String> {
    require_quickchat_window(&window)?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Message cannot be empty.".to_string());
    }
    // Strict resolution: a vanished pin fails instead of silently rerouting to default.
    let (agent, catalog) = state
        .selected_agent(gateway.inner(), MissingSelection::Fail)
        .await?;
    let idempotency_key =
        state.send_idempotency_key(&message, &agent.id, &catalog.scope, &catalog.main_key)?;
    let result = gateway
        .chat_send(
            message,
            &agent.id,
            &catalog.scope,
            &catalog.main_key,
            &idempotency_key,
        )
        .await;
    if result.is_ok() {
        state.clear_send_retry(&idempotency_key);
    }
    result
}

#[tauri::command]
pub fn quickchat_shortcut(
    window: WebviewWindow,
    state: State<'_, QuickChatState>,
) -> Result<QuickChatShortcutStatus, String> {
    require_quickchat_window(&window)?;
    state.shortcut_status()
}

#[tauri::command]
pub fn quickchat_set_shortcut(
    window: WebviewWindow,
    app: AppHandle,
    desktop: State<'_, DesktopState>,
    state: State<'_, QuickChatState>,
    accelerator: Option<String>,
) -> Result<QuickChatShortcutStatus, String> {
    require_quickchat_window(&window)?;
    if !state.shortcuts_supported {
        return state.shortcut_status();
    }

    let configured = accelerator.and_then(|value| non_empty(Some(value)));
    let candidate_accelerator = configured
        .clone()
        .unwrap_or_else(|| QUICKCHAT_SHORTCUT.to_string());
    let candidate = validate_quickchat_shortcut(&candidate_accelerator)?;
    let current = state.active_shortcut()?;
    let preference_path = quickchat_config_file(&app, QUICKCHAT_SHORTCUT_FILE)?;
    let manager = app.global_shortcut();
    let current_registered = manager.is_registered(current.shortcut);
    let should_register = quickchat_shortcut_enabled(&app);
    let candidate_already_registered = current.shortcut == candidate && current_registered;

    if !candidate_already_registered {
        manager.register(candidate).map_err(|error| {
            format!("Could not register shortcut \"{candidate_accelerator}\": {error}")
        })?;
    }
    if current.shortcut != candidate && current_registered {
        if let Err(error) = manager.unregister(current.shortcut) {
            let _ = manager.unregister(candidate);
            return Err(format!(
                "Could not replace shortcut \"{}\": {error}",
                current.accelerator
            ));
        }
    }
    if !should_register {
        if let Err(error) = manager.unregister(candidate) {
            if current.shortcut != candidate && current_registered {
                let _ = manager.register(current.shortcut);
            }
            return Err(format!(
                "Could not finish validating shortcut \"{candidate_accelerator}\": {error}"
            ));
        }
    }

    if let Err(error) = persist_shortcut_preference(&preference_path, configured.as_deref()) {
        if manager.is_registered(candidate) {
            let _ = manager.unregister(candidate);
        }
        if current_registered && !manager.is_registered(current.shortcut) {
            let _ = manager.register(current.shortcut);
        }
        return Err(format!("Could not save the Quick Chat shortcut: {error}"));
    }

    let registered = should_register && manager.is_registered(candidate);
    state.set_active_shortcut(candidate_accelerator, candidate, registered);
    desktop.set_quickchat_shortcut_checked(registered);
    state.shortcut_status()
}

#[tauri::command]
pub fn quickchat_set_expanded(window: WebviewWindow, expanded: bool) -> Result<(), String> {
    require_quickchat_window(&window)?;
    let height = if expanded {
        QUICKCHAT_EXPANDED_HEIGHT
    } else {
        QUICKCHAT_HEIGHT
    };
    window
        .set_size(LogicalSize::new(QUICKCHAT_WIDTH, height))
        .map_err(|error| format!("Could not resize Quick Chat: {error}"))?;
    position_quickchat(window.app_handle(), &window)
}

#[tauri::command]
pub fn quickchat_hide(window: WebviewWindow) -> Result<(), String> {
    require_quickchat_window(&window)?;
    window
        .app_handle()
        .state::<QuickChatState>()
        .hide_requested
        .store(true, Ordering::SeqCst);
    window
        .hide()
        .map_err(|error| format!("Could not hide Quick Chat: {error}"))?;
    let _ = window.set_size(LogicalSize::new(QUICKCHAT_WIDTH, QUICKCHAT_HEIGHT));
    Ok(())
}

#[tauri::command]
pub fn quickchat_ready(
    window: WebviewWindow,
    gateway: State<'_, GatewayClient>,
    state: State<'_, QuickChatState>,
) -> Result<bool, String> {
    require_quickchat_window(&window)?;
    gateway.emit_current_state(&window)?;
    Ok(!state.hide_requested.load(Ordering::SeqCst))
}

#[tauri::command]
pub fn quickchat_show_dashboard(
    window: WebviewWindow,
    app: AppHandle,
    desktop: State<'_, DesktopState>,
) -> Result<(), String> {
    require_quickchat_window(&window)?;
    tray::open_dashboard(&app, desktop.inner());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn assert_position(actual: (f64, f64), expected: (f64, f64)) {
        assert!((actual.0 - expected.0).abs() < 1e-9);
        assert!((actual.1 - expected.1).abs() < 1e-9);
    }

    fn test_agent(id: &str, is_default: bool) -> QuickChatAgent {
        QuickChatAgent {
            id: id.to_string(),
            name: id.to_string(),
            emoji: None,
            avatar_url: None,
            is_default,
        }
    }

    fn test_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "openclaw-quickchat-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn unchanged_failed_draft_reuses_idempotency_key() {
        let state = QuickChatState::new(true);
        let first = state
            .send_idempotency_key("hello", "main", "per-sender", "main")
            .expect("first key");
        let retry = state
            .send_idempotency_key("hello", "main", "per-sender", "main")
            .expect("retry key");
        let edited = state
            .send_idempotency_key("hello again", "main", "per-sender", "main")
            .expect("edited key");

        assert_eq!(first, retry);
        assert_ne!(first, edited);
        state.clear_send_retry(&edited);
        assert_ne!(
            state
                .send_idempotency_key("hello again", "main", "per-sender", "main")
                .expect("post-ack key"),
            edited
        );
    }

    #[test]
    fn position_centers_window_at_twenty_two_percent_of_work_area() {
        assert_position(
            quickchat_position((0.0, 0.0), (1920.0, 1080.0), (640.0, 92.0)),
            (640.0, 237.6),
        );
        assert_position(
            quickchat_position((-1280.0, 40.0), (1280.0, 984.0), (640.0, 92.0)),
            (-960.0, 256.48),
        );
    }

    #[test]
    fn position_stays_inside_small_work_area() {
        assert_eq!(
            quickchat_position((10.0, 20.0), (500.0, 80.0), (640.0, 92.0)),
            (10.0, 20.0)
        );
    }

    #[test]
    fn agents_use_identity_precedence_and_render_fields() {
        let catalog = AgentsListResult {
            default_id: "main".to_string(),
            main_key: "main".to_string(),
            scope: "per-sender".to_string(),
            agents: vec![
                crate::gateway_ws::GatewayAgentSummary {
                    id: "main".to_string(),
                    name: Some("Configured".to_string()),
                    identity: Some(crate::gateway_ws::GatewayAgentIdentity {
                        name: Some("Molty".to_string()),
                        emoji: Some("🦞".to_string()),
                        avatar_url: Some("data:image/png;base64,AA==".to_string()),
                    }),
                },
                crate::gateway_ws::GatewayAgentSummary {
                    id: "other".to_string(),
                    name: None,
                    identity: None,
                },
            ],
        };
        let agents = build_agents(&catalog).expect("agent list");

        assert_eq!(agents[0].name, "Molty");
        assert_eq!(agents[0].emoji.as_deref(), Some("🦞"));
        assert_eq!(
            agents[0].avatar_url.as_deref(),
            Some("data:image/png;base64,AA==")
        );
        assert_eq!(agents[1].name, "other");
    }

    #[test]
    fn shortcut_preference_round_trips_and_resets() {
        let directory = test_directory("shortcut-roundtrip");
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join(QUICKCHAT_SHORTCUT_FILE);

        persist_shortcut_preference(&path, Some("Ctrl+Alt+KeyK")).expect("write shortcut");
        let loaded = shortcut_preference_from_path(&path);
        assert_eq!(loaded.accelerator, "Ctrl+Alt+KeyK");
        assert!(loaded
            .shortcut
            .matches(loaded.shortcut.mods, loaded.shortcut.key));

        persist_shortcut_preference(&path, None).expect("reset shortcut");
        assert!(!path.exists());
        assert_eq!(
            shortcut_preference_from_path(&path).accelerator,
            QUICKCHAT_SHORTCUT
        );
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn invalid_shortcut_preference_falls_back_to_default() {
        let directory = test_directory("shortcut-fallback");
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join(QUICKCHAT_SHORTCUT_FILE);
        fs::write(&path, b"Ctrl+NotAKey").expect("write invalid shortcut");

        let loaded = shortcut_preference_from_path(&path);
        assert_eq!(loaded.accelerator, QUICKCHAT_SHORTCUT);
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn dashboard_shortcut_preference_falls_back_to_default() {
        let directory = test_directory("shortcut-reserved");
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join(QUICKCHAT_SHORTCUT_FILE);
        fs::write(&path, tray::GLOBAL_SHORTCUT).expect("write reserved shortcut");

        let loaded = shortcut_preference_from_path(&path);
        assert_eq!(loaded.accelerator, QUICKCHAT_SHORTCUT);
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn missing_pinned_agent_fails_sends_and_heals_identity() {
        let agents = [test_agent("main", true), test_agent("work", false)];

        let pinned = resolve_selected_agent(Some("work"), &agents, MissingSelection::Fail);
        assert_eq!(pinned.expect("pinned agent").id, "work");
        let gone = resolve_selected_agent(Some("gone"), &agents, MissingSelection::Fail);
        assert!(gone.is_err());
        let healed =
            resolve_selected_agent(Some("gone"), &agents, MissingSelection::FallBackToDefault);
        assert_eq!(healed.expect("default agent").id, "main");
    }

    #[test]
    fn shortcut_dispatch_matches_custom_accelerator() {
        let state = QuickChatState::new(true);
        let custom = parse_shortcut("Ctrl+Alt+KeyK").expect("custom shortcut");
        let default = parse_shortcut(QUICKCHAT_SHORTCUT).expect("default shortcut");
        state.set_active_shortcut("Ctrl+Alt+KeyK".to_string(), custom, true);

        assert!(state.matches_shortcut(&custom));
        assert!(!state.matches_shortcut(&default));
        state.set_shortcut_registered(false);
        assert!(!state.matches_shortcut(&custom));
    }
}
