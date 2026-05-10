import {
  computeBackoff,
  logVerbose,
  shouldLogVerbose,
  sleepWithAbort,
  type BackoffPolicy,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { type SignalApiMode, type SignalSseEvent, streamSignalEvents } from "./client-adapter.js";

const DEFAULT_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};

type RunSignalSseLoopParams = {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  timeoutMs?: number;
  apiMode?: SignalApiMode;
  policy?: Partial<BackoffPolicy>;
};

export async function runSignalSseLoop({
  baseUrl,
  account,
  abortSignal,
  runtime,
  onEvent,
  timeoutMs,
  apiMode,
  policy,
}: RunSignalSseLoopParams) {
  const reconnectPolicy = {
    ...DEFAULT_RECONNECT_POLICY,
    ...policy,
  };
  let reconnectAttempts = 0;

  const logReconnectVerbose = (message: string) => {
    if (!shouldLogVerbose()) {
      return;
    }
    logVerbose(message);
  };

  for (;;) {
    if (abortSignal?.aborted) {
      break;
    }
    try {
      await streamSignalEvents({
        baseUrl,
        account,
        abortSignal,
        timeoutMs,
        apiMode,
        onEvent: (event: SignalSseEvent) => {
          reconnectAttempts = 0;
          onEvent(event);
        },
        logger: {
          log: runtime.log,
          error: runtime.error,
        },
      });
      if (abortSignal?.aborted) {
        return;
      }
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      logReconnectVerbose(`Signal stream ended, reconnecting in ${delayMs / 1000}s...`);
      await sleepWithAbort(delayMs, abortSignal);
    } catch (err) {
      if (abortSignal?.aborted) {
        return;
      }
      runtime.error?.(`Signal stream error: ${String(err)}`);
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      runtime.log?.(`Signal connection lost, reconnecting in ${delayMs / 1000}s...`);
      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch (sleepErr) {
        if (abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}
