use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use openclaw_node_host::{
    CommandRuntime, ConnectAuth, InvocationResult, NodeClient, NodeClientConfig, NodeConnectOptions,
};
use serde_json::{json, Value};
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
                "payload":{"type":"hello-ok","protocol":4,
                    "auth":{"deviceToken":"issued-device-token"}}
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

    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let public_key = signing_key.verifying_key().to_bytes();
    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        move |nonce| async move {
            assert_eq!(nonce, "node-nonce");
            let options = NodeConnectOptions::new("test", "linux")
                .command("example.status")
                .activate()
                .auth(ConnectAuth::token("test-token"));
            let request = options.external_signing_request(public_key, &nonce)?;
            let signature = signing_key.sign(request.payload().as_bytes());
            Ok::<_, openclaw_node_host::IdentityError>(
                options.device(request.finish(signature.to_bytes())?),
            )
        },
    )
    .await
    .unwrap();
    assert!(session.is_activated());
    assert_eq!(session.issued_device_token(), Some("issued-device-token"));
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

#[tokio::test]
async fn duplex_runtime_routes_ordered_input_and_progress() {
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
        assert_example_connect_surface(&connect);
        send_json(
            &mut socket,
            json!({"type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        send_json(
            &mut socket,
            json!({"type":"event", "event":"node.invoke.request",
                "payload":{"id":"invoke-1","nodeId":"node-1","command":"example.duplex"}}),
        )
        .await;
        for payload in [
            json!({"id":"invoke-1","nodeId":"node-1","seq":0,"payloadJSON":"one"}),
            json!({"id":"invoke-1","nodeId":"wrong-node","seq":1,"payloadJSON":"wrong"}),
            json!({"id":"invoke-1","nodeId":"node-1","seq":0,"payloadJSON":"duplicate"}),
            json!({"id":"invoke-1","nodeId":"node-1","seq":2,"payloadJSON":"two"}),
        ] {
            send_json(
                &mut socket,
                json!({"type":"event", "event":"node.invoke.input", "payload":payload}),
            )
            .await;
        }

        let first = receive_json(&mut socket).await;
        assert_eq!(first["method"], "node.invoke.progress");
        assert_eq!(first["params"]["seq"], 0);
        assert_eq!(
            first["params"]["chunk"].as_str().unwrap().len(),
            16 * 1024 - 1
        );
        send_json(
            &mut socket,
            json!({"type":"res", "id":first["id"], "ok":true, "payload":{"ok":true}}),
        )
        .await;
        let second = receive_json(&mut socket).await;
        assert_eq!(second["method"], "node.invoke.progress");
        assert_eq!(second["params"]["seq"], 1);
        assert_eq!(second["params"]["chunk"], "é");
        send_json(
            &mut socket,
            json!({"type":"res", "id":second["id"], "ok":true, "payload":{"ok":true}}),
        )
        .await;

        let result = receive_json(&mut socket).await;
        assert_eq!(result["method"], "node.invoke.result");
        assert_eq!(result["params"]["payload"], json!({"input":["one","two"]}));
        send_json(
            &mut socket,
            json!({"type":"res", "id":result["id"], "ok":true, "payload":{"accepted":true}}),
        )
        .await;
    });

    let runtime = CommandRuntime::builder()
        .capability("example")
        .duplex_command("example.duplex", |context| async move {
            let io = context.io.expect("duplex command I/O");
            let first = io.recv().await.expect("first input");
            let second = io.recv().await.expect("second input");
            let output = format!("{}é", "a".repeat(16 * 1024 - 1));
            io.emit_chunk(&output).await.unwrap();
            Ok(json!({"input":[first, second]}))
        })
        .build()
        .unwrap();
    let connect_runtime = runtime.clone();
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let public_key = signing_key.verifying_key().to_bytes();
    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        move |nonce| async move {
            let options = connect_runtime.activate(
                NodeConnectOptions::new("test", "linux").auth(ConnectAuth::token("test-token")),
            );
            let request = options.external_signing_request(public_key, &nonce)?;
            let signature = signing_key.sign(request.payload().as_bytes());
            Ok::<_, openclaw_node_host::IdentityError>(
                options.device(request.finish(signature.to_bytes())?),
            )
        },
    )
    .await
    .unwrap();

    assert!(runtime.run(session).await.is_err());
    server.await.unwrap();
}

#[tokio::test]
async fn direct_dispatch_rejects_duplex_without_running_an_event_loop() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({"type":"event","event":"connect.challenge","payload":{"nonce":"node-nonce"}}),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
                "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        send_json(
            &mut socket,
            json!({"type":"event","event":"node.invoke.request",
                "payload":{"id":"invoke-1","nodeId":"node-1","command":"example.duplex"}}),
        )
        .await;
        let result = receive_json(&mut socket).await;
        assert_eq!(result["method"], "node.invoke.result");
        assert_eq!(result["params"]["ok"], false);
        assert_eq!(result["params"]["error"]["code"], "DUPLEX_REQUIRES_RUN");
        send_json(
            &mut socket,
            json!({"type":"res","id":result["id"],"ok":true,"payload":{"accepted":true}}),
        )
        .await;
    });

    let runtime = CommandRuntime::builder()
        .duplex_command("example.duplex", |_context| async { Ok(Value::Null) })
        .build()
        .unwrap();
    let connect_runtime = runtime.clone();
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let public_key = signing_key.verifying_key().to_bytes();
    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        move |nonce| async move {
            let options = connect_runtime.activate(
                NodeConnectOptions::new("test", "linux").auth(ConnectAuth::token("test-token")),
            );
            let request = options.external_signing_request(public_key, &nonce)?;
            let signature = signing_key.sign(request.payload().as_bytes());
            Ok::<_, openclaw_node_host::IdentityError>(
                options.device(request.finish(signature.to_bytes())?),
            )
        },
    )
    .await
    .unwrap();
    let invocation = session.next_invocation().await.unwrap();
    runtime.dispatch(&session, invocation).await.unwrap();
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

fn assert_example_connect_surface(connect: &Value) {
    assert_eq!(connect["params"]["caps"], json!(["example"]));
    assert_eq!(connect["params"]["commands"], json!(["example.duplex"]));
}
