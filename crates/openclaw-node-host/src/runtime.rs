use futures_util::FutureExt;
use serde_json::Value;
use std::{
    collections::{hash_map::Entry, BTreeMap, BTreeSet, HashMap},
    future::Future,
    io::{self, Write},
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::{
    sync::{watch, Semaphore},
    task::JoinSet,
};

use crate::{
    duplex::{
        InputBuffer, InputDisposition, InvocationIo, InvocationProgress,
        DEFAULT_PENDING_INPUT_BYTES,
    },
    node::{
        ClientError, InvocationResult, NodeConnectOptions, NodeInvocation, NodeSession,
        NodeSessionEvent,
    },
};

const DEFAULT_MAX_CONCURRENCY: usize = 8;
const DEFAULT_MAX_INPUT_BYTES: usize = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const DEFAULT_HANDLER_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_HANDLER_TIMEOUT: Duration = Duration::from_mins(5);
const DEFAULT_RESULT_GRACE: Duration = Duration::from_millis(100);
const DUPLEX_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value, HandlerError>> + Send>>;
type Handler = Arc<dyn Fn(InvocationContext) -> HandlerFuture + Send + Sync>;
type AdmissionFuture = Pin<Box<dyn Future<Output = Result<(), HandlerError>> + Send>>;
type AdmissionPolicy = Arc<dyn Fn(InvocationAdmissionContext) -> AdmissionFuture + Send + Sync>;
type HandlerTaskResult = (Result<(), ClientError>, tokio::sync::OwnedSemaphorePermit);

/// Cooperative local cancellation for a command handler and any child work it starts.
#[derive(Clone, Debug)]
pub struct CancellationToken {
    sender: Arc<watch::Sender<bool>>,
}

impl CancellationToken {
    fn new() -> Self {
        let (sender, _receiver) = watch::channel(false);
        Self {
            sender: Arc::new(sender),
        }
    }

    /// Whether runtime timeout or disconnect cleanup has requested cancellation.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    /// Wait until runtime timeout or disconnect cleanup requests cancellation.
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let mut receiver = self.sender.subscribe();
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }

    pub(crate) fn cancel(&self) {
        self.sender.send_replace(true);
    }
}

/// Handler input independent of internal transport tasks.
#[derive(Clone, Debug)]
pub struct InvocationContext {
    pub invocation: NodeInvocation,
    pub cancellation: CancellationToken,
    /// Present only for commands registered through `duplex_command`.
    pub io: Option<InvocationIo>,
}

/// Input to an embedding-owned command admission policy.
///
/// The Gateway remains authoritative for node pairing and approved command
/// surfaces. This callback lets a native host compose its current local policy
/// and approval state before any platform handler runs, without reimplementing
/// that policy in the Rust runtime.
#[derive(Clone, Debug)]
pub struct InvocationAdmissionContext {
    pub invocation: NodeInvocation,
    pub cancellation: CancellationToken,
}

/// Structured handler rejection returned to the Gateway.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("{code}: {message}")]
pub struct HandlerError {
    pub code: String,
    pub message: String,
}

impl HandlerError {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Registration-time errors for the bounded command runtime.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum RuntimeBuildError {
    #[error("capability name must not be empty")]
    EmptyCapability,
    #[error("command name must not be empty")]
    EmptyCommand,
    #[error("OpenClaw-owned system command namespace is reserved: {0}")]
    ReservedCommand(String),
    #[error("duplicate command registration: {0}")]
    DuplicateCommand(String),
}

/// Terminal failure from a running command runtime.
#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error("runtime result delivery queue saturated; session must be restarted")]
    DeliverySaturated,
    #[error("runtime result task failed: {0}")]
    ResultTask(String),
}

struct Registration {
    command: String,
    handler: Handler,
    duplex: bool,
}

#[derive(Clone)]
struct RegisteredHandler {
    handler: Handler,
    duplex: bool,
}

/// Builder for a reusable command runtime with explicit resource bounds.
pub struct CommandRuntimeBuilder {
    registrations: Vec<Registration>,
    capabilities: Vec<String>,
    admission_policy: Option<AdmissionPolicy>,
    max_concurrency: usize,
    max_input_bytes: usize,
    max_output_bytes: usize,
    default_timeout: Duration,
    max_timeout: Duration,
    result_grace: Duration,
}

impl Default for CommandRuntimeBuilder {
    fn default() -> Self {
        Self {
            registrations: Vec::new(),
            capabilities: Vec::new(),
            admission_policy: None,
            max_concurrency: DEFAULT_MAX_CONCURRENCY,
            max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            default_timeout: DEFAULT_HANDLER_TIMEOUT,
            max_timeout: DEFAULT_MAX_HANDLER_TIMEOUT,
            result_grace: DEFAULT_RESULT_GRACE,
        }
    }
}

impl CommandRuntimeBuilder {
    /// Declare one exact node capability supplied by this runtime.
    #[must_use]
    pub fn capability(mut self, capability: impl Into<String>) -> Self {
        self.capabilities.push(capability.into());
        self
    }

    /// Consult an embedding-owned admission policy before every handler.
    ///
    /// A rejection, panic, or timeout fails closed and the handler is not run.
    #[must_use]
    pub fn admission_policy<F, Fut>(mut self, policy: F) -> Self
    where
        F: Fn(InvocationAdmissionContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), HandlerError>> + Send + 'static,
    {
        self.admission_policy = Some(Arc::new(move |context| Box::pin(policy(context))));
        self
    }

    /// Register one exact command name and asynchronous handler.
    #[must_use]
    pub fn command<F, Fut>(self, command: impl Into<String>, handler: F) -> Self
    where
        F: Fn(InvocationContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, HandlerError>> + Send + 'static,
    {
        self.register(command, handler, false)
    }

    /// Register one exact command with ordered invocation input and progress output.
    #[must_use]
    pub fn duplex_command<F, Fut>(self, command: impl Into<String>, handler: F) -> Self
    where
        F: Fn(InvocationContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, HandlerError>> + Send + 'static,
    {
        self.register(command, handler, true)
    }

    fn register<F, Fut>(mut self, command: impl Into<String>, handler: F, duplex: bool) -> Self
    where
        F: Fn(InvocationContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, HandlerError>> + Send + 'static,
    {
        self.registrations.push(Registration {
            command: command.into(),
            handler: Arc::new(move |context| Box::pin(handler(context))),
            duplex,
        });
        self
    }

    /// Maximum handler/result lifecycles executing concurrently.
    /// Saturation rejects new handler work.
    #[must_use]
    pub fn max_concurrency(mut self, maximum: usize) -> Self {
        self.max_concurrency = maximum.max(1);
        self
    }

    /// Maximum serialized JSON parameter bytes accepted by a handler.
    #[must_use]
    pub fn max_input_bytes(mut self, maximum: usize) -> Self {
        self.max_input_bytes = maximum.max(1);
        self
    }

    /// Maximum serialized JSON result bytes returned by a handler.
    #[must_use]
    pub fn max_output_bytes(mut self, maximum: usize) -> Self {
        self.max_output_bytes = maximum.max(1);
        self
    }

    /// Deadline used when an invocation omits `timeoutMs`.
    #[must_use]
    pub fn default_timeout(mut self, timeout: Duration) -> Self {
        self.default_timeout = nonzero_duration(timeout);
        self
    }

    /// Upper bound applied to both caller-provided and default deadlines.
    #[must_use]
    pub fn max_timeout(mut self, timeout: Duration) -> Self {
        self.max_timeout = nonzero_duration(timeout);
        self
    }

    /// Time reserved inside a Gateway-provided deadline to deliver the result.
    #[must_use]
    pub fn result_grace(mut self, duration: Duration) -> Self {
        self.result_grace = duration;
        self
    }

    /// Validate registrations and construct the runtime.
    /// # Errors
    ///
    /// Returns an error for empty, duplicate, or reserved command names.
    pub fn build(self) -> Result<CommandRuntime, RuntimeBuildError> {
        let mut capabilities = BTreeSet::new();
        for capability in self.capabilities {
            let capability = capability.trim().to_owned();
            if capability.is_empty() {
                return Err(RuntimeBuildError::EmptyCapability);
            }
            capabilities.insert(capability);
        }
        let mut handlers = BTreeMap::new();
        for registration in self.registrations {
            let command = registration.command.trim().to_owned();
            if command.is_empty() {
                return Err(RuntimeBuildError::EmptyCommand);
            }
            if command == "system" || command.starts_with("system.") {
                return Err(RuntimeBuildError::ReservedCommand(command));
            }
            if handlers
                .insert(
                    command.clone(),
                    RegisteredHandler {
                        handler: registration.handler,
                        duplex: registration.duplex,
                    },
                )
                .is_some()
            {
                return Err(RuntimeBuildError::DuplicateCommand(command));
            }
        }
        let max_timeout = nonzero_duration(self.max_timeout);
        Ok(CommandRuntime {
            inner: Arc::new(RuntimeInner {
                handlers,
                capabilities,
                admission_policy: self.admission_policy,
                permits: Arc::new(Semaphore::new(self.max_concurrency.max(1))),
                delivery_capacity: self.max_concurrency.max(1),
                session_scopes: Mutex::new(HashMap::new()),
                max_input_bytes: self.max_input_bytes.max(1),
                max_output_bytes: self.max_output_bytes.max(1),
                default_timeout: nonzero_duration(self.default_timeout).min(max_timeout),
                max_timeout,
                result_grace: self.result_grace,
            }),
        })
    }
}

struct RuntimeInner {
    handlers: BTreeMap<String, RegisteredHandler>,
    capabilities: BTreeSet<String>,
    admission_policy: Option<AdmissionPolicy>,
    permits: Arc<Semaphore>,
    delivery_capacity: usize,
    session_scopes: Mutex<HashMap<usize, SessionScope>>,
    max_input_bytes: usize,
    max_output_bytes: usize,
    default_timeout: Duration,
    max_timeout: Duration,
    result_grace: Duration,
}

/// Exact-name command router with zero queued work and explicit execution bounds.
#[derive(Clone)]
pub struct CommandRuntime {
    inner: Arc<RuntimeInner>,
}

impl CommandRuntime {
    #[must_use]
    pub fn builder() -> CommandRuntimeBuilder {
        CommandRuntimeBuilder::default()
    }

    /// Exact command names registered by this runtime, in deterministic order.
    pub fn command_names(&self) -> impl Iterator<Item = &str> {
        self.inner.handlers.keys().map(String::as_str)
    }

    /// Exact capability names declared by this runtime, in deterministic order.
    pub fn capability_names(&self) -> impl Iterator<Item = &str> {
        self.inner.capabilities.iter().map(String::as_str)
    }

    /// Declare every registered command and activate the supplied connect options.
    #[must_use]
    pub fn activate(&self, mut options: NodeConnectOptions) -> NodeConnectOptions {
        for capability in self.capability_names() {
            options = options.capability(capability);
        }
        for command in self.command_names() {
            options = options.command(command);
        }
        options.activate()
    }

    /// Dispatch one ordinary invocation and complete it through the node session.
    ///
    /// Duplex commands fail with `DUPLEX_REQUIRES_RUN` because this one-shot API does not own
    /// the session event loop needed to route ordered input and cancellation.
    /// # Errors
    ///
    /// Returns a client/result error, or fails closed when the bounded direct
    /// result-delivery capacity itself saturates.
    pub async fn dispatch(
        &self,
        session: &NodeSession,
        invocation: NodeInvocation,
    ) -> Result<(), RuntimeError> {
        if self
            .inner
            .handlers
            .get(&invocation.command)
            .is_some_and(|handler| handler.duplex)
        {
            return session
                .complete_invocation(
                    &invocation,
                    failure(
                        "DUPLEX_REQUIRES_RUN",
                        "duplex commands require CommandRuntime::run",
                    ),
                )
                .await
                .map_err(Into::into);
        }
        let scope = self.session_scope(session);
        let active = scope.active.clone();
        let Ok(permit) = self.inner.permits.clone().try_acquire_owned() else {
            let Ok(delivery) = scope.overload_permits.clone().try_acquire_owned() else {
                session.close().await;
                return Err(RuntimeError::DeliverySaturated);
            };
            let completion = session
                .complete_invocation(
                    &invocation,
                    failure("OVERLOADED", "command runtime is at its concurrency limit"),
                )
                .await;
            drop(delivery);
            return completion.map_err(Into::into);
        };
        let evaluation = tokio::select! {
            evaluation = self.evaluate_with_scope(invocation.clone(), active.clone(), Some(session.clone())) => evaluation,
            closed = session.wait_closed() => {
                active.cancel_all();
                drop(permit);
                return closed.map_err(Into::into);
            }
        };
        let Evaluation {
            result,
            mut tracking,
        } = evaluation;
        let completion = session.complete_invocation(&invocation, result).await;
        if completion.is_ok() {
            if let Some(tracking) = tracking.as_mut() {
                tracking.disarm();
            }
        }
        drop(tracking);
        drop(permit);
        completion.map_err(Into::into)
    }

    /// Consume invocation events until the node session closes.
    ///
    /// The registered handlers may be a superset of the commands advertised by
    /// this connection. Session-bound dispatch fails closed for any command
    /// outside the connection manifest.
    ///
    /// Disconnect cancels and aborts every handler still owned by this run.
    /// # Errors
    ///
    /// Returns session/input/result errors, or fails closed when the bounded
    /// critical result-delivery queue itself saturates.
    pub async fn run(&self, session: NodeSession) -> Result<(), RuntimeError> {
        let mut tasks = JoinSet::new();
        let active = self.session_scope(&session).active;
        let (overload_tx, mut overload_rx) =
            tokio::sync::mpsc::channel(self.inner.delivery_capacity);
        let overload_session = session.clone();
        let mut overload_task = tokio::spawn(async move {
            while let Some((invocation, result)) = overload_rx.recv().await {
                overload_session
                    .complete_invocation(&invocation, result)
                    .await?;
            }
            Ok(())
        });
        loop {
            tokio::select! {
                node_event = session.next_node_event() => {
                    match node_event {
                        Ok(NodeSessionEvent::Invocation(invocation)) => {
                            match self.inner.permits.clone().try_acquire_owned() {
                                Ok(permit) => {
                                    self.spawn_handler_task(
                                        &mut tasks,
                                        &session,
                                        &active,
                                        invocation,
                                        permit,
                                    );
                                }
                                Err(_) => {
                                    match overload_tx.try_send((
                                        invocation,
                                        failure(
                                            "OVERLOADED",
                                            "command runtime is at its concurrency limit",
                                        ),
                                    )) {
                                        Ok(()) => {}
                                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                            stop_runtime_tasks(
                                                &active,
                                                &mut tasks,
                                                &mut overload_task,
                                            ).await;
                                            session.close().await;
                                            return Err(RuntimeError::DeliverySaturated);
                                        }
                                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                                            let error = runtime_task_failure(
                                                (&mut overload_task).await,
                                                "result delivery worker stopped",
                                            );
                                            stop_handler_tasks(&active, &mut tasks).await;
                                            session.close().await;
                                            return Err(error);
                                        }
                                    }
                                }
                            }
                        }
                        Ok(control) => route_invocation_control(&active, control),
                        Err(error) => {
                            stop_runtime_tasks(&active, &mut tasks, &mut overload_task).await;
                            session.close().await;
                            return Err(error.into());
                        }
                    }
                }
                Some(completed) = tasks.join_next(), if !tasks.is_empty() => {
                    match completed {
                        Ok((Ok(()), _permit)) => {}
                        Ok((Err(error), _permit)) => {
                            stop_runtime_tasks(&active, &mut tasks, &mut overload_task).await;
                            session.close().await;
                            return Err(error.into());
                        }
                        Err(error) => {
                            stop_runtime_tasks(&active, &mut tasks, &mut overload_task).await;
                            session.close().await;
                            return Err(RuntimeError::ResultTask(error.to_string()));
                        }
                    }
                }
                completed = &mut overload_task => {
                    let error = runtime_task_failure(
                        completed,
                        "result delivery worker stopped unexpectedly",
                    );
                    stop_handler_tasks(&active, &mut tasks).await;
                    session.close().await;
                    return Err(error);
                }
            }
        }
    }

    fn spawn_handler_task(
        &self,
        tasks: &mut JoinSet<HandlerTaskResult>,
        session: &NodeSession,
        active: &ActiveInvocations,
        invocation: NodeInvocation,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) {
        let runtime = self.clone();
        let task_session = session.clone();
        let cancellation = CancellationToken::new();
        let duplex = self
            .inner
            .handlers
            .get(&invocation.command)
            .is_some_and(|handler| handler.duplex);
        let tracking = active.track(&invocation.id, &invocation.node_id, &cancellation, duplex);
        tasks.spawn(async move {
            let Evaluation {
                result,
                mut tracking,
            } = match tracking {
                Some(tracking) => {
                    runtime
                        .evaluate_tracked(
                            invocation.clone(),
                            cancellation,
                            tracking,
                            Some(task_session.clone()),
                        )
                        .await
                }
                None => Evaluation::untracked(failure(
                    "DUPLICATE_INVOCATION",
                    "invocation id is already executing",
                )),
            };
            let completion = task_session.complete_invocation(&invocation, result).await;
            if completion.is_ok() {
                if let Some(tracking) = tracking.as_mut() {
                    tracking.disarm();
                }
            }
            drop(tracking);
            (completion, permit)
        });
    }

    #[cfg(test)]
    pub(crate) async fn evaluate(&self, invocation: NodeInvocation) -> InvocationResult {
        let Ok(permit) = self.inner.permits.clone().try_acquire_owned() else {
            return failure("OVERLOADED", "command runtime is at its concurrency limit");
        };
        let Evaluation {
            result,
            mut tracking,
        } = self
            .evaluate_with_scope(invocation, ActiveInvocations::default(), None)
            .await;
        if let Some(tracking) = tracking.as_mut() {
            tracking.disarm();
        }
        drop(tracking);
        drop(permit);
        result
    }

    async fn evaluate_with_scope(
        &self,
        invocation: NodeInvocation,
        active: ActiveInvocations,
        session: Option<NodeSession>,
    ) -> Evaluation {
        let cancellation = CancellationToken::new();
        let duplex = self
            .inner
            .handlers
            .get(&invocation.command)
            .is_some_and(|handler| handler.duplex);
        let Some(tracking) =
            active.track(&invocation.id, &invocation.node_id, &cancellation, duplex)
        else {
            return Evaluation::untracked(failure(
                "DUPLICATE_INVOCATION",
                "invocation id is already executing",
            ));
        };
        self.evaluate_tracked(invocation, cancellation, tracking, session)
            .await
    }

    async fn evaluate_tracked(
        &self,
        invocation: NodeInvocation,
        cancellation: CancellationToken,
        tracking: ActiveInvocation,
        session: Option<NodeSession>,
    ) -> Evaluation {
        let registration = match self.resolve_session_handler(&invocation, session.as_ref()) {
            Ok(registration) => registration,
            Err(result) => return Evaluation::tracked(result, tracking),
        };
        let input_within_limit = invocation
            .input_bytes()
            .is_none_or(|received| received <= self.inner.max_input_bytes)
            && serialized_json_within_limit(&invocation.params, self.inner.max_input_bytes);
        if !input_within_limit {
            return Evaluation::tracked(
                failure(
                    "INPUT_TOO_LARGE",
                    "command parameters exceed the runtime limit",
                ),
                tracking,
            );
        }
        let Ok(mut timeout) = self.resolve_timeout(&invocation) else {
            cancellation.cancel();
            return Evaluation::tracked(
                failure(
                    "HANDLER_TIMEOUT",
                    "command handler deadline already elapsed",
                ),
                tracking,
            );
        };
        timeout = match self
            .evaluate_admission(&invocation, &cancellation, timeout)
            .await
        {
            Ok(remaining) => remaining,
            Err(result) => {
                tracking.cancel();
                return Evaluation::tracked(result, tracking);
            }
        };
        let duplex = InvocationDuplex::start(
            registration.duplex,
            session,
            &invocation,
            &cancellation,
            &tracking,
        );
        let input_overflow = tracking.input_overflow.clone();
        let Ok(future) = std::panic::catch_unwind(AssertUnwindSafe(|| {
            (registration.handler)(InvocationContext {
                invocation: invocation.clone(),
                cancellation: cancellation.clone(),
                io: duplex.io.clone(),
            })
        })) else {
            tracking.cancel();
            return Evaluation::tracked(
                failure("HANDLER_PANIC", "command handler panicked"),
                tracking,
            );
        };
        let result = self
            .execute_handler(
                future,
                timeout,
                &cancellation,
                &input_overflow,
                duplex.io.is_some(),
            )
            .await;

        duplex.stop().await;
        Evaluation::tracked(result, tracking)
    }

    async fn execute_handler(
        &self,
        future: HandlerFuture,
        timeout: Option<Duration>,
        cancellation: &CancellationToken,
        input_overflow: &CancellationToken,
        duplex: bool,
    ) -> InvocationResult {
        let handler_result = async {
            let outcome = match timeout {
                Some(timeout) => {
                    tokio::time::timeout(timeout, AssertUnwindSafe(future).catch_unwind()).await
                }
                None => Ok(AssertUnwindSafe(future).catch_unwind().await),
            };
            match outcome {
                Err(_) => {
                    cancellation.cancel();
                    failure("HANDLER_TIMEOUT", "command handler exceeded its deadline")
                }
                Ok(Err(_)) => {
                    cancellation.cancel();
                    failure("HANDLER_PANIC", "command handler panicked")
                }
                Ok(Ok(Err(error))) => handler_failure(
                    error,
                    "HANDLER_ERROR",
                    "command handler failed",
                    self.inner.max_output_bytes,
                ),
                Ok(Ok(Ok(result))) => {
                    if serialized_json_within_limit(&result, self.inner.max_output_bytes) {
                        InvocationResult::success(result)
                    } else {
                        failure(
                            "OUTPUT_TOO_LARGE",
                            "command result exceeds the runtime limit",
                        )
                    }
                }
            }
        };
        tokio::pin!(handler_result);
        if duplex {
            tokio::select! {
                biased;
                () = input_overflow.cancelled() => {
                    cancellation.cancel();
                    failure(
                        "INPUT_BUFFER_OVERFLOW",
                        "duplex command input exceeded the pending-byte limit",
                    )
                }
                result = &mut handler_result => result,
            }
        } else {
            handler_result.as_mut().await
        }
    }

    async fn evaluate_admission(
        &self,
        invocation: &NodeInvocation,
        cancellation: &CancellationToken,
        timeout: Option<Duration>,
    ) -> Result<Option<Duration>, InvocationResult> {
        let Some(admission_policy) = &self.inner.admission_policy else {
            return Ok(timeout);
        };
        let started = Instant::now();
        let admission = std::panic::catch_unwind(AssertUnwindSafe(|| {
            admission_policy(InvocationAdmissionContext {
                invocation: invocation.clone(),
                cancellation: cancellation.clone(),
            })
        }))
        .map_err(|_| failure("ADMISSION_PANIC", "command admission policy panicked"))?;
        let outcome = if let Some(remaining) = timeout {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => {
                    return Err(failure(
                        "INVOCATION_CANCELLED",
                        "command invocation was cancelled during admission",
                    ));
                }
                outcome = tokio::time::timeout(
                    remaining,
                    AssertUnwindSafe(admission).catch_unwind(),
                ) => outcome,
            }
        } else {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => {
                    return Err(failure(
                        "INVOCATION_CANCELLED",
                        "command invocation was cancelled during admission",
                    ));
                }
                outcome = AssertUnwindSafe(admission).catch_unwind() => Ok(outcome),
            }
        };
        match outcome {
            Err(_) => {
                cancellation.cancel();
                Err(failure(
                    "HANDLER_TIMEOUT",
                    "command admission exceeded its deadline",
                ))
            }
            Ok(Err(_)) => Err(failure(
                "ADMISSION_PANIC",
                "command admission policy panicked",
            )),
            Ok(Ok(Err(error))) => Err(handler_failure(
                error,
                "ADMISSION_DENIED",
                "command denied by admission policy",
                self.inner.max_output_bytes,
            )),
            Ok(Ok(Ok(()))) => match timeout {
                Some(remaining) => {
                    let remaining = remaining.saturating_sub(started.elapsed());
                    if remaining.is_zero() {
                        cancellation.cancel();
                        Err(failure(
                            "HANDLER_TIMEOUT",
                            "command handler deadline already elapsed",
                        ))
                    } else {
                        Ok(Some(remaining))
                    }
                }
                None => Ok(None),
            },
        }
    }

    fn resolve_session_handler(
        &self,
        invocation: &NodeInvocation,
        session: Option<&NodeSession>,
    ) -> Result<RegisteredHandler, InvocationResult> {
        if session.is_some_and(|session| !session.advertises_command(&invocation.command)) {
            return Err(failure(
                "COMMAND_NOT_ADVERTISED",
                "command is outside the active connection manifest",
            ));
        }
        self.inner
            .handlers
            .get(&invocation.command)
            .cloned()
            .ok_or_else(|| failure("COMMAND_NOT_FOUND", "no handler registered for command"))
    }

    fn resolve_timeout(&self, invocation: &NodeInvocation) -> Result<Option<Duration>, ()> {
        if invocation.timeout_ms == Some(0) {
            return Ok(None);
        }
        let total = invocation
            .timeout_ms
            .map_or(self.inner.default_timeout, |milliseconds| {
                let gateway_deadline =
                    Duration::from_millis(milliseconds).min(self.inner.max_timeout);
                gateway_deadline.saturating_sub(self.inner.result_grace)
            });
        total
            .checked_sub(invocation.received_elapsed().unwrap_or_default())
            .filter(|remaining| !remaining.is_zero())
            .map(Some)
            .ok_or(())
    }

    fn session_scope(&self, session: &NodeSession) -> SessionScope {
        let (key, marker) = session.runtime_scope();
        let mut scopes = self
            .inner
            .session_scopes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        scopes.retain(|_, scope| scope.marker.strong_count() > 0);
        scopes
            .entry(key)
            .or_insert_with(|| SessionScope {
                marker,
                active: ActiveInvocations::default(),
                overload_permits: Arc::new(Semaphore::new(self.inner.delivery_capacity)),
            })
            .clone()
    }
}

#[derive(Clone)]
struct SessionScope {
    marker: Weak<()>,
    active: ActiveInvocations,
    overload_permits: Arc<Semaphore>,
}

fn runtime_task_failure(
    completed: Result<Result<(), ClientError>, tokio::task::JoinError>,
    unexpected: &str,
) -> RuntimeError {
    match completed {
        Ok(Err(error)) => error.into(),
        Err(error) => RuntimeError::ResultTask(error.to_string()),
        Ok(Ok(())) => RuntimeError::ResultTask(unexpected.into()),
    }
}

async fn stop_handler_tasks(active: &ActiveInvocations, tasks: &mut JoinSet<HandlerTaskResult>) {
    active.cancel_all();
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

async fn stop_runtime_tasks(
    active: &ActiveInvocations,
    tasks: &mut JoinSet<HandlerTaskResult>,
    delivery: &mut tokio::task::JoinHandle<Result<(), ClientError>>,
) {
    delivery.abort();
    stop_handler_tasks(active, tasks).await;
    let _ = delivery.await;
}

fn route_invocation_control(active: &ActiveInvocations, event: NodeSessionEvent) {
    match event {
        NodeSessionEvent::InvocationInput {
            invoke_id,
            node_id,
            seq,
            payload_json,
        } => {
            if active.input(&invoke_id, &node_id, seq, payload_json) == InputDisposition::Overflow {
                active.cancel(&invoke_id);
            }
        }
        NodeSessionEvent::InvocationCancelled { invoke_id, .. } => active.cancel(&invoke_id),
        NodeSessionEvent::Invocation(_) => unreachable!("invocations are dispatched separately"),
    }
}

fn handler_failure(
    error: HandlerError,
    fallback_code: &str,
    fallback_message: &str,
    max_output_bytes: usize,
) -> InvocationResult {
    let code = if error.code.is_empty() {
        fallback_code.to_owned()
    } else {
        error.code
    };
    let message = if error.message.is_empty() {
        fallback_message.to_owned()
    } else {
        error.message
    };
    let payload = serde_json::json!({"code": &code, "message": &message});
    if serialized_json_within_limit(&payload, max_output_bytes) {
        InvocationResult::failure(code, message)
    } else {
        failure(
            "OUTPUT_TOO_LARGE",
            "command error exceeds the runtime limit",
        )
    }
}

struct InvocationDuplex {
    io: Option<InvocationIo>,
    progress: Option<InvocationProgress>,
    heartbeat_task: Option<tokio::task::JoinHandle<()>>,
}

impl InvocationDuplex {
    fn start(
        enabled: bool,
        session: Option<NodeSession>,
        invocation: &NodeInvocation,
        cancellation: &CancellationToken,
        tracking: &ActiveInvocation,
    ) -> Self {
        let progress = enabled
            .then_some(session)
            .flatten()
            .map(|session| InvocationProgress::new(session, invocation, cancellation.clone()));
        let io = progress
            .as_ref()
            .map(|progress| InvocationIo::new(tracking.input_receiver(), progress.clone()));
        let heartbeat_task = progress.as_ref().map(|progress| {
            let progress = progress.clone();
            let cancellation = cancellation.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        () = cancellation.cancelled() => break,
                        () = tokio::time::sleep(DUPLEX_HEARTBEAT_INTERVAL) => {
                            if progress.heartbeat().await.is_err() {
                                cancellation.cancel();
                                break;
                            }
                        }
                    }
                }
            })
        });
        Self {
            io,
            progress,
            heartbeat_task,
        }
    }

    async fn stop(self) {
        if let Some(progress) = &self.progress {
            progress.stop();
        }
        if let Some(heartbeat_task) = self.heartbeat_task {
            heartbeat_task.abort();
            let _ = heartbeat_task.await;
        }
    }
}

struct Evaluation {
    result: InvocationResult,
    tracking: Option<ActiveInvocation>,
}

impl Evaluation {
    fn untracked(result: InvocationResult) -> Self {
        Self {
            result,
            tracking: None,
        }
    }

    fn tracked(result: InvocationResult, tracking: ActiveInvocation) -> Self {
        Self {
            result,
            tracking: Some(tracking),
        }
    }
}

struct ActiveInvocation {
    active: ActiveInvocations,
    id: String,
    cancellation: CancellationToken,
    input: Option<Arc<InputBuffer>>,
    input_overflow: CancellationToken,
    cancel_on_drop: bool,
}

impl ActiveInvocation {
    fn cancel(&self) {
        self.cancellation.cancel();
    }

    fn input_receiver(&self) -> crate::duplex::InvocationInputReceiver {
        self.input
            .as_ref()
            .expect("duplex tracking owns input")
            .receiver()
    }

    fn disarm(&mut self) {
        self.cancel_on_drop = false;
    }
}

impl Drop for ActiveInvocation {
    fn drop(&mut self) {
        if self.cancel_on_drop {
            self.cancellation.cancel();
        }
        self.active.untrack(&self.id);
    }
}

#[derive(Clone, Default)]
struct ActiveInvocations {
    inner: Arc<Mutex<HashMap<String, ActiveInvocationState>>>,
}

struct ActiveInvocationState {
    node_id: String,
    cancellation: CancellationToken,
    input: Option<Arc<InputBuffer>>,
    input_overflow: CancellationToken,
}

impl ActiveInvocations {
    fn track(
        &self,
        id: &str,
        node_id: &str,
        cancellation: &CancellationToken,
        duplex: bool,
    ) -> Option<ActiveInvocation> {
        let mut active = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match active.entry(id.to_owned()) {
            Entry::Vacant(entry) => {
                let input = duplex.then(|| InputBuffer::new(DEFAULT_PENDING_INPUT_BYTES));
                let input_overflow = CancellationToken::new();
                entry.insert(ActiveInvocationState {
                    node_id: node_id.to_owned(),
                    cancellation: cancellation.clone(),
                    input: input.clone(),
                    input_overflow: input_overflow.clone(),
                });
                Some(ActiveInvocation {
                    active: self.clone(),
                    id: id.to_owned(),
                    cancellation: cancellation.clone(),
                    input,
                    input_overflow,
                    cancel_on_drop: true,
                })
            }
            Entry::Occupied(_) => None,
        }
    }

    fn untrack(&self, id: &str) {
        let removed = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id);
        if let Some(input) = removed.and_then(|state| state.input) {
            input.close();
        }
    }

    fn cancel(&self, id: &str) {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .map(|state| (state.cancellation.clone(), state.input.clone()));
        if let Some((cancellation, input)) = state {
            cancellation.cancel();
            if let Some(input) = input {
                input.close();
            }
        }
    }

    fn input(&self, id: &str, node_id: &str, seq: u64, payload: String) -> InputDisposition {
        let (input, input_overflow) = {
            let active = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(state) = active.get(id) else {
                return InputDisposition::Ignored;
            };
            if state.node_id != node_id {
                return InputDisposition::Ignored;
            }
            (state.input.clone(), state.input_overflow.clone())
        };
        let disposition = input.map_or(InputDisposition::Ignored, |input| input.push(seq, payload));
        if disposition == InputDisposition::Overflow {
            input_overflow.cancel();
        }
        disposition
    }

    fn cancel_all(&self) {
        let active = {
            let mut locked = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            std::mem::take(&mut *locked)
        };
        for state in active.values() {
            state.cancellation.cancel();
            if let Some(input) = &state.input {
                input.close();
            }
        }
    }
}

fn failure(code: &str, message: &str) -> InvocationResult {
    InvocationResult::failure(code, message)
}

fn nonzero_duration(value: Duration) -> Duration {
    value.max(Duration::from_millis(1))
}

struct LimitWriter {
    written: usize,
    maximum: usize,
}

impl Write for LimitWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let Some(next) = self.written.checked_add(bytes.len()) else {
            return Err(io::Error::other("serialized JSON exceeds byte limit"));
        };
        if next > self.maximum {
            return Err(io::Error::other("serialized JSON exceeds byte limit"));
        }
        self.written = next;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn serialized_json_within_limit(value: &Value, maximum: usize) -> bool {
    serde_json::to_writer(
        LimitWriter {
            written: 0,
            maximum,
        },
        value,
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::Notify;

    fn invocation(id: &str, command: &str, params: Value) -> NodeInvocation {
        NodeInvocation::new(id, "node-1", command, params)
    }

    fn failure_code(result: &InvocationResult) -> Option<&str> {
        match result {
            InvocationResult::Failure { code, .. } => Some(code),
            InvocationResult::Success(_) => None,
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct IntegrationFixture {
        version: u32,
        declared_capabilities: Vec<String>,
        expected_capabilities: Vec<String>,
        declared_commands: Vec<String>,
        expected_commands: Vec<String>,
        invocations: Vec<IntegrationInvocation>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct IntegrationInvocation {
        command: String,
        gateway_delivery: String,
        gateway_reason: Option<String>,
        local_admission: String,
        expected: Option<String>,
        error_code: Option<String>,
        error_message: Option<String>,
    }

    fn integration_fixture() -> IntegrationFixture {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/node-runtime-integration-contract.json"
        )))
        .expect("valid node runtime integration fixture")
    }

    #[tokio::test]
    async fn shared_authority_handoff_contract_matches_openclaw() {
        let fixture = integration_fixture();
        assert_eq!(fixture.version, 2);
        let local_denied = Arc::new(
            fixture
                .invocations
                .iter()
                .filter(|invocation| invocation.local_admission == "deny")
                .map(|invocation| invocation.command.clone())
                .collect::<BTreeSet<_>>(),
        );
        let admission_evaluations = Arc::new(AtomicUsize::new(0));
        let admission_state = Arc::clone(&admission_evaluations);
        let handler_runs = Arc::new(AtomicUsize::new(0));
        let mut builder = CommandRuntime::builder();
        for capability in fixture.declared_capabilities {
            builder = builder.capability(capability);
        }
        for command in fixture.declared_commands {
            let handler_runs = Arc::clone(&handler_runs);
            builder = builder.command(command, move |_context| {
                let handler_runs = Arc::clone(&handler_runs);
                async move {
                    handler_runs.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"handled": true}))
                }
            });
        }
        let runtime = builder
            .admission_policy(move |context| {
                let local_denied = Arc::clone(&local_denied);
                let admission_evaluations = Arc::clone(&admission_state);
                async move {
                    admission_evaluations.fetch_add(1, Ordering::SeqCst);
                    if local_denied.contains(&context.invocation.command) {
                        Err(HandlerError::new(
                            "LOCAL_POLICY_DENIED",
                            "command is outside the embedding's current local policy",
                        ))
                    } else {
                        Ok(())
                    }
                }
            })
            .build()
            .unwrap();

        assert_eq!(
            runtime.capability_names().collect::<Vec<_>>(),
            fixture
                .expected_capabilities
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            runtime.command_names().collect::<Vec<_>>(),
            fixture
                .expected_commands
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );

        for (index, contract) in fixture.invocations.into_iter().enumerate() {
            if contract.gateway_delivery == "reject" {
                assert_eq!(contract.local_admission, "not-evaluated");
                assert!(contract.gateway_reason.is_some());
                continue;
            }
            assert_eq!(contract.gateway_delivery, "deliver");
            let result = runtime
                .evaluate(invocation(
                    &format!("fixture-{index}"),
                    &contract.command,
                    Value::Null,
                ))
                .await;
            match contract.expected.as_deref() {
                Some("success") => assert!(matches!(result, InvocationResult::Success(_))),
                Some("failure") => assert_eq!(
                    result,
                    InvocationResult::failure(
                        contract.error_code.expect("denial code"),
                        contract.error_message.expect("denial message")
                    )
                ),
                other => panic!("unknown fixture outcome: {other:?}"),
            }
        }
        assert_eq!(admission_evaluations.load(Ordering::SeqCst), 2);
        assert_eq!(handler_runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn routes_success_and_structured_handler_failure() {
        let runtime = CommandRuntime::builder()
            .command("example.ok", |context| async move {
                assert!(context.io.is_none());
                Ok(json!({"echo": context.invocation.params}))
            })
            .command("example.fail", |_context| async {
                Err(HandlerError::new("NOT_READY", "dependency unavailable"))
            })
            .build()
            .unwrap();

        assert_eq!(
            runtime
                .evaluate(invocation("1", "example.ok", json!({"value": 1})))
                .await,
            InvocationResult::success(json!({"echo":{"value":1}}))
        );
        assert_eq!(
            runtime
                .evaluate(invocation("2", "example.fail", Value::Null))
                .await,
            InvocationResult::failure("NOT_READY", "dependency unavailable")
        );
        assert_eq!(
            failure_code(
                &runtime
                    .evaluate(invocation("3", "example.missing", Value::Null))
                    .await
            ),
            Some("COMMAND_NOT_FOUND")
        );
    }

    #[tokio::test]
    async fn enforces_input_and_output_limits() {
        let runtime = CommandRuntime::builder()
            .max_input_bytes(8)
            .max_output_bytes(8)
            .command("example.echo", |context| async move {
                Ok(context.invocation.params)
            })
            .command("example.large", |_context| async { Ok(json!("1234567")) })
            .build()
            .unwrap();

        assert_eq!(
            failure_code(
                &runtime
                    .evaluate(invocation("1", "example.echo", json!({"too":"large"})))
                    .await
            ),
            Some("INPUT_TOO_LARGE")
        );
        assert_eq!(
            failure_code(
                &runtime
                    .evaluate(invocation("2", "example.large", Value::Null))
                    .await
            ),
            Some("OUTPUT_TOO_LARGE")
        );

        let error_runtime = CommandRuntime::builder()
            .max_output_bytes(64)
            .command("example.error", |_context| async {
                Err(HandlerError::new("DEPENDENCY_ERROR", "x".repeat(128)))
            })
            .build()
            .unwrap();
        assert_eq!(
            failure_code(
                &error_runtime
                    .evaluate(invocation("3", "example.error", Value::Null))
                    .await
            ),
            Some("OUTPUT_TOO_LARGE")
        );
    }

    #[tokio::test]
    async fn zero_gateway_timeout_disables_the_handler_deadline() {
        let runtime = CommandRuntime::builder()
            .default_timeout(Duration::from_millis(1))
            .command("example.wait", |_context| async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                Ok(json!({"finished": true}))
            })
            .build()
            .unwrap();
        let mut invocation = invocation("1", "example.wait", Value::Null);
        invocation.timeout_ms = Some(0);

        assert_eq!(
            runtime.evaluate(invocation).await,
            InvocationResult::success(json!({"finished": true}))
        );
    }

    #[tokio::test]
    async fn times_out_and_notifies_child_work() {
        let child_cancelled = Arc::new(AtomicBool::new(false));
        let observed = child_cancelled.clone();
        let runtime = CommandRuntime::builder()
            .default_timeout(Duration::from_millis(10))
            .max_timeout(Duration::from_millis(20))
            .command("example.wait", move |context| {
                let observed = observed.clone();
                async move {
                    let token = context.cancellation.clone();
                    tokio::spawn(async move {
                        token.cancelled().await;
                        observed.store(true, Ordering::SeqCst);
                    });
                    std::future::pending().await
                }
            })
            .build()
            .unwrap();

        assert_eq!(
            failure_code(
                &runtime
                    .evaluate(invocation("1", "example.wait", Value::Null))
                    .await
            ),
            Some("HANDLER_TIMEOUT")
        );
        tokio::task::yield_now().await;
        assert!(child_cancelled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn rejects_saturation_without_queueing() {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let handler_entered = entered.clone();
        let handler_release = release.clone();
        let runtime = CommandRuntime::builder()
            .max_concurrency(1)
            .command("example.block", move |_context| {
                let entered = handler_entered.clone();
                let release = handler_release.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    Ok(Value::Null)
                }
            })
            .build()
            .unwrap();
        let first_runtime = runtime.clone();
        let first = tokio::spawn(async move {
            first_runtime
                .evaluate(invocation("1", "example.block", Value::Null))
                .await
        });
        entered.notified().await;
        assert_eq!(
            failure_code(
                &runtime
                    .evaluate(invocation("2", "example.block", Value::Null))
                    .await
            ),
            Some("OVERLOADED")
        );
        release.notify_one();
        assert!(matches!(first.await.unwrap(), InvocationResult::Success(_)));
    }

    #[tokio::test]
    async fn rejects_duplicate_active_invocation_ids() {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let handler_entered = entered.clone();
        let handler_release = release.clone();
        let runtime = CommandRuntime::builder()
            .command("example.block", move |_context| {
                let entered = handler_entered.clone();
                let release = handler_release.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    Ok(Value::Null)
                }
            })
            .build()
            .unwrap();
        let active = ActiveInvocations::default();
        let first_runtime = runtime.clone();
        let first_active = active.clone();
        let first = tokio::spawn(async move {
            first_runtime
                .evaluate_with_scope(
                    invocation("same-id", "example.block", Value::Null),
                    first_active,
                    None,
                )
                .await
        });
        entered.notified().await;
        let duplicate = runtime
            .evaluate_with_scope(
                invocation("same-id", "example.block", Value::Null),
                active,
                None,
            )
            .await;
        assert_eq!(
            failure_code(&duplicate.result),
            Some("DUPLICATE_INVOCATION")
        );
        release.notify_one();
        assert!(matches!(
            first.await.unwrap().result,
            InvocationResult::Success(_)
        ));
    }

    #[tokio::test]
    async fn gateway_cancellation_closes_duplex_input() {
        let active = ActiveInvocations::default();
        let cancellation = CancellationToken::new();
        let tracking = active
            .track("invoke-1", "node-1", &cancellation, true)
            .unwrap();
        let input = tracking.input_receiver();
        let waiting = tokio::spawn(async move { input.recv().await });

        active.cancel("invoke-1");

        assert!(cancellation.is_cancelled());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), waiting)
                .await
                .expect("input receiver woke")
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn gateway_cancellation_notifies_the_active_handler() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let cancelled = Arc::new(tokio::sync::Notify::new());
        let handler_entered = entered.clone();
        let handler_cancelled = cancelled.clone();
        let runtime = CommandRuntime::builder()
            .command("example.block", move |context| {
                let entered = handler_entered.clone();
                let cancelled = handler_cancelled.clone();
                async move {
                    entered.notify_one();
                    context.cancellation.cancelled().await;
                    cancelled.notify_one();
                    Ok(Value::Null)
                }
            })
            .build()
            .unwrap();
        let active = ActiveInvocations::default();
        let task_runtime = runtime.clone();
        let task_active = active.clone();
        let task = tokio::spawn(async move {
            task_runtime
                .evaluate_with_scope(
                    invocation("invoke-1", "example.block", Value::Null),
                    task_active,
                    None,
                )
                .await
        });

        entered.notified().await;
        active.cancel("invoke-1");
        tokio::time::timeout(Duration::from_secs(1), cancelled.notified())
            .await
            .expect("handler observed Gateway cancellation");
        assert!(matches!(
            task.await.unwrap().result,
            InvocationResult::Success(_)
        ));
    }

    #[tokio::test]
    async fn converts_panics_to_structured_failure() {
        let runtime = CommandRuntime::builder()
            .command("example.panic", |_context| async {
                panic!("handler bug");
                #[allow(unreachable_code)]
                Ok(Value::Null)
            })
            .build()
            .unwrap();
        assert_eq!(
            failure_code(
                &runtime
                    .evaluate(invocation("1", "example.panic", Value::Null))
                    .await
            ),
            Some("HANDLER_PANIC")
        );

        let synchronous = CommandRuntime::builder()
            .command("example.sync-panic", |_context| {
                panic!("handler construction bug");
                #[allow(unreachable_code)]
                async {
                    Ok(Value::Null)
                }
            })
            .build()
            .unwrap();
        assert_eq!(
            failure_code(
                &synchronous
                    .evaluate(invocation("2", "example.sync-panic", Value::Null))
                    .await
            ),
            Some("HANDLER_PANIC")
        );
    }

    #[tokio::test]
    async fn admission_policy_panics_fail_closed_before_handler_execution() {
        let handler_ran = Arc::new(AtomicBool::new(false));
        let handler_state = Arc::clone(&handler_ran);
        let runtime = CommandRuntime::builder()
            .admission_policy(|_context| async {
                panic!("policy unavailable");
            })
            .command("example.status", move |_context| {
                let handler_state = Arc::clone(&handler_state);
                async move {
                    handler_state.store(true, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            })
            .build()
            .unwrap();

        assert_eq!(
            failure_code(
                &runtime
                    .evaluate(invocation("1", "example.status", Value::Null))
                    .await
            ),
            Some("ADMISSION_PANIC")
        );
        assert!(!handler_ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn gateway_cancellation_stops_admission_before_handler_execution() {
        let admission_entered = Arc::new(Notify::new());
        let handler_ran = Arc::new(AtomicBool::new(false));
        let entered = Arc::clone(&admission_entered);
        let handler_state = Arc::clone(&handler_ran);
        let runtime = CommandRuntime::builder()
            .admission_policy(move |_context| {
                let entered = Arc::clone(&entered);
                async move {
                    entered.notify_one();
                    std::future::pending().await
                }
            })
            .command("example.status", move |_context| {
                let handler_state = Arc::clone(&handler_state);
                async move {
                    handler_state.store(true, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            })
            .build()
            .unwrap();
        let active = ActiveInvocations::default();
        let task_runtime = runtime.clone();
        let task_active = active.clone();
        let task = tokio::spawn(async move {
            task_runtime
                .evaluate_with_scope(
                    invocation("invoke-1", "example.status", Value::Null),
                    task_active,
                    None,
                )
                .await
        });

        admission_entered.notified().await;
        active.cancel("invoke-1");
        let evaluation = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("cancelled admission returned")
            .unwrap();

        assert_eq!(
            failure_code(&evaluation.result),
            Some("INVOCATION_CANCELLED")
        );
        assert!(!handler_ran.load(Ordering::SeqCst));
    }

    #[test]
    fn rejects_invalid_registrations() {
        let empty_capability = CommandRuntime::builder().capability(" ").build();
        assert!(matches!(
            empty_capability,
            Err(RuntimeBuildError::EmptyCapability)
        ));

        let empty = CommandRuntime::builder()
            .command("", |_context| async { Ok(Value::Null) })
            .build();
        assert!(matches!(empty, Err(RuntimeBuildError::EmptyCommand)));

        for command in ["system", "system.run"] {
            let reserved = CommandRuntime::builder()
                .command(command, |_context| async { Ok(Value::Null) })
                .build();
            assert!(matches!(
                reserved,
                Err(RuntimeBuildError::ReservedCommand(_))
            ));
        }

        let duplicate = CommandRuntime::builder()
            .command("example.status", |_context| async { Ok(Value::Null) })
            .command("example.status", |_context| async { Ok(Value::Null) })
            .build();
        assert!(matches!(
            duplicate,
            Err(RuntimeBuildError::DuplicateCommand(_))
        ));
    }

    #[test]
    fn declares_registered_commands_in_deterministic_order() {
        let runtime = CommandRuntime::builder()
            .command("example.z", |_context| async { Ok(Value::Null) })
            .command("example.a", |_context| async { Ok(Value::Null) })
            .build()
            .unwrap();
        assert_eq!(
            runtime.command_names().collect::<Vec<_>>(),
            ["example.a", "example.z"]
        );
    }

    #[test]
    fn cancellation_scopes_do_not_cross_sessions() {
        let first = ActiveInvocations::default();
        let second = ActiveInvocations::default();
        let first_token = CancellationToken::new();
        let second_token = CancellationToken::new();
        let first_tracking = first
            .track("same-id", "node-1", &first_token, false)
            .unwrap();
        let mut second_tracking = second
            .track("same-id", "node-2", &second_token, false)
            .unwrap();

        first.cancel_all();

        assert!(first_token.is_cancelled());
        assert!(!second_token.is_cancelled());
        drop(first_tracking);
        second_tracking.disarm();
        drop(second_tracking);
    }
}
