/**
 * Nodes lookup helpers.
 *
 * Loads paired nodes from Gateway and resolves requested/default nodes with legacy pair-list fallback.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
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
  options: { allowCompactDisplayName?: boolean } = {},
): string {
  return resolveNodeIdFromNodeList(nodes, query, {
    allowDefault,
    allowCompactDisplayName: options.allowCompactDisplayName,
    pickDefaultNode,
  });
}

/** Tool-supplied error wording for {@link resolveEligibleNodeFromList}. */
export type EligibleNodeMessages = {
  /** Explicit exact-id match that is not eligible; `eligibleIds` is the sorted list (or "none"). */
  ineligibleExact: (query: string, eligibleIds: string) => string;
  /** Display-name/query resolution among eligible nodes failed (unknown/ambiguous). */
  nameResolveFailed: (reason: string, eligibleIds: string) => string;
  /** No eligible node exists. */
  noneEligible: () => string;
  /** Several eligible nodes and no query to disambiguate. */
  multipleEligible: (eligible: NodeListNode[]) => string;
};

function formatNodeIdList(nodes: NodeListNode[]): string {
  return nodes.length > 0
    ? nodes
        .map((node) => node.nodeId)
        .toSorted()
        .join(", ")
    : "none";
}

/**
 * Resolves a capability-gated node from the FULL node list, keeping control off
 * the wrong device. An exact node-id match (case-sensitive, then -insensitive to
 * mirror display-name matching) is checked against every node first, so an
 * ineligible id can never fall through to an eligible node that merely shares its
 * display name. Display-name/query resolution runs only among eligible nodes and
 * rejects ambiguity. Any tool that filters nodes by capability must resolve
 * through here rather than handing a pre-filtered list to {@link resolveNodeIdFromList}.
 */
export function resolveEligibleNodeFromList(
  nodes: NodeListNode[],
  query: string | undefined,
  isEligible: (node: NodeListNode) => boolean,
  messages: EligibleNodeMessages,
): NodeListNode {
  const eligible = nodes.filter(isEligible);
  const trimmed = query?.trim();
  if (trimmed) {
    const eligibleIds = formatNodeIdList(eligible);
    const lowerTrimmed = trimmed.toLowerCase();
    const exactNode =
      nodes.find((node) => node.nodeId === trimmed) ??
      nodes.find((node) => node.nodeId.toLowerCase() === lowerTrimmed);
    if (exactNode) {
      if (!isEligible(exactNode)) {
        throw new Error(messages.ineligibleExact(trimmed, eligibleIds));
      }
      return exactNode;
    }
    try {
      const nodeId = resolveNodeIdFromList(eligible, trimmed, false);
      const match = eligible.find((node) => node.nodeId === nodeId);
      if (match) {
        return match;
      }
    } catch (err) {
      throw new Error(messages.nameResolveFailed(formatErrorMessage(err), eligibleIds), {
        cause: err,
      });
    }
    throw new Error(`node not found: ${trimmed}`);
  }
  const only = eligible.length === 1 ? eligible.at(0) : undefined;
  if (only) {
    return only;
  }
  if (eligible.length === 0) {
    throw new Error(messages.noneEligible());
  }
  throw new Error(messages.multipleEligible(eligible));
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
