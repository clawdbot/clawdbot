use crate::gateway_sleep::GatewaySleepCycleController;
use crate::gateway_ws::GatewayClient;
use futures_util::StreamExt;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zbus::zvariant::OwnedFd;

#[zbus::proxy(
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1",
    interface = "org.freedesktop.login1.Manager"
)]
trait Login1Manager {
    fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> zbus::Result<OwnedFd>;

    #[zbus(signal)]
    fn prepare_for_sleep(&self, sleeping: bool) -> zbus::Result<()>;
}

pub(crate) struct SleepBridge {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl SleepBridge {
    pub(crate) fn start(app: AppHandle) -> Self {
        let gateway = app.state::<GatewayClient>().inner().clone();
        let route_gateway = gateway.clone();
        let prepare_gateway = gateway.clone();
        let resume_gateway = gateway.clone();
        let refresh_gateway = gateway;
        let controller = Arc::new(GatewaySleepCycleController::new(
            format!("linux-sleep-{}", Uuid::new_v4()),
            move || route_gateway.loopback_route_token(),
            move |request_id| {
                let gateway = prepare_gateway.clone();
                async move { gateway.suspend_prepare(request_id).await }
            },
            move |suspension_id| {
                let gateway = resume_gateway.clone();
                async move {
                    gateway.suspend_resume(suspension_id).await?;
                    Ok(())
                }
            },
            move || {
                refresh_gateway.resume_reconnect();
                async {}
            },
            tokio::time::sleep,
            |message| eprintln!("Gateway sleep: {message}"),
        ));
        let task = tauri::async_runtime::spawn(async move {
            if let Err(error) = run_listener(controller).await {
                eprintln!("Gateway sleep listener unavailable: {error}");
            }
        });
        Self {
            task: Mutex::new(Some(task)),
        }
    }

    pub(crate) fn shutdown(&self) {
        if let Some(task) = self
            .task
            .lock()
            .expect("sleep bridge mutex poisoned")
            .take()
        {
            task.abort();
        }
    }
}

async fn run_listener(controller: Arc<GatewaySleepCycleController>) -> Result<(), String> {
    let connection = zbus::Connection::system()
        .await
        .map_err(|error| format!("could not connect to the system bus: {error}"))?;
    let proxy = Login1ManagerProxy::new(&connection)
        .await
        .map_err(|error| format!("could not connect to systemd-logind: {error}"))?;
    let mut signals = proxy
        .receive_prepare_for_sleep()
        .await
        .map_err(|error| format!("could not subscribe to PrepareForSleep: {error}"))?;
    let mut inhibitor = Some(acquire_inhibitor(&proxy).await?);

    while let Some(signal) = signals.next().await {
        let sleeping = signal
            .args()
            .map_err(|error| format!("invalid PrepareForSleep signal: {error}"))?
            .sleeping;
        if sleeping {
            controller.will_sleep().await;
            // Releasing the delay inhibitor lets logind continue into sleep.
            inhibitor.take();
        } else {
            let next_inhibitor = acquire_inhibitor(&proxy).await;
            let controller = Arc::clone(&controller);
            // Keep consuming signals so a new sleep cycle can abort wake retries.
            tauri::async_runtime::spawn(async move {
                controller.did_wake().await;
            });
            inhibitor = Some(next_inhibitor?);
        }
    }
    Err("PrepareForSleep signal stream ended".into())
}

async fn acquire_inhibitor(proxy: &Login1ManagerProxy<'_>) -> Result<OwnedFd, String> {
    proxy
        .inhibit("sleep", "OpenClaw", "Suspending local gateway", "delay")
        .await
        .map_err(|error| format!("could not acquire the logind sleep inhibitor: {error}"))
}
