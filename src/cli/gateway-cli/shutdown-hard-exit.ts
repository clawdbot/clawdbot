import { Worker } from "node:worker_threads";

export type ShutdownHardExitWatchdog = {
  cancel: () => void;
};

export function armShutdownHardExitWatchdog(params: {
  delayMs: number;
  onError: (error: unknown) => void;
}): ShutdownHardExitWatchdog | null {
  const reportError = (error: unknown) => {
    try {
      params.onError(error);
    } catch {
      // Shutdown must retain the main-thread fallback even if warning delivery fails.
    }
  };
  let worker: Worker;
  try {
    worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const timer = setTimeout(() => process.kill(process.pid, "SIGKILL"), workerData.delayMs);
       parentPort.once("message", () => {
         clearTimeout(timer);
         parentPort.close();
       });`,
      {
        eval: true,
        execArgv: [],
        workerData: { delayMs: Math.max(0, Math.floor(params.delayMs)) },
      },
    );
  } catch (error) {
    reportError(error);
    return null;
  }

  let active = true;
  worker.once("error", (error) => {
    if (active) {
      active = false;
      reportError(error);
    }
  });

  return {
    cancel: () => {
      active = false;
      try {
        worker.postMessage("cancel", []);
      } catch (error) {
        reportError(error);
      }
    },
  };
}
