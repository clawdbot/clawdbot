#[cfg(any(target_os = "macos", test))]
use std::path::Path;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notifications::{NotificationsExt, PermissionState};

pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    if notifications_supported() {
        builder.plugin(tauri_plugin_notifications::init())
    } else {
        eprintln!("Native notifications are unavailable outside a macOS app bundle");
        builder
    }
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    if !notifications_supported() {
        return;
    }
    let app = app.clone();
    let title = title.to_string();
    let body = body.to_string();
    tauri::async_runtime::spawn(async move {
        let notification = app.notifications();
        let permission = match notification.permission_state().await {
            Ok(PermissionState::Granted) => PermissionState::Granted,
            Ok(_) => match notification.request_permission().await {
                Ok(permission) => permission,
                Err(error) => {
                    eprintln!("Could not request notification permission: {error}");
                    return;
                }
            },
            Err(error) => {
                eprintln!("Could not check notification permission: {error}");
                return;
            }
        };
        if !matches!(permission, PermissionState::Granted) {
            return;
        }
        if let Err(error) = notification.builder().title(title).body(body).show().await {
            eprintln!("Could not show notification: {error}");
        }
    });
}

fn notifications_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::env::current_exe()
            .ok()
            .as_deref()
            .is_some_and(is_macos_app_bundle_executable)
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(any(target_os = "macos", test))]
fn is_macos_app_bundle_executable(executable: &Path) -> bool {
    let Some(macos) = executable.parent() else {
        return false;
    };
    let Some(contents) = macos.parent() else {
        return false;
    };
    let Some(bundle) = contents.parent() else {
        return false;
    };
    macos.file_name().is_some_and(|name| name == "MacOS")
        && contents.file_name().is_some_and(|name| name == "Contents")
        && bundle
            .extension()
            .is_some_and(|extension| extension == "app")
}

#[cfg(test)]
mod tests {
    use super::is_macos_app_bundle_executable;
    use std::path::Path;

    #[test]
    fn recognizes_only_executables_inside_macos_app_bundles() {
        assert!(is_macos_app_bundle_executable(Path::new(
            "/Applications/OpenClaw.app/Contents/MacOS/openclaw-desktop"
        )));
        assert!(!is_macos_app_bundle_executable(Path::new(
            "/tmp/OpenClaw/Contents/MacOS/openclaw-desktop"
        )));
        assert!(!is_macos_app_bundle_executable(Path::new(
            "/tmp/target/debug/openclaw-desktop"
        )));
    }
}
