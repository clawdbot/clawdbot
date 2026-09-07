use crate::gateway::{GatewayAction, GatewaySnapshot};
use crate::installer::InstallChannel;
use crate::remote_gateway::RemoteGatewayRequest;
use std::sync::mpsc;
use std::thread;
use tokio::sync::oneshot;

pub(crate) enum GatewayOperation {
    Connect,
    ConnectExplicitLocal,
    ConnectRemote(RemoteGatewayRequest),
    Install(InstallChannel),
    Action(GatewayAction),
}

struct QueuedGatewayOperation {
    operation: GatewayOperation,
    reply: Option<oneshot::Sender<Result<GatewaySnapshot, String>>>,
}

pub(crate) struct GatewayOperationQueue {
    sender: mpsc::Sender<QueuedGatewayOperation>,
}

impl GatewayOperationQueue {
    pub(crate) fn new<F, E>(sink: F, show_error: E) -> Self
    where
        F: Fn(GatewayOperation) -> Result<GatewaySnapshot, String> + Send + Sync + 'static,
        E: Fn(&str) + Send + Sync + 'static,
    {
        let (sender, receiver) = mpsc::channel::<QueuedGatewayOperation>();
        thread::Builder::new()
            .name("openclaw-gateway-operations".to_string())
            .spawn(move || {
                for request in receiver {
                    let result = sink(request.operation);
                    if let Some(reply) = request.reply {
                        let _ = reply.send(result);
                    } else if let Err(error) = result {
                        show_error(&error);
                    }
                }
            })
            .expect("gateway operation worker should start");
        Self { sender }
    }

    pub(crate) fn submit_connect(&self) {
        self.submit_detached(GatewayOperation::ConnectExplicitLocal);
    }

    pub(crate) fn submit_action(&self, action: GatewayAction) {
        self.submit_detached(GatewayOperation::Action(action));
    }

    pub(crate) async fn execute(
        &self,
        operation: GatewayOperation,
    ) -> Result<GatewaySnapshot, String> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .send(QueuedGatewayOperation {
                operation,
                reply: Some(reply),
            })
            .map_err(|_| "Gateway operation queue is unavailable.".to_string())?;
        receiver
            .await
            .map_err(|_| "Gateway operation worker stopped unexpectedly.".to_string())?
    }

    fn submit_detached(&self, operation: GatewayOperation) {
        let _ = self.sender.send(QueuedGatewayOperation {
            operation,
            reply: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{GatewayOperation, GatewayOperationQueue};
    use crate::gateway::GatewayAction;
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    #[derive(Debug, Eq, PartialEq)]
    enum ObservedOperation {
        Stop,
        Connect,
    }

    #[test]
    fn executes_every_rapid_submission_in_order() {
        let (sender, receiver) = mpsc::channel();
        let queue = GatewayOperationQueue::new(
            move |operation| {
                let observed = match operation {
                    GatewayOperation::ConnectExplicitLocal => 0,
                    GatewayOperation::Action(GatewayAction::Stop) => 1,
                    _ => panic!("unexpected operation"),
                };
                sender.send(observed).expect("record operation");
                Err("test operation".to_string())
            },
            |_| {},
        );
        let expected = (0..256).map(|index| index % 2).collect::<Vec<_>>();
        for operation in &expected {
            if *operation == 0 {
                queue.submit_connect();
            } else {
                queue.submit_action(GatewayAction::Stop);
            }
        }
        let observed = (0..expected.len())
            .map(|_| {
                receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("operation should execute")
            })
            .collect::<Vec<_>>();
        assert_eq!(observed, expected);
    }

    #[test]
    fn orders_non_tray_connect_after_gateway_action() {
        let contention = Arc::new(Barrier::new(2));
        let worker_contention = Arc::clone(&contention);
        let (observed_sender, observed_receiver) = mpsc::channel();
        let queue = Arc::new(GatewayOperationQueue::new(
            move |operation| {
                let observed = match operation {
                    GatewayOperation::Action(GatewayAction::Stop) => {
                        worker_contention.wait();
                        thread::sleep(Duration::from_millis(100));
                        ObservedOperation::Stop
                    }
                    GatewayOperation::ConnectExplicitLocal => ObservedOperation::Connect,
                    _ => panic!("unexpected operation"),
                };
                observed_sender.send(observed).expect("record operation");
                Err("test operation".to_string())
            },
            |_| {},
        ));

        let connect_queue = Arc::clone(&queue);
        let connect_submitter = thread::spawn(move || {
            contention.wait();
            connect_queue.submit_connect();
        });
        let action_queue = Arc::clone(&queue);
        let action_submitter = thread::spawn(move || {
            action_queue.submit_action(GatewayAction::Stop);
        });

        action_submitter.join().expect("action submitter");
        connect_submitter.join().expect("connect submitter");
        let observed = (0..2)
            .map(|_| {
                observed_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("operation should execute")
            })
            .collect::<Vec<_>>();
        assert_eq!(
            observed,
            [ObservedOperation::Stop, ObservedOperation::Connect]
        );
    }
}
