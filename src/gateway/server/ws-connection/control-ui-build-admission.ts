import { GATEWAY_CLIENT_IDS } from "../../../../packages/gateway-protocol/src/client-info.js";
import { isGatewayHostBrowserOrigin } from "../../origin-check.js";

type ControlUiBuildMismatch = {
  gatewayBuildId: string;
  clientBuildId: string | null;
};

/**
 * The Gateway owns bundled same-origin UI admission. Browser code still owns
 * reload, but an older document must never become an RPC-capable session.
 */
export function resolveControlUiBuildMismatch(params: {
  clientId: string;
  clientBuildId?: string;
  gatewayBuildId?: string | null;
  configuredControlUiRoot?: string;
  requestHost?: string;
  requestOrigin?: string;
}): ControlUiBuildMismatch | null {
  const gatewayBuildId = params.gatewayBuildId?.trim();
  const clientBuildId = params.clientBuildId?.trim();
  if (
    params.clientId !== GATEWAY_CLIENT_IDS.CONTROL_UI ||
    params.configuredControlUiRoot ||
    !gatewayBuildId ||
    clientBuildId === "dev" ||
    !isGatewayHostBrowserOrigin({
      requestHost: params.requestHost,
      origin: params.requestOrigin,
    }) ||
    clientBuildId === gatewayBuildId
  ) {
    return null;
  }
  return { gatewayBuildId, clientBuildId: clientBuildId || null };
}
