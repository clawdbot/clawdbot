import type { EnvironmentsDestroyResult } from "../../../packages/gateway-protocol/src/schema/environments.ts";
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";

export type CloudWorkerStopAction =
  | { method: "sessions.reclaim"; requiredScope: "operator.admin" }
  | {
      method: "environments.destroy";
      params: { environmentId: string };
      requiredScope: "operator.admin";
    };

export function resolveCloudWorkerStopAction(
  placement: GatewaySessionRow["placement"],
): CloudWorkerStopAction | null {
  if (!placement || !isCloudWorkerPlacementState(placement.state)) {
    return null;
  }
  if (placement.state === "active") {
    return { method: "sessions.reclaim", requiredScope: "operator.admin" };
  }
  return "environmentId" in placement && placement.environmentId
    ? {
        method: "environments.destroy",
        params: { environmentId: placement.environmentId },
        requiredScope: "operator.admin",
      }
    : null;
}

export async function requestCloudWorkerStop(
  client: GatewayBrowserClient,
  action: CloudWorkerStopAction,
  session: { key: string; agentId?: string },
): Promise<EnvironmentsDestroyResult | null> {
  if (action.method === "environments.destroy") {
    return client.request<EnvironmentsDestroyResult>("environments.destroy", action.params);
  }
  await client.request(
    "sessions.reclaim",
    { key: session.key, ...(session.agentId ? { agentId: session.agentId } : {}) },
    { timeoutMs: 10 * 60_000 },
  );
  return null;
}
