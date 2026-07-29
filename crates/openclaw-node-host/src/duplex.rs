use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::{CancellationToken, ClientError, NodeInvocation, NodeSession};

pub(crate) const MAX_INPUT_FRAME_BYTES: usize = 16 * 1024;
pub(crate) const DEFAULT_PENDING_INPUT_BYTES: usize = 64 * 1024;
const PROGRESS_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct InvocationInputReceiver {
    inner: Arc<InputBuffer>,
}

impl InvocationInputReceiver {
    /// Receive the next ordered JSON input payload, or `None` after the invocation ends.
    pub async fn recv(&self) -> Option<String> {
        loop {
            let notified = self.inner.notify.notified();
            {
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(payload) = state.queue.pop_front() {
                    state.buffered_bytes = state.buffered_bytes.saturating_sub(payload.len());
                    return Some(payload);
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }
}

#[derive(Clone)]
pub(crate) struct InvocationProgress {
    inner: Arc<ProgressInner>,
}

impl std::fmt::Debug for InvocationProgress {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InvocationProgress")
            .field("invoke_id", &self.inner.invoke_id)
            .field("node_id", &self.inner.node_id)
            .finish_non_exhaustive()
    }
}

impl InvocationProgress {
    pub(crate) fn new(
        session: NodeSession,
        invocation: &NodeInvocation,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            inner: Arc::new(ProgressInner {
                session,
                invoke_id: invocation.id.clone(),
                node_id: invocation.node_id.clone(),
                cancellation,
                state: AsyncMutex::new(ProgressState { seq: 0 }),
                stopped: AtomicBool::new(false),
            }),
        }
    }

    /// Emit ordered UTF-8 output, splitting it at the Gateway's 16 KiB byte limit.
    ///
    /// # Errors
    ///
    /// Returns a request, transport, or closed-invocation error.
    pub async fn write(&self, text: &str) -> Result<(), ClientError> {
        if text.is_empty() {
            return Ok(());
        }
        let mut remaining = text;
        while !remaining.is_empty() {
            let split = utf8_prefix_len(remaining, PROGRESS_CHUNK_BYTES);
            let (chunk, rest) = remaining.split_at(split);
            self.send(chunk).await?;
            remaining = rest;
        }
        Ok(())
    }

    /// Emit an empty liveness frame without fabricating output.
    ///
    /// # Errors
    ///
    /// Returns a request, transport, or closed-invocation error.
    pub async fn heartbeat(&self) -> Result<(), ClientError> {
        self.send("").await
    }

    async fn send(&self, chunk: &str) -> Result<(), ClientError> {
        if self.inner.stopped.load(Ordering::Acquire) || self.inner.cancellation.is_cancelled() {
            return Err(ClientError::Closed("invocation is no longer active".into()));
        }
        let mut state = self.inner.state.lock().await;
        if self.inner.stopped.load(Ordering::Acquire) || self.inner.cancellation.is_cancelled() {
            return Err(ClientError::Closed("invocation is no longer active".into()));
        }
        self.inner
            .session
            .request(
                "node.invoke.progress",
                serde_json::json!({
                    "invokeId": self.inner.invoke_id,
                    "nodeId": self.inner.node_id,
                    "seq": state.seq,
                    "chunk": chunk,
                }),
            )
            .await?;
        state.seq += 1;
        Ok(())
    }

    pub(crate) fn stop(&self) {
        self.inner.stopped.store(true, Ordering::Release);
    }
}

struct ProgressInner {
    session: NodeSession,
    invoke_id: String,
    node_id: String,
    cancellation: CancellationToken,
    state: AsyncMutex<ProgressState>,
    stopped: AtomicBool,
}

struct ProgressState {
    seq: u64,
}

/// Transport-neutral duplex I/O for a long-lived node invocation.
#[derive(Clone, Debug)]
pub struct InvocationIo {
    input: InvocationInputReceiver,
    progress: InvocationProgress,
}

impl InvocationIo {
    pub(crate) fn new(input: InvocationInputReceiver, progress: InvocationProgress) -> Self {
        Self { input, progress }
    }

    /// Receive the next ordered `payloadJSON` frame.
    pub async fn recv(&self) -> Option<String> {
        self.input.recv().await
    }

    /// Emit ordered output for the caller.
    ///
    /// # Errors
    ///
    /// Returns a request, transport, or closed-invocation error.
    pub async fn emit_chunk(&self, chunk: &str) -> Result<(), ClientError> {
        self.progress.write(chunk).await
    }

    /// Keep an otherwise quiet duplex invocation alive.
    ///
    /// # Errors
    ///
    /// Returns a request, transport, or closed-invocation error.
    pub async fn heartbeat(&self) -> Result<(), ClientError> {
        self.progress.heartbeat().await
    }
}

#[derive(Debug)]
pub(crate) struct InputBuffer {
    state: Mutex<InputState>,
    notify: Notify,
    maximum_bytes: usize,
}

#[derive(Debug)]
struct InputState {
    next_seq: u64,
    queue: VecDeque<String>,
    buffered_bytes: usize,
    closed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InputDisposition {
    Accepted,
    Ignored,
    Overflow,
}

impl InputBuffer {
    pub(crate) fn new(maximum_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(InputState {
                next_seq: 0,
                queue: VecDeque::new(),
                buffered_bytes: 0,
                closed: false,
            }),
            notify: Notify::new(),
            maximum_bytes,
        })
    }

    pub(crate) fn receiver(self: &Arc<Self>) -> InvocationInputReceiver {
        InvocationInputReceiver {
            inner: self.clone(),
        }
    }

    pub(crate) fn push(&self, seq: u64, payload: String) -> InputDisposition {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed || seq < state.next_seq {
            return InputDisposition::Ignored;
        }
        state.next_seq = seq.saturating_add(1);
        let Some(buffered_bytes) = state.buffered_bytes.checked_add(payload.len()) else {
            self.close_locked(&mut state);
            return InputDisposition::Overflow;
        };
        if buffered_bytes > self.maximum_bytes {
            self.close_locked(&mut state);
            return InputDisposition::Overflow;
        }
        state.buffered_bytes = buffered_bytes;
        state.queue.push_back(payload);
        drop(state);
        self.notify.notify_one();
        InputDisposition::Accepted
    }

    pub(crate) fn close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.close_locked(&mut state);
    }

    fn close_locked(&self, state: &mut InputState) {
        state.closed = true;
        state.queue.clear();
        state.buffered_bytes = 0;
        self.notify.notify_waiters();
    }
}

fn utf8_prefix_len(value: &str, maximum: usize) -> usize {
    if value.len() <= maximum {
        return value.len();
    }
    let mut split = maximum;
    while !value.is_char_boundary(split) {
        split -= 1;
    }
    split
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn input_is_ordered_bounded_and_closes() {
        let input = InputBuffer::new(8);
        let receiver = input.receiver();
        assert_eq!(input.push(0, "one".into()), InputDisposition::Accepted);
        assert_eq!(input.push(0, "old".into()), InputDisposition::Ignored);
        assert_eq!(input.push(2, "two".into()), InputDisposition::Accepted);
        assert_eq!(receiver.recv().await.as_deref(), Some("one"));
        assert_eq!(receiver.recv().await.as_deref(), Some("two"));
        assert_eq!(
            input.push(3, "too-large".into()),
            InputDisposition::Overflow
        );
        assert_eq!(receiver.recv().await, None);
    }

    #[test]
    fn utf8_chunks_end_at_character_boundaries() {
        let value = format!("{}é", "a".repeat(PROGRESS_CHUNK_BYTES - 1));
        assert_eq!(
            utf8_prefix_len(&value, PROGRESS_CHUNK_BYTES),
            PROGRESS_CHUNK_BYTES - 1
        );
    }
}
