import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";

export type ModelSetupDetectionConnection = Pick<ApplicationGatewaySnapshot, "client" | "hello"> & {
  agentId: string | null;
};

let cached:
  | { connection: ModelSetupDetectionConnection; result: SystemAgentSetupDetectResult }
  | undefined;

export function consumeCachedModelSetupDetection(
  connection: ModelSetupDetectionConnection,
): SystemAgentSetupDetectResult | null {
  if (!cached) {
    return null;
  }
  if (
    cached.connection.client !== connection.client ||
    cached.connection.hello !== connection.hello ||
    cached.connection.agentId !== connection.agentId
  ) {
    cached = undefined;
    return null;
  }
  const result = cached.result;
  cached = undefined;
  return result;
}
