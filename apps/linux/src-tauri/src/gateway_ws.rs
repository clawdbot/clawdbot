use crate::gateway_device_identity::{
    GatewayAuth, GatewayDeviceIdentity, GatewayDeviceIdentityStore, CLIENT_DEVICE_FAMILY,
    CLIENT_ID, CLIENT_MODE, CLIENT_PLATFORM, CLIENT_ROLE, CLIENT_SCOPES,
};
use crate::quickchat::QUICKCHAT_LABEL;
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::io::ErrorKind;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter, Manager, Webview};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{Error as TungsteniteError, Message};
use tokio_tungstenite::{
    connect_async, connect_async_tls_with_config, Connector, MaybeTlsStream, WebSocketStream,
};
use uuid::Uuid;

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
const AUTH_DEVICE_TOKEN_MISMATCH_DETAIL_CODE: &str = "AUTH_DEVICE_TOKEN_MISMATCH";
const TLS_PIN_MISMATCH_ERROR: &str = "Gateway TLS certificate fingerprint mismatch";

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

#[derive(Clone, Debug, Eq, PartialEq)]
enum TlsTrustDecision {
    SystemRoots,
    Pinned([u8; 32]),
}

fn tls_trust_decision(fingerprint: Option<&str>) -> Result<TlsTrustDecision, String> {
    fingerprint
        .map(parse_tls_fingerprint)
        .transpose()
        .map(|fingerprint| {
            fingerprint.map_or(TlsTrustDecision::SystemRoots, TlsTrustDecision::Pinned)
        })
}

fn parse_tls_fingerprint(raw: &str) -> Result<[u8; 32], String> {
    let value = raw.trim();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Gateway TLS fingerprint must be 64 hexadecimal characters.".to_string());
    }
    let mut fingerprint = [0_u8; 32];
    for (index, byte) in fingerprint.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Gateway TLS fingerprint is invalid.".to_string())?;
    }
    Ok(fingerprint)
}

fn pinned_fingerprint_matches(expected: &[u8; 32], certificate_der: &[u8]) -> bool {
    let observed: [u8; 32] = Sha256::digest(certificate_der).into();
    bool::from(expected.as_slice().ct_eq(observed.as_slice()))
}

struct GatewayTlsPinVerifier {
    expected: [u8; 32],
    supported_algorithms: WebPkiSupportedAlgorithms,
}

impl fmt::Debug for GatewayTlsPinVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayTlsPinVerifier")
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for GatewayTlsPinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        // The local CLI authenticates this exact leaf-certificate hash before handing it to the
        // app. A present pin replaces CA/hostname trust, matching OpenClawKit; the signature
        // methods below still prove the peer owns the certificate's private key.
        if pinned_fingerprint_matches(&self.expected, end_entity.as_ref()) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(RustlsError::General(TLS_PIN_MISMATCH_ERROR.to_string()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(message, cert, signature, &self.supported_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, signature, &self.supported_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported_algorithms.supported_schemes()
    }
}

fn pinned_tls_connector(expected: [u8; 32]) -> Result<Connector, String> {
    let provider = rustls::crypto::ring::default_provider();
    let verifier = GatewayTlsPinVerifier {
        expected,
        supported_algorithms: provider.signature_verification_algorithms,
    };
    let config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("Could not configure Gateway TLS: {error}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
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

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ConnectErrorDetails {
    code: Option<String>,
    device_id: Option<String>,
    remediation_hint: Option<String>,
    retryable: Option<bool>,
    pause_reconnect: Option<bool>,
}

impl ConnectErrorDetails {
    fn from_value(value: Option<&Value>) -> Self {
        let Some(value) = value else {
            return Self::default();
        };
        Self {
            code: connect_detail_text(value.get("code"), 80),
            device_id: connect_detail_text(value.get("deviceId"), 128),
            remediation_hint: connect_detail_text(value.get("remediationHint"), 240),
            retryable: value.get("retryable").and_then(Value::as_bool),
            pause_reconnect: value.get("pauseReconnect").and_then(Value::as_bool),
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
        self.connect_state =
            classify_connect_failure(self.connect_details.code.as_deref(), !auth.is_none());
        self
    }
}

struct GatewayClientInner {
    config: Mutex<Option<GatewayWsConfig>>,
    config_generation: AtomicU64,
    commands: Mutex<Option<mpsc::Sender<DriverCommand>>>,
    agents_cache: Mutex<Option<CachedAgents>>,
    identity: Mutex<Option<GatewayDeviceIdentityStore>>,
    canvas_surface_url: Mutex<Option<String>>,
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
                canvas_surface_url: Mutex::new(None),
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
        self.inner.config_generation.fetch_add(1, Ordering::SeqCst);
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
        self.inner.config_generation.fetch_add(1, Ordering::SeqCst);
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
        let observed_url = self.canvas_surface_url();
        if observed_url.is_none() {
            return Ok(None);
        }
        let response = self
            .request(GatewayRequest::RefreshCanvasSurface { observed_url })
            .await?;
        let GatewayResponse::CanvasSurface(refreshed) = response else {
            return Err(
                "Gateway returned the wrong response for plugin.surface.refresh.".to_string(),
            );
        };
        self.set_canvas_surface_url(refreshed.clone());
        Ok(refreshed)
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
                .map(|failure| should_pause_reconnect(&failure.connect_details))
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
            let delay = reconnect_backoff(reconnect_attempt);
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
        let mut socket = tokio::time::timeout(CONNECT_TIMEOUT, connect_gateway_socket(config))
            .await
            .map_err(|_| RequestFailure::transport("Gateway connection timed out."))??;
        let nonce = wait_for_connect_challenge(&mut socket).await?;
        let signed_at_ms = unix_time_ms().map_err(RequestFailure::transport)?;
        // Native child WebViews use platform HTTP trust and cannot bind the optional
        // WebSocket leaf pin, so pinned Gateway connections remain capability-free.
        let inline_widgets_available = config
            .tls_fingerprint
            .as_deref()
            .is_none_or(|value| value.trim().is_empty());
        let params = connect_params(
            &identity,
            &auth,
            &nonce,
            signed_at_ms,
            inline_widgets_available,
        )
        .map_err(RequestFailure::transport)?;
        let hello = match request_on_socket(app, &mut socket, "connect", params).await {
            Ok(hello) => hello,
            Err(failure) => {
                let failure = failure.classify_connect(&auth);
                if should_clear_stored_device_token(&failure, &auth) {
                    self.clear_device_token(&config.ws_url)?;
                }
                return Err(failure);
            }
        };
        drop(auth);
        let hello = validate_hello(hello).map_err(RequestFailure::transport)?;
        if let Some(device_token) = hello.device_token.as_deref() {
            self.persist_device_token(&config.ws_url, device_token)?;
        }
        self.set_canvas_surface_url(gated_canvas_surface_url(
            hello.canvas_surface_url,
            inline_widgets_available,
        ));

        let agents = request_agents_list(app, &mut socket).await?;
        if self.inner.config_generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        self.cache_agents(agents);
        self.set_connection_state(app, GatewayConnectionState::Up, None);
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
                            let result = perform_request(app, &mut socket, request).await;
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
                incoming = socket.next() => {
                    handle_idle_message(app, &mut socket, incoming).await?;
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

    fn set_canvas_surface_url(&self, canvas_surface_url: Option<String>) {
        *self
            .inner
            .canvas_surface_url
            .lock()
            .expect("gateway canvas surface mutex poisoned") = canvas_surface_url;
    }

    fn canvas_surface_url(&self) -> Option<String> {
        self.inner
            .canvas_surface_url
            .lock()
            .expect("gateway canvas surface mutex poisoned")
            .clone()
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
            self.set_canvas_surface_url(None);
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

fn connect_detail_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let normalized = value
        .and_then(Value::as_str)?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(max_chars).collect())
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

fn should_pause_reconnect(details: &ConnectErrorDetails) -> bool {
    details.pause_reconnect == Some(true) || details.retryable == Some(false)
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
        .remediation_hint
        .clone()
        .unwrap_or_else(|| fallback.to_string());
    if state == GatewayConnectionState::PairingRequired {
        if let Some(device_id) = details.device_id.as_deref().and_then(short_device_id) {
            notice.push_str(" · Device ");
            notice.push_str(&device_id);
        }
    }
    Some(notice)
}

fn reconnect_backoff(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(5);
    Duration::from_secs((1_u64 << shift).min(MAX_RECONNECT_DELAY.as_secs()))
}

fn should_clear_stored_device_token(failure: &RequestFailure, auth: &GatewayAuth) -> bool {
    matches!(auth, GatewayAuth::DeviceToken(_))
        && failure.connect_details.code.as_deref() == Some(AUTH_DEVICE_TOKEN_MISMATCH_DETAIL_CODE)
}

fn connect_params(
    identity: &GatewayDeviceIdentity,
    auth: &GatewayAuth,
    nonce: &str,
    signed_at_ms: u64,
    inline_widgets_available: bool,
) -> Result<Value, String> {
    let client_caps = if inline_widgets_available {
        vec![INLINE_WIDGETS_CLIENT_CAPABILITY]
    } else {
        Vec::new()
    };
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

fn request_frame(id: &str, method: &str, params: Value) -> Value {
    json!({
        "type": "req",
        "id": id,
        "method": method,
        "params": params
    })
}

async fn wait_for_connect_challenge(socket: &mut GatewaySocket) -> Result<String, RequestFailure> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        loop {
            let value = next_json(socket).await?;
            if value.get("type").and_then(Value::as_str) == Some("event")
                && value.get("event").and_then(Value::as_str) == Some("connect.challenge")
            {
                let nonce = value
                    .get("payload")
                    .and_then(|payload| payload.get("nonce"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|nonce| !nonce.is_empty());
                return nonce
                    .map(ToOwned::to_owned)
                    .ok_or_else(|| RequestFailure::transport("Gateway challenge omitted nonce."));
            }
        }
    })
    .await
    .map_err(|_| RequestFailure::transport("Gateway connect challenge timed out."))?
}

async fn request_on_socket(
    app: &AppHandle,
    socket: &mut GatewaySocket,
    method: &str,
    params: Value,
) -> Result<Value, RequestFailure> {
    let id = Uuid::new_v4().to_string();
    let encoded = serde_json::to_string(&request_frame(&id, method, params)).map_err(|error| {
        RequestFailure::transport(format!("Could not encode {method}: {error}"))
    })?;
    socket
        .send(Message::Text(encoded.into()))
        .await
        .map_err(|error| RequestFailure::transport(format!("Could not send {method}: {error}")))?;

    tokio::time::timeout(REQUEST_TIMEOUT, async {
        loop {
            let value = next_json(socket).await?;
            dispatch_chat_event(app, &value);
            if value.get("type").and_then(Value::as_str) != Some("res")
                || value.get("id").and_then(Value::as_str) != Some(id.as_str())
            {
                continue;
            }
            if value.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(value.get("payload").cloned().unwrap_or(Value::Null));
            }
            let message = value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Gateway request failed.");
            let details = value
                .get("error")
                .and_then(|error| error.get("details"))
                .filter(|details| details.is_object());
            return Err(RequestFailure::method_with_details(message, details));
        }
    })
    .await
    .map_err(|_| RequestFailure::transport(format!("Gateway {method} request timed out.")))?
}

async fn perform_request(
    app: &AppHandle,
    socket: &mut GatewaySocket,
    request: GatewayRequest,
) -> Result<GatewayResponse, RequestFailure> {
    match request {
        GatewayRequest::AgentsList => request_agents_list(app, socket)
            .await
            .map(GatewayResponse::AgentsList),
        GatewayRequest::ChatSend(params) => {
            let params = serde_json::to_value(params).map_err(|error| {
                RequestFailure::transport(format!("Could not encode chat.send: {error}"))
            })?;
            let payload = request_on_socket(app, socket, "chat.send", params).await?;
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
            let payload = request_on_socket(app, socket, "plugin.surface.refresh", params).await?;
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
    app: &AppHandle,
    socket: &mut GatewaySocket,
) -> Result<AgentsListResult, RequestFailure> {
    let payload = request_on_socket(app, socket, "agents.list", json!({})).await?;
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

type GatewaySocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_gateway_socket(config: &GatewayWsConfig) -> Result<GatewaySocket, RequestFailure> {
    let trust =
        tls_trust_decision(config.tls_fingerprint.as_deref()).map_err(RequestFailure::tls)?;
    let result = match trust {
        TlsTrustDecision::SystemRoots => connect_async(config.ws_url.as_str()).await,
        TlsTrustDecision::Pinned(expected) => {
            if !config.ws_url.starts_with("wss://") {
                return Err(RequestFailure::tls(
                    "Gateway TLS fingerprint requires a wss:// URL.",
                ));
            }
            let connector = pinned_tls_connector(expected).map_err(RequestFailure::tls)?;
            connect_async_tls_with_config(config.ws_url.as_str(), None, false, Some(connector))
                .await
        }
    };
    result
        .map(|(socket, _)| socket)
        .map_err(|error| connect_failure(config, error))
}

fn connect_failure(config: &GatewayWsConfig, error: TungsteniteError) -> RequestFailure {
    let message = format!("Gateway connection failed: {error}");
    if is_tls_connect_failure(&config.ws_url, &error) {
        RequestFailure::tls(message)
    } else {
        RequestFailure::transport(message)
    }
}

fn is_tls_connect_failure(ws_url: &str, error: &TungsteniteError) -> bool {
    if !ws_url.starts_with("wss://") {
        return false;
    }
    error.to_string().contains(TLS_PIN_MISMATCH_ERROR)
        || matches!(error, TungsteniteError::Tls(_))
        || matches!(error, TungsteniteError::Io(io_error) if io_error.kind() == ErrorKind::InvalidData)
}

async fn next_json(socket: &mut GatewaySocket) -> Result<Value, RequestFailure> {
    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| RequestFailure::transport("Gateway connection closed."))?
            .map_err(|error| {
                RequestFailure::transport(format!("Gateway connection failed: {error}"))
            })?;
        match message {
            Message::Text(text) => {
                return serde_json::from_str(text.as_ref()).map_err(|error| {
                    RequestFailure::transport(format!("Gateway sent invalid JSON: {error}"))
                });
            }
            Message::Ping(payload) => {
                socket.send(Message::Pong(payload)).await.map_err(|error| {
                    RequestFailure::transport(format!("Could not answer Gateway ping: {error}"))
                })?
            }
            Message::Close(_) => {
                return Err(RequestFailure::transport("Gateway connection closed."));
            }
            _ => {}
        }
    }
}

async fn handle_idle_message(
    app: &AppHandle,
    socket: &mut GatewaySocket,
    incoming: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) -> Result<(), RequestFailure> {
    let message = incoming
        .ok_or_else(|| RequestFailure::transport("Gateway connection closed."))?
        .map_err(|error| {
            RequestFailure::transport(format!("Gateway connection failed: {error}"))
        })?;
    match message {
        Message::Text(text) => {
            if let Ok(value) = serde_json::from_str::<Value>(text.as_ref()) {
                dispatch_chat_event(app, &value);
            }
            Ok(())
        }
        Message::Ping(payload) => socket.send(Message::Pong(payload)).await.map_err(|error| {
            RequestFailure::transport(format!("Could not answer Gateway ping: {error}"))
        }),
        Message::Close(_) => Err(RequestFailure::transport("Gateway connection closed.")),
        _ => Ok(()),
    }
}

fn dispatch_chat_event(app: &AppHandle, frame: &Value) {
    if frame.get("type").and_then(Value::as_str) != Some("event")
        || frame.get("event").and_then(Value::as_str) != Some("chat")
    {
        return;
    }
    if let Some(payload) = frame.get("payload") {
        // Payload stays raw so the WebView can mirror Gateway delta assembly without native drift.
        let _ = app.emit_to(QUICKCHAT_LABEL, CHAT_EVENT, payload.clone());
    }
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
    fn tls_trust_decision_uses_system_roots_or_an_exact_pin() {
        assert_eq!(
            tls_trust_decision(None).expect("system trust"),
            TlsTrustDecision::SystemRoots
        );
        assert_eq!(
            tls_trust_decision(Some(&"ab".repeat(32))).expect("pinned trust"),
            TlsTrustDecision::Pinned([0xab; 32])
        );
        assert!(tls_trust_decision(Some("sha256:abc")).is_err());

        let certificate = b"fixture gateway leaf certificate";
        let expected: [u8; 32] = Sha256::digest(certificate).into();
        assert!(pinned_fingerprint_matches(&expected, certificate));
        assert!(!pinned_fingerprint_matches(
            &expected,
            b"different gateway leaf certificate"
        ));
    }

    #[test]
    fn tls_failures_have_a_distinct_connectivity_state() {
        let tls_error = TungsteniteError::Io(std::io::Error::new(
            ErrorKind::InvalidData,
            TLS_PIN_MISMATCH_ERROR,
        ));
        assert!(is_tls_connect_failure("wss://127.0.0.1:18789", &tls_error));
        assert!(!is_tls_connect_failure("ws://127.0.0.1:18789", &tls_error));
        assert_eq!(
            GatewayConnectionState::TlsFailure.event_name(),
            "tls-failure"
        );
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_capped() {
        assert_eq!(reconnect_backoff(1), Duration::from_secs(1));
        assert_eq!(reconnect_backoff(2), Duration::from_secs(2));
        assert_eq!(reconnect_backoff(5), Duration::from_secs(16));
        assert_eq!(reconnect_backoff(6), MAX_RECONNECT_DELAY);
        assert_eq!(reconnect_backoff(100), MAX_RECONNECT_DELAY);
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
        assert_eq!(frame["params"]["client"]["id"], CLIENT_ID);
        assert_eq!(
            frame["params"]["client"]["deviceFamily"],
            CLIENT_DEVICE_FAMILY
        );
        assert_eq!(frame["params"]["auth"], json!({ "token": "secret" }));
        assert_eq!(
            frame["params"]["caps"],
            json!([INLINE_WIDGETS_CLIENT_CAPABILITY])
        );
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
        assert_eq!(pinned_params["caps"], json!([]));
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

        let stale_device_details = json!({ "code": AUTH_DEVICE_TOKEN_MISMATCH_DETAIL_CODE });
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
    fn reconnect_pause_requires_explicit_server_policy() {
        let pause_details = json!({ "pauseReconnect": true });
        let paused = RequestFailure::method_with_details("pause", Some(&pause_details));
        assert!(should_pause_reconnect(&paused.connect_details));

        let terminal_details = json!({ "retryable": false });
        let terminal = RequestFailure::method_with_details("terminal", Some(&terminal_details));
        assert!(should_pause_reconnect(&terminal.connect_details));

        let retry_details = json!({ "retryable": true, "pauseReconnect": false });
        let retry = RequestFailure::method_with_details("retry", Some(&retry_details));
        assert!(!should_pause_reconnect(&retry.connect_details));
        assert!(!should_pause_reconnect(
            &RequestFailure::transport("transport").connect_details
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
