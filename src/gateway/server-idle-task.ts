import {
  getGatewayRestartDrainSignal,
  isGatewayRestartDrainError,
  tryBeginGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";

export type GatewayIdleTaskHandle = {
  stop: () => void | Promise<void>;
};

/** Schedules one low-priority task, retrying until the gateway has no active request roots. */
export function scheduleGatewayIdleTask(params: {
  delayMs: number;
  retryDelayMs: number;
  isClosing: () => boolean;
  isBusy: () => boolean;
  run: () => Promise<void>;
  log: { warn: (message: string) => void };
  errorMessage: string;
}): GatewayIdleTaskHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | undefined;
  const isClosing = () => stopped || params.isClosing() || getGatewayRestartDrainSignal().aborted;
  const run = async () => {
    if (isClosing()) {
      return;
    }
    // Newly admitted request work takes priority over maintenance.
    if (params.isBusy()) {
      schedule(params.retryDelayMs);
    } else {
      await params.run();
    }
  };
  const schedule = (delayMs: number) => {
    if (isClosing()) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (isClosing()) {
        return;
      }
      // Optional work retries admission instead of waiting behind a suspend fence
      // that shutdown may never reopen.
      const admission = params.isBusy()
        ? null
        : tryBeginGatewayIndependentRootWorkAdmission("idle-task");
      if (!admission) {
        schedule(params.retryDelayMs);
        return;
      }
      // Publish the join before callbacks can synchronously initiate shutdown.
      running = Promise.resolve()
        .then(() => admission.run(run))
        .catch((error: unknown) => {
          if (!isGatewayRestartDrainError(error)) {
            params.log.warn(`${params.errorMessage}: ${String(error)}`);
          }
        })
        .finally(() => {
          admission.release();
          running = undefined;
        });
    }, delayMs);
    timer.unref?.();
  };
  schedule(params.delayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return running;
    },
  };
}
