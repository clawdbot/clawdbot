import { abortableSleep } from "./transport.js";

const REEF_RECONCILE_INTERVAL_MS = 30_000;
const CONTINUE_AFTER_RECONCILE_ERROR = () => true;
const STOP_AFTER_RECONCILE_ERROR = () => false;

async function runReconcileStep(params: {
  reconcile: () => Promise<void>;
  onReconcileError: (error: unknown) => void;
  shouldContinueAfterError: (error: unknown) => boolean;
  signal: AbortSignal;
}): Promise<void> {
  try {
    await params.reconcile();
  } catch (error) {
    if (params.signal.aborted) {
      return;
    }
    if (!params.shouldContinueAfterError(error)) {
      throw error;
    }
    params.onReconcileError(error);
  }
}

// One abort scope owns both account loops. If either branch throws, the inbox
// loop must be torn down and awaited before startAccount settles: a leaked
// loop keeps reconnecting as this handle, fights the replacement instance for
// the single relay inbox socket, and drives the relay into rate limiting.
export async function runReefChannelLifecycle(params: {
  parentSignal: AbortSignal;
  startInbox: (signal: AbortSignal) => Promise<void>;
  reconcile: () => Promise<void>;
  onReconcileError: (error: unknown) => void;
  // Startup may continue only for errors the channel classifies as retryable.
  // Periodic reconcile remains best-effort once the account is already active.
  shouldContinueAfterStartupReconcileError?: (error: unknown) => boolean;
  // Runs after the startup reconcile either refreshes peer keys or reports a
  // classified retryable failure, before the inbox can dispatch a turn.
  onReady?: () => Promise<void>;
  reconcileIntervalMs?: number;
}): Promise<void> {
  const lifecycle = new AbortController();
  const onParentAbort = () => lifecycle.abort();
  params.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  if (params.parentSignal.aborted) {
    // Listeners added after an abort never fire; inherit the abort directly.
    lifecycle.abort();
  }
  const intervalMs = params.reconcileIntervalMs ?? REEF_RECONCILE_INTERVAL_MS;
  const reconciliationLoop = async () => {
    while (!lifecycle.signal.aborted) {
      await abortableSleep(intervalMs, lifecycle.signal);
      if (lifecycle.signal.aborted) {
        return;
      }
      await runReconcileStep({
        ...params,
        shouldContinueAfterError: CONTINUE_AFTER_RECONCILE_ERROR,
        signal: lifecycle.signal,
      });
    }
  };
  // Declared outside the try so the finally can await it even when the startup
  // steps below throw before the inbox is started.
  let inboxTask: Promise<void> | undefined;
  try {
    if (!lifecycle.signal.aborted) {
      await runReconcileStep({
        ...params,
        shouldContinueAfterError:
          params.shouldContinueAfterStartupReconcileError ?? STOP_AFTER_RECONCILE_ERROR,
        signal: lifecycle.signal,
      });
    }
    if (lifecycle.signal.aborted) {
      return;
    }
    await params.onReady?.();
    if (lifecycle.signal.aborted) {
      return;
    }
    inboxTask = params.startInbox(lifecycle.signal);
    await Promise.all([inboxTask, reconciliationLoop()]);
  } finally {
    lifecycle.abort();
    params.parentSignal.removeEventListener("abort", onParentAbort);
    // startInbox resolves (never rejects) once its socket work is quiescent,
    // so no reconnect loop can outlive this account instance.
    await inboxTask;
  }
}
