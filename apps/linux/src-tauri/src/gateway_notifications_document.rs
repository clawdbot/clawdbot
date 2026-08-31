use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview};
use tokio::sync::mpsc;

#[derive(Default)]
pub(crate) struct BridgeViews(Mutex<Option<Arc<BridgeView>>>);

pub(crate) struct BridgeView {
    active: AtomicBool,
    navigation: AtomicU64,
}

#[derive(Clone)]
pub(crate) struct BridgeDocument {
    view: Arc<BridgeView>,
    navigation: u64,
    pub(crate) id: String,
}

impl BridgeViews {
    pub(crate) fn replace(&self) -> Arc<BridgeView> {
        let view = Arc::new(BridgeView {
            active: AtomicBool::new(true),
            navigation: AtomicU64::new(0),
        });
        if let Some(previous) = self
            .0
            .lock()
            .expect("notification view mutex poisoned")
            .replace(view.clone())
        {
            previous.active.store(false, Ordering::SeqCst);
        }
        view
    }

    pub(crate) fn retire(&self) {
        if let Some(view) = self
            .0
            .lock()
            .expect("notification view mutex poisoned")
            .take()
        {
            view.active.store(false, Ordering::SeqCst);
        }
    }
}

impl BridgeView {
    // Wry navigation decisions also include child frames. Conservatively revoke on
    // every non-bridge navigation; page-load Started arrives only at document commit.
    pub(crate) fn navigated(&self) {
        self.navigation.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn document(self: &Arc<Self>, id: String) -> BridgeDocument {
        BridgeDocument {
            view: self.clone(),
            navigation: self.navigation.load(Ordering::SeqCst),
            id,
        }
    }

    pub(crate) fn admit(
        self: &Arc<Self>,
        webview: Webview,
        request_id: String,
    ) -> impl std::future::Future<Output = Option<(BridgeDocument, String)>> + Send + 'static {
        // Capture before returning the future: spawning it must not adopt a
        // navigation or same-label replacement that happened while it was queued.
        let navigation = self.navigation.load(Ordering::SeqCst);
        let view = self.clone();
        async move {
            if !view.active.load(Ordering::SeqCst)
                || view.navigation.load(Ordering::SeqCst) != navigation
            {
                return None;
            }
            let request =
                serde_json::to_string(&request_id).expect("request identifier serialization");
            let script =
                format!("window.__OPENCLAW_NATIVE_NOTIFICATIONS_ADMIT__?.({request}) ?? null");
            let (sender, mut receiver) = mpsc::channel(1);
            webview
                .eval_with_callback(script, move |result| {
                    let _ = sender.try_send(result);
                })
                .ok()?;
            // Wry can drop callbacks while initial scripts are queued. Only a
            // returned top-frame request, still bound to this epoch, is admitted.
            let result = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
                .await
                .ok()??;
            let (document_id, payload): (String, String) = serde_json::from_str(&result).ok()?;
            let document = view.document(document_id);
            if document.navigation != navigation || !document.is_current() {
                return None;
            }
            // Acknowledge receipt before OS permission can outlive the transport
            // timeout; a lost callback leaves that timeout available to the UI.
            let args = serde_json::json!([request_id, document.id]);
            webview
                .eval(format!(
                    "window.__OPENCLAW_NATIVE_NOTIFICATIONS_ADMIT__?.(...{args})"
                ))
                .ok()?;
            document.is_current().then_some((document, payload))
        }
    }
}

impl BridgeDocument {
    pub(crate) fn is_attached(&self) -> bool {
        self.view.active.load(Ordering::SeqCst)
    }

    pub(crate) fn is_current(&self) -> bool {
        self.is_attached() && self.view.navigation.load(Ordering::SeqCst) == self.navigation
    }
}

pub(crate) fn replace_view(app: &AppHandle) -> Arc<BridgeView> {
    app.state::<BridgeViews>().replace()
}

#[cfg(test)]
mod tests {
    use super::BridgeViews;

    #[test]
    fn navigation_and_same_label_replacement_revoke_captured_documents() {
        let views = BridgeViews::default();
        let view = views.replace();
        let first = view.document("same-url-document".to_string());
        assert!(first.is_current());
        view.navigated();
        assert!(!first.is_current());
        let reloaded = view.document("same-url-document".to_string());
        assert!(reloaded.is_current());
        let replacement = views.replace().document("same-url-document".to_string());
        assert!(!reloaded.is_current());
        assert!(replacement.is_current());
        views.retire();
        assert!(!replacement.is_current());
    }
}
