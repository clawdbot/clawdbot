import type { PortalSummary } from "@openclaw/gateway-protocol";
import { resolveGatewayHttpOrigin } from "../../components/sandbox-host.ts";

export function resolvePortalUrl(
  portal: Pick<PortalSummary, "listenPort" | "path"> & { tokenQuery: string },
  gatewayUrl: string,
  hostOrigin: string,
): string {
  const url = new URL(resolveGatewayHttpOrigin(gatewayUrl, hostOrigin));
  url.port = String(portal.listenPort);
  url.pathname = portal.path ?? "/";
  url.search = portal.tokenQuery;
  return url.href;
}
