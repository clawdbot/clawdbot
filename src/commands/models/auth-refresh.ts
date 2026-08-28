/** Shared gateway refresh for CLI auth writes made outside the gateway process. */
import { callGateway } from "../../gateway/call.js";

// Best-effort refresh: auth writes must still succeed when the gateway is absent or stale.
export async function refreshRunningGatewayAuthState(agentId?: string): Promise<void> {
  try {
    await callGateway({
      method: "models.authStatus",
      params: { refresh: true, ...(agentId ? { agentId } : {}) },
      timeoutMs: 3000,
    });
  } catch {
    // No local gateway, or it is unreachable — the store write already landed.
  }
}
