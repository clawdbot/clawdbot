// Matrix plugin module implements task runner behavior.
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

const monitorTaskSignal = new AsyncLocalStorage<AbortSignal>();

export function getMatrixMonitorTaskSignal(): AbortSignal | undefined {
  return monitorTaskSignal.getStore();
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
    while (inFlight.size > 0) {
      await Promise.allSettled(Array.from(inFlight.keys()));
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
