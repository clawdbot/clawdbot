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
        session
            .request("node.echo", json!({"value":42}))
            .await
            .unwrap(),
        json!({"echo":{"value":42}})
    );
    assert_eq!(
        session.next_event().await.unwrap(),
        Event {
            event: "node.test".into(),
            payload: json!({"ready":true}),
            seq: Some(7)
        }
    );
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
