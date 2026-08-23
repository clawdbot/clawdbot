/** Shared gateway refresh for CLI auth writes made outside the gateway process. */
import { callGateway } from "../../gateway/call.js";

// CLI auth writes occur outside the gateway process, which may retain an older
// runtime snapshot. Best-effort: auth writes must still succeed with no gateway.
export async function refreshRunningGatewayAuthState(): Promise<void> {
  try {
    await callGateway({
      method: "models.authStatus",
      params: { refresh: true },
      timeoutMs: 3000,
    });
  } catch {
    // No local gateway, or it is unreachable — the store write already landed.
  }
}
