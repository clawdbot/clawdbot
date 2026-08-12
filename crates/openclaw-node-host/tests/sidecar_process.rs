use std::{
    env,
    process::{Command, Stdio},
    time::Duration,
};

use openclaw_node_host::{
    read_sidecar_frame, write_sidecar_frame, AuthenticatedSidecarChannel, SidecarAdmissionDecision,
    SidecarCommandRegistration, SidecarConfigurationExchange, SidecarHandshake,
    SidecarHandshakeState, SidecarInvocation, SidecarInvocationResult, SidecarLimits,
    SidecarPeerIdentity, SidecarPeerRole, SidecarProtocolOffer, SidecarRuntimeConfiguration,
    SidecarRuntimeMessage, SidecarSessionKey, SIDECAR_PROTOCOL_MAJOR, SIDECAR_PROTOCOL_MINOR,
};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};

const CHILD_ENV: &str = "OPENCLAW_SIDECAR_PROCESS_CHILD";
const CHILD_ADDRESS_ENV: &str = "OPENCLAW_SIDECAR_PROCESS_ADDRESS";
const FRAME_LIMIT: u32 = 4_096;
const SESSION_KEY: [u8; 32] = [0x5a; 32];
const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the parent transcript intentionally keeps the full ordered process exchange visible"
)]
async fn authenticated_sidecar_crosses_a_real_process_boundary() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let child = Command::new(env::current_exe().unwrap())
        .arg("--exact")
        .arg("sidecar_process_child")
        .arg("--nocapture")
        .env(CHILD_ENV, "1")
        .env(CHILD_ADDRESS_ENV, address.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let (stream, _) = tokio::time::timeout(IO_TIMEOUT, listener.accept())
        .await
        .expect("sidecar child did not connect")
        .unwrap();
    let (mut input, mut output) = stream.into_split();
    let mut channel = channel(SidecarPeerRole::Supervisor);
    let mut handshake = SidecarHandshake::new(offer(SidecarPeerRole::Supervisor)).unwrap();

    let offered = handshake.start(&mut channel).unwrap();
    write_sidecar_frame(&mut output, &offered, FRAME_LIMIT, IO_TIMEOUT)
        .await
        .unwrap();
    let accepted = read_sidecar_frame(&mut input, FRAME_LIMIT, IO_TIMEOUT)
        .await
        .unwrap();
    assert!(handshake
        .receive(&mut channel, &accepted)
        .unwrap()
        .is_none());
    assert_eq!(handshake.state(), SidecarHandshakeState::Authenticated);

    let mut exchange = SidecarConfigurationExchange::new(handshake).unwrap();
    let configuration = configuration();
    let configure = exchange.start(&mut channel, &configuration).unwrap();
    write_sidecar_frame(
        &mut output,
        &configure,
        channel.max_frame_bytes(),
        IO_TIMEOUT,
    )
    .await
    .unwrap();
    let configured = read_sidecar_frame(&mut input, channel.max_frame_bytes(), IO_TIMEOUT)
        .await
        .unwrap();
    assert!(exchange
        .receive(&mut channel, &configured)
        .unwrap()
        .is_none());

    let invocation = invocation();
    let admission = channel
        .seal(&SidecarRuntimeMessage::AdmissionRequest {
            invocation: invocation.clone(),
        })
        .unwrap();
    write_sidecar_frame(
        &mut output,
        &admission,
        channel.max_frame_bytes(),
        IO_TIMEOUT,
    )
    .await
    .unwrap();
    let decision = read_sidecar_frame(&mut input, channel.max_frame_bytes(), IO_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(
        channel.open::<SidecarRuntimeMessage>(&decision).unwrap(),
        SidecarRuntimeMessage::AdmissionDecision {
            invocation_id: invocation.id.clone(),
            decision: SidecarAdmissionDecision::Allow,
        }
    );

    let invoke = channel
        .seal(&SidecarRuntimeMessage::Invoke {
            invocation: invocation.clone(),
        })
        .unwrap();
    write_sidecar_frame(&mut output, &invoke, channel.max_frame_bytes(), IO_TIMEOUT)
        .await
        .unwrap();
    let result = read_sidecar_frame(&mut input, channel.max_frame_bytes(), IO_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(
        channel.open::<SidecarRuntimeMessage>(&result).unwrap(),
        SidecarRuntimeMessage::Result {
            invocation_id: invocation.id,
            result: SidecarInvocationResult::Success {
                payload: json!({"handledBy": "process-runtime", "value": 42}),
            },
        }
    );

    let output = tokio::task::spawn_blocking(move || child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "child failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn sidecar_process_child() {
    if env::var_os(CHILD_ENV).is_none() {
        return;
    }
    let address = env::var(CHILD_ADDRESS_ENV).expect("child address");
    let stream = tokio::time::timeout(IO_TIMEOUT, TcpStream::connect(address))
        .await
        .expect("supervisor was unavailable")
        .unwrap();
    let (mut input, mut output) = stream.into_split();
    let mut channel = channel(SidecarPeerRole::Runtime);
    let mut handshake = SidecarHandshake::new(offer(SidecarPeerRole::Runtime)).unwrap();

    let offered = read_sidecar_frame(&mut input, FRAME_LIMIT, IO_TIMEOUT)
        .await
        .unwrap();
    let accepted = handshake
        .receive(&mut channel, &offered)
        .unwrap()
        .expect("supervisor offer must produce acceptance");
    write_sidecar_frame(&mut output, &accepted, FRAME_LIMIT, IO_TIMEOUT)
        .await
        .unwrap();
    handshake.complete_acceptance(&mut channel).unwrap();
    assert_eq!(handshake.state(), SidecarHandshakeState::Authenticated);

    let mut exchange = SidecarConfigurationExchange::new(handshake).unwrap();
    let configure = read_sidecar_frame(&mut input, channel.max_frame_bytes(), IO_TIMEOUT)
        .await
        .unwrap();
    let received = exchange
        .receive(&mut channel, &configure)
        .unwrap()
        .expect("runtime must receive configuration");
    assert_eq!(received, configuration());
    let manifest = exchange.validated_manifest().unwrap().clone();
    let configured = exchange.acknowledge(&mut channel, &manifest).unwrap();
    write_sidecar_frame(
        &mut output,
        &configured,
        channel.max_frame_bytes(),
        IO_TIMEOUT,
    )
    .await
    .unwrap();
    exchange.complete_acknowledgement(&mut channel).unwrap();

    let admission = read_sidecar_frame(&mut input, channel.max_frame_bytes(), IO_TIMEOUT)
        .await
        .unwrap();
    let SidecarRuntimeMessage::AdmissionRequest { invocation } =
        channel.open::<SidecarRuntimeMessage>(&admission).unwrap()
    else {
        panic!("expected admission request");
    };
    assert_eq!(invocation.command, "product.status");
    let decision = channel
        .seal(&SidecarRuntimeMessage::AdmissionDecision {
            invocation_id: invocation.id,
            decision: SidecarAdmissionDecision::Allow,
        })
        .unwrap();
    write_sidecar_frame(
        &mut output,
        &decision,
        channel.max_frame_bytes(),
        IO_TIMEOUT,
    )
    .await
    .unwrap();

    let invoke = read_sidecar_frame(&mut input, channel.max_frame_bytes(), IO_TIMEOUT)
        .await
        .unwrap();
    let SidecarRuntimeMessage::Invoke { invocation } =
        channel.open::<SidecarRuntimeMessage>(&invoke).unwrap()
    else {
        panic!("expected invocation");
    };
    assert_eq!(invocation.params, json!({"value": 42}));
    let result = channel
        .seal(&SidecarRuntimeMessage::Result {
            invocation_id: invocation.id,
            result: SidecarInvocationResult::Success {
                payload: json!({"handledBy": "process-runtime", "value": 42}),
            },
        })
        .unwrap();
    write_sidecar_frame(&mut output, &result, channel.max_frame_bytes(), IO_TIMEOUT)
        .await
        .unwrap();
}

fn configuration() -> SidecarRuntimeConfiguration {
    SidecarRuntimeConfiguration {
        manifest_generation: 3,
        capabilities: vec!["native.status".into()],
        commands: vec![SidecarCommandRegistration {
            name: "product.status".into(),
        }],
        max_concurrency: 1,
        max_input_bytes: 1_024,
        max_output_bytes: 1_024,
        default_timeout_ms: 1_000,
        max_timeout_ms: 5_000,
        result_grace_ms: 50,
    }
}

fn invocation() -> SidecarInvocation {
    SidecarInvocation {
        id: "invoke-process-1".into(),
        node_id: "node-process-1".into(),
        command: "product.status".into(),
        params: json!({"value": 42}),
        timeout_ms: Some(1_000),
        idempotency_key: Some("process-idempotency-1".into()),
        session_key: Some("agent:main:process".into()),
    }
}

fn channel(role: SidecarPeerRole) -> AuthenticatedSidecarChannel {
    AuthenticatedSidecarChannel::new(
        role,
        "process-session".into(),
        7,
        SidecarSessionKey::from_bytes(SESSION_KEY),
        FRAME_LIMIT,
    )
    .unwrap()
}

fn offer(role: SidecarPeerRole) -> SidecarProtocolOffer {
    SidecarProtocolOffer {
        protocol_major: SIDECAR_PROTOCOL_MAJOR,
        protocol_minor: SIDECAR_PROTOCOL_MINOR,
        peer: SidecarPeerIdentity {
            role,
            name: match role {
                SidecarPeerRole::Supervisor => "process-supervisor",
                SidecarPeerRole::Runtime => "process-runtime",
            }
            .into(),
            version: "test".into(),
            artifact_identity: "sha256:process-fixture".into(),
        },
        feature_bits: 0b0011,
        limits: SidecarLimits {
            max_frame_bytes: 2_048,
            max_in_flight: 8,
            bootstrap_timeout_ms: 1_000,
        },
    }
}
