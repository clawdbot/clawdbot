//! Reusable `OpenClaw` node profile, bounded command runtime, and headless host.
//!
//! Register capabilities and exact command handlers with [`CommandRuntimeBuilder`].
//! Embeddings can compose their canonical local approval state through
//! [`CommandRuntimeBuilder::admission_policy`] before any handler runs. Duplex handlers
//! receive transport-neutral ordered input, UTF-8 progress output, heartbeats, and
//! cooperative cancellation through [`InvocationContext`]. Process spawning, policy
//! decisions, and platform credential storage remain embedding-owned.

mod duplex;
mod host;
mod identity;
mod lifecycle;
mod node;
mod reconnect;
mod runtime;

pub use duplex::InvocationIo;
pub use host::{run_host, AuthKind, HostConfig, HostCredentials, HostError};
pub use identity::{DeviceSigningRequest, IdentityError, NodeIdentity};
pub use lifecycle::{
    ClientErrorClass, LifecycleDisconnectReason, LifecycleError, LifecycleEvent, NodeLifecycle,
    RuntimeErrorClass,
};
pub use node::{
    ClientError, ConnectAuth, DeviceProof, Event, EventSubscription, InvocationResult, NodeClient,
    NodeClientConfig, NodeConnectOptions, NodeInvocation, NodeSession, NodeSessionEvent,
};
pub use reconnect::{
    DevicePairingReason, DevicePairingRequest, ReconnectAction, ReconnectPause, ReconnectPolicy,
    RecoveryStep, StoredDeviceTokenRetry,
};
pub use runtime::{
    CancellationToken, CommandRuntime, CommandRuntimeBuilder, HandlerError,
    InvocationAdmissionContext, InvocationContext, RuntimeBuildError, RuntimeError,
};
