import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";

const CONTEXT_CACHE_PREWARM_START_DELAY_MS = 5_000;
const CONTEXT_CACHE_PREWARM_RETRY_DELAY_MS = 250;

type StartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

type ContextCachePrewarmHandle = {
  stop: () => void | Promise<void>;
};

export function scheduleContextCachePrewarm(params: {
  cfgAtStart: OpenClawConfig;
  startupTrace?: StartupTrace;
  log: { warn: (msg: string) => void };
}): ContextCachePrewarmHandle {
  let stopped = false;
  const warm = async () => {
    if (stopped) {
      return;
    }
    const { ensureContextWindowCacheLoaded } = await import("../agents/context.js");
    if (!stopped) {
      await ensureContextWindowCacheLoaded(params.cfgAtStart);
    }
  };

  // Source-backed provider discovery can consume the main thread. Give
  // readiness probes and immediate client work a clean event-loop window.
  const idleTask = scheduleGatewayIdleTask({
    delayMs: CONTEXT_CACHE_PREWARM_START_DELAY_MS,
    retryDelayMs: CONTEXT_CACHE_PREWARM_RETRY_DELAY_MS,
    isClosing: () => stopped,
    isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
    run: () =>
      params.startupTrace
        ? params.startupTrace.measure("post-ready.context-window-cache", warm)
        : warm(),
    log: params.log,
    errorMessage: "post-ready.context-window-cache failed after gateway ready",
  });

  return {
    stop: () => {
      stopped = true;
      idleTask.stop();
    },
  };
}
