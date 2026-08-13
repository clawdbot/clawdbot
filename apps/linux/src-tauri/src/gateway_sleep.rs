use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const RESUME_ATTEMPTS: usize = 3;
const RESUME_RETRY_DELAY: Duration = Duration::from_secs(2);

type PrepareFuture = Pin<Box<dyn Future<Output = Result<SleepPrepareOutcome, String>> + Send>>;
type ResumeFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
type RefreshFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type DelayFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SleepPrepareOutcome {
    Ready { suspension_id: String },
    Busy,
}

struct HeldSuspension {
    id: String,
    route: String,
}

#[derive(Default)]
struct CycleState {
    suspension: Option<HeldSuspension>,
    generation: u64,
}

pub(crate) struct GatewaySleepCycleController {
    request_id: String,
    current_route: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    prepare: Arc<dyn Fn(String) -> PrepareFuture + Send + Sync>,
    resume: Arc<dyn Fn(String) -> ResumeFuture + Send + Sync>,
    refresh: Arc<dyn Fn() -> RefreshFuture + Send + Sync>,
    retry_delay: Arc<dyn Fn(Duration) -> DelayFuture + Send + Sync>,
    log: Arc<dyn Fn(String) + Send + Sync>,
    state: Mutex<CycleState>,
}

impl GatewaySleepCycleController {
    pub(crate) fn new<P, PF, R, RF, F, FF, C, D, DF, L>(
        request_id: String,
        current_route: C,
        prepare: P,
        resume: R,
        refresh: F,
        retry_delay: D,
        log: L,
    ) -> Self
    where
        P: Fn(String) -> PF + Send + Sync + 'static,
        PF: Future<Output = Result<SleepPrepareOutcome, String>> + Send + 'static,
        R: Fn(String) -> RF + Send + Sync + 'static,
        RF: Future<Output = Result<(), String>> + Send + 'static,
        F: Fn() -> FF + Send + Sync + 'static,
        FF: Future<Output = ()> + Send + 'static,
        C: Fn() -> Option<String> + Send + Sync + 'static,
        D: Fn(Duration) -> DF + Send + Sync + 'static,
        DF: Future<Output = ()> + Send + 'static,
        L: Fn(String) + Send + Sync + 'static,
    {
        Self {
            request_id,
            current_route: Arc::new(current_route),
            prepare: Arc::new(move |request_id| Box::pin(prepare(request_id))),
            resume: Arc::new(move |suspension_id| Box::pin(resume(suspension_id))),
            refresh: Arc::new(move || Box::pin(refresh())),
            retry_delay: Arc::new(move |delay| Box::pin(retry_delay(delay))),
            log: Arc::new(log),
            state: Mutex::new(CycleState::default()),
        }
    }

    pub(crate) async fn will_sleep(&self) {
        // The production route closure exposes only configured loopback gateways.
        let Some(route) = (self.current_route)() else {
            return;
        };
        let generation = {
            let mut state = self
                .state
                .lock()
                .expect("gateway sleep state mutex poisoned");
            state.generation = state.generation.wrapping_add(1);
            state.generation
        };
        match (self.prepare)(self.request_id.clone()).await {
            Ok(SleepPrepareOutcome::Ready { suspension_id }) => {
                let late = {
                    let mut state = self
                        .state
                        .lock()
                        .expect("gateway sleep state mutex poisoned");
                    if generation == state.generation {
                        state.suspension = Some(HeldSuspension {
                            id: suspension_id.clone(),
                            route,
                        });
                        false
                    } else {
                        true
                    }
                };
                if late {
                    // Wake or a newer cycle won the race; do not leave the late lease active.
                    if let Err(error) = (self.resume)(suspension_id).await {
                        (self.log)(format!("gateway sleep preparation failed: {error}"));
                    }
                }
            }
            Ok(SleepPrepareOutcome::Busy) => {
                (self.log)("gateway sleep preparation skipped because the gateway is busy".into());
            }
            Err(error) => {
                (self.log)(format!("gateway sleep preparation failed: {error}"));
            }
        }
    }

    pub(crate) async fn did_wake(&self) {
        // Clear first so a second wake or failed resume cannot reuse this cycle's lease.
        let (suspension, generation) = {
            let mut state = self
                .state
                .lock()
                .expect("gateway sleep state mutex poisoned");
            let suspension = state.suspension.take();
            state.generation = state.generation.wrapping_add(1);
            (suspension, state.generation)
        };
        if (self.current_route)().is_none() {
            if suspension.is_some() {
                (self.log)(
                    "dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire"
                        .into(),
                );
            }
            return;
        }

        // The pre-sleep transport is normally dead; reconnect before attempting resume.
        (self.refresh)().await;
        if let Some(suspension) = suspension {
            if (self.current_route)().as_ref() == Some(&suspension.route) {
                self.resume_with_retries(suspension.id, generation).await;
            } else {
                (self.log)(
                    "dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire"
                        .into(),
                );
            }
        }
    }

    async fn resume_with_retries(&self, suspension_id: String, generation: u64) {
        for attempt in 1..=RESUME_ATTEMPTS {
            // A new sleep cycle owns the connection; abandoned leases self-expire.
            if generation
                != self
                    .state
                    .lock()
                    .expect("gateway sleep state mutex poisoned")
                    .generation
            {
                return;
            }
            match (self.resume)(suspension_id.clone()).await {
                Ok(()) => return,
                Err(error) => {
                    (self.log)(format!(
                        "gateway wake resume attempt {attempt} failed: {error}"
                    ));
                    if attempt < RESUME_ATTEMPTS {
                        (self.retry_delay)(RESUME_RETRY_DELAY).await;
                    }
                }
            }
        }
        (self.log)("giving up on gateway wake resume; lease will self-expire".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::oneshot;

    fn route_state(value: Option<&str>) -> Arc<Mutex<Option<String>>> {
        Arc::new(Mutex::new(value.map(str::to_string)))
    }

    fn current_route(
        route: &Arc<Mutex<Option<String>>>,
    ) -> impl Fn() -> Option<String> + Send + Sync + 'static {
        let route = Arc::clone(route);
        move || route.lock().expect("route mutex poisoned").clone()
    }

    fn no_delay(_: Duration) -> impl Future<Output = ()> + Send {
        std::future::ready(())
    }

    #[tokio::test]
    async fn ready_preparation_resumes_once_after_refresh() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let events = Arc::new(Mutex::new(Vec::new()));
        let prepare_events = Arc::clone(&events);
        let resume_events = Arc::clone(&events);
        let refresh_events = Arc::clone(&events);
        let request_ids = Arc::new(Mutex::new(Vec::new()));
        let prepared_ids = Arc::clone(&request_ids);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            move |request_id| {
                prepared_ids.lock().unwrap().push(request_id);
                prepare_events.lock().unwrap().push("prepare");
                async {
                    Ok(SleepPrepareOutcome::Ready {
                        suspension_id: "suspension-1".into(),
                    })
                }
            },
            move |_| {
                resume_events.lock().unwrap().push("resume");
                async { Ok(()) }
            },
            move || {
                refresh_events.lock().unwrap().push("refresh");
                async {}
            },
            no_delay,
            |_| {},
        );

        controller.will_sleep().await;
        controller.did_wake().await;
        controller.did_wake().await;

        assert_eq!(*request_ids.lock().unwrap(), ["linux-sleep-test-run"]);
        assert_eq!(
            *events.lock().unwrap(),
            ["prepare", "refresh", "resume", "refresh"]
        );
    }

    #[tokio::test]
    async fn busy_preparation_does_not_resume() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let resumes = Arc::new(AtomicUsize::new(0));
        let resumed = Arc::clone(&resumes);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshed = Arc::clone(&refreshes);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_| async { Ok(SleepPrepareOutcome::Busy) },
            move |_| {
                resumed.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                refreshed.fetch_add(1, Ordering::SeqCst);
                async {}
            },
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        controller.did_wake().await;

        assert_eq!(resumes.load(Ordering::SeqCst), 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(
            *logs.lock().unwrap(),
            ["gateway sleep preparation skipped because the gateway is busy"]
        );
    }

    #[tokio::test]
    async fn failed_preparation_does_not_resume() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let resumes = Arc::new(AtomicUsize::new(0));
        let resumed = Arc::clone(&resumes);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshed = Arc::clone(&refreshes);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_| async { Err("prepare failed".into()) },
            move |_| {
                resumed.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                refreshed.fetch_add(1, Ordering::SeqCst);
                async {}
            },
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        controller.did_wake().await;

        assert_eq!(resumes.load(Ordering::SeqCst), 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(
            *logs.lock().unwrap(),
            ["gateway sleep preparation failed: prepare failed"]
        );
    }

    #[tokio::test]
    async fn changed_route_drops_the_suspension() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let resumes = Arc::new(AtomicUsize::new(0));
        let resumed = Arc::clone(&resumes);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshed = Arc::clone(&refreshes);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-1".into(),
                })
            },
            move |_| {
                resumed.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                refreshed.fetch_add(1, Ordering::SeqCst);
                async {}
            },
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        *route.lock().unwrap() = Some("ws://127.0.0.1:19001".into());
        controller.did_wake().await;

        assert_eq!(resumes.load(Ordering::SeqCst), 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(
            *logs.lock().unwrap(),
            ["dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire"]
        );
    }

    #[tokio::test]
    async fn missing_or_remote_route_drops_a_held_suspension() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let resumes = Arc::new(AtomicUsize::new(0));
        let resumed = Arc::clone(&resumes);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshed = Arc::clone(&refreshes);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-1".into(),
                })
            },
            move |_| {
                resumed.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                refreshed.fetch_add(1, Ordering::SeqCst);
                async {}
            },
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        *route.lock().unwrap() = None;
        controller.did_wake().await;
        *route.lock().unwrap() = Some("ws://127.0.0.1:18789".into());
        controller.did_wake().await;

        assert_eq!(resumes.load(Ordering::SeqCst), 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(logs.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn late_prepare_response_resumes_immediately() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let (release, receiver) = oneshot::channel();
        let (started, prepare_started) = oneshot::channel();
        let receiver = Arc::new(Mutex::new(Some(receiver)));
        let prepare_receiver = Arc::clone(&receiver);
        let started = Arc::new(Mutex::new(Some(started)));
        let prepare_started_sender = Arc::clone(&started);
        let resumed_ids = Arc::new(Mutex::new(Vec::new()));
        let resumed = Arc::clone(&resumed_ids);
        let controller = Arc::new(GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            move |_| {
                let receiver = prepare_receiver.lock().unwrap().take().unwrap();
                prepare_started_sender
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap()
                    .send(())
                    .unwrap();
                async move {
                    let _ = receiver.await;
                    Ok(SleepPrepareOutcome::Ready {
                        suspension_id: "late-suspension".into(),
                    })
                }
            },
            move |id| {
                resumed.lock().unwrap().push(id);
                async { Ok(()) }
            },
            || async {},
            no_delay,
            |_| {},
        ));

        let sleeping = {
            let controller = Arc::clone(&controller);
            tokio::spawn(async move { controller.will_sleep().await })
        };
        prepare_started.await.unwrap();
        controller.did_wake().await;
        release.send(()).unwrap();
        sleeping.await.unwrap();
        controller.did_wake().await;

        assert_eq!(*resumed_ids.lock().unwrap(), ["late-suspension"]);
    }

    #[tokio::test]
    async fn resume_retries_then_succeeds() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempted = Arc::clone(&attempts);
        let delays = Arc::new(AtomicUsize::new(0));
        let delayed = Arc::clone(&delays);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-retry".into(),
                })
            },
            move |_| {
                let attempt = attempted.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err("transport failed".into())
                    } else {
                        Ok(())
                    }
                }
            },
            || async {},
            move |_| {
                delayed.fetch_add(1, Ordering::SeqCst);
                async {}
            },
            |_| {},
        );

        controller.will_sleep().await;
        controller.did_wake().await;

        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(delays.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn resume_exhausts_three_attempts() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempted = Arc::clone(&attempts);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-exhaust".into(),
                })
            },
            move |_| {
                attempted.fetch_add(1, Ordering::SeqCst);
                async { Err("transport failed".into()) }
            },
            || async {},
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        controller.did_wake().await;

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|log| log.contains("giving up")));
    }

    #[tokio::test]
    async fn new_sleep_cycle_aborts_in_flight_retries() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempted = Arc::clone(&attempts);
        let controller_slot = Arc::new(Mutex::new(None::<Arc<GatewaySleepCycleController>>));
        let delay_slot = Arc::clone(&controller_slot);
        let controller = Arc::new(GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-abort".into(),
                })
            },
            move |_| {
                attempted.fetch_add(1, Ordering::SeqCst);
                async { Err("transport failed".into()) }
            },
            || async {},
            move |_| {
                let controller = delay_slot.lock().unwrap().as_ref().unwrap().clone();
                async move { controller.will_sleep().await }
            },
            |_| {},
        ));
        *controller_slot.lock().unwrap() = Some(Arc::clone(&controller));

        controller.will_sleep().await;
        controller.did_wake().await;

        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn wake_always_clears_the_held_lease() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempted = Arc::clone(&attempts);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-failure".into(),
                })
            },
            move |_| {
                attempted.fetch_add(1, Ordering::SeqCst);
                async { Err("transport failed".into()) }
            },
            || async {},
            no_delay,
            |_| {},
        );

        controller.will_sleep().await;
        controller.did_wake().await;
        controller.did_wake().await;

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }
}
