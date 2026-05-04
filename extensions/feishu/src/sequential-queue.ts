/**
 * Per-key serial task queue for Feishu inbound message handling.
 *
 * Tasks enqueued under the same key run in FIFO order. Different keys run
 * concurrently. This preserves the channel's same-chat ordering contract
 * (see #64324) while letting cross-chat work proceed in parallel.
 *
 * `taskTimeoutMs` bounds how long the queue will block subsequent same-key
 * tasks behind a single in-flight task. After the cap, the in-flight task
 * is evicted from the blocking chain so newer messages for the same key
 * can proceed. The original task is NOT aborted — it continues running in
 * the background; it just stops starving the queue.
 *
 * Without this cap, a single hung dispatch (e.g. an agent call that never
 * resolves) keeps later same-chat messages in `queued` state until the
 * gateway is restarted. See #70133.
 */

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

export interface SequentialQueueOptions {
  /**
   * Maximum time (ms) to block subsequent same-key tasks behind a single
   * in-flight task. Pass 0 (or a non-finite value) to disable the cap and
   * restore unbounded legacy behavior.
   *
   * Default: 5 minutes.
   */
  taskTimeoutMs?: number;

  /**
   * Optional callback fired when a task exceeds `taskTimeoutMs`. The task
   * itself is not awaited further; this callback is the only signal the
   * caller gets that the queue moved on without it.
   */
  onTaskTimeout?: (key: string, timeoutMs: number) => void;
}

export function createSequentialQueue(options: SequentialQueueOptions = {}) {
  const queues = new Map<string, Promise<void>>();
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const onTaskTimeout = options.onTaskTimeout;

  return (key: string, task: () => Promise<void>): Promise<void> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const wrapped = () => boundedRun(key, task, taskTimeoutMs, onTaskTimeout);
    const next = previous.then(wrapped, wrapped);
    queues.set(key, next);
    const cleanup = () => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  };
}

async function boundedRun(
  key: string,
  task: () => Promise<void>,
  timeoutMs: number,
  onTaskTimeout: ((key: string, timeoutMs: number) => void) | undefined,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return task();
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      try {
        onTaskTimeout?.(key, timeoutMs);
      } catch {
        // Swallow logging errors so they cannot poison the queue chain.
      }
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([task(), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
