/**
 * Nodes lookup helpers.
 *
 * Loads paired nodes from Gateway and resolves requested/default nodes with legacy pair-list fallback.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
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

function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return "";
    }
  }
  return "";
}

function shouldFallbackToPairList(error: unknown): boolean {
  const message = normalizeOptionalLowercaseString(messageFromError(error)) ?? "";
  if (!message.includes("node.list")) {
    return false;
  }
  return (
    message.includes("unknown method") ||
    message.includes("method not found") ||
    message.includes("not implemented") ||
    message.includes("unsupported")
  );
}

async function loadNodes(opts: GatewayCallOptions, signal?: AbortSignal): Promise<NodeListNode[]> {
  try {
    const res = await callGatewayTool("node.list", opts, {}, { signal });
    return parseNodeList(res);
  } catch (error) {
    if (!shouldFallbackToPairList(error)) {
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

function compareDefaultNodeOrder(a: NodeListNode, b: NodeListNode): number {
  const aConnectedAt = Number.isFinite(a.connectedAtMs) ? (a.connectedAtMs ?? 0) : -1;
  const bConnectedAt = Number.isFinite(b.connectedAtMs) ? (b.connectedAtMs ?? 0) : -1;
  if (aConnectedAt !== bConnectedAt) {
    return bConnectedAt - aConnectedAt;
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
    return candidates[0];
  }

  const preferLocalMac = options.preferLocalMac ?? true;
  if (preferLocalMac) {
    const local = candidates.filter(isLocalMacNode);
    if (local.length === 1) {
      return local[0];
    }
  }

  const fallback = options.fallback ?? "none";
  if (fallback === "none") {
    return null;
  }

  const ordered = [...candidates].toSorted(compareDefaultNodeOrder);
  // Multiple candidates — pick the first connected canvas-capable node.
  // For A2UI and other canvas operations, any node works since multi-node
  // setups broadcast surfaces across devices.
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
): string {
  return resolveNodeIdFromNodeList(nodes, query, {
    allowDefault,
    pickDefaultNode,
  });
}

/** Loads nodes from the Gateway and resolves the requested or default node id. */
export async function resolveNodeId(
  opts: GatewayCallOptions,
  query?: string,
  allowDefault = false,
) {
  return (await resolveNode(opts, query, allowDefault)).nodeId;
}

/** Loads nodes from the Gateway and returns the requested or default node record. */
export async function resolveNode(
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
