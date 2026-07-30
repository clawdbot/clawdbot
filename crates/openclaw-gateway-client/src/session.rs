use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    net::IpAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use thiserror::Error;
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex, Semaphore};
use tokio::time::Instant;
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
        protocol::WebSocketConfig,
        Error as TungsteniteError, Message,
    },
    Connector,
};
use url::{Host, Url};

use crate::{pinned_tls_config, TlsTrust};

const DEFAULT_CHALLENGE_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BUFFER_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct GatewayClientConfig {
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    tls_trust: TlsTrust,
    connect_timeout: Duration,
    challenge_timeout: Duration,
    request_timeout: Duration,
    write_timeout: Duration,
    max_message_bytes: usize,
    max_event_buffer_bytes: usize,
    event_capacity: usize,
    max_in_flight: usize,
}

impl GatewayClientConfig {
    /// Build a client configuration for a secure remote or loopback Gateway URL.
    pub fn new(gateway_url: impl AsRef<str>) -> Result<Self, ClientError> {
        validate_gateway_url(gateway_url.as_ref())?;
        let request = gateway_url
            .as_ref()
            .into_client_request()
            .map_err(|error| ClientError::InvalidUrl(error.to_string()))?;
        Ok(Self {
            request,
            tls_trust: TlsTrust::SystemRoots,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            challenge_timeout: DEFAULT_CHALLENGE_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            write_timeout: DEFAULT_WRITE_TIMEOUT,
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
            max_event_buffer_bytes: DEFAULT_MAX_EVENT_BUFFER_BYTES,
            event_capacity: 256,
            max_in_flight: 64,
        })
    }

    /// Add an HTTP header to the WebSocket upgrade request.
    pub fn header(mut self, name: &str, value: &str) -> Result<Self, ClientError> {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| ClientError::InvalidHeader(error.to_string()))?;
        let value = HeaderValue::from_str(value)
            .map_err(|error| ClientError::InvalidHeader(error.to_string()))?;
        self.request.headers_mut().insert(name, value);
        Ok(self)
    }

    #[must_use]
    pub fn tls_trust(mut self, trust: TlsTrust) -> Self {
        self.tls_trust = trust;
        self
    }

    #[must_use]
    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    #[must_use]
    pub fn challenge_timeout(mut self, timeout: Duration) -> Self {
        self.challenge_timeout = timeout;
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

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Event {
    pub event: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub seq: Option<u64>,
}

/// Independent retained-event consumer that drains buffered events and then
/// reports the session's terminal close reason.
pub struct EventSubscription {
    events: broadcast::Receiver<Arc<str>>,
    closed: watch::Receiver<Option<SessionCloseCause>>,
}

impl EventSubscription {
    pub async fn recv(&mut self) -> Result<Event, ClientError> {
        receive_event(&mut self.events, &mut self.closed).await
    }
}

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("invalid Gateway URL: {0}")]
    InvalidUrl(String),
    #[error("invalid WebSocket request header: {0}")]
    InvalidHeader(String),
    #[error("plaintext WebSocket is allowed only for trusted local or private Gateways")]
    InsecureRemoteGateway,
    #[error("Gateway connection failed: {0}")]
    Transport(String),
    #[error("Gateway TLS connection failed: {0}")]
    Tls(String),
    #[error("Gateway connection timed out")]
    ConnectTimeout,
    #[error("Gateway connect challenge timed out")]
    ChallengeTimeout,
    #[error("Gateway connect challenge was invalid: {0}")]
    InvalidChallenge(String),
    #[error("connect parameter callback failed: {0}")]
    ConnectParams(String),
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
}

pub struct GatewayClient;

impl GatewayClient {
    /// Connect after the Gateway supplies its challenge nonce.
    pub async fn connect<F, Fut, E>(
        config: GatewayClientConfig,
        make_params: F,
    ) -> Result<GatewaySession, ClientError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<Value, E>>,
        E: std::fmt::Display + Send + Sync + 'static,
    {
        if matches!(config.tls_trust, TlsTrust::Pinned(_))
            && config.request.uri().scheme_str() != Some("wss")
        {
            return Err(ClientError::Tls(
                "Gateway TLS fingerprint requires a wss:// URL".into(),
            ));
        }
        let websocket_config = WebSocketConfig::default()
            .max_message_size(Some(config.max_message_bytes))
            .max_frame_size(Some(config.max_message_bytes));
        let connector = match config.tls_trust {
            TlsTrust::SystemRoots => None,
            TlsTrust::Pinned(expected) => Some(Connector::Rustls(Arc::new(
                pinned_tls_config(expected).map_err(ClientError::Transport)?,
            ))),
        };
        let secure_endpoint = config.request.uri().scheme_str() == Some("wss");
        let (mut socket, _) = tokio::time::timeout(
            config.connect_timeout,
            connect_async_tls_with_config(config.request, Some(websocket_config), false, connector),
        )
        .await
        .map_err(|_| ClientError::ConnectTimeout)?
        .map_err(|error| classify_connect_error(error, secure_endpoint))?;

        let nonce = tokio::time::timeout(
            config.challenge_timeout,
            wait_for_challenge(&mut socket, config.write_timeout),
        )
        .await
        .map_err(|_| ClientError::ChallengeTimeout)??;
        let params = make_params(nonce)
            .await
            .map_err(|error| ClientError::ConnectParams(error.to_string()))?;

        let connect_id = "rust-gateway-connect-1";
        send_request(
            &mut socket,
            connect_id,
            "connect",
            params,
            config.write_timeout,
        )
        .await?;
        let hello = tokio::time::timeout(
            config.request_timeout,
            wait_for_response(&mut socket, connect_id, "connect", config.write_timeout),
        )
        .await
        .map_err(|_| ClientError::RequestTimeout("connect".into()))??;

        // Keep requests and cancellations on one bounded, ordered stream so a
        // timeout cannot overtake its request. Each request carries its
        // semaphore permit through the session task, bounding queued and
        // pending requests even if the caller drops its future.
        let command_capacity = config.max_in_flight.max(1);
        let (command_tx, command_rx) = mpsc::channel(command_capacity);
        let (event_capacity, max_event_bytes) =
            event_buffer_limits(config.event_capacity, config.max_event_buffer_bytes);
        let (event_tx, initial_event_rx) = broadcast::channel(event_capacity);
        let (activity_tx, activity_rx) = watch::channel(0_u64);
        let (closed_tx, closed_rx) = watch::channel(None);
        let (close_tx, close_rx) = watch::channel(false);
        let cancellations = Arc::new(StdMutex::new(HashSet::new()));
        tokio::spawn(run_session(
            socket,
            SessionChannels {
                commands: command_rx,
                events: event_tx.clone(),
                activity: activity_tx,
                closed: closed_tx,
                close: close_rx,
                cancellations: Arc::clone(&cancellations),
            },
            SessionLimits {
                write_timeout: config.write_timeout,
                max_event_bytes,
            },
        ));

        Ok(GatewaySession {
            hello,
            command_tx,
            event_tx: event_tx.downgrade(),
            event_rx: Arc::new(Mutex::new(initial_event_rx)),
            activity_rx,
            closed_rx,
            close_tx,
            cancellations,
            next_request_id: Arc::new(AtomicU64::new(1)),
            request_timeout: config.request_timeout,
            in_flight: Arc::new(Semaphore::new(config.max_in_flight.max(1))),
        })
    }
}

#[derive(Clone)]
pub struct GatewaySession {
    hello: Value,
    command_tx: mpsc::Sender<SessionCommand>,
    event_tx: broadcast::WeakSender<Arc<str>>,
    event_rx: Arc<Mutex<broadcast::Receiver<Arc<str>>>>,
    activity_rx: watch::Receiver<u64>,
    closed_rx: watch::Receiver<Option<SessionCloseCause>>,
    close_tx: watch::Sender<bool>,
    cancellations: Arc<StdMutex<HashSet<String>>>,
    next_request_id: Arc<AtomicU64>,
    request_timeout: Duration,
    in_flight: Arc<Semaphore>,
}

impl GatewaySession {
    #[must_use]
    pub fn hello(&self) -> &Value {
        &self.hello
    }

    #[must_use]
    pub fn subscribe(&self) -> EventSubscription {
        let events = self
            .event_tx
            .upgrade()
            .map_or_else(closed_event_receiver, |events| events.subscribe());
        EventSubscription {
            events,
            closed: self.closed_rx.clone(),
        }
    }

    #[must_use]
    pub fn subscribe_transport_activity(&self) -> watch::Receiver<u64> {
        self.activity_rx.clone()
    }

    pub async fn next_event(&self) -> Result<Event, ClientError> {
        let mut closed = self.closed_rx.clone();
        let mut events = self.event_rx.lock().await;
        receive_event(&mut events, &mut closed).await
    }

    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, ClientError> {
        let method = method.into();
        if method.is_empty() {
            return Err(ClientError::InvalidFrame(
                "request method must not be empty".into(),
            ));
        }
        let deadline = Instant::now() + self.request_timeout;
        let permit = tokio::time::timeout_at(deadline, self.in_flight.clone().acquire_owned())
            .await
            .map_err(|_| ClientError::RequestTimeout(method.clone()))?
            .map_err(|_| self.closed_error())?;
        let id = format!(
            "rust-gateway-{}",
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        let (reply_tx, reply_rx) = oneshot::channel();
        tokio::time::timeout_at(
            deadline,
            self.command_tx.send(SessionCommand::Request {
                id: id.clone(),
                method: method.clone(),
                params,
                reply: reply_tx,
                permit,
                deadline,
            }),
        )
        .await
        .map_err(|_| ClientError::RequestTimeout(method.clone()))?
        .map_err(|_| self.closed_error())?;

        let mut cancellation =
            RequestCancellation::new(id, self.command_tx.clone(), Arc::clone(&self.cancellations));
        match tokio::time::timeout_at(deadline, reply_rx).await {
            Ok(Ok(result)) => {
                cancellation.disarm();
                result
            }
            Ok(Err(_)) => {
                cancellation.disarm();
                Err(self.closed_error())
            }
            Err(_) => Err(ClientError::RequestTimeout(method)),
        }
    }

    pub async fn close(&self) {
        let _ = self.close_tx.send(true);
    }

    pub async fn wait_closed(&self) -> Result<(), ClientError> {
        let mut closed = self.closed_rx.clone();
        loop {
            if let Some(reason) = closed.borrow().as_ref() {
                return Err(reason.to_client_error());
            }
            if closed.changed().await.is_err() {
                return Err(ClientError::Closed("session task ended".into()));
            }
        }
    }

    fn closed_error(&self) -> ClientError {
        self.closed_rx.borrow().as_ref().map_or_else(
            || ClientError::Closed("session task ended".into()),
            SessionCloseCause::to_client_error,
        )
    }
}

fn closed_event_receiver() -> broadcast::Receiver<Arc<str>> {
    let (sender, receiver) = broadcast::channel(1);
    drop(sender);
    receiver
}

async fn receive_event(
    events: &mut broadcast::Receiver<Arc<str>>,
    closed: &mut watch::Receiver<Option<SessionCloseCause>>,
) -> Result<Event, ClientError> {
    match events.try_recv() {
        Ok(event) => return parse_retained_event(&event),
        Err(broadcast::error::TryRecvError::Lagged(count)) => {
            return Err(ClientError::EventLagged(count));
        }
        Err(broadcast::error::TryRecvError::Closed) => return Err(closed_event_error(closed)),
        Err(broadcast::error::TryRecvError::Empty) => {}
    }
    if closed.borrow().is_some() {
        return Err(closed_event_error(closed));
    }
    tokio::select! {
        biased;
        event = events.recv() => match event {
            Ok(event) => parse_retained_event(&event),
            Err(broadcast::error::RecvError::Lagged(count)) => {
                Err(ClientError::EventLagged(count))
            }
            Err(broadcast::error::RecvError::Closed) => Err(closed_event_error(closed)),
        },
        changed = closed.changed() => {
            let _ = changed;
            Err(closed_event_error(closed))
        }
    }
}

fn parse_retained_event(event: &str) -> Result<Event, ClientError> {
    serde_json::from_str(event).map_err(|error| ClientError::InvalidFrame(error.to_string()))
}

fn closed_event_error(closed: &watch::Receiver<Option<SessionCloseCause>>) -> ClientError {
    closed.borrow().as_ref().map_or_else(
        || ClientError::Closed("session task ended".into()),
        SessionCloseCause::to_client_error,
    )
}

struct RequestCancellation {
    id: Option<String>,
    commands: mpsc::Sender<SessionCommand>,
    cancellations: Arc<StdMutex<HashSet<String>>>,
}

impl RequestCancellation {
    fn new(
        id: String,
        commands: mpsc::Sender<SessionCommand>,
        cancellations: Arc<StdMutex<HashSet<String>>>,
    ) -> Self {
        Self {
            id: Some(id),
            commands,
            cancellations,
        }
    }

    fn disarm(&mut self) {
        self.id = None;
    }
}

impl Drop for RequestCancellation {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.cancellations
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(id.clone());
            let _ = self.commands.try_send(SessionCommand::CancelRequest { id });
        }
    }
}

#[derive(Clone, Debug)]
enum SessionCloseCause {
    Closed(String),
    InvalidFrame(String),
    Transport(String),
    WriteTimeout(String),
}

impl SessionCloseCause {
    fn to_client_error(&self) -> ClientError {
        match self {
            Self::Closed(reason) => ClientError::Closed(reason.clone()),
            Self::InvalidFrame(reason) => ClientError::InvalidFrame(reason.clone()),
            Self::Transport(reason) => ClientError::Transport(reason.clone()),
            Self::WriteTimeout(operation) => ClientError::WriteTimeout(operation.clone()),
        }
    }

    fn pending_request_error(&self, method: &str) -> ClientError {
        let suffix = format!("; request {method} did not complete");
        match self {
            Self::Closed(reason) => ClientError::Closed(format!("{reason}{suffix}")),
            Self::InvalidFrame(reason) => ClientError::InvalidFrame(format!("{reason}{suffix}")),
            Self::Transport(reason) => ClientError::Transport(format!("{reason}{suffix}")),
            Self::WriteTimeout(operation) => {
                ClientError::WriteTimeout(format!("{operation}{suffix}"))
            }
        }
    }
}

enum SessionCommand {
    Request {
        id: String,
        method: String,
        params: Value,
        reply: oneshot::Sender<Result<Value, ClientError>>,
        permit: tokio::sync::OwnedSemaphorePermit,
        deadline: Instant,
    },
    CancelRequest {
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum IncomingFrame {
    #[serde(rename = "event")]
    Event {
        event: String,
        #[serde(default)]
        payload: Value,
    },
    #[serde(rename = "res")]
    Response {
        id: String,
        ok: bool,
        #[serde(default)]
        payload: Value,
        #[serde(default)]
        error: Option<GatewayErrorShape>,
    },
}

#[derive(Deserialize)]
struct GatewayErrorShape {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    details: Option<Value>,
    #[serde(default)]
    retryable: Option<bool>,
    #[serde(default, rename = "retryAfterMs")]
    retry_after_ms: Option<u64>,
}

async fn wait_for_challenge<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    write_timeout: Duration,
) -> Result<String, ClientError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match next_frame(socket, write_timeout).await? {
            IncomingFrame::Event { event, payload, .. } if event == "connect.challenge" => {
                let nonce = payload
                    .get("nonce")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| ClientError::InvalidChallenge("missing nonce".into()))?;
                return Ok(nonce.into());
            }
            IncomingFrame::Event { .. } | IncomingFrame::Response { .. } => {}
        }
    }
}

async fn wait_for_response<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    expected_id: &str,
    method: &str,
    write_timeout: Duration,
) -> Result<Value, ClientError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        if let IncomingFrame::Response {
            id,
            ok,
            payload,
            error,
        } = next_frame(socket, write_timeout).await?
        {
            if id == expected_id {
                return response_result(method, ok, payload, error);
            }
        }
    }
}

async fn next_frame<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    write_timeout: Duration,
) -> Result<IncomingFrame, ClientError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| ClientError::Closed("Gateway ended the WebSocket stream".into()))?
            .map_err(|error| ClientError::Transport(error.to_string()))?;
        match message {
            Message::Text(text) => {
                return serde_json::from_str(text.as_str())
                    .map_err(|error| ClientError::InvalidFrame(error.to_string()));
            }
            Message::Ping(payload) => {
                send_message(socket, Message::Pong(payload), write_timeout, "pong").await?
            }
            Message::Close(frame) => return Err(ClientError::Closed(format_close(frame.as_ref()))),
            Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

async fn send_request<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    id: &str,
    method: &str,
    params: Value,
    write_timeout: Duration,
) -> Result<(), ClientError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = json!({ "type": "req", "id": id, "method": method, "params": params });
    send_message(
        socket,
        Message::Text(frame.to_string().into()),
        write_timeout,
        method,
    )
    .await
}

async fn send_message<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    message: Message,
    timeout: Duration,
    operation: &str,
) -> Result<(), ClientError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::time::timeout(timeout, socket.send(message))
        .await
        .map_err(|_| ClientError::WriteTimeout(operation.into()))?
        .map_err(|error| ClientError::Transport(error.to_string()))
}

fn event_buffer_limits(requested_capacity: usize, max_event_buffer_bytes: usize) -> (usize, usize) {
    let budget = max_event_buffer_bytes.max(1);
    let target_capacity = requested_capacity.max(1).min(budget);
    let capacity = 1_usize << target_capacity.ilog2();
    (capacity, budget / capacity)
}

struct SessionChannels {
    commands: mpsc::Receiver<SessionCommand>,
    events: broadcast::Sender<Arc<str>>,
    activity: watch::Sender<u64>,
    closed: watch::Sender<Option<SessionCloseCause>>,
    close: watch::Receiver<bool>,
    cancellations: Arc<StdMutex<HashSet<String>>>,
}

#[derive(Clone, Copy)]
struct SessionLimits {
    write_timeout: Duration,
    max_event_bytes: usize,
}

async fn run_session<S>(
    mut socket: tokio_tungstenite::WebSocketStream<S>,
    channels: SessionChannels,
    limits: SessionLimits,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let SessionChannels {
        mut commands,
        events,
        activity,
        closed,
        mut close,
        cancellations,
    } = channels;
    let SessionLimits {
        write_timeout,
        max_event_bytes,
    } = limits;
    let mut pending: HashMap<String, PendingRequest> = HashMap::new();
    let close_reason = loop {
        let cancelled_pending = pending
            .keys()
            .filter(|id| {
                cancellations
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .contains(*id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for id in cancelled_pending {
            pending.remove(&id);
            cancellations
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&id);
        }
        let next_deadline = pending
            .values()
            .map(|request: &PendingRequest| request.deadline)
            .min();
        let deadline = async move {
            if let Some(deadline) = next_deadline {
                tokio::time::sleep_until(deadline).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::pin!(deadline);
        tokio::select! {
            changed = close.changed() => {
                let _ = changed;
                let _ = tokio::time::timeout(write_timeout, socket.close(None)).await;
                break SessionCloseCause::Closed("closed by client".into());
            }
            () = &mut deadline => {
                let now = Instant::now();
                let expired = pending
                    .iter()
                    .filter(|(_, request)| request.deadline <= now)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in expired {
                    if let Some(request) = pending.remove(&id) {
                        cancellations
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .remove(&id);
                        let _ = request.reply.send(Err(ClientError::RequestTimeout(
                            request.method,
                        )));
                    }
                }
            }
            command = commands.recv() => {
                match command {
                    Some(SessionCommand::Request { id, method, params, reply, permit, deadline }) => {
                        if cancellations
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .remove(&id)
                        {
                            continue;
                        }
                        if deadline <= Instant::now() {
                            let _ = reply.send(Err(ClientError::RequestTimeout(method)));
                            continue;
                        }
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        let request_deadline_wins = remaining <= write_timeout;
                        match send_request(
                            &mut socket,
                            &id,
                            &method,
                            params,
                            write_timeout.min(remaining),
                        ).await {
                            Ok(()) => {
                                pending.insert(id, PendingRequest { method, reply, _permit: permit, deadline });
                            }
                            Err(ClientError::WriteTimeout(operation)) => {
                                let result = if request_deadline_wins {
                                    Err(ClientError::RequestTimeout(method))
                                } else {
                                    Err(ClientError::WriteTimeout(operation.clone()))
                                };
                                let _ = reply.send(result);
                                break SessionCloseCause::WriteTimeout(operation);
                            }
                            Err(error) => {
                                let reason = error.to_string();
                                let _ = reply.send(Err(error));
                                break SessionCloseCause::Transport(reason);
                            }
                        }
                    }
                    Some(SessionCommand::CancelRequest { id }) => {
                        pending.remove(&id);
                        cancellations
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .remove(&id);
                    }
                    None => {
                        let _ = tokio::time::timeout(write_timeout, socket.close(None)).await;
                        break SessionCloseCause::Closed("closed by client".into());
                    }
                }
            }
            message = socket.next() => {
                if matches!(&message, Some(Ok(_))) {
                    activity.send_modify(|generation| *generation = generation.wrapping_add(1));
                }
                match message {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<IncomingFrame>(text.as_str()) {
                            Ok(IncomingFrame::Event { .. }) => {
                                if text.len() > max_event_bytes {
                                    break SessionCloseCause::InvalidFrame(format!(
                                        "Gateway event exceeds the retained-event limit of {max_event_bytes} bytes"
                                    ));
                                }
                                let _ = events.send(Arc::from(text.as_str()));
                            }
                            Ok(IncomingFrame::Response { id, ok, payload, error }) => {
                                if let Some(request) = pending.remove(&id) {
                                    cancellations
                                        .lock()
                                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                                        .remove(&id);
                                    let _ = request.reply.send(response_result(
                                        &request.method,
                                        ok,
                                        payload,
                                        error,
                                    ));
                                }
                            }
                            Err(error) => break SessionCloseCause::InvalidFrame(error.to_string()),
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if let Err(error) = send_message(
                            &mut socket,
                            Message::Pong(payload),
                            write_timeout,
                            "pong",
                        ).await {
                            break session_close_cause(error);
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        break SessionCloseCause::Closed(format_close(frame.as_ref()));
                    }
                    Some(Ok(Message::Binary(_) | Message::Pong(_) | Message::Frame(_))) => {}
                    Some(Err(error)) => break SessionCloseCause::Transport(error.to_string()),
                    None => break SessionCloseCause::Closed("Gateway ended the WebSocket stream".into()),
                }
            }
        }
    };

    for (_, request) in pending {
        let _ = request
            .reply
            .send(Err(close_reason.pending_request_error(&request.method)));
    }
    let _ = closed.send(Some(close_reason));
}

struct PendingRequest {
    method: String,
    reply: oneshot::Sender<Result<Value, ClientError>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    deadline: Instant,
}

fn session_close_cause(error: ClientError) -> SessionCloseCause {
    match error {
        ClientError::WriteTimeout(operation) => SessionCloseCause::WriteTimeout(operation),
        error => SessionCloseCause::Transport(error.to_string()),
    }
}

fn response_result(
    method: &str,
    ok: bool,
    payload: Value,
    error: Option<GatewayErrorShape>,
) -> Result<Value, ClientError> {
    if ok {
        return Ok(payload);
    }
    let mut error = error.unwrap_or(GatewayErrorShape {
        code: "UNKNOWN".into(),
        message: "Gateway rejected the request".into(),
        details: None,
        retryable: None,
        retry_after_ms: None,
    });
    if error.code.is_empty() {
        error.code = "UNKNOWN".into();
    }
    if error.message.is_empty() {
        error.message = "Gateway rejected the request".into();
    }
    Err(ClientError::Gateway {
        method: method.into(),
        code: error.code,
        message: error.message,
        details: error.details,
        retryable: error.retryable,
        retry_after_ms: error.retry_after_ms,
    })
}

fn classify_connect_error(error: TungsteniteError, secure_endpoint: bool) -> ClientError {
    if matches!(error, TungsteniteError::Tls(_))
        || secure_endpoint
            && matches!(
                &error,
                TungsteniteError::Io(io_error)
                    if io_error.kind() == std::io::ErrorKind::InvalidData
            )
        || error.to_string().contains(crate::TLS_PIN_MISMATCH_ERROR)
    {
        ClientError::Tls(error.to_string())
    } else {
        ClientError::Transport(error.to_string())
    }
}

fn validate_gateway_url(value: &str) -> Result<(), ClientError> {
    let url = Url::parse(value).map_err(|error| ClientError::InvalidUrl(error.to_string()))?;
    match url.scheme() {
        "wss" => Ok(()),
        "ws" if is_trusted_plaintext_host(&url) => Ok(()),
        "ws" => Err(ClientError::InsecureRemoteGateway),
        scheme => Err(ClientError::InvalidUrl(format!(
            "unsupported scheme {scheme}; expected ws or wss"
        ))),
    }
}

fn is_trusted_plaintext_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(address)) => is_trusted_plaintext_address(&IpAddr::V4(address)),
        Some(Host::Ipv6(address)) => is_trusted_plaintext_address(&IpAddr::V6(address)),
        Some(Host::Domain(host)) => {
            let host = host.to_ascii_lowercase();
            host == "localhost" || host.ends_with(".local") || host.ends_with(".ts.net")
        }
        None => false,
    }
}

fn is_trusted_plaintext_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, _, _] = address.octets();
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || (first == 100 && (64..=127).contains(&second))
        }
        IpAddr::V6(address) => {
            if let Some(address) = address.to_ipv4_mapped() {
                return is_trusted_plaintext_address(&IpAddr::V4(address));
            }
            let first = address.segments()[0];
            address.is_loopback() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
        }
    }
}

fn format_close(frame: Option<&tokio_tungstenite::tungstenite::protocol::CloseFrame>) -> String {
    frame.map_or_else(
        || "Gateway closed the WebSocket".into(),
        |frame| {
            format!(
                "Gateway closed the WebSocket ({}): {}",
                frame.code, frame.reason
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio_tungstenite::tungstenite::protocol::Role;

    struct StalledIo;

    impl AsyncRead for StalledIo {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }
    }

    impl AsyncWrite for StalledIo {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Pending
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }
    }

    #[test]
    fn secure_invalid_data_handshakes_are_tls_failures() {
        let invalid_data = || {
            TungsteniteError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "certificate validation failed",
            ))
        };
        assert!(matches!(
            classify_connect_error(invalid_data(), true),
            ClientError::Tls(_)
        ));
        assert!(matches!(
            classify_connect_error(invalid_data(), false),
            ClientError::Transport(_)
        ));
    }

    #[test]
    fn event_buffer_preserves_count_with_an_aggregate_byte_budget() {
        assert_eq!(
            event_buffer_limits(256, 64 * 1024 * 1024),
            (256, 256 * 1024)
        );
        assert_eq!(event_buffer_limits(3, 64), (2, 32));
        assert_eq!(event_buffer_limits(0, 0), (1, 1));
    }

    #[tokio::test]
    async fn stalled_writer_closes_session_and_releases_pending_request() {
        let socket =
            tokio_tungstenite::WebSocketStream::from_raw_socket(StalledIo, Role::Client, None)
                .await;
        let (command_tx, command_rx) = mpsc::channel(1);
        let (event_tx, mut event_rx) = broadcast::channel(1);
        let (activity_tx, _activity_rx) = watch::channel(0);
        let (closed_tx, mut closed_rx) = watch::channel(None);
        let (_close_tx, close_rx) = watch::channel(false);
        let cancellations = Arc::new(StdMutex::new(HashSet::new()));
        let task = tokio::spawn(run_session(
            socket,
            SessionChannels {
                commands: command_rx,
                events: event_tx,
                activity: activity_tx,
                closed: closed_tx,
                close: close_rx,
                cancellations,
            },
            SessionLimits {
                write_timeout: Duration::from_millis(20),
                max_event_bytes: 1024,
            },
        ));

        let permits = Arc::new(Semaphore::new(1));
        let permit = permits.clone().acquire_owned().await.unwrap();
        let (reply_tx, reply_rx) = oneshot::channel();
        command_tx
            .send(SessionCommand::Request {
                id: "stalled-request".into(),
                method: "node.stalled".into(),
                params: json!({}),
                reply: reply_tx,
                permit,
                deadline: Instant::now() + Duration::from_secs(1),
            })
            .await
            .unwrap();

        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), reply_rx)
                .await
                .expect("stalled write must be bounded")
                .unwrap(),
            Err(ClientError::WriteTimeout(operation)) if operation == "node.stalled"
        ));
        closed_rx.changed().await.unwrap();
        assert!(matches!(
            closed_rx.borrow().as_ref(),
            Some(SessionCloseCause::WriteTimeout(operation)) if operation == "node.stalled"
        ));
        assert!(matches!(
            event_rx.recv().await,
            Err(broadcast::error::RecvError::Closed)
        ));
        task.await.unwrap();
        assert_eq!(permits.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancellation_state_survives_a_full_command_queue() {
        let (commands, mut receiver) = mpsc::channel(1);
        commands
            .send(SessionCommand::CancelRequest {
                id: "queue-filler".into(),
            })
            .await
            .unwrap();
        let cancellations = Arc::new(StdMutex::new(HashSet::new()));
        drop(RequestCancellation::new(
            "abandoned".into(),
            commands,
            Arc::clone(&cancellations),
        ));

        assert!(cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains("abandoned"));
        assert!(matches!(
            receiver.try_recv(),
            Ok(SessionCommand::CancelRequest { id }) if id == "queue-filler"
        ));
    }
}
