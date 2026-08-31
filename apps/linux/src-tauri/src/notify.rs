use std::collections::VecDeque;
#[cfg(any(target_os = "macos", test))]
use std::path::Path;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};
use tauri_plugin_notifications::{NotificationsExt, PermissionState};

// One allocator owns every notification sent by this process, including legacy pairing/update notices.
pub(crate) fn next_notification_id() -> i32 {
    static NEXT_ID: OnceLock<AtomicI32> = OnceLock::new();
    // A fresh process does not deterministically reuse IDs of toasts left behind by a crash.
    NEXT_ID
        .get_or_init(|| AtomicI32::new(uuid::Uuid::new_v4().as_u128() as i32))
        .fetch_add(1, Ordering::Relaxed)
}

const LEGACY_NOTICE_LIMIT: usize = 128;
const LEGACY_NOTICE_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
struct LegacyNoticeIds(VecDeque<(i32, Instant)>);

impl LegacyNoticeIds {
    fn remember(&mut self, id: i32, now: Instant) {
        self.0
            .retain(|(_, created)| now.duration_since(*created) < LEGACY_NOTICE_LIFETIME);
        if self.0.len() == LEGACY_NOTICE_LIMIT {
            self.0.pop_front();
        }
        self.0.push_back((id, now));
    }

    fn take(&mut self, id: i32, now: Instant) -> bool {
        self.0
            .retain(|(_, created)| now.duration_since(*created) < LEGACY_NOTICE_LIFETIME);
        self.0
            .iter()
            .position(|(owned, _)| *owned == id)
            .and_then(|index| self.0.remove(index))
            .is_some()
    }
}

fn legacy_notice_ids() -> &'static Mutex<LegacyNoticeIds> {
    static IDS: OnceLock<Mutex<LegacyNoticeIds>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(LegacyNoticeIds::default()))
}

pub(crate) fn focus_legacy_notice(app: &AppHandle, id: i32) -> bool {
    let owned = legacy_notice_ids()
        .lock()
        .expect("legacy notification mutex poisoned")
        .take(id, Instant::now());
    if owned {
        crate::tray::show_window(app);
    }
    owned
}

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
        let id = next_notification_id();
        // A global platform click listener also exposes Open on pairing/update notices.
        // Only IDs emitted here may focus the app; they never carry a Gateway route.
        legacy_notice_ids()
            .lock()
            .expect("legacy notification mutex poisoned")
            .remember(id, Instant::now());
        if let Err(error) = notification
            .builder()
            .id(id)
            .title(title)
            .body(body)
            .show()
            .await
        {
            legacy_notice_ids()
                .lock()
                .expect("legacy notification mutex poisoned")
                .take(id, Instant::now());
            eprintln!("Could not show notification: {error}");
        }
    });
}

pub(crate) fn notifications_supported() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| {
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
    })
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
    use super::{
        is_macos_app_bundle_executable, LegacyNoticeIds, LEGACY_NOTICE_LIFETIME,
        LEGACY_NOTICE_LIMIT,
    };
    use std::path::Path;
    use std::time::Instant;

    #[test]
    fn legacy_clicks_require_a_live_emitted_id_and_are_consumed_once() {
        let mut ids = LegacyNoticeIds::default();
        let now = Instant::now();
        ids.remember(7, now);
        assert!(!ids.take(8, now));
        assert!(ids.take(7, now));
        assert!(!ids.take(7, now));
        ids.remember(9, now);
        assert!(!ids.take(9, now + LEGACY_NOTICE_LIFETIME));
        for id in 0..=LEGACY_NOTICE_LIMIT {
            ids.remember(id as i32, now);
        }
        assert!(!ids.take(0, now));
        assert!(ids.take(LEGACY_NOTICE_LIMIT as i32, now));
    }

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
