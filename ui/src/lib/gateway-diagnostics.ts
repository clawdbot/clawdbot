import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { HealthSnapshot, StatusSummary } from "../api/types.ts";

type CommandLaneBlockReason = "lane" | "group-budget" | "sibling-reservation" | null;

export type CommandLaneSnapshot = {
  lane: string;
  queuedCount: number;
  activeCount: number;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
  group?: string;
  groupActive?: number;
  groupBudget?: number;
  reservedForLane?: number;
  blockedBy?: CommandLaneBlockReason;
};

type GatewayDiagnosticsSnapshot = {
  status: StatusSummary;
  health: HealthSnapshot;
  models: unknown[];
  heartbeat: unknown;
  lanes: CommandLaneSnapshot[] | null;
};

export async function loadCommandLaneDiagnostics(
  client: GatewayBrowserClient,
  signal?: AbortSignal,
): Promise<CommandLaneSnapshot[]> {
  const payload = await client.request<{ lanes: CommandLaneSnapshot[] }>(
    "diagnostics.lanes",
    {},
    { signal },
  );
  return payload.lanes;
}

export async function loadGatewayDiagnostics(
  client: GatewayBrowserClient,
  agentId: string | null,
  signal?: AbortSignal,
): Promise<GatewayDiagnosticsSnapshot> {
  const modelsRequest = agentId
    ? client.request("models.list", { agentId, preparedOnly: true }, { signal })
    : Promise.resolve({ models: [] });
  const lanesRequest = loadCommandLaneDiagnostics(client, signal).catch(() => null);
  const [status, health, models, heartbeat, lanes] = await Promise.all([
    client.request("status", {}, { signal }),
    client.request("health", {}, { signal }),
    modelsRequest,
    client.request("last-heartbeat", {}, { signal }),
    lanesRequest,
  ]);
  const modelPayload = models as { models?: unknown[] } | undefined;
  return {
    status: status as StatusSummary,
    health: health as HealthSnapshot,
    models: Array.isArray(modelPayload?.models) ? modelPayload.models : [],
    heartbeat,
    lanes,
  };
}
