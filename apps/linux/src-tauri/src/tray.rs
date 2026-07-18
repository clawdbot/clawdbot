use crate::gateway::{GatewayAction, GatewaySnapshot};
use crate::quickchat;
use crate::DesktopState;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

const OPEN_ID: &str = "open-dashboard";
const QUICKCHAT_ID: &str = "quickchat";
const CHECK_UPDATES_ID: &str = "check-for-updates";
const START_AT_LOGIN_ID: &str = "start-at-login";
const QUICKCHAT_SHORTCUT_ID: &str = "quickchat-shortcut";
const GLOBAL_SHORTCUT_ID: &str = "global-shortcut";
pub(crate) const GLOBAL_SHORTCUT: &str = "CmdOrCtrl+Shift+O";
// Marker presence is the durable user opt-out across restarts; no config schema on purpose.
const GLOBAL_SHORTCUT_DISABLED_MARKER: &str = "global-shortcut-disabled";
const START_ID: &str = "start-gateway";
const STOP_ID: &str = "stop-gateway";
const RESTART_ID: &str = "restart-gateway";
const QUIT_ID: &str = "quit";

pub struct TrayHandles {
    _tray: TrayIcon<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    status_line: Mutex<StatusLine>,
    _quickchat: MenuItem<tauri::Wry>,
    open: MenuItem<tauri::Wry>,
    _check_updates: MenuItem<tauri::Wry>,
    _start_at_login: CheckMenuItem<tauri::Wry>,
    quickchat_shortcut: Option<CheckMenuItem<tauri::Wry>>,
    _global_shortcut: Option<CheckMenuItem<tauri::Wry>>,
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
}

struct StatusLine {
    gateway: String,
    pending_count: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct ShortcutInitialState {
    should_register: bool,
    checked: bool,
}

fn shortcut_initial_state(marker_exists: bool) -> ShortcutInitialState {
    let enabled = !marker_exists;
    ShortcutInitialState {
        should_register: enabled,
        checked: enabled,
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_global_shortcuts_supported(
    session_type: Option<&str>,
    wayland_display: Option<&str>,
    display: Option<&str>,
) -> bool {
    session_type.is_some_and(|value| value.eq_ignore_ascii_case("x11"))
        || (wayland_display.is_none() && display.is_some())
}

pub fn global_shortcuts_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        let session_type = std::env::var("XDG_SESSION_TYPE").ok();
        let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
        let display = std::env::var("DISPLAY").ok();
        linux_global_shortcuts_supported(
            session_type.as_deref(),
            wayland_display.as_deref(),
            display.as_deref(),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

impl StatusLine {
    fn text(&self) -> String {
        match self.pending_count {
            0 => format!("Gateway: {}", self.gateway),
            1 => format!("Gateway: {} · 1 approval pending", self.gateway),
            count => format!("Gateway: {} · {count} approvals pending", self.gateway),
        }
    }
}

impl TrayHandles {
    pub fn update(&self, snapshot: &GatewaySnapshot) {
        let mut status_line = self.status_line.lock().expect("tray status mutex poisoned");
        status_line.gateway.clone_from(&snapshot.status);
        if !snapshot.reachable {
            status_line.pending_count = 0;
        }
        let _ = self.status.set_text(status_line.text());
        let _ = self.open.set_enabled(true);
        let _ = self
            .start
            .set_enabled(snapshot.installed && !snapshot.running && !snapshot.reachable);
        let _ = self
            .stop
            .set_enabled(snapshot.installed && snapshot.running);
        let _ = self.restart.set_enabled(snapshot.installed);
    }

    pub fn update_pending_count(&self, count: usize) {
        let mut status_line = self.status_line.lock().expect("tray status mutex poisoned");
        status_line.pending_count = count;
        let _ = self.status.set_text(status_line.text());
    }

    pub fn set_quickchat_shortcut_checked(&self, checked: bool) {
        if let Some(item) = self.quickchat_shortcut.as_ref() {
            set_quickchat_shortcut_checked(item, checked);
        }
    }
}

pub fn build(
    app: &App,
    state: DesktopState,
    global_shortcuts_supported: bool,
) -> tauri::Result<TrayHandles> {
    let status = MenuItem::with_id(
        app,
        "gateway-status",
        "Gateway: Checking…",
        false,
        None::<&str>,
    )?;
    let quickchat = MenuItem::with_id(app, QUICKCHAT_ID, "Quick Chat", true, None::<&str>)?;
    let open = MenuItem::with_id(app, OPEN_ID, "Open Dashboard", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(
        app,
        CHECK_UPDATES_ID,
        "Check for Updates",
        true,
        None::<&str>,
    )?;
    let autostart_enabled = match app.autolaunch().is_enabled() {
        Ok(enabled) => enabled,
        Err(error) => {
            eprintln!("Could not read autostart state: {error}");
            false
        }
    };
    let start_at_login = CheckMenuItem::with_id(
        app,
        START_AT_LOGIN_ID,
        "Start at Login",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let quickchat_shortcut_initial_state = global_shortcuts_supported
        .then(|| shortcut_initial_state(!quickchat::quickchat_shortcut_enabled(app)));
    let quickchat_shortcut = quickchat_shortcut_initial_state
        .as_ref()
        .map(|initial_state| {
            CheckMenuItem::with_id(
                app,
                QUICKCHAT_SHORTCUT_ID,
                "Quick Chat shortcut",
                true,
                initial_state.checked,
                None::<&str>,
            )
        })
        .transpose()?;
    let global_shortcut_initial_state = global_shortcuts_supported.then(|| {
        let shortcut_marker = global_shortcut_disabled_marker(app);
        shortcut_initial_state(
            shortcut_marker
                .as_deref()
                .is_some_and(global_shortcut_marker_exists),
        )
    });
    let global_shortcut = global_shortcut_initial_state
        .as_ref()
        .map(|initial_state| {
            CheckMenuItem::with_id(
                app,
                GLOBAL_SHORTCUT_ID,
                "Enable Global Shortcut",
                true,
                initial_state.checked,
                None::<&str>,
            )
        })
        .transpose()?;
    let start = MenuItem::with_id(app, START_ID, "Start Gateway", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, STOP_ID, "Stop Gateway", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, RESTART_ID, "Restart Gateway", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit OpenClaw", true, None::<&str>)?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let separator_three = PredefinedMenuItem::separator(app)?;
    let menu_builder = MenuBuilder::new(app).items(&[
        &status,
        &separator_one,
        &quickchat,
        &open,
        &check_updates,
        &start_at_login,
    ]);
    let menu_builder = if let Some(quickchat_shortcut) = quickchat_shortcut.as_ref() {
        menu_builder.item(quickchat_shortcut)
    } else {
        menu_builder
    };
    let menu_builder = if let Some(global_shortcut) = global_shortcut.as_ref() {
        menu_builder.item(global_shortcut)
    } else {
        menu_builder
    };
    let menu = menu_builder
        .items(&[
            &separator_two,
            &start,
            &stop,
            &restart,
            &separator_three,
            &quit,
        ])
        .build()?;

    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    let menu_state = state.clone();
    let menu_start_at_login = start_at_login.clone();
    let menu_quickchat_shortcut = quickchat_shortcut.clone();
    let menu_global_shortcut = global_shortcut.clone();
    let tray_builder = TrayIconBuilder::with_id("openclaw-main")
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            handle_menu(
                app,
                &menu_state,
                &menu_start_at_login,
                menu_quickchat_shortcut.as_ref(),
                menu_global_shortcut.as_ref(),
                event.id().as_ref(),
            );
        })
        // Linux tray backends expose the Open action through the menu; Tauri also
        // emits this direct click event on platforms that support it.
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_window(tray.app_handle());
            }
        });
    #[cfg(target_os = "macos")]
    let tray_builder = tray_builder.icon_as_template(true);
    let tray = tray_builder.build(app)?;
    let quickchat_preference = quickchat::load_shortcut_preference(app);
    let quickchat_state = app.state::<quickchat::QuickChatState>();
    quickchat_state.set_active_shortcut(
        quickchat_preference.accelerator.clone(),
        quickchat_preference.shortcut,
        false,
    );
    if let (Some(initial_state), Some(quickchat_shortcut)) = (
        quickchat_shortcut_initial_state,
        quickchat_shortcut.as_ref(),
    ) {
        if initial_state.should_register {
            if let Err(error) = app
                .global_shortcut()
                .register(quickchat_preference.shortcut)
            {
                eprintln!(
                    "Could not register Quick Chat shortcut {}: {error}",
                    quickchat_preference.accelerator
                );
                set_quickchat_shortcut_checked(quickchat_shortcut, false);
            } else {
                quickchat_state.set_shortcut_registered(true);
            }
        }
    }
    if let (Some(initial_state), Some(global_shortcut)) =
        (global_shortcut_initial_state, global_shortcut.as_ref())
    {
        if initial_state.should_register {
            if let Err(error) = app.global_shortcut().register(GLOBAL_SHORTCUT) {
                eprintln!("Could not register global shortcut {GLOBAL_SHORTCUT}: {error}");
                set_global_shortcut_checked(global_shortcut, false);
            }
        }
    }

    Ok(TrayHandles {
        _tray: tray,
        status,
        status_line: Mutex::new(StatusLine {
            gateway: "Checking…".to_string(),
            pending_count: 0,
        }),
        _quickchat: quickchat,
        open,
        _check_updates: check_updates,
        _start_at_login: start_at_login,
        quickchat_shortcut,
        _global_shortcut: global_shortcut,
        start,
        stop,
        restart,
    })
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn open_dashboard(app: &AppHandle, state: &DesktopState) {
    show_window(app);
    spawn_connect(app.clone(), state.clone());
}

fn handle_menu(
    app: &AppHandle,
    state: &DesktopState,
    start_at_login: &CheckMenuItem<tauri::Wry>,
    quickchat_shortcut: Option<&CheckMenuItem<tauri::Wry>>,
    global_shortcut: Option<&CheckMenuItem<tauri::Wry>>,
    id: &str,
) {
    match id {
        QUIT_ID => {
            state.quit();
            app.exit(0);
        }
        QUICKCHAT_ID => quickchat::toggle_quickchat(app),
        OPEN_ID => open_dashboard(app, state),
        CHECK_UPDATES_ID => {
            show_window(app);
            crate::updater::spawn_check(app.clone());
        }
        START_AT_LOGIN_ID => toggle_autostart(app, start_at_login),
        QUICKCHAT_SHORTCUT_ID => {
            if let Some(quickchat_shortcut) = quickchat_shortcut {
                toggle_quickchat_shortcut(app, quickchat_shortcut);
            }
        }
        GLOBAL_SHORTCUT_ID => {
            if let Some(global_shortcut) = global_shortcut {
                toggle_global_shortcut(app, global_shortcut);
            }
        }
        START_ID => spawn_action(app.clone(), state.clone(), GatewayAction::Start),
        STOP_ID => spawn_action(app.clone(), state.clone(), GatewayAction::Stop),
        RESTART_ID => spawn_action(app.clone(), state.clone(), GatewayAction::Restart),
        _ => {}
    }
}

fn toggle_quickchat_shortcut(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let state = app.state::<quickchat::QuickChatState>();
    let Some(shortcut) = state.shortcut() else {
        eprintln!("Could not read Quick Chat shortcut state");
        return;
    };
    let manager = app.global_shortcut();
    let enabled = manager.is_registered(shortcut);
    let next = !enabled;
    let result = if next {
        manager.register(shortcut)
    } else {
        manager.unregister(shortcut)
    };
    match result {
        Ok(()) => {
            let registered = manager.is_registered(shortcut);
            quickchat::persist_quickchat_shortcut_state(app, registered);
            state.set_shortcut_registered(registered);
            set_quickchat_shortcut_checked(item, registered);
        }
        Err(error) => {
            eprintln!("Could not update Quick Chat shortcut: {error}");
            set_quickchat_shortcut_checked(item, enabled);
        }
    }
}

fn toggle_global_shortcut(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let manager = app.global_shortcut();
    let enabled = manager.is_registered(GLOBAL_SHORTCUT);
    let next = !enabled;
    let result = if next {
        manager.register(GLOBAL_SHORTCUT)
    } else {
        manager.unregister(GLOBAL_SHORTCUT)
    };
    match result {
        Ok(()) => {
            let registered = manager.is_registered(GLOBAL_SHORTCUT);
            persist_global_shortcut_state(app, registered);
            set_global_shortcut_checked(item, registered);
        }
        Err(error) => {
            eprintln!("Could not update global shortcut {GLOBAL_SHORTCUT}: {error}");
            set_global_shortcut_checked(item, enabled);
        }
    }
}

fn global_shortcut_disabled_marker(app: &impl Manager<tauri::Wry>) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(path) => Some(path.join(GLOBAL_SHORTCUT_DISABLED_MARKER)),
        Err(error) => {
            eprintln!("Could not resolve global shortcut preference path: {error}");
            None
        }
    }
}

fn global_shortcut_marker_exists(path: &Path) -> bool {
    match path.try_exists() {
        Ok(exists) => exists,
        Err(error) => {
            eprintln!("Could not read global shortcut preference: {error}");
            false
        }
    }
}

fn persist_global_shortcut_state(app: &AppHandle, registered: bool) {
    let Some(marker) = global_shortcut_disabled_marker(app) else {
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
        eprintln!("Could not persist global shortcut preference: {error}");
    }
}

fn set_global_shortcut_checked(item: &CheckMenuItem<tauri::Wry>, checked: bool) {
    if let Err(error) = item.set_checked(checked) {
        eprintln!("Could not update global shortcut menu state: {error}");
    }
}

fn set_quickchat_shortcut_checked(item: &CheckMenuItem<tauri::Wry>, checked: bool) {
    if let Err(error) = item.set_checked(checked) {
        eprintln!("Could not update Quick Chat shortcut menu state: {error}");
    }
}

fn toggle_autostart(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let manager = app.autolaunch();
    let enabled = match manager.is_enabled() {
        Ok(enabled) => enabled,
        Err(error) => {
            eprintln!("Could not read autostart state: {error}");
            return;
        }
    };
    let next = !enabled;
    let result = if next {
        manager.enable()
    } else {
        manager.disable()
    };
    match result {
        Ok(()) => {
            let _ = item.set_checked(next);
        }
        Err(error) => {
            eprintln!("Could not update autostart state: {error}");
            let _ = item.set_checked(enabled);
        }
    }
}

fn spawn_connect(app: AppHandle, state: DesktopState) {
    std::thread::spawn(move || {
        if let Err(error) = state.connect_explicit_local(&app) {
            state.show_error(&app, &error);
        }
    });
}

fn spawn_action(app: AppHandle, state: DesktopState, action: GatewayAction) {
    std::thread::spawn(move || {
        if let Err(error) = state.gateway_action(&app, action) {
            state.show_error(&app, &error);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn linux_shortcut_support_follows_x11_session_facts() {
        assert!(linux_global_shortcuts_supported(
            Some("x11"),
            Some("wayland-0"),
            Some(":0"),
        ));
        assert!(linux_global_shortcuts_supported(None, None, Some(":0")));
        assert!(!linux_global_shortcuts_supported(
            Some("wayland"),
            Some("wayland-0"),
            Some(":0"),
        ));
        assert!(!linux_global_shortcuts_supported(
            None,
            Some("wayland-0"),
            Some(":0"),
        ));
        assert!(!linux_global_shortcuts_supported(None, None, None));
    }

    #[test]
    fn global_shortcut_marker_disables_startup_registration() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "openclaw-global-shortcut-test-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let marker = directory.join(GLOBAL_SHORTCUT_DISABLED_MARKER);

        assert_eq!(
            shortcut_initial_state(marker.exists()),
            ShortcutInitialState {
                should_register: true,
                checked: true,
            }
        );
        fs::write(&marker, b"").expect("write opt-out marker");
        assert_eq!(
            shortcut_initial_state(marker.exists()),
            ShortcutInitialState {
                should_register: false,
                checked: false,
            }
        );

        fs::remove_dir_all(directory).expect("remove test directory");
    }
}
