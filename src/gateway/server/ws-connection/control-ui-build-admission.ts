import { GATEWAY_CLIENT_IDS } from "../../../../packages/gateway-protocol/src/client-info.js";
import { isGatewayHostBrowserOrigin } from "../../origin-check.js";

type ControlUiBuildMismatch = {
  gatewayBuildId: string;
  clientBuildId: string | null;
};

/**
 * The Gateway owns bundled same-origin UI admission. Browser code still owns
 * reload, but an older document must never become an RPC-capable session.
 *
 * The exemptions are deliberate, not gaps (ui/AGENTS.md "Gateway Coupling"):
 * configured roots serve a non-dist build by definition, "dev" is the ui:dev
 * sentinel, and cross-origin stays exempt because build ids embed the build
 * timestamp — version-identical source-built installs carry different ids, so
 * equality would reject matched pairings, and "reload" cannot remediate a
 * client the Gateway did not serve. Exempted skew fails visibly at the first
 * missing method instead.
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
