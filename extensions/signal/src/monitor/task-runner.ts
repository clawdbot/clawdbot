// Signal plugin module implements monitor task runner behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

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

export function createSignalMonitorTaskRunner(runtime: RuntimeEnv) {
  const inFlight = new Set<Promise<void>>();
  return {
    runTask(task: () => Promise<void>): Promise<void> {
      const trackedTask = Promise.resolve().then(task);
      inFlight.add(trackedTask);
      void trackedTask.catch((err: unknown) =>
        runtime.error?.(`signal monitor task failed: ${String(err)}`),
      );
      void trackedTask.finally(() => inFlight.delete(trackedTask)).catch(() => undefined);
      return trackedTask;
    },
    async waitForIdle(): Promise<void> {
      // Must not block gateway stop on a hung attachment fetch or inbound turn.
      // Idle window, not wall-clock: keep waiting while tasks settle; return if none complete.
      while (inFlight.size > 0) {
        const snapshot = Array.from(inFlight);
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
          runtime.error?.(
            `signal waitForIdle made no progress within ${DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS}ms; continuing teardown with ${remaining} task(s) still in flight`,
          );
          return;
        }
      }
    },
  };
}
