use crate::gateway_notifications::{dashboard_contains, NotificationLease};
use crate::gateway_notifications_document::{BridgeDocument, BridgeView};
use crate::gateway_ws::GatewayClient;
use crate::notify;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_notifications::{NotificationsExt, PermissionState};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_opener::OpenerExt;

// Bound transport independently of the Gateway's canonical preference-value limit.
const MAX_BRIDGE_MESSAGE_BYTES: usize = 32 * 1024;

// This exposes only notification settings, never Tauri IPC or a renderer-selected Gateway.
// Rust admits each request against the currently configured native Dashboard route.
pub(crate) const BRIDGE_SCRIPT: &str = r#"(() => {
  if (window.top !== window) return;
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const pending = new Map();
  const reject = (message, error) => {
    const snapshot = { ...(window.__OPENCLAW_NATIVE_NOTIFICATIONS__ ?? { supported:true, permission:'unknown' }),
      replyTo:message.requestId, error,
      ...(message.type === 'send-test' ? {test:{state:'error',message:error}} : {}) };
    window.__OPENCLAW_NATIVE_NOTIFICATIONS__ = snapshot;
    window.dispatchEvent(new CustomEvent('openclaw:native-notifications-status', { detail:snapshot }));
  };
  Object.defineProperty(window, '__OPENCLAW_NATIVE_NOTIFICATIONS_DOCUMENT__', { value: documentId });
  Object.defineProperty(window, '__OPENCLAW_NATIVE_NOTIFICATIONS_ADMIT__', { value: (request, acknowledgeDocument = null) => {
    const entry = pending.get(request);
    if (!entry) return null;
    if (acknowledgeDocument !== null) {
      if (acknowledgeDocument !== documentId || !entry.claimed) return false;
      clearTimeout(entry.timer);
      pending.delete(request);
      return true;
    }
    if (entry.claimed) return null;
    entry.claimed = true;
    return [documentId, entry.payload];
  }});
  Object.defineProperty(window, '__OPENCLAW_NATIVE_NOTIFICATIONS_BRIDGE__', { value: {
    postMessage(message) {
      const payload = JSON.stringify(message);
      if (new TextEncoder().encode(payload).length > 32768) {
        reject(message, 'Notification settings are too large. Reduce the selected agents or shorten the device label.');
        return;
      }
      if (pending.has(message.requestId)) return;
      if (pending.size >= 32) {
        reject(message, 'Too many notification requests. Wait a moment and try again.');
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(message.requestId);
        reject(message, 'Could not authorize notification settings. Reload the Dashboard and try again.');
      }, 10000);
      pending.set(message.requestId, {payload, timer, claimed:false});
      location.href = 'openclaw-notifications://request?request=' + encodeURIComponent(message.requestId);
    }
  }});
})();"#;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum BridgeAction {
    Status {},
    RequestPermission {},
    SendTest {},
    PreferencesGet {},
    PreferencesSet {
        scope: PreferenceScope,
        preferences: Value,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum PreferenceScope {
    User,
    Device,
}

fn decode_bridge_action(raw: &str, request_id: &str) -> Result<BridgeAction, String> {
    if raw.len() > MAX_BRIDGE_MESSAGE_BYTES {
        return Err("Notification settings are too large. Reduce the selected agents or shorten the device label.".to_string());
    }
    let mut message: Value = serde_json::from_str(raw)
        .map_err(|_| "Invalid notification request. Reload the Dashboard.".to_string())?;
    let embedded_id = message
        .as_object_mut()
        .and_then(|message| message.remove("requestId"));
    if embedded_id.as_ref().and_then(Value::as_str) != Some(request_id) {
        return Err("Notification request identity changed. Reload the Dashboard.".to_string());
    }
    serde_json::from_value(message)
        .map_err(|_| "Unknown notification request. Reload the Dashboard.".to_string())
}

pub(crate) fn intercept_navigation(app: &AppHandle, view: &Arc<BridgeView>, target: &Url) -> bool {
    if target.scheme() != "openclaw-notifications" {
        return false;
    }
    let Some(webview) = app.get_webview("main") else {
        return true;
    };
    let gateway = app.state::<GatewayClient>().inner().clone();
    let Some((generation, dashboard)) = gateway.notification_target() else {
        return true;
    };
    if !webview
        .url()
        .is_ok_and(|url| dashboard_contains(&dashboard, &url))
    {
        return true;
    }
    let Some((_, request_id)) = target.query_pairs().find(|(key, _)| key == "request") else {
        return true;
    };
    if target.host_str() != Some("request") || request_id.is_empty() || request_id.len() > 64 {
        return true;
    }
    let lease = gateway.notification_lease();
    let request_id = request_id.into_owned();
    // The URL only wakes the bridge. Its payload and document come from the
    // current top frame's private queue, never from a navigating child frame.
    let admission = view.admit(webview, request_id.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some((document, message)) = admission.await else {
            return;
        };
        gateway.register_notification_document(generation, document.clone());
        respond_to_bridge(
            &app,
            gateway,
            generation,
            dashboard,
            document,
            lease,
            decode_bridge_action(&message, &request_id),
            Some(request_id),
        );
    });
    true
}

pub(crate) fn refresh_status(app: &AppHandle) {
    let gateway = app.state::<GatewayClient>().inner().clone();
    let Some((generation, dashboard)) = gateway.notification_target() else {
        return;
    };
    let Some((document_generation, document)) = gateway.notification_document() else {
        return;
    };
    if document_generation != generation {
        return;
    }
    let lease = gateway.notification_lease();
    respond_to_bridge(
        app,
        gateway,
        generation,
        dashboard,
        document,
        lease,
        Ok(BridgeAction::Status {}),
        None,
    );
}

fn respond_to_bridge(
    app: &AppHandle,
    gateway: GatewayClient,
    generation: u64,
    dashboard: Url,
    document: BridgeDocument,
    lease: Option<NotificationLease>,
    action: Result<BridgeAction, String>,
    reply_to: Option<String>,
) {
    let send_test = matches!(action, Ok(BridgeAction::SendTest {}));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut snapshot = json!({ "supported": notify::notifications_supported() && gateway.notifications_supported(), "permission": "unknown" });
        if let Some(reply_to) = reply_to {
            snapshot["replyTo"] = json!(reply_to);
        }
        let result = match action {
            Ok(action) => {
                handle_bridge(
                    &app,
                    &gateway,
                    generation,
                    &document,
                    lease,
                    action,
                    &mut snapshot,
                )
                .await
            }
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            snapshot["error"] = Value::String(error.clone());
            if send_test {
                snapshot["test"] = json!({ "state": "error", "message": error });
            }
        }
        // Platform delivery runs independently of the RPC acknowledgement. A later ack
        // must never erase the authoritative error recorded by that platform operation.
        let (error_revision, error) = gateway.notification_error();
        snapshot["supported"] =
            json!(notify::notifications_supported() && gateway.notifications_supported());
        if let Some(error) = error {
            snapshot["error"] = Value::String(error.clone());
            if send_test {
                snapshot["test"] = json!({ "state": "error", "message": error });
            }
        }
        publish_snapshot(
            &app,
            &gateway,
            generation,
            &dashboard,
            &document,
            error_revision,
            snapshot,
        );
    });
}

async fn handle_bridge(
    app: &AppHandle,
    gateway: &GatewayClient,
    generation: u64,
    document: &BridgeDocument,
    lease: Option<NotificationLease>,
    action: BridgeAction,
    snapshot: &mut Value,
) -> Result<(), String> {
    if !document.is_current()
        || !gateway
            .notification_target()
            .is_some_and(|(current, _)| current == generation)
    {
        return Err("The Dashboard changed. Reload notification settings.".to_string());
    }
    if !notify::notifications_supported() {
        return Err(
            "Native notifications require an installed, signed application bundle.".to_string(),
        );
    }
    let send_test = matches!(action, BridgeAction::SendTest {});
    if send_test || matches!(action, BridgeAction::RequestPermission {}) {
        if let Some(lease) = lease.as_ref() {
            gateway.record_notification_error(lease, None);
        }
    }
    let permission = if gateway.notifications_supported()
        && matches!(action, BridgeAction::RequestPermission {})
    {
        app.notifications().request_permission().await
    } else {
        app.notifications().permission_state().await
    }
    .map_err(|error| format!("Could not read notification permission: {error}"))?;
    let granted = matches!(permission, PermissionState::Granted);
    snapshot["permission"] = json!(match permission {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        _ => "notDetermined",
    });
    if !document.is_current()
        || !gateway
            .notification_target()
            .is_some_and(|(current, _)| current == generation)
    {
        return Err("The Gateway changed. Reload notification settings.".to_string());
    }
    if !gateway.notifications_supported() {
        return Err("Update the Gateway to use native notification preferences.".to_string());
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if matches!(action, BridgeAction::RequestPermission {})
        && matches!(permission, PermissionState::Denied)
    {
        // Denied permissions cannot prompt again. Only the explicit Settings action
        // opens the OS page; background status checks remain noninteractive.
        #[cfg(target_os = "macos")]
        let settings_url = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
        #[cfg(target_os = "windows")]
        let settings_url = "ms-settings:notifications";
        app.opener()
            .open_url(settings_url, None::<&str>)
            .map_err(|error| {
                format!(
                    "Could not open notification settings. Open System Settings manually: {error}"
                )
            })?;
    }
    let lease = lease.filter(NotificationLease::is_active).ok_or_else(|| {
        "The Gateway is disconnected. Reconnect to manage notifications.".to_string()
    })?;
    if send_test && !granted {
        return Err("Enable notifications in system settings before sending a test.".to_string());
    }
    if lease.permission_enabled() != Some(granted) {
        let preferences = gateway
            .notification_request(
                lease.clone(),
                document.clone(),
                "notifications.subscribe",
                json!({ "enabled": granted }),
            )
            .await?;
        if matches!(
            action,
            BridgeAction::RequestPermission {}
                | BridgeAction::Status {}
                | BridgeAction::PreferencesGet {}
        ) {
            snapshot["preferences"] = preferences;
            return Ok(());
        }
    }
    let (method, params) = match action {
        BridgeAction::RequestPermission {}
        | BridgeAction::Status {}
        | BridgeAction::PreferencesGet {} => ("notifications.preferences.get", json!({})),
        BridgeAction::PreferencesSet { scope, preferences } => (
            "notifications.preferences.set",
            json!({ "scope": match scope { PreferenceScope::User => "user", PreferenceScope::Device => "device" }, "preferences": preferences }),
        ),
        BridgeAction::SendTest {} => ("notifications.test", json!({})),
    };
    let result = gateway
        .notification_request(lease.clone(), document.clone(), method, params)
        .await?;
    if send_test {
        snapshot["test"] = json!({ "state": "sent" });
        if let Some(preferences) = lease.preferences() {
            snapshot["preferences"] = preferences;
        }
    } else {
        snapshot["preferences"] = result;
    }
    Ok(())
}

fn publish_snapshot(
    app: &AppHandle,
    gateway: &GatewayClient,
    generation: u64,
    dashboard: &Url,
    document: &BridgeDocument,
    error_revision: u64,
    snapshot: Value,
) {
    if !document.is_attached() {
        return;
    }
    // A child navigation or Gateway change can revoke admission while this document remains.
    // Settle only its own request with an error; never publish stale preference data.
    let snapshot = if !document.is_current()
        || !gateway
            .notification_target()
            .is_some_and(|(current, _)| current == generation)
    {
        let Some(reply_to) = snapshot.get("replyTo") else {
            return;
        };
        json!({ "supported": notify::notifications_supported() && gateway.notifications_supported(),
            "permission": "unknown", "replyTo": reply_to,
            "error": "The Dashboard or Gateway changed. Try notification settings again." })
    } else {
        snapshot
    };
    let Some(webview) = app.get_webview("main") else {
        return;
    };
    if !webview
        .url()
        .is_ok_and(|url| dashboard_contains(dashboard, &url))
    {
        return;
    }
    let document = serde_json::to_string(&document.id).expect("document identifier serialization");
    let script = format!("if (window.__OPENCLAW_NATIVE_NOTIFICATIONS_DOCUMENT__ === {document}) {{ const next = {snapshot}; if ((window.__OPENCLAW_NATIVE_NOTIFICATIONS_ERROR_REVISION__ ?? 0) > {error_revision}) {{ const current = window.__OPENCLAW_NATIVE_NOTIFICATIONS__; if (current?.error) {{ next.error = current.error; next.test = current.test; }} }} else {{ window.__OPENCLAW_NATIVE_NOTIFICATIONS_ERROR_REVISION__ = {error_revision}; }} window.__OPENCLAW_NATIVE_NOTIFICATIONS__ = next; window.dispatchEvent(new CustomEvent('openclaw:native-notifications-status', {{detail:next}})); }}");
    let _ = webview.eval(&script);
}

#[cfg(test)]
mod tests {
    use super::{decode_bridge_action, MAX_BRIDGE_MESSAGE_BYTES};
    use serde_json::json;

    #[test]
    fn bridge_requests_cannot_supply_notification_content_or_gateway_targets() {
        assert!(decode_bridge_action(
            &json!({ "type": "send-test", "requestId": "request-1" }).to_string(),
            "request-1"
        )
        .is_ok());
        for mut request in [
            json!({ "type": "send-test", "body": "renderer-selected content" }),
            json!({ "type": "preferences-get", "gatewayUrl": "https://other.example" }),
            json!({ "type": "preferences-set", "scope": "other", "preferences": {} }),
        ] {
            request["requestId"] = json!("request-1");
            assert!(decode_bridge_action(&request.to_string(), "request-1").is_err());
        }
    }

    #[test]
    fn bridge_preserves_preference_values_and_rejects_oversized_transport() {
        let request = json!({ "type": "preferences-set", "requestId": "request-1", "scope": "device", "preferences": { "enabled": true, "label": "", "agentIds": vec!["a".repeat(127); 31] } });
        assert!(request.to_string().len() > 4096);
        assert!(decode_bridge_action(&request.to_string(), "request-1").is_ok());
        assert!(decode_bridge_action(&request.to_string(), "other-request").is_err());
        let oversized = json!({ "type": "preferences-set", "requestId": "request-1", "scope": "device", "preferences": { "agentIds": ["a".repeat(MAX_BRIDGE_MESSAGE_BYTES)] } });
        assert!(decode_bridge_action(&oversized.to_string(), "request-1")
            .err()
            .is_some_and(|error| error.contains("too large")));
    }
}
