use crate::gateway_device_identity::{
    GatewayAuth, GatewayDeviceIdentity, GatewayDeviceIdentityStore, CLIENT_DEVICE_FAMILY,
    CLIENT_ID, CLIENT_MODE, CLIENT_PLATFORM, CLIENT_ROLE, CLIENT_SCOPES,
};
#[cfg(any(target_os = "linux", test))]
use crate::gateway_sleep::SleepPrepareOutcome;
use crate::quickchat::QUICKCHAT_LABEL;
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::io::ErrorKind;
#[cfg(any(target_os = "linux", test))]
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
#[cfg(any(target_os = "linux", test))]
use tauri::Url;
use tauri::{AppHandle, Emitter, Manager, Webview};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{Error as TungsteniteError, Message};
use tokio_tungstenite::{
    connect_async, connect_async_tls_with_config, Connector, MaybeTlsStream, WebSocketStream,
};
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
#[cfg(any(target_os = "linux", test))]
const SUSPEND_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
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

#[cfg(any(target_os = "linux", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuspendPrepareResponse {
    status: Option<String>,
    suspension_id: Option<String>,
}

#[cfg(any(target_os = "linux", test))]
impl SuspendPrepareResponse {
    fn into_outcome(self) -> SleepPrepareOutcome {
        match (self.status.as_deref(), self.suspension_id) {
            (Some("ready"), Some(suspension_id)) if !suspension_id.trim().is_empty() => {
                SleepPrepareOutcome::Ready { suspension_id }
            }
            _ => SleepPrepareOutcome::Busy,
        }
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Deserialize)]
struct SuspendResumeResponse {
    resumed: bool,
}

enum GatewayRequest {
    AgentsList,
    ChatSend(ChatSendParams),
    RefreshCanvasSurface {
        observed_url: Option<String>,
    },
    #[cfg(target_os = "linux")]
    SuspendPrepare {
        request_id: String,
    },
    #[cfg(target_os = "linux")]
    SuspendResume {
        suspension_id: String,
    },
}

enum GatewayResponse {
    AgentsList(AgentsListResult),
    ChatSend(ChatSendAck),
    CanvasSurface(Option<String>),
    #[cfg(target_os = "linux")]
    SuspendPrepare(SuspendPrepareResponse),
    #[cfg(target_os = "linux")]
    SuspendResume(SuspendResumeResponse),
}

enum DriverCommand {
    Request {
        request: GatewayRequest,
        budget: Option<Duration>,
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
            tls_failure: true,
            ..Self::transport(message)
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

#[derive(Clone, Default)]
struct CanvasSurfaceState {
    generation: u64,
    url: Option<String>,
}

#[derive(Default)]
struct GatewayClientInner {
    config: Mutex<Option<GatewayWsConfig>>,
    config_generation: AtomicU64,
    commands: Mutex<Option<mpsc::Sender<DriverCommand>>>,
    agents_cache: Mutex<Option<CachedAgents>>,
    identity: Mutex<Option<GatewayDeviceIdentityStore>>,
    canvas_surface: Mutex<CanvasSurfaceState>,
    user_accent: Mutex<Option<String>>,
    connection_notice: Mutex<Option<String>>,
    connection_state: AtomicU64,
    reconnect_paused: AtomicBool,
    sleep_cycle_depth: AtomicU64,
    running: AtomicBool,
}

#[derive(Clone)]
pub struct GatewayClient {
    inner: Arc<GatewayClientInner>,
}

impl GatewayClient {
    pub fn new() -> Self {
        Self {
            inner: Arc::default(),
        }
    }

    pub fn configure(&self, app: &AppHandle, config: GatewayWsConfig) {
        self.set_configuration(app, Some(config));
    }

    pub fn clear_configuration(&self, app: &AppHandle) {
        self.set_configuration(app, None);
    }

    fn set_configuration(&self, app: &AppHandle, config: Option<GatewayWsConfig>) {
        *self
            .inner
            .config
            .lock()
            .expect("gateway config mutex poisoned") = config;
        *self
            .inner
            .agents_cache
            .lock()
            .expect("gateway agents cache mutex poisoned") = None;
        let generation = self.inner.config_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.set_canvas_surface_url(generation, None);
        self.inner.reconnect_paused.store(false, Ordering::SeqCst);
        self.set_connection_state(app, GatewayConnectionState::Down, None);
        self.resume_reconnect();
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
                GatewayStateEvent::new(
                    self.connection_state(),
                    notice,
                    self.canvas_surface_url(),
                    self.user_accent(),
                ),
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

    #[cfg(target_os = "linux")]
    pub async fn suspend_prepare(&self, request_id: String) -> Result<SleepPrepareOutcome, String> {
        let response = tokio::time::timeout(SUSPEND_REQUEST_TIMEOUT, async {
            self.wait_for_sleep_connection().await;
            self.request_with_budget(
                GatewayRequest::SuspendPrepare { request_id },
                Some(SUSPEND_REQUEST_TIMEOUT),
            )
            .await
        })
        .await
        .map_err(|_| "Gateway sleep preparation timed out.".to_string())??;
        let GatewayResponse::SuspendPrepare(response) = response else {
            return Err(
                "Gateway returned the wrong response for gateway.suspend.prepare.".to_string(),
            );
        };
        Ok(response.into_outcome())
    }

    #[cfg(target_os = "linux")]
    pub async fn suspend_resume(&self, suspension_id: String) -> Result<bool, String> {
        let response = tokio::time::timeout(SUSPEND_REQUEST_TIMEOUT, async {
            self.wait_for_sleep_connection().await;
            self.request_with_budget(
                GatewayRequest::SuspendResume { suspension_id },
                Some(SUSPEND_REQUEST_TIMEOUT),
            )
            .await
        })
        .await
        .map_err(|_| "Gateway sleep resume timed out.".to_string())??;
        let GatewayResponse::SuspendResume(response) = response else {
            return Err(
                "Gateway returned the wrong response for gateway.suspend.resume.".to_string(),
            );
        };
        Ok(response.resumed)
    }

    #[cfg(target_os = "linux")]
    pub fn loopback_route_token(&self) -> Option<String> {
        self.inner
            .config
            .lock()
            .expect("gateway config mutex poisoned")
            .as_ref()
            .map(|config| config.ws_url.clone())
            .filter(|route| is_loopback_ws_url(route))
    }

    pub fn resume_reconnect(&self) {
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

    pub fn resume_paused_reconnect(&self) {
        if self.inner.reconnect_paused.load(Ordering::SeqCst) {
            self.resume_reconnect();
        }
    }

    #[cfg(any(target_os = "linux", test))]
    pub(crate) fn begin_sleep_cycle(&self) {
        self.inner.sleep_cycle_depth.fetch_add(1, Ordering::SeqCst);
    }

    #[cfg(any(target_os = "linux", test))]
    pub(crate) fn end_sleep_cycle(&self) {
        // Depth, not a boolean: an older wake task ending late must not park the
        // driver while a newer sleep cycle is still active. Saturate at zero so
        // an unbalanced end can never wrap into a permanently active driver.
        let _ =
            self.inner
                .sleep_cycle_depth
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |depth| {
                    depth.checked_sub(1)
                });
    }

    #[cfg(target_os = "linux")]
    async fn wait_for_sleep_connection(&self) {
        while !self.is_connected() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn request(&self, request: GatewayRequest) -> Result<GatewayResponse, String> {
        self.request_with_budget(request, None).await
    }

    async fn request_with_budget(
        &self,
        request: GatewayRequest,
        budget: Option<Duration>,
    ) -> Result<GatewayResponse, String> {
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
            .send(DriverCommand::Request {
                request,
                budget,
                reply,
            })
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
            if !driver_should_run(
                app.get_window(QUICKCHAT_LABEL).is_some(),
                self.inner.sleep_cycle_depth.load(Ordering::SeqCst) > 0,
            ) {
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
            if !driver_should_run(
                app.get_window(QUICKCHAT_LABEL).is_some(),
                self.inner.sleep_cycle_depth.load(Ordering::SeqCst) > 0,
            ) {
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
        let challenge = wait_for_connect_challenge(&mut socket).await?;
        // Native child WebViews use platform HTTP trust and cannot bind the optional
        // WebSocket leaf pin, so pinned Gateway connections remain capability-free.
        let inline_widgets_available = config
            .tls_fingerprint
            .as_deref()
            .is_none_or(|value| value.trim().is_empty());
        let params = connect_params(
            &identity,
            &auth,
            &challenge.nonce,
            challenge.issued_at_ms,
            inline_widgets_available,
        )
        .map_err(RequestFailure::transport)?;
        let config_changed = AtomicBool::new(false);
        let dispatch = |frame: &Value| {
            dispatch_chat_event(app, frame);
            if frame.get("type").and_then(Value::as_str) == Some("event")
                && frame.get("event").and_then(Value::as_str) == Some("config.changed")
            {
                config_changed.store(true, Ordering::SeqCst);
            }
        };
        let hello =
            match request_on_socket(&mut socket, "connect", params, REQUEST_TIMEOUT, &dispatch)
                .await
            {
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
        self.set_canvas_surface_url(
            generation,
            gated_canvas_surface_url(hello.canvas_surface_url, inline_widgets_available),
        );

        let agents = request_agents_list(&mut socket, REQUEST_TIMEOUT, &dispatch).await?;
        let accent = request_gateway_accent(&mut socket, &dispatch).await?;
        if self.inner.config_generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        self.cache_agents(agents);
        self.set_user_accent(generation, accent);
        self.set_connection_state(app, GatewayConnectionState::Up, None);
        let mut last_gateway_activity = Instant::now();

        loop {
            if self.inner.config_generation.load(Ordering::SeqCst) != generation
                || !driver_should_run(
                    app.get_window(QUICKCHAT_LABEL).is_some(),
                    self.inner.sleep_cycle_depth.load(Ordering::SeqCst) > 0,
                )
            {
                return Ok(());
            }
            if config_changed.swap(false, Ordering::SeqCst) {
                let accent = request_gateway_accent(&mut socket, &dispatch).await?;
                if self.inner.config_generation.load(Ordering::SeqCst) != generation {
                    return Ok(());
                }
                if self.set_user_accent(generation, accent) {
                    self.emit_connection_state(app, GatewayConnectionState::Up, None);
                }
                last_gateway_activity = Instant::now();
            }
            tokio::select! {
                command = receiver.recv() => {
                    let Some(command) = command else {
                        return Ok(());
                    };
                    match command {
                        DriverCommand::Reconfigure => return Ok(()),
                        DriverCommand::Request { request, budget, reply } => {
                            let result = perform_request(&mut socket, request, budget, &dispatch).await;
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
                    handle_idle_message(&dispatch, &mut socket, incoming).await?;
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

    fn set_user_accent(&self, generation: u64, accent: Option<String>) -> bool {
        let mut current = self
            .inner
            .user_accent
            .lock()
            .expect("gateway user accent mutex poisoned");
        if self.inner.config_generation.load(Ordering::SeqCst) != generation || *current == accent {
            return false;
        }
        *current = accent;
        true
    }

    fn user_accent(&self) -> Option<String> {
        self.inner
            .user_accent
            .lock()
            .expect("gateway user accent mutex poisoned")
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
            self.set_canvas_surface_url(self.inner.config_generation.load(Ordering::SeqCst), None);
            self.set_user_accent(self.inner.config_generation.load(Ordering::SeqCst), None);
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
        self.emit_connection_state(app, state, notice);
    }

    fn emit_connection_state(
        &self,
        app: &AppHandle,
        state: GatewayConnectionState,
        notice: Option<String>,
    ) {
        let _ = app.emit_to(
            QUICKCHAT_LABEL,
            GATEWAY_STATE_EVENT,
            GatewayStateEvent::new(state, notice, self.canvas_surface_url(), self.user_accent()),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    accent: Option<String>,
}

impl GatewayStateEvent {
    fn new(
        state: GatewayConnectionState,
        notice: Option<String>,
        canvas_surface_url: Option<String>,
        accent: Option<String>,
    ) -> Self {
        Self {
            state: state.event_name(),
            notice,
            canvas_surface_url,
            accent,
        }
    }
}

fn reject_disconnected_command(command: DriverCommand) {
    if let DriverCommand::Request { reply, .. } = command {
        let _ = reply.send(Err("Gateway unreachable — retrying".to_string()));
    }
}

fn driver_should_run(window_exists: bool, sleep_active: bool) -> bool {
    // Sleep cycles temporarily activate the driver; the companion-wide connection lifetime
    // remains owned by Quick Chat outside that narrow window.
    window_exists || sleep_active
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
    // A retained device token can fail because the Gateway now requires shared credentials.
    // Mismatch errors remain credential-aware so configured auth keeps its existing recovery path.
    let credential_required = detail_code.is_some_and(|code| {
        code == AUTH_TOKEN_MISSING_DETAIL_CODE
            || code == AUTH_PASSWORD_MISSING_DETAIL_CODE
            || (!has_local_credential && code.starts_with("AUTH_") && code.ends_with("_MISMATCH"))
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

fn request_frame(id: &str, method: &str, params: Value) -> Value {
    json!({
        "type": "req",
        "id": id,
        "method": method,
        "params": params
    })
}

#[derive(Debug, PartialEq, Eq)]
struct ConnectChallenge {
    nonce: String,
    issued_at_ms: u64,
}

fn parse_connect_challenge(value: &Value) -> Result<ConnectChallenge, RequestFailure> {
    let nonce = value
        .get("payload")
        .and_then(|payload| payload.get("nonce"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|nonce| !nonce.is_empty());
    let issued_at_ms = value
        .get("payload")
        .and_then(|payload| payload.get("ts"))
        .and_then(Value::as_u64)
        .ok_or_else(|| RequestFailure::transport("Gateway challenge timestamp was invalid."))?;
    nonce
        .map(|nonce| ConnectChallenge {
            nonce: nonce.to_owned(),
            issued_at_ms,
        })
        .ok_or_else(|| RequestFailure::transport("Gateway challenge omitted nonce."))
}

async fn wait_for_connect_challenge(
    socket: &mut GatewaySocket,
) -> Result<ConnectChallenge, RequestFailure> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        loop {
            let value = next_json(socket).await?;
            if value.get("type").and_then(Value::as_str) == Some("event")
                && value.get("event").and_then(Value::as_str) == Some("connect.challenge")
            {
                return parse_connect_challenge(&value);
            }
        }
    })
    .await
    .map_err(|_| RequestFailure::transport("Gateway connect challenge timed out."))?
}

async fn request_on_socket<T, F>(
    socket: &mut GatewaySocket,
    method: &str,
    params: Value,
    budget: Duration,
    dispatch: &F,
) -> Result<T, RequestFailure>
where
    T: DeserializeOwned,
    F: Fn(&Value),
{
    let id = Uuid::new_v4().to_string();
    let encoded = serde_json::to_string(&request_frame(&id, method, params)).map_err(|error| {
        RequestFailure::transport(format!("Could not encode {method}: {error}"))
    })?;
    socket
        .send(Message::Text(encoded.into()))
        .await
        .map_err(|error| RequestFailure::transport(format!("Could not send {method}: {error}")))?;

    tokio::time::timeout(budget, async {
        loop {
            let value = next_json(socket).await?;
            dispatch(&value);
            if value.get("type").and_then(Value::as_str) != Some("res")
                || value.get("id").and_then(Value::as_str) != Some(id.as_str())
            {
                continue;
            }
            if value.get("ok").and_then(Value::as_bool) == Some(true) {
                // Decode before the driver releases this socket to another request.
                let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                return serde_json::from_value(payload).map_err(|error| {
                    RequestFailure::transport(format!("Invalid {method} response: {error}"))
                });
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

async fn perform_request<F>(
    socket: &mut GatewaySocket,
    request: GatewayRequest,
    budget: Option<Duration>,
    dispatch: &F,
) -> Result<GatewayResponse, RequestFailure>
where
    F: Fn(&Value),
{
    let budget = budget.unwrap_or(REQUEST_TIMEOUT);
    match request {
        GatewayRequest::AgentsList => request_agents_list(socket, budget, dispatch)
            .await
            .map(GatewayResponse::AgentsList),
        GatewayRequest::ChatSend(params) => {
            let params = serde_json::to_value(params).map_err(|error| {
                RequestFailure::transport(format!("Could not encode chat.send: {error}"))
            })?;
            request_on_socket(socket, "chat.send", params, budget, dispatch)
                .await
                .map(GatewayResponse::ChatSend)
        }
        GatewayRequest::RefreshCanvasSurface { observed_url } => {
            let mut params = json!({ "surface": "canvas" });
            if let Some(observed_url) = observed_url {
                params["observedUrl"] = Value::String(observed_url);
            }
            let response: PluginSurfaceRefreshResponse =
                request_on_socket(socket, "plugin.surface.refresh", params, budget, dispatch)
                    .await?;
            let canvas = response
                .plugin_surface_urls
                .and_then(|urls| urls.get("canvas").cloned())
                .map(|url| url.trim().to_string())
                .filter(|url| !url.is_empty());
            Ok(GatewayResponse::CanvasSurface(canvas))
        }
        #[cfg(target_os = "linux")]
        GatewayRequest::SuspendPrepare { request_id } => request_on_socket(
            socket,
            "gateway.suspend.prepare",
            json!({ "requestId": request_id }),
            budget,
            dispatch,
        )
        .await
        .map(GatewayResponse::SuspendPrepare),
        #[cfg(target_os = "linux")]
        GatewayRequest::SuspendResume { suspension_id } => request_on_socket(
            socket,
            "gateway.suspend.resume",
            json!({ "suspensionId": suspension_id }),
            budget,
            dispatch,
        )
        .await
        .map(GatewayResponse::SuspendResume),
    }
}

#[cfg(any(target_os = "linux", test))]
fn is_loopback_ws_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "ws" | "wss") {
        return false;
    }
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    })
}

async fn request_agents_list<F>(
    socket: &mut GatewaySocket,
    budget: Duration,
    dispatch: &F,
) -> Result<AgentsListResult, RequestFailure>
where
    F: Fn(&Value),
{
    request_on_socket(socket, "agents.list", json!({}), budget, dispatch).await
}

async fn request_gateway_accent<F>(
    socket: &mut GatewaySocket,
    dispatch: &F,
) -> Result<Option<String>, RequestFailure>
where
    F: Fn(&Value),
{
    let config =
        request_on_socket(socket, "config.get", json!({}), REQUEST_TIMEOUT, dispatch).await?;
    Ok(gateway_user_accent(&config))
}

fn gateway_user_accent(config: &Value) -> Option<String> {
    [
        config.pointer("/config/ui/prefs/accent"),
        config.pointer("/config/ui/seamColor"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .find(|value| {
        value.len() == 7
            && value.starts_with('#')
            && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    })
    .map(str::to_ascii_lowercase)
}

struct ValidatedHello {
    device_token: Option<String>,
    tick_watch_timeout: Duration,
    canvas_surface_url: Option<String>,
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
    let canvas_surface_url = hello
        .plugin_surface_urls
        .and_then(|surface_urls| surface_urls.get("canvas").cloned())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(ValidatedHello {
        device_token: hello.auth.device_token,
        tick_watch_timeout: Duration::from_millis(tick_interval_ms).saturating_mul(2),
        canvas_surface_url,
    })
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
        .as_deref()
        .or_else(|| ack.error.as_ref().and_then(Value::as_str))
        .or_else(|| {
            ack.error
                .as_ref()
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
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

async fn handle_idle_message<F>(
    dispatch: &F,
    socket: &mut GatewaySocket,
    incoming: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) -> Result<(), RequestFailure>
where
    F: Fn(&Value),
{
    let message = incoming
        .ok_or_else(|| RequestFailure::transport("Gateway connection closed."))?
        .map_err(|error| {
            RequestFailure::transport(format!("Gateway connection failed: {error}"))
        })?;
    match message {
        Message::Text(text) => {
            if let Ok(value) = serde_json::from_str::<Value>(text.as_ref()) {
                dispatch(&value);
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

fn dispatch_chat_event<R: tauri::Runtime>(app: &AppHandle<R>, frame: &Value) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    mod dashboard_handoff {
        use super::*;
        use crate::{cli::OpenClawCli, gateway, NavigationState};
        use std::ffi::OsString;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::path::PathBuf;
        use std::sync::MutexGuard;

        static CLI_ENV: Mutex<()> = Mutex::new(());

        struct CliFixture {
            directory: PathBuf,
            previous_cli: Option<OsString>,
            _environment: MutexGuard<'static, ()>,
        }

        impl CliFixture {
            fn new() -> Self {
                let environment = CLI_ENV.lock().unwrap_or_else(|error| error.into_inner());
                let directory = std::env::temp_dir()
                    .join(format!("openclaw-dashboard-handoff-{}", Uuid::new_v4()));
                fs::create_dir(&directory).expect("create CLI fixture");
                let executable = directory.join("openclaw");
                fs::write(
                    &executable,
                    r#"#!/bin/sh
case "$*" in
  --version) echo '0.0.0-test' ;;
  'gateway status --json')
    if test -f "$(dirname "$0")/stopped"; then
      echo '{"service":{"loaded":true,"runtime":{"status":"stopped"}},"rpc":{"ok":false}}'
    else
      echo '{"service":{"loaded":true,"runtime":{"status":"running"}},"rpc":{"ok":true}}'
    fi ;;
  'gateway stop --json --force') touch "$(dirname "$0")/stopped"; echo '{"ok":true}' ;;
  'gateway start --json'|'gateway restart --json') rm -f "$(dirname "$0")/stopped"; echo '{"ok":true}' ;;
  'dashboard --json --no-open') cat "$(dirname "$0")/dashboard.json" ;;
  *) echo 'Unexpected CLI invocation' >&2; exit 1 ;;
esac
"#,
                )
                .expect("write CLI fixture");
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
                    .expect("make CLI fixture executable");
                let previous_cli = std::env::var_os("OPENCLAW_DESKTOP_CLI");
                std::env::set_var("OPENCLAW_DESKTOP_CLI", executable);
                Self {
                    directory,
                    previous_cli,
                    _environment: environment,
                }
            }

            fn ready(&self, response: Value) -> Result<gateway::ReadyGateway, String> {
                fs::write(self.directory.join("dashboard.json"), response.to_string())
                    .expect("write dashboard response");
                let cli = OpenClawCli::discover().expect("discover fixture CLI");
                gateway::ensure_ready(&cli)
            }
        }

        impl Drop for CliFixture {
            fn drop(&mut self) {
                match self.previous_cli.as_ref() {
                    Some(value) => std::env::set_var("OPENCLAW_DESKTOP_CLI", value),
                    None => std::env::remove_var("OPENCLAW_DESKTOP_CLI"),
                }
                let _ = fs::remove_dir_all(&self.directory);
            }
        }

        #[test]
        fn gateway_actions_supply_stop_consent_without_forcing_restart() {
            let _fixture = CliFixture::new();
            let cli = OpenClawCli::discover().expect("discover fixture CLI");
            for action in [
                gateway::GatewayAction::Stop,
                gateway::GatewayAction::Start,
                gateway::GatewayAction::Restart,
                gateway::GatewayAction::Stop,
            ] {
                let snapshot = gateway::act(&cli, action).expect("CLI accepts desktop action");
                let running = !matches!(action, gateway::GatewayAction::Stop);
                assert_eq!(snapshot.running, running);
                assert_eq!(snapshot.reachable, running);
            }
        }

        #[test]
        fn browser_pairing_is_separate_from_native_auth_and_survives_first_run_routing() {
            let fixture = CliFixture::new();
            let browser_url = "https://127.0.0.1:18789/control/?keep=yes#bootstrapToken=fixture%2Bbrowser%2Fgrant%3D&bootstrapProfile=owner";
            let ws_url = "wss://127.0.0.1:18789/control";
            for (mode, fragment, token, password) in [
                ("password", "", None, Some("fixture-password")),
                (
                    "token",
                    "#token=fixture%2Bshared%2Ftoken%3D",
                    Some("fixture+shared/token="),
                    None,
                ),
                // The CLI withholds SecretRef-backed shared credentials from JSON.
                ("SecretRef", "", None, None),
            ] {
                let ready = fixture
                    .ready(json!({
                        "ok": true,
                        "url": format!("https://127.0.0.1:18789/control/{fragment}"),
                        "browserUrl": browser_url,
                        "wsUrl": ws_url,
                        "gatewayPassword": password,
                        "tlsFingerprint": "ab".repeat(32),
                    }))
                    .unwrap_or_else(|error| panic!("{mode}: {error}"));

                assert!(ready.snapshot.reachable, "{mode}");
                assert_eq!(ready.gateway_ws.ws_url, ws_url, "{mode}");
                assert_eq!(ready.gateway_ws.token.as_deref(), token, "{mode}");
                assert_eq!(ready.gateway_ws.password.as_deref(), password, "{mode}");
                assert_eq!(
                    ready.gateway_ws.tls_fingerprint,
                    Some("ab".repeat(32)),
                    "{mode}"
                );
                assert_eq!(
                    ready.dashboard_url, browser_url,
                    "{mode}: browser pairing URL"
                );

                let mut navigation = NavigationState::default();
                navigation.mark_onboarding_pending();
                let first_run = navigation
                    .prepare_dashboard_url(&ready.dashboard_url)
                    .expect("first-run dashboard");
                assert_eq!(first_run.path(), "/control/settings/model-setup", "{mode}");
                assert_eq!(
                    first_run.query(),
                    Some("keep=yes&firstRun=explicit"),
                    "{mode}"
                );
                assert_eq!(
                    first_run.fragment(),
                    Some("bootstrapToken=fixture%2Bbrowser%2Fgrant%3D&bootstrapProfile=owner"),
                    "{mode}"
                );
            }
        }

        #[test]
        fn missing_browser_handoff_requires_an_integration_upgrade() {
            let fixture = CliFixture::new();
            let result = fixture.ready(json!({
                "ok": true,
                "url": "http://127.0.0.1:18789/#token=fixture-shared-token",
                "wsUrl": "ws://127.0.0.1:18789",
            }));
            let error = result
                .err()
                .expect("legacy shared URL cannot pair the browser");
            assert!(error.contains("desktop dashboard integration"), "{error}");
            assert!(error.contains("Beta or Development"), "{error}");
        }
    }

    #[test]
    fn sleep_cycle_runs_driver_without_quick_chat() {
        let client = GatewayClient::new();
        let sleep_active =
            |client: &GatewayClient| client.inner.sleep_cycle_depth.load(Ordering::SeqCst) > 0;
        assert!(!driver_should_run(false, false));
        assert!(driver_should_run(true, false));
        client.begin_sleep_cycle();
        assert!(driver_should_run(false, sleep_active(&client)));
        client.end_sleep_cycle();
        assert!(!driver_should_run(false, sleep_active(&client)));
    }

    #[test]
    fn late_wake_end_does_not_park_a_newer_sleep_cycle() {
        let client = GatewayClient::new();
        let sleep_active =
            |client: &GatewayClient| client.inner.sleep_cycle_depth.load(Ordering::SeqCst) > 0;
        client.begin_sleep_cycle(); // cycle 1 sleeps
        client.begin_sleep_cycle(); // cycle 2 sleeps before cycle 1's wake task ends
        client.end_sleep_cycle(); // cycle 1's wake ends late
        assert!(driver_should_run(false, sleep_active(&client)));
        client.end_sleep_cycle();
        assert!(!driver_should_run(false, sleep_active(&client)));
        // An unbalanced extra end saturates at zero instead of wrapping.
        client.end_sleep_cycle();
        assert!(!driver_should_run(false, sleep_active(&client)));
    }

    #[tokio::test]
    async fn malformed_success_payloads_require_reconnection() {
        let requests = [
            ("agents.list", GatewayRequest::AgentsList),
            (
                "chat.send",
                GatewayRequest::ChatSend(ChatSendParams {
                    session_key: "agent:main:main".into(),
                    agent_id: None,
                    message: "hello".into(),
                    idempotency_key: "fixture-request".into(),
                }),
            ),
            (
                "plugin.surface.refresh",
                GatewayRequest::RefreshCanvasSurface { observed_url: None },
            ),
            #[cfg(target_os = "linux")]
            (
                "gateway.suspend.prepare",
                GatewayRequest::SuspendPrepare {
                    request_id: "fixture-sleep".into(),
                },
            ),
            #[cfg(target_os = "linux")]
            (
                "gateway.suspend.resume",
                GatewayRequest::SuspendResume {
                    suspension_id: "fixture-sleep".into(),
                },
            ),
        ];
        for (method, request) in requests {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind websocket fixture");
            let address = listener.local_addr().expect("fixture address");
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.expect("accept fixture");
                let mut socket = tokio_tungstenite::accept_async(stream)
                    .await
                    .expect("accept websocket");
                let message = socket.next().await.unwrap().unwrap();
                let frame: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                assert_eq!(frame["method"], method);
                socket
                    .send(Message::Text(
                        json!({
                            "type": "res", "id": frame["id"], "ok": true, "payload": 7,
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .expect("send malformed payload");
            });
            let (mut socket, _) = connect_async(format!("ws://{address}"))
                .await
                .expect("connect fixture");
            let failure = perform_request(&mut socket, request, None, &|_| {})
                .await
                .err()
                .expect("typed response must reject a number");
            assert!(failure.disconnect, "{method} must recycle the socket");
            assert!(failure
                .message
                .starts_with(&format!("Invalid {method} response:")));
            server.await.expect("fixture task");
        }
    }

    #[tokio::test]
    async fn budgeted_driver_request_releases_the_serial_queue() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind websocket fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept websocket fixture");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept websocket handshake");
            let _request = socket.next().await.expect("request frame");
            std::future::pending::<()>().await;
        });
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .expect("connect websocket fixture");
        let (commands, mut receiver) = mpsc::channel(2);
        let (reply, response) = oneshot::channel();
        commands
            .send(DriverCommand::Request {
                request: GatewayRequest::AgentsList,
                budget: Some(SUSPEND_REQUEST_TIMEOUT),
                reply,
            })
            .await
            .expect("queue budgeted request");
        commands
            .send(DriverCommand::Reconfigure)
            .await
            .expect("queue reconnect");

        let started = Instant::now();
        let command = receiver.recv().await.expect("budgeted request");
        let DriverCommand::Request {
            request,
            budget,
            reply,
        } = command
        else {
            panic!("expected request command");
        };
        let failure = match perform_request(&mut socket, request, budget, &|_| {}).await {
            Ok(_) => panic!("hung request should time out"),
            Err(failure) => failure,
        };
        let elapsed = started.elapsed();
        assert!(failure.disconnect, "timeout must recycle the socket");
        let _ = reply.send(Err(failure.message));

        assert!(matches!(
            tokio::time::timeout(Duration::from_millis(250), receiver.recv())
                .await
                .expect("serial queue remained blocked"),
            Some(DriverCommand::Reconfigure)
        ));
        assert!(
            elapsed >= Duration::from_millis(2_750),
            "elapsed: {elapsed:?}"
        );
        assert!(elapsed < Duration::from_secs(4), "elapsed: {elapsed:?}");
        let reply = response.await.expect("driver reply");
        match reply {
            Ok(_) => panic!("expected timeout reply"),
            Err(error) => assert!(error.contains("agents.list request timed out")),
        }
        server.abort();
    }

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
    fn connect_challenge_uses_gateway_timestamp() {
        let Ok(challenge) = parse_connect_challenge(&json!({
            "payload": {
                "nonce": " fixture-nonce ",
                "ts": 1_700_000_000_123_u64
            }
        })) else {
            panic!("expected valid challenge");
        };

        assert_eq!(
            challenge,
            ConnectChallenge {
                nonce: "fixture-nonce".to_string(),
                issued_at_ms: 1_700_000_000_123,
            }
        );
        assert!(parse_connect_challenge(&json!({
            "payload": { "nonce": "missing-time" }
        }))
        .is_err());
        assert!(parse_connect_challenge(&json!({
            "payload": { "nonce": "fixture-nonce", "ts": "1700000000123" }
        }))
        .is_err());
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
    fn gateway_user_accent_prefers_valid_user_preferences() {
        for (config, expected) in [
            (
                json!({ "config": { "ui": { "prefs": { "accent": "#ABC123" }, "seamColor": "#654321" } } }),
                Some("#abc123"),
            ),
            (
                json!({ "config": { "ui": { "prefs": { "accent": "invalid" }, "seamColor": "#654321" } } }),
                Some("#654321"),
            ),
            (
                json!({ "config": { "ui": { "prefs": { "accent": "abc123" }, "seamColor": "#12345" } } }),
                None,
            ),
            (
                json!({ "config": { "ui": { "prefs": { "accent": "#12345g" }, "seamColor": " #654321" } } }),
                None,
            ),
            (json!({ "config": {} }), None),
        ] {
            assert_eq!(gateway_user_accent(&config).as_deref(), expected);
        }
    }

    #[test]
    fn sleep_gateway_routes_are_loopback_only() {
        for route in [
            "ws://localhost:18789",
            "ws://127.0.0.1:18789",
            "wss://[::1]:18789",
        ] {
            assert!(
                is_loopback_ws_url(route),
                "expected loopback route: {route}"
            );
        }
        for route in [
            "ws://192.168.1.10:18789",
            "wss://gateway.example:18789",
            "https://127.0.0.1:18789",
            "not a URL",
        ] {
            assert!(!is_loopback_ws_url(route), "expected remote route: {route}");
        }
    }

    #[test]
    fn suspend_wire_results_decode_leniently() {
        let ready: SuspendPrepareResponse = serde_json::from_value(json!({
            "status": "ready",
            "suspensionId": "suspension-1",
            "expiresAtMs": 1_800_000_000_000_u64,
            "activeCount": 0,
            "blockers": []
        }))
        .expect("ready suspension response");
        assert_eq!(
            ready.into_outcome(),
            SleepPrepareOutcome::Ready {
                suspension_id: "suspension-1".into()
            }
        );

        let busy: SuspendPrepareResponse = serde_json::from_value(json!({
            "status": "busy",
            "reason": "active-work",
            "retryAfterMs": 1000,
            "activeCount": 1,
            "blockers": []
        }))
        .expect("busy suspension response");
        assert_eq!(busy.into_outcome(), SleepPrepareOutcome::Busy);

        let resumed: SuspendResumeResponse = serde_json::from_value(json!({
            "ok": true,
            "status": "running",
            "resumed": false
        }))
        .expect("resume response");
        assert!(!resumed.resumed);
    }

    #[test]
    fn gateway_state_event_carries_canvas_surface_in_camel_case() {
        let event = serde_json::to_value(GatewayStateEvent::new(
            GatewayConnectionState::Up,
            None,
            Some("https://gateway.example/__openclaw__/cap/fixture-capability".to_string()),
            Some("#abc123".to_string()),
        ))
        .expect("serialize gateway state");

        assert_eq!(
            event["canvasSurfaceUrl"],
            "https://gateway.example/__openclaw__/cap/fixture-capability"
        );
        assert_eq!(event["accent"], "#abc123");
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
    fn missing_gateway_credentials_override_retained_device_auth() {
        for detail_code in [
            AUTH_TOKEN_MISSING_DETAIL_CODE,
            AUTH_PASSWORD_MISSING_DETAIL_CODE,
        ] {
            let details = json!({
                "code": detail_code,
                "retryable": false,
                "pauseReconnect": true
            });
            let auth = GatewayAuth::DeviceToken("retained-device-token".to_string());
            let failure = RequestFailure::method_with_details("credential missing", Some(&details))
                .classify_connect(&auth);

            assert_eq!(
                failure.connect_state,
                Some(GatewayConnectionState::CredentialRequired)
            );
            assert!(should_pause_reconnect(&failure.connect_details));
            assert!(!should_clear_stored_device_token(&failure, &auth));
            let state = failure.connect_state.expect("classified state");
            let notice = connection_notice(state, &failure.connect_details, true);
            assert_eq!(
                notice.as_deref(),
                Some("Gateway requires a credential — open the dashboard on the gateway host")
            );
            assert_eq!(
                serde_json::to_value(GatewayStateEvent::new(state, notice, None, None))
                    .expect("serialize credential-required state"),
                json!({
                    "state": "credential-required",
                    "notice": "Gateway requires a credential — open the dashboard on the gateway host"
                })
            );
        }
    }

    #[tokio::test]
    async fn reopening_quick_chat_resumes_only_a_paused_reconnect() {
        let client = GatewayClient::new();
        let (commands, mut receiver) = mpsc::channel(2);
        *client
            .inner
            .commands
            .lock()
            .expect("gateway command mutex poisoned") = Some(commands);

        client.resume_paused_reconnect();
        assert!(
            tokio::time::timeout(Duration::from_millis(25), receiver.recv())
                .await
                .is_err()
        );

        client.inner.reconnect_paused.store(true, Ordering::SeqCst);
        client.resume_paused_reconnect();
        assert!(matches!(
            receiver.recv().await,
            Some(DriverCommand::Reconfigure)
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
