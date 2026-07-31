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

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{
    CancellationToken, ClientErrorClass, CommandRuntime, HandlerError, InvocationContext,
    InvocationResult, LifecycleDisconnectReason, LifecycleEvent, NodeInvocation, RuntimeBuildError,
    RuntimeErrorClass, SidecarHandshake, SidecarHandshakeState, SidecarPeerRole,
    SidecarProtocolSelection,
};

pub type SidecarAdapterFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarCommandRegistration {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarRuntimeConfiguration {
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
    pub params: Value,
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
    Success { payload: Value },
    Failure { code: String, message: String },
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
    pub manifest_generation: u64,
    pub runtime_version: String,
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
    params: &'a Value,
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
    Configured,
    Failed,
}

/// Enforces the one-time configuration exchange immediately after the
/// authenticated offer/accept handshake.
pub struct SidecarConfigurationExchange {
    role: SidecarPeerRole,
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
    pub fn new(handshake: &SidecarHandshake) -> Result<Self, SidecarConfigurationError> {
        if handshake.state() != SidecarHandshakeState::Authenticated {
            return Err(SidecarConfigurationError::HandshakeNotAuthenticated);
        }
        let negotiated = handshake
            .negotiated()
            .ok_or(SidecarConfigurationError::HandshakeNotAuthenticated)?;
        let role = handshake.local_role();
        let runtime_version = match role {
            SidecarPeerRole::Runtime => handshake.local_peer().version.clone(),
            SidecarPeerRole::Supervisor => negotiated.remote_peer.version.clone(),
        };
        Ok(Self {
            role,
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

    /// Seal the supervisor's single runtime configuration.
    ///
    /// # Errors
    ///
    /// Every wrong role, state, channel, invalid configuration, or encoding
    /// error retires the exchange and authenticated channel.
    pub fn start(
        &mut self,
        channel: &mut crate::AuthenticatedSidecarChannel,
        configuration: &SidecarRuntimeConfiguration,
    ) -> Result<Vec<u8>, SidecarConfigurationError> {
        if self.role != SidecarPeerRole::Supervisor {
            return self.fail(channel, SidecarConfigurationError::SupervisorMustInitiate);
        }
        if channel.role() != self.role {
            return self.fail(channel, SidecarConfigurationError::ChannelRoleMismatch);
        }
        if self.state != SidecarConfigurationState::Starting {
            return self.fail(channel, SidecarConfigurationError::UnexpectedMessage);
        }
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
        if channel.role() != self.role {
            return self.fail(channel, SidecarConfigurationError::ChannelRoleMismatch);
        }
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
        self.state = SidecarConfigurationState::Configured;
        Ok(frame)
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
    /// Returns an error unless the exact configuration is awaiting runtime
    /// acknowledgement, or for a command-runtime registration failure.
    pub fn from_configuration<A: SidecarCapabilityAdapter + ?Sized>(
        exchange: &SidecarConfigurationExchange,
        adapter: &Arc<A>,
    ) -> Result<Self, SidecarRuntimeBridgeError> {
        if exchange.role != SidecarPeerRole::Runtime {
            return Err(SidecarRuntimeBridgeError::RuntimeRoleRequired);
        }
        let configuration = exchange
            .configuration
            .as_ref()
            .ok_or(SidecarRuntimeBridgeError::ConfigurationNotValidated)?;
        let manifest = manifest_from_configuration(configuration);
        if exchange.state != SidecarConfigurationState::AwaitingAcknowledgement
            || exchange.expected_manifest.as_ref() != Some(&manifest)
        {
            return Err(SidecarRuntimeBridgeError::ConfigurationNotValidated);
        }
        let max_payload_bytes = exchange
            .max_payload_bytes
            .ok_or(SidecarRuntimeBridgeError::ConfigurationNotValidated)?;
        let runtime = build_command_runtime(configuration, &manifest, adapter, max_payload_bytes)?;
        Ok(Self {
            runtime,
            manifest: manifest.clone(),
            status: SidecarRuntimeStatus {
                state: SidecarRuntimeState::Configured,
                manifest_generation: manifest.manifest_generation,
                runtime_version: exchange.runtime_version.clone(),
                attempt: 0,
                reason: None,
            },
        })
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
    builder = builder.admission_policy(move |context| {
        evaluate_sidecar_admission(Arc::clone(&admission_adapter), context, max_payload_bytes)
    });
    for command in &manifest.commands {
        let command_adapter = Arc::clone(adapter);
        builder = builder.command(command.clone(), move |context| {
            evaluate_sidecar_invocation(Arc::clone(&command_adapter), context, max_payload_bytes)
        });
    }
    builder.build()
}

async fn evaluate_sidecar_admission<A: SidecarCapabilityAdapter + ?Sized>(
    adapter: Arc<A>,
    context: crate::InvocationAdmissionContext,
    max_payload_bytes: usize,
) -> Result<(), HandlerError> {
    let invocation_ref = SidecarInvocationRef::from(&context.invocation);
    if !runtime_message_within_limit(
        &SidecarRuntimeMessageRef::AdmissionRequest {
            invocation: invocation_ref,
        },
        max_payload_bytes,
    ) {
        return Err(message_too_large());
    }
    let decision = adapter
        .admit(
            SidecarInvocation::from(&context.invocation),
            context.cancellation,
        )
        .await
        .map_err(|error| adapter_failure(&error))?;
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
) -> Result<Value, HandlerError> {
    let invocation_ref = SidecarInvocationRef::from(&context.invocation);
    if !runtime_message_within_limit(
        &SidecarRuntimeMessageRef::Invoke {
            invocation: invocation_ref,
        },
        max_payload_bytes,
    ) {
        return Err(message_too_large());
    }
    let result = adapter
        .invoke(
            SidecarInvocation::from(&context.invocation),
            context.cancellation,
        )
        .await
        .map_err(|error| adapter_failure(&error))?;
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
    if configuration.manifest_generation == 0 {
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
            attempt: u64::MAX,
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
            feature_bits: u64::MAX,
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
        supervisor
            .receive(&mut supervisor_channel, &accept_frame)
            .unwrap();
        (supervisor, runtime, supervisor_channel, runtime_channel)
    }

    fn authenticated_runtime_handshake() -> SidecarHandshake {
        authenticated_pair().1
    }

    fn validated_runtime_exchange(
        configuration: &SidecarRuntimeConfiguration,
    ) -> (
        SidecarHandshake,
        SidecarConfigurationExchange,
        AuthenticatedSidecarChannel,
        SidecarRuntimeConfiguration,
    ) {
        let (supervisor, runtime, mut supervisor_channel, mut runtime_channel) =
            authenticated_pair();
        let mut supervisor_exchange = SidecarConfigurationExchange::new(&supervisor).unwrap();
        let mut runtime_exchange = SidecarConfigurationExchange::new(&runtime).unwrap();
        let frame = supervisor_exchange
            .start(&mut supervisor_channel, configuration)
            .unwrap();
        let received = runtime_exchange
            .receive(&mut runtime_channel, &frame)
            .unwrap()
            .unwrap();
        (runtime, runtime_exchange, runtime_channel, received)
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
        let (_handshake, exchange, _channel, _configuration) =
            validated_runtime_exchange(&configuration());
        let adapter = Arc::new(RecordingAdapter::default());
        let bridge = SidecarRuntimeBridge::from_configuration(&exchange, &adapter).unwrap();

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
        let (_handshake, exchange, _channel, _configuration) =
            validated_runtime_exchange(&configuration());
        let adapter = Arc::new(RecordingAdapter::default());
        *adapter
            .denied_command
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some("product.settings".into());
        let bridge = SidecarRuntimeBridge::from_configuration(&exchange, &adapter).unwrap();

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

    #[tokio::test]
    async fn complete_message_budget_rejects_boundary_values_before_transport() {
        let mut bounded = configuration();
        bounded.max_input_bytes = 4096;
        bounded.max_output_bytes = 4096;
        let (_handshake, exchange, mut runtime_channel, _received) =
            validated_runtime_exchange(&bounded);
        let adapter = Arc::new(RecordingAdapter::default());
        let bridge = SidecarRuntimeBridge::from_configuration(&exchange, &adapter).unwrap();
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

        let result_adapter = Arc::new(OversizedResultAdapter);
        let result_bridge =
            SidecarRuntimeBridge::from_configuration(&exchange, &result_adapter).unwrap();
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
        let (_handshake, exchange, _channel, _configuration) =
            validated_runtime_exchange(&configuration());
        let invoked = Arc::new(Notify::new());
        let cancelled = Arc::new(Notify::new());
        let adapter = Arc::new(CancellationAdapter {
            invoked: Arc::clone(&invoked),
            cancelled: Arc::clone(&cancelled),
        });
        let bridge = SidecarRuntimeBridge::from_configuration(&exchange, &adapter).unwrap();
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

    #[test]
    fn configuration_requires_authenticated_runtime_and_bounded_manifest() {
        let adapter = Arc::new(RecordingAdapter::default());
        let starting = SidecarHandshake::new(offer(SidecarPeerRole::Runtime)).unwrap();
        assert!(matches!(
            SidecarConfigurationExchange::new(&starting),
            Err(SidecarConfigurationError::HandshakeNotAuthenticated)
        ));

        let handshake = authenticated_runtime_handshake();
        let exchange = SidecarConfigurationExchange::new(&handshake).unwrap();
        assert!(matches!(
            SidecarRuntimeBridge::from_configuration(&exchange, &adapter),
            Err(SidecarRuntimeBridgeError::ConfigurationNotValidated)
        ));
        let selection = SidecarProtocolSelection::from(handshake.negotiated().unwrap());
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
        let mut supervisor_exchange = SidecarConfigurationExchange::new(&supervisor).unwrap();
        let mut runtime_exchange = SidecarConfigurationExchange::new(&runtime).unwrap();
        let configuration = configuration();

        let frame = supervisor_exchange
            .start(&mut supervisor_channel, &configuration)
            .unwrap();
        let received = runtime_exchange
            .receive(&mut runtime_channel, &frame)
            .unwrap()
            .unwrap();
        assert_eq!(received, configuration);

        let adapter = Arc::new(RecordingAdapter::default());
        let bridge = SidecarRuntimeBridge::from_configuration(&runtime_exchange, &adapter).unwrap();
        let acknowledgement = runtime_exchange
            .acknowledge(&mut runtime_channel, bridge.manifest())
            .unwrap();
        assert!(supervisor_exchange
            .receive(&mut supervisor_channel, &acknowledgement)
            .unwrap()
            .is_none());
        assert_eq!(
            supervisor_exchange.state(),
            SidecarConfigurationState::Configured
        );
        assert_eq!(
            runtime_exchange.state(),
            SidecarConfigurationState::Configured
        );
        assert!(!supervisor_channel.is_retired());
        assert!(!runtime_channel.is_retired());
    }

    #[test]
    fn bridge_uses_the_exact_authenticated_configuration() {
        let (_runtime, exchange, _channel, mut caller_copy) =
            validated_runtime_exchange(&configuration());
        caller_copy.max_concurrency = u16::MAX;
        caller_copy.max_input_bytes = u32::MAX;
        assert_eq!(exchange.configuration.as_ref().unwrap().max_concurrency, 2);
        assert_eq!(
            exchange.configuration.as_ref().unwrap().max_input_bytes,
            1024
        );

        let adapter = Arc::new(RecordingAdapter::default());
        let bridge = SidecarRuntimeBridge::from_configuration(&exchange, &adapter).unwrap();
        assert_eq!(bridge.manifest().manifest_generation, 3);
    }

    #[test]
    fn forged_configuration_acknowledgement_is_terminal() {
        let (supervisor, _runtime, mut supervisor_channel, mut runtime_channel) =
            authenticated_pair();
        let mut supervisor_exchange = SidecarConfigurationExchange::new(&supervisor).unwrap();
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
        supervisor
            .receive(&mut supervisor_channel, &accept_frame)
            .unwrap();
        assert_eq!(supervisor_channel.max_frame_bytes(), 1024);

        let mut exchange = SidecarConfigurationExchange::new(&supervisor).unwrap();
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
        let (_handshake, exchange, _channel, _configuration) =
            validated_runtime_exchange(&configuration());
        let adapter = Arc::new(RecordingAdapter::default());
        let mut bridge = SidecarRuntimeBridge::from_configuration(&exchange, &adapter).unwrap();
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
