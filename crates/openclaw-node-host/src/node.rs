use openclaw_gateway_client::{
    ClientError as GatewayClientError, GatewayClient, GatewayClientConfig, GatewaySession, TlsTrust,
};
pub use openclaw_gateway_client::{Event, EventSubscription};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use thiserror::Error;

use crate::identity::{DeviceSigningRequest, IdentityError, NodeIdentity};

const PROTOCOL_VERSION: u32 = 4;
const MINIMUM_NODE_PROTOCOL_VERSION: u32 = 3;
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_CHALLENGE_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BUFFER_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct NodeClientConfig {
    gateway_url: String,
    tls_trust: TlsTrust,
    headers: Vec<(String, String)>,
    connect_timeout: Duration,
    challenge_timeout: Duration,
    request_timeout: Duration,
    write_timeout: Duration,
    max_message_bytes: usize,
    max_event_buffer_bytes: usize,
    event_capacity: usize,
    max_in_flight: usize,
}

impl NodeClientConfig {
    #[must_use]
    pub fn new(gateway_url: impl Into<String>) -> Self {
        Self {
            gateway_url: gateway_url.into(),
            tls_trust: TlsTrust::SystemRoots,
            headers: Vec::new(),
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            challenge_timeout: DEFAULT_CHALLENGE_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            write_timeout: DEFAULT_WRITE_TIMEOUT,
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
            max_event_buffer_bytes: DEFAULT_MAX_EVENT_BUFFER_BYTES,
            event_capacity: 256,
            max_in_flight: 64,
        }
    }

    #[must_use]
    pub fn tls_trust(mut self, trust: TlsTrust) -> Self {
        self.tls_trust = trust;
        self
    }

    #[must_use]
    pub fn upgrade_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    #[must_use]
    pub fn challenge_timeout(mut self, timeout: Duration) -> Self {
        self.challenge_timeout = timeout;
        self
    }

    #[must_use]
    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    #[must_use]
    pub fn request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    #[must_use]
    pub fn write_timeout(mut self, timeout: Duration) -> Self {
        self.write_timeout = timeout;
        self
    }

    #[must_use]
    pub fn max_message_bytes(mut self, bytes: usize) -> Self {
        self.max_message_bytes = bytes;
        self
    }

    #[must_use]
    pub fn max_event_buffer_bytes(mut self, bytes: usize) -> Self {
        self.max_event_buffer_bytes = bytes;
        self
    }

    #[must_use]
    pub fn event_capacity(mut self, capacity: usize) -> Self {
        self.event_capacity = capacity;
        self
    }

    #[must_use]
    pub fn max_in_flight(mut self, maximum: usize) -> Self {
        self.max_in_flight = maximum;
        self
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProof {
    id: String,
    public_key: String,
    signature: String,
    signed_at: u64,
    nonce: String,
}

impl DeviceProof {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        public_key: impl Into<String>,
        signature: impl Into<String>,
        signed_at: u64,
        nonce: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            public_key: public_key.into(),
            signature: signature.into(),
            signed_at,
            nonce: nonce.into(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectAuth {
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bootstrap_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

impl ConnectAuth {
    #[must_use]
    pub fn token(value: impl Into<String>) -> Self {
        Self::single(Some(value.into()), None, None, None)
    }

    #[must_use]
    pub fn bootstrap_token(value: impl Into<String>) -> Self {
        Self::single(None, Some(value.into()), None, None)
    }

    #[must_use]
    pub fn device_token(value: impl Into<String>) -> Self {
        Self::single(None, None, Some(value.into()), None)
    }

    #[must_use]
    pub fn password(value: impl Into<String>) -> Self {
        Self::single(None, None, None, Some(value.into()))
    }

    fn single(
        token: Option<String>,
        bootstrap_token: Option<String>,
        device_token: Option<String>,
        password: Option<String>,
    ) -> Self {
        Self {
            token,
            bootstrap_token,
            device_token,
            password,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientInfo {
    id: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    version: String,
    platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_family: Option<String>,
    mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeConnectOptions {
    min_protocol: u32,
    max_protocol: u32,
    client: ClientInfo,
    #[serde(rename = "caps", skip_serializing_if = "Vec::is_empty")]
    advertised_caps: Vec<String>,
    #[serde(rename = "commands", skip_serializing_if = "Vec::is_empty")]
    advertised_commands: Vec<String>,
    #[serde(rename = "permissions", skip_serializing_if = "BTreeMap::is_empty")]
    advertised_permissions: BTreeMap<String, bool>,
    #[serde(skip)]
    declared_caps: Vec<String>,
    #[serde(skip)]
    declared_commands: Vec<String>,
    #[serde(skip)]
    declared_permissions: BTreeMap<String, bool>,
    #[serde(skip)]
    activated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_env: Option<String>,
    role: &'static str,
    scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device: Option<DeviceProof>,
    #[serde(skip)]
    identity: Option<NodeIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth: Option<ConnectAuth>,
    #[serde(skip_serializing_if = "Option::is_none")]
    locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_agent: Option<String>,
}

impl NodeConnectOptions {
    #[must_use]
    pub fn new(version: impl Into<String>, platform: impl Into<String>) -> Self {
        Self {
            min_protocol: MINIMUM_NODE_PROTOCOL_VERSION,
            max_protocol: PROTOCOL_VERSION,
            client: ClientInfo {
                id: "node-host",
                display_name: None,
                version: version.into(),
                platform: platform.into(),
                device_family: None,
                mode: "node",
                instance_id: None,
            },
            advertised_caps: Vec::new(),
            advertised_commands: Vec::new(),
            advertised_permissions: BTreeMap::new(),
            declared_caps: Vec::new(),
            declared_commands: Vec::new(),
            declared_permissions: BTreeMap::new(),
            activated: false,
            path_env: None,
            role: "node",
            scopes: Vec::new(),
            device: None,
            identity: None,
            auth: None,
            locale: None,
            user_agent: None,
        }
    }

    #[must_use]
    pub fn display_name(mut self, value: impl Into<String>) -> Self {
        self.client.display_name = Some(value.into());
        self
    }

    #[must_use]
    pub fn instance_id(mut self, value: impl Into<String>) -> Self {
        self.client.instance_id = Some(value.into());
        self
    }

    #[must_use]
    pub fn device_family(mut self, value: impl Into<String>) -> Self {
        self.client.device_family = Some(value.into());
        self
    }

    #[must_use]
    pub fn capability(mut self, value: impl Into<String>) -> Self {
        self.declared_caps.push(value.into());
        self
    }

    #[must_use]
    pub fn command(mut self, value: impl Into<String>) -> Self {
        self.declared_commands.push(value.into());
        self
    }

    #[must_use]
    pub fn permission(mut self, name: impl Into<String>, allowed: bool) -> Self {
        self.declared_permissions.insert(name.into(), allowed);
        self
    }

    /// Advertise the declared node surface on this connection.
    ///
    /// Declarations are withheld by default so an embedding can establish its
    /// own readiness before asking the Gateway to approve or expose them.
    /// Gateway approval remains authoritative and is intentionally not inferred
    /// from a successful `hello-ok` response.
    #[must_use]
    pub fn activate(mut self) -> Self {
        self.activated = true;
        self
    }

    #[must_use]
    pub fn path_env(mut self, value: impl Into<String>) -> Self {
        self.path_env = Some(value.into());
        self
    }

    #[must_use]
    pub fn device(mut self, value: DeviceProof) -> Self {
        self.device = Some(value);
        self.identity = None;
        self
    }

    /// Use a library-managed Ed25519 identity for the final connect signature.
    #[must_use]
    pub fn identity(mut self, value: NodeIdentity) -> Self {
        self.identity = Some(value);
        self.device = None;
        self
    }

    /// Prepare the canonical v3 payload for an embedding-owned Ed25519 key.
    ///
    /// The caller signs [`DeviceSigningRequest::payload`] with the private key
    /// corresponding to `public_key`, completes the request, and supplies the
    /// resulting proof through [`Self::device`]. The private key never enters
    /// this crate.
    /// # Errors
    ///
    /// Returns an error when the system clock cannot produce the signed-at
    /// timestamp required by the Gateway contract.
    pub fn external_signing_request(
        &self,
        public_key: [u8; 32],
        nonce: &str,
    ) -> Result<DeviceSigningRequest, IdentityError> {
        DeviceSigningRequest::new(
            public_key,
            nonce,
            &self.client.platform,
            self.client.device_family.as_deref(),
            self.auth.as_ref().and_then(ConnectAuth::signature_token),
        )
    }

    #[must_use]
    pub fn auth(mut self, value: ConnectAuth) -> Self {
        self.auth = Some(value);
        self
    }

    #[must_use]
    pub fn locale(mut self, value: impl Into<String>) -> Self {
        self.locale = Some(value.into());
        self
    }

    #[must_use]
    pub fn user_agent(mut self, value: impl Into<String>) -> Self {
        self.user_agent = Some(value.into());
        self
    }

    fn finalize_identity(mut self, nonce: &str) -> Result<Self, IdentityError> {
        if self.activated {
            self.advertised_caps.clone_from(&self.declared_caps);
            self.advertised_commands.clone_from(&self.declared_commands);
            self.advertised_permissions
                .clone_from(&self.declared_permissions);
        }
        let Some(identity) = self.identity.take() else {
            return Ok(self);
        };
        self.device = Some(identity.sign_connect(
            nonce,
            &self.client.platform,
            self.client.device_family.as_deref(),
            self.auth.as_ref().and_then(ConnectAuth::signature_token),
        )?);
        Ok(self)
    }
}

impl ConnectAuth {
    fn signature_token(&self) -> Option<&str> {
        self.token
            .as_deref()
            .or(self.device_token.as_deref())
            .or(self.bootstrap_token.as_deref())
    }
}

/// A Gateway-authorized node command invocation.
#[derive(Clone, Debug)]
pub struct NodeInvocation {
    pub id: String,
    pub node_id: String,
    pub command: String,
    pub params: Value,
    pub timeout_ms: Option<u64>,
    pub idempotency_key: Option<String>,
    pub session_key: Option<String>,
    received_params_bytes: Option<usize>,
    received_at: Option<Instant>,
}

impl PartialEq for NodeInvocation {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.node_id == other.node_id
            && self.command == other.command
            && self.params == other.params
            && self.timeout_ms == other.timeout_ms
            && self.idempotency_key == other.idempotency_key
            && self.session_key == other.session_key
    }
}

/// Node-specific events consumed by a command runtime.
#[derive(Clone, Debug, PartialEq)]
pub enum NodeSessionEvent {
    Invocation(NodeInvocation),
    InvocationInput {
        invoke_id: String,
        node_id: String,
        seq: u64,
        payload_json: String,
    },
    InvocationCancelled {
        invoke_id: String,
        node_id: String,
    },
}

impl NodeInvocation {
    /// Construct an invocation for direct programmatic dispatch.
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        node_id: impl Into<String>,
        command: impl Into<String>,
        params: Value,
    ) -> Self {
        Self {
            id: id.into(),
            node_id: node_id.into(),
            command: command.into(),
            params,
            timeout_ms: None,
            idempotency_key: None,
            session_key: None,
            received_params_bytes: None,
            received_at: None,
        }
    }

    pub(crate) fn input_bytes(&self) -> Option<usize> {
        self.received_params_bytes
    }

    pub(crate) fn received_elapsed(&self) -> Option<Duration> {
        self.received_at.map(|received| received.elapsed())
    }
}

/// A structured final result for a node invocation.
#[derive(Clone, Debug, PartialEq)]
pub enum InvocationResult {
    Success(Value),
    Failure { code: String, message: String },
}

impl InvocationResult {
    #[must_use]
    pub fn success(payload: Value) -> Self {
        Self::Success(payload)
    }

    #[must_use]
    pub fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Failure {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("invalid Gateway URL: {0}")]
    InvalidUrl(String),
    #[error("plaintext WebSocket is allowed only for trusted local or private Gateways")]
    InsecureRemoteGateway,
    #[error("Gateway connection failed: {0}")]
    Transport(String),
    #[error("Gateway TLS validation failed: {0}")]
    Tls(String),
    #[error("Gateway connection timed out")]
    ConnectTimeout,
    #[error("Gateway connect challenge timed out")]
    ChallengeTimeout,
    #[error("Gateway connect challenge was invalid: {0}")]
    InvalidChallenge(String),
    #[error("connect parameter callback failed: {0}")]
    ConnectParams(String),
    #[error("node identity failed: {0}")]
    Identity(#[from] IdentityError),
    #[error("Gateway rejected {method}: {code}: {message}")]
    Gateway {
        method: String,
        code: String,
        message: String,
        details: Option<Value>,
        retryable: Option<bool>,
        retry_after_ms: Option<u64>,
    },
    #[error("Gateway request timed out: {0}")]
    RequestTimeout(String),
    #[error("Gateway write timed out: {0}")]
    WriteTimeout(String),
    #[error("Gateway session is closed: {0}")]
    Closed(String),
    #[error("Gateway frame was invalid: {0}")]
    InvalidFrame(String),
    #[error("event consumer fell behind by {0} events")]
    EventLagged(u64),
    #[error("the embedding did not activate this node connection")]
    NotActivated,
}

pub struct NodeClient;

impl NodeClient {
    /// Connect a node profile using challenge-bound connect parameters.
    /// # Errors
    ///
    /// Returns configuration, transport, identity, protocol, or Gateway rejection errors.
    pub async fn connect<F, Fut, E>(
        config: NodeClientConfig,
        make_options: F,
    ) -> Result<NodeSession, ClientError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<NodeConnectOptions, E>>,
        E: Error + Send + Sync + 'static,
    {
        let mut gateway_config = GatewayClientConfig::new(&config.gateway_url)
            .map_err(map_gateway_error)?
            .tls_trust(config.tls_trust)
            .connect_timeout(config.connect_timeout)
            .challenge_timeout(config.challenge_timeout)
            .request_timeout(config.request_timeout)
            .write_timeout(config.write_timeout)
            .max_message_bytes(config.max_message_bytes)
            .max_event_buffer_bytes(config.max_event_buffer_bytes)
            .event_capacity(config.event_capacity)
            .max_in_flight(config.max_in_flight);
        for (name, value) in config.headers {
            gateway_config = gateway_config
                .header(&name, &value)
                .map_err(map_gateway_error)?;
        }
        let connection_surface = Arc::new(Mutex::new((false, BTreeSet::new())));
        let surface_for_connect = Arc::clone(&connection_surface);
        let gateway = GatewayClient::connect(gateway_config, move |nonce| async move {
            let options = make_options(nonce.clone())
                .await
                .map_err(|error| ConnectOptionsError(error.to_string()))?;
            let options = options
                .finalize_identity(&nonce)
                .map_err(|error| ConnectOptionsError(error.to_string()))?;
            *surface_for_connect
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = (
                options.activated,
                options.advertised_commands.iter().cloned().collect(),
            );
            serde_json::to_value(options).map_err(|error| ConnectOptionsError(error.to_string()))
        })
        .await
        .map_err(map_gateway_error)?;

        let (activated, advertised_commands) = connection_surface
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        Ok(NodeSession {
            gateway,
            activated,
            advertised_commands: Arc::new(advertised_commands),
            runtime_marker: Arc::new(()),
        })
    }
}

#[derive(Debug, Error)]
#[error("{0}")]
struct ConnectOptionsError(String);

#[derive(Clone)]
pub struct NodeSession {
    gateway: GatewaySession,
    activated: bool,
    advertised_commands: Arc<BTreeSet<String>>,
    runtime_marker: Arc<()>,
}

impl NodeSession {
    pub(crate) fn runtime_scope(&self) -> (usize, std::sync::Weak<()>) {
        (
            Arc::as_ptr(&self.runtime_marker) as usize,
            Arc::downgrade(&self.runtime_marker),
        )
    }

    pub(crate) fn advertises_command(&self, command: &str) -> bool {
        self.advertised_commands.contains(command)
    }

    #[must_use]
    pub fn hello(&self) -> &Value {
        self.gateway.hello()
    }

    #[must_use]
    pub fn is_activated(&self) -> bool {
        self.activated
    }

    /// Return the issued device token from `hello-ok`, when the Gateway supplied
    /// one. Embeddings remain responsible for secure persistence and for
    /// selecting it on a later connection attempt.
    #[must_use]
    pub fn issued_device_token(&self) -> Option<&str> {
        self.hello()["auth"]["deviceToken"]
            .as_str()
            .filter(|token| !token.is_empty())
    }

    #[must_use]
    pub fn subscribe(&self) -> EventSubscription {
        self.gateway.subscribe()
    }

    /// Receive the next retained Gateway event.
    /// # Errors
    ///
    /// Returns a lag, invalid-frame, transport, or closed-session error.
    pub async fn next_event(&self) -> Result<Event, ClientError> {
        self.gateway.next_event().await.map_err(map_gateway_error)
    }

    /// Receive the next invocation, ordered input, or cancellation event for this node.
    /// # Errors
    ///
    /// Returns an activation, payload, lag, transport, or closed-session error.
    pub async fn next_node_event(&self) -> Result<NodeSessionEvent, ClientError> {
        if !self.activated {
            return Err(ClientError::NotActivated);
        }
        loop {
            let event = self.next_event().await?;
            match event.event.as_str() {
                "node.invoke.request" => {
                    return parse_invocation(event.payload, Instant::now())
                        .map(NodeSessionEvent::Invocation);
                }
                "node.invoke.input" => {
                    return parse_invocation_input(event.payload);
                }
                "node.invoke.cancel" => {
                    return parse_invocation_cancel(event.payload);
                }
                _ => {}
            }
        }
    }

    /// Receive the next authorized node invocation.
    ///
    /// Embeddings that execute more than one invocation concurrently should use
    /// [`Self::next_node_event`] so Gateway input and cancellation events are not discarded.
    /// # Errors
    ///
    /// Returns an activation, payload, lag, transport, or closed-session error.
    pub async fn next_invocation(&self) -> Result<NodeInvocation, ClientError> {
        loop {
            if let NodeSessionEvent::Invocation(invocation) = self.next_node_event().await? {
                return Ok(invocation);
            }
        }
    }

    /// Send a final result for an authorized invocation.
    /// # Errors
    ///
    /// Returns an activation, validation, Gateway, timeout, or closed-session error.
    pub async fn complete_invocation(
        &self,
        invocation: &NodeInvocation,
        result: InvocationResult,
    ) -> Result<(), ClientError> {
        if !self.activated {
            return Err(ClientError::NotActivated);
        }
        let params = invocation_result_params(invocation, result)?;
        self.request("node.invoke.result", params).await.map(|_| ())
    }

    /// Send a correlated Gateway request.
    /// # Errors
    ///
    /// Returns validation, Gateway, timeout, transport, or closed-session errors.
    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, ClientError> {
        self.gateway
            .request(method, params)
            .await
            .map_err(map_gateway_error)
    }

    pub async fn close(&self) {
        self.gateway.close().await;
    }

    /// Wait until the Gateway transport closes.
    /// # Errors
    ///
    /// Returns the transport's terminal close reason.
    pub async fn wait_closed(&self) -> Result<(), ClientError> {
        self.gateway.wait_closed().await.map_err(map_gateway_error)
    }
}

fn invocation_result_params(
    invocation: &NodeInvocation,
    result: InvocationResult,
) -> Result<Value, ClientError> {
    Ok(match result {
        InvocationResult::Success(payload) => json!({
            "id": invocation.id,
            "nodeId": invocation.node_id,
            "ok": true,
            "payload": payload,
        }),
        InvocationResult::Failure { code, message } => {
            let code = require_non_empty_result_field("error code", code)?;
            let message = require_non_empty_result_field("error message", message)?;
            json!({
                "id": invocation.id,
                "nodeId": invocation.node_id,
                "ok": false,
                "error": { "code": code, "message": message },
            })
        }
    })
}

fn map_gateway_error(error: GatewayClientError) -> ClientError {
    match error {
        GatewayClientError::InvalidUrl(error) | GatewayClientError::InvalidHeader(error) => {
            ClientError::InvalidUrl(error)
        }
        GatewayClientError::InsecureRemoteGateway => ClientError::InsecureRemoteGateway,
        GatewayClientError::Transport(error) => ClientError::Transport(error),
        GatewayClientError::Tls(error) => ClientError::Tls(error),
        GatewayClientError::ConnectTimeout => ClientError::ConnectTimeout,
        GatewayClientError::ChallengeTimeout => ClientError::ChallengeTimeout,
        GatewayClientError::InvalidChallenge(error) => ClientError::InvalidChallenge(error),
        GatewayClientError::ConnectParams(error) => ClientError::ConnectParams(error),
        GatewayClientError::Gateway {
            method,
            code,
            message,
            details,
            retryable,
            retry_after_ms,
        } => ClientError::Gateway {
            method,
            code,
            message,
            details,
            retryable,
            retry_after_ms,
        },
        GatewayClientError::RequestTimeout(method) => ClientError::RequestTimeout(method),
        GatewayClientError::WriteTimeout(operation) => ClientError::WriteTimeout(operation),
        GatewayClientError::Closed(error) => ClientError::Closed(error),
        GatewayClientError::InvalidFrame(error) => ClientError::InvalidFrame(error),
        GatewayClientError::EventLagged(count) => ClientError::EventLagged(count),
    }
}

fn parse_invocation_input(payload: Value) -> Result<NodeSessionEvent, ClientError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        id: String,
        node_id: String,
        seq: u64,
        #[serde(rename = "payloadJSON")]
        json: String,
    }

    let payload: Payload = serde_json::from_value(payload).map_err(|error| {
        ClientError::InvalidFrame(format!("invalid node.invoke.input: {error}"))
    })?;
    if payload.json.len() > crate::duplex::MAX_INPUT_FRAME_BYTES {
        return Err(ClientError::InvalidFrame(
            "node.invoke.input payloadJSON exceeds 16 KiB".into(),
        ));
    }
    Ok(NodeSessionEvent::InvocationInput {
        invoke_id: require_non_empty_result_field("input invocation id", payload.id)?,
        node_id: require_non_empty_result_field("input invocation node id", payload.node_id)?,
        seq: payload.seq,
        payload_json: payload.json,
    })
}

fn parse_invocation_cancel(payload: Value) -> Result<NodeSessionEvent, ClientError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        invoke_id: String,
        node_id: String,
    }

    let payload: Payload = serde_json::from_value(payload).map_err(|error| {
        ClientError::InvalidFrame(format!("invalid node.invoke.cancel: {error}"))
    })?;
    Ok(NodeSessionEvent::InvocationCancelled {
        invoke_id: require_non_empty_result_field("cancelled invocation id", payload.invoke_id)?,
        node_id: require_non_empty_result_field("cancelled invocation node id", payload.node_id)?,
    })
}

fn parse_invocation(payload: Value, received_at: Instant) -> Result<NodeInvocation, ClientError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        id: String,
        node_id: String,
        command: String,
        #[serde(
            default,
            rename = "paramsJSON",
            deserialize_with = "deserialize_nullable_string"
        )]
        params_json: Option<String>,
        #[serde(default, deserialize_with = "deserialize_optional_u64")]
        timeout_ms: Option<u64>,
        #[serde(default, deserialize_with = "deserialize_optional_string")]
        idempotency_key: Option<String>,
        #[serde(default)]
        session_key: Option<String>,
    }

    let payload: Payload = serde_json::from_value(payload).map_err(|error| {
        ClientError::InvalidFrame(format!("invalid node.invoke.request: {error}"))
    })?;
    let id = require_non_empty_result_field("invocation id", payload.id)?;
    let node_id = require_non_empty_result_field("invocation node id", payload.node_id)?;
    let command = require_non_empty_result_field("invocation command", payload.command)?;
    let idempotency_key = payload
        .idempotency_key
        .map(|value| require_non_empty_result_field("invocation idempotency key", value))
        .transpose()?;
    let session_key = payload
        .session_key
        .map(|value| require_non_empty_result_field("invocation session key", value))
        .transpose()?;
    let (params, received_params_bytes) = match payload.params_json {
        Some(value) => {
            let received_params_bytes = value.len();
            let params = serde_json::from_str(&value).map_err(|error| {
                ClientError::InvalidFrame(format!("invalid invocation paramsJSON: {error}"))
            })?;
            (params, Some(received_params_bytes))
        }
        None => (Value::Null, Some(0)),
    };
    Ok(NodeInvocation {
        id,
        node_id,
        command,
        params,
        timeout_ms: payload.timeout_ms,
        idempotency_key,
        session_key,
        received_params_bytes,
        received_at: Some(received_at),
    })
}

fn require_non_empty_result_field(name: &str, value: String) -> Result<String, ClientError> {
    if value.is_empty() {
        return Err(ClientError::InvalidFrame(format!(
            "{name} must not be empty"
        )));
    }
    Ok(value)
}

fn deserialize_nullable_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn deserialize_optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    u64::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_invocation_lifecycle_contract_matches_openclaw() {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/node-invoke-lifecycle-contract.json"
        )))
        .expect("valid node invocation lifecycle fixture");
        assert_eq!(fixture["version"], 1);

        let invocation = parse_invocation(fixture["request"]["canonical"].clone(), Instant::now())
            .expect("canonical invocation request");
        assert_eq!(invocation.id, "invoke-1");
        assert_eq!(invocation.command, "example.duplex");
        assert_eq!(invocation.params, Value::Null);
        assert_eq!(invocation.timeout_ms, Some(0));
        assert_eq!(invocation.idempotency_key.as_deref(), Some("idem-1"));
        assert_eq!(invocation.session_key.as_deref(), Some("agent:main:main"));
        assert!(parse_invocation(fixture["request"]["invalid"].clone(), Instant::now()).is_err());

        let inputs = fixture["input"]["canonical"]
            .as_array()
            .expect("canonical input array");
        for (seq, payload) in inputs.iter().enumerate() {
            assert_eq!(
                parse_invocation_input(payload.clone()).expect("canonical invocation input"),
                NodeSessionEvent::InvocationInput {
                    invoke_id: "invoke-1".into(),
                    node_id: "node-1".into(),
                    seq: seq as u64,
                    payload_json: if seq == 0 { "one" } else { "two" }.into(),
                }
            );
        }
        assert!(parse_invocation_input(fixture["input"]["invalid"].clone()).is_err());

        let success = invocation_result_params(
            &invocation,
            InvocationResult::success(fixture["results"]["success"]["payload"].clone()),
        )
        .expect("canonical success result");
        assert_eq!(success, fixture["results"]["success"]);
        let failure = &fixture["results"]["failure"];
        let failed_invocation = NodeInvocation::new(
            failure["id"].as_str().expect("failure invocation id"),
            failure["nodeId"].as_str().expect("failure node id"),
            "example.duplex",
            Value::Null,
        );
        let failure_params = invocation_result_params(
            &failed_invocation,
            InvocationResult::failure(
                failure["error"]["code"].as_str().expect("failure code"),
                failure["error"]["message"]
                    .as_str()
                    .expect("failure message"),
            ),
        )
        .expect("canonical failure result");
        assert_eq!(failure_params, failure.clone());
    }

    #[test]
    fn parses_gateway_invocation_cancellation() {
        assert_eq!(
            parse_invocation_cancel(json!({"invokeId": "invoke-1", "nodeId": "node-1"}))
                .expect("valid Gateway cancellation"),
            NodeSessionEvent::InvocationCancelled {
                invoke_id: "invoke-1".into(),
                node_id: "node-1".into(),
            }
        );
    }

    #[test]
    fn external_signing_request_uses_final_connect_metadata_and_auth() {
        let options = NodeConnectOptions::new("test", "Windows")
            .device_family("Desktop")
            .auth(ConnectAuth::token("test-token"));
        let public_key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
            .verifying_key()
            .to_bytes();
        let request = options
            .external_signing_request(public_key, "nonce-1")
            .expect("external signing request");
        assert_eq!(
            request.payload(),
            format!(
                "v3|{}|node-host|node|node||{}|test-token|nonce-1|windows|desktop",
                request.device_id(),
                request.signed_at()
            )
        );
    }
    #[test]
    fn invocation_accepts_gateway_null_params_and_session_key() {
        let invocation = parse_invocation(
            json!({
                "id": "invoke-1",
                "nodeId": "node-1",
                "command": "example.status",
                "paramsJSON": null,
                "sessionKey": "agent:main:main"
            }),
            Instant::now(),
        )
        .expect("valid Gateway invocation");

        assert_eq!(invocation.params, Value::Null);
        assert_eq!(invocation.input_bytes(), Some(0));
        assert_eq!(invocation.session_key.as_deref(), Some("agent:main:main"));
    }

    #[test]
    fn preserves_gateway_tls_failures() {
        assert!(matches!(
            map_gateway_error(GatewayClientError::Tls("pin mismatch".into())),
            ClientError::Tls(message) if message == "pin mismatch"
        ));
    }
}
