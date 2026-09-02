const GATEWAY_PROBE_ROUTES = new Map<string, "live" | "ready" | "startup">([
  ["/health", "live"],
  ["/healthz", "live"],
  ["/ready", "ready"],
  ["/readyz", "ready"],
  ["/startup", "startup"],
  ["/startupz", "startup"],
]);

export const MCP_APP_STANDALONE_PATH = "/__openclaw__/mcp-app";
export const MCP_APP_STANDALONE_VIEW_PATH = `${MCP_APP_STANDALONE_PATH}/view`;
const WORKER_GATEWAY_PATH = "/__openclaw__/worker";
const NODE_WORKER_BUNDLE_TRANSFER_NAMESPACE = "/__openclaw__/worker-bundle";
const NODE_WORKSPACE_TRANSFER_NAMESPACE = "/__openclaw__/worker-transfer";
export const WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH = "/__openclaw__/worker-bootstrap";

export function classifyGatewayProbePath(
  pathname: string,
): "live" | "ready" | "startup" | "namespace" | "outside" {
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

export function classifyWorkerGatewayPath(pathname: string): "worker" | "namespace" | "outside" {
  if (pathname === WORKER_GATEWAY_PATH) {
    return "worker";
  }
  return pathname.startsWith(`${WORKER_GATEWAY_PATH}/`) ? "namespace" : "outside";
}

export function classifyNodeWorkerBundleTransferPath(pathname: string): "namespace" | "outside" {
  return pathname === NODE_WORKER_BUNDLE_TRANSFER_NAMESPACE ||
    pathname.startsWith(`${NODE_WORKER_BUNDLE_TRANSFER_NAMESPACE}/`)
    ? "namespace"
    : "outside";
}

export function classifyNodeWorkspaceTransferPath(pathname: string): "namespace" | "outside" {
  return pathname === NODE_WORKSPACE_TRANSFER_NAMESPACE ||
    pathname.startsWith(`${NODE_WORKSPACE_TRANSFER_NAMESPACE}/`)
    ? "namespace"
    : "outside";
}

export function classifyWorkerBootstrapArtifactTransferPath(
  pathname: string,
): "namespace" | "outside" {
  return pathname === WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH ||
    pathname.startsWith(`${WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH}/`)
    ? "namespace"
    : "outside";
}
