use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    net::IpAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use thiserror::Error;
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex, Semaphore};
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
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct GatewayClientConfig {
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    tls_trust: TlsTrust,
    challenge_timeout: Duration,
    request_timeout: Duration,
    max_message_bytes: usize,
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
            challenge_timeout: DEFAULT_CHALLENGE_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
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
    pub fn max_message_bytes(mut self, bytes: usize) -> Self {
        self.max_message_bytes = bytes;
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
        let (mut socket, _) =
            connect_async_tls_with_config(config.request, Some(websocket_config), false, connector)
                .await
                .map_err(|error| classify_connect_error(error, secure_endpoint))?;

        let nonce = tokio::time::timeout(config.challenge_timeout, wait_for_challenge(&mut socket))
            .await
            .map_err(|_| ClientError::ChallengeTimeout)??;
        let params = make_params(nonce)
            .await
            .map_err(|error| ClientError::ConnectParams(error.to_string()))?;

        let connect_id = "rust-gateway-connect-1";
        send_request(&mut socket, connect_id, "connect", params).await?;
        let hello = tokio::time::timeout(
            config.request_timeout,
            wait_for_response(&mut socket, connect_id, "connect"),
        )
        .await
        .map_err(|_| ClientError::RequestTimeout("connect".into()))??;

        // Keep requests and cancellations on one bounded, ordered stream so a
        // timeout cannot overtake its request. Each request carries its
        // semaphore permit through the session task, bounding queued and
        // pending requests even if the caller drops its future.
        let command_capacity = config.max_in_flight.max(1);
        let (command_tx, command_rx) = mpsc::channel(command_capacity);
        let (event_tx, initial_event_rx) = broadcast::channel(config.event_capacity.max(1));
        let (activity_tx, activity_rx) = watch::channel(0_u64);
        let (closed_tx, closed_rx) = watch::channel(None);
        tokio::spawn(run_session(
            socket,
            command_rx,
            event_tx.clone(),
            activity_tx,
            closed_tx,
        ));

        Ok(GatewaySession {
            hello,
            command_tx,
            event_tx,
            event_rx: Arc::new(Mutex::new(initial_event_rx)),
            activity_rx,
            closed_rx,
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
    event_tx: broadcast::Sender<Event>,
    event_rx: Arc<Mutex<broadcast::Receiver<Event>>>,
    activity_rx: watch::Receiver<u64>,
    closed_rx: watch::Receiver<Option<SessionCloseCause>>,
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
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.event_tx.subscribe()
    }

    #[must_use]
    pub fn subscribe_transport_activity(&self) -> watch::Receiver<u64> {
        self.activity_rx.clone()
    }

    pub async fn next_event(&self) -> Result<Event, ClientError> {
        let mut closed = self.closed_rx.clone();
        let mut events = self.event_rx.lock().await;
        match events.try_recv() {
            Ok(event) => return Ok(event),
            Err(broadcast::error::TryRecvError::Lagged(count)) => {
                return Err(ClientError::EventLagged(count));
            }
            Err(broadcast::error::TryRecvError::Closed) => return Err(self.closed_error()),
            Err(broadcast::error::TryRecvError::Empty) => {}
        }
        if closed.borrow().is_some() {
            return Err(self.closed_error());
        }
        tokio::select! {
            biased;
            event = events.recv() => match event {
                Ok(event) => Ok(event),
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    Err(ClientError::EventLagged(count))
                }
                Err(broadcast::error::RecvError::Closed) => Err(self.closed_error()),
            },
            changed = closed.changed() => {
                let _ = changed;
                Err(self.closed_error())
            }
        }
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
        let permit = self
            .in_flight
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| self.closed_error())?;
        let id = format!(
            "rust-gateway-{}",
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        let (reply_tx, reply_rx) = oneshot::channel();
        self.command_tx
            .send(SessionCommand::Request {
                id: id.clone(),
                method: method.clone(),
                params,
                reply: reply_tx,
                permit,
            })
            .await
            .map_err(|_| self.closed_error())?;

        match tokio::time::timeout(self.request_timeout, reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(self.closed_error()),
            Err(_) => {
                let _ = self
                    .command_tx
                    .send(SessionCommand::CancelRequest { id })
                    .await;
                Err(ClientError::RequestTimeout(method))
            }
        }
    }

    pub async fn close(&self) {
        let _ = self.command_tx.send(SessionCommand::Close).await;
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

#[derive(Clone, Debug)]
enum SessionCloseCause {
    Closed(String),
    InvalidFrame(String),
    Transport(String),
}

impl SessionCloseCause {
    fn to_client_error(&self) -> ClientError {
        match self {
            Self::Closed(reason) => ClientError::Closed(reason.clone()),
            Self::InvalidFrame(reason) => ClientError::InvalidFrame(reason.clone()),
            Self::Transport(reason) => ClientError::Transport(reason.clone()),
        }
    }

    fn pending_request_error(&self, method: &str) -> ClientError {
        let suffix = format!("; request {method} did not complete");
        match self {
            Self::Closed(reason) => ClientError::Closed(format!("{reason}{suffix}")),
            Self::InvalidFrame(reason) => ClientError::InvalidFrame(format!("{reason}{suffix}")),
            Self::Transport(reason) => ClientError::Transport(format!("{reason}{suffix}")),
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
    },
    CancelRequest {
        id: String,
    },
    Close,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum IncomingFrame {
    #[serde(rename = "event")]
    Event {
        event: String,
        #[serde(default)]
        payload: Value,
        #[serde(default)]
        seq: Option<u64>,
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
) -> Result<String, ClientError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match next_frame(socket).await? {
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
        } = next_frame(socket).await?
        {
            if id == expected_id {
                return response_result(method, ok, payload, error);
            }
        }
    }
}

async fn next_frame<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
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
            Message::Ping(payload) => socket
                .send(Message::Pong(payload))
                .await
                .map_err(|error| ClientError::Transport(error.to_string()))?,
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
) -> Result<(), ClientError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = json!({ "type": "req", "id": id, "method": method, "params": params });
    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .map_err(|error| ClientError::Transport(error.to_string()))
}

async fn run_session<S>(
    mut socket: tokio_tungstenite::WebSocketStream<S>,
    mut commands: mpsc::Receiver<SessionCommand>,
    events: broadcast::Sender<Event>,
    activity: watch::Sender<u64>,
    closed: watch::Sender<Option<SessionCloseCause>>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let mut pending = HashMap::new();
    let close_reason = loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(SessionCommand::Request { id, method, params, reply, permit }) => {
                        match send_request(&mut socket, &id, &method, params).await {
                            Ok(()) => { pending.insert(id, (method, reply, permit)); }
                            Err(error) => { let _ = reply.send(Err(error)); }
                        }
                    }
                    Some(SessionCommand::CancelRequest { id }) => {
                        pending.remove(&id);
                    }
                    Some(SessionCommand::Close) | None => {
                        let _ = socket.close(None).await;
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
                            Ok(IncomingFrame::Event { event, payload, seq }) => {
                                let _ = events.send(Event { event, payload, seq });
                            }
                            Ok(IncomingFrame::Response { id, ok, payload, error }) => {
                                if let Some((method, reply, _permit)) = pending.remove(&id) {
                                    let _ = reply.send(response_result(&method, ok, payload, error));
                                }
                            }
                            Err(error) => break SessionCloseCause::InvalidFrame(error.to_string()),
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if let Err(error) = socket.send(Message::Pong(payload)).await {
                            break SessionCloseCause::Transport(error.to_string());
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

    for (_, (method, reply, _permit)) in pending {
        let _ = reply.send(Err(close_reason.pending_request_error(&method)));
    }
    let _ = closed.send(Some(close_reason));
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
}
