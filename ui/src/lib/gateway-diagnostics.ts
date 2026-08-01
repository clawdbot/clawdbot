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
  signal?: AbortSignal,
): Promise<GatewayDiagnosticsSnapshot> {
  const [status, health, models, heartbeat] = await Promise.all([
    client.request("status", {}, { signal }),
    client.request("health", {}, { signal }),
    client.request("models.list", {}, { signal }),
    client.request("last-heartbeat", {}, { signal }),
  ]);
  const modelPayload = models as { models?: unknown[] } | undefined;
  return {
    status: status as StatusSummary,
    health: health as HealthSnapshot,
    models: Array.isArray(modelPayload?.models) ? modelPayload.models : [],
    heartbeat,
  };
}
