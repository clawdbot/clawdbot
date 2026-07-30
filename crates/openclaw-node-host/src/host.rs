use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    env, fs,
    future::Future,
    net::SocketAddr,
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::{JoinHandle, JoinSet},
};

use crate::{
    ClientError, ClientErrorClass, CommandRuntime, ConnectAuth, LifecycleDisconnectReason,
    LifecycleError, LifecycleEvent, NodeClient, NodeClientConfig, NodeConnectOptions, NodeIdentity,
    NodeLifecycle, NodeSession, ReconnectPause, RuntimeBuildError, RuntimeErrorClass,
};

// Avoid OpenClaw's reserved Gateway-adjacent ports by asking the OS for a free
// loopback port. Managed hosts can configure a stable healthListen explicitly.
const DEFAULT_HEALTH_LISTEN: &str = "127.0.0.1:0";
const DEFAULT_STATUS_COMMAND: &str = "rust-node.status";
const DEFAULT_AUTH_ENV: &str = "OPENCLAW_NODE_TOKEN";
const DEFAULT_IDENTITY_SECRET_ENV: &str = "OPENCLAW_NODE_IDENTITY";
const MAX_CONFIG_FILE_BYTES: u64 = 64 * 1024;
const MAX_HEALTH_CONNECTIONS: usize = 8;
const MAX_CONSECUTIVE_HEALTH_ACCEPT_ERRORS: usize = 3;
const HEALTH_ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    #[default]
    Token,
    BootstrapToken,
    DeviceToken,
    Password,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostConfig {
    gateway_url: String,
    #[serde(default = "default_display_name")]
    display_name: String,
    #[serde(default)]
    instance_id: Option<String>,
    #[serde(default = "default_health_listen")]
    health_listen: SocketAddr,
    #[serde(default = "default_status_command")]
    status_command: String,
    #[serde(default)]
    auth_kind: AuthKind,
    #[serde(default = "default_auth_env")]
    auth_env: String,
    #[serde(default = "default_identity_secret_env")]
    identity_secret_env: String,
    #[serde(default = "default_max_concurrency")]
    max_concurrency: usize,
    #[serde(default = "default_max_input_bytes")]
    max_input_bytes: usize,
    #[serde(default = "default_max_output_bytes")]
    max_output_bytes: usize,
    #[serde(default = "default_timeout_ms")]
    default_timeout_ms: u64,
    #[serde(default = "default_max_timeout_ms")]
    max_timeout_ms: u64,
}

impl HostConfig {
    /// Load and validate a headless-host JSON configuration file.
    /// # Errors
    ///
    /// Returns an I/O, JSON, or validation error. Secret material is never
    /// accepted directly in this file.
    pub fn load(path: &Path) -> Result<Self, HostError> {
        let metadata =
            fs::metadata(path).map_err(|error| HostError::ConfigRead(error.to_string()))?;
        if !metadata.is_file() || metadata.len() > MAX_CONFIG_FILE_BYTES {
            return Err(HostError::ConfigRead(
                "configuration path must be a regular file no larger than 64 KiB".into(),
            ));
        }
        let bytes = fs::read(path).map_err(|error| HostError::ConfigRead(error.to_string()))?;
        let config: Self = serde_json::from_slice(&bytes)
            .map_err(|error| HostError::ConfigParse(error.to_string()))?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), HostError> {
        if self.gateway_url.trim().is_empty() || self.gateway_url.trim() != self.gateway_url {
            return Err(HostError::Config(
                "gatewayUrl must be non-empty and have no surrounding whitespace".into(),
            ));
        }
        if !self.health_listen.ip().is_loopback() {
            return Err(HostError::Config(
                "healthListen must use a loopback address".into(),
            ));
        }
        let command = self.status_command.trim();
        if command.is_empty()
            || command != self.status_command
            || command == "system"
            || command.starts_with("system.")
        {
            return Err(HostError::Config(
                "statusCommand must have no surrounding whitespace and be outside the reserved system namespace".into(),
            ));
        }
        if self.auth_env.trim().is_empty() || self.auth_env.trim() != self.auth_env {
            return Err(HostError::Config(
                "authEnv must be non-empty and have no surrounding whitespace".into(),
            ));
        }
        if self.identity_secret_env.trim().is_empty()
            || self.identity_secret_env.trim() != self.identity_secret_env
        {
            return Err(HostError::Config(
                "identitySecretEnv must be non-empty and have no surrounding whitespace".into(),
            ));
        }
        if self
            .auth_env
            .eq_ignore_ascii_case(&self.identity_secret_env)
        {
            return Err(HostError::Config(
                "authEnv and identitySecretEnv must name different variables".into(),
            ));
        }
        if self.max_concurrency == 0
            || self.max_concurrency > Semaphore::MAX_PERMITS
            || self.max_input_bytes == 0
            || self.max_output_bytes == 0
            || self.default_timeout_ms == 0
            || self.max_timeout_ms == 0
            || self.default_timeout_ms > self.max_timeout_ms
        {
            return Err(HostError::Config(
                "runtime bounds must be positive and defaultTimeoutMs must not exceed maxTimeoutMs"
                    .into(),
            ));
        }
        Ok(())
    }

    #[must_use]
    pub fn health_listen(&self) -> SocketAddr {
        self.health_listen
    }

    #[must_use]
    pub fn status_command(&self) -> &str {
        &self.status_command
    }
}

pub struct HostCredentials {
    identity: NodeIdentity,
    configured_auth: ConnectAuth,
    issued_device_token: Option<String>,
}

impl HostCredentials {
    /// Load identity and authentication secrets from the indirections named in
    /// the non-secret host configuration.
    /// # Errors
    ///
    /// Returns an error for missing, empty, or malformed identity material.
    pub fn load(config: &HostConfig) -> Result<Self, HostError> {
        let identity_value = env::var(&config.identity_secret_env)
            .map_err(|_| HostError::MissingSecret(config.identity_secret_env.clone()))?;
        let secret = decode_identity(identity_value.as_bytes())?;
        let auth_value = env::var(&config.auth_env)
            .map_err(|_| HostError::MissingSecret(config.auth_env.clone()))?;
        if auth_value.is_empty() {
            return Err(HostError::EmptySecret(config.auth_env.clone()));
        }
        let auth = match config.auth_kind {
            AuthKind::Token => ConnectAuth::token(auth_value),
            AuthKind::BootstrapToken => ConnectAuth::bootstrap_token(auth_value),
            AuthKind::DeviceToken => ConnectAuth::device_token(auth_value),
            AuthKind::Password => ConnectAuth::password(auth_value),
        };
        Ok(Self {
            identity: NodeIdentity::from_secret_bytes(secret),
            configured_auth: auth,
            issued_device_token: None,
        })
    }

    #[must_use]
    pub fn new(identity: NodeIdentity, auth: ConnectAuth) -> Self {
        Self {
            identity,
            configured_auth: auth,
            issued_device_token: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum HostError {
    #[error("failed to read host configuration: {0}")]
    ConfigRead(String),
    #[error("failed to parse host configuration: {0}")]
    ConfigParse(String),
    #[error("invalid host configuration: {0}")]
    Config(String),
    #[error("required secret environment variable is missing: {0}")]
    MissingSecret(String),
    #[error("secret environment variable is empty: {0}")]
    EmptySecret(String),
    #[error("identity secret could not be loaded: {0}")]
    IdentitySecret(String),
    #[error("failed to bind the local health listener: {0}")]
    HealthBind(String),
    #[error("local health listener failed: {0}")]
    HealthServe(String),
    #[error("command runtime configuration failed: {0}")]
    RuntimeBuild(#[from] RuntimeBuildError),
    #[error("node reconnect paused: {0}")]
    ReconnectPaused(String),
}

#[derive(Default)]
struct HostState {
    ready: AtomicBool,
}

struct AbortOnDropTask<T> {
    handle: JoinHandle<T>,
}

impl<T> AbortOnDropTask<T> {
    fn new(handle: JoinHandle<T>) -> Self {
        Self { handle }
    }

    fn abort(&self) {
        self.handle.abort();
    }
}

impl<T> Drop for AbortOnDropTask<T> {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Run the generic node host in the foreground until shutdown or a terminal
/// authentication, pairing, protocol, or configuration pause.
/// # Errors
///
/// Returns configuration, listener, runtime, or terminal reconnect errors.
pub async fn run_host<F>(
    config: HostConfig,
    credentials: HostCredentials,
    shutdown: F,
) -> Result<(), HostError>
where
    F: Future<Output = ()> + Send,
{
    config.validate()?;
    let listener = TcpListener::bind(config.health_listen)
        .await
        .map_err(|error| HostError::HealthBind(error.to_string()))?;
    let health_listen = listener
        .local_addr()
        .map_err(|error| HostError::HealthBind(error.to_string()))?;
    let state = Arc::new(HostState::default());
    let runtime = build_runtime(&config, &state)?;
    let health_state = Arc::clone(&state);
    let mut health_task = AbortOnDropTask::new(tokio::spawn(async move {
        serve_health(listener, health_state).await
    }));
    let mut connections = Box::pin(run_connections(
        config,
        credentials,
        runtime,
        state,
        health_listen,
        shutdown,
    ));
    tokio::select! {
        result = &mut connections => {
            health_task.abort();
            let _ = (&mut health_task.handle).await;
            result
        }
        health_result = &mut health_task.handle => match health_result {
            Ok(Ok(never)) => match never {},
            Ok(Err(error)) => Err(HostError::HealthServe(error.to_string())),
            Err(error) => Err(HostError::HealthServe(error.to_string())),
        },
    }
}

type HostConnectFuture = Pin<Box<dyn Future<Output = Result<NodeSession, ClientError>> + Send>>;

async fn run_connections<F>(
    config: HostConfig,
    credentials: HostCredentials,
    runtime: CommandRuntime,
    state: Arc<HostState>,
    health_listen: SocketAddr,
    shutdown: F,
) -> Result<(), HostError>
where
    F: Future<Output = ()> + Send,
{
    emit(
        "info",
        "host.starting",
        json!({
            "healthListen": health_listen,
            "statusCommand": config.status_command,
        }),
    );
    let issued_device_token = Arc::new(Mutex::new(credentials.issued_device_token.clone()));
    let identity = credentials.identity.clone();
    let connect = host_connection_factory(
        &config,
        credentials,
        runtime.clone(),
        Arc::clone(&issued_device_token),
    );
    let on_event = host_event_handler(state, identity);
    let on_issued_device_token = host_token_handler(issued_device_token);

    NodeLifecycle::default()
        .run(connect, runtime, on_event, on_issued_device_token, shutdown)
        .await
        .map_err(|LifecycleError::Paused(pause)| {
            HostError::ReconnectPaused(pause_name(&pause).into())
        })
}

fn host_connection_factory(
    config: &HostConfig,
    credentials: HostCredentials,
    runtime: CommandRuntime,
    issued_device_token: Arc<Mutex<Option<String>>>,
) -> impl FnMut() -> HostConnectFuture + Send {
    let connection_config = config.clone();
    move || {
        let issued_device_token = Arc::clone(&issued_device_token);
        let identity = credentials.identity.clone();
        let configured_auth = credentials.configured_auth.clone();
        let runtime = runtime.clone();
        let connection_config = connection_config.clone();
        Box::pin(async move {
            let adopted_auth = issued_device_token
                .lock()
                .map_err(|_| {
                    ClientError::ConnectParams("issued device-token state is unavailable".into())
                })?
                .clone();
            if let Some(device_token) = adopted_auth {
                match connect_host_attempt(
                    &connection_config,
                    identity.clone(),
                    ConnectAuth::device_token(device_token),
                    runtime.clone(),
                )
                .await
                {
                    Ok(session) => return Ok(session),
                    Err(error) if invalidates_adopted_device_token(&error) => {
                        *issued_device_token.lock().map_err(|_| {
                            ClientError::ConnectParams(
                                "issued device-token state is unavailable".into(),
                            )
                        })? = None;
                        emit(
                            "warn",
                            "gateway.device_token_rejected",
                            json!({"action": "retry-configured-auth"}),
                        );
                    }
                    Err(error) => return Err(error),
                }
            }
            connect_host_attempt(&connection_config, identity, configured_auth, runtime).await
        })
    }
}

fn host_event_handler(
    state: Arc<HostState>,
    identity: NodeIdentity,
) -> impl FnMut(LifecycleEvent) + Send {
    move |event| match event {
        LifecycleEvent::Connecting { .. } => state.ready.store(false, Ordering::Release),
        LifecycleEvent::Connected {
            protocol,
            server_version,
            ..
        } => emit(
            "info",
            "gateway.connected",
            json!({
                "protocol": protocol,
                "serverVersion": server_version,
                "deviceId": identity.device_id(),
            }),
        ),
        LifecycleEvent::Ready { .. } => state.ready.store(true, Ordering::Release),
        LifecycleEvent::Disconnected { reason, .. } => {
            state.ready.store(false, Ordering::Release);
            if reason == LifecycleDisconnectReason::RuntimeEnded {
                emit(
                    "warn",
                    "runtime.restart",
                    json!({"reason": "runtime-ended"}),
                );
            }
        }
        LifecycleEvent::BackingOff { delay, reason, .. } => emit_backoff(delay, reason),
        LifecycleEvent::Paused { reason, .. } => {
            state.ready.store(false, Ordering::Release);
            emit(
                "error",
                "gateway.paused",
                json!({
                    "reason": pause_name(&reason),
                    "diagnostic": pause_diagnostic(&reason),
                }),
            );
        }
        LifecycleEvent::Stopped { drained, .. } => {
            state.ready.store(false, Ordering::Release);
            emit(
                "info",
                "host.stopped",
                json!({"reason": "shutdown", "drained": drained}),
            );
        }
    }
}

fn emit_backoff(delay: Duration, reason: LifecycleDisconnectReason) {
    match reason {
        LifecycleDisconnectReason::Client(error_class) => emit(
            "warn",
            "gateway.retry",
            json!({
                "delayMs": duration_ms(delay),
                "errorClass": client_error_class_name(error_class),
            }),
        ),
        LifecycleDisconnectReason::Runtime(error_class) => emit(
            "error",
            "runtime.restart",
            json!({"reason": runtime_error_class_name(error_class)}),
        ),
        LifecycleDisconnectReason::RuntimeEnded | LifecycleDisconnectReason::Shutdown => {}
    }
}

fn host_token_handler(issued_device_token: Arc<Mutex<Option<String>>>) -> impl FnMut(&str) + Send {
    move |device_token| {
        let Ok(mut current) = issued_device_token.lock() else {
            emit(
                "error",
                "gateway.device_token_adoption_failed",
                json!({"reason": "local-state-unavailable"}),
            );
            return;
        };
        *current = Some(device_token.to_owned());
        emit(
            "info",
            "gateway.device_token_adopted",
            json!({"persistence": "process-memory"}),
        );
    }
}

async fn connect_host_attempt(
    config: &HostConfig,
    identity: NodeIdentity,
    auth: ConnectAuth,
    runtime: CommandRuntime,
) -> Result<crate::NodeSession, ClientError> {
    let mut options = NodeConnectOptions::new(env!("CARGO_PKG_VERSION"), env::consts::OS)
        .display_name(config.display_name.clone())
        .identity(identity)
        .auth(auth);
    if let Some(instance_id) = &config.instance_id {
        options = options.instance_id(instance_id.clone());
    }
    NodeClient::connect(
        NodeClientConfig::new(config.gateway_url.clone()),
        move |_nonce| async move { Ok::<_, Infallible>(runtime.activate(options)) },
    )
    .await
}

fn invalidates_adopted_device_token(error: &ClientError) -> bool {
    let ClientError::Gateway {
        method, details, ..
    } = error
    else {
        return false;
    };
    method == "connect"
        && openclaw_gateway_client::ConnectErrorDetails::from_value(details.as_ref())
            .invalidates_device_token()
}

fn build_runtime(
    config: &HostConfig,
    state: &Arc<HostState>,
) -> Result<CommandRuntime, RuntimeBuildError> {
    let status_state = Arc::clone(state);
    CommandRuntime::builder()
        .max_concurrency(config.max_concurrency)
        .max_input_bytes(config.max_input_bytes)
        .max_output_bytes(config.max_output_bytes)
        .default_timeout(Duration::from_millis(config.default_timeout_ms))
        .max_timeout(Duration::from_millis(config.max_timeout_ms))
        .command(config.status_command.clone(), move |_context| {
            let status_state = Arc::clone(&status_state);
            async move {
                Ok(json!({
                    "ready": status_state.ready.load(Ordering::Acquire),
                    "version": env!("CARGO_PKG_VERSION"),
                }))
            }
        })
        .build()
}

async fn serve_health(
    listener: TcpListener,
    state: Arc<HostState>,
) -> Result<Infallible, std::io::Error> {
    let permits = Arc::new(Semaphore::new(MAX_HEALTH_CONNECTIONS));
    let mut requests = JoinSet::new();
    let mut consecutive_accept_errors = 0;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _peer) = match accepted {
                    Ok(accepted) => {
                        consecutive_accept_errors = 0;
                        accepted
                    }
                    Err(error) => {
                        consecutive_accept_errors += 1;
                        emit(
                            "warn",
                            "health.accept_failed",
                            json!({
                                "attempt": consecutive_accept_errors,
                                "errorClass": error.kind().to_string(),
                            }),
                        );
                        if consecutive_accept_errors >= MAX_CONSECUTIVE_HEALTH_ACCEPT_ERRORS {
                            return Err(error);
                        }
                        tokio::time::sleep(HEALTH_ACCEPT_RETRY_DELAY).await;
                        continue;
                    }
                };
                let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                    emit("warn", "health.saturated", json!({"limit": MAX_HEALTH_CONNECTIONS}));
                    drop(stream);
                    continue;
                };
                let request_state = Arc::clone(&state);
                requests.spawn(async move {
                    let result = serve_health_request(stream, &request_state).await;
                    (result, permit)
                });
            }
            Some(completed) = requests.join_next(), if !requests.is_empty() => {
                match completed {
                    Ok((Ok(()), _permit)) => {}
                    Ok((Err(error), _permit)) => emit(
                        "warn",
                        "health.request_failed",
                        json!({"errorClass": error.kind().to_string()}),
                    ),
                    Err(error) => emit(
                        "warn",
                        "health.request_failed",
                        json!({"errorClass": if error.is_panic() { "panic" } else { "cancelled" }}),
                    ),
                }
            }
        }
    }
}

async fn serve_health_request(
    mut stream: TcpStream,
    state: &HostState,
) -> Result<(), std::io::Error> {
    let mut request = [0_u8; 4096];
    let count = tokio::time::timeout(
        Duration::from_secs(2),
        read_request_line(&mut stream, &mut request),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "request timeout"))??;
    let first_line = std::str::from_utf8(&request[..count])
        .ok()
        .and_then(|request| request.lines().next())
        .unwrap_or_default();
    let mut request_parts = first_line.split_ascii_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let path = request_parts.next().unwrap_or_default();
    let ready = state.ready.load(Ordering::Acquire);
    let (status, body) = match (method, path) {
        ("GET", "/healthz") => ("200 OK", json!({"status": "ok"})),
        ("GET", "/readyz") if ready => ("200 OK", json!({"ready": true})),
        ("GET", "/readyz") => ("503 Service Unavailable", json!({"ready": false})),
        ("GET", _) => ("404 Not Found", json!({"error": "not found"})),
        _ => (
            "405 Method Not Allowed",
            json!({"error": "method not allowed"}),
        ),
    };
    let body = serde_json::to_vec(&body).expect("health response serialization cannot fail");
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.shutdown().await
}

async fn read_request_line(
    stream: &mut TcpStream,
    request: &mut [u8; 4096],
) -> Result<usize, std::io::Error> {
    let mut count = 0;
    while count < request.len() {
        let read = stream.read(&mut request[count..]).await?;
        if read == 0 {
            break;
        }
        count += read;
        if request[..count].contains(&b'\n') {
            return Ok(count);
        }
    }
    if count == request.len() && !request.contains(&b'\n') {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "request line too long",
        ));
    }
    Ok(count)
}

fn decode_identity(value: &[u8]) -> Result<[u8; 32], HostError> {
    let encoded = std::str::from_utf8(value)
        .map(str::trim)
        .map_err(|_| HostError::IdentitySecret("secret must be unpadded base64url".into()))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| HostError::IdentitySecret("secret must be unpadded base64url".into()))?;
    decoded
        .try_into()
        .map_err(|_| HostError::IdentitySecret("identity secret must decode to 32 bytes".into()))
}

fn pause_name(pause: &ReconnectPause) -> &'static str {
    match pause {
        ReconnectPause::DevicePairing(_) => "device-pairing",
        ReconnectPause::Authentication { .. } => "authentication",
        ReconnectPause::Protocol { .. } => "protocol",
        ReconnectPause::Configuration => "configuration",
        ReconnectPause::LocalIdentity => "local-identity",
    }
}

fn pause_diagnostic(pause: &ReconnectPause) -> Value {
    match pause {
        ReconnectPause::DevicePairing(request) => json!({
            "requestId": request.request_id,
            "deviceId": request.device_id,
            "requestedRole": request.requested_role,
            "requestedScopes": request.requested_scopes,
            "remediationHint": request.remediation_hint,
        }),
        ReconnectPause::Authentication { detail_code } => json!({"detailCode": detail_code}),
        ReconnectPause::Protocol { detail_code } => json!({"detailCode": detail_code}),
        ReconnectPause::Configuration | ReconnectPause::LocalIdentity => json!({}),
    }
}

fn client_error_class_name(error: ClientErrorClass) -> &'static str {
    match error {
        ClientErrorClass::Configuration => "configuration",
        ClientErrorClass::Transport => "transport",
        ClientErrorClass::Protocol => "protocol",
        ClientErrorClass::Identity => "identity",
        ClientErrorClass::Gateway => "gateway",
        ClientErrorClass::RequestTimeout => "request-timeout",
        ClientErrorClass::EventLagged => "event-lagged",
        ClientErrorClass::Activation => "activation",
    }
}

fn runtime_error_class_name(error: RuntimeErrorClass) -> &'static str {
    match error {
        RuntimeErrorClass::DeliverySaturated => "delivery-saturated",
        RuntimeErrorClass::ResultTask => "result-task",
    }
}

fn emit(level: &str, event: &str, fields: Value) {
    let mut record = serde_json::Map::with_capacity(3);
    record.insert("level".into(), Value::String(level.into()));
    record.insert("event".into(), Value::String(event.into()));
    record.insert("fields".into(), fields);
    eprintln!("{}", Value::Object(record));
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn default_display_name() -> String {
    "Rust node host".into()
}
fn default_health_listen() -> SocketAddr {
    DEFAULT_HEALTH_LISTEN
        .parse()
        .expect("valid default address")
}
fn default_status_command() -> String {
    DEFAULT_STATUS_COMMAND.into()
}
fn default_auth_env() -> String {
    DEFAULT_AUTH_ENV.into()
}
fn default_identity_secret_env() -> String {
    DEFAULT_IDENTITY_SECRET_ENV.into()
}
const fn default_max_concurrency() -> usize {
    4
}
const fn default_max_input_bytes() -> usize {
    64 * 1024
}
const fn default_max_output_bytes() -> usize {
    64 * 1024
}
const fn default_timeout_ms() -> u64 {
    30_000
}
const fn default_max_timeout_ms() -> u64 {
    120_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    fn config_json(extra: &str) -> String {
        format!(r#"{{"gatewayUrl":"ws://127.0.0.1:18789"{extra}}}"#)
    }

    #[tokio::test]
    async fn config_defaults_are_bounded_local_and_collision_free() {
        let config: HostConfig = serde_json::from_str(&config_json("")).unwrap();
        config.validate().unwrap();
        assert!(config.health_listen().ip().is_loopback());
        assert_eq!(config.health_listen().port(), 0);
        let listener = TcpListener::bind(config.health_listen()).await.unwrap();
        assert_ne!(listener.local_addr().unwrap().port(), 0);
        assert_eq!(config.status_command(), DEFAULT_STATUS_COMMAND);
    }

    #[test]
    fn config_rejects_reserved_commands_remote_health_and_secret_ambiguity() {
        for extra in [
            r#", "statusCommand":"system.run""#,
            r#", "healthListen":"0.0.0.0:18790""#,
            r#", "identitySecretEnv":" ""#,
            r#", "authEnv":"openclaw_node_identity""#,
        ] {
            let config: HostConfig = serde_json::from_str(&config_json(extra)).unwrap();
            assert!(config.validate().is_err(), "accepted {extra}");
        }
        let oversized = config_json(&format!(
            r#", "maxConcurrency":{}"#,
            Semaphore::MAX_PERMITS.saturating_add(1)
        ));
        let config: HostConfig = serde_json::from_str(&oversized).unwrap();
        assert!(config.validate().is_err());
    }

    #[test]
    fn identity_accepts_only_exact_base64url_material() {
        let encoded = URL_SAFE_NO_PAD.encode([9; 32]);
        assert_eq!(decode_identity(encoded.as_bytes()).unwrap(), [9; 32]);
        assert!(decode_identity(&[7; 32]).is_err());
        assert!(decode_identity(b"short").is_err());
    }

    #[tokio::test]
    async fn stalled_health_request_does_not_starve_other_probes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_health(listener, Arc::new(HostState::default())));
        let mut stalled = TcpStream::connect(address).await.unwrap();
        stalled.write_all(b"G").await.unwrap();

        let probe = async {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream
                .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .await
                .unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            String::from_utf8(response).unwrap()
        };
        let response = tokio::time::timeout(Duration::from_millis(500), probe)
            .await
            .expect("stalled client must not block independent health probes");
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");

        drop(stalled);
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn rejected_adopted_device_token_retries_configured_auth_once() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 1..=2 {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(tcp).await.unwrap();
                send_test_json(
                    &mut socket,
                    json!({
                        "type":"event", "event":"connect.challenge",
                        "payload":{"nonce":format!("nonce-{attempt}")}
                    }),
                )
                .await;
                let connect = receive_test_json(&mut socket).await;
                if attempt == 1 {
                    assert_eq!(
                        connect["params"]["auth"]["deviceToken"],
                        "adopted-device-token"
                    );
                    send_test_json(
                        &mut socket,
                        json!({
                            "type":"res", "id":connect["id"], "ok":false,
                            "error":{
                                "code":"UNAUTHORIZED",
                                "message":"device token rejected",
                                "details":{"code":"AUTH_DEVICE_TOKEN_MISMATCH"}
                            }
                        }),
                    )
                    .await;
                } else {
                    assert_eq!(connect["params"]["auth"]["token"], "configured-token");
                    send_test_json(
                        &mut socket,
                        json!({
                            "type":"res", "id":connect["id"], "ok":true,
                            "payload":{"type":"hello-ok","protocol":4}
                        }),
                    )
                    .await;
                }
            }
        });

        let config: HostConfig =
            serde_json::from_str(&format!(r#"{{"gatewayUrl":"ws://{address}"}}"#)).unwrap();
        let mut credentials = HostCredentials::new(
            NodeIdentity::from_secret_bytes([7; 32]),
            ConnectAuth::token("configured-token"),
        );
        credentials.issued_device_token = Some("adopted-device-token".into());
        let issued_device_token = Arc::new(Mutex::new(credentials.issued_device_token.clone()));
        let mut connect = host_connection_factory(
            &config,
            credentials,
            CommandRuntime::builder().build().unwrap(),
            Arc::clone(&issued_device_token),
        );

        let session = connect().await.unwrap();
        assert_eq!(session.hello()["protocol"], 4);
        assert!(issued_device_token.lock().unwrap().is_none());
        drop(session);
        server.await.unwrap();
    }

    async fn send_test_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    async fn receive_test_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let message = socket.next().await.unwrap().unwrap();
        let Message::Text(text) = message else {
            panic!("expected text frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }
}
