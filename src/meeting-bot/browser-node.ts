import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import { resolveBrowserNodeDelegationRuntime } from "../plugins/runtime/browser-node-delegation.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type {
  MeetingBrowserRequestCaller,
  MeetingBrowserRequestParams,
  MeetingPlatformAdapter,
} from "./platform-adapter-contract.js";
import type { MeetingBrowserHealth, MeetingTranscriptSnapshot } from "./session-types.js";

export type MeetingBrowserNodeInfo = {
  caps?: string[];
  commands?: string[];
  connected?: boolean;
  nodeId?: string;
  displayName?: string;
  remoteIp?: string;
};

type NodeAdapter = Pick<
  MeetingPlatformAdapter<unknown, string, MeetingBrowserHealth, MeetingTranscriptSnapshot>,
  "displayName" | "nodeCommandName" | "nodeConfigPath"
>;

function isMeetingBrowserNode(node: MeetingBrowserNodeInfo, adapter: NodeAdapter) {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  const caps = Array.isArray(node.caps) ? node.caps : [];
  return (
    node.connected === true &&
    commands.includes(adapter.nodeCommandName) &&
    (commands.includes("browser.proxy") || caps.includes("browser"))
  );
}

function matchesRequestedNode(node: MeetingBrowserNodeInfo, requested: string): boolean {
  return [node.nodeId, node.displayName, node.remoteIp].some((value) => value === requested);
}

function formatNodeLabel(node: MeetingBrowserNodeInfo): string {
  const parts = [node.displayName, node.nodeId, node.remoteIp].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "unknown node";
}

function describeNodeUsabilityIssues(node: MeetingBrowserNodeInfo, adapter: NodeAdapter): string[] {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const issues: string[] = [];
  if (node.connected !== true) {
    issues.push("offline");
  }
  if (!commands.includes(adapter.nodeCommandName)) {
    issues.push(`missing ${adapter.nodeCommandName}`);
  }
  if (!commands.includes("browser.proxy") && !caps.includes("browser")) {
    issues.push("missing browser.proxy/browser capability");
  }
  return issues;
}

async function listMeetingNodes(
  runtime: PluginRuntime,
  adapter: NodeAdapter,
  params?: { connected?: boolean },
): Promise<{ nodes: MeetingBrowserNodeInfo[] }> {
  try {
    return params ? await runtime.nodes.list(params) : await runtime.nodes.list();
  } catch (error) {
    throw new Error(`${adapter.displayName} node inventory unavailable`, { cause: error });
  }
}

export async function resolveMeetingBrowserNodeInfo(params: {
  runtime: PluginRuntime;
  adapter: NodeAdapter;
  requestedNode?: string;
}): Promise<MeetingBrowserNodeInfo> {
  const requested = params.requestedNode?.trim();
  if (requested) {
    const list = await listMeetingNodes(params.runtime, params.adapter);
    const matches = list.nodes.filter((node) => matchesRequestedNode(node, requested));
    if (matches.length > 1) {
      throw new Error(
        `Configured ${params.adapter.displayName} node ${requested} is ambiguous (${matches.length} matches). Pin ${params.adapter.nodeConfigPath} to a unique node id, display name, or remote IP.`,
      );
    }
    const [node] = matches;
    if (!node) {
      throw new Error(
        `Configured ${params.adapter.displayName} node ${requested} was not found. Run \`openclaw nodes status\` and start or approve the Chrome node.`,
      );
    }
    if (isMeetingBrowserNode(node, params.adapter)) {
      return node;
    }
    throw new Error(
      `Configured ${params.adapter.displayName} node ${requested} is not usable (${formatNodeLabel(node)}): ${describeNodeUsabilityIssues(node, params.adapter).join("; ")}. Start or reinstall \`openclaw node run\` on that Chrome host, approve pairing, and allow ${params.adapter.nodeCommandName} plus browser.proxy.`,
    );
  }

  const list = await listMeetingNodes(params.runtime, params.adapter, { connected: true });
  const nodes = list.nodes.filter((node) => isMeetingBrowserNode(node, params.adapter));
  const [node] = nodes;
  if (!node) {
    throw new Error(
      `No connected ${params.adapter.displayName}-capable node with browser proxy. Run \`openclaw node run\` on the Chrome host with browser proxy enabled, approve pairing, and allow ${params.adapter.nodeCommandName} plus browser.proxy.`,
    );
  }
  if (nodes.length === 1) {
    return node;
  }
  throw new Error(
    `Multiple ${params.adapter.displayName}-capable nodes connected. Set ${params.adapter.nodeConfigPath}.`,
  );
}

export async function resolveMeetingBrowserNode(params: {
  runtime: PluginRuntime;
  adapter: NodeAdapter;
  requestedNode?: string;
}): Promise<string> {
  const node = await resolveMeetingBrowserNodeInfo(params);
  if (!node.nodeId) {
    throw new Error(`${params.adapter.displayName} node did not include a node id.`);
  }
  return node.nodeId;
}

/** Keeps the public helper compatible while routing through the Browser Gateway owner. */
export async function callMeetingBrowserProxyOnNode(
  params: {
    runtime: PluginRuntime;
    adapter: NodeAdapter;
    nodeId: string;
    browserRouting?: "legacy" | "browser-steward";
  } & MeetingBrowserRequestParams,
) {
  const browser = resolveBrowserNodeDelegationRuntime(params.runtime);
  if (params.browserRouting === "browser-steward") {
    if (!browser) {
      throw new Error("Browser-owned node delegation is unavailable");
    }
    return await browser.request({
      method: params.method,
      path: params.path,
      ...(params.body !== undefined ? { body: params.body } : {}),
      timeoutMs: params.timeoutMs,
      nodeId: params.nodeId,
    });
  }
  if (browser) {
    return await browser.request({
      method: params.method,
      path: params.path,
      ...(params.body !== undefined ? { body: params.body } : {}),
      timeoutMs: params.timeoutMs,
      nodeId: params.nodeId,
    });
  }
  if (!(await params.runtime.gateway.isAvailable())) {
    throw new Error(`${params.adapter.displayName} Browser Gateway is unavailable`);
  }
  return await params.runtime.gateway.request(
    "browser.request",
    {
      method: params.method,
      path: params.path,
      ...(params.body !== undefined ? { body: params.body } : {}),
      timeoutMs: params.timeoutMs,
      nodeId: params.nodeId,
      legacyMeetingRuntime: true,
      allowAutomaticHostFallback: false,
    },
    {
      timeoutMs: addTimerTimeoutGraceMs(params.timeoutMs) ?? 1,
      scopes: ["operator.admin"],
    },
  );
}

export function createMeetingBrowserNodeCaller(params: {
  runtime: PluginRuntime;
  adapter: NodeAdapter;
  nodeId: string;
}): MeetingBrowserRequestCaller {
  return async (request) =>
    await callMeetingBrowserProxyOnNode({
      runtime: params.runtime,
      adapter: params.adapter,
      nodeId: params.nodeId,
      ...request,
    });
}
