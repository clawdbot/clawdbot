import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelAuthStatusResult } from "../types.ts";

const FALLBACK: ModelAuthStatusResult = { ts: 0, providers: [] };

export type ModelAuthStatusState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  modelAuthStatusLoading: boolean;
  modelAuthStatusResult: ModelAuthStatusResult | null;
  modelAuthStatusError: string | null;
};

/**
 * Fetch the current auth-status snapshot. Rethrows transport errors so the
 * state wrapper can distinguish "not loaded yet" (ts === 0) from "load failed"
 * (error set).
 *
 * Pass `{ refresh: true }` to bypass the gateway's 60s cache — useful after
 * a user-initiated refresh, where serving a minute-old snapshot would
 * contradict the affordance.
 */
export async function loadModelAuthStatus(
  client: GatewayBrowserClient,
  opts?: { refresh?: boolean },
): Promise<ModelAuthStatusResult> {
  const params = opts?.refresh ? { refresh: true } : {};
  const result = await client.request<ModelAuthStatusResult>("models.authStatus", params);
  return result ?? FALLBACK;
}

export async function loadModelAuthStatusState(
  state: ModelAuthStatusState,
  opts?: { refresh?: boolean },
): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.modelAuthStatusLoading) {
    return;
  }
  state.modelAuthStatusLoading = true;
  state.modelAuthStatusError = null;
  try {
    state.modelAuthStatusResult = await loadModelAuthStatus(state.client, opts);
  } catch (err) {
    state.modelAuthStatusError = err instanceof Error ? err.message : String(err);
    state.modelAuthStatusResult = FALLBACK;
  } finally {
    state.modelAuthStatusLoading = false;
  }
}
