// Matrix plugin module implements task runner behavior.
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

const monitorTaskSignal = new AsyncLocalStorage<AbortSignal>();
const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

export function getMatrixMonitorTaskSignal(): AbortSignal | undefined {
  return monitorTaskSignal.getStore();
}

function createIdleTimeoutPromise(timeoutMs: number): {
  promise: Promise<"timeout">;
  clear: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
    timeoutId.unref?.();
  });
  return {
    promise,
    clear: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  };
}

export function createMatrixMonitorTaskRunner(params: {
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
}) {
  const inFlight = new Map<Promise<void>, AbortController>();
  let closed = false;

  const runDetachedTask = (label: string, task: () => Promise<void>): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    const controller = new AbortController();
    const trackedTask: Promise<void> = monitorTaskSignal
      .run(controller.signal, () => Promise.resolve().then(task))
      .catch((error: unknown) => {
        const message = String(error);
        params.logVerboseMessage(`matrix: ${label} failed (${message})`);
        params.logger.warn("matrix background task failed", {
          task: label,
          error: message,
        });
      })
      .finally(() => {
        // Async descendants retain the signal, but cannot acquire after their owner settles.
        controller.abort();
        inFlight.delete(trackedTask);
      });
    inFlight.set(trackedTask, controller);
    return trackedTask;
  };

  const waitForIdle = async (): Promise<void> => {
    // Must not block gateway stop on a hung homeserver join or inbound turn.
    // Idle window, not wall-clock: keep waiting while tasks settle; return if none complete.
    while (inFlight.size > 0) {
      const snapshot = Array.from(inFlight.keys());
      const timeout = createIdleTimeoutPromise(DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);
      const outcome = await Promise.race<"timeout" | "settled">([
        timeout.promise,
        ...snapshot.map((task) =>
          task.then(
            () => "settled" as const,
            () => "settled" as const,
          ),
        ),
      ]);
      timeout.clear();
      if (outcome === "timeout") {
        const remaining = inFlight.size;
        params.logVerboseMessage(
          `matrix: waitForIdle made no progress within ${DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS}ms; continuing retirement with ${remaining} task(s) still in flight`,
        );
        params.logger.warn("matrix waitForIdle timed out", {
          idleTimeoutMs: DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
          remaining,
        });
        return;
      }
    }
  };

  return {
    close: () => {
      closed = true;
      for (const controller of inFlight.values()) {
        controller.abort();
      }
    },
    runDetachedTask,
    waitForIdle,
  };
}
