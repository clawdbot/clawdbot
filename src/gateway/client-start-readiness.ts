import type { GatewayClient, GatewayClientOptions } from "./client.js";
import { waitForEventLoopReady, type EventLoopReadyResult } from "./event-loop-ready.js";
import { resolveConnectChallengeTimeoutMs } from "./handshake-timeouts.js";

export type GatewayClientStartReadinessOptions = {
  timeoutMs?: number;
  clientOptions?: Pick<
    GatewayClientOptions,
    "connectChallengeTimeoutMs" | "connectDelayMs" | "preauthHandshakeTimeoutMs"
  >;
  signal?: AbortSignal;
};

function resolveGatewayClientStartReadinessTimeoutMs(
  options: GatewayClientStartReadinessOptions = {},
): number {
  if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)) {
    return options.timeoutMs;
  }
  const clientOptions = options.clientOptions ?? {};
  const timeoutOverride =
    typeof clientOptions.connectChallengeTimeoutMs === "number" &&
    Number.isFinite(clientOptions.connectChallengeTimeoutMs)
      ? clientOptions.connectChallengeTimeoutMs
      : typeof clientOptions.connectDelayMs === "number" &&
          Number.isFinite(clientOptions.connectDelayMs)
        ? clientOptions.connectDelayMs
        : undefined;
  return resolveConnectChallengeTimeoutMs(timeoutOverride, {
    configuredTimeoutMs: clientOptions.preauthHandshakeTimeoutMs,
  });
}

export async function startGatewayClientWhenEventLoopReady(
  client: GatewayClient,
  options: GatewayClientStartReadinessOptions = {},
): Promise<EventLoopReadyResult> {
  const readiness = await waitForEventLoopReady({
    maxWaitMs: resolveGatewayClientStartReadinessTimeoutMs(options),
    signal: options.signal,
  });
  if (readiness.ready && !readiness.aborted && options.signal?.aborted !== true) {
    client.start();
  }
  return readiness;
}
