// Gateway Client module implements readiness behavior.
import type { GatewayClientOptions } from "./client.js";
import {
  waitForEventLoopReady,
  type EventLoopReadyOptions,
  type EventLoopReadyResult,
} from "./event-loop-ready.js";
import { resolveConnectChallengeTimeoutMs } from "./timeouts.js";

export type GatewayClientStartable = {
  start(): void;
};

/** Injectable readiness waiter used by tests and alternate event-loop probes. */
export type EventLoopReadyWaiter = (
  options?: EventLoopReadyOptions,
) => Promise<EventLoopReadyResult>;

/** Timeout and abort controls for delaying client start until the loop can process IO. */
export type GatewayClientStartReadinessOptions = {
  timeoutMs?: number;
  clientOptions?: Pick<
    GatewayClientOptions,
    "connectChallengeTimeoutMs" | "env" | "preauthHandshakeTimeoutMs"
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
  return resolveConnectChallengeTimeoutMs(clientOptions.connectChallengeTimeoutMs, {
    env: clientOptions.env,
    configuredTimeoutMs: clientOptions.preauthHandshakeTimeoutMs,
  });
}

/** Starts a gateway client only after the supplied readiness probe succeeds. */
export async function startGatewayClientWithReadinessWait(
  waitForReady: EventLoopReadyWaiter,
  client: GatewayClientStartable,
  options: GatewayClientStartReadinessOptions = {},
): Promise<EventLoopReadyResult> {
  const readiness = await waitForReady({
    maxWaitMs: resolveGatewayClientStartReadinessTimeoutMs(options),
    signal: options.signal,
  });
  if (readiness.ready && !readiness.aborted && options.signal?.aborted !== true) {
    client.start();
  }
  return readiness;
}

/** Starts a gateway client after the default event-loop readiness probe succeeds. */
export async function startGatewayClientWhenEventLoopReady(
  client: GatewayClientStartable,
  options: GatewayClientStartReadinessOptions = {},
): Promise<EventLoopReadyResult> {
  return startGatewayClientWithReadinessWait(waitForEventLoopReady, client, options);
}
