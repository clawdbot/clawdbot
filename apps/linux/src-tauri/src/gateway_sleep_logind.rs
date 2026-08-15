use crate::gateway_sleep::GatewaySleepCycleController;
use crate::gateway_sleep_logind_listener::{run_listener, BeginSleepCycleHook, EndSleepCycleHook};
use crate::gateway_ws::GatewayClient;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub(crate) struct SleepBridge {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl SleepBridge {
    pub(crate) fn start(app: AppHandle) -> Self {
        let gateway = app.state::<GatewayClient>().inner().clone();
        // The driver task stays parked outside Quick Chat or a sleep cycle, so starting it here
        // does not widen the companion's normal Gateway connection lifetime.
        gateway.activate(app.clone());
        let route_gateway = gateway.clone();
        let prepare_gateway = gateway.clone();
        let resume_gateway = gateway.clone();
        let refresh_gateway = gateway.clone();
        let begin_gateway = gateway.clone();
        let end_gateway = gateway;
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
        let begin_sleep_cycle: BeginSleepCycleHook = Arc::new(move || {
            // A remote or unconfigured route must not activate the driver.
            if begin_gateway.loopback_route_token().is_none() {
                return false;
            }
            begin_gateway.begin_sleep_cycle();
            true
        });
        let end_sleep_cycle: EndSleepCycleHook = Arc::new(move || end_gateway.end_sleep_cycle());
        let task = tauri::async_runtime::spawn(async move {
            if let Err(error) = run_listener(controller, begin_sleep_cycle, end_sleep_cycle).await {
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
