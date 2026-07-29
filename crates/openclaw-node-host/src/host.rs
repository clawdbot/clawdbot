use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    env, fs,
    future::Future,
    net::SocketAddr,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
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
    ClientError, CommandRuntime, ConnectAuth, NodeClient, NodeClientConfig, NodeConnectOptions,
    NodeIdentity, ReconnectAction, ReconnectPause, ReconnectPolicy, RuntimeBuildError,
    RuntimeError,
};

const DEFAULT_HEALTH_LISTEN: &str = "127.0.0.1:18790";
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
        if !self.health_listen.ip().is_loopback() || self.health_listen.port() == 0 {
            return Err(HostError::Config(
                "healthListen must use a loopback address and nonzero port".into(),
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
    auth: ConnectAuth,
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
            auth,
        })
    }

    #[must_use]
    pub fn new(identity: NodeIdentity, auth: ConnectAuth) -> Self {
        Self { identity, auth }
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

async fn run_connections<F>(
    config: HostConfig,
    mut credentials: HostCredentials,
    runtime: CommandRuntime,
    state: Arc<HostState>,
    shutdown: F,
) -> Result<(), HostError>
where
    F: Future<Output = ()> + Send,
{
    let mut shutdown = Box::pin(shutdown);
    let mut reconnect = ReconnectPolicy::default();
    emit(
        "info",
        "host.starting",
        json!({
            "healthListen": config.health_listen,
            "statusCommand": config.status_command,
        }),
    );
    loop {
        let identity = credentials.identity.clone();
        let auth = credentials.auth.clone();
        let runtime_for_connect = runtime.clone();
        let mut options = NodeConnectOptions::new(env!("CARGO_PKG_VERSION"), env::consts::OS)
            .display_name(config.display_name.clone())
            .identity(identity)
            .auth(auth);
        if let Some(instance_id) = &config.instance_id {
            options = options.instance_id(instance_id.clone());
        }
        let connect = NodeClient::connect(
            NodeClientConfig::new(config.gateway_url.clone()),
            move |_nonce| async move { Ok::<_, Infallible>(runtime_for_connect.activate(options)) },
        );
        let session = tokio::select! {
            () = &mut shutdown => {
                emit("info", "host.stopped", json!({"reason": "shutdown"}));
                return Ok(());
            }
            result = connect => match result {
                Ok(session) => session,
                Err(error) => {
                    state.ready.store(false, Ordering::Release);
                    let delay = reconnect_delay(&mut reconnect, &error)?;
                    if wait_or_shutdown(delay, &mut shutdown).await {
                        emit("info", "host.stopped", json!({"reason": "shutdown"}));
                        return Ok(());
                    }
                    continue;
                }
            }
        };

        reconnect.connected();
        adopt_device_token(&session, &mut credentials);
        state.ready.store(true, Ordering::Release);
        emit_connected(&session, &credentials.identity);
        let runtime_session = session.clone();
        let running = runtime.run(runtime_session);
        tokio::pin!(running);
        let runtime_result = tokio::select! {
            () = &mut shutdown => {
                state.ready.store(false, Ordering::Release);
                let graceful = async {
                    session.close().await;
                    let _ = (&mut running).await;
                };
                let drained = tokio::time::timeout(Duration::from_secs(5), graceful)
                    .await
                    .is_ok();
                emit("info", "host.stopped", json!({"reason": "shutdown", "drained": drained}));
                return Ok(());
            }
            result = &mut running => result,
        };
        state.ready.store(false, Ordering::Release);
        session.close().await;
        match runtime_result {
            Err(RuntimeError::Client(error)) => {
                let delay = reconnect_delay(&mut reconnect, &error)?;
                if wait_or_shutdown(delay, &mut shutdown).await {
                    emit("info", "host.stopped", json!({"reason": "shutdown"}));
                    return Ok(());
                }
            }
            Err(error @ (RuntimeError::DeliverySaturated | RuntimeError::ResultTask(_))) => {
                emit(
                    "error",
                    "runtime.restart",
                    json!({"reason": runtime_error_class(&error)}),
                );
                if wait_or_shutdown(Duration::from_secs(1), &mut shutdown).await {
                    emit("info", "host.stopped", json!({"reason": "shutdown"}));
                    return Ok(());
                }
            }
            Ok(()) => {
                emit(
                    "warn",
                    "runtime.restart",
                    json!({"reason": "runtime-ended"}),
                );
            }
        }
    }
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

fn emit_connected(session: &crate::NodeSession, identity: &NodeIdentity) {
    emit(
        "info",
        "gateway.connected",
        json!({
            "protocol": session.hello()["protocol"],
            "serverVersion": session.hello()["server"]["version"],
            "deviceId": identity.device_id(),
        }),
    );
}

fn adopt_device_token(session: &crate::NodeSession, credentials: &mut HostCredentials) {
    if let Some(device_token) = session.hello()["auth"]["deviceToken"]
        .as_str()
        .filter(|token| !token.is_empty())
    {
        credentials.auth = ConnectAuth::device_token(device_token.to_owned());
        emit(
            "info",
            "gateway.device_token_adopted",
            json!({"persistence": "process-memory"}),
        );
    }
}

async fn wait_or_shutdown<F>(delay: Duration, shutdown: &mut std::pin::Pin<Box<F>>) -> bool
where
    F: Future<Output = ()> + Send,
{
    tokio::select! {
        () = shutdown => true,
        () = tokio::time::sleep(delay) => false,
    }
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

fn reconnect_delay(
    policy: &mut ReconnectPolicy,
    error: &ClientError,
) -> Result<Duration, HostError> {
    match policy.after_failure(error) {
        ReconnectAction::RetryAfter(delay)
        | ReconnectAction::RetryWithStoredDeviceTokenAfter(delay) => {
            emit(
                "warn",
                "gateway.retry",
                json!({
                    "delayMs": duration_ms(delay),
                    "errorClass": client_error_class(error),
                }),
            );
            Ok(delay)
        }
        ReconnectAction::Pause(pause) => {
            let reason = pause_name(&pause);
            emit(
                "error",
                "gateway.paused",
                json!({"reason": reason, "diagnostic": pause_diagnostic(&pause)}),
            );
            Err(HostError::ReconnectPaused(reason.into()))
        }
        // This host calls the policy only after connect failed or its runtime
        // closed the session, so there is no healthy session left to retain.
        ReconnectAction::KeepSession => {
            let delay = Duration::from_secs(1);
            emit(
                "warn",
                "gateway.retry",
                json!({
                    "delayMs": duration_ms(delay),
                    "errorClass": client_error_class(error),
                }),
            );
            Ok(delay)
        }
    }
}

fn client_error_class(error: &ClientError) -> &'static str {
    match error {
        ClientError::InvalidUrl(_) | ClientError::InsecureRemoteGateway => "configuration",
        ClientError::Transport(_) | ClientError::ChallengeTimeout | ClientError::Closed(_) => {
            "transport"
        }
        ClientError::InvalidChallenge(_) | ClientError::InvalidFrame(_) => "protocol",
        ClientError::ConnectParams(_) | ClientError::Identity(_) => "identity",
        ClientError::Gateway { .. } => "gateway",
        ClientError::RequestTimeout(_) => "request-timeout",
        ClientError::EventLagged(_) => "event-lagged",
        ClientError::NotActivated => "activation",
    }
}

fn runtime_error_class(error: &RuntimeError) -> &'static str {
    match error {
        RuntimeError::DeliverySaturated => "delivery-saturated",
        RuntimeError::ResultTask(_) => "result-task",
        RuntimeError::Client(_) => "client",
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

    fn config_json(extra: &str) -> String {
        format!(r#"{{"gatewayUrl":"ws://127.0.0.1:18789"{extra}}}"#)
    }

    #[test]
    fn config_defaults_are_bounded_and_local() {
        let config: HostConfig = serde_json::from_str(&config_json("")).unwrap();
        config.validate().unwrap();
        assert!(config.health_listen().ip().is_loopback());
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

    #[test]
    fn ended_session_retries_request_scoped_failures() {
        let error = ClientError::RequestTimeout("node.invoke.result".into());
        assert_eq!(
            reconnect_delay(&mut ReconnectPolicy::default(), &error).unwrap(),
            Duration::from_secs(1)
        );
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
}
