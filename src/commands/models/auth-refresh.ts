/** Shared gateway refresh for CLI auth writes made outside the gateway process. */
import { callGateway, isGatewayClientRequestError } from "../../gateway/call.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("models-auth-refresh");

export type ModelAuthRefreshOperation = "login" | "logout" | "update";
export type ModelAuthRefreshOutcome = "refreshed" | "gateway-rejected" | "gateway-unreachable";

// Best-effort refresh: auth writes must still succeed when the gateway is absent or stale.
export async function refreshRunningGatewayAuthState(
  agentId: string | undefined,
  operation: ModelAuthRefreshOperation,
): Promise<ModelAuthRefreshOutcome> {
  try {
    await callGateway({
      method: "models.authRefresh",
      params: { operation, ...(agentId ? { agentId } : {}) },
      timeoutMs: 3000,
    });
    return "refreshed";
  } catch (error) {
    if (isGatewayClientRequestError(error)) {
      log.warn(`saved model auth, but the Gateway rejected its refresh (${error.gatewayCode})`);
      return "gateway-rejected";
    }
    // No local gateway, or it is unreachable — the store write already landed.
    log.warn("saved model auth, but the running Gateway could not refresh it; restart the Gateway");
    return "gateway-unreachable";
  }
}
