/**
 * Nodes lookup helpers.
 *
 * Loads paired nodes from Gateway and resolves requested/default nodes with legacy pair-list fallback.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { parseNodeList, parsePairingList } from "../../shared/node-list-parse.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { resolveNodeFromNodeList, resolveNodeIdFromNodeList } from "../../shared/node-resolve.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

export type { NodeListNode };

type DefaultNodeFallback = "none" | "first";

type DefaultNodeSelectionOptions = {
  capability?: string;
  fallback?: DefaultNodeFallback;
  preferLocalMac?: boolean;
};

async function loadNodes(opts: GatewayCallOptions, signal?: AbortSignal): Promise<NodeListNode[]> {
  try {
    const res = await callGatewayTool("node.list", opts, {}, { signal });
    return parseNodeList(res);
  } catch (error) {
    if (
      !(error instanceof GatewayClientRequestError) ||
      error.gatewayCode !== "INVALID_REQUEST" ||
      error.retryable ||
      error.message !== "unknown method: node.list" ||
      (error.retryAfterMs !== undefined &&
        (!Number.isInteger(error.retryAfterMs) || error.retryAfterMs < 0))
    ) {
      throw error;
    }
    // Older gateways only expose paired-node state; preserve node tools until node.list exists.
    const res = await callGatewayTool("node.pair.list", opts, {}, { signal });
    const { paired } = parsePairingList(res);
    return paired.map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      platform: n.platform,
      remoteIp: n.remoteIp,
    }));
  }
}

function isLocalMacNode(node: NodeListNode): boolean {
  return (
    normalizeOptionalLowercaseString(node.platform)?.startsWith("mac") === true &&
    typeof node.nodeId === "string" &&
    node.nodeId.startsWith("mac-")
  );
}

function compareNewestTimestamp(a?: number, b?: number): number {
  const aValue = Number.isFinite(a) ? (a ?? 0) : -1;
  const bValue = Number.isFinite(b) ? (b ?? 0) : -1;
  return bValue - aValue;
}

function compareDefaultNodeOrder(
  a: NodeListNode,
  b: NodeListNode,
  recencyField: "connectedAtMs" | "lastSeenAtMs",
): number {
  const recencyOrder = compareNewestTimestamp(a[recencyField], b[recencyField]);
  if (recencyOrder !== 0) {
    return recencyOrder;
  }
  return a.nodeId.localeCompare(b.nodeId);
}

/** Selects the implicit node target when a tool call omits an explicit node query. */
export function selectDefaultNodeFromList(
  nodes: NodeListNode[],
  options: DefaultNodeSelectionOptions = {},
): NodeListNode | null {
  const capability = options.capability?.trim();
  const withCapability = capability
    ? nodes.filter((n) => (Array.isArray(n.caps) ? n.caps.includes(capability) : true))
    : nodes;
  if (withCapability.length === 0) {
    return null;
  }

  const connected = withCapability.filter((n) => n.connected);
  const candidates = connected.length > 0 ? connected : withCapability;
  if (candidates.length === 1) {
    return candidates.at(0) ?? null;
  }

  const preferLocalMac = options.preferLocalMac ?? true;
  if (preferLocalMac) {
    const local = candidates.filter(isLocalMacNode);
    if (local.length === 1) {
      return local.at(0) ?? null;
    }
  }

  const fallback = options.fallback ?? "none";
  if (fallback === "none") {
    return null;
  }

  // Once the pool is known to be offline, stale connection timestamps must not
  // outrank the durable last-seen signal used to choose the wake target.
  const recencyField = connected.length > 0 ? "connectedAtMs" : "lastSeenAtMs";
  const ordered = [...candidates].toSorted((a, b) => compareDefaultNodeOrder(a, b, recencyField));
  return ordered[0] ?? null;
}

function pickDefaultNode(nodes: NodeListNode[]): NodeListNode | null {
  return selectDefaultNodeFromList(nodes, {
    capability: "canvas",
    fallback: "first",
    preferLocalMac: true,
  });
}

/** Lists Gateway nodes, falling back to paired-node records for older Gateway versions. */
export async function listNodes(
  opts: GatewayCallOptions,
  signal?: AbortSignal,
): Promise<NodeListNode[]> {
  return loadNodes(opts, signal);
}

/** Resolves a node id from an already-loaded node list using shared node matching rules. */
export function resolveNodeIdFromList(
  nodes: NodeListNode[],
  query?: string,
  allowDefault = false,
  options: { allowCompactDisplayName?: boolean } = {},
): string {
  return resolveNodeIdFromNodeList(nodes, query, {
    allowDefault,
    allowCompactDisplayName: options.allowCompactDisplayName,
    pickDefaultNode,
  });
}

/** Loads nodes from the Gateway and resolves the requested or default node id. */
export async function resolveAgentNodeId(
  opts: GatewayCallOptions,
  query?: string,
  allowDefault = false,
) {
  return (await resolveAgentNode(opts, query, allowDefault)).nodeId;
}

/** Loads nodes from the Gateway and returns the requested or default node record. */
export async function resolveAgentNode(
  opts: GatewayCallOptions,
  query?: string,
  allowDefault = false,
): Promise<NodeListNode> {
  const nodes = await loadNodes(opts);
  return resolveNodeFromNodeList(nodes, query, {
    allowDefault,
    pickDefaultNode,
  });
}
