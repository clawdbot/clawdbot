use std::sync::mpsc;
use std::thread;

pub(crate) struct OperationExecutor<T> {
    sender: mpsc::Sender<T>,
}

impl<T> Clone for OperationExecutor<T> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
        }
    }
}

impl<T: Send + 'static> OperationExecutor<T> {
    pub(crate) fn new<F>(name: &str, sink: F) -> Self
    where
        F: Fn(T) + Send + Sync + 'static,
    {
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                for operation in receiver {
                    sink(operation);
                }
            })
            .expect("operation executor worker should start");
        Self { sender }
    }

    pub(crate) fn submit(&self, operation: T) -> Result<(), mpsc::SendError<T>> {
        self.sender.send(operation)
    }
}

#[cfg(test)]
mod tests {
    use super::OperationExecutor;
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum TestOperation {
        Stop,
        Restart,
    }

    #[test]
    fn executes_contending_submissions_in_submission_order() {
        let contention = Arc::new(Barrier::new(2));
        let worker_contention = Arc::clone(&contention);
        let (observed_sender, observed_receiver) = mpsc::channel();
        let executor = OperationExecutor::new("ordered-operation-test", move |operation| {
            if operation == TestOperation::Stop {
                worker_contention.wait();
                thread::sleep(Duration::from_millis(100));
            }
            observed_sender.send(operation).expect("record operation");
        });

        let restart_executor = executor.clone();
        let restart_submitter = thread::spawn(move || {
            contention.wait();
            restart_executor
                .submit(TestOperation::Restart)
                .expect("submit restart");
        });
        let stop_executor = executor.clone();
        let stop_submitter = thread::spawn(move || {
            stop_executor
                .submit(TestOperation::Stop)
                .expect("submit stop");
        });

        stop_submitter.join().expect("stop submitter");
        restart_submitter.join().expect("restart submitter");
        let observed = (0..2)
            .map(|_| {
                observed_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("operation should execute")
            })
            .collect::<Vec<_>>();
        assert_eq!(observed, [TestOperation::Stop, TestOperation::Restart]);
    }

    #[test]
    fn executes_every_rapid_submission_in_order() {
        let (observed_sender, observed_receiver) = mpsc::channel();
        let executor = OperationExecutor::new("rapid-operation-test", move |operation| {
            observed_sender.send(operation).expect("record operation");
        });
        let expected = (0..256).collect::<Vec<_>>();

        for operation in expected.iter().copied() {
            executor.submit(operation).expect("submit operation");
        }

        let observed = (0..expected.len())
            .map(|_| {
                observed_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("operation should execute")
            })
            .collect::<Vec<_>>();
        assert_eq!(observed, expected);
    }
}
