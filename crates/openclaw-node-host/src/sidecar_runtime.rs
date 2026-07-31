//! Product-neutral bridge from an authenticated sidecar session into the
//! bounded node command runtime.

use std::{
    collections::BTreeSet,
    future::Future,
    io::{self, Write},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use serde::{de::Error as _, ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use thiserror::Error;

use crate::sidecar_protocol::SidecarChannelLiveness;
use crate::{
    CancellationToken, ClientErrorClass, CommandRuntime, HandlerError, InvocationContext,
    InvocationResult, LifecycleDisconnectReason, LifecycleEvent, NodeInvocation, RuntimeBuildError,
    RuntimeErrorClass, SidecarHandshake, SidecarHandshakeState, SidecarPeerRole,
    SidecarProtocolSelection,
};

const MAX_PORTABLE_JSON_INTEGER: u64 = crate::SIDECAR_MAX_FEATURE_BITS;
const MIN_PORTABLE_JSON_INTEGER: i64 = -9_007_199_254_740_991;
const MAX_PORTABLE_JSON_INTEGER_F64: f64 = 9_007_199_254_740_991.0;

#[allow(clippy::trivially_copy_pass_by_ref)] // serde `serialize_with` contract
fn serialize_portable_u64<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if *value > MAX_PORTABLE_JSON_INTEGER {
        return Err(S::Error::custom("integer exceeds portable JSON range"));
    }
    serializer.serialize_u64(*value)
}

fn deserialize_portable_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > MAX_PORTABLE_JSON_INTEGER {
        return Err(D::Error::custom("integer exceeds portable JSON range"));
    }
    Ok(value)
}

#[allow(clippy::ref_option)] // serde `serialize_with` contract
fn serialize_portable_optional_u64<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if value.is_some_and(|value| value > MAX_PORTABLE_JSON_INTEGER) {
        return Err(S::Error::custom("integer exceeds portable JSON range"));
    }
    value.serialize(serializer)
}

fn deserialize_portable_optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<u64>::deserialize(deserializer)?;
    if value.is_some_and(|value| value > MAX_PORTABLE_JSON_INTEGER) {
        return Err(D::Error::custom("integer exceeds portable JSON range"));
    }
    Ok(value)
}

fn portable_json_value(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => true,
        Value::Number(number) => {
            if let Some(value) = number.as_u64() {
                value <= MAX_PORTABLE_JSON_INTEGER
            } else if let Some(value) = number.as_i64() {
                value >= MIN_PORTABLE_JSON_INTEGER
            } else {
                number.as_f64().is_some_and(|value| {
                    value.fract() != 0.0 || value.abs() <= MAX_PORTABLE_JSON_INTEGER_F64
                })
            }
        }
        Value::Array(values) => values.iter().all(portable_json_value),
        Value::Object(values) => values.values().all(portable_json_value),
    }
}

fn serialize_portable_value<S>(value: &Value, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if !portable_json_value(value) {
        return Err(S::Error::custom("integer exceeds portable JSON range"));
    }
    value.serialize(serializer)
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde passes a reference to the borrowed field
fn serialize_portable_value_ref<S>(value: &&Value, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serialize_portable_value(value, serializer)
}

fn deserialize_portable_value<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if !portable_json_value(&value) {
        return Err(D::Error::custom("integer exceeds portable JSON range"));
    }
    Ok(value)
}

pub type SidecarAdapterFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarCommandRegistration {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarRuntimeConfiguration {
    #[serde(
        serialize_with = "serialize_portable_u64",
        deserialize_with = "deserialize_portable_u64"
    )]
    pub manifest_generation: u64,
    pub capabilities: Vec<String>,
    pub commands: Vec<SidecarCommandRegistration>,
    pub max_concurrency: u16,
    pub max_input_bytes: u32,
    pub max_output_bytes: u32,
    pub default_timeout_ms: u32,
    pub max_timeout_ms: u32,
    pub result_grace_ms: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarRuntimeManifest {
    #[serde(
        serialize_with = "serialize_portable_u64",
        deserialize_with = "deserialize_portable_u64"
    )]
    pub manifest_generation: u64,
    pub capabilities: Vec<String>,
    pub commands: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarInvocation {
    pub id: String,
    pub node_id: String,
    pub command: String,
    #[serde(
        serialize_with = "serialize_portable_value",
        deserialize_with = "deserialize_portable_value"
    )]
    pub params: Value,
    #[serde(
        serialize_with = "serialize_portable_optional_u64",
        deserialize_with = "deserialize_portable_optional_u64"
    )]
    pub timeout_ms: Option<u64>,
    pub idempotency_key: Option<String>,
    pub session_key: Option<String>,
}

impl From<&NodeInvocation> for SidecarInvocation {
    fn from(invocation: &NodeInvocation) -> Self {
        Self {
            id: invocation.id.clone(),
            node_id: invocation.node_id.clone(),
            command: invocation.command.clone(),
            params: invocation.params.clone(),
            timeout_ms: invocation.timeout_ms,
            idempotency_key: invocation.idempotency_key.clone(),
            session_key: invocation.session_key.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SidecarAdmissionDecision {
    Allow,
    Deny { code: String, message: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SidecarInvocationResult {
    Success {
        #[serde(
            serialize_with = "serialize_portable_value",
            deserialize_with = "deserialize_portable_value"
        )]
        payload: Value,
    },
    Failure {
        code: String,
        message: String,
    },
}

impl From<SidecarInvocationResult> for Result<Value, HandlerError> {
    fn from(result: SidecarInvocationResult) -> Self {
        match result {
            SidecarInvocationResult::Success { payload } => Ok(payload),
            SidecarInvocationResult::Failure { code, message } => {
                Err(HandlerError::new(code, message))
            }
        }
    }
}

impl From<InvocationResult> for SidecarInvocationResult {
    fn from(result: InvocationResult) -> Self {
        match result {
            InvocationResult::Success(payload) => Self::Success { payload },
            InvocationResult::Failure { code, message } => Self::Failure { code, message },
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SidecarRuntimeState {
    Configured,
    Connecting,
    Ready,
    BackingOff,
    Paused,
    Draining,
    Stopped,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SidecarRuntimeReason {
    Transport,
    Gateway,
    RequestTimeout,
    EventLagged,
    Activation,
    DeliverySaturated,
    ResultTask,
    RuntimeEnded,
    Shutdown,
    Pairing,
    Authentication,
    Protocol,
    Configuration,
    Identity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarRuntimeStatus {
    pub state: SidecarRuntimeState,
    #[serde(
        serialize_with = "serialize_portable_u64",
        deserialize_with = "deserialize_portable_u64"
    )]
    pub manifest_generation: u64,
    pub runtime_version: String,
    #[serde(
        serialize_with = "serialize_portable_u64",
        deserialize_with = "deserialize_portable_u64"
    )]
    pub attempt: u64,
    pub reason: Option<SidecarRuntimeReason>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SidecarRuntimeMessage {
    Configure {
        configuration: SidecarRuntimeConfiguration,
    },
    Configured {
        manifest: SidecarRuntimeManifest,
    },
    AdmissionRequest {
        invocation: SidecarInvocation,
    },
    AdmissionDecision {
        invocation_id: String,
        decision: SidecarAdmissionDecision,
    },
    Invoke {
        invocation: SidecarInvocation,
    },
    Result {
        invocation_id: String,
        result: SidecarInvocationResult,
    },
    Cancel {
        invocation_id: String,
    },
    Status {
        status: SidecarRuntimeStatus,
    },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarInvocationRef<'a> {
    id: &'a str,
    node_id: &'a str,
    command: &'a str,
    #[serde(serialize_with = "serialize_portable_value_ref")]
    params: &'a Value,
    #[serde(serialize_with = "serialize_portable_optional_u64")]
    timeout_ms: Option<u64>,
    idempotency_key: Option<&'a str>,
    session_key: Option<&'a str>,
}

impl<'a> From<&'a NodeInvocation> for SidecarInvocationRef<'a> {
    fn from(invocation: &'a NodeInvocation) -> Self {
        Self {
            id: &invocation.id,
            node_id: &invocation.node_id,
            command: &invocation.command,
            params: &invocation.params,
            timeout_ms: invocation.timeout_ms,
            idempotency_key: invocation.idempotency_key.as_deref(),
            session_key: invocation.session_key.as_deref(),
        }
    }
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum SidecarRuntimeMessageRef<'a> {
    AdmissionRequest {
        invocation: SidecarInvocationRef<'a>,
    },
    AdmissionDecision {
        invocation_id: &'a str,
        decision: &'a SidecarAdmissionDecision,
    },
    Invoke {
        invocation: SidecarInvocationRef<'a>,
    },
    Result {
        invocation_id: &'a str,
        result: &'a SidecarInvocationResult,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SidecarConfigurationState {
    Starting,
    AwaitingConfiguration,
    AwaitingAcknowledgement,
    AcknowledgementPending,
    Configured,
    Activated,
    Failed,
}

/// Enforces the one-time configuration exchange immediately after the
/// authenticated offer/accept handshake.
pub struct SidecarConfigurationExchange {
    role: SidecarPeerRole,
    channel_instance_id: u64,
    selection: SidecarProtocolSelection,
    runtime_version: String,
    state: SidecarConfigurationState,
    configuration: Option<SidecarRuntimeConfiguration>,
    expected_manifest: Option<SidecarRuntimeManifest>,
    max_payload_bytes: Option<usize>,
}

impl SidecarConfigurationExchange {
    /// Bind a configuration exchange to one authenticated handshake.
    ///
    /// # Errors
    ///
    /// Returns an error until the supplied handshake is authenticated.
    #[expect(
        clippy::needless_pass_by_value,
        reason = "consuming the authenticated handshake enforces a one-shot phase transition"
    )]
    pub fn new(handshake: SidecarHandshake) -> Result<Self, SidecarConfigurationError> {
        if handshake.state() != SidecarHandshakeState::Authenticated {
            return Err(SidecarConfigurationError::HandshakeNotAuthenticated);
        }
        let negotiated = handshake
            .negotiated()
            .ok_or(SidecarConfigurationError::HandshakeNotAuthenticated)?;
        let channel_instance_id = handshake
            .bound_channel_instance_id()
            .ok_or(SidecarConfigurationError::HandshakeNotAuthenticated)?;
        let role = handshake.local_role();
        let runtime_version = match role {
            SidecarPeerRole::Runtime => handshake.local_peer().version.clone(),
            SidecarPeerRole::Supervisor => negotiated.remote_peer.version.clone(),
        };
        Ok(Self {
            role,
            channel_instance_id,
            selection: SidecarProtocolSelection::from(negotiated),
            runtime_version,
            state: match role {
                SidecarPeerRole::Supervisor => SidecarConfigurationState::Starting,
                SidecarPeerRole::Runtime => SidecarConfigurationState::AwaitingConfiguration,
            },
            configuration: None,
            expected_manifest: None,
            max_payload_bytes: None,
        })
    }

    #[must_use]
    pub const fn state(&self) -> SidecarConfigurationState {
        self.state
    }

    /// Return the independently derived manifest after configuration has
    /// passed validation.
    #[must_use]
    pub const fn validated_manifest(&self) -> Option<&SidecarRuntimeManifest> {
        self.expected_manifest.as_ref()
    }

    /// Seal the supervisor's single runtime configuration.
    ///
    /// # Errors
    ///
    /// Every wrong role, state, invalid configuration, or encoding error
    /// retires the exchange and authenticated channel. A replacement channel
    /// instance is retired before processing and leaves the exchange intact.
    pub fn start(
        &mut self,
        channel: &mut crate::AuthenticatedSidecarChannel,
        configuration: &SidecarRuntimeConfiguration,
    ) -> Result<Vec<u8>, SidecarConfigurationError> {
        self.ensure_channel(channel)?;
        if self.role != SidecarPeerRole::Supervisor {
            return self.fail(channel, SidecarConfigurationError::SupervisorMustInitiate);
        }
        if channel.role() != self.role {
            return self.fail(channel, SidecarConfigurationError::ChannelRoleMismatch);
        }
        if self.state != SidecarConfigurationState::Starting {
            return self.fail(channel, SidecarConfigurationError::UnexpectedMessage);
        }
        channel.lock_frame_limit();
        if let Err(error) = validate_configuration(configuration, self.selection) {
            return self.fail(channel, SidecarConfigurationError::Configuration(error));
        }
        if let Err(error) = validate_status_budget(
            &self.runtime_version,
            configuration.manifest_generation,
            channel.max_payload_bytes(),
        ) {
            return self.fail(channel, SidecarConfigurationError::Configuration(error));
        }
        let frame = match channel.seal(&SidecarRuntimeMessage::Configure {
            configuration: configuration.clone(),
        }) {
            Ok(frame) => frame,
            Err(error) => return self.fail(channel, SidecarConfigurationError::Frame(error)),
        };
        self.configuration = Some(configuration.clone());
        self.expected_manifest = Some(manifest_from_configuration(configuration));
        self.max_payload_bytes = Some(channel.max_payload_bytes());
        self.state = SidecarConfigurationState::AwaitingAcknowledgement;
        Ok(frame)
    }

    /// Receive the runtime configuration or the configured acknowledgement.
    /// A runtime returns `Some(configuration)`; a supervisor returns `None`.
    ///
    /// # Errors
    ///
    /// Wrong ordering, roles, malformed frames, invalid configuration, and a
    /// forged acknowledgement are terminal for the exchange and channel.
    pub fn receive(
        &mut self,
        channel: &mut crate::AuthenticatedSidecarChannel,
        frame: &[u8],
    ) -> Result<Option<SidecarRuntimeConfiguration>, SidecarConfigurationError> {
        self.ensure_channel(channel)?;
        if channel.role() != self.role {
            return self.fail(channel, SidecarConfigurationError::ChannelRoleMismatch);
        }
        channel.lock_frame_limit();
        let message = match channel.open::<SidecarRuntimeMessage>(frame) {
            Ok(message) => message,
            Err(error) => return self.fail(channel, SidecarConfigurationError::Frame(error)),
        };
        match (self.role, self.state, message) {
            (
                SidecarPeerRole::Runtime,
                SidecarConfigurationState::AwaitingConfiguration,
                SidecarRuntimeMessage::Configure { configuration },
            ) => {
                if let Err(error) = validate_configuration(&configuration, self.selection) {
                    return self.fail(channel, SidecarConfigurationError::Configuration(error));
                }
                if let Err(error) = validate_status_budget(
                    &self.runtime_version,
                    configuration.manifest_generation,
                    channel.max_payload_bytes(),
                ) {
                    return self.fail(channel, SidecarConfigurationError::Configuration(error));
                }
                self.configuration = Some(configuration.clone());
                self.expected_manifest = Some(manifest_from_configuration(&configuration));
                self.max_payload_bytes = Some(channel.max_payload_bytes());
                self.state = SidecarConfigurationState::AwaitingAcknowledgement;
                Ok(Some(configuration))
            }
            (
                SidecarPeerRole::Supervisor,
                SidecarConfigurationState::AwaitingAcknowledgement,
                SidecarRuntimeMessage::Configured { manifest },
            ) => {
                if self.expected_manifest.as_ref() != Some(&manifest) {
                    return self.fail(channel, SidecarConfigurationError::ManifestMismatch);
                }
                self.state = SidecarConfigurationState::Configured;
                Ok(None)
            }
            _ => self.fail(channel, SidecarConfigurationError::UnexpectedMessage),
        }
    }

    /// Seal the runtime's acknowledgement of the exact validated manifest.
    ///
    /// # Errors
    ///
    /// Returns an error for a wrong role/state/channel or mismatched manifest.
    pub fn acknowledge(
        &mut self,
        channel: &mut crate::AuthenticatedSidecarChannel,
        manifest: &SidecarRuntimeManifest,
    ) -> Result<Vec<u8>, SidecarConfigurationError> {
        self.ensure_channel(channel)?;
        if self.role != SidecarPeerRole::Runtime {
            return self.fail(channel, SidecarConfigurationError::RuntimeMustAcknowledge);
        }
        if channel.role() != self.role {
            return self.fail(channel, SidecarConfigurationError::ChannelRoleMismatch);
        }
        if self.state != SidecarConfigurationState::AwaitingAcknowledgement {
            return self.fail(channel, SidecarConfigurationError::UnexpectedMessage);
        }
        if self.expected_manifest.as_ref() != Some(manifest) {
            return self.fail(channel, SidecarConfigurationError::ManifestMismatch);
        }
        let frame = match channel.seal(&SidecarRuntimeMessage::Configured {
            manifest: manifest.clone(),
        }) {
            Ok(frame) => frame,
            Err(error) => return self.fail(channel, SidecarConfigurationError::Frame(error)),
        };
        self.state = SidecarConfigurationState::AcknowledgementPending;
        Ok(frame)
    }

    /// Commit runtime configuration after the acknowledgement frame has been
    /// written successfully.
    ///
    /// # Errors
    ///
    /// Returns an error for the wrong channel, role, state, or a retired
    /// channel. Bound-channel failures retire the exchange and channel; a
    /// replacement channel is retired before processing without mutation.
    pub fn complete_acknowledgement(
        &mut self,
        channel: &mut crate::AuthenticatedSidecarChannel,
    ) -> Result<(), SidecarConfigurationError> {
        self.ensure_channel(channel)?;
        if self.role != SidecarPeerRole::Runtime {
            return self.fail(channel, SidecarConfigurationError::RuntimeMustAcknowledge);
        }
        if channel.is_retired() {
            return self.fail(
                channel,
                SidecarConfigurationError::Frame(crate::SidecarFrameError::ChannelRetired),
            );
        }
        if self.state != SidecarConfigurationState::AcknowledgementPending {
            return self.fail(channel, SidecarConfigurationError::UnexpectedMessage);
        }
        self.state = SidecarConfigurationState::Configured;
        Ok(())
    }

    fn ensure_channel(
        &self,
        channel: &mut crate::AuthenticatedSidecarChannel,
    ) -> Result<(), SidecarConfigurationError> {
        if channel.instance_id() == self.channel_instance_id {
            return Ok(());
        }
        channel.retire();
        Err(SidecarConfigurationError::ChannelInstanceMismatch)
    }

    fn fail<T>(
        &mut self,
        channel: &mut crate::AuthenticatedSidecarChannel,
        error: SidecarConfigurationError,
    ) -> Result<T, SidecarConfigurationError> {
        channel.retire();
        self.configuration = None;
        self.expected_manifest = None;
        self.max_payload_bytes = None;
        self.state = SidecarConfigurationState::Failed;
        Err(error)
    }
}

/// Product adapter invoked only after the Gateway and local runtime bounds
/// have accepted an invocation. Implementations own product policy and native
/// dispatch; they must observe the supplied cancellation token while waiting.
pub trait SidecarCapabilityAdapter: Send + Sync + 'static {
    fn admit(
        &self,
        invocation: SidecarInvocation,
        cancellation: CancellationToken,
    ) -> SidecarAdapterFuture<Result<SidecarAdmissionDecision, SidecarAdapterError>>;

    fn invoke(
        &self,
        invocation: SidecarInvocation,
        cancellation: CancellationToken,
    ) -> SidecarAdapterFuture<Result<SidecarInvocationResult, SidecarAdapterError>>;
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("{code}: {message}")]
pub struct SidecarAdapterError {
    pub code: String,
    pub message: String,
}

impl SidecarAdapterError {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// A validated, immutable connection manifest plus the bounded runtime that
/// enforces it. A capability update creates a new bridge/process generation;
/// this type intentionally has no mutation API for registrations.
pub struct SidecarRuntimeBridge {
    runtime: CommandRuntime,
    manifest: SidecarRuntimeManifest,
    status: SidecarRuntimeStatus,
}

impl SidecarRuntimeBridge {
    /// Build a runtime bridge only from the runtime side of a successfully
    /// authenticated and validated configuration exchange.
    ///
    /// # Errors
    ///
    /// Returns an error unless the exact runtime configuration acknowledgement
    /// has been delivered successfully, or for a command-runtime registration
    /// failure.
    pub fn activate<A: SidecarCapabilityAdapter + ?Sized>(
        exchange: &mut SidecarConfigurationExchange,
        channel: &mut crate::AuthenticatedSidecarChannel,
        adapter: &Arc<A>,
    ) -> Result<Self, SidecarRuntimeBridgeError> {
        if channel.instance_id() != exchange.channel_instance_id {
            channel.retire();
            return Err(SidecarRuntimeBridgeError::ChannelInstanceMismatch);
        }
        if channel.is_retired() {
            exchange.configuration = None;
            exchange.expected_manifest = None;
            exchange.max_payload_bytes = None;
            exchange.state = SidecarConfigurationState::Failed;
            return Err(SidecarRuntimeBridgeError::ChannelRetired);
        }
        if exchange.role != SidecarPeerRole::Runtime {
            return Err(SidecarRuntimeBridgeError::RuntimeRoleRequired);
        }
        let configuration = exchange
            .configuration
            .as_ref()
            .ok_or(SidecarRuntimeBridgeError::ConfigurationNotValidated)?;
        let manifest = manifest_from_configuration(configuration);
        if exchange.state != SidecarConfigurationState::Configured
            || exchange.expected_manifest.as_ref() != Some(&manifest)
        {
            return Err(SidecarRuntimeBridgeError::ConfigurationNotValidated);
        }
        let max_payload_bytes = exchange
            .max_payload_bytes
            .ok_or(SidecarRuntimeBridgeError::ConfigurationNotValidated)?;
        let liveness = channel.liveness();
        let runtime = build_command_runtime(
            configuration,
            &manifest,
            adapter,
            max_payload_bytes,
            &liveness,
        )?;
        let bridge = Self {
            runtime,
            manifest: manifest.clone(),
            status: SidecarRuntimeStatus {
                state: SidecarRuntimeState::Configured,
                manifest_generation: manifest.manifest_generation,
                runtime_version: exchange.runtime_version.clone(),
                attempt: 0,
                reason: None,
            },
        };
        exchange.state = SidecarConfigurationState::Activated;
        Ok(bridge)
    }

    #[must_use]
    pub const fn runtime(&self) -> &CommandRuntime {
        &self.runtime
    }

    #[must_use]
    pub fn into_runtime(self) -> CommandRuntime {
        self.runtime
    }

    #[must_use]
    pub const fn manifest(&self) -> &SidecarRuntimeManifest {
        &self.manifest
    }

    #[must_use]
    pub const fn status(&self) -> &SidecarRuntimeStatus {
        &self.status
    }

    #[must_use]
    pub fn configured_message(&self) -> SidecarRuntimeMessage {
        SidecarRuntimeMessage::Configured {
            manifest: self.manifest.clone(),
        }
    }

    #[must_use]
    pub fn status_message(&self) -> SidecarRuntimeMessage {
        SidecarRuntimeMessage::Status {
            status: self.status.clone(),
        }
    }

    /// Apply one secret-free lifecycle event to the status projected to the
    /// product supervisor.
    pub fn observe_lifecycle(&mut self, event: &LifecycleEvent) {
        let (state, attempt, reason) = match event {
            LifecycleEvent::Connecting { attempt } | LifecycleEvent::Connected { attempt, .. } => {
                (SidecarRuntimeState::Connecting, *attempt, None)
            }
            LifecycleEvent::Ready { attempt } => (SidecarRuntimeState::Ready, *attempt, None),
            LifecycleEvent::Disconnected { attempt, reason } => {
                let state = if *reason == LifecycleDisconnectReason::Shutdown {
                    SidecarRuntimeState::Draining
                } else {
                    SidecarRuntimeState::Connecting
                };
                (state, *attempt, Some(disconnect_reason(*reason)))
            }
            LifecycleEvent::BackingOff {
                attempt, reason, ..
            } => (
                SidecarRuntimeState::BackingOff,
                *attempt,
                Some(disconnect_reason(*reason)),
            ),
            LifecycleEvent::Paused { attempt, reason } => (
                SidecarRuntimeState::Paused,
                *attempt,
                Some(match reason {
                    crate::ReconnectPause::DevicePairing(_) => SidecarRuntimeReason::Pairing,
                    crate::ReconnectPause::Authentication { .. } => {
                        SidecarRuntimeReason::Authentication
                    }
                    crate::ReconnectPause::Protocol { .. } => SidecarRuntimeReason::Protocol,
                    crate::ReconnectPause::Configuration => SidecarRuntimeReason::Configuration,
                    crate::ReconnectPause::LocalIdentity => SidecarRuntimeReason::Identity,
                }),
            ),
            LifecycleEvent::Stopped { attempt, .. } => (
                SidecarRuntimeState::Stopped,
                *attempt,
                Some(SidecarRuntimeReason::Shutdown),
            ),
        };
        let attempt = attempt.min(MAX_PORTABLE_JSON_INTEGER);
        self.status = SidecarRuntimeStatus {
            state,
            manifest_generation: self.manifest.manifest_generation,
            runtime_version: self.status.runtime_version.clone(),
            attempt,
            reason,
        };
    }
}

fn build_command_runtime<A: SidecarCapabilityAdapter + ?Sized>(
    configuration: &SidecarRuntimeConfiguration,
    manifest: &SidecarRuntimeManifest,
    adapter: &Arc<A>,
    max_payload_bytes: usize,
    liveness: &SidecarChannelLiveness,
) -> Result<CommandRuntime, RuntimeBuildError> {
    let mut builder = CommandRuntime::builder()
        .max_concurrency(usize::from(configuration.max_concurrency))
        .max_input_bytes(configuration.max_input_bytes as usize)
        .max_output_bytes(configuration.max_output_bytes as usize)
        .default_timeout(Duration::from_millis(u64::from(
            configuration.default_timeout_ms,
        )))
        .max_timeout(Duration::from_millis(u64::from(
            configuration.max_timeout_ms,
        )))
        .result_grace(Duration::from_millis(u64::from(
            configuration.result_grace_ms,
        )));
    for capability in &manifest.capabilities {
        builder = builder.capability(capability.clone());
    }
    let admission_adapter = Arc::clone(adapter);
    let admission_liveness = liveness.clone();
    builder = builder.admission_policy(move |context| {
        evaluate_sidecar_admission(
            Arc::clone(&admission_adapter),
            context,
            max_payload_bytes,
            admission_liveness.clone(),
        )
    });
    for command in &manifest.commands {
        let command_adapter = Arc::clone(adapter);
        let command_liveness = liveness.clone();
        builder = builder.command(command.clone(), move |context| {
            evaluate_sidecar_invocation(
                Arc::clone(&command_adapter),
                context,
                max_payload_bytes,
                command_liveness.clone(),
            )
        });
    }
    builder.build()
}

async fn evaluate_sidecar_admission<A: SidecarCapabilityAdapter + ?Sized>(
    adapter: Arc<A>,
    context: crate::InvocationAdmissionContext,
    max_payload_bytes: usize,
    liveness: SidecarChannelLiveness,
) -> Result<(), HandlerError> {
    if liveness.is_retired() {
        context.cancellation.cancel();
        return Err(channel_retired());
    }
    if !node_invocation_is_portable(&context.invocation) {
        return Err(nonportable_json());
    }
    let invocation_ref = SidecarInvocationRef::from(&context.invocation);
    if !runtime_message_within_limit(
        &SidecarRuntimeMessageRef::AdmissionRequest {
            invocation: invocation_ref,
        },
        max_payload_bytes,
    ) {
        return Err(message_too_large());
    }
    let cancellation = context.cancellation;
    let adapter_future = adapter.admit(
        SidecarInvocation::from(&context.invocation),
        cancellation.clone(),
    );
    tokio::pin!(adapter_future);
    let decision = tokio::select! {
        biased;
        () = liveness.retired() => {
            cancellation.cancel();
            return Err(channel_retired());
        },
        result = &mut adapter_future => match result {
            Ok(decision) => decision,
            Err(error) => {
                let error = adapter_failure(&error);
                SidecarAdmissionDecision::Deny {
                    code: error.code,
                    message: error.message,
                }
            }
        },
    };
    if !runtime_message_within_limit(
        &SidecarRuntimeMessageRef::AdmissionDecision {
            invocation_id: &context.invocation.id,
            decision: &decision,
        },
        max_payload_bytes,
    ) {
        return Err(message_too_large());
    }
    match decision {
        SidecarAdmissionDecision::Allow => Ok(()),
        SidecarAdmissionDecision::Deny { code, message } => Err(HandlerError::new(code, message)),
    }
}

async fn evaluate_sidecar_invocation<A: SidecarCapabilityAdapter + ?Sized>(
    adapter: Arc<A>,
    context: InvocationContext,
    max_payload_bytes: usize,
    liveness: SidecarChannelLiveness,
) -> Result<Value, HandlerError> {
    if liveness.is_retired() {
        context.cancellation.cancel();
        return Err(channel_retired());
    }
    if !node_invocation_is_portable(&context.invocation) {
        return Err(nonportable_json());
    }
    let invocation_ref = SidecarInvocationRef::from(&context.invocation);
    if !runtime_message_within_limit(
        &SidecarRuntimeMessageRef::Invoke {
            invocation: invocation_ref,
        },
        max_payload_bytes,
    ) {
        return Err(message_too_large());
    }
    let cancellation = context.cancellation;
    let adapter_future = adapter.invoke(
        SidecarInvocation::from(&context.invocation),
        cancellation.clone(),
    );
    tokio::pin!(adapter_future);
    let result = tokio::select! {
        biased;
        () = liveness.retired() => {
            cancellation.cancel();
            return Err(channel_retired());
        },
        result = &mut adapter_future => match result {
            Ok(result) => result,
            Err(error) => {
                let error = adapter_failure(&error);
                SidecarInvocationResult::Failure {
                    code: error.code,
                    message: error.message,
                }
            }
        },
    };
    if !invocation_result_is_portable(&result) {
        return Err(nonportable_json());
    }
    if !runtime_message_within_limit(
        &SidecarRuntimeMessageRef::Result {
            invocation_id: &context.invocation.id,
            result: &result,
        },
        max_payload_bytes,
    ) {
        return Err(message_too_large());
    }
    result.into()
}

fn validate_configuration(
    configuration: &SidecarRuntimeConfiguration,
    negotiated: SidecarProtocolSelection,
) -> Result<(), SidecarRuntimeBridgeError> {
    if configuration.manifest_generation == 0
        || configuration.manifest_generation > MAX_PORTABLE_JSON_INTEGER
    {
        return Err(SidecarRuntimeBridgeError::InvalidManifestGeneration);
    }
    if configuration.max_concurrency == 0
        || configuration.max_concurrency > negotiated.limits.max_in_flight
    {
        return Err(SidecarRuntimeBridgeError::InvalidLimit("maxConcurrency"));
    }
    if configuration.max_input_bytes == 0
        || configuration.max_input_bytes > negotiated.limits.max_frame_bytes
    {
        return Err(SidecarRuntimeBridgeError::InvalidLimit("maxInputBytes"));
    }
    if configuration.max_output_bytes == 0
        || (configuration.max_output_bytes as usize) < minimum_bridge_failure_bytes()
        || configuration.max_output_bytes > negotiated.limits.max_frame_bytes
    {
        return Err(SidecarRuntimeBridgeError::InvalidLimit("maxOutputBytes"));
    }
    if configuration.default_timeout_ms == 0
        || configuration.max_timeout_ms == 0
        || configuration.default_timeout_ms > configuration.max_timeout_ms
        || configuration.result_grace_ms >= configuration.default_timeout_ms
    {
        return Err(SidecarRuntimeBridgeError::InvalidLimit("timeouts"));
    }
    validate_names(&configuration.capabilities, false)?;
    validate_names(
        &configuration
            .commands
            .iter()
            .map(|command| command.name.clone())
            .collect::<Vec<_>>(),
        true,
    )
}

fn validate_status_budget(
    runtime_version: &str,
    manifest_generation: u64,
    max_payload_bytes: usize,
) -> Result<(), SidecarRuntimeBridgeError> {
    let worst_case = SidecarRuntimeMessage::Status {
        status: SidecarRuntimeStatus {
            state: SidecarRuntimeState::BackingOff,
            manifest_generation,
            runtime_version: runtime_version.to_owned(),
            attempt: MAX_PORTABLE_JSON_INTEGER,
            reason: Some(SidecarRuntimeReason::DeliverySaturated),
        },
    };
    if runtime_message_within_limit(&worst_case, max_payload_bytes) {
        Ok(())
    } else {
        Err(SidecarRuntimeBridgeError::StatusMessageTooLarge)
    }
}

fn manifest_from_configuration(
    configuration: &SidecarRuntimeConfiguration,
) -> SidecarRuntimeManifest {
    SidecarRuntimeManifest {
        manifest_generation: configuration.manifest_generation,
        capabilities: sorted(configuration.capabilities.clone()),
        commands: sorted(
            configuration
                .commands
                .iter()
                .map(|command| command.name.clone())
                .collect(),
        ),
    }
}

fn validate_names(names: &[String], commands: bool) -> Result<(), SidecarRuntimeBridgeError> {
    let mut unique = BTreeSet::new();
    for name in names {
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(SidecarRuntimeBridgeError::InvalidName(name.clone()));
        }
        if commands && (name == "system" || name.starts_with("system.")) {
            return Err(SidecarRuntimeBridgeError::ReservedCommand(name.clone()));
        }
        if !unique.insert(name) {
            return Err(SidecarRuntimeBridgeError::DuplicateName(name.clone()));
        }
    }
    Ok(())
}

fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values
}

fn adapter_failure(error: &SidecarAdapterError) -> HandlerError {
    let code = if error.code.trim().is_empty() {
        "SIDECAR_ADAPTER"
    } else {
        error.code.as_str()
    };
    let message = if error.message.trim().is_empty() {
        "sidecar capability adapter failed"
    } else {
        error.message.as_str()
    };
    HandlerError::new(code, message)
}

fn message_too_large() -> HandlerError {
    HandlerError::new(
        "SIDECAR_MESSAGE_TOO_LARGE",
        "complete sidecar message exceeds the authenticated payload limit",
    )
}

fn nonportable_json() -> HandlerError {
    HandlerError::new(
        "SIDECAR_NON_PORTABLE_JSON",
        "sidecar message contains an integer outside the exact JSON range",
    )
}

fn node_invocation_is_portable(invocation: &NodeInvocation) -> bool {
    invocation
        .timeout_ms
        .is_none_or(|value| value <= MAX_PORTABLE_JSON_INTEGER)
        && portable_json_value(&invocation.params)
}

fn invocation_result_is_portable(result: &SidecarInvocationResult) -> bool {
    match result {
        SidecarInvocationResult::Success { payload } => portable_json_value(payload),
        SidecarInvocationResult::Failure { .. } => true,
    }
}

fn channel_retired() -> HandlerError {
    HandlerError::new(
        "SIDECAR_CHANNEL_RETIRED",
        "authenticated sidecar channel is no longer live",
    )
}

fn minimum_bridge_failure_bytes() -> usize {
    [message_too_large(), nonportable_json(), channel_retired()]
        .iter()
        .map(|error| {
            serde_json::json!({"code": &error.code, "message": &error.message})
                .to_string()
                .len()
        })
        .max()
        .unwrap_or(1)
}

fn runtime_message_within_limit<T: Serialize>(message: &T, limit: usize) -> bool {
    let mut writer = PayloadSizeLimiter { written: 0, limit };
    serde_json::to_writer(&mut writer, message).is_ok()
}

struct PayloadSizeLimiter {
    written: usize,
    limit: usize,
}

impl Write for PayloadSizeLimiter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = self.limit.saturating_sub(self.written);
        if bytes.len() > remaining {
            return Err(io::Error::other("sidecar payload limit exceeded"));
        }
        self.written += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

const fn disconnect_reason(reason: LifecycleDisconnectReason) -> SidecarRuntimeReason {
    match reason {
        LifecycleDisconnectReason::Client(class) => match class {
            ClientErrorClass::Configuration => SidecarRuntimeReason::Configuration,
            ClientErrorClass::Transport => SidecarRuntimeReason::Transport,
            ClientErrorClass::Protocol => SidecarRuntimeReason::Protocol,
            ClientErrorClass::Identity => SidecarRuntimeReason::Identity,
            ClientErrorClass::Gateway => SidecarRuntimeReason::Gateway,
            ClientErrorClass::RequestTimeout => SidecarRuntimeReason::RequestTimeout,
            ClientErrorClass::EventLagged => SidecarRuntimeReason::EventLagged,
            ClientErrorClass::Activation => SidecarRuntimeReason::Activation,
        },
        LifecycleDisconnectReason::Runtime(class) => match class {
            RuntimeErrorClass::DeliverySaturated => SidecarRuntimeReason::DeliverySaturated,
            RuntimeErrorClass::ResultTask => SidecarRuntimeReason::ResultTask,
        },
        LifecycleDisconnectReason::RuntimeEnded => SidecarRuntimeReason::RuntimeEnded,
        LifecycleDisconnectReason::Shutdown => SidecarRuntimeReason::Shutdown,
    }
}

#[derive(Debug, Error)]
pub enum SidecarRuntimeBridgeError {
    #[error("sidecar runtime configuration has not been authenticated and validated")]
    ConfigurationNotValidated,
    #[error("sidecar runtime bridge cannot move between authenticated channel instances")]
    ChannelInstanceMismatch,
    #[error("sidecar runtime bridge requires a live authenticated channel")]
    ChannelRetired,
    #[error("sidecar runtime status cannot fit the authenticated payload limit")]
    StatusMessageTooLarge,
    #[error("sidecar runtime bridge requires the runtime handshake role")]
    RuntimeRoleRequired,
    #[error("sidecar manifest generation must be nonzero")]
    InvalidManifestGeneration,
    #[error("invalid sidecar runtime limit: {0}")]
    InvalidLimit(&'static str),
    #[error("invalid sidecar runtime name: {0}")]
    InvalidName(String),
    #[error("duplicate sidecar runtime name: {0}")]
    DuplicateName(String),
    #[error("OpenClaw-owned system command namespace is reserved: {0}")]
    ReservedCommand(String),
    #[error(transparent)]
    Runtime(#[from] RuntimeBuildError),
}

#[derive(Debug, Error)]
pub enum SidecarConfigurationError {
    #[error("sidecar handshake must be authenticated before configuration")]
    HandshakeNotAuthenticated,
    #[error("sidecar configuration frame failed")]
    Frame(#[source] crate::SidecarFrameError),
    #[error("sidecar runtime configuration is invalid")]
    Configuration(#[source] SidecarRuntimeBridgeError),
    #[error("supervisor must initiate sidecar configuration")]
    SupervisorMustInitiate,
    #[error("runtime must acknowledge sidecar configuration")]
    RuntimeMustAcknowledge,
    #[error("sidecar configuration role does not match authenticated channel role")]
    ChannelRoleMismatch,
    #[error("sidecar configuration cannot move between authenticated channel instances")]
    ChannelInstanceMismatch,
    #[error("sidecar configured manifest does not match the validated configuration")]
    ManifestMismatch,
    #[error("unexpected sidecar configuration message")]
    UnexpectedMessage,
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    use serde_json::json;
    use tokio::sync::Notify;

    use super::*;
    use crate::{
        AuthenticatedSidecarChannel, SidecarLimits, SidecarPeerIdentity, SidecarProtocolOffer,
        SidecarSessionKey,
    };

    const KEY: [u8; 32] = [0x55; 32];

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RuntimeFixture {
        schema_version: u8,
        messages: Vec<SidecarRuntimeMessage>,
        canonical_json: Vec<String>,
    }

    fn offer(role: SidecarPeerRole) -> SidecarProtocolOffer {
        SidecarProtocolOffer {
            protocol_major: crate::SIDECAR_PROTOCOL_MAJOR,
            protocol_minor: crate::SIDECAR_PROTOCOL_MINOR,
            peer: SidecarPeerIdentity {
                role,
                name: match role {
                    SidecarPeerRole::Supervisor => "test-supervisor",
                    SidecarPeerRole::Runtime => "openclaw-node",
                }
                .into(),
                version: "1.0.0".into(),
                artifact_identity: "sha256:test-only".into(),
            },
            feature_bits: crate::SIDECAR_MAX_FEATURE_BITS,
            limits: SidecarLimits {
                max_frame_bytes: 4096,
                max_in_flight: 4,
                bootstrap_timeout_ms: 1_000,
            },
        }
    }

    fn channel(role: SidecarPeerRole) -> AuthenticatedSidecarChannel {
        AuthenticatedSidecarChannel::new(
            role,
            "runtime-session".into(),
            11,
            SidecarSessionKey::from_bytes(KEY),
            4096,
        )
        .unwrap()
    }

    fn authenticated_pair() -> (
        SidecarHandshake,
        SidecarHandshake,
        AuthenticatedSidecarChannel,
        AuthenticatedSidecarChannel,
    ) {
        let mut supervisor = SidecarHandshake::new(offer(SidecarPeerRole::Supervisor)).unwrap();
        let mut runtime = SidecarHandshake::new(offer(SidecarPeerRole::Runtime)).unwrap();
        let mut supervisor_channel = channel(SidecarPeerRole::Supervisor);
        let mut runtime_channel = channel(SidecarPeerRole::Runtime);
        let offer_frame = supervisor.start(&mut supervisor_channel).unwrap();
        let accept_frame = runtime
            .receive(&mut runtime_channel, &offer_frame)
            .unwrap()
            .unwrap();
        runtime.complete_acceptance(&mut runtime_channel).unwrap();
        supervisor
            .receive(&mut supervisor_channel, &accept_frame)
            .unwrap();
        (supervisor, runtime, supervisor_channel, runtime_channel)
    }

    fn validated_runtime_exchange(
        configuration: &SidecarRuntimeConfiguration,
    ) -> (
        SidecarConfigurationExchange,
        AuthenticatedSidecarChannel,
        SidecarRuntimeConfiguration,
    ) {
        let (supervisor, runtime, mut supervisor_channel, mut runtime_channel) =
            authenticated_pair();
        let mut supervisor_exchange = SidecarConfigurationExchange::new(supervisor).unwrap();
        let mut runtime_exchange = SidecarConfigurationExchange::new(runtime).unwrap();
        let frame = supervisor_exchange
            .start(&mut supervisor_channel, configuration)
            .unwrap();
        let received = runtime_exchange
            .receive(&mut runtime_channel, &frame)
            .unwrap()
            .unwrap();
        let manifest = runtime_exchange.validated_manifest().unwrap().clone();
        let acknowledgement = runtime_exchange
            .acknowledge(&mut runtime_channel, &manifest)
            .unwrap();
        runtime_exchange
            .complete_acknowledgement(&mut runtime_channel)
            .unwrap();
        supervisor_exchange
            .receive(&mut supervisor_channel, &acknowledgement)
            .unwrap();
        (runtime_exchange, runtime_channel, received)
    }

    fn configuration() -> SidecarRuntimeConfiguration {
        SidecarRuntimeConfiguration {
            manifest_generation: 3,
            capabilities: vec!["native.settings".into(), "native.status".into()],
            commands: vec![
                SidecarCommandRegistration {
                    name: "product.status".into(),
                },
                SidecarCommandRegistration {
                    name: "product.settings".into(),
                },
            ],
            max_concurrency: 2,
            max_input_bytes: 1024,
            max_output_bytes: 1024,
            default_timeout_ms: 1_000,
            max_timeout_ms: 5_000,
            result_grace_ms: 50,
        }
    }

    #[derive(Default)]
    struct RecordingAdapter {
        admissions: AtomicUsize,
        invocations: AtomicUsize,
        denied_command: Mutex<Option<String>>,
    }

    impl SidecarCapabilityAdapter for RecordingAdapter {
        fn admit(
            &self,
            invocation: SidecarInvocation,
            _cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarAdmissionDecision, SidecarAdapterError>> {
            self.admissions.fetch_add(1, Ordering::SeqCst);
            let denied = self
                .denied_command
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_deref()
                == Some(invocation.command.as_str());
            Box::pin(async move {
                Ok(if denied {
                    SidecarAdmissionDecision::Deny {
                        code: "LOCAL_DENY".into(),
                        message: "denied by product policy".into(),
                    }
                } else {
                    SidecarAdmissionDecision::Allow
                })
            })
        }

        fn invoke(
            &self,
            invocation: SidecarInvocation,
            _cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarInvocationResult, SidecarAdapterError>> {
            self.invocations.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(SidecarInvocationResult::Success {
                    payload: json!({"command": invocation.command, "params": invocation.params}),
                })
            })
        }
    }

    #[tokio::test]
    async fn bridge_routes_admission_then_native_invocation() {
        let (mut exchange, mut channel, _configuration) =
            validated_runtime_exchange(&configuration());
        let adapter = Arc::new(RecordingAdapter::default());
        let bridge = SidecarRuntimeBridge::activate(&mut exchange, &mut channel, &adapter).unwrap();

        assert_eq!(
            bridge.runtime().command_names().collect::<Vec<_>>(),
            vec!["product.settings", "product.status"]
        );
        assert_eq!(
            bridge.runtime().capability_names().collect::<Vec<_>>(),
            vec!["native.settings", "native.status"]
        );
        let result = bridge
            .runtime()
            .evaluate(NodeInvocation::new(
                "invoke-1",
                "node-1",
                "product.status",
                json!({"verbose": true}),
            ))
            .await;
        assert_eq!(
            result,
            InvocationResult::success(json!({
                "command": "product.status",
                "params": {"verbose": true}
            }))
        );
        assert_eq!(adapter.admissions.load(Ordering::SeqCst), 1);
        assert_eq!(adapter.invocations.load(Ordering::SeqCst), 1);
        assert_eq!(
            bridge.configured_message(),
            SidecarRuntimeMessage::Configured {
                manifest: bridge.manifest().clone()
            }
        );
    }

    #[tokio::test]
    async fn admission_denial_never_dispatches_native_work() {
        let (mut exchange, mut channel, _configuration) =
            validated_runtime_exchange(&configuration());
        let adapter = Arc::new(RecordingAdapter::default());
        *adapter
            .denied_command
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some("product.settings".into());
        let bridge = SidecarRuntimeBridge::activate(&mut exchange, &mut channel, &adapter).unwrap();

        assert_eq!(
            bridge
                .runtime()
                .evaluate(NodeInvocation::new(
                    "invoke-2",
                    "node-1",
                    "product.settings",
                    Value::Null,
                ))
                .await,
            InvocationResult::failure("LOCAL_DENY", "denied by product policy")
        );
        assert_eq!(adapter.admissions.load(Ordering::SeqCst), 1);
        assert_eq!(adapter.invocations.load(Ordering::SeqCst), 0);
    }

    struct OversizedResultAdapter;

    impl SidecarCapabilityAdapter for OversizedResultAdapter {
        fn admit(
            &self,
            _invocation: SidecarInvocation,
            _cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarAdmissionDecision, SidecarAdapterError>> {
            Box::pin(async { Ok(SidecarAdmissionDecision::Allow) })
        }

        fn invoke(
            &self,
            _invocation: SidecarInvocation,
            _cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarInvocationResult, SidecarAdapterError>> {
            Box::pin(async {
                Ok(SidecarInvocationResult::Success {
                    payload: json!({"data": "x".repeat(3_950)}),
                })
            })
        }
    }

    struct OversizedAdapterError {
        fail_admission: bool,
    }

    impl SidecarCapabilityAdapter for OversizedAdapterError {
        fn admit(
            &self,
            _invocation: SidecarInvocation,
            _cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarAdmissionDecision, SidecarAdapterError>> {
            let fail_admission = self.fail_admission;
            Box::pin(async move {
                if fail_admission {
                    Err(SidecarAdapterError::new(
                        "C".repeat(2_000),
                        "M".repeat(2_000),
                    ))
                } else {
                    Ok(SidecarAdmissionDecision::Allow)
                }
            })
        }

        fn invoke(
            &self,
            _invocation: SidecarInvocation,
            _cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarInvocationResult, SidecarAdapterError>> {
            Box::pin(async {
                Err(SidecarAdapterError::new(
                    "C".repeat(2_000),
                    "M".repeat(2_000),
                ))
            })
        }
    }

    #[tokio::test]
    async fn adapter_errors_obey_complete_sidecar_message_budget() {
        let handler_payload = json!({
            "code": "C".repeat(2_000),
            "message": "M".repeat(2_000),
        });
        assert!(serde_json::to_vec(&handler_payload).unwrap().len() <= 4_096);

        for fail_admission in [true, false] {
            let mut bounded = configuration();
            bounded.max_output_bytes = 4_096;
            let (mut exchange, mut channel, _configuration) = validated_runtime_exchange(&bounded);
            let adapter = Arc::new(OversizedAdapterError { fail_admission });
            let bridge =
                SidecarRuntimeBridge::activate(&mut exchange, &mut channel, &adapter).unwrap();

            assert_eq!(
                bridge
                    .runtime()
                    .evaluate(NodeInvocation::new(
                        "invoke-adapter-error",
                        "node-1",
                        "product.status",
                        Value::Null,
                    ))
                    .await,
                InvocationResult::failure(
                    "SIDECAR_MESSAGE_TOO_LARGE",
                    "complete sidecar message exceeds the authenticated payload limit"
                )
            );
        }
    }

    struct NonPortableResultAdapter;

    impl SidecarCapabilityAdapter for NonPortableResultAdapter {
        fn admit(
            &self,
            _invocation: SidecarInvocation,
            _cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarAdmissionDecision, SidecarAdapterError>> {
            Box::pin(async { Ok(SidecarAdmissionDecision::Allow) })
        }

        fn invoke(
            &self,
            _invocation: SidecarInvocation,
            _cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarInvocationResult, SidecarAdapterError>> {
            Box::pin(async {
                Ok(SidecarInvocationResult::Success {
                    payload: json!({"unsafe": MAX_PORTABLE_JSON_INTEGER + 1}),
                })
            })
        }
    }

    #[tokio::test]
    async fn nonportable_json_has_a_distinct_runtime_failure() {
        let mut failure_bounded = configuration();
        failure_bounded.max_output_bytes = u32::try_from(minimum_bridge_failure_bytes()).unwrap();
        let (mut exchange, mut channel, _configuration) =
            validated_runtime_exchange(&failure_bounded);
        let adapter = Arc::new(RecordingAdapter::default());
        let bridge = SidecarRuntimeBridge::activate(&mut exchange, &mut channel, &adapter).unwrap();
        assert_eq!(
            bridge
                .runtime()
                .evaluate(NodeInvocation::new(
                    "invoke-unsafe-input",
                    "node-1",
                    "product.status",
                    json!({"unsafe": MAX_PORTABLE_JSON_INTEGER + 1}),
                ))
                .await,
            InvocationResult::failure(
                "SIDECAR_NON_PORTABLE_JSON",
                "sidecar message contains an integer outside the exact JSON range"
            )
        );
        assert_eq!(adapter.admissions.load(Ordering::SeqCst), 0);

        let (mut result_exchange, mut result_channel, _configuration) =
            validated_runtime_exchange(&failure_bounded);
        let result_adapter = Arc::new(NonPortableResultAdapter);
        let result_bridge = SidecarRuntimeBridge::activate(
            &mut result_exchange,
            &mut result_channel,
            &result_adapter,
        )
        .unwrap();
        assert_eq!(
            result_bridge
                .runtime()
                .evaluate(NodeInvocation::new(
                    "invoke-unsafe-result",
                    "node-1",
                    "product.status",
                    Value::Null,
                ))
                .await,
            InvocationResult::failure(
                "SIDECAR_NON_PORTABLE_JSON",
                "sidecar message contains an integer outside the exact JSON range"
            )
        );
    }

    #[tokio::test]
    async fn complete_message_budget_rejects_boundary_values_before_transport() {
        let mut bounded = configuration();
        bounded.max_input_bytes = 4096;
        bounded.max_output_bytes = 4096;
        let (mut exchange, mut runtime_channel, _received) = validated_runtime_exchange(&bounded);
        let adapter = Arc::new(RecordingAdapter::default());
        let bridge =
            SidecarRuntimeBridge::activate(&mut exchange, &mut runtime_channel, &adapter).unwrap();
        let invocation = NodeInvocation::new(
            "invoke-boundary",
            "node-1",
            "product.status",
            json!({"data": "x".repeat(3_900)}),
        );
        let sidecar_invocation = SidecarInvocation::from(&invocation);
        assert!(matches!(
            runtime_channel.seal(&SidecarRuntimeMessage::AdmissionRequest {
                invocation: sidecar_invocation,
            }),
            Err(crate::SidecarFrameError::FrameTooLarge { .. })
        ));
        assert_eq!(
            bridge.runtime().evaluate(invocation).await,
            InvocationResult::failure(
                "SIDECAR_MESSAGE_TOO_LARGE",
                "complete sidecar message exceeds the authenticated payload limit",
            )
        );
        assert_eq!(adapter.admissions.load(Ordering::SeqCst), 0);
        assert_eq!(adapter.invocations.load(Ordering::SeqCst), 0);

        let (mut result_exchange, mut result_channel, _received) =
            validated_runtime_exchange(&bounded);
        let result_adapter = Arc::new(OversizedResultAdapter);
        let result_bridge = SidecarRuntimeBridge::activate(
            &mut result_exchange,
            &mut result_channel,
            &result_adapter,
        )
        .unwrap();
        assert_eq!(
            result_bridge
                .runtime()
                .evaluate(NodeInvocation::new(
                    "invoke-result",
                    "node-1",
                    "product.status",
                    Value::Null,
                ))
                .await,
            InvocationResult::failure(
                "SIDECAR_MESSAGE_TOO_LARGE",
                "complete sidecar message exceeds the authenticated payload limit",
            )
        );
    }

    struct CancellationAdapter {
        invoked: Arc<Notify>,
        cancelled: Arc<Notify>,
    }

    impl SidecarCapabilityAdapter for CancellationAdapter {
        fn admit(
            &self,
            _invocation: SidecarInvocation,
            _cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarAdmissionDecision, SidecarAdapterError>> {
            Box::pin(async { Ok(SidecarAdmissionDecision::Allow) })
        }

        fn invoke(
            &self,
            _invocation: SidecarInvocation,
            cancellation: CancellationToken,
        ) -> SidecarAdapterFuture<Result<SidecarInvocationResult, SidecarAdapterError>> {
            let invoked = Arc::clone(&self.invoked);
            let cancelled = Arc::clone(&self.cancelled);
            Box::pin(async move {
                invoked.notify_one();
                tokio::spawn(async move {
                    cancellation.cancelled().await;
                    cancelled.notify_one();
                })
                .await
                .unwrap();
                std::future::pending().await
            })
        }
    }

    #[tokio::test]
    async fn runtime_timeout_reaches_the_product_adapter() {
        let (mut exchange, mut channel, _configuration) =
            validated_runtime_exchange(&configuration());
        let invoked = Arc::new(Notify::new());
        let cancelled = Arc::new(Notify::new());
        let adapter = Arc::new(CancellationAdapter {
            invoked: Arc::clone(&invoked),
            cancelled: Arc::clone(&cancelled),
        });
        let bridge = SidecarRuntimeBridge::activate(&mut exchange, &mut channel, &adapter).unwrap();
        let mut invocation =
            NodeInvocation::new("invoke-3", "node-1", "product.status", Value::Null);
        invocation.timeout_ms = Some(100);
        let result = bridge.runtime().evaluate(invocation).await;
        assert_eq!(
            result,
            InvocationResult::failure("HANDLER_TIMEOUT", "command handler exceeded its deadline")
        );
        tokio::time::timeout(Duration::from_secs(1), cancelled.notified())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn retired_or_dropped_channel_cancels_and_blocks_native_work() {
        for drop_channel in [false, true] {
            let (mut exchange, mut channel, _configuration) =
                validated_runtime_exchange(&configuration());
            let invoked = Arc::new(Notify::new());
            let cancelled = Arc::new(Notify::new());
            let adapter = Arc::new(CancellationAdapter {
                invoked: Arc::clone(&invoked),
                cancelled: Arc::clone(&cancelled),
            });
            let bridge = Arc::new(
                SidecarRuntimeBridge::activate(&mut exchange, &mut channel, &adapter).unwrap(),
            );
            let evaluation_bridge = Arc::clone(&bridge);
            let evaluation = tokio::spawn(async move {
                evaluation_bridge
                    .runtime()
                    .evaluate(NodeInvocation::new(
                        "invoke-retired",
                        "node-1",
                        "product.status",
                        Value::Null,
                    ))
                    .await
            });
            invoked.notified().await;
            if drop_channel {
                drop(channel);
            } else {
                channel.retire();
            }

            assert_eq!(
                evaluation.await.unwrap(),
                InvocationResult::failure(
                    "SIDECAR_CHANNEL_RETIRED",
                    "authenticated sidecar channel is no longer live"
                )
            );
            tokio::time::timeout(Duration::from_secs(1), cancelled.notified())
                .await
                .unwrap();
            assert_eq!(
                bridge
                    .runtime()
                    .evaluate(NodeInvocation::new(
                        "invoke-after-retire",
                        "node-1",
                        "product.status",
                        Value::Null,
                    ))
                    .await,
                InvocationResult::failure(
                    "SIDECAR_CHANNEL_RETIRED",
                    "authenticated sidecar channel is no longer live"
                )
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(20), invoked.notified())
                    .await
                    .is_err()
            );
        }
    }

    #[test]
    fn configuration_requires_authenticated_runtime_and_bounded_manifest() {
        let adapter = Arc::new(RecordingAdapter::default());
        let starting = SidecarHandshake::new(offer(SidecarPeerRole::Runtime)).unwrap();
        assert!(matches!(
            SidecarConfigurationExchange::new(starting),
            Err(SidecarConfigurationError::HandshakeNotAuthenticated)
        ));

        let (_supervisor, handshake, _supervisor_channel, mut runtime_channel) =
            authenticated_pair();
        let selection = SidecarProtocolSelection::from(handshake.negotiated().unwrap());
        let mut exchange = SidecarConfigurationExchange::new(handshake).unwrap();
        assert!(matches!(
            SidecarRuntimeBridge::activate(&mut exchange, &mut runtime_channel, &adapter),
            Err(SidecarRuntimeBridgeError::ConfigurationNotValidated)
        ));
        let mut invalid = configuration();
        invalid.manifest_generation = 0;
        assert!(matches!(
            validate_configuration(&invalid, selection),
            Err(SidecarRuntimeBridgeError::InvalidManifestGeneration)
        ));
        let mut invalid = configuration();
        invalid.max_concurrency = 5;
        assert!(matches!(
            validate_configuration(&invalid, selection),
            Err(SidecarRuntimeBridgeError::InvalidLimit("maxConcurrency"))
        ));
        let mut invalid = configuration();
        invalid.max_output_bytes = u32::try_from(minimum_bridge_failure_bytes() - 1).unwrap();
        assert!(matches!(
            validate_configuration(&invalid, selection),
            Err(SidecarRuntimeBridgeError::InvalidLimit("maxOutputBytes"))
        ));
        let mut invalid = configuration();
        invalid.commands.push(SidecarCommandRegistration {
            name: "product.status".into(),
        });
        assert!(matches!(
            validate_configuration(&invalid, selection),
            Err(SidecarRuntimeBridgeError::DuplicateName(_))
        ));
        let mut invalid = configuration();
        invalid.commands[0].name = "system.run".into();
        assert!(matches!(
            validate_configuration(&invalid, selection),
            Err(SidecarRuntimeBridgeError::ReservedCommand(_))
        ));
        let mut invalid = configuration();
        invalid.commands[0].name = "product.\u{1f980}".into();
        assert!(matches!(
            validate_configuration(&invalid, selection),
            Err(SidecarRuntimeBridgeError::InvalidName(_))
        ));
    }

    #[test]
    fn configuration_exchange_preserves_channel_and_manifest_state() {
        let (supervisor, runtime, mut supervisor_channel, mut runtime_channel) =
            authenticated_pair();
        let mut supervisor_exchange = SidecarConfigurationExchange::new(supervisor).unwrap();
        let mut runtime_exchange = SidecarConfigurationExchange::new(runtime).unwrap();
        let configuration = configuration();

        let frame = supervisor_exchange
            .start(&mut supervisor_channel, &configuration)
            .unwrap();
        let received = runtime_exchange
            .receive(&mut runtime_channel, &frame)
            .unwrap()
            .unwrap();
        assert_eq!(received, configuration);

        let manifest = runtime_exchange.validated_manifest().unwrap().clone();
        let acknowledgement = runtime_exchange
            .acknowledge(&mut runtime_channel, &manifest)
            .unwrap();
        assert_eq!(
            runtime_exchange.state(),
            SidecarConfigurationState::AcknowledgementPending
        );
        assert!(matches!(
            SidecarRuntimeBridge::activate(
                &mut runtime_exchange,
                &mut runtime_channel,
                &Arc::new(RecordingAdapter::default())
            ),
            Err(SidecarRuntimeBridgeError::ConfigurationNotValidated)
        ));
        runtime_exchange
            .complete_acknowledgement(&mut runtime_channel)
            .unwrap();
        assert!(supervisor_exchange
            .receive(&mut supervisor_channel, &acknowledgement)
            .unwrap()
            .is_none());
        let adapter = Arc::new(RecordingAdapter::default());
        let bridge =
            SidecarRuntimeBridge::activate(&mut runtime_exchange, &mut runtime_channel, &adapter)
                .unwrap();
        assert_eq!(bridge.manifest(), &manifest);
        assert_eq!(
            supervisor_exchange.state(),
            SidecarConfigurationState::Configured
        );
        assert_eq!(
            runtime_exchange.state(),
            SidecarConfigurationState::Activated
        );
        assert!(!supervisor_channel.is_retired());
        assert!(!runtime_channel.is_retired());
    }

    #[test]
    fn configuration_exchange_rejects_channel_substitution_without_mutation() {
        let (supervisor, _runtime, mut supervisor_channel, _runtime_channel) = authenticated_pair();
        let mut exchange = SidecarConfigurationExchange::new(supervisor).unwrap();
        let mut replacement = channel(SidecarPeerRole::Supervisor);

        assert!(matches!(
            exchange.start(&mut replacement, &configuration()),
            Err(SidecarConfigurationError::ChannelInstanceMismatch)
        ));
        assert!(replacement.is_retired());
        assert_eq!(exchange.state(), SidecarConfigurationState::Starting);
        assert!(!supervisor_channel.is_retired());

        assert!(exchange
            .start(&mut supervisor_channel, &configuration())
            .is_ok());
        assert_eq!(
            exchange.state(),
            SidecarConfigurationState::AwaitingAcknowledgement
        );
    }

    #[test]
    fn failed_configuration_acknowledgement_delivery_is_terminal() {
        let (supervisor, runtime, mut supervisor_channel, mut runtime_channel) =
            authenticated_pair();
        let mut supervisor_exchange = SidecarConfigurationExchange::new(supervisor).unwrap();
        let mut runtime_exchange = SidecarConfigurationExchange::new(runtime).unwrap();
        let frame = supervisor_exchange
            .start(&mut supervisor_channel, &configuration())
            .unwrap();
        runtime_exchange
            .receive(&mut runtime_channel, &frame)
            .unwrap();
        let manifest = runtime_exchange.validated_manifest().unwrap().clone();
        runtime_exchange
            .acknowledge(&mut runtime_channel, &manifest)
            .unwrap();

        runtime_channel.retire();
        assert!(matches!(
            runtime_exchange.complete_acknowledgement(&mut runtime_channel),
            Err(SidecarConfigurationError::Frame(
                crate::SidecarFrameError::ChannelRetired
            ))
        ));
        assert_eq!(runtime_exchange.state(), SidecarConfigurationState::Failed);
        assert!(runtime_exchange.validated_manifest().is_none());
    }

    #[test]
    fn bridge_uses_the_exact_authenticated_configuration() {
        let (mut exchange, mut channel, mut caller_copy) =
            validated_runtime_exchange(&configuration());
        caller_copy.max_concurrency = u16::MAX;
        caller_copy.max_input_bytes = u32::MAX;
        assert_eq!(exchange.configuration.as_ref().unwrap().max_concurrency, 2);
        assert_eq!(
            exchange.configuration.as_ref().unwrap().max_input_bytes,
            1024
        );

        let adapter = Arc::new(RecordingAdapter::default());
        let frame_limit = channel.max_frame_bytes();
        assert_eq!(
            channel.lower_frame_limit(frame_limit - 1),
            Err(crate::SidecarProtocolError::FrameLimitLocked)
        );
        let bridge = SidecarRuntimeBridge::activate(&mut exchange, &mut channel, &adapter).unwrap();
        assert_eq!(
            channel.lower_frame_limit(frame_limit - 1),
            Err(crate::SidecarProtocolError::FrameLimitLocked)
        );
        assert_eq!(bridge.manifest().manifest_generation, 3);
        assert!(matches!(
            SidecarRuntimeBridge::activate(&mut exchange, &mut channel, &adapter),
            Err(SidecarRuntimeBridgeError::ConfigurationNotValidated)
        ));
    }

    #[test]
    fn forged_configuration_acknowledgement_is_terminal() {
        let (supervisor, _runtime, mut supervisor_channel, mut runtime_channel) =
            authenticated_pair();
        let mut supervisor_exchange = SidecarConfigurationExchange::new(supervisor).unwrap();
        supervisor_exchange
            .start(&mut supervisor_channel, &configuration())
            .unwrap();
        let forged = runtime_channel
            .seal(&SidecarRuntimeMessage::Configured {
                manifest: SidecarRuntimeManifest {
                    manifest_generation: 4,
                    capabilities: vec![],
                    commands: vec![],
                },
            })
            .unwrap();

        assert!(matches!(
            supervisor_exchange.receive(&mut supervisor_channel, &forged),
            Err(SidecarConfigurationError::ManifestMismatch)
        ));
        assert_eq!(
            supervisor_exchange.state(),
            SidecarConfigurationState::Failed
        );
        assert!(supervisor_channel.is_retired());
    }

    #[test]
    fn configuration_rejects_status_that_cannot_fit_the_negotiated_channel() {
        let mut supervisor_offer = offer(SidecarPeerRole::Supervisor);
        supervisor_offer.limits.max_frame_bytes = 1024;
        let mut runtime_offer = offer(SidecarPeerRole::Runtime);
        runtime_offer.peer.version = "v".repeat(900);
        let mut supervisor = SidecarHandshake::new(supervisor_offer).unwrap();
        let mut runtime = SidecarHandshake::new(runtime_offer).unwrap();
        let mut supervisor_channel = channel(SidecarPeerRole::Supervisor);
        let mut runtime_channel = channel(SidecarPeerRole::Runtime);
        let offer_frame = supervisor.start(&mut supervisor_channel).unwrap();
        let accept_frame = runtime
            .receive(&mut runtime_channel, &offer_frame)
            .unwrap()
            .unwrap();
        runtime.complete_acceptance(&mut runtime_channel).unwrap();
        supervisor
            .receive(&mut supervisor_channel, &accept_frame)
            .unwrap();
        assert_eq!(supervisor_channel.max_frame_bytes(), 1024);

        let mut exchange = SidecarConfigurationExchange::new(supervisor).unwrap();
        assert!(matches!(
            exchange.start(&mut supervisor_channel, &configuration()),
            Err(SidecarConfigurationError::Configuration(
                SidecarRuntimeBridgeError::StatusMessageTooLarge
            ))
        ));
        assert_eq!(exchange.state(), SidecarConfigurationState::Failed);
        assert!(supervisor_channel.is_retired());
    }

    #[test]
    fn configuration_rejects_unknown_fields_instead_of_ignoring_secrets() {
        let mut value = serde_json::to_value(configuration()).unwrap();
        value["token"] = json!("must-not-be-ignored");
        assert!(serde_json::from_value::<SidecarRuntimeConfiguration>(value).is_err());
    }

    #[test]
    fn lifecycle_events_project_stable_secret_free_status() {
        let (mut exchange, mut channel, _configuration) =
            validated_runtime_exchange(&configuration());
        let adapter = Arc::new(RecordingAdapter::default());
        let mut bridge =
            SidecarRuntimeBridge::activate(&mut exchange, &mut channel, &adapter).unwrap();
        bridge.observe_lifecycle(&LifecycleEvent::Ready { attempt: 2 });
        assert_eq!(
            bridge.status(),
            &SidecarRuntimeStatus {
                state: SidecarRuntimeState::Ready,
                manifest_generation: 3,
                runtime_version: "1.0.0".into(),
                attempt: 2,
                reason: None,
            }
        );
        bridge.observe_lifecycle(&LifecycleEvent::Disconnected {
            attempt: 2,
            reason: LifecycleDisconnectReason::Shutdown,
        });
        assert_eq!(bridge.status().state, SidecarRuntimeState::Draining);
        assert_eq!(bridge.status().reason, Some(SidecarRuntimeReason::Shutdown));
    }

    #[test]
    fn runtime_messages_use_stable_tagged_json() {
        let message = SidecarRuntimeMessage::AdmissionDecision {
            invocation_id: "invoke-1".into(),
            decision: SidecarAdmissionDecision::Deny {
                code: "LOCAL_DENY".into(),
                message: "approval required".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            json!({
                "type": "admission-decision",
                "invocationId": "invoke-1",
                "decision": {
                    "outcome": "deny",
                    "code": "LOCAL_DENY",
                    "message": "approval required"
                }
            })
        );
    }

    #[test]
    fn runtime_messages_reject_nonportable_json_integers() {
        let above_max = MAX_PORTABLE_JSON_INTEGER + 1;
        let status = json!({
            "type": "status",
            "status": {
                "state": "ready",
                "manifestGeneration": above_max,
                "runtimeVersion": "1.0.0",
                "attempt": 1,
                "reason": null
            }
        });
        assert!(serde_json::from_value::<SidecarRuntimeMessage>(status).is_err());

        let invalid_payload = SidecarRuntimeMessage::Result {
            invocation_id: "invoke-unsafe".into(),
            result: SidecarInvocationResult::Success {
                payload: json!({"nested": [above_max]}),
            },
        };
        assert!(serde_json::to_string(&invalid_payload).is_err());

        let float_encoded_integer = format!(
            "{{\"type\":\"result\",\"invocationId\":\"invoke-float\",\"result\":{{\"outcome\":\"success\",\"payload\":{{\"unsafe\":{}.0}}}}}}",
            MAX_PORTABLE_JSON_INTEGER + 1
        );
        assert!(serde_json::from_str::<SidecarRuntimeMessage>(&float_encoded_integer).is_err());

        let mut invalid_configuration = configuration();
        invalid_configuration.manifest_generation = above_max;
        let selection = SidecarProtocolSelection {
            protocol_major: crate::SIDECAR_PROTOCOL_MAJOR,
            protocol_minor: crate::SIDECAR_PROTOCOL_MINOR,
            feature_bits: 0,
            limits: SidecarLimits {
                max_frame_bytes: 4096,
                max_in_flight: 4,
                bootstrap_timeout_ms: 1_000,
            },
        };
        assert!(matches!(
            validate_configuration(&invalid_configuration, selection),
            Err(SidecarRuntimeBridgeError::InvalidManifestGeneration)
        ));
    }

    #[test]
    fn cross_language_runtime_message_corpus_is_exact() {
        let fixture: RuntimeFixture = serde_json::from_str(include_str!(
            "../../../test/fixtures/node-sidecar-runtime-v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.schema_version, 1);
        assert_eq!(fixture.messages.len(), fixture.canonical_json.len());
        for (message, canonical) in fixture.messages.iter().zip(fixture.canonical_json) {
            assert_eq!(serde_json::to_string(message).unwrap(), canonical);
            assert_eq!(
                serde_json::from_str::<SidecarRuntimeMessage>(&canonical).unwrap(),
                *message
            );
        }
    }
}
