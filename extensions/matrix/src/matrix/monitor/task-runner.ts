import type { RuntimeLogger } from "../../runtime-api.js";

export function createMatrixMonitorTaskRunner(params: {
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
}) {
  const inFlight = new Set<Promise<void>>();

  const runDetachedTask = (label: string, task: () => Promise<void>): Promise<void> => {
    let trackedTask!: Promise<void>;
    trackedTask = Promise.resolve()
      .then(task)
      .catch((error) => {
        const message = String(error);
        params.logVerboseMessage(`matrix: ${label} failed (${message})`);
        params.logger.warn("matrix background task failed", {
          task: label,
          error: message,
        });
      })
      .finally(() => {
        inFlight.delete(trackedTask);
      });
    inFlight.add(trackedTask);
    return trackedTask;
  };

  const waitForIdle = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled(Array.from(inFlight));
    }
  };

  return {
    runDetachedTask,
    waitForIdle,
  };
}
