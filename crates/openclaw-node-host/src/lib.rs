//! Reusable `OpenClaw` node profile, bounded command runtime, and headless host.

mod host;
mod identity;
mod lifecycle;
mod node;
mod reconnect;
mod runtime;

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
    CancellationToken, CommandRuntime, CommandRuntimeBuilder, HandlerError, InvocationContext,
    RuntimeBuildError, RuntimeError,
};
