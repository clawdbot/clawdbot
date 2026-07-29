// Detects node-only hosts for status output.
// On these machines the local gateway daemon is absent by design, but the node service may point at a remote gateway.

import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import { loadNodeHostConfig } from "../node-host/config.js";

type NodeOnlyServiceLike = {
  installed: boolean | null;
  loaded?: boolean | null;
  externallyManaged?: boolean;
  runtime?:
    | {
        status?: string;
        pid?: number;
      }
    | undefined;
  runtimeShort?: string | null;
};

export type NodeOnlyGatewayInfo = {
  gatewayTarget: string;
  gatewayValue: string;
  connectionDetails: string;
};

function resolveNodeGatewayTarget(gateway?: { host?: string; port?: number }): string {
  return gateway?.host
    ? `${gateway.host}:${gateway.port ?? DEFAULT_GATEWAY_PORT}`
    : "(gateway address unknown)";
}

function hasRunningRuntime(
  runtime:
    | {
        status?: string;
        pid?: number;
      }
    | undefined,
): boolean {
  return runtime?.status === "running" || typeof runtime?.pid === "number";
}

function isNodeServiceActive(node: NodeOnlyServiceLike): boolean {
  if (node.installed !== true) {
    return false;
  }
  if (node.externallyManaged === true) {
    // Externally managed node services can be healthy even without local launchd/systemd loaded state.
    return true;
  }
  if (node.loaded === true) {
    return true;
  }
  if (hasRunningRuntime(node.runtime)) {
    return true;
  }
  return typeof node.runtimeShort === "string" && node.runtimeShort.startsWith("running");
}

/** Returns node-only gateway context when node is active and the local gateway is intentionally absent. */
export async function resolveNodeOnlyGatewayInfo(params: {
  daemon: Pick<NodeOnlyServiceLike, "installed">;
  node: NodeOnlyServiceLike;
}): Promise<NodeOnlyGatewayInfo | null> {
  if (params.daemon.installed !== false || !isNodeServiceActive(params.node)) {
    return null;
  }

  const gatewayTarget = resolveNodeGatewayTarget((await loadNodeHostConfig())?.gateway);
  return {
    gatewayTarget,
    gatewayValue: `node → ${gatewayTarget} · no local gateway`,
    connectionDetails: [
      "Node-only mode detected",
      "Local gateway: not expected on this machine",
      `Remote gateway target: ${gatewayTarget}`,
      "Inspect the remote gateway host for live channel and health details.",
    ].join("\n"),
  };
}
