use crate::gateway::{GatewayAction, GatewaySnapshot};
use crate::DesktopState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

const OPEN_ID: &str = "open-dashboard";
const START_ID: &str = "start-gateway";
const STOP_ID: &str = "stop-gateway";
const RESTART_ID: &str = "restart-gateway";
const QUIT_ID: &str = "quit";

pub struct TrayHandles {
    _tray: TrayIcon<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    open: MenuItem<tauri::Wry>,
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
}

impl TrayHandles {
    pub fn update(&self, snapshot: &GatewaySnapshot) {
        let _ = self
            .status
            .set_text(format!("Gateway: {}", snapshot.status));
        let _ = self.open.set_enabled(true);
        let _ = self
            .start
            .set_enabled(snapshot.installed && !snapshot.running && !snapshot.reachable);
        let _ = self
            .stop
            .set_enabled(snapshot.installed && snapshot.running);
        let _ = self.restart.set_enabled(snapshot.installed);
    }
}

pub fn build(app: &App, state: DesktopState) -> tauri::Result<TrayHandles> {
    let status = MenuItem::with_id(
        app,
        "gateway-status",
        "Gateway: Checking…",
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, OPEN_ID, "Open Dashboard", true, None::<&str>)?;
    let start = MenuItem::with_id(app, START_ID, "Start Gateway", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, STOP_ID, "Stop Gateway", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, RESTART_ID, "Restart Gateway", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit OpenClaw", true, None::<&str>)?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &separator_one,
            &open,
            &start,
            &stop,
            &restart,
            &separator_two,
            &quit,
        ],
    )?;

    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    let menu_state = state.clone();
    let tray_builder = TrayIconBuilder::with_id("openclaw-main")
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            handle_menu(app, &menu_state, event.id().as_ref());
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

    Ok(TrayHandles {
        _tray: tray,
        status,
        open,
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

fn handle_menu(app: &AppHandle, state: &DesktopState, id: &str) {
    match id {
        QUIT_ID => {
            state.quit();
            app.exit(0);
        }
        OPEN_ID => {
            show_window(app);
            spawn_connect(app.clone(), state.clone());
        }
        START_ID => spawn_action(app.clone(), state.clone(), GatewayAction::Start),
        STOP_ID => spawn_action(app.clone(), state.clone(), GatewayAction::Stop),
        RESTART_ID => spawn_action(app.clone(), state.clone(), GatewayAction::Restart),
        _ => {}
    }
}

fn spawn_connect(app: AppHandle, state: DesktopState) {
    std::thread::spawn(move || {
        if let Err(error) = state.connect(&app) {
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
