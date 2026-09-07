/** Shared gateway refresh for CLI auth writes made outside the gateway process. */
import {
  callGateway,
  GatewayLocalBackendSharedAuthUnavailableError,
  isImplicitLocalGatewayTarget,
} from "../../gateway/call.js";
import { isGatewayTransportError } from "../../gateway/transport-error.js";
import type { RuntimeEnv } from "../../runtime.js";

type GatewayAuthRefreshResponse = { unavailable?: unknown };

export async function refreshRunningGatewayAuthState(
  agentId: string | undefined,
  runtime: Pick<RuntimeEnv, "error">,
): Promise<void> {
  let gatewayConnected = false;
  let localTarget: boolean | undefined;
  try {
    localTarget = await isImplicitLocalGatewayTarget({});
    const result = await callGateway<GatewayAuthRefreshResponse>({
      method: "models.authStatus",
      params: { refresh: true, ...(agentId ? { agentId } : {}) },
      timeoutMs: 3000,
      requireLocalBackendSharedAuth: true,
      onHelloOk: () => {
        gatewayConnected = true;
      },
    });
    if (!result.unavailable) {
      return;
    }
  } catch (error) {
    if (error instanceof GatewayLocalBackendSharedAuthUnavailableError && localTarget === false) {
      runtime.error(
        "Warning: Model auth changes were saved on this host, but the configured Gateway does not share this auth state. Run the auth command on the Gateway host (the far end of any SSH tunnel).",
      );
      return;
    }
    if (
      localTarget === true &&
      !gatewayConnected &&
      isGatewayTransportError(error) &&
      error.kind === "closed" &&
      error.code === undefined &&
      error.reason?.includes("ECONNREFUSED")
    ) {
      return;
    }
  }
  runtime.error(
    localTarget === true
      ? `Warning: Model auth changes were saved, but the ${gatewayConnected ? "running" : "local"} Gateway could not refresh them. Run \`openclaw gateway restart\` to apply the saved changes.`
      : "Warning: Model auth changes were saved, but the configured Gateway could not be identified or refreshed. Apply the auth change on the Gateway host, or restart it there.",
  );
}
