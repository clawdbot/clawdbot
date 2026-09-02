/** Browser tool host, sandbox, and node target resolution. */
import { resolveBrowserNodeTarget } from "./browser-node-routing.js";
import {
  getRuntimeConfig,
  hasGatewayToolRoutingContext,
  listNodes,
  resolveBrowserConfig,
  resolveProfile,
  getBrowserProfileCapabilities,
} from "./browser-tool.runtime.js";

export type BrowserNodeTarget = {
  nodeId: string;
  label?: string;
  commands: string[];
  pendingDeclaredCommands: string[];
};

export async function resolveBrowserToolNodeTarget(params: {
  requestedNode?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  signal?: AbortSignal;
}): Promise<BrowserNodeTarget | null> {
  if (params.allowHostControl === false) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser control is disabled by sandbox policy.");
    }
    return null;
  }

  const cfg = getRuntimeConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const explicitTarget = params.target === "node";
  const requestedNode = params.requestedNode?.trim();
  if (policy?.mode === "off") {
    resolveBrowserNodeTarget({ nodes: [], policy, requestedNode, explicitTarget });
    return null;
  }
  if (params.sandboxBridgeUrl?.trim() && !explicitTarget && !requestedNode) {
    return null;
  }
  if (params.target && !explicitTarget) {
    return null;
  }
  // Browser control can create Gateway auth itself. Credentials do not imply
  // node routing; standalone runs use the host unless a Gateway route is selected.
  if (
    !explicitTarget &&
    !requestedNode &&
    !policy?.node?.trim() &&
    (policy?.mode === "manual" ||
      (policy?.mode !== "auto" &&
        !hasGatewayToolRoutingContext() &&
        cfg.gateway?.mode !== "remote" &&
        !cfg.gateway?.remote?.url?.trim() &&
        !process.env.OPENCLAW_GATEWAY_URL?.trim()))
  ) {
    return null;
  }
  const node = resolveBrowserNodeTarget({
    nodes: await listNodes({}, params.signal),
    policy,
    requestedNode,
    explicitTarget,
    requireConnected: true,
  });
  return node
    ? {
        nodeId: node.nodeId,
        label: node.displayName ?? node.remoteIp ?? node.nodeId,
        commands: node.commands ?? [],
        pendingDeclaredCommands: node.pendingDeclaredCommands ?? [],
      }
    : null;
}

export function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string | undefined {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const normalizedSandbox = params.sandboxBridgeUrl?.trim() ?? "";
  const target = params.target ?? (normalizedSandbox ? "sandbox" : "host");

  if (target === "sandbox") {
    if (!normalizedSandbox) {
      throw new Error(
        'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
      );
    }
    return normalizedSandbox.replace(/\/$/, "");
  }

  if (params.allowHostControl === false) {
    throw new Error("Host browser control is disabled by sandbox policy.");
  }
  if (!resolved.enabled) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.openclaw/openclaw.json.",
    );
  }
  return undefined;
}

const DEFAULT_EXISTING_SESSION_MANAGE_TIMEOUT_MS = 45_000;
const EXISTING_SESSION_MANAGE_ACTIONS = new Set([
  "status",
  "start",
  "stop",
  "profiles",
  "tabs",
  "open",
  "focus",
  "close",
]);

function hasExistingSessionProfile(resolved: ReturnType<typeof resolveBrowserConfig>) {
  return Object.keys(resolved.profiles).some((name) => {
    const candidate = resolveProfile(resolved, name);
    return candidate ? getBrowserProfileCapabilities(candidate).usesChromeMcp : false;
  });
}

export function resolveBrowserToolTimeoutMs({
  requestedTimeoutMs,
  action,
  isUserBrowserProfile,
  resolvedBrowser,
}: {
  requestedTimeoutMs?: number;
  action: string;
  isUserBrowserProfile: boolean;
  resolvedBrowser: ReturnType<typeof resolveBrowserConfig>;
}) {
  return (
    requestedTimeoutMs ??
    (EXISTING_SESSION_MANAGE_ACTIONS.has(action) &&
    (isUserBrowserProfile || (action === "profiles" && hasExistingSessionProfile(resolvedBrowser)))
      ? DEFAULT_EXISTING_SESSION_MANAGE_TIMEOUT_MS
      : undefined)
  );
}
