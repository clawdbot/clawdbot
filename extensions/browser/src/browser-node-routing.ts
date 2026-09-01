/** Shared browser-node selection for agent tools and Gateway requests. */
import { BROWSER_PROXY_COMMAND } from "./browser-node-commands.js";
import { resolveNodeIdFromList } from "./sdk-setup-tools.js";

export type BrowserNodeTarget = {
  nodeId: string;
  displayName?: string;
  label?: string;
  connected?: boolean;
  caps?: string[];
  commands?: string[];
  pendingDeclaredCommands?: string[];
};

type BrowserNodeRoutingPolicy = {
  mode?: "off" | "auto" | "manual";
  node?: string;
};

/** Select the same authorized browser-capable node on every request surface. */
export function resolveBrowserNodeTarget<T extends BrowserNodeTarget>(params: {
  nodes: T[];
  policy?: BrowserNodeRoutingPolicy;
  requestedNode?: string;
  explicitTarget?: boolean;
  requireConnected?: boolean;
}): T | null {
  const mode = params.policy?.mode ?? "auto";
  const explicit = params.explicitTarget || Boolean(params.requestedNode?.trim());
  if (mode === "off") {
    if (explicit) {
      throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
    }
    return null;
  }

  const requested = params.requestedNode?.trim() || params.policy?.node?.trim();
  if (mode === "manual" && !explicit && !requested) {
    return null;
  }

  const browserNodes = params.nodes.filter((node) => {
    if (params.requireConnected && !node.connected) {
      return false;
    }
    return node.caps?.includes("browser") || node.commands?.includes(BROWSER_PROXY_COMMAND);
  });
  if (browserNodes.length === 0) {
    if (explicit || requested) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }

  if (requested) {
    const nodeId = resolveNodeIdFromList(browserNodes, requested, false, {
      allowCompactDisplayName: true,
    });
    return browserNodes.find((node) => node.nodeId === nodeId) ?? null;
  }

  if (browserNodes.length === 1) {
    return browserNodes[0] ?? null;
  }
  if (explicit) {
    throw new Error(
      `Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`,
    );
  }
  return null;
}
