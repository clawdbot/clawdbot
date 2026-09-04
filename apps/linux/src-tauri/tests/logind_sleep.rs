#![cfg(target_os = "linux")]

#[path = "../src/gateway_sleep.rs"]
mod gateway_sleep;
#[path = "../src/gateway_sleep_logind_listener.rs"]
mod gateway_sleep_logind_listener;

use gateway_sleep::{GatewaySleepCycleController, SleepPrepareOutcome};
use gateway_sleep_logind_listener::{run_listener, BeginSleepCycleHook, EndSleepCycleHook};
use std::io::{BufRead, BufReader, Read};
use std::os::fd::OwnedFd as StdOwnedFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use uuid::Uuid;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::OwnedFd;

const LOGIN1_PATH: &str = "/org/freedesktop/login1";

#[derive(Debug, Eq, PartialEq)]
enum MockEvent {
    InhibitorAcquired(usize),
    InhibitorReleased(usize),
    DriverActivated,
    Prepare,
    Refresh,
    Resume,
    DriverDeactivated,
}

struct MockLogin1 {
    events: mpsc::UnboundedSender<MockEvent>,
    next_inhibitor: std::sync::atomic::AtomicUsize,
}

#[zbus::interface(name = "org.freedesktop.login1.Manager")]
impl MockLogin1 {
    fn inhibit(
        &self,
        _what: &str,
        _who: &str,
        _why: &str,
        _mode: &str,
    ) -> zbus::fdo::Result<OwnedFd> {
        let id = self
            .next_inhibitor
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let (mut release_reader, inhibitor) =
            UnixStream::pair().map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?;
        let events = self.events.clone();
        std::thread::spawn(move || {
            let mut byte = [0_u8; 1];
            loop {
                match release_reader.read(&mut byte) {
                    Ok(0) => {
                        let _ = events.send(MockEvent::InhibitorReleased(id));
                        return;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("mock inhibitor {id} release probe failed: {error}");
                        return;
                    }
                }
            }
        });
        let _ = self.events.send(MockEvent::InhibitorAcquired(id));
        let inhibitor: StdOwnedFd = inhibitor.into();
        Ok(inhibitor.into())
    }

    #[zbus(signal)]
    async fn prepare_for_sleep(emitter: &SignalEmitter<'_>, sleeping: bool) -> zbus::Result<()>;
}

struct DbusDaemon {
    child: Child,
    directory: PathBuf,
}

impl Drop for DbusDaemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn spawn_dbus_daemon() -> Option<(DbusDaemon, String)> {
    if !Command::new("dbus-daemon")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
    {
        eprintln!("SKIP logind_sleep: dbus-daemon is unavailable (install the dbus package)");
        return None;
    }
    let directory = std::env::temp_dir().join(format!("openclaw-logind-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("create private D-Bus directory");
    let address = format!("unix:path={}", directory.join("bus.sock").display());
    let mut child = Command::new("dbus-daemon")
        .args([
            "--session",
            "--nofork",
            "--nopidfile",
            "--print-address=1",
            &format!("--address={address}"),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start private dbus-daemon");
    let mut announced_address = String::new();
    BufReader::new(child.stdout.take().expect("dbus-daemon stdout"))
        .read_line(&mut announced_address)
        .expect("read private D-Bus address");
    if announced_address.trim().is_empty() {
        let mut error = String::new();
        if let Some(stderr) = child.stderr.take() {
            BufReader::new(stderr)
                .read_to_string(&mut error)
                .expect("read dbus-daemon failure");
        }
        panic!("private dbus-daemon did not announce an address: {error}");
    }
    Some((
        DbusDaemon { child, directory },
        announced_address.trim().to_string(),
    ))
}

struct SystemBusAddress(Option<String>);

impl SystemBusAddress {
    fn set(address: &str) -> Self {
        let previous = std::env::var("DBUS_SYSTEM_BUS_ADDRESS").ok();
        std::env::set_var("DBUS_SYSTEM_BUS_ADDRESS", address);
        Self(previous)
    }
}

impl Drop for SystemBusAddress {
    fn drop(&mut self) {
        if let Some(previous) = self.0.as_deref() {
            std::env::set_var("DBUS_SYSTEM_BUS_ADDRESS", previous);
        } else {
            std::env::remove_var("DBUS_SYSTEM_BUS_ADDRESS");
        }
    }
}

async fn next_event(events: &mut mpsc::UnboundedReceiver<MockEvent>) -> MockEvent {
    tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .expect("timed out waiting for mock logind event")
        .expect("mock logind event channel closed")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires Linux and dbus-daemon; run with cargo test -- --ignored logind"]
async fn logind_full_sleep_cycle_releases_and_reacquires_inhibitor() {
    let Some((_daemon, address)) = spawn_dbus_daemon() else {
        return;
    };
    let _system_bus = SystemBusAddress::set(&address);
    let (event_tx, mut events) = mpsc::unbounded_channel();
    let service = zbus::connection::Builder::address(address.as_str())
        .expect("private D-Bus address")
        .name("org.freedesktop.login1")
        .expect("request mock login1 name")
        .serve_at(
            LOGIN1_PATH,
            MockLogin1 {
                events: event_tx.clone(),
                next_inhibitor: std::sync::atomic::AtomicUsize::new(0),
            },
        )
        .expect("register mock login1 manager")
        .build()
        .await
        .expect("connect mock login1 service");

    let prepare_events = event_tx.clone();
    let refresh_events = event_tx.clone();
    let resume_events = event_tx.clone();
    let controller = Arc::new(GatewaySleepCycleController::new(
        "logind-proof".into(),
        || Some("ws://127.0.0.1:18789".into()),
        move |_| {
            let events = prepare_events.clone();
            async move {
                let _ = events.send(MockEvent::Prepare);
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "mock-suspension".into(),
                })
            }
        },
        move |_| {
            let events = resume_events.clone();
            async move {
                let _ = events.send(MockEvent::Resume);
                Ok(())
            }
        },
        move || {
            let events = refresh_events.clone();
            async move {
                let _ = events.send(MockEvent::Refresh);
            }
        },
        |_| std::future::ready(()),
        |message| eprintln!("mock Gateway sleep: {message}"),
    ));
    let begin_events = event_tx.clone();
    let begin_sleep_cycle: BeginSleepCycleHook = Arc::new(move || {
        let _ = begin_events.send(MockEvent::DriverActivated);
        true
    });
    let end_events = event_tx;
    let end_sleep_cycle: EndSleepCycleHook = Arc::new(move || {
        let _ = end_events.send(MockEvent::DriverDeactivated);
    });
    let listener = tokio::spawn(run_listener(controller, begin_sleep_cycle, end_sleep_cycle));

    assert_eq!(
        next_event(&mut events).await,
        MockEvent::InhibitorAcquired(1)
    );
    let interface = service
        .object_server()
        .interface::<_, MockLogin1>(LOGIN1_PATH)
        .await
        .expect("mock login1 interface");
    MockLogin1::prepare_for_sleep(interface.signal_emitter(), true)
        .await
        .expect("emit sleep signal");
    assert_eq!(next_event(&mut events).await, MockEvent::DriverActivated);
    assert_eq!(next_event(&mut events).await, MockEvent::Prepare);
    assert_eq!(
        next_event(&mut events).await,
        MockEvent::InhibitorReleased(1)
    );

    MockLogin1::prepare_for_sleep(interface.signal_emitter(), false)
        .await
        .expect("emit wake signal");
    // Wake recovery is spawned before the inhibitor re-acquire so a slow logind
    // cannot delay reconnect/resume; only the relative order of the recovery
    // chain is guaranteed.
    let mut wake_events = Vec::new();
    for _ in 0..4 {
        wake_events.push(next_event(&mut events).await);
    }
    assert!(wake_events.contains(&MockEvent::InhibitorAcquired(2)));
    let recovery: Vec<_> = wake_events
        .into_iter()
        .filter(|event| *event != MockEvent::InhibitorAcquired(2))
        .collect();
    assert_eq!(
        recovery,
        vec![
            MockEvent::Refresh,
            MockEvent::Resume,
            MockEvent::DriverDeactivated
        ]
    );

    listener.abort();
}
