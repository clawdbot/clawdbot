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
  SignalSseRejectionError,
  type SignalSseEvent,
  type SignalTransportKind,
  streamSignalEvents,
} from "./client-adapter.js";

const DEFAULT_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};

// Only the native signal-cli transport (client.ts) throws SignalSseRejectionError on a
// non-2xx daemon response; the container/WebSocket transport never throws this type, so
// an unmatched rejection falls through to the generic transient-error handling below.
const UNAUTHORIZED_ACCOUNT_STATUS = 401;
const UNAUTHORIZED_ACCOUNT_MESSAGE =
  'Signal daemon rejected the connection (401 Unauthorized). This usually means the account needs re-linking (`signal-cli link -n "OpenClaw"`) or re-registering; if the daemon sits behind its own auth proxy, its credentials may need attention instead. Restart the channel once resolved.';

function readSseRejectionStatus(err: unknown): number | undefined {
  return err instanceof SignalSseRejectionError ? err.status : undefined;
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
      if (readSseRejectionStatus(err) === UNAUTHORIZED_ACCOUNT_STATUS) {
        runtime.log?.(`Signal reconnect stopped: ${UNAUTHORIZED_ACCOUNT_MESSAGE}`);
        statusSink?.(channelBlockedPatch(UNAUTHORIZED_ACCOUNT_MESSAGE, { connected: false }));
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
