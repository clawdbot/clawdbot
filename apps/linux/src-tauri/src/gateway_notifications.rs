use crate::gateway_ws::GatewayClient;
use crate::{notify, tray};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_notifications::{NotificationsExt, PermissionState};
use tokio::sync::{mpsc, Notify};

const QUEUE_CAPACITY: usize = 64;
const MAX_ACTIVE: usize = 128;

#[derive(Clone)]
pub(crate) struct NotificationLease(Arc<LeaseInner>);

struct LeaseInner {
    active: AtomicBool,
    queue: mpsc::Sender<NotificationCommand>,
    retired: Notify,
    target: Url,
    sequence: Mutex<Option<u64>>,
    claims: Mutex<HashMap<String, Arc<NotificationClaim>>>,
    subscription: Mutex<Option<NotificationSubscription>>,
    app: AppHandle,
}

struct NotificationSubscription {
    permission_enabled: bool,
    preferences: Value,
}

enum NotificationCommand {
    Event(NotificationEvent, Arc<NotificationClaim>),
    Click(i32),
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum NotificationEvent {
    Show {
        id: String,
        category: NotificationCategory,
        title: String,
        body: String,
        path: String,
        #[serde(rename = "expiresAtMs")]
        expires_at_ms: u64,
        alert: bool,
    },
    Remove {
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum NotificationCategory {
    ApprovalRequested,
    AgentFinished,
    AgentQuestion,
    ScheduledTaskFailed,
    BackgroundTaskFailed,
}

struct NotificationClaim {
    active: AtomicBool,
    expires_at_ms: u64,
}

impl NotificationClaim {
    fn is_current(&self, now: u64) -> bool {
        self.active.load(Ordering::SeqCst) && self.expires_at_ms > now
    }

    fn cancel(&self) {
        self.active.store(false, Ordering::SeqCst);
    }
}

struct OwnedNotification {
    native_id: i32,
    url: Url,
    claim: Arc<NotificationClaim>,
}

impl NotificationLease {
    pub(crate) fn start(app: &AppHandle, target: Url) -> Result<Self, String> {
        let (queue, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let lease = Self(Arc::new(LeaseInner {
            active: AtomicBool::new(true),
            queue,
            retired: Notify::new(),
            target,
            sequence: Mutex::new(None),
            claims: Mutex::new(HashMap::new()),
            subscription: Mutex::new(None),
            app: app.clone(),
        }));
        let clicks = lease.clone();
        // The platform callback exists before subscribe can replay pending approvals.
        let listener = app
            .notifications()
            .on_notification_clicked(move |payload| {
                if let Some(id) = payload
                    .get("id")
                    .and_then(Value::as_i64)
                    .and_then(|id| i32::try_from(id).ok())
                {
                    if clicks.is_active() && notify::focus_legacy_notice(&clicks.0.app, id) {
                        return;
                    }
                    clicks.enqueue(NotificationCommand::Click(id));
                }
            })
            .map_err(|error| format!("Could not listen for notification clicks: {error}"))?;
        let worker = lease.clone();
        tauri::async_runtime::spawn(async move {
            let _listener = listener;
            worker.run(receiver).await;
        });
        Ok(lease)
    }

    pub(crate) fn subscribed(&self, permission_enabled: bool, preferences: Value) {
        *self
            .0
            .subscription
            .lock()
            .expect("notification subscription mutex poisoned") = Some(NotificationSubscription {
            permission_enabled,
            preferences,
        });
    }

    pub(crate) fn update_preferences(&self, preferences: Value) {
        if let Some(subscription) = self
            .0
            .subscription
            .lock()
            .expect("notification subscription mutex poisoned")
            .as_mut()
        {
            subscription.preferences = preferences;
        }
    }

    pub(crate) fn permission_enabled(&self) -> Option<bool> {
        self.0
            .subscription
            .lock()
            .ok()?
            .as_ref()
            .map(|subscription| subscription.permission_enabled)
    }

    pub(crate) fn preferences(&self) -> Option<Value> {
        self.0
            .subscription
            .lock()
            .ok()?
            .as_ref()
            .map(|subscription| subscription.preferences.clone())
    }

    pub(crate) fn is_active(&self) -> bool {
        self.0.active.load(Ordering::SeqCst)
    }

    pub(crate) fn is_same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    pub(crate) fn retire(&self) {
        self.0.active.store(false, Ordering::SeqCst);
        self.0.retired.notify_one();
    }

    pub(crate) fn accepts_url(&self, url: &Url) -> bool {
        self.is_active() && dashboard_contains(&self.0.target, url)
    }

    fn enqueue(&self, command: NotificationCommand) {
        if self.is_active() && self.0.queue.try_send(command).is_err() {
            self.fail(
                "Notification delivery fell behind. Reconnecting to refresh pending notifications.",
            );
        }
    }

    pub(crate) fn report_error(&self, message: &str) {
        let app = &self.0.app;
        let Some(revision) = app
            .state::<GatewayClient>()
            .record_notification_error(self, Some(message.to_string()))
        else {
            return;
        };
        eprintln!("{message}");
        let Some(webview) = app.get_webview("main") else {
            return;
        };
        if !webview.url().is_ok_and(|url| self.accepts_url(&url)) {
            return;
        }
        let message = serde_json::to_string(message).expect("notification error serialization");
        let origin = serde_json::to_string(&self.0.target.origin().ascii_serialization())
            .expect("origin serialization");
        let script = format!("if (location.origin === {origin} && (window.__OPENCLAW_NATIVE_NOTIFICATIONS_ERROR_REVISION__ ?? 0) <= {revision}) {{ window.__OPENCLAW_NATIVE_NOTIFICATIONS_ERROR_REVISION__ = {revision}; window.__OPENCLAW_NATIVE_NOTIFICATIONS__ = {{ ...(window.__OPENCLAW_NATIVE_NOTIFICATIONS__ ?? {{supported:true,permission:'unknown'}}), error:{message}, test:{{state:'error',message:{message}}} }}; delete window.__OPENCLAW_NATIVE_NOTIFICATIONS__.replyTo; window.dispatchEvent(new CustomEvent('openclaw:native-notifications-status', {{detail:window.__OPENCLAW_NATIVE_NOTIFICATIONS__}})); }}");
        let _ = webview.eval(&script);
    }

    fn fail(&self, message: &str) {
        self.report_error(message);
        self.retire();
    }

    pub(crate) fn dispatch(&self, frame: &Value) {
        if frame.get("type").and_then(Value::as_str) != Some("event") || !self.is_active() {
            return;
        }
        if let Some(next) = frame.get("seq").and_then(Value::as_u64) {
            let mut previous = self
                .0
                .sequence
                .lock()
                .expect("notification sequence mutex poisoned");
            if previous.is_some_and(|previous| next > previous + 1) {
                drop(previous);
                self.fail(
                    "Gateway events were missed. Reconnecting to refresh pending notifications.",
                );
                return;
            }
            *previous = Some(next);
        }
        if frame.get("event").and_then(Value::as_str) != Some("notification") {
            return;
        }
        let Some(payload) = frame.get("payload") else {
            return;
        };
        match serde_json::from_value(payload.clone()) {
            Ok(event) => {
                let id = match &event {
                    NotificationEvent::Show { id, .. } | NotificationEvent::Remove { id } => id,
                };
                if id.is_empty() || id.len() > 200 {
                    self.fail("The Gateway sent an invalid notification identifier.");
                    return;
                }
                let expires_at_ms = match &event {
                    NotificationEvent::Show { expires_at_ms, .. } => *expires_at_ms,
                    NotificationEvent::Remove { .. } => 0,
                };
                let claim = Arc::new(NotificationClaim {
                    active: AtomicBool::new(true),
                    expires_at_ms,
                });
                {
                    let mut claims = self
                        .0
                        .claims
                        .lock()
                        .expect("notification claims mutex poisoned");
                    if let Some(previous) = claims.remove(id) {
                        previous.cancel();
                    }
                    if matches!(event, NotificationEvent::Show { .. }) {
                        claims.insert(id.clone(), claim.clone());
                    }
                }
                self.enqueue(NotificationCommand::Event(event, claim));
            }
            Err(_) => {
                self.fail("The Gateway sent an invalid notification. Reconnect or update OpenClaw.")
            }
        }
    }

    async fn run(&self, mut receiver: mpsc::Receiver<NotificationCommand>) {
        let app = &self.0.app;
        let mut owned = HashMap::<String, OwnedNotification>::new();
        while self.is_active() {
            tokio::select! {
                _ = self.0.retired.notified() => break,
                command = receiver.recv() => {
                    let Some(command) = command else { break; };
                    if !self.is_active() { break; }
                    match command {
                        NotificationCommand::Click(id) => {
                            if let Some(item) = owned.values().find(|item| item.native_id == id) {
                                if item.claim.is_current(now_ms()) && self.is_active() {
                                    if let Some(webview) = app.get_webview("main") {
                                        // Captured route, not OS payload data, owns the click destination.
                                        if webview.url().is_ok_and(|url| self.accepts_url(&url)) {
                                            let _ = webview.navigate(item.url.clone());
                                            tray::show_window(app);
                                        }
                                    }
                                }
                            }
                        }
                        NotificationCommand::Event(event, claim) => self.apply(&mut owned, event, claim).await,
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            let expired: Vec<String> = owned
                .iter()
                .filter(|(_, item)| item.claim.expires_at_ms <= now_ms())
                .map(|(id, _)| id.clone())
                .collect();
            for id in expired {
                self.remove_owned(&mut owned, &id);
            }
        }
        self.0
            .claims
            .lock()
            .expect("notification claims mutex poisoned")
            .clear();
        // Serial with show(): late platform completions are removed before this lease exits.
        for item in owned.into_values() {
            remove_native(app, item.native_id);
        }
    }

    async fn apply(
        &self,
        owned: &mut HashMap<String, OwnedNotification>,
        event: NotificationEvent,
        claim: Arc<NotificationClaim>,
    ) {
        let app = &self.0.app;
        let NotificationEvent::Show {
            id,
            category: _category,
            title,
            body,
            path,
            expires_at_ms: _,
            alert,
        } = event
        else {
            if let NotificationEvent::Remove { id } = event {
                self.remove_owned(owned, &id);
            }
            return;
        };
        let Some(url) = notification_url(&self.0.target, &path) else {
            self.fail("The Gateway sent an unsafe notification destination.");
            return;
        };
        if title.chars().count() > 160 || body.chars().count() > 320 {
            self.fail("The Gateway sent an oversized notification.");
            return;
        }
        self.remove_owned(owned, &id);
        if !self.is_active() || !claim.is_current(now_ms()) {
            self.finish_claim(&id, &claim);
            return;
        }
        // The cross-platform backends cannot all guarantee list-only presentation.
        // Pending approvals remain visible in the Dashboard; reconnect never alerts again.
        if !alert {
            self.finish_claim(&id, &claim);
            return;
        }
        if owned.len() >= MAX_ACTIVE {
            if let Some(oldest) = owned
                .iter()
                .min_by_key(|(_, item)| item.claim.expires_at_ms)
                .map(|(id, _)| id.clone())
            {
                self.remove_owned(owned, &oldest);
            }
        }
        match app.notifications().permission_state().await {
            Ok(PermissionState::Granted) if self.is_active() && claim.is_current(now_ms()) => {}
            Ok(_) => {
                self.finish_claim(&id, &claim);
                return;
            }
            Err(error) => {
                self.fail(&format!("Could not read notification permission: {error}"));
                return;
            }
        }
        let native_id = notify::next_notification_id();
        let result = app
            .notifications()
            .builder()
            .id(native_id)
            .title(title)
            .body(body)
            .show()
            .await;
        // A resolution/replacement cancels the claim at ingress, even while an OS await
        // is in flight. Never retain or route a late notification for a closed approval.
        if !self.is_active() || !claim.is_current(now_ms()) {
            self.finish_claim(&id, &claim);
            remove_native(app, native_id);
            return;
        }
        match result {
            Ok(()) => {
                owned.insert(
                    id,
                    OwnedNotification {
                        native_id,
                        url,
                        claim,
                    },
                );
            }
            Err(error) => self.fail(&format!("Could not show Gateway notification: {error}")),
        }
    }
    fn finish_claim(&self, id: &str, claim: &Arc<NotificationClaim>) {
        claim.cancel();
        let mut claims = self
            .0
            .claims
            .lock()
            .expect("notification claims mutex poisoned");
        if claims
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, claim))
        {
            claims.remove(id);
        }
    }

    fn remove_owned(&self, owned: &mut HashMap<String, OwnedNotification>, id: &str) {
        if let Some(item) = owned.remove(id) {
            self.finish_claim(id, &item.claim);
            remove_native(&self.0.app, item.native_id);
        }
    }
}

fn remove_native(app: &AppHandle, id: i32) {
    if let Err(error) = app.notifications().remove_active(vec![id]) {
        eprintln!("Could not remove Gateway notification: {error}");
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn dashboard_contains(base: &Url, url: &Url) -> bool {
    let root = base.path().trim_end_matches('/');
    url.origin() == base.origin()
        && (root.is_empty() || url.path() == root || url.path().starts_with(&format!("{root}/")))
}

fn notification_url(base: &Url, path: &str) -> Option<Url> {
    if path.len() > 1024
        || !path.starts_with('/')
        || path.starts_with("//")
        || path
            .chars()
            .any(|character| character.is_control() || character == '\\')
    {
        return None;
    }
    // Gateway descriptors are app-relative. The native route owns its mount prefix.
    let mut mount = base.clone();
    mount.set_path(&format!("{}/", base.path().trim_end_matches('/')));
    mount.set_query(None);
    mount.set_fragment(None);
    let url = mount.join(&path[1..]).ok()?;
    (url.username().is_empty() && url.password().is_none() && dashboard_contains(base, &url))
        .then_some(url)
}

#[cfg(test)]
mod tests {
    use super::{dashboard_contains, notification_url, NotificationClaim, NotificationEvent};
    use serde_json::json;
    use std::sync::atomic::AtomicBool;
    use tauri::Url;

    #[test]
    fn notification_clicks_stay_inside_the_captured_dashboard() {
        let dashboard = Url::parse("https://gateway.example/openclaw/").unwrap();
        for route in [
            "/chat?session=agent%3Amain%3Amain",
            "/approve/approval-1",
            "/settings/notifications",
        ] {
            let url = notification_url(&dashboard, route).expect("app-relative notification route");
            assert!(url.path().starts_with("/openclaw/"), "{route}");
        }
        for route in [
            "//other.example/openclaw",
            "https://other.example/",
            "/../../",
            "/%2e%2e/",
            "/chat/../../",
            "/chat\\other",
            "/chat/\n",
        ] {
            assert!(notification_url(&dashboard, route).is_none(), "{route}");
        }
        assert!(!dashboard_contains(
            &dashboard,
            &Url::parse("https://other.example/openclaw/").unwrap()
        ));
        assert!(!dashboard_contains(
            &dashboard,
            &Url::parse("https://gateway.example/openclaw-other/").unwrap()
        ));
    }

    #[test]
    fn expired_or_cancelled_claims_cannot_resume_after_platform_awaits() {
        let claim = NotificationClaim {
            active: AtomicBool::new(true),
            expires_at_ms: 100,
        };
        assert!(claim.is_current(99));
        assert!(
            !claim.is_current(100),
            "expiry during permission lookup must prevent OS submission"
        );
        assert!(!claim.is_current(101));
        claim.cancel();
        assert!(
            !claim.is_current(99),
            "resolution must cancel an otherwise unexpired claim"
        );
    }

    #[test]
    fn notification_removal_is_scoped_to_an_id() {
        assert!(serde_json::from_value::<NotificationEvent>(
            json!({ "action": "remove", "id": "approval-1" })
        )
        .is_ok());
        assert!(serde_json::from_value::<NotificationEvent>(
            json!({ "action": "remove", "id": "approval-1", "removeAll": true })
        )
        .is_err());
    }
}
