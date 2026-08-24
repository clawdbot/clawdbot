/**
 * Browser-local SDK bridge for gateway, plugin runtime, CLI runtime, and timeout
 * helpers.
 */
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { clampTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

export {
  addGatewayClientOptions,
  callGatewayFromCli,
  ensureGatewayStartupAuth,
  ErrorCodes,
  errorShape,
  isLoopbackHost,
  isNodeCommandAllowed,
  respondUnavailableOnNodeInvokeError,
  resolveGatewayAuth,
  resolveNodeCommandAllowlist,
  safeParseJson,
} from "openclaw/plugin-sdk/gateway-runtime";
export type {
  GatewayRequestHandlers,
  GatewayRpcOpts,
  NodeSession,
} from "openclaw/plugin-sdk/gateway-runtime";
export { runCommandWithRuntime } from "openclaw/plugin-sdk/cli-runtime";
export type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
export {
  startLazyPluginServiceModule,
  type LazyPluginServiceHandle,
} from "openclaw/plugin-sdk/plugin-runtime";
export { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return clampTimerTimeoutMs(timeoutMs);
}

function createTimeoutAbortSignal(timeoutMs: number, label: string | undefined) {
  const controller = new AbortController();
  const error = new Error(`${label ?? "request"} timed out`);
  const timer = setTimeout(() => controller.abort(error), timeoutMs);
  timer.unref?.();
  return { controller, error, timer };
}

function waitForAbort(
  signal: AbortSignal,
  fallback: Error,
): {
  promise: Promise<never>;
  cleanup: () => void;
} {
  if (signal.aborted) {
    return {
      promise: Promise.reject(toErrorObject(signal.reason ?? fallback, "Non-Error rejection")),
      cleanup: () => undefined,
    };
  }
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    listener = () => reject(toErrorObject(signal.reason ?? fallback, "Non-Error rejection"));
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    cleanup: () => {
      if (listener) {
        signal.removeEventListener("abort", listener);
      }
    },
    promise,
  };
}

/** Runs async work with an optional aborting timeout signal. */
export async function withTimeout<T>(
  work: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs?: number,
  label?: string,
): Promise<T> {
  const resolved = normalizeTimeoutMs(timeoutMs);
  if (!resolved) {
    return await work(undefined);
  }

  const timeout = createTimeoutAbortSignal(resolved, label);
  const abort = waitForAbort(timeout.controller.signal, timeout.error);

  try {
    return await Promise.race([work(timeout.controller.signal), abort.promise]);
  } finally {
    clearTimeout(timeout.timer);
    abort.cleanup();
  }
}
