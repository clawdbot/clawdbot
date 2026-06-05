// Control UI controller manages health gateway state.
import type { GatewayBrowserClient } from "../gateway.ts";
import type { HealthSummary } from "../types.ts";

/** Default fallback returned when the gateway is unreachable or returns null. */
const HEALTH_FALLBACK: HealthSummary = {
  ok: false,
  ts: 0,
  durationMs: 0,
  heartbeatSeconds: 0,
  defaultAgentId: "",
  agents: [],
  sessions: { path: "", count: 0, recent: [] },
};

/** State slice consumed by {@link loadHealthState}. Follows the agents/sessions convention. */
export type HealthState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  healthLoading: boolean;
  healthResult: HealthSummary | null;
  healthError: string | null;
};

/**
 * Fetch the gateway health summary.
 *
 * Accepts a {@link GatewayBrowserClient} (matching the existing ui/ controller
 * convention).  Returns a fully-typed {@link HealthSummary}; on failure the
 * caller receives a safe fallback with `ok: false` rather than `null`.
 */
export async function loadHealth(client: GatewayBrowserClient): Promise<HealthSummary> {
  try {
    const result = await client.request<HealthSummary>("health", {});
    return result ?? HEALTH_FALLBACK;
  } catch {
    return HEALTH_FALLBACK;
  }
}

/**
 * State-mutating health loader (same pattern as {@link import("./agents.ts").loadAgents}).
 *
 * Populates `healthResult` / `healthError` on the provided state slice and
 * toggles `healthLoading` around the request.
 */
export async function loadHealthState(state: HealthState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.healthLoading) {
    return;
  }
  state.healthLoading = true;
  state.healthError = null;
  try {
    state.healthResult = await loadHealth(state.client);
  } catch (err) {
    state.healthError = String(err);
  } finally {
    state.healthLoading = false;
  }
}
