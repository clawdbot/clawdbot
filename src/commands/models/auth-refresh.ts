/** Shared gateway refresh for CLI auth writes made outside the gateway process. */
import { callGateway } from "../../gateway/call.js";
import { isGatewayTransportError } from "../../gateway/transport-error.js";
import type { RuntimeEnv } from "../../runtime.js";

export type GatewayAuthRefreshResult = "refreshed" | "unavailable" | "failed";

// The store write remains authoritative when no gateway is running, while a
// connected gateway failure must remain visible because its runtime is stale.
export async function refreshRunningGatewayAuthState(
  agentId: string | undefined,
  runtime: Pick<RuntimeEnv, "error">,
): Promise<GatewayAuthRefreshResult> {
  let gatewayConnected = false;
  try {
    await callGateway({
      method: "models.authStatus",
      params: { refresh: true, ...(agentId ? { agentId } : {}) },
      timeoutMs: 3000,
      requireLocalBackendSharedAuth: true,
      onHelloOk: () => {
        gatewayConnected = true;
      },
    });
    return "refreshed";
  } catch (error) {
    if (
      !gatewayConnected &&
      isGatewayTransportError(error) &&
      error.kind === "closed" &&
      error.code === undefined &&
      error.reason?.includes("ECONNREFUSED")
    ) {
      return "unavailable";
    }
    runtime.error(
      gatewayConnected
        ? "Warning: Model auth changes were saved, but the running gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes."
        : "Warning: Model auth changes were saved, but the gateway did not confirm the refresh. If a gateway is running, run `openclaw gateway restart` to apply the saved changes.",
    );
    return "failed";
  }
}
