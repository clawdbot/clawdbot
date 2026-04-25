import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

type BrowserProxyResult = {
  result?: unknown;
};

export type BrowserTab = {
  targetId?: string;
  title?: string;
  url?: string;
};

export function normalizeMeetUrlForReuse(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "meet.google.com") {
      return undefined;
    }
    const match = parsed.pathname.match(/^\/(new|[a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/)?$/i);
    if (!match?.[1]) {
      return undefined;
    }
    return `https://meet.google.com/${match[1].toLowerCase()}`;
  } catch {
    return undefined;
  }
}

export function isSameMeetUrlForReuse(a: string | undefined, b: string | undefined): boolean {
  const normalizedA = normalizeMeetUrlForReuse(a);
  const normalizedB = normalizeMeetUrlForReuse(b);
  return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
}

export type GoogleMeetNodeInfo = {
  caps?: string[];
  commands?: string[];
  connected?: boolean;
  nodeId?: string;
  displayName?: string;
  remoteIp?: string;
};

function isGoogleMeetNode(node: GoogleMeetNodeInfo) {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  const caps = Array.isArray(node.caps) ? node.caps : [];
  return (
    node.connected === true &&
    commands.includes("googlemeet.chrome") &&
    (commands.includes("browser.proxy") || caps.includes("browser"))
  );
}

export async function resolveChromeNodeInfo(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
}): Promise<GoogleMeetNodeInfo> {
  const list = await params.runtime.nodes.list({ connected: true });
  const nodes = list.nodes.filter(isGoogleMeetNode);
  if (nodes.length === 0) {
    throw new Error(
      "No connected Google Meet-capable node with browser proxy. Run `openclaw node run` on the Chrome host with browser proxy enabled, approve pairing, and allow googlemeet.chrome plus browser.proxy.",
    );
  }
  const requested = params.requestedNode?.trim();
  if (requested) {
    const matches = nodes.filter((node) =>
      [node.nodeId, node.displayName, node.remoteIp].some((value) => value === requested),
    );
    if (matches.length === 1) {
      return matches[0];
    }
    throw new Error(`Google Meet node not found or ambiguous: ${requested}`);
  }
  if (nodes.length === 1) {
    return nodes[0];
  }
  throw new Error(
    "Multiple Google Meet-capable nodes connected. Set plugins.entries.google-meet.config.chromeNode.node.",
  );
}

export async function resolveChromeNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
}): Promise<string> {
  const node = await resolveChromeNodeInfo(params);
  if (!node.nodeId) {
    throw new Error("Google Meet node did not include a node id.");
  }
  return node.nodeId;
}

function unwrapNodeInvokePayload(raw: unknown): unknown {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof record.payloadJSON === "string" && record.payloadJSON.trim()) {
    return JSON.parse(record.payloadJSON);
  }
  if ("payload" in record) {
    return record.payload;
  }
  return raw;
}

function parseBrowserProxyResult(raw: unknown): unknown {
  const payload = unwrapNodeInvokePayload(raw);
  const proxy =
    payload && typeof payload === "object" ? (payload as BrowserProxyResult) : undefined;
  if (!proxy || !("result" in proxy)) {
    throw new Error("Google Meet browser proxy returned an invalid result.");
  }
  return proxy.result;
}

export async function callBrowserProxyOnNode(params: {
  runtime: PluginRuntime;
  nodeId: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
}) {
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: "browser.proxy",
    params: {
      method: params.method,
      path: params.path,
      body: params.body,
      timeoutMs: params.timeoutMs,
    },
    timeoutMs: params.timeoutMs + 5_000,
  });
  return parseBrowserProxyResult(raw);
}

export function asBrowserTabs(result: unknown): BrowserTab[] {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  return Array.isArray(record.tabs) ? (record.tabs as BrowserTab[]) : [];
}

export function readBrowserTab(result: unknown): BrowserTab | undefined {
  return result && typeof result === "object" ? (result as BrowserTab) : undefined;
}
