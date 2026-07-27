import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { HealthSnapshot, StatusSummary } from "../api/types.ts";

type GatewayDiagnosticsSnapshot = {
  status: StatusSummary;
  health: HealthSnapshot;
  models: unknown[];
  heartbeat: unknown;
};

export async function loadGatewayDiagnostics(
  client: GatewayBrowserClient,
): Promise<GatewayDiagnosticsSnapshot> {
  const [status, health, models, heartbeat] = await Promise.all([
    client.request("status", {}),
    client.request("health", {}),
    client.request("models.list", {}),
    client.request("last-heartbeat", {}),
  ]);
  const modelPayload = models as { models?: unknown[] } | undefined;
  return {
    status: status as StatusSummary,
    health: health as HealthSnapshot,
    models: Array.isArray(modelPayload?.models) ? modelPayload.models : [],
    heartbeat,
  };
}
