use futures_util::{SinkExt, StreamExt};
use openclaw_gateway_client::{ClientError, Event, GatewayClient, GatewayClientConfig};
use serde_json::{json, Value};
use std::{io, time::Duration};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn connects_publishes_events_and_correlates_requests() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-1"}
            }),
        )
        .await;

        let connect = receive_json(&mut socket).await;
        assert_eq!(connect["method"], "connect");
        assert_eq!(connect["params"]["role"], "node");
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"node.test", "payload":{"ready":true}, "seq":7
            }),
        )
        .await;

        let request = receive_json(&mut socket).await;
        assert_eq!(request["method"], "node.echo");
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":request["id"], "ok":true,
                "payload":{"echo":request["params"]}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |nonce| async move {
            assert_eq!(nonce, "nonce-1");
            Ok::<_, io::Error>(json!({
                "minProtocol":4, "maxProtocol":4,
                "client":{"id":"node-host","version":"test","platform":"test","mode":"node"},
                "role":"node", "scopes":[]
            }))
        },
    )
    .await
    .unwrap();
    assert_eq!(session.hello()["protocol"], 4);
    assert_eq!(
        session.next_event().await.unwrap(),
        Event {
            event: "node.test".into(),
            payload: json!({"ready":true}),
            seq: Some(7)
        }
    );
    assert_eq!(
        session
            .request("node.echo", json!({"value":42}))
            .await
            .unwrap(),
        json!({"echo":{"value":42}})
    );
    server.await.unwrap();
}

#[tokio::test]
async fn idle_disconnect_unblocks_the_retained_event_receiver() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-close"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), session.next_event())
        .await
        .expect("idle disconnect must unblock next_event");
    assert!(matches!(result, Err(ClientError::Closed(_))));
    server.await.unwrap();
}

#[tokio::test]
async fn raw_event_subscription_closes_with_the_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-subscribe"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let mut events = session.subscribe();
    assert!(matches!(
        session.wait_closed().await,
        Err(ClientError::Closed(_))
    ));
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("subscription must terminate"),
        Err(ClientError::Closed(_))
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn default_buffer_retains_256_small_events() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-buffer"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        for seq in 0..256 {
            send_json(
                &mut socket,
                json!({"type":"event", "event":"node.small", "seq":seq}),
            )
            .await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(25)).await;
    for seq in 0..256 {
        let event = session.next_event().await.unwrap();
        assert_eq!(event.event, "node.small");
        assert_eq!(event.seq, Some(seq));
    }
    server.await.unwrap();
}

#[tokio::test]
async fn oversized_retained_event_lags_without_closing_the_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-large-event"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"node.large",
                "payload":{"value":"x".repeat(2000)}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({"type":"event", "event":"node.after-large", "seq":2}),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(50)).await;
    });

    let config = GatewayClientConfig::new(format!("ws://{address}"))
        .unwrap()
        .event_capacity(2)
        .max_event_buffer_bytes(1024);
    let session = GatewayClient::connect(config, |_| async {
        Ok::<_, io::Error>(json!({"role":"node"}))
    })
    .await
    .unwrap();
    assert!(matches!(
        session.next_event().await,
        Err(ClientError::EventLagged(1))
    ));
    assert_eq!(
        session.next_event().await.unwrap().event,
        "node.after-large"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn abandoned_request_releases_its_in_flight_permit() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (first_seen_tx, first_seen_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-abandon"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        let first = receive_json(&mut socket).await;
        assert_eq!(first["method"], "node.first");
        first_seen_tx.send(()).unwrap();
        let second = receive_json(&mut socket).await;
        assert_eq!(second["method"], "node.second");
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":second["id"], "ok":true,
                "payload":{"ok":true}
            }),
        )
        .await;
    });

    let config = GatewayClientConfig::new(format!("ws://{address}"))
        .unwrap()
        .request_timeout(Duration::from_millis(250))
        .max_in_flight(1);
    let session = GatewayClient::connect(config, |_| async {
        Ok::<_, io::Error>(json!({"role":"node"}))
    })
    .await
    .unwrap();
    let first_session = session.clone();
    let first = tokio::spawn(async move { first_session.request("node.first", json!({})).await });
    first_seen_rx.await.unwrap();
    first.abort();

    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(1),
            session.request("node.second", json!({}))
        )
        .await
        .expect("second request must acquire the released permit")
        .unwrap(),
        json!({"ok":true})
    );
    server.await.unwrap();
}

#[tokio::test]
async fn drains_a_queued_event_before_reporting_disconnect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-final"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"node.final", "payload":{"ready":true}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    assert!(matches!(
        session.wait_closed().await,
        Err(ClientError::Closed(_))
    ));
    assert_eq!(
        session.next_event().await.unwrap(),
        Event {
            event: "node.final".into(),
            payload: json!({"ready":true}),
            seq: None,
        }
    );
    assert!(matches!(
        session.next_event().await,
        Err(ClientError::Closed(_))
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn surfaces_websocket_ping_as_transport_activity() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-ping"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        socket
            .send(Message::Ping(vec![1, 2, 3].into()))
            .await
            .unwrap();
        let pong = socket.next().await.unwrap().unwrap();
        assert!(matches!(pong, Message::Pong(_)));
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let mut activity = session.subscribe_transport_activity();
    tokio::time::timeout(Duration::from_secs(1), activity.changed())
        .await
        .expect("ping activity timeout")
        .expect("activity channel remains open");
    server.await.unwrap();
}

#[tokio::test]
async fn connect_response_uses_the_request_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-slow"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
    });

    let config = GatewayClientConfig::new(format!("ws://{address}"))
        .unwrap()
        .challenge_timeout(Duration::from_millis(10))
        .request_timeout(Duration::from_millis(100));
    let session = GatewayClient::connect(config, |_| async {
        Ok::<_, io::Error>(json!({"role":"node"}))
    })
    .await
    .expect("connect response may outlive the challenge timeout");
    assert_eq!(session.hello()["protocol"], 4);
    server.await.unwrap();
}

#[tokio::test]
async fn websocket_establishment_uses_the_connect_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (_tcp, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
    });

    let config = GatewayClientConfig::new(format!("ws://{address}"))
        .unwrap()
        .connect_timeout(Duration::from_millis(25));
    let result = GatewayClient::connect(config, |_| async {
        Ok::<_, io::Error>(json!({"role":"node"}))
    })
    .await;
    assert!(matches!(result, Err(ClientError::ConnectTimeout)));
    server.abort();
}

#[tokio::test]
async fn connect_rejection_preserves_recovery_details() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-2"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(&mut socket, json!({
            "type":"res", "id":connect["id"], "ok":false,
            "error":{"code":"NOT_PAIRED","message":"pairing required",
                "details":{"code":"PAIRING_REQUIRED","deviceId":"device-1","pauseReconnect":true},
                "retryable":false,"retryAfterMs":1250}
        })).await;
    });

    let result = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({})) },
    )
    .await;
    let Err(ClientError::Gateway {
        details,
        retryable,
        retry_after_ms,
        ..
    }) = result
    else {
        panic!("expected structured Gateway rejection");
    };
    let details = openclaw_gateway_client::ConnectErrorDetails::from_value(details.as_ref());
    assert_eq!(details.device_id(), Some("device-1"));
    assert!(details.should_pause_reconnect());
    assert_eq!(retryable, Some(false));
    assert_eq!(retry_after_ms, Some(1250));
    server.await.unwrap();
}

#[test]
fn plaintext_policy_accepts_trusted_private_targets_only() {
    for target in [
        "ws://127.0.0.1:18789",
        "ws://192.168.1.10:18789",
        "ws://100.64.0.1:18789",
        "ws://[::ffff:127.0.0.1]:18789",
        "ws://[::ffff:192.168.1.10]:18789",
        "ws://[::ffff:100.64.0.1]:18789",
        "ws://studio.local:18789",
        "ws://studio.example.ts.net:18789",
        "ws://[fd00::1]:18789",
    ] {
        GatewayClientConfig::new(target).expect("trusted private Gateway target");
    }
    assert!(matches!(
        GatewayClientConfig::new("ws://gateway.example.com:18789"),
        Err(ClientError::InsecureRemoteGateway)
    ));
    assert!(matches!(
        GatewayClientConfig::new("ws://[::ffff:8.8.8.8]:18789"),
        Err(ClientError::InsecureRemoteGateway)
    ));
}

#[tokio::test]
async fn pinned_trust_rejects_plaintext_before_connecting() {
    let config = GatewayClientConfig::new("ws://127.0.0.1:9")
        .unwrap()
        .tls_trust(openclaw_gateway_client::TlsTrust::Pinned([7; 32]));
    let result = GatewayClient::connect(config, |_| async { Ok::<_, io::Error>(json!({})) }).await;
    assert!(matches!(result, Err(ClientError::Tls(_))));
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
