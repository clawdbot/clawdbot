import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";

const CONTEXT_CACHE_PREWARM_START_DELAY_MS = 5_000;

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
  let timer: ReturnType<typeof setTimeout> | undefined;
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
  timer = setTimeout(() => {
    timer = undefined;
    void runWithGatewayIndependentRootWorkAdmission(() =>
      params.startupTrace
        ? params.startupTrace.measure("post-ready.context-window-cache", warm)
        : warm(),
    ).catch((err: unknown) => {
      params.log.warn(`post-ready.context-window-cache failed after gateway ready: ${String(err)}`);
    });
  }, CONTEXT_CACHE_PREWARM_START_DELAY_MS);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
