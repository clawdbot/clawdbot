import type {
  GatewayClientStartable,
  GatewayClientStartReadinessOptions,
} from "../../packages/gateway-client/src/readiness.js";
import { startGatewayClientWithReadinessWait } from "../../packages/gateway-client/src/readiness.js";
import { waitForEventLoopReady, type EventLoopReadyResult } from "./event-loop-ready.js";

export type {
  GatewayClientStartable,
  GatewayClientStartReadinessOptions,
} from "../../packages/gateway-client/src/readiness.js";

export function startGatewayClientWhenEventLoopReady(
  client: GatewayClientStartable,
  options: GatewayClientStartReadinessOptions = {},
): Promise<EventLoopReadyResult> {
  return startGatewayClientWithReadinessWait(waitForEventLoopReady, client, options);
}
