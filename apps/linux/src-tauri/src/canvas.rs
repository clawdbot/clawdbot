use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::ImageFormat;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Cursor, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

const CANVAS_LABEL: &str = "canvas";
const CANVAS_SCHEME: &str = "openclaw-canvas";
const BUNDLED_CANVAS_HREF: &str = "openclaw-canvas://localhost/index.html";
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
const WEBVIEW_TIMEOUT: Duration = Duration::from_secs(8);
const A2UI_READY_TIMEOUT: Duration = Duration::from_secs(6);
const A2UI_READY_INTERVAL: Duration = Duration::from_millis(100);
const A2UI_READY_EVAL_TIMEOUT: Duration = Duration::from_millis(100);

const A2UI_INDEX: &[u8] = include_bytes!(
    "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/index.html"
);
const A2UI_BUNDLE: &[u8] = include_bytes!(
    "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/a2ui.bundle.js"
);

const ACTION_BRIDGE_SCRIPT: &str = r#"
(() => {
  const dispatchFailure = (message, error) => {
    try {
      const parsed = JSON.parse(String(message));
      const id = parsed?.userAction?.id;
      if (typeof id === "string") {
        window.dispatchEvent(new CustomEvent("openclaw:a2ui-action-status", {
          detail: { id, ok: false, error: String(error) }
        }));
      }
    } catch {}
  };
  Object.defineProperty(window, "openclawCanvasA2UIAction", {
    configurable: false,
    value: {
      postMessage(message) {
        if (window.location.protocol !== "openclaw-canvas:") return;
        const invoke = window.__TAURI__?.core?.invoke;
        if (typeof invoke !== "function") {
          dispatchFailure(message, "desktop action bridge unavailable");
          return;
        }
        void invoke("canvas_a2ui_action", { message: String(message) })
          .catch((error) => dispatchFailure(message, error));
      }
    }
  });
})();
"#;

#[derive(Clone)]
pub struct CanvasBridge {
    inner: Arc<CanvasBridgeInner>,
}

struct CanvasBridgeInner {
    clients: Mutex<HashMap<u64, Arc<Mutex<UnixStream>>>>,
    command_tx: mpsc::Sender<CanvasRequestJob>,
    active_client_id: AtomicU64,
    next_client_id: AtomicU64,
    socket_path: PathBuf,
    socket_inode: u64,
    stopping: AtomicBool,
}

struct CanvasRequestJob {
    client_id: u64,
    request: IpcRequest,
    writer: Arc<Mutex<UnixStream>>,
}

#[derive(Debug)]
struct CanvasError {
    code: &'static str,
    message: String,
}

impl CanvasError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_REQUEST",
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "CANVAS_UNAVAILABLE",
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
struct IpcRequest {
    id: String,
    command: String,
    #[serde(rename = "paramsJSON")]
    params_json: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Placement {
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresentParams {
    url: Option<String>,
    placement: Option<Placement>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NavigateParams {
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EvalParams {
    #[serde(rename = "javaScript")]
    java_script: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotParams {
    format: String,
    #[serde(rename = "maxWidth")]
    max_width: Option<u32>,
    quality: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PushParams {
    messages: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PushJsonlParams {
    jsonl: String,
}

impl CanvasBridge {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let socket_path = socket_path();
        prepare_socket_path(&socket_path)?;
        let listener = UnixListener::bind(&socket_path)
            .map_err(|error| format!("Could not bind Canvas socket: {error}"))?;
        if let Err(error) = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&socket_path);
            return Err(format!("Could not secure Canvas socket: {error}"));
        }
        let socket_inode = match fs::symlink_metadata(&socket_path) {
            Ok(metadata) => metadata.ino(),
            Err(error) => {
                let _ = fs::remove_file(&socket_path);
                return Err(format!("Could not inspect Canvas socket: {error}"));
            }
        };
        if let Err(error) = listener.set_nonblocking(true) {
            let _ = remove_socket_if_owned(&socket_path, socket_inode);
            return Err(format!("Could not configure Canvas socket: {error}"));
        }

        let (command_tx, command_rx) = mpsc::channel();
        let bridge = Self {
            inner: Arc::new(CanvasBridgeInner {
                clients: Mutex::new(HashMap::new()),
                command_tx,
                active_client_id: AtomicU64::new(0),
                next_client_id: AtomicU64::new(1),
                socket_path,
                socket_inode,
                stopping: AtomicBool::new(false),
            }),
        };
        let command_bridge = bridge.clone();
        let command_app = app.clone();
        thread::spawn(move || command_bridge.run_commands(command_app, command_rx));
        let server_bridge = bridge.clone();
        thread::spawn(move || {
            while !server_bridge.inner.stopping.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _address)) => server_bridge.accept(app.clone(), stream),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(100));
                    }
                    Err(error) => {
                        eprintln!("Canvas IPC accept failed: {error}");
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        });
        Ok(bridge)
    }

    pub fn shutdown(&self) {
        if self.inner.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut clients) = self.inner.clients.lock() {
            for client in clients.values() {
                if let Ok(client) = client.lock() {
                    let _ = client.shutdown(std::net::Shutdown::Both);
                }
            }
            clients.clear();
        }
        let _ = remove_socket_if_owned(&self.inner.socket_path, self.inner.socket_inode);
    }

    fn accept(&self, app: AppHandle, stream: UnixStream) {
        // Socket mode closes normal access; peer credentials also close the
        // short bind-to-chmod window on the /tmp fallback.
        if peer_uid(&stream).ok() != Some(unsafe { libc::geteuid() }) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return;
        }
        let client_id = self.inner.next_client_id.fetch_add(1, Ordering::Relaxed);
        let writer = match stream.try_clone() {
            Ok(writer) => Arc::new(Mutex::new(writer)),
            Err(error) => {
                eprintln!("Canvas IPC client clone failed: {error}");
                return;
            }
        };
        let mut clients = self
            .inner
            .clients
            .lock()
            .expect("Canvas client mutex poisoned");
        // The CLI host is the single Gateway node connection. Replace a stale
        // socket here so one click cannot fan out into duplicate agent turns.
        for previous in clients.values() {
            if let Ok(previous) = previous.lock() {
                let _ = previous.shutdown(std::net::Shutdown::Both);
            }
        }
        clients.clear();
        clients.insert(client_id, writer.clone());
        self.inner
            .active_client_id
            .store(client_id, Ordering::Release);
        drop(clients);
        let bridge = self.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) if line.len() > MAX_FRAME_BYTES => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                let Ok(frame) = serde_json::from_str::<Value>(line.trim_end()) else {
                    continue;
                };
                if bridge.inner.active_client_id.load(Ordering::Acquire) != client_id {
                    break;
                }
                if frame.get("event").and_then(Value::as_str) == Some("a2ui-action-result") {
                    dispatch_action_status(&app, &frame);
                    continue;
                }
                let Ok(request) = serde_json::from_value::<IpcRequest>(frame) else {
                    continue;
                };
                if bridge
                    .inner
                    .command_tx
                    .send(CanvasRequestJob {
                        client_id,
                        request,
                        writer: writer.clone(),
                    })
                    .is_err()
                {
                    break;
                }
            }
            bridge
                .inner
                .clients
                .lock()
                .expect("Canvas client mutex poisoned")
                .remove(&client_id);
            let _ = bridge.inner.active_client_id.compare_exchange(
                client_id,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        });
    }

    fn run_commands(&self, app: AppHandle, receiver: mpsc::Receiver<CanvasRequestJob>) {
        for job in receiver {
            let response = if self.inner.active_client_id.load(Ordering::Acquire) != job.client_id {
                json!({
                    "id": job.request.id,
                    "error": {
                        "code": "CANVAS_UNAVAILABLE",
                        "message": "Canvas node connection was replaced"
                    }
                })
            } else {
                match handle_request(&app, &job.request) {
                    Ok(payload_json) => {
                        json!({"id": job.request.id, "ok": true, "payloadJSON": payload_json})
                    }
                    Err(error) => json!({
                        "id": job.request.id,
                        "error": {"code": error.code, "message": error.message}
                    }),
                }
            };
            // Response completion is part of the FIFO command. The node host
            // updates the owning agent session only after receiving it.
            let _ = write_frame(&job.writer, &response);
        }
    }

    fn send_action(&self, action: Value) -> Result<(), String> {
        let id = action
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "A2UI action is missing an id.".to_string())?;
        let frame = json!({"event": "a2ui-action", "id": id, "action": action});
        let mut failed = Vec::new();
        let mut delivered = false;
        let clients = self
            .inner
            .clients
            .lock()
            .map_err(|_| "Canvas client registry is unavailable.".to_string())?;
        if clients.is_empty() {
            return Err("OpenClaw node host is not connected.".to_string());
        }
        for (client_id, writer) in clients.iter() {
            if write_frame(writer, &frame).is_err() {
                failed.push(*client_id);
            } else {
                delivered = true;
            }
        }
        drop(clients);
        if !failed.is_empty() {
            let mut clients = self
                .inner
                .clients
                .lock()
                .map_err(|_| "Canvas client registry is unavailable.".to_string())?;
            for client_id in failed {
                clients.remove(&client_id);
            }
        }
        if delivered {
            Ok(())
        } else {
            Err("OpenClaw node host disconnected before the action was sent.".to_string())
        }
    }
}

pub fn register_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol(CANVAS_SCHEME, |_context, request| {
        let (body, content_type, status) = match request.uri().path() {
            "/" | "/index.html" => (A2UI_INDEX, "text/html; charset=utf-8", 200),
            "/a2ui.bundle.js" => (A2UI_BUNDLE, "text/javascript; charset=utf-8", 200),
            _ => (&b"not found"[..], "text/plain; charset=utf-8", 404),
        };
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            .header("Cache-Control", "no-store")
            .body(body.to_vec())
            .expect("Canvas protocol response must be valid")
    })
}

#[tauri::command]
pub fn canvas_a2ui_action(
    window: WebviewWindow,
    bridge: tauri::State<'_, CanvasBridge>,
    message: String,
) -> Result<(), String> {
    if window.label() != CANVAS_LABEL {
        return Err("A2UI actions are accepted only from the Canvas window.".to_string());
    }
    let url = window
        .url()
        .map_err(|error| format!("Could not read Canvas URL: {error}"))?;
    if !is_bundled_canvas_url(&url) {
        return Err("A2UI actions are accepted only from the bundled Canvas renderer.".to_string());
    }
    let payload: Value = serde_json::from_str(&message)
        .map_err(|error| format!("A2UI action is invalid JSON: {error}"))?;
    let action = payload.get("userAction").cloned().unwrap_or(payload);
    if action
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .is_none()
    {
        return Err("A2UI action is missing a name.".to_string());
    }
    bridge.send_action(action)
}

fn handle_request(app: &AppHandle, request: &IpcRequest) -> Result<String, CanvasError> {
    match request.command.as_str() {
        "canvas.present" => {
            let params: PresentParams = decode_params(&request.params_json)?;
            let window = ensure_canvas_window(app)?;
            if let Some(url) = params.url.as_deref() {
                window.navigate(parse_canvas_url(url)?).map_err(|error| {
                    CanvasError::unavailable(format!("navigation failed: {error}"))
                })?;
            } else {
                ensure_a2ui_host(&window)?;
            }
            if let Some(placement) = params.placement {
                apply_placement(&window, placement);
            }
            window
                .show()
                .map_err(|error| CanvasError::unavailable(format!("show failed: {error}")))?;
            Ok(json!({"ok": true}).to_string())
        }
        "canvas.hide" => {
            decode_empty_params(&request.params_json)?;
            if let Some(window) = app.get_webview_window(CANVAS_LABEL) {
                window
                    .hide()
                    .map_err(|error| CanvasError::unavailable(format!("hide failed: {error}")))?;
            }
            Ok(json!({"ok": true}).to_string())
        }
        "canvas.navigate" => {
            let params: NavigateParams = decode_params(&request.params_json)?;
            ensure_canvas_window(app)?
                .navigate(parse_canvas_url(&params.url)?)
                .map_err(|error| CanvasError::unavailable(format!("navigation failed: {error}")))?;
            Ok(json!({"ok": true}).to_string())
        }
        "canvas.eval" => {
            let params: EvalParams = decode_params(&request.params_json)?;
            let window = ensure_canvas_window(app)?;
            // Native WebKit evaluation is not governed by the loaded page's
            // `unsafe-eval` CSP and matches the macOS/iOS Canvas contract.
            let result = eval_json(&window, &params.java_script)?;
            Ok(json!({"result": evaluation_result_string(result)}).to_string())
        }
        "canvas.snapshot" => {
            let params: SnapshotParams = decode_params(&request.params_json)?;
            let window = ensure_canvas_window(app)?;
            snapshot(&window, params)
        }
        "canvas.a2ui.push" => {
            let params: PushParams = decode_params(&request.params_json)?;
            apply_a2ui_messages(app, params.messages, true)
        }
        "canvas.a2ui.pushJSONL" => {
            let params: PushJsonlParams = decode_params(&request.params_json)?;
            let messages = params
                .jsonl
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| {
                    serde_json::from_str::<Value>(line).map_err(|error| {
                        CanvasError::invalid(format!("invalid A2UI JSONL: {error}"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            apply_a2ui_messages(app, messages, true)
        }
        "canvas.a2ui.reset" => {
            decode_empty_params(&request.params_json)?;
            let window = ensure_canvas_window(app)?;
            ensure_a2ui_host(&window)?;
            let result = eval_json(&window, &a2ui_reset_script())?;
            if result.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(CanvasError::invalid(
                    result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("A2UI reset failed"),
                ));
            }
            Ok(result.to_string())
        }
        _ => Err(CanvasError::invalid("unknown Canvas command")),
    }
}

fn apply_a2ui_messages(
    app: &AppHandle,
    messages: Vec<Value>,
    show: bool,
) -> Result<String, CanvasError> {
    let window = ensure_canvas_window(app)?;
    ensure_a2ui_host(&window)?;
    let messages_json = serde_json::to_string(&messages)
        .map_err(|error| CanvasError::invalid(error.to_string()))?;
    let result = eval_json(
        &window,
        &guarded_a2ui_script(&format!(
            "return globalThis.openclawA2UI.applyMessages({messages_json});"
        )),
    )?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(CanvasError::invalid(
            result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("A2UI update failed"),
        ));
    }
    if show {
        window
            .show()
            .map_err(|error| CanvasError::unavailable(format!("show failed: {error}")))?;
    }
    Ok(result.to_string())
}

fn ensure_canvas_window(app: &AppHandle) -> Result<WebviewWindow, CanvasError> {
    if let Some(window) = app.get_webview_window(CANVAS_LABEL) {
        return Ok(window);
    }
    let url = bundled_canvas_url()?;
    let data_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| CanvasError::unavailable(format!("cache path unavailable: {error}")))?
        .join("canvas-webview");
    WebviewWindowBuilder::new(app, CANVAS_LABEL, WebviewUrl::CustomProtocol(url))
        .title("OpenClaw Canvas")
        .inner_size(900.0, 700.0)
        .visible(false)
        // Canvas is agent-scriptable: it must not share storage with the
        // privileged dashboard window, and must not persist browser state
        // across restarts. A dedicated data_directory gives Tauri a distinct
        // WebContext key so it attaches the openclaw-canvas:// protocol closure;
        // incognito then makes Wry swap in a fresh *ephemeral* context carrying
        // those protocols. Incognito alone reused the default context and lost
        // the handler (page never loaded); the directory alone persisted cookies
        // and origin storage. Both together keep the handler and stay ephemeral.
        .data_directory(data_directory)
        .incognito(true)
        .initialization_script(ACTION_BRIDGE_SCRIPT)
        .on_navigation(|url| matches!(url.scheme(), "http" | "https") || is_bundled_canvas_url(url))
        .build()
        .map_err(|error| CanvasError::unavailable(format!("window creation failed: {error}")))
}

fn ensure_a2ui_host(window: &WebviewWindow) -> Result<(), CanvasError> {
    // `navigate` is asynchronous. Stop any earlier remote load before deciding
    // whether the bundled renderer is already current.
    stop_pending_navigation(window)?;
    let current = window
        .url()
        .map_err(|error| CanvasError::unavailable(format!("could not read URL: {error}")))?;
    let renderer_ready = is_bundled_canvas_url(&current)
        && eval_json_with_timeout(window, &a2ui_ready_script(), A2UI_READY_EVAL_TIMEOUT)
            .is_ok_and(|value| value == Value::Bool(true));
    if !renderer_ready {
        window
            .navigate(bundled_canvas_url()?)
            .map_err(|error| CanvasError::unavailable(format!("A2UI load failed: {error}")))?;
    }
    let deadline = Instant::now() + A2UI_READY_TIMEOUT;
    loop {
        // The loaded page participates in this probe. Check its committed URL
        // in the same evaluation so remote content cannot spoof renderer readiness.
        let ready = eval_json_with_timeout(window, &a2ui_ready_script(), A2UI_READY_EVAL_TIMEOUT);
        if ready
            .as_ref()
            .is_ok_and(|value| value == &Value::Bool(true))
        {
            return Ok(());
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        thread::sleep(A2UI_READY_INTERVAL.min(deadline - now));
    }
    Err(CanvasError::unavailable(
        "A2UI renderer did not become ready",
    ))
}

fn stop_pending_navigation(window: &WebviewWindow) -> Result<(), CanvasError> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |platform| {
            platform.inner().stop_loading();
            let _ = sender.send(());
        })
        .map_err(|error| CanvasError::unavailable(format!("navigation stop failed: {error}")))?;
    receiver
        .recv_timeout(WEBVIEW_TIMEOUT)
        .map_err(|_| CanvasError::unavailable("navigation stop timed out"))
}

fn eval_json(window: &WebviewWindow, script: &str) -> Result<Value, CanvasError> {
    eval_json_with_timeout(window, script, WEBVIEW_TIMEOUT)
}

fn eval_json_with_timeout(
    window: &WebviewWindow,
    script: &str,
    timeout: Duration,
) -> Result<Value, CanvasError> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .eval_with_callback(script, move |result| {
            let _ = sender.send(result);
        })
        .map_err(|error| CanvasError::unavailable(format!("JavaScript failed: {error}")))?;
    let result = receiver
        .recv_timeout(timeout)
        .map_err(|_| CanvasError::unavailable("JavaScript timed out"))?;
    serde_json::from_str(&result)
        .map_err(|error| CanvasError::invalid(format!("JavaScript returned invalid JSON: {error}")))
}

fn evaluation_result_string(result: Value) -> String {
    match result {
        Value::Null => String::new(),
        Value::String(value) => value,
        value => value.to_string(),
    }
}

fn snapshot(window: &WebviewWindow, params: SnapshotParams) -> Result<String, CanvasError> {
    if !matches!(params.format.as_str(), "png" | "jpeg") {
        return Err(CanvasError::invalid("snapshot format must be png or jpeg"));
    }
    if params.max_width == Some(0) {
        return Err(CanvasError::invalid("maxWidth must be greater than zero"));
    }
    if params
        .quality
        .is_some_and(|value| !(0.0..=1.0).contains(&value))
    {
        return Err(CanvasError::invalid("quality must be between 0 and 1"));
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |platform| {
            platform.inner().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let encoded = result
                        .map_err(|error| error.to_string())
                        .and_then(|surface| encode_surface(surface, &params));
                    let _ = sender.send(encoded);
                },
            );
        })
        .map_err(|error| CanvasError::unavailable(format!("snapshot failed: {error}")))?;
    receiver
        .recv_timeout(WEBVIEW_TIMEOUT)
        .map_err(|_| CanvasError::unavailable("snapshot timed out"))?
        .map_err(CanvasError::unavailable)
}

fn encode_surface(surface: cairo::Surface, params: &SnapshotParams) -> Result<String, String> {
    let mut png = Vec::new();
    surface
        .write_to_png(&mut png)
        .map_err(|error| format!("snapshot encoding failed: {error}"))?;
    let mut image = image::load_from_memory_with_format(&png, ImageFormat::Png)
        .map_err(|error| format!("snapshot decoding failed: {error}"))?;
    if let Some(max_width) = params.max_width.filter(|width| image.width() > *width) {
        let height = ((image.height() as f64 * max_width as f64 / image.width() as f64).round()
            as u32)
            .max(1);
        image = image.resize(max_width, height, FilterType::Lanczos3);
    }
    let bytes = if params.format == "jpeg" {
        let mut bytes = Vec::new();
        let quality = (params.quality.unwrap_or(0.8) * 100.0).round() as u8;
        JpegEncoder::new_with_quality(&mut bytes, quality.clamp(1, 100))
            .encode_image(&image)
            .map_err(|error| format!("JPEG encoding failed: {error}"))?;
        bytes
    } else {
        let mut cursor = Cursor::new(Vec::new());
        image
            .write_to(&mut cursor, ImageFormat::Png)
            .map_err(|error| format!("PNG encoding failed: {error}"))?;
        cursor.into_inner()
    };
    Ok(json!({"format": params.format, "base64": BASE64.encode(bytes)}).to_string())
}

fn apply_placement(window: &WebviewWindow, placement: Placement) {
    let scale_factor = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
    let width = placement.width.filter(|value| *value > 0.0);
    let height = placement.height.filter(|value| *value > 0.0);
    if width.is_some() || height.is_some() {
        let current = if width.is_none() || height.is_none() {
            window.inner_size().ok().map(|size| {
                (
                    size.width as f64 / scale_factor,
                    size.height as f64 / scale_factor,
                )
            })
        } else {
            None
        };
        if let (Some(width), Some(height)) = (
            width.or_else(|| current.map(|size| size.0)),
            height.or_else(|| current.map(|size| size.1)),
        ) {
            let _ = window.set_size(LogicalSize::new(width, height));
        }
    }

    if placement.x.is_some() || placement.y.is_some() {
        let current = if placement.x.is_none() || placement.y.is_none() {
            window.outer_position().ok().map(|position| {
                (
                    position.x as f64 / scale_factor,
                    position.y as f64 / scale_factor,
                )
            })
        } else {
            None
        };
        if let (Some(x), Some(y)) = (
            placement.x.or_else(|| current.map(|position| position.0)),
            placement.y.or_else(|| current.map(|position| position.1)),
        ) {
            let _ = window.set_position(LogicalPosition::new(x, y));
        }
    }
}

fn parse_canvas_url(value: &str) -> Result<Url, CanvasError> {
    let url = Url::parse(value).map_err(|_| CanvasError::invalid("Canvas URL is invalid"))?;
    if matches!(url.scheme(), "http" | "https") || is_bundled_canvas_url(&url) {
        return Ok(url);
    }
    Err(CanvasError::invalid(
        "Canvas navigation allows only http(s) or the bundled A2UI renderer",
    ))
}

fn is_bundled_canvas_url(url: &Url) -> bool {
    url.scheme() == CANVAS_SCHEME
        && url.host_str() == Some("localhost")
        && matches!(url.path(), "/" | "/index.html")
}

fn bundled_canvas_url() -> Result<Url, CanvasError> {
    Url::parse(BUNDLED_CANVAS_HREF)
        .map_err(|_| CanvasError::unavailable("bundled A2UI URL is invalid"))
}

fn a2ui_ready_script() -> String {
    format!(
        "Boolean(globalThis.location.href === {href:?} && globalThis.openclawA2UI?.applyMessages && globalThis.openclawA2UI?.reset)",
        href = BUNDLED_CANVAS_HREF
    )
}

fn guarded_a2ui_script(body: &str) -> String {
    format!(
        "(() => {{ try {{ if (globalThis.location.href !== {href:?}) return {{ok:false,error:'A2UI renderer origin changed'}}; {body} }} catch (error) {{ return {{ok:false,error:String(error)}}; }} }})()",
        href = BUNDLED_CANVAS_HREF
    )
}

fn a2ui_reset_script() -> String {
    guarded_a2ui_script("globalThis.openclawA2UI.reset(); return {ok:true};")
}

fn decode_params<T: for<'de> Deserialize<'de>>(params_json: &str) -> Result<T, CanvasError> {
    serde_json::from_str(params_json)
        .map_err(|error| CanvasError::invalid(format!("invalid command parameters: {error}")))
}

fn decode_empty_params(params_json: &str) -> Result<(), CanvasError> {
    let value: Value = decode_params(params_json)?;
    if value.as_object().is_some_and(|object| object.is_empty()) {
        Ok(())
    } else {
        Err(CanvasError::invalid("command parameters must be empty"))
    }
}

fn write_frame(writer: &Arc<Mutex<UnixStream>>, frame: &Value) -> std::io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| std::io::Error::other("Canvas writer mutex poisoned"))?;
    serde_json::to_writer(&mut *writer, frame)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn dispatch_action_status(app: &AppHandle, frame: &Value) {
    let Some(window) = app.get_webview_window(CANVAS_LABEL) else {
        return;
    };
    if window.url().ok().as_ref().map(Url::scheme) != Some(CANVAS_SCHEME) {
        return;
    }
    let detail = json!({
        "id": frame.get("id").and_then(Value::as_str).unwrap_or(""),
        "ok": frame.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "error": frame.get("error").and_then(Value::as_str).unwrap_or("")
    });
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent('openclaw:a2ui-action-status', {{detail:{detail}}}));"
    ));
}

fn socket_path() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR").filter(|value| !value.is_empty()) {
        Some(runtime_dir) => PathBuf::from(runtime_dir).join("openclaw-canvas.sock"),
        // Both independently started processes need the specified rendezvous
        // path. Foreign-owned entries fail closed; desktop startup stays usable.
        None => PathBuf::from(format!("/tmp/openclaw-canvas-{}.sock", unsafe {
            libc::geteuid()
        })),
    }
}

fn prepare_socket_path(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    let uid = unsafe { libc::geteuid() };
    if !metadata.file_type().is_socket() || metadata.uid() != uid {
        return Err("Canvas socket path exists but is not a stale user-owned socket.".to_string());
    }
    let socket_table = fs::read_to_string("/proc/net/unix")
        .map_err(|error| format!("Could not inspect the existing Canvas socket: {error}"))?;
    if socket_table_contains(&socket_table, path) {
        return Err("Another OpenClaw desktop app already owns the Canvas socket.".to_string());
    }
    fs::remove_file(path).map_err(|error| format!("Could not remove stale Canvas socket: {error}"))
}

fn socket_table_contains(socket_table: &str, path: &Path) -> bool {
    let Some(path) = path.to_str() else {
        return false;
    };
    socket_table.lines().any(|line| {
        line.strip_suffix(path)
            .is_some_and(|prefix| prefix.ends_with(' '))
    })
}

fn remove_socket_if_owned(path: &Path, inode: u64) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() && metadata.ino() == inode => {
            fs::remove_file(path)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn peer_uid(stream: &UnixStream) -> std::io::Result<u32> {
    let mut peer = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut peer as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result == 0 {
        Ok(peer.uid)
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_allows_only_http_and_bundled_renderer() {
        assert!(parse_canvas_url("https://example.com/canvas").is_ok());
        assert!(parse_canvas_url("openclaw-canvas://localhost/index.html").is_ok());
        assert!(parse_canvas_url("file:///tmp/secret").is_err());
        assert!(parse_canvas_url("openclaw-canvas://other/index.html").is_err());
    }

    #[test]
    fn a2ui_scripts_require_the_exact_bundled_document() {
        let expected = format!("globalThis.location.href === {BUNDLED_CANVAS_HREF:?}");
        assert!(a2ui_ready_script().contains(&expected));

        let guarded = guarded_a2ui_script("return true;");
        assert!(guarded.contains(&format!(
            "globalThis.location.href !== {BUNDLED_CANVAS_HREF:?}"
        )));
        assert!(guarded.find("location.href").unwrap() < guarded.find("return true").unwrap());

        let reset = a2ui_reset_script();
        assert!(reset.contains("globalThis.openclawA2UI.reset(); return {ok:true};"));
    }

    #[test]
    fn empty_params_are_closed() {
        assert!(decode_empty_params("{}").is_ok());
        assert!(decode_empty_params("{\"extra\":true}").is_err());
    }

    #[test]
    fn ipc_request_uses_camel_case_payload_field() {
        let request: IpcRequest =
            serde_json::from_str(r#"{"id":"1","command":"canvas.hide","paramsJSON":"{}"}"#)
                .expect("request should decode");
        assert_eq!(request.command, "canvas.hide");
        assert_eq!(request.params_json, "{}");
    }

    #[test]
    fn present_accepts_partial_placement() {
        let params: PresentParams =
            serde_json::from_str(r#"{"placement":{"width":640.0,"height":480.0}}"#)
                .expect("partial placement should decode");
        let placement = params.placement.expect("placement should be present");
        assert_eq!(placement.x, None);
        assert_eq!(placement.y, None);
        assert_eq!(placement.width, Some(640.0));
        assert_eq!(placement.height, Some(480.0));
    }

    #[test]
    fn evaluation_results_match_the_canvas_string_contract() {
        assert_eq!(evaluation_result_string(Value::Null), "");
        assert_eq!(evaluation_result_string(json!(true)), "true");
        assert_eq!(evaluation_result_string(json!(42)), "42");
        assert_eq!(evaluation_result_string(json!("hello")), "hello");
        assert_eq!(
            evaluation_result_string(json!({"ok": true})),
            r#"{"ok":true}"#
        );
    }

    #[test]
    fn socket_table_matches_only_the_exact_rendezvous_path() {
        let table = concat!(
            "Num RefCount Protocol Flags Type St Inode Path\n",
            "000: 00000002 00000000 00010000 0001 01 1 /tmp/openclaw-canvas-501.sock.old\n",
            "001: 00000002 00000000 00010000 0001 01 2 /tmp/openclaw-canvas-501.sock\n",
        );
        assert!(socket_table_contains(
            table,
            Path::new("/tmp/openclaw-canvas-501.sock")
        ));
        assert!(!socket_table_contains(
            table,
            Path::new("/tmp/openclaw-canvas-502.sock")
        ));
    }

    #[test]
    fn shutdown_removes_only_the_socket_inode_it_bound() {
        let path =
            std::env::temp_dir().join(format!("openclaw-canvas-test-{}.sock", std::process::id()));
        let _ = fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("test socket should bind");
        let inode = fs::symlink_metadata(&path)
            .expect("test socket should exist")
            .ino();

        remove_socket_if_owned(&path, inode + 1).expect("foreign inode check should succeed");
        assert!(path.exists());
        remove_socket_if_owned(&path, inode).expect("owned socket should be removed");
        assert!(!path.exists());
        drop(listener);
    }
}
