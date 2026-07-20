use crate::gateway_ws::GatewayClient;
use crate::quickchat::{QuickChatState, QUICKCHAT_LABEL};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl, Window,
};
use tokio::sync::Mutex as AsyncMutex;

const QUICKCHAT_WIDTH: f64 = 640.0;
const QUICKCHAT_COMPACT_WINDOW_HEIGHT: f64 = 92.0;
const QUICKCHAT_TEXT_WINDOW_HEIGHT: f64 = 360.0;
const QUICKCHAT_WIDGET_WINDOW_HEIGHT: f64 = 440.0;
const QUICKCHAT_WIDGET_HEIGHT: f64 = 160.0;
const QUICKCHAT_WIDGET_LABEL_PREFIX: &str = "quickchat-widget-";
const QUICKCHAT_WIDGET_MAX_COUNT: usize = 32;
const QUICKCHAT_WIDGET_MAX_URL_BYTES: usize = 4096;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickChatWidgetLayout {
    key: String,
    url: String,
    sandbox: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
}

#[derive(Clone, Default)]
pub struct QuickChatWidgetState {
    views: Arc<Mutex<HashSet<String>>>,
    sync: Arc<AsyncMutex<()>>,
    closed_generation: Arc<AtomicU64>,
}

fn quickchat_window_height(has_widgets: bool, expanded: bool) -> f64 {
    if has_widgets {
        QUICKCHAT_WIDGET_WINDOW_HEIGHT
    } else if expanded {
        QUICKCHAT_TEXT_WINDOW_HEIGHT
    } else {
        QUICKCHAT_COMPACT_WINDOW_HEIGHT
    }
}

fn resize_window_if_needed(window: &Window, height: f64) -> Result<(), String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Could not read Quick Chat scale: {error}"))?;
    let current = window
        .inner_size()
        .map_err(|error| format!("Could not read Quick Chat size: {error}"))?;
    let current_height = f64::from(current.height) / scale;
    if (current_height - height).abs() <= 0.5 {
        return Ok(());
    }
    window
        .set_size(LogicalSize::new(QUICKCHAT_WIDTH, height))
        .map_err(|error| format!("Could not resize Quick Chat for widgets: {error}"))
}

impl QuickChatWidgetState {
    fn invalidate_generation(&self, generation: u64) {
        self.closed_generation
            .fetch_max(generation, Ordering::SeqCst);
    }

    fn generation_is_closed(&self, generation: u64) -> bool {
        generation <= self.closed_generation.load(Ordering::SeqCst)
    }

    pub async fn close(&self, app: &AppHandle, generation: u64) {
        // Invalidate before waiting on the sync lock so an older queued request cannot
        // recreate child WebViews after this hide cycle finishes its cleanup.
        self.invalidate_generation(generation);
        let _sync = self.sync.lock().await;
        let labels = self
            .views
            .lock()
            .map(|mut views| views.drain().collect::<Vec<_>>())
            .unwrap_or_default();
        for label in labels {
            if let Some(webview) = app.get_webview(&label) {
                let _ = webview.close();
            }
        }
    }

    async fn sync(
        &self,
        webview: &Webview,
        app: &AppHandle,
        widgets: Vec<QuickChatWidgetLayout>,
        has_widgets: bool,
        expanded: bool,
        generation: u64,
    ) -> Result<(), String> {
        if self.generation_is_closed(generation) {
            return Ok(());
        }
        let _sync = self.sync.lock().await;
        if self.generation_is_closed(generation) {
            return Ok(());
        }
        let window = webview.window();
        if !has_widgets && !widgets.is_empty() {
            return Err("Quick Chat received widget layouts without widget content.".to_string());
        }
        if widgets.len() > QUICKCHAT_WIDGET_MAX_COUNT {
            return Err("Quick Chat received too many widgets.".to_string());
        }
        let mut keys = HashSet::new();
        let mut visible_count = 0;
        let mut prepared = Vec::with_capacity(widgets.len());
        for widget in widgets {
            if !keys.insert(widget.key.clone()) {
                return Err("Quick Chat widget keys must be unique.".to_string());
            }
            visible_count += usize::from(widget.visible);
            let url = validate_widget_layout(&widget)?;
            let label = widget_view_label(&widget);
            prepared.push((widget, label, url));
        }
        if visible_count > 1 {
            return Err("Quick Chat can show only one widget at a time.".to_string());
        }
        let current = self
            .views
            .lock()
            .map_err(|_| "Quick Chat widget state is unavailable.".to_string())?
            .clone();
        let mut desired = HashSet::new();
        for (_, label, _) in &prepared {
            if !desired.insert(label.clone()) {
                return Err("Quick Chat widget identities must be unique.".to_string());
            }
        }

        let cleanup_created = |labels: &HashSet<String>| {
            for label in labels {
                if let Some(webview) = app.get_webview(label) {
                    let _ = webview.close();
                }
            }
        };
        let parent = window.clone();
        let mut created = HashSet::new();
        let mut reconciled = Vec::with_capacity(prepared.len());
        for (widget, label, url) in prepared {
            let position = LogicalPosition::new(widget.x, widget.y);
            let size = LogicalSize::new(widget.width, widget.height);
            let existing = current
                .contains(&label)
                .then(|| app.get_webview(&label))
                .flatten();
            let webview = match existing {
                Some(webview) => webview,
                None => {
                    if let Some(orphan) = app.get_webview(&label) {
                        let _ = orphan.close();
                    }
                    let allowed_url = url.clone();
                    // Widget labels intentionally match no Tauri capability. Linux cannot isolate
                    // iframe IPC, so agent-authored scripts must stay in separate child WebViews.
                    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
                        .incognito(true)
                        .transparent(true)
                        .on_navigation(move |candidate| {
                            same_widget_document(candidate, &allowed_url)
                        })
                        .on_new_window(|_, _| NewWindowResponse::Deny);
                    if widget.sandbox == "strict" {
                        builder = builder.disable_javascript();
                    }
                    match parent.add_child(builder, position, size) {
                        Ok(webview) => {
                            created.insert(label.clone());
                            webview
                        }
                        Err(error) => {
                            cleanup_created(&created);
                            return Err(format!("Could not create Quick Chat widget: {error}"));
                        }
                    }
                }
            };
            if let Err(error) = webview.set_position(position) {
                cleanup_created(&created);
                return Err(format!("Could not position Quick Chat widget: {error}"));
            }
            if let Err(error) = webview.set_size(size) {
                cleanup_created(&created);
                return Err(format!("Could not resize Quick Chat widget: {error}"));
            }
            reconciled.push((widget.visible, webview));
        }

        for (visible, webview) in &reconciled {
            let result = if *visible {
                webview.show()
            } else {
                webview.hide()
            };
            if let Err(error) = result {
                cleanup_created(&created);
                return Err(format!(
                    "Could not update Quick Chat widget visibility: {error}"
                ));
            }
        }
        if let Err(error) =
            resize_window_if_needed(&window, quickchat_window_height(has_widgets, expanded))
        {
            cleanup_created(&created);
            return Err(error);
        }

        let mut committed = desired.clone();
        for label in current.difference(&desired) {
            if app
                .get_webview(label)
                .is_some_and(|webview| webview.close().is_err())
            {
                committed.insert(label.clone());
            }
        }
        *self.views.lock().map_err(|_| {
            cleanup_created(&created);
            "Quick Chat widget state is unavailable.".to_string()
        })? = committed;
        Ok(())
    }
}

#[tauri::command]
pub async fn quickchat_refresh_widget_surface(
    webview: Webview,
    gateway: State<'_, GatewayClient>,
) -> Result<Option<String>, String> {
    if webview.label() != QUICKCHAT_LABEL || webview.window().label() != QUICKCHAT_LABEL {
        return Err("Quick Chat command is available only to the Quick Chat webview.".to_string());
    }
    gateway.refresh_canvas_surface().await
}

#[tauri::command]
pub async fn quickchat_sync_widgets(
    webview: Webview,
    app: AppHandle,
    state: State<'_, QuickChatState>,
    widgets: Vec<QuickChatWidgetLayout>,
    has_widgets: bool,
    expanded: bool,
    generation: u64,
) -> Result<(), String> {
    if webview.label() != QUICKCHAT_LABEL || webview.window().label() != QUICKCHAT_LABEL {
        return Err("Quick Chat command is available only to the Quick Chat webview.".to_string());
    }
    state
        .widget_state()
        .sync(&webview, &app, widgets, has_widgets, expanded, generation)
        .await
}

fn percent_decode_once(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return None;
        }
        let byte = u8::from_str_radix(&raw[index + 1..index + 3], 16).ok()?;
        decoded.push(byte);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn percent_decode_repeatedly(raw: &str) -> Option<String> {
    let mut value = raw.to_string();
    for _ in 0..8 {
        let decoded = percent_decode_once(&value)?;
        if decoded == value {
            return Some(decoded);
        }
        value = decoded;
    }
    None
}

fn has_url_userinfo(url: &Url) -> bool {
    url.as_str()
        .split_once("://")
        .map(|(_, suffix)| {
            suffix
                .split(['/', '?', '#'])
                .next()
                .is_some_and(|authority| authority.contains('@'))
        })
        .unwrap_or(false)
}

fn has_secure_widget_transport(url: &Url) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }
    let Some(host) = url
        .host_str()
        .map(|host| host.trim_matches(['[', ']']).to_ascii_lowercase())
    else {
        return false;
    };
    host == "localhost"
        || host.ends_with(".localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn validate_widget_url(raw: &str) -> Result<Url, String> {
    if raw.len() > QUICKCHAT_WIDGET_MAX_URL_BYTES {
        return Err("Quick Chat widget URL is too long.".to_string());
    }
    let url =
        Url::parse(raw.trim()).map_err(|_| "Quick Chat widget URL is invalid.".to_string())?;
    if !has_secure_widget_transport(&url) || has_url_userinfo(&url) || url.host_str().is_none() {
        return Err("Quick Chat widget URL is not a secure HTTP capability URL.".to_string());
    }
    let encoded_segments = url
        .path()
        .split('/')
        .skip(1)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if encoded_segments.iter().any(|segment| segment.is_empty()) {
        return Err("Quick Chat widget URL has an invalid path.".to_string());
    }
    let segments = encoded_segments
        .iter()
        .map(|segment| {
            let decoded = percent_decode_repeatedly(segment)
                .ok_or_else(|| "Quick Chat widget URL has invalid encoding.".to_string())?;
            if decoded == "." || decoded == ".." || decoded.contains('/') || decoded.contains('\\')
            {
                return Err("Quick Chat widget URL has an unsafe path.".to_string());
            }
            Ok(decoded)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let Some(capability_index) = segments
        .windows(2)
        .rposition(|pair| pair == ["__openclaw__", "cap"])
    else {
        return Err("Quick Chat widget URL is missing its capability scope.".to_string());
    };
    let document_index = capability_index + 3;
    if segments
        .get(capability_index + 2)
        .is_none_or(String::is_empty)
        || segments.get(document_index).map(String::as_str) != Some("__openclaw__")
        || segments.get(document_index + 1).map(String::as_str) != Some("canvas")
        || segments.get(document_index + 2).map(String::as_str) != Some("documents")
        || segments.len() < document_index + 5
    {
        return Err("Quick Chat widget URL is outside the Canvas document scope.".to_string());
    }
    Ok(url)
}

fn validate_widget_layout(widget: &QuickChatWidgetLayout) -> Result<Url, String> {
    if widget.key.trim().is_empty() || widget.key.len() > 256 {
        return Err("Quick Chat widget key is invalid.".to_string());
    }
    if widget.sandbox != "scripts" && widget.sandbox != "strict" {
        return Err("Quick Chat widget sandbox is invalid.".to_string());
    }
    if !widget.x.is_finite()
        || !widget.y.is_finite()
        || !widget.width.is_finite()
        || !widget.height.is_finite()
        || widget.x < 0.0
        || widget.y < 0.0
        || widget.width < 1.0
        || (widget.height - QUICKCHAT_WIDGET_HEIGHT).abs() > 0.5
        || widget.x + widget.width > QUICKCHAT_WIDTH + 1.0
        || widget.y + widget.height > QUICKCHAT_WIDGET_WINDOW_HEIGHT + 1.0
    {
        return Err("Quick Chat widget bounds are invalid.".to_string());
    }
    validate_widget_url(&widget.url)
}

fn widget_view_label(widget: &QuickChatWidgetLayout) -> String {
    let mut hasher = Sha256::new();
    hasher.update(widget.key.as_bytes());
    hasher.update([0]);
    hasher.update(widget.url.as_bytes());
    hasher.update([0]);
    hasher.update(widget.sandbox.as_bytes());
    let digest = hasher.finalize();
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{QUICKCHAT_WIDGET_LABEL_PREFIX}{suffix}")
}

fn same_widget_document(candidate: &Url, allowed: &Url) -> bool {
    candidate.scheme() == allowed.scheme()
        && !has_url_userinfo(candidate)
        && candidate.host_str() == allowed.host_str()
        && candidate.port_or_known_default() == allowed.port_or_known_default()
        && candidate.path() == allowed.path()
        && candidate.query() == allowed.query()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_widget(key: &str, url: &str, sandbox: &str) -> QuickChatWidgetLayout {
        QuickChatWidgetLayout {
            key: key.to_string(),
            url: url.to_string(),
            sandbox: sandbox.to_string(),
            x: 52.0,
            y: 174.0,
            width: 540.0,
            height: QUICKCHAT_WIDGET_HEIGHT,
            visible: true,
        }
    }

    #[test]
    fn hide_generation_invalidates_queued_syncs() {
        let state = QuickChatWidgetState::default();
        assert!(!state.generation_is_closed(1));
        state.invalidate_generation(2);
        assert!(state.generation_is_closed(1));
        assert!(state.generation_is_closed(2));
        assert!(!state.generation_is_closed(3));
    }

    #[test]
    fn semantic_widget_state_owns_window_height() {
        assert_eq!(
            quickchat_window_height(false, false),
            QUICKCHAT_COMPACT_WINDOW_HEIGHT
        );
        assert_eq!(
            quickchat_window_height(false, true),
            QUICKCHAT_TEXT_WINDOW_HEIGHT
        );
        assert_eq!(
            quickchat_window_height(true, false),
            QUICKCHAT_WIDGET_WINDOW_HEIGHT
        );
        assert_eq!(
            quickchat_window_height(true, true),
            QUICKCHAT_WIDGET_WINDOW_HEIGHT
        );
    }

    #[test]
    fn layout_requires_a_scoped_canvas_document() {
        let valid = test_widget(
            "status",
            "https://gateway.example/base/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html",
            "scripts",
        );
        assert!(validate_widget_layout(&valid).is_ok());
        assert!(validate_widget_layout(&test_widget(
            "local",
            "http://127.0.0.1:18789/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/local/index.html",
            "scripts",
        ))
        .is_ok());
        assert!(validate_widget_layout(&test_widget(
            "local-v6",
            "http://[::1]:18789/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/local-v6/index.html",
            "scripts",
        ))
        .is_ok());

        for url in [
            "https://evil.example/widget.html",
            "http://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html",
            "https://gateway.example/__openclaw__/canvas/documents/status/index.html",
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/%252e%252e/private-file",
        ] {
            assert!(validate_widget_layout(&test_widget("status", url, "scripts")).is_err());
        }
        let mut outside_window = valid.clone();
        outside_window.y = QUICKCHAT_WIDGET_WINDOW_HEIGHT;
        assert!(validate_widget_layout(&outside_window).is_err());
    }

    #[test]
    fn labels_preserve_existing_instances_when_siblings_append() {
        let first = test_widget(
            "first",
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/first/index.html",
            "scripts",
        );
        let second = test_widget(
            "second",
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/second/index.html",
            "scripts",
        );
        let first_label = widget_view_label(&first);
        let desired_before = HashMap::from([(first.key.clone(), first_label.clone())]);
        let desired_after = HashMap::from([
            (first.key.clone(), widget_view_label(&first)),
            (second.key.clone(), widget_view_label(&second)),
        ]);

        assert_eq!(desired_after.get("first"), desired_before.get("first"));
        let mut navigated = first.clone();
        navigated.url.push_str("?revision=2");
        assert_ne!(widget_view_label(&navigated), first_label);
    }

    #[test]
    fn navigation_stays_on_the_original_document() {
        let allowed = Url::parse(
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html?mode=compact",
        )
        .expect("allowed URL");
        let fragment = Url::parse(
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html?mode=compact#details",
        )
        .expect("fragment URL");
        let other = Url::parse(
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/other/index.html",
        )
        .expect("other URL");
        let mut userinfo_url = allowed.clone();
        userinfo_url
            .set_username("fixture-user")
            .expect("set fixture user");

        assert!(same_widget_document(&fragment, &allowed));
        assert!(!same_widget_document(&other, &allowed));
        assert!(!same_widget_document(&userinfo_url, &allowed));
    }
}
