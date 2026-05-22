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
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : undefined;
}

function createTimeoutAbortSignal(timeoutMs: number, label: string | undefined) {
  const controller = new AbortController();
  const error = new Error(`${label ?? "request"} timed out`);
  const timer = setTimeout(() => controller.abort(error), timeoutMs);
  timer.unref?.();
  return { controller, error, timer };
}

function waitForAbort(signal: AbortSignal, fallback: Error): {
  promise: Promise<never>;
  cleanup: () => void;
} {
  if (signal.aborted) {
    return { promise: Promise.reject(signal.reason ?? fallback), cleanup: () => undefined };
  }
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason ?? fallback);
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
