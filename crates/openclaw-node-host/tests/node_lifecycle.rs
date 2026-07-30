use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use openclaw_node_host::{
    ClientError, ClientErrorClass, CommandRuntime, ConnectAuth, IdentityError,
    LifecycleDisconnectReason, LifecycleEvent, NodeClient, NodeClientConfig, NodeConnectOptions,
    NodeLifecycle, ReconnectPolicy,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn lifecycle_reacquires_each_attempt_delivers_token_and_stops_cleanly() {
    let (address, server) = gateway_fixture().await;

    let attempts = Arc::new(AtomicUsize::new(0));
    let attempt_count = Arc::clone(&attempts);
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&events);
    let token = Arc::new(Mutex::new(None::<String>));
    let observed_token = Arc::clone(&token);
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let mut stop_tx = Some(stop_tx);

    let lifecycle = NodeLifecycle::new(ReconnectPolicy::new(
        Duration::from_millis(1),
        Duration::from_millis(1),
    ))
    .shutdown_grace(Duration::from_secs(1))
    .run(
        move || {
            let attempt = attempt_count.fetch_add(1, Ordering::Relaxed) + 1;
            async move {
                if attempt == 1 {
                    return Err(ClientError::Transport("synthetic first failure".into()));
                }
                NodeClient::connect(
                    NodeClientConfig::new(format!("ws://{address}")),
                    move |nonce| async move {
                        assert_eq!(nonce, "fresh-nonce");
                        let signing_key = SigningKey::from_bytes(&[7; 32]);
                        let options = NodeConnectOptions::new("test", "linux")
                            .auth(ConnectAuth::token(format!("fresh-token-{attempt}")))
                            .activate();
                        let request = options.external_signing_request(
                            signing_key.verifying_key().to_bytes(),
                            &nonce,
                        )?;
                        let signature = signing_key.sign(request.payload().as_bytes());
                        Ok::<_, IdentityError>(
                            options.device(request.finish(signature.to_bytes())?),
                        )
                    },
                )
                .await
            }
        },
        CommandRuntime::builder().build().unwrap(),
        move |event| {
            if matches!(event, LifecycleEvent::Ready { .. }) {
                if let Some(stop_tx) = stop_tx.take() {
                    let _ = stop_tx.send(());
                }
            }
            observed.lock().unwrap().push(event);
        },
        move |issued| *observed_token.lock().unwrap() = Some(issued.to_owned()),
        async move {
            let _ = stop_rx.await;
        },
    );
    tokio::time::timeout(Duration::from_secs(5), Box::pin(lifecycle))
        .await
        .expect("lifecycle did not stop")
        .unwrap();

    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("Gateway did not observe socket shutdown")
        .unwrap();
    assert_eq!(attempts.load(Ordering::Relaxed), 2);
    assert_eq!(
        token.lock().unwrap().as_deref(),
        Some("issued-device-token")
    );
    assert_eq!(*events.lock().unwrap(), expected_events());
}

async fn gateway_fixture() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"fresh-nonce"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        assert_eq!(connect["params"]["auth"]["token"], "fresh-token-2");
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4,
                    "server":{"version":"test-gateway"},
                    "auth":{"deviceToken":"issued-device-token"}}
            }),
        )
        .await;
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(error)) => panic!("socket failed before close: {error}"),
            }
        }
    });
    (address, server)
}

fn expected_events() -> Vec<LifecycleEvent> {
    vec![
        LifecycleEvent::Connecting { attempt: 1 },
        LifecycleEvent::Disconnected {
            attempt: 1,
            reason: LifecycleDisconnectReason::Client(ClientErrorClass::Transport),
        },
        LifecycleEvent::BackingOff {
            attempt: 1,
            delay: Duration::from_millis(1),
            reason: LifecycleDisconnectReason::Client(ClientErrorClass::Transport),
        },
        LifecycleEvent::Connecting { attempt: 2 },
        LifecycleEvent::Connected {
            attempt: 2,
            protocol: Some(4),
            server_version: Some("test-gateway".into()),
        },
        LifecycleEvent::Ready { attempt: 2 },
        LifecycleEvent::Disconnected {
            attempt: 2,
            reason: LifecycleDisconnectReason::Shutdown,
        },
        LifecycleEvent::Stopped {
            attempt: 2,
            drained: true,
        },
    ]
}

async fn send_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn receive_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = socket.next().await.unwrap().unwrap();
    serde_json::from_str(message.into_text().unwrap().as_str()).unwrap()
}
