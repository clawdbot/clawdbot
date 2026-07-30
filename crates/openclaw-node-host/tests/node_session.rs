use futures_util::{SinkExt, StreamExt};
use openclaw_node_host::{
    ConnectAuth, InvocationResult, NodeClient, NodeClientConfig, NodeConnectOptions, NodeIdentity,
};
use serde_json::{json, Value};
use std::io;
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn node_profile_uses_shared_session_for_invocations() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"node-nonce"}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        assert_eq!(connect["params"]["client"]["mode"], "node");
        assert_eq!(connect["params"]["role"], "node");
        assert_eq!(connect["params"]["commands"], json!(["example.status"]));
        assert_eq!(connect["params"]["device"]["nonce"], "node-nonce");
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
                "type":"event", "event":"node.invoke.request",
                "payload":{"id":"invoke-1","nodeId":"node-1","command":"example.status",
                    "paramsJSON":"{\"verbose\":true}",
                    "sessionKey":"agent:main:main"}
            }),
        )
        .await;
        let result = receive_json(&mut socket).await;
        assert_eq!(result["method"], "node.invoke.result");
        assert_eq!(result["params"]["id"], "invoke-1");
        assert_eq!(result["params"]["payload"], json!({"ready":true}));
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":result["id"], "ok":true, "payload":{"accepted":true}
            }),
        )
        .await;
    });

    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        |nonce| async move {
            assert_eq!(nonce, "node-nonce");
            Ok::<_, io::Error>(
                NodeConnectOptions::new("test", "linux")
                    .command("example.status")
                    .activate()
                    .auth(ConnectAuth::token("test-token"))
                    .identity(NodeIdentity::from_secret_bytes([7; 32])),
            )
        },
    )
    .await
    .unwrap();
    assert!(session.is_activated());
    let invocation = session.next_invocation().await.unwrap();
    assert_eq!(invocation.params, json!({"verbose":true}));
    assert_eq!(invocation.session_key.as_deref(), Some("agent:main:main"));
    session
        .complete_invocation(
            &invocation,
            InvocationResult::success(json!({"ready":true})),
        )
        .await
        .unwrap();
    server.await.unwrap();
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
