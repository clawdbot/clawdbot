import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";

export type CloudWorkerStopAction = {
  method: "sessions.reclaim";
  requiredScope: "operator.write";
  blocksActiveRun: boolean;
};

export function resolveCloudWorkerStopAction(
  placement: GatewaySessionRow["placement"],
): CloudWorkerStopAction | null {
  if (!placement || !isCloudWorkerPlacementState(placement.state)) {
    return null;
  }
  return {
    method: "sessions.reclaim",
    requiredScope: "operator.write",
    blocksActiveRun: placement.state === "active",
  };
}

export async function requestCloudWorkerStop(
  client: GatewayBrowserClient,
  session: { key: string; agentId?: string },
): Promise<void> {
  await client.request(
    "sessions.reclaim",
    { key: session.key, ...(session.agentId ? { agentId: session.agentId } : {}) },
    { timeoutMs: 10 * 60_000 },
  );
}
