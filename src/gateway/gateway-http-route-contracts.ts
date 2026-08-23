const GATEWAY_PROBE_ROUTES = new Map<string, "live" | "ready">([
  ["/health", "live"],
  ["/healthz", "live"],
  ["/ready", "ready"],
  ["/readyz", "ready"],
]);

export const MCP_APP_STANDALONE_PATH = "/__openclaw__/mcp-app";
export const MCP_APP_STANDALONE_VIEW_PATH = `${MCP_APP_STANDALONE_PATH}/view`;

export function classifyGatewayProbePath(
  pathname: string,
): "live" | "ready" | "namespace" | "outside" {
  for (const [root, status] of GATEWAY_PROBE_ROUTES) {
    if (pathname === root) {
      return status;
    }
    if (pathname.startsWith(`${root}/`)) {
      return "namespace";
    }
  }
  return "outside";
}

export function classifyMcpAppStandalonePath(
  pathname: string,
): "shell" | "view" | "namespace" | "outside" {
  if (pathname === MCP_APP_STANDALONE_PATH) {
    return "shell";
  }
  if (pathname === MCP_APP_STANDALONE_VIEW_PATH) {
    return "view";
  }
  return pathname.startsWith(`${MCP_APP_STANDALONE_PATH}/`) ? "namespace" : "outside";
}
