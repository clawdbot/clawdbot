use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use openclaw_node_host::{
    CommandRuntime, ConnectAuth, InvocationResult, NodeClient, NodeClientConfig,
    NodeConnectOptions, NodeSession,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
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
    let fixture = lifecycle_fixture();
    let server_fixture = fixture.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(serve_duplex_runtime(listener, server_fixture));

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
async fn duplex_input_overflow_forces_a_terminal_failure() {
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
            json!({"type":"event","event":"node.invoke.request","payload":{
                "id":"overflow","nodeId":"node-1","command":"example.duplex","paramsJSON":null
            }}),
        )
        .await;
        for seq in 0..5 {
            send_json(
                &mut socket,
                json!({"type":"event","event":"node.invoke.input","payload":{
                    "id":"overflow","nodeId":"node-1","seq":seq,
                    "payloadJSON":"x".repeat(16 * 1024)
                }}),
            )
            .await;
        }
        let result = receive_json(&mut socket).await;
        assert_eq!(result["method"], "node.invoke.result");
        assert_eq!(result["params"]["ok"], false);
        assert_eq!(result["params"]["error"]["code"], "INPUT_BUFFER_OVERFLOW");
        acknowledge(&mut socket, &result).await;
        socket.close(None).await.unwrap();
    });

    let runtime = CommandRuntime::builder()
        .duplex_command("example.duplex", |_context| async move {
            std::future::pending().await
        })
        .build()
        .unwrap();
    let session = connect_with_command(address, "example.duplex").await;

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

#[tokio::test]
async fn runtime_enforces_the_manifest_of_each_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let first_entered = Arc::new(tokio::sync::Notify::new());
    let server_entered = Arc::clone(&first_entered);
    let server = tokio::spawn(async move {
        for (attempt, (advertised, denied)) in [
            ("example.first", "example.second"),
            ("example.second", "example.first"),
        ]
        .into_iter()
        .enumerate()
        {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json(
                &mut socket,
                json!({"type":"event","event":"connect.challenge",
                    "payload":{"nonce":"node-nonce"}}),
            )
            .await;
            let connect = receive_json(&mut socket).await;
            assert_eq!(connect["params"]["commands"], json!([advertised]));
            send_json(
                &mut socket,
                json!({"type":"res","id":connect["id"],"ok":true,
                    "payload":{"type":"hello-ok","protocol":4}}),
            )
            .await;

            for (id, command) in [("denied", denied), ("allowed", advertised)] {
                send_json(
                    &mut socket,
                    json!({"type":"event","event":"node.invoke.request",
                        "payload":{"id":id,"nodeId":"node-1","command":command}}),
                )
                .await;
                if attempt == 0 && id == "allowed" {
                    server_entered.notified().await;
                    break;
                }
                let result = receive_json(&mut socket).await;
                assert_eq!(result["method"], "node.invoke.result");
                if id == "denied" {
                    assert_eq!(result["params"]["ok"], false);
                    assert_eq!(result["params"]["error"]["code"], "COMMAND_NOT_ADVERTISED");
                } else {
                    assert_eq!(result["params"]["payload"], json!({"command":command}));
                }
                send_json(
                    &mut socket,
                    json!({"type":"res","id":result["id"],"ok":true,
                        "payload":{"accepted":true}}),
                )
                .await;
            }
            socket.close(None).await.unwrap();
        }
    });

    let first_cancelled = Arc::new(tokio::sync::Notify::new());
    let handler_entered = Arc::clone(&first_entered);
    let handler_cancelled = Arc::clone(&first_cancelled);
    let runtime = CommandRuntime::builder()
        .command("example.first", move |context| {
            let entered = Arc::clone(&handler_entered);
            let cancelled = Arc::clone(&handler_cancelled);
            async move {
                let cancellation = context.cancellation.clone();
                tokio::spawn(async move {
                    cancellation.cancelled().await;
                    cancelled.notify_one();
                });
                entered.notify_one();
                std::future::pending().await
            }
        })
        .command("example.second", |context| async move {
            Ok(json!({"command":context.invocation.command}))
        })
        .build()
        .unwrap();
    for (attempt, advertised) in ["example.first", "example.second"].into_iter().enumerate() {
        let session = connect_with_command(address, advertised).await;
        assert!(runtime.run(session).await.is_err());
        if attempt == 0 {
            tokio::time::timeout(Duration::from_secs(1), first_cancelled.notified())
                .await
                .expect("retired connection cancelled its active handler");
        }
    }
    server.await.unwrap();
}

async fn connect_with_command(
    address: std::net::SocketAddr,
    advertised: &'static str,
) -> NodeSession {
    NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        move |nonce| async move {
            let signing_key = SigningKey::from_bytes(&[7; 32]);
            let options = NodeConnectOptions::new("test", "linux")
                .command(advertised)
                .activate()
                .auth(ConnectAuth::token("test-token"));
            let request =
                options.external_signing_request(signing_key.verifying_key().to_bytes(), &nonce)?;
            let signature = signing_key.sign(request.payload().as_bytes());
            Ok::<_, openclaw_node_host::IdentityError>(
                options.device(request.finish(signature.to_bytes())?),
            )
        },
    )
    .await
    .unwrap()
}

async fn serve_duplex_runtime(listener: TcpListener, fixture: Value) {
    let (tcp, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(tcp).await.unwrap();
    send_json(
        &mut socket,
        json!({"type":"event", "event":"connect.challenge",
            "payload":{"nonce":"node-nonce"}}),
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
            "payload":fixture["request"]["canonical"]}),
    )
    .await;
    let inputs = fixture["input"]["canonical"]
        .as_array()
        .expect("canonical input array");
    for payload in [
        inputs[0].clone(),
        json!({"id":"invoke-1","nodeId":"wrong-node","seq":1,"payloadJSON":"wrong"}),
        json!({"id":"invoke-1","nodeId":"node-1","seq":0,"payloadJSON":"duplicate"}),
        inputs[1].clone(),
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
    acknowledge(&mut socket, &first).await;

    let second = receive_json(&mut socket).await;
    assert_eq!(second["method"], "node.invoke.progress");
    assert_eq!(second["params"], fixture["progress"]["canonical"]);
    acknowledge(&mut socket, &second).await;

    let result = receive_json(&mut socket).await;
    assert_eq!(result["method"], "node.invoke.result");
    assert_eq!(result["params"], fixture["results"]["success"]);
    send_json(
        &mut socket,
        json!({"type":"res", "id":result["id"], "ok":true,
            "payload":{"accepted":true}}),
    )
    .await;
}

async fn acknowledge<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, request: &Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json(
        socket,
        json!({"type":"res", "id":request["id"], "ok":true, "payload":{"ok":true}}),
    )
    .await;
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

fn lifecycle_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/node-invoke-lifecycle-contract.json"
    ))
    .expect("valid node invocation lifecycle fixture")
}
