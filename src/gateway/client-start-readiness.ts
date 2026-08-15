// Server-side gateway client readiness adapter.
// Defers client start until the shared event-loop readiness probe succeeds.
import type {
  GatewayClientStartable,
  GatewayClientStartReadinessOptions,
} from "../../packages/gateway-client/src/readiness.js";
import { startGatewayClientWithReadinessWait } from "../../packages/gateway-client/src/readiness.js";
import { waitForEventLoopReady, type EventLoopReadyResult } from "./event-loop-ready.js";

// Server-side gateway clients wait for the event loop readiness probe before
// starting so connect attempts do not race immediately after process startup.

/** Starts a gateway client once the shared event-loop readiness check passes. */
export function startGatewayClientWhenEventLoopReady(
  client: GatewayClientStartable,
  options: GatewayClientStartReadinessOptions = {},
): Promise<EventLoopReadyResult> {
  return startGatewayClientWithReadinessWait(waitForEventLoopReady, client, options);
}
