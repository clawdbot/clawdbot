use std::{future::Future, time::Duration};

use thiserror::Error;

use crate::reconnect::is_tls_configuration_error;
use crate::{
    ClientError, CommandRuntime, NodeSession, ReconnectAction, ReconnectPause, ReconnectPolicy,
    RuntimeError,
};

const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const DEFAULT_RUNTIME_RESTART_DELAY: Duration = Duration::from_secs(1);
const RETIRED_SESSION_RETRY_DELAY: Duration = Duration::from_secs(1);

/// Stable, secret-free classification for connection diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientErrorClass {
    Configuration,
    Transport,
    Protocol,
    Identity,
    Gateway,
    RequestTimeout,
    EventLagged,
    Activation,
}

impl ClientErrorClass {
    #[must_use]
    pub fn of(error: &ClientError) -> Self {
        match error {
            ClientError::InvalidUrl(_) | ClientError::InsecureRemoteGateway => Self::Configuration,
            ClientError::Tls(reason) if is_tls_configuration_error(reason) => Self::Configuration,
            ClientError::Tls(_)
            | ClientError::Transport(_)
            | ClientError::ConnectTimeout
            | ClientError::ChallengeTimeout
            | ClientError::WriteTimeout(_)
            | ClientError::Closed(_) => Self::Transport,
            ClientError::InvalidChallenge(_) | ClientError::InvalidFrame(_) => Self::Protocol,
            ClientError::ConnectParams(_) | ClientError::Identity(_) => Self::Identity,
            ClientError::Gateway { .. } => Self::Gateway,
            ClientError::RequestTimeout(_) => Self::RequestTimeout,
            ClientError::EventLagged(_) => Self::EventLagged,
            ClientError::NotActivated => Self::Activation,
        }
    }
}

/// Stable, secret-free classification for a local runtime restart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeErrorClass {
    DeliverySaturated,
    ResultTask,
}

/// Why a ready node session left the connected state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleDisconnectReason {
    Client(ClientErrorClass),
    Runtime(RuntimeErrorClass),
    RuntimeEnded,
    Shutdown,
}

/// Observable states emitted by [`NodeLifecycle`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LifecycleEvent {
    Connecting {
        attempt: u64,
    },
    Connected {
        attempt: u64,
        protocol: Option<u64>,
        server_version: Option<String>,
    },
    Ready {
        attempt: u64,
    },
    Disconnected {
        attempt: u64,
        reason: LifecycleDisconnectReason,
    },
    BackingOff {
        attempt: u64,
        delay: Duration,
        reason: LifecycleDisconnectReason,
    },
    Paused {
        attempt: u64,
        reason: ReconnectPause,
    },
    Stopped {
        attempt: u64,
        drained: bool,
    },
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum LifecycleError {
    #[error("node reconnect paused")]
    Paused(ReconnectPause),
}

/// Canonical node connection, reconnect, runtime, and shutdown driver.
///
/// The connection factory is invoked before every attempt. Native embedders can
/// therefore reacquire endpoint, upgrade headers, authentication, account epoch,
/// and challenge-signing state without placing product concepts in this crate.
/// Dropping the returned future cancels the current wait; resolving `shutdown`
/// additionally closes and drains an active session for the configured grace.
#[derive(Clone, Debug)]
pub struct NodeLifecycle {
    reconnect: ReconnectPolicy,
    shutdown_grace: Duration,
    runtime_restart_delay: Duration,
}

impl Default for NodeLifecycle {
    fn default() -> Self {
        Self {
            reconnect: ReconnectPolicy::default(),
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
            runtime_restart_delay: DEFAULT_RUNTIME_RESTART_DELAY,
        }
    }
}

impl NodeLifecycle {
    #[must_use]
    pub fn new(reconnect: ReconnectPolicy) -> Self {
        Self {
            reconnect,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn shutdown_grace(mut self, grace: Duration) -> Self {
        self.shutdown_grace = grace;
        self
    }

    #[must_use]
    pub fn runtime_restart_delay(mut self, delay: Duration) -> Self {
        self.runtime_restart_delay = delay;
        self
    }

    /// Run until explicit shutdown or a terminal reconnect pause.
    ///
    /// `connect` is called exactly once per attempt, so each connection can
    /// advertise a fresh command manifest. Retiring the current session cancels
    /// its active handlers before a later attempt receives work. `on_event`
    /// receives only typed, secret-free state. A Gateway-issued device token is
    /// delivered separately to `on_issued_device_token`; the embedding owns
    /// persistence.
    /// # Errors
    ///
    /// Returns a typed pause for authentication, pairing, protocol,
    /// configuration, or local-identity failures that must not retry forever.
    pub async fn run<C, ConnectFuture, O, T, S>(
        mut self,
        mut connect: C,
        runtime: CommandRuntime,
        mut on_event: O,
        mut on_issued_device_token: T,
        shutdown: S,
    ) -> Result<(), LifecycleError>
    where
        C: FnMut() -> ConnectFuture + Send,
        ConnectFuture: Future<Output = Result<NodeSession, ClientError>> + Send,
        O: FnMut(LifecycleEvent) + Send,
        T: FnMut(&str) + Send,
        S: Future<Output = ()> + Send,
    {
        let mut shutdown = Box::pin(shutdown);
        let mut attempt = 0_u64;
        loop {
            attempt = attempt.saturating_add(1);
            on_event(LifecycleEvent::Connecting { attempt });
            let session = tokio::select! {
                () = &mut shutdown => {
                    on_event(LifecycleEvent::Stopped { attempt, drained: true });
                    return Ok(());
                }
                result = connect() => match result {
                    Ok(session) => session,
                    Err(error) => {
                        if self.handle_client_failure(
                            attempt,
                            &error,
                            &mut on_event,
                            &mut shutdown,
                        ).await? {
                            return Ok(());
                        }
                        continue;
                    }
                }
            };

            self.reconnect.connected();
            on_event(connected_event(attempt, &session));
            if let Some(device_token) = session.issued_device_token() {
                on_issued_device_token(device_token);
            }
            on_event(LifecycleEvent::Ready { attempt });

            let running = runtime.run(session.clone());
            tokio::pin!(running);
            let runtime_result = tokio::select! {
                () = &mut shutdown => {
                    on_event(LifecycleEvent::Disconnected {
                        attempt,
                        reason: LifecycleDisconnectReason::Shutdown,
                    });
                    let graceful = async {
                        session.close().await;
                        let _ = (&mut running).await;
                    };
                    let drained = tokio::time::timeout(self.shutdown_grace, graceful)
                        .await
                        .is_ok();
                    on_event(LifecycleEvent::Stopped { attempt, drained });
                    return Ok(());
                }
                result = &mut running => result,
            };
            session.close().await;

            let stopped = match runtime_result {
                Err(RuntimeError::Client(error)) => {
                    self.handle_client_failure(attempt, &error, &mut on_event, &mut shutdown)
                        .await?
                }
                Err(RuntimeError::DeliverySaturated) => {
                    self.handle_runtime_failure(
                        attempt,
                        RuntimeErrorClass::DeliverySaturated,
                        &mut on_event,
                        &mut shutdown,
                    )
                    .await
                }
                Err(RuntimeError::ResultTask(_)) => {
                    self.handle_runtime_failure(
                        attempt,
                        RuntimeErrorClass::ResultTask,
                        &mut on_event,
                        &mut shutdown,
                    )
                    .await
                }
                Ok(()) => {
                    on_event(LifecycleEvent::Disconnected {
                        attempt,
                        reason: LifecycleDisconnectReason::RuntimeEnded,
                    });
                    false
                }
            };
            if stopped {
                return Ok(());
            }
        }
    }

    async fn handle_client_failure<O, S>(
        &mut self,
        attempt: u64,
        error: &ClientError,
        on_event: &mut O,
        shutdown: &mut std::pin::Pin<Box<S>>,
    ) -> Result<bool, LifecycleError>
    where
        O: FnMut(LifecycleEvent) + Send,
        S: Future<Output = ()> + Send,
    {
        let reason = LifecycleDisconnectReason::Client(ClientErrorClass::of(error));
        on_event(LifecycleEvent::Disconnected { attempt, reason });
        let delay = match self.reconnect.after_failure(error) {
            ReconnectAction::RetryAfter(delay)
            | ReconnectAction::RetryWithStoredDeviceTokenAfter(delay) => delay,
            ReconnectAction::Pause(pause) => {
                on_event(LifecycleEvent::Paused {
                    attempt,
                    reason: pause.clone(),
                });
                return Err(LifecycleError::Paused(pause));
            }
            // The policy reserves KeepSession for request-scoped errors. At this
            // boundary the old session is already retired, so reconnect safely.
            ReconnectAction::KeepSession => RETIRED_SESSION_RETRY_DELAY,
        };
        Ok(backoff_or_stop(attempt, delay, reason, on_event, shutdown).await)
    }

    async fn handle_runtime_failure<O, S>(
        &self,
        attempt: u64,
        error: RuntimeErrorClass,
        on_event: &mut O,
        shutdown: &mut std::pin::Pin<Box<S>>,
    ) -> bool
    where
        O: FnMut(LifecycleEvent) + Send,
        S: Future<Output = ()> + Send,
    {
        let reason = LifecycleDisconnectReason::Runtime(error);
        on_event(LifecycleEvent::Disconnected { attempt, reason });
        backoff_or_stop(
            attempt,
            self.runtime_restart_delay,
            reason,
            on_event,
            shutdown,
        )
        .await
    }
}

fn connected_event(attempt: u64, session: &NodeSession) -> LifecycleEvent {
    LifecycleEvent::Connected {
        attempt,
        protocol: session.hello()["protocol"].as_u64(),
        server_version: session.hello()["server"]["version"]
            .as_str()
            .map(str::to_owned),
    }
}

async fn backoff_or_stop<O, S>(
    attempt: u64,
    delay: Duration,
    reason: LifecycleDisconnectReason,
    on_event: &mut O,
    shutdown: &mut std::pin::Pin<Box<S>>,
) -> bool
where
    O: FnMut(LifecycleEvent) + Send,
    S: Future<Output = ()> + Send,
{
    on_event(LifecycleEvent::BackingOff {
        attempt,
        delay,
        reason,
    });
    if wait_or_shutdown(delay, shutdown).await {
        on_event(LifecycleEvent::Stopped {
            attempt,
            drained: true,
        });
        true
    } else {
        false
    }
}

async fn wait_or_shutdown<S>(delay: Duration, shutdown: &mut std::pin::Pin<Box<S>>) -> bool
where
    S: Future<Output = ()> + Send,
{
    tokio::select! {
        () = shutdown => true,
        () = tokio::time::sleep(delay) => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    fn runtime() -> CommandRuntime {
        CommandRuntime::builder().build().unwrap()
    }

    #[tokio::test]
    async fn shutdown_cancels_an_in_progress_connection_attempt() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let mut stop_tx = Some(stop_tx);

        NodeLifecycle::default()
            .run(
                std::future::pending::<Result<NodeSession, ClientError>>,
                runtime(),
                move |event| {
                    if matches!(event, LifecycleEvent::Connecting { .. }) {
                        if let Some(stop_tx) = stop_tx.take() {
                            let _ = stop_tx.send(());
                        }
                    }
                    observed.lock().unwrap().push(event);
                },
                |_| {},
                async move {
                    let _ = stop_rx.await;
                },
            )
            .await
            .unwrap();

        assert_eq!(
            *events.lock().unwrap(),
            vec![
                LifecycleEvent::Connecting { attempt: 1 },
                LifecycleEvent::Stopped {
                    attempt: 1,
                    drained: true,
                },
            ]
        );
    }

    #[tokio::test]
    async fn shutdown_interrupts_backoff_without_another_attempt() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempt_count = Arc::clone(&attempts);
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let mut stop_tx = Some(stop_tx);

        NodeLifecycle::new(ReconnectPolicy::new(
            Duration::from_mins(1),
            Duration::from_mins(1),
        ))
        .run(
            move || {
                attempt_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                std::future::ready(Err(ClientError::Transport("test failure".into())))
            },
            runtime(),
            move |event| {
                if matches!(event, LifecycleEvent::BackingOff { .. }) {
                    if let Some(stop_tx) = stop_tx.take() {
                        let _ = stop_tx.send(());
                    }
                }
                observed.lock().unwrap().push(event);
            },
            |_| {},
            async move {
                let _ = stop_rx.await;
            },
        )
        .await
        .unwrap();

        assert_eq!(attempts.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                LifecycleEvent::Connecting { attempt: 1 },
                LifecycleEvent::Disconnected {
                    attempt: 1,
                    reason: LifecycleDisconnectReason::Client(ClientErrorClass::Transport),
                },
                LifecycleEvent::BackingOff {
                    attempt: 1,
                    delay: Duration::from_mins(1),
                    reason: LifecycleDisconnectReason::Client(ClientErrorClass::Transport),
                },
                LifecycleEvent::Stopped {
                    attempt: 1,
                    drained: true,
                },
            ]
        );
    }

    #[tokio::test]
    async fn terminal_failure_emits_a_typed_pause() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        let result = NodeLifecycle::default()
            .run(
                || std::future::ready(Err(ClientError::InvalidUrl("test".into()))),
                runtime(),
                move |event| observed.lock().unwrap().push(event),
                |_| {},
                std::future::pending(),
            )
            .await;

        assert_eq!(
            result,
            Err(LifecycleError::Paused(ReconnectPause::Configuration))
        );
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                LifecycleEvent::Connecting { attempt: 1 },
                LifecycleEvent::Disconnected {
                    attempt: 1,
                    reason: LifecycleDisconnectReason::Client(ClientErrorClass::Configuration),
                },
                LifecycleEvent::Paused {
                    attempt: 1,
                    reason: ReconnectPause::Configuration,
                },
            ]
        );
    }
}
