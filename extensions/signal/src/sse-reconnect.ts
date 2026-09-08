// Signal plugin module implements sse reconnect behavior.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { channelBlockedPatch, channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  computeBackoff,
  logVerbose,
  shouldLogVerbose,
  sleepWithAbort,
  type BackoffPolicy,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import {
  type SignalSseEvent,
  type SignalTransportKind,
  streamSignalEvents,
} from "./client-adapter.js";
import { SignalSseRejectionError } from "./client.js";

const DEFAULT_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};

function isPermanentSignalSseRejection(error: unknown): error is SignalSseRejectionError {
  if (!(error instanceof SignalSseRejectionError)) {
    return false;
  }
  // signal-cli uses other 4xx responses for request/configuration rejection.
  // These three statuses explicitly permit a later retry.
  return error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
}

export type SignalStatusSink = (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;

export function publishSignalRecovering(
  statusSink: SignalStatusSink | undefined,
  lastError?: string,
) {
  statusSink?.({
    connected: false,
    lifecycle: "recovering",
    ...(lastError ? { lastError } : {}),
  });
}

type RunSignalSseLoopParams = {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => unknown;
  timeoutMs?: number;
  transportKind?: SignalTransportKind;
  policy?: Partial<BackoffPolicy>;
  statusSink?: SignalStatusSink;
};

export async function runSignalSseLoop({
  baseUrl,
  account,
  abortSignal,
  runtime,
  onEvent,
  timeoutMs,
  transportKind,
  policy,
  statusSink,
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
        transportKind,
        onStreamOpen: () => {
          statusSink?.(channelReadyPatch());
        },
        onEvent: async (event: SignalSseEvent) => {
          reconnectAttempts = 0;
          await onEvent(event);
        },
        logger: {
          log: runtime.log,
          error: runtime.error,
        },
      });
      if (abortSignal?.aborted) {
        return;
      }
      publishSignalRecovering(statusSink);
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      logReconnectVerbose(`Signal stream ended, reconnecting in ${delayMs / 1000}s...`);
      await sleepWithAbort(delayMs, abortSignal);
    } catch (err) {
      if (abortSignal?.aborted) {
        return;
      }
      runtime.error?.(`Signal stream error: ${String(err)}`);
      if (isPermanentSignalSseRejection(err)) {
        const lastError = `Signal daemon rejected the event stream: ${err.message}. Check the configured account and daemon URL, fix the daemon or proxy response, then restart the channel.`;
        runtime.log?.(`Signal reconnect stopped: ${lastError}`);
        statusSink?.(channelBlockedPatch(lastError, { connected: false }));
        return;
      }
      publishSignalRecovering(statusSink, String(err));
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
