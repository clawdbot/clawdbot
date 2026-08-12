use crate::gateway_sleep::GatewaySleepCycleController;
use futures_util::StreamExt;
use std::sync::Arc;
use zbus::zvariant::OwnedFd;

pub(crate) type SleepCycleHook = Arc<dyn Fn() + Send + Sync>;

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

pub(crate) async fn run_listener(
    controller: Arc<GatewaySleepCycleController>,
    begin_sleep_cycle: SleepCycleHook,
    end_sleep_cycle: SleepCycleHook,
) -> Result<(), String> {
    let connection = zbus::Connection::system()
        .await
        .map_err(|error| format!("could not connect to the system bus: {error}"))?;
    run_listener_on_connection(&connection, controller, begin_sleep_cycle, end_sleep_cycle).await
}

async fn run_listener_on_connection(
    connection: &zbus::Connection,
    controller: Arc<GatewaySleepCycleController>,
    begin_sleep_cycle: SleepCycleHook,
    end_sleep_cycle: SleepCycleHook,
) -> Result<(), String> {
    let proxy = Login1ManagerProxy::new(connection)
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
            begin_sleep_cycle();
            controller.will_sleep().await;
            // Releasing the delay inhibitor lets logind continue into sleep.
            inhibitor.take();
        } else {
            let next_inhibitor = acquire_inhibitor(&proxy).await;
            let controller = Arc::clone(&controller);
            let end_sleep_cycle = Arc::clone(&end_sleep_cycle);
            // Keep consuming signals so a new sleep cycle can abort wake retries.
            tauri::async_runtime::spawn(async move {
                controller.did_wake().await;
                end_sleep_cycle();
            });
            // A failed re-acquire only loses the pre-sleep delay window; keep the
            // listener alive so later sleep/wake cycles are still handled.
            inhibitor = match next_inhibitor {
                Ok(fd) => Some(fd),
                Err(error) => {
                    eprintln!("Gateway sleep: {error}");
                    None
                }
            };
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
