//! Reusable `OpenClaw` node profile, bounded command runtime, and headless host.

mod host;
mod identity;
mod node;
mod reconnect;
mod runtime;

pub use host::{run_host, AuthKind, HostConfig, HostCredentials, HostError};
pub use identity::{IdentityError, NodeIdentity};
pub use node::{
    ClientError, ConnectAuth, DeviceProof, Event, InvocationResult, NodeClient, NodeClientConfig,
    NodeConnectOptions, NodeInvocation, NodeSession, NodeSessionEvent,
};
pub use reconnect::{
    DevicePairingReason, DevicePairingRequest, ReconnectAction, ReconnectPause, ReconnectPolicy,
    RecoveryStep, StoredDeviceTokenRetry,
};
pub use runtime::{
    CancellationToken, CommandRuntime, CommandRuntimeBuilder, HandlerError, InvocationContext,
    RuntimeBuildError, RuntimeError,
};
