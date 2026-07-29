use crate::gateway_device_identity::{
    GatewayAuth, GatewayDeviceIdentity, GatewayDeviceIdentityStore, CLIENT_DEVICE_FAMILY,
    CLIENT_ID, CLIENT_MODE, CLIENT_PLATFORM, CLIENT_ROLE, CLIENT_SCOPES,
};
use crate::quickchat::QUICKCHAT_LABEL;
use openclaw_gateway_client::{
    reconnect_backoff as gateway_reconnect_backoff, tls_trust, ClientError as SharedClientError,
    ConnectErrorDetails, Event as GatewayEvent, GatewayClient as SharedGatewayClient,
    GatewayClientConfig as SharedGatewayClientConfig, GatewaySession as SharedGatewaySession,
    TlsTrust,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Webview};
use tokio::sync::{mpsc, oneshot};
#[cfg(test)]
use uuid::Uuid;

const AGENT_KIND_CLIENT_CAPABILITY: &str = "agent-kind";
const GATEWAY_STATE_EVENT: &str = "quickchat:gateway-state";
const CHAT_EVENT: &str = "quickchat:chat-event";
const GATEWAY_DEVICE_IDENTITY_FILE: &str = "quickchat-gateway-device.json";
const AGENTS_CACHE_TTL: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(35);
const DRIVER_TICK: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
const PAIRING_REQUIRED_DETAIL_CODE: &str = "PAIRING_REQUIRED";
const AUTH_TOKEN_MISSING_DETAIL_CODE: &str = "AUTH_TOKEN_MISSING";
const AUTH_PASSWORD_MISSING_DETAIL_CODE: &str = "AUTH_PASSWORD_MISSING";

// Mirrors packages/gateway-protocol/src/version.ts. The Gateway rejects other ranges.
const MIN_PROTOCOL_VERSION: u32 = 4;
const MAX_PROTOCOL_VERSION: u32 = 4;
const INLINE_WIDGETS_CLIENT_CAPABILITY: &str = "inline-widgets";

#[derive(Clone)]
pub struct GatewayWsConfig {
    ws_url: String,
    token: Option<String>,
    password: Option<String>,
    tls_fingerprint: Option<String>,
}

impl GatewayWsConfig {
    pub fn new(
        ws_url: String,
        token: Option<String>,
        password: Option<String>,
        tls_fingerprint: Option<String>,
    ) -> Self {
        Self {
            ws_url,
            token,
            password,
            tls_fingerprint,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayAgentIdentity {
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct GatewayAgentSummary {
    pub id: String,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub identity: Option<GatewayAgentIdentity>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentsListResult {
    pub default_id: String,
    pub main_key: String,
    pub scope: String,
    pub agents: Vec<GatewayAgentSummary>,
}

#[derive(Clone)]
struct CachedAgents {
    fetched_at: Instant,
    result: AgentsListResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatSendParams {
    session_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    message: String,
    idempotency_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSendAck {
    run_id: String,
    status: String,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRoutingTarget {
    pub(crate) session_key: String,
    pub(crate) agent_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSendResult {
    #[serde(flatten)]
    pub(crate) target: ChatRoutingTarget,
    pub(crate) run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginSurfaceRefreshResponse {
    plugin_surface_urls: Option<HashMap<String, String>>,
}

enum GatewayRequest {
    AgentsList,
    ChatSend(ChatSendParams),
    RefreshCanvasSurface { observed_url: Option<String> },
}

enum GatewayResponse {
    AgentsList(AgentsListResult),
    ChatSend(ChatSendAck),
    CanvasSurface(Option<String>),
}

enum DriverCommand {
    Request {
        request: GatewayRequest,
        reply: oneshot::Sender<Result<GatewayResponse, String>>,
    },
    Reconfigure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GatewayConnectionState {
    Down = 0,
    Up = 1,
    PairingRequired = 2,
    CredentialRequired = 3,
    TlsFailure = 4,
}

impl GatewayConnectionState {
    fn from_u64(value: u64) -> Self {
        match value {
            1 => Self::Up,
            2 => Self::PairingRequired,
            3 => Self::CredentialRequired,
            4 => Self::TlsFailure,
            _ => Self::Down,
        }
    }

    fn event_name(self) -> &'static str {
        match self {
            Self::Down => "down",
            Self::Up => "up",
            Self::PairingRequired => "pairing-required",
            Self::CredentialRequired => "credential-required",
            Self::TlsFailure => "tls-failure",
        }
    }
}

struct RequestFailure {
    message: String,
    disconnect: bool,
    connect_details: ConnectErrorDetails,
    connect_state: Option<GatewayConnectionState>,
    tls_failure: bool,
}

impl RequestFailure {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            disconnect: true,
            connect_details: ConnectErrorDetails::default(),
            connect_state: None,
            tls_failure: false,
        }
    }

    fn tls(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            disconnect: true,
            connect_details: ConnectErrorDetails::default(),
            connect_state: None,
            tls_failure: true,
        }
    }

    fn method_with_details(message: impl Into<String>, details: Option<&Value>) -> Self {
        Self {
            message: message.into(),
            disconnect: false,
            connect_details: ConnectErrorDetails::from_value(details),
            connect_state: None,
            tls_failure: false,
        }
    }

    fn classify_connect(mut self, auth: &GatewayAuth) -> Self {
        self.connect_state = classify_connect_failure(self.connect_details.code(), !auth.is_none());
        self
    }

    fn from_shared(error: SharedClientError) -> Self {
        match error {
            SharedClientError::Gateway {
                message, details, ..
            } => Self::method_with_details(message, details.as_ref()),
            SharedClientError::Tls(message) => Self::tls(message),
            error => Self::transport(error.to_string()),
        }
    }
}

#[derive(Clone, Default)]
struct CanvasSurfaceState {
    generation: u64,
    url: Option<String>,
}

struct GatewayClientInner {
    config: Mutex<Option<GatewayWsConfig>>,
    config_generation: AtomicU64,
    commands: Mutex<Option<mpsc::Sender<DriverCommand>>>,
    agents_cache: Mutex<Option<CachedAgents>>,
    identity: Mutex<Option<GatewayDeviceIdentityStore>>,
    canvas_surface: Mutex<CanvasSurfaceState>,
    connection_notice: Mutex<Option<String>>,
    connection_state: AtomicU64,
    reconnect_paused: AtomicBool,
    running: AtomicBool,
}

#[derive(Clone)]
pub struct GatewayClient {
    inner: Arc<GatewayClientInner>,
}

impl GatewayClient {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(GatewayClientInner {
                config: Mutex::new(None),
                config_generation: AtomicU64::new(0),
                commands: Mutex::new(None),
                agents_cache: Mutex::new(None),
                identity: Mutex::new(None),
                canvas_surface: Mutex::new(CanvasSurfaceState::default()),
                connection_notice: Mutex::new(None),
                connection_state: AtomicU64::new(GatewayConnectionState::Down as u64),
                reconnect_paused: AtomicBool::new(false),
                running: AtomicBool::new(false),
            }),
        }
    }

    pub fn configure(&self, app: &AppHandle, config: GatewayWsConfig) {
        *self
            .inner
            .config
            .lock()
            .expect("gateway config mutex poisoned") = Some(config);
        *self
            .inner
            .agents_cache
            .lock()
            .expect("gateway agents cache mutex poisoned") = None;
        let generation = self.inner.config_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.set_canvas_surface_url(generation, None);
        self.inner.reconnect_paused.store(false, Ordering::SeqCst);
        self.set_connection_state(app, GatewayConnectionState::Down, None);
        if let Some(commands) = self
            .inner
            .commands
            .lock()
            .expect("gateway command mutex poisoned")
            .as_ref()
        {
            let _ = commands.try_send(DriverCommand::Reconfigure);
        }
    }

    pub fn clear_configuration(&self, app: &AppHandle) {
        *self
            .inner
            .config
            .lock()
            .expect("gateway config mutex poisoned") = None;
        *self
            .inner
            .agents_cache
            .lock()
            .expect("gateway agents cache mutex poisoned") = None;
        let generation = self.inner.config_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.set_canvas_surface_url(generation, None);
        self.inner.reconnect_paused.store(false, Ordering::SeqCst);
        self.set_connection_state(app, GatewayConnectionState::Down, None);
        if let Some(commands) = self
            .inner
            .commands
            .lock()
            .expect("gateway command mutex poisoned")
            .as_ref()
        {
            let _ = commands.try_send(DriverCommand::Reconfigure);
        }
    }

    pub fn activate(&self, app: AppHandle) {
        if self.inner.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let (commands, receiver) = mpsc::channel(16);
        *self
            .inner
            .commands
            .lock()
            .expect("gateway command mutex poisoned") = Some(commands);
        let client = self.clone();
        tauri::async_runtime::spawn(async move {
            client.run_driver(app, receiver).await;
        });
    }

    pub fn emit_current_state(&self, webview: &Webview) -> Result<(), String> {
        let notice = self
            .inner
            .connection_notice
            .lock()
            .map_err(|_| "Gateway connection notice is unavailable.".to_string())?
            .clone();
        webview
            .emit(
                GATEWAY_STATE_EVENT,
                GatewayStateEvent::new(self.connection_state(), notice, self.canvas_surface_url()),
            )
            .map_err(|error| format!("Could not report Gateway connectivity: {error}"))
    }

    pub async fn agents_list(&self) -> Result<AgentsListResult, String> {
        if !self.is_connected() {
            return Err("Gateway unreachable — retrying".to_string());
        }
        let cached = {
            self.inner
                .agents_cache
                .lock()
                .map_err(|_| "Gateway agent cache is unavailable.".to_string())?
                .as_ref()
                .filter(|cached| cached.fetched_at.elapsed() < AGENTS_CACHE_TTL)
                .map(|cached| cached.result.clone())
        };
        if let Some(result) = cached {
            return Ok(result);
        }
        let response = self.request(GatewayRequest::AgentsList).await?;
        let GatewayResponse::AgentsList(result) = response else {
            return Err("Gateway returned the wrong response for agents.list.".to_string());
        };
        self.cache_agents(result.clone());
        Ok(result)
    }

    pub async fn chat_send(
        &self,
        message: String,
        selected_agent_id: &str,
        scope: &str,
        main_key: &str,
        idempotency_key: &str,
    ) -> Result<ChatSendResult, String> {
        let target = routing_target(scope, selected_agent_id, main_key);
        let response = self
            .request(GatewayRequest::ChatSend(ChatSendParams {
                session_key: target.session_key.clone(),
                agent_id: target.agent_id.clone(),
                message,
                idempotency_key: idempotency_key.to_string(),
            }))
            .await?;
        let GatewayResponse::ChatSend(ack) = response else {
            return Err("Gateway returned the wrong response for chat.send.".to_string());
        };
        classify_chat_ack(&ack)?;
        Ok(ChatSendResult {
            target,
            run_id: ack.run_id,
        })
    }

    pub async fn refresh_canvas_surface(&self) -> Result<Option<String>, String> {
        let observed = self.canvas_surface_state();
        if observed.url.is_none() {
            return Ok(None);
        }
        if self.inner.config_generation.load(Ordering::SeqCst) != observed.generation {
            return Err("Gateway Canvas surface generation changed before refresh.".to_string());
        }
        let response = self
            .request(GatewayRequest::RefreshCanvasSurface {
                observed_url: observed.url.clone(),
            })
            .await?;
        let GatewayResponse::CanvasSurface(refreshed) = response else {
            return Err(
                "Gateway returned the wrong response for plugin.surface.refresh.".to_string(),
            );
        };
        let Some(refreshed) = refreshed else {
            return Err("Gateway did not return a refreshed Canvas surface.".to_string());
        };
        let mut current = self
            .inner
            .canvas_surface
            .lock()
            .map_err(|_| "Gateway Canvas surface state is unavailable.".to_string())?;
        if self.inner.config_generation.load(Ordering::SeqCst) != observed.generation
            || current.generation != observed.generation
            || current.url != observed.url
        {
            return Err("Gateway Canvas surface changed during refresh.".to_string());
        }
        current.url = Some(refreshed.clone());
        Ok(Some(refreshed))
    }

    pub fn resume_reconnect(&self) {
        if !self.inner.reconnect_paused.load(Ordering::SeqCst) {
            return;
        }
        if let Some(commands) = self
            .inner
            .commands
            .lock()
            .expect("gateway command mutex poisoned")
            .as_ref()
        {
            let _ = commands.try_send(DriverCommand::Reconfigure);
        }
    }

    async fn request(&self, request: GatewayRequest) -> Result<GatewayResponse, String> {
        if !self.is_connected() {
            return Err("Gateway unreachable — retrying".to_string());
        }
        let commands = self
            .inner
            .commands
            .lock()
            .map_err(|_| "Gateway command queue is unavailable.".to_string())?
            .clone()
            .ok_or_else(|| "Gateway unreachable — retrying".to_string())?;
        let (reply, response) = oneshot::channel();
        commands
            .send(DriverCommand::Request { request, reply })
            .await
            .map_err(|_| "Gateway unreachable — retrying".to_string())?;
        tokio::time::timeout(COMMAND_TIMEOUT, response)
            .await
            .map_err(|_| "Gateway request timed out.".to_string())?
            .map_err(|_| "Gateway connection closed before the request completed.".to_string())?
    }

    async fn run_driver(&self, app: AppHandle, mut receiver: mpsc::Receiver<DriverCommand>) {
        let mut reconnect_attempt = 0_u32;
        loop {
            if app.get_webview_window(QUICKCHAT_LABEL).is_none() {
                self.inner.reconnect_paused.store(false, Ordering::SeqCst);
                self.set_connection_state(&app, GatewayConnectionState::Down, None);
                tokio::time::sleep(DRIVER_TICK).await;
                reconnect_attempt = 0;
                continue;
            }
            let config = self
                .inner
                .config
                .lock()
                .expect("gateway config mutex poisoned")
                .clone();
            let Some(config) = config else {
                self.inner.reconnect_paused.store(false, Ordering::SeqCst);
                self.set_connection_state(&app, GatewayConnectionState::Down, None);
                tokio::time::sleep(DRIVER_TICK).await;
                continue;
            };
            while let Ok(command) = receiver.try_recv() {
                reject_disconnected_command(command);
            }
            let generation = self.inner.config_generation.load(Ordering::SeqCst);
            let connection_result = self
                .connect_and_serve(&app, &config, generation, &mut receiver)
                .await;
            let reached_hello = self.is_connected();
            let failure = connection_result.as_ref().err();
            let disconnected_state = failure
                .and_then(|failure| failure.connect_state)
                .or_else(|| {
                    failure
                        .is_some_and(|failure| failure.tls_failure)
                        .then_some(GatewayConnectionState::TlsFailure)
                })
                .unwrap_or(GatewayConnectionState::Down);
            let pause_reconnect = failure
                .map(|failure| failure.connect_details.should_pause_reconnect())
                .unwrap_or(false);
            let notice = failure.and_then(|failure| {
                connection_notice(
                    disconnected_state,
                    &failure.connect_details,
                    pause_reconnect,
                )
            });
            self.inner
                .reconnect_paused
                .store(pause_reconnect, Ordering::SeqCst);
            self.set_connection_state(&app, disconnected_state, notice);
            if pause_reconnect {
                // Server retry policy is authoritative: explicit pauseReconnect or retryable=false
                // waits for a fresh user summon instead of burning the capped backoff loop.
                loop {
                    let Some(command) = receiver.recv().await else {
                        return;
                    };
                    match command {
                        DriverCommand::Reconfigure => break,
                        command => reject_disconnected_command(command),
                    }
                }
                self.inner.reconnect_paused.store(false, Ordering::SeqCst);
                reconnect_attempt = 0;
                continue;
            }
            reconnect_attempt = if reached_hello {
                1
            } else {
                reconnect_attempt.saturating_add(1)
            };
            if connection_result.is_ok() {
                reconnect_attempt = 1;
            }
            if app.get_webview_window(QUICKCHAT_LABEL).is_none() {
                continue;
            }
            let delay = gateway_reconnect_backoff(reconnect_attempt, MAX_RECONNECT_DELAY);
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                command = receiver.recv() => {
                    if let Some(command) = command {
                        reject_disconnected_command(command);
                    }
                }
            }
        }
    }

    async fn connect_and_serve(
        &self,
        app: &AppHandle,
        config: &GatewayWsConfig,
        generation: u64,
        receiver: &mut mpsc::Receiver<DriverCommand>,
    ) -> Result<(), RequestFailure> {
        let (identity, auth) = self.identity_and_auth(app, config)?;
        let trust = tls_trust(config.tls_fingerprint.as_deref()).map_err(RequestFailure::tls)?;
        if matches!(trust, TlsTrust::Pinned(_)) && !config.ws_url.starts_with("wss://") {
            return Err(RequestFailure::tls(
                "Gateway TLS fingerprint requires a wss:// URL.",
            ));
        }
        let shared_config = SharedGatewayClientConfig::new(&config.ws_url)
            .map_err(|error| RequestFailure::from_shared(error))?
            .tls_trust(trust)
            .challenge_timeout(HANDSHAKE_TIMEOUT)
            .request_timeout(REQUEST_TIMEOUT);
        let inline_widgets_available = config
            .tls_fingerprint
            .as_deref()
            .is_none_or(|value| value.trim().is_empty());
        let connect_identity = identity.clone();
        let connect_auth = auth.clone();
        let connect = SharedGatewayClient::connect(shared_config, move |nonce| async move {
            let signed_at_ms = unix_time_ms()?;
            connect_params(
                &connect_identity,
                &connect_auth,
                &nonce,
                signed_at_ms,
                inline_widgets_available,
            )
        });
        let connect_result = tokio::time::timeout(
            CONNECT_TIMEOUT + HANDSHAKE_TIMEOUT + REQUEST_TIMEOUT,
            connect,
        )
        .await
        .map_err(|_| RequestFailure::transport("Gateway connection timed out."))?;
        let session = match connect_result {
            Ok(session) => session,
            Err(error) => {
                let failure = RequestFailure::from_shared(error).classify_connect(&auth);
                if should_clear_stored_device_token(&failure, &auth) {
                    self.clear_device_token(&config.ws_url)?;
                }
                return Err(failure);
            }
        };
        let hello = validate_hello(session.hello().clone()).map_err(RequestFailure::transport)?;
        drop(auth);
        if let Some(device_token) = hello.device_token.as_deref() {
            self.persist_device_token(&config.ws_url, device_token)?;
        }
        self.set_canvas_surface_url(
            generation,
            gated_canvas_surface_url(hello.canvas_surface_url, inline_widgets_available),
        );

        let agents = request_agents_list(&session).await?;
        if self.inner.config_generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        self.cache_agents(agents);
        self.set_connection_state(app, GatewayConnectionState::Up, None);
        let mut transport_activity = session.subscribe_transport_activity();
        let mut last_gateway_activity = Instant::now();

        loop {
            if self.inner.config_generation.load(Ordering::SeqCst) != generation
                || app.get_webview_window(QUICKCHAT_LABEL).is_none()
            {
                return Ok(());
            }
            tokio::select! {
                command = receiver.recv() => {
                    let Some(command) = command else {
                        return Ok(());
                    };
                    match command {
                        DriverCommand::Reconfigure => return Ok(()),
                        DriverCommand::Request { request, reply } => {
                            let result = perform_request_while_dispatching(app, &session, request).await;
                            last_gateway_activity = Instant::now();
                            match result {
                                Ok(response) => {
                                    let _ = reply.send(Ok(response));
                                }
                                Err(failure) => {
                                    let disconnect = failure.disconnect;
                                    let message = failure.message;
                                    let _ = reply.send(Err(message.clone()));
                                    if disconnect {
                                        return Err(RequestFailure::transport(message));
                                    }
                                }
                            }
                        }
                    }
                }
                event = session.next_event() => {
                    let event = event
                        .map_err(RequestFailure::from_shared)?;
                    dispatch_chat_event(app, &event);
                    last_gateway_activity = Instant::now();
                }
                activity = transport_activity.changed() => {
                    activity.map_err(|_| {
                        RequestFailure::transport("Gateway transport activity ended.")
                    })?;
                    last_gateway_activity = Instant::now();
                }
                _ = tokio::time::sleep(DRIVER_TICK) => {
                    // hello-ok owns the heartbeat cadence. Reconnect after two missed ticks so a
                    // half-open transport cannot leave Quick Chat showing a false connected state.
                    if last_gateway_activity.elapsed() > hello.tick_watch_timeout {
                        return Err(RequestFailure::transport("Gateway tick timeout."));
                    }
                }
            }
        }
    }

    fn identity_and_auth(
        &self,
        app: &AppHandle,
        config: &GatewayWsConfig,
    ) -> Result<(GatewayDeviceIdentity, GatewayAuth), RequestFailure> {
        let mut store =
            self.inner.identity.lock().map_err(|_| {
                RequestFailure::transport("Gateway device identity is unavailable.")
            })?;
        if store.is_none() {
            let path = app
                .path()
                .app_config_dir()
                .map_err(|error| {
                    RequestFailure::transport(format!(
                        "Could not resolve Gateway device identity path: {error}"
                    ))
                })?
                .join(GATEWAY_DEVICE_IDENTITY_FILE);
            *store = Some(
                GatewayDeviceIdentityStore::load_or_create(path)
                    .map_err(RequestFailure::transport)?,
            );
        }
        let store = store.as_ref().expect("gateway identity initialized");
        Ok((
            store.identity(),
            store.select_auth(
                &config.ws_url,
                config.token.as_deref(),
                config.password.as_deref(),
            ),
        ))
    }

    fn persist_device_token(
        &self,
        gateway: &str,
        device_token: &str,
    ) -> Result<(), RequestFailure> {
        let mut store =
            self.inner.identity.lock().map_err(|_| {
                RequestFailure::transport("Gateway device identity is unavailable.")
            })?;
        store
            .as_mut()
            .ok_or_else(|| RequestFailure::transport("Gateway device identity is unavailable."))?
            .persist_device_token(gateway, device_token)
            .map_err(RequestFailure::transport)
    }

    fn clear_device_token(&self, gateway: &str) -> Result<(), RequestFailure> {
        let mut store =
            self.inner.identity.lock().map_err(|_| {
                RequestFailure::transport("Gateway device identity is unavailable.")
            })?;
        store
            .as_mut()
            .ok_or_else(|| RequestFailure::transport("Gateway device identity is unavailable."))?
            .clear_device_token(gateway)
            .map_err(RequestFailure::transport)
    }

    fn cache_agents(&self, result: AgentsListResult) {
        *self
            .inner
            .agents_cache
            .lock()
            .expect("gateway agents cache mutex poisoned") = Some(CachedAgents {
            fetched_at: Instant::now(),
            result,
        });
    }

    fn set_canvas_surface_url(&self, generation: u64, url: Option<String>) {
        let mut surface = self
            .inner
            .canvas_surface
            .lock()
            .expect("gateway canvas surface mutex poisoned");
        if self.inner.config_generation.load(Ordering::SeqCst) == generation {
            *surface = CanvasSurfaceState { generation, url };
        }
    }

    fn canvas_surface_state(&self) -> CanvasSurfaceState {
        self.inner
            .canvas_surface
            .lock()
            .expect("gateway canvas surface mutex poisoned")
            .clone()
    }

    fn canvas_surface_url(&self) -> Option<String> {
        self.canvas_surface_state().url
    }

    fn is_connected(&self) -> bool {
        self.connection_state() == GatewayConnectionState::Up
    }

    fn connection_state(&self) -> GatewayConnectionState {
        GatewayConnectionState::from_u64(self.inner.connection_state.load(Ordering::SeqCst))
    }

    fn set_connection_state(
        &self,
        app: &AppHandle,
        state: GatewayConnectionState,
        notice: Option<String>,
    ) {
        if state != GatewayConnectionState::Up {
            *self
                .inner
                .agents_cache
                .lock()
                .expect("gateway agents cache mutex poisoned") = None;
            self.set_canvas_surface_url(self.inner.config_generation.load(Ordering::SeqCst), None);
        }
        let notice_changed = {
            let mut current = self
                .inner
                .connection_notice
                .lock()
                .expect("gateway connection notice mutex poisoned");
            if *current == notice {
                false
            } else {
                *current = notice.clone();
                true
            }
        };
        let state_changed = self
            .inner
            .connection_state
            .swap(state as u64, Ordering::SeqCst)
            != state as u64;
        if !state_changed && !notice_changed {
            return;
        }
        let _ = app.emit_to(
            QUICKCHAT_LABEL,
            GATEWAY_STATE_EVENT,
            GatewayStateEvent::new(state, notice, self.canvas_surface_url()),
        );
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayStateEvent {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    canvas_surface_url: Option<String>,
}

impl GatewayStateEvent {
    fn new(
        state: GatewayConnectionState,
        notice: Option<String>,
        canvas_surface_url: Option<String>,
    ) -> Self {
        Self {
            state: state.event_name(),
            notice,
            canvas_surface_url,
        }
    }
}

fn reject_disconnected_command(command: DriverCommand) {
    if let DriverCommand::Request { reply, .. } = command {
        let _ = reply.send(Err("Gateway unreachable — retrying".to_string()));
    }
}

fn routing_target(scope: &str, selected_agent_id: &str, main_key: &str) -> ChatRoutingTarget {
    if scope.trim().eq_ignore_ascii_case("global") {
        ChatRoutingTarget {
            session_key: "global".to_string(),
            agent_id: Some(selected_agent_id.to_string()),
        }
    } else {
        ChatRoutingTarget {
            session_key: format!("agent:{selected_agent_id}:{main_key}"),
            // Canonical agent keys already encode ownership; a redundant agentId is rejected.
            agent_id: None,
        }
    }
}

fn classify_connect_failure(
    detail_code: Option<&str>,
    has_local_credential: bool,
) -> Option<GatewayConnectionState> {
    if detail_code == Some(PAIRING_REQUIRED_DETAIL_CODE) {
        return Some(GatewayConnectionState::PairingRequired);
    }
    let credential_required = !has_local_credential
        && detail_code.is_some_and(|code| {
            code == AUTH_TOKEN_MISSING_DETAIL_CODE
                || code == AUTH_PASSWORD_MISSING_DETAIL_CODE
                || (code.starts_with("AUTH_") && code.ends_with("_MISMATCH"))
        });
    credential_required.then_some(GatewayConnectionState::CredentialRequired)
}

fn short_device_id(device_id: &str) -> Option<String> {
    let short = device_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>();
    (!short.is_empty()).then_some(short)
}

fn connection_notice(
    state: GatewayConnectionState,
    details: &ConnectErrorDetails,
    reconnect_paused: bool,
) -> Option<String> {
    let fallback = match state {
        GatewayConnectionState::PairingRequired => "Approve this device in the dashboard (Nodes)",
        GatewayConnectionState::CredentialRequired => {
            "Gateway requires a credential — open the dashboard on the gateway host"
        }
        _ if reconnect_paused => "Gateway connection paused — reopen Quick Chat to retry",
        _ => return None,
    };
    // The Gateway owns recovery semantics and can give more precise operator guidance than this
    // client. Keep only its bounded plain-text hint, then add the safe pairing identifier.
    let mut notice = details
        .remediation_hint()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| fallback.to_string());
    if state == GatewayConnectionState::PairingRequired {
        if let Some(device_id) = details.device_id().and_then(short_device_id) {
            notice.push_str(" · Device ");
            notice.push_str(&device_id);
        }
    }
    Some(notice)
}

fn should_clear_stored_device_token(failure: &RequestFailure, auth: &GatewayAuth) -> bool {
    matches!(auth, GatewayAuth::DeviceToken(_))
        && failure.connect_details.invalidates_device_token()
}

fn connect_params(
    identity: &GatewayDeviceIdentity,
    auth: &GatewayAuth,
    nonce: &str,
    signed_at_ms: u64,
    inline_widgets_available: bool,
) -> Result<Value, String> {
    let mut client_caps = vec![AGENT_KIND_CLIENT_CAPABILITY];
    if inline_widgets_available {
        client_caps.push(INLINE_WIDGETS_CLIENT_CAPABILITY);
    }
    let mut params = json!({
        "minProtocol": MIN_PROTOCOL_VERSION,
        "maxProtocol": MAX_PROTOCOL_VERSION,
        "client": {
            "id": CLIENT_ID,
            "version": env!("CARGO_PKG_VERSION"),
            "platform": CLIENT_PLATFORM,
            "mode": CLIENT_MODE,
            "deviceFamily": CLIENT_DEVICE_FAMILY
        },
        "caps": client_caps,
        "commands": [],
        "permissions": {},
        "role": CLIENT_ROLE,
        "scopes": CLIENT_SCOPES
    });
    if let Some(auth) = auth.json() {
        params["auth"] = auth;
    }
    params["device"] = identity.signed_device(auth, nonce, signed_at_ms)?;
    Ok(params)
}

#[cfg(test)]
fn request_frame(id: &str, method: &str, params: Value) -> Value {
    json!({ "type": "req", "id": id, "method": method, "params": params })
}

async fn perform_request_while_dispatching(
    app: &AppHandle,
    session: &SharedGatewaySession,
    request: GatewayRequest,
) -> Result<GatewayResponse, RequestFailure> {
    let request = perform_request(session, request);
    tokio::pin!(request);
    loop {
        tokio::select! {
            result = &mut request => return result,
            event = session.next_event() => {
                let event = event.map_err(RequestFailure::from_shared)?;
                dispatch_chat_event(app, &event);
            }
        }
    }
}

async fn perform_request(
    session: &SharedGatewaySession,
    request: GatewayRequest,
) -> Result<GatewayResponse, RequestFailure> {
    match request {
        GatewayRequest::AgentsList => request_agents_list(session)
            .await
            .map(GatewayResponse::AgentsList),
        GatewayRequest::ChatSend(params) => {
            let params = serde_json::to_value(params).map_err(|error| {
                RequestFailure::transport(format!("Could not encode chat.send: {error}"))
            })?;
            let payload = session
                .request("chat.send", params)
                .await
                .map_err(|error| RequestFailure::from_shared(error))?;
            serde_json::from_value(payload)
                .map(GatewayResponse::ChatSend)
                .map_err(|error| {
                    RequestFailure::transport(format!("Invalid chat.send response: {error}"))
                })
        }
        GatewayRequest::RefreshCanvasSurface { observed_url } => {
            let mut params = json!({ "surface": "canvas" });
            if let Some(observed_url) = observed_url {
                params["observedUrl"] = Value::String(observed_url);
            }
            let payload = session
                .request("plugin.surface.refresh", params)
                .await
                .map_err(|error| RequestFailure::from_shared(error))?;
            let response: PluginSurfaceRefreshResponse =
                serde_json::from_value(payload).map_err(|error| {
                    RequestFailure::transport(format!(
                        "Invalid plugin.surface.refresh response: {error}"
                    ))
                })?;
            let canvas = response
                .plugin_surface_urls
                .and_then(|urls| urls.get("canvas").cloned())
                .map(|url| url.trim().to_string())
                .filter(|url| !url.is_empty());
            Ok(GatewayResponse::CanvasSurface(canvas))
        }
    }
}

async fn request_agents_list(
    session: &SharedGatewaySession,
) -> Result<AgentsListResult, RequestFailure> {
    let payload = session
        .request("agents.list", json!({}))
        .await
        .map_err(|error| RequestFailure::from_shared(error))?;
    serde_json::from_value(payload).map_err(|error| {
        RequestFailure::transport(format!("Invalid agents.list response: {error}"))
    })
}

struct ValidatedHello {
    device_token: Option<String>,
    tick_watch_timeout: Duration,
    canvas_surface_url: Option<String>,
}

impl ValidatedHello {
    fn new(
        device_token: Option<String>,
        tick_watch_timeout: Duration,
        canvas_surface_url: Option<String>,
    ) -> Self {
        Self {
            device_token,
            tick_watch_timeout,
            canvas_surface_url,
        }
    }
}

fn gated_canvas_surface_url(
    canvas_surface_url: Option<String>,
    inline_widgets_available: bool,
) -> Option<String> {
    inline_widgets_available
        .then_some(canvas_surface_url)
        .flatten()
}

fn validate_hello(payload: Value) -> Result<ValidatedHello, String> {
    #[derive(Deserialize)]
    struct HelloFeatures {
        methods: Vec<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HelloOk {
        #[serde(rename = "type")]
        kind: String,
        protocol: u32,
        features: HelloFeatures,
        auth: HelloAuth,
        policy: Option<HelloPolicy>,
        plugin_surface_urls: Option<HashMap<String, String>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HelloAuth {
        device_token: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HelloPolicy {
        tick_interval_ms: Option<u64>,
    }
    let hello: HelloOk = serde_json::from_value(payload)
        .map_err(|error| format!("Invalid Gateway hello response: {error}"))?;
    if hello.kind != "hello-ok" || hello.protocol != MAX_PROTOCOL_VERSION {
        return Err("Gateway negotiated an unsupported protocol.".to_string());
    }
    for required in ["agents.list", "chat.send"] {
        if !hello
            .features
            .methods
            .iter()
            .any(|method| method == required)
        {
            return Err(format!(
                "Gateway does not advertise required method {required}."
            ));
        }
    }
    let tick_interval_ms = hello
        .policy
        .and_then(|policy| policy.tick_interval_ms)
        .unwrap_or(30_000)
        .max(1);
    let issued_device_auth = hello.auth.device_token;
    let canvas_surface_url = hello
        .plugin_surface_urls
        .and_then(|surface_urls| surface_urls.get("canvas").cloned())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(ValidatedHello::new(
        issued_device_auth,
        Duration::from_millis(tick_interval_ms).saturating_mul(2),
        canvas_surface_url,
    ))
}

fn classify_chat_ack(ack: &ChatSendAck) -> Result<(), String> {
    match ack.status.trim().to_ascii_lowercase().as_str() {
        "ok" | "started" | "in_flight" => Ok(()),
        "error" | "timeout" => Err(ack_error_message(ack)),
        status => Err(format!(
            "Gateway returned unexpected chat.send status \"{status}\"."
        )),
    }
}

fn ack_error_message(ack: &ChatSendAck) -> String {
    ack.message
        .clone()
        .or_else(|| {
            ack.error
                .as_ref()
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            ack.error
                .as_ref()
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| format!("Gateway chat.send {}.", ack.status))
}

fn dispatch_chat_event(app: &AppHandle, frame: &GatewayEvent) {
    if frame.event != "chat" {
        return;
    }
    // Payload stays raw so the WebView can mirror Gateway delta assembly without native drift.
    let _ = app.emit_to(QUICKCHAT_LABEL, CHAT_EVENT, frame.payload.clone());
}

fn unix_time_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("Could not read system time: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_matches_macos_quick_chat_contract() {
        assert_eq!(
            routing_target("global", "work", "main"),
            ChatRoutingTarget {
                session_key: "global".to_string(),
                agent_id: Some("work".to_string()),
            }
        );
        assert_eq!(
            routing_target("per-sender", "work", "main"),
            ChatRoutingTarget {
                session_key: "agent:work:main".to_string(),
                agent_id: None,
            }
        );
        assert_eq!(
            serde_json::to_value(routing_target("global", "work", "main"))
                .expect("serialized routing target"),
            json!({ "sessionKey": "global", "agentId": "work" })
        );
    }

    #[test]
    fn agents_list_result_uses_gateway_routing_and_render_fields() {
        let result = serde_json::from_value::<AgentsListResult>(json!({
            "defaultId": "main",
            "mainKey": "main",
            "scope": "per-sender",
            "agents": [{
                "id": "main",
                "name": "Main",
                "identity": {
                    "name": "Molty",
                    "emoji": "🦞",
                    "avatarUrl": "data:image/png;base64,AA=="
                }
            }]
        }))
        .expect("agents.list result");

        assert_eq!(result.default_id, "main");
        assert_eq!(result.main_key, "main");
        assert_eq!(result.scope, "per-sender");
        assert_eq!(
            result.agents[0]
                .identity
                .as_ref()
                .and_then(|identity| identity.avatar_url.as_deref()),
            Some("data:image/png;base64,AA==")
        );
    }

    #[test]
    fn chat_ack_acceptance_is_explicit() {
        for status in ["ok", "started", "in_flight"] {
            assert!(classify_chat_ack(&ChatSendAck {
                run_id: "run-1".to_string(),
                status: status.to_string(),
                error: None,
                message: None,
            })
            .is_ok());
        }
        for status in ["error", "timeout", "queued"] {
            assert!(classify_chat_ack(&ChatSendAck {
                run_id: "run-1".to_string(),
                status: status.to_string(),
                error: Some(json!({ "message": "not accepted" })),
                message: None,
            })
            .is_err());
        }
    }

    #[test]
    fn tls_failures_have_a_distinct_connectivity_state() {
        let failure =
            RequestFailure::from_shared(SharedClientError::Tls("certificate mismatch".to_string()));
        assert!(failure.tls_failure);
        assert_eq!(
            GatewayConnectionState::TlsFailure.event_name(),
            "tls-failure"
        );
    }

    #[test]
    fn connect_frame_matches_gateway_schema() {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-linux-connect-frame-test-{}",
            Uuid::new_v4()
        ));
        let store = GatewayDeviceIdentityStore::load_or_create(directory.join("identity.json"))
            .expect("device identity");
        let params = connect_params(
            &store.identity(),
            &GatewayAuth::SharedToken("secret".to_string()),
            "fixture-nonce",
            1_800_000_000_000,
            true,
        )
        .expect("connect params");
        let frame = request_frame("connect-1", "connect", params);

        assert_eq!(frame["type"], "req");
        assert_eq!(frame["id"], "connect-1");
        assert_eq!(frame["method"], "connect");
        assert_eq!(frame["params"]["minProtocol"], MIN_PROTOCOL_VERSION);
        assert_eq!(frame["params"]["maxProtocol"], MAX_PROTOCOL_VERSION);
        assert_eq!(
            frame["params"]["caps"],
            json!([
                AGENT_KIND_CLIENT_CAPABILITY,
                INLINE_WIDGETS_CLIENT_CAPABILITY
            ])
        );
        assert_eq!(frame["params"]["client"]["id"], CLIENT_ID);
        assert_eq!(
            frame["params"]["client"]["deviceFamily"],
            CLIENT_DEVICE_FAMILY
        );
        assert_eq!(frame["params"]["auth"], json!({ "token": "secret" }));
        assert_eq!(frame["params"]["device"]["nonce"], "fixture-nonce");
        assert_eq!(frame["params"]["device"]["signedAt"], 1_800_000_000_000_u64);
        assert_eq!(
            frame["params"]["device"]["id"]
                .as_str()
                .expect("device id")
                .len(),
            64
        );
        assert!(frame["params"]["device"]["publicKey"]
            .as_str()
            .is_some_and(|value| !value.contains('=')));
        assert!(frame["params"]["device"]["signature"]
            .as_str()
            .is_some_and(|value| !value.contains('=')));

        let pinned_params = connect_params(
            &store.identity(),
            &GatewayAuth::SharedToken("secret".to_string()),
            "fixture-nonce",
            1_800_000_000_000,
            false,
        )
        .expect("pinned connect params");
        // Pinning only withdraws inline widgets; agent-kind is unconditional.
        assert_eq!(pinned_params["caps"], json!([AGENT_KIND_CLIENT_CAPABILITY]));
        std::fs::remove_dir_all(directory).expect("remove connect fixture");
    }

    #[test]
    fn hello_tick_policy_sets_two_interval_watchdog() {
        let hello = validate_hello(json!({
            "type": "hello-ok",
            "protocol": MAX_PROTOCOL_VERSION,
            "features": { "methods": ["agents.list", "chat.send"] },
            "auth": { "deviceToken": "test-device-token" },
            "policy": { "tickIntervalMs": 1_250 },
            "pluginSurfaceUrls": {
                "canvas": "https://gateway.example/__openclaw__/cap/fixture-capability"
            }
        }))
        .expect("valid hello");

        assert_eq!(hello.device_token.as_deref(), Some("test-device-token"));
        assert_eq!(hello.tick_watch_timeout, Duration::from_millis(2_500));
        assert_eq!(
            hello.canvas_surface_url.as_deref(),
            Some("https://gateway.example/__openclaw__/cap/fixture-capability")
        );
        assert_eq!(
            gated_canvas_surface_url(hello.canvas_surface_url.clone(), true),
            hello.canvas_surface_url
        );
        assert_eq!(
            gated_canvas_surface_url(hello.canvas_surface_url, false),
            None
        );
    }

    #[test]
    fn plugin_surface_refresh_response_decodes_canvas_url() {
        let response: PluginSurfaceRefreshResponse = serde_json::from_value(json!({
            "pluginSurfaceUrls": {
                "canvas": "https://gateway.example/__openclaw__/cap/refreshed-capability"
            }
        }))
        .expect("refresh response");

        assert_eq!(
            response
                .plugin_surface_urls
                .and_then(|urls| urls.get("canvas").cloned())
                .as_deref(),
            Some("https://gateway.example/__openclaw__/cap/refreshed-capability")
        );
    }

    #[test]
    fn gateway_state_event_carries_canvas_surface_in_camel_case() {
        let event = serde_json::to_value(GatewayStateEvent::new(
            GatewayConnectionState::Up,
            None,
            Some("https://gateway.example/__openclaw__/cap/fixture-capability".to_string()),
        ))
        .expect("serialize gateway state");

        assert_eq!(
            event["canvasSurfaceUrl"],
            "https://gateway.example/__openclaw__/cap/fixture-capability"
        );
        assert!(event.get("canvas_surface_url").is_none());
    }

    #[test]
    fn connect_classification_separates_pairing_and_missing_credentials() {
        assert_eq!(
            classify_connect_failure(Some(PAIRING_REQUIRED_DETAIL_CODE), true),
            Some(GatewayConnectionState::PairingRequired)
        );
        assert_eq!(
            classify_connect_failure(Some(AUTH_TOKEN_MISSING_DETAIL_CODE), false),
            Some(GatewayConnectionState::CredentialRequired)
        );
        assert_eq!(
            classify_connect_failure(Some("AUTH_TOKEN_MISMATCH"), false),
            Some(GatewayConnectionState::CredentialRequired)
        );
        assert_eq!(
            classify_connect_failure(Some("AUTH_TOKEN_MISMATCH"), true),
            None
        );
        assert_eq!(
            GatewayConnectionState::CredentialRequired.event_name(),
            "credential-required"
        );

        let pairing_details = json!({ "code": PAIRING_REQUIRED_DETAIL_CODE });
        let pending =
            RequestFailure::method_with_details("pairing required", Some(&pairing_details))
                .classify_connect(&GatewayAuth::SharedToken("bootstrap".to_string()));
        assert_eq!(
            pending.connect_state,
            Some(GatewayConnectionState::PairingRequired)
        );

        let missing_details = json!({ "code": AUTH_TOKEN_MISSING_DETAIL_CODE });
        let missing_auth_failure =
            RequestFailure::method_with_details("token missing", Some(&missing_details))
                .classify_connect(&GatewayAuth::None);
        assert_eq!(
            missing_auth_failure.connect_state,
            Some(GatewayConnectionState::CredentialRequired)
        );

        let mismatch_details = json!({ "code": "AUTH_TOKEN_MISMATCH" });
        let mismatch_without_auth =
            RequestFailure::method_with_details("token mismatch", Some(&mismatch_details))
                .classify_connect(&GatewayAuth::None);
        assert_eq!(
            mismatch_without_auth.connect_state,
            Some(GatewayConnectionState::CredentialRequired)
        );
        let mismatch_with_auth =
            RequestFailure::method_with_details("token mismatch", Some(&mismatch_details))
                .classify_connect(&GatewayAuth::SharedToken("configured".to_string()));
        assert_eq!(mismatch_with_auth.connect_state, None);

        let stale_device_details =
            json!({ "code": openclaw_gateway_client::AUTH_DEVICE_TOKEN_MISMATCH_DETAIL_CODE });
        let stale_device_auth = RequestFailure::method_with_details(
            "device token mismatch",
            Some(&stale_device_details),
        )
        .classify_connect(&GatewayAuth::DeviceToken("stale".to_string()));
        assert_eq!(stale_device_auth.connect_state, None);
        assert!(should_clear_stored_device_token(
            &stale_device_auth,
            &GatewayAuth::DeviceToken("stale".to_string())
        ));
    }

    #[test]
    fn connection_notices_prefer_server_guidance_and_shorten_device_ids() {
        let details = ConnectErrorDetails::from_value(Some(&json!({
            "remediationHint": "Use the Nodes approval queue.",
            "deviceId": "abcdef1234567890"
        })));
        assert_eq!(
            connection_notice(GatewayConnectionState::PairingRequired, &details, true).as_deref(),
            Some("Use the Nodes approval queue. · Device abcdef12")
        );
        assert_eq!(
            connection_notice(
                GatewayConnectionState::CredentialRequired,
                &ConnectErrorDetails::default(),
                true,
            )
            .as_deref(),
            Some("Gateway requires a credential — open the dashboard on the gateway host")
        );
        assert_eq!(
            connection_notice(
                GatewayConnectionState::Down,
                &ConnectErrorDetails::from_value(Some(&json!({
                    "remediationHint": "Replace the configured credential."
                }))),
                true,
            )
            .as_deref(),
            Some("Replace the configured credential.")
        );
    }

    #[test]
    fn chat_send_frame_matches_gateway_schema() {
        let params = ChatSendParams {
            session_key: "agent:work:main".to_string(),
            agent_id: None,
            message: "hello".to_string(),
            idempotency_key: "idempotency-1".to_string(),
        };
        assert_eq!(
            request_frame(
                "chat-1",
                "chat.send",
                serde_json::to_value(params).expect("chat params")
            ),
            json!({
                "type": "req",
                "id": "chat-1",
                "method": "chat.send",
                "params": {
                    "sessionKey": "agent:work:main",
                    "message": "hello",
                    "idempotencyKey": "idempotency-1"
                }
            })
        );
    }

    #[test]
    fn chat_send_result_flattens_route_and_ack_run_id() {
        let result = ChatSendResult {
            target: routing_target("global", "work", "main"),
            run_id: "run-1".to_string(),
        };
        assert_eq!(
            serde_json::to_value(result).expect("serialized chat send result"),
            json!({ "sessionKey": "global", "agentId": "work", "runId": "run-1" })
        );
    }
}
