import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type {
  MeetingBrowserRequestCaller,
  MeetingBrowserRequestParams,
  MeetingPlatformAdapter,
} from "./platform-adapter-contract.js";
import type { MeetingBrowserHealth, MeetingTranscriptSnapshot } from "./session-types.js";

type BrowserProxyResult = { result?: unknown };

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

function unwrapNodeInvokePayload(raw: unknown, adapter: NodeAdapter): unknown {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof record.payloadJSON === "string" && record.payloadJSON.trim()) {
    try {
      return JSON.parse(record.payloadJSON);
    } catch (error) {
      throw new Error(`${adapter.displayName} browser proxy returned malformed payloadJSON.`, {
        cause: error,
      });
    }
  }
  if ("payload" in record) {
    return record.payload;
  }
  return raw;
}

function parseBrowserProxyResult(raw: unknown, adapter: NodeAdapter): unknown {
  const payload = unwrapNodeInvokePayload(raw, adapter);
  const proxy =
    payload && typeof payload === "object" ? (payload as BrowserProxyResult) : undefined;
  if (!proxy || !("result" in proxy)) {
    throw new Error(`${adapter.displayName} browser proxy returned an invalid result.`);
  }
  return proxy.result;
}

export async function callMeetingBrowserProxyOnNode(
  params: {
    runtime: PluginRuntime;
    adapter: NodeAdapter;
    nodeId: string;
  } & MeetingBrowserRequestParams,
) {
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: "browser.proxy",
    params: {
      method: params.method,
      path: params.path,
      body: params.body,
      timeoutMs: params.timeoutMs,
    },
    timeoutMs: addTimerTimeoutGraceMs(params.timeoutMs) ?? 1,
    scopes: ["operator.admin"],
  });
  return parseBrowserProxyResult(raw, params.adapter);
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
