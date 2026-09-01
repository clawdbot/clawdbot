// Node resolution helpers resolve node references from names, ids, and URLs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { type NodeMatchCandidate, resolveNodeIdFromCandidates } from "./node-match.js";

type ResolveNodeFromListOptions<TNode extends NodeMatchCandidate> = {
  allowDefault?: boolean;
  allowCompactDisplayName?: boolean;
  pickDefaultNode?: (nodes: TNode[]) => TNode | null;
};

/** Resolves a user query to a node id, optionally using a caller-defined blank-query default. */
export function resolveNodeIdFromNodeList<TNode extends NodeMatchCandidate>(
  nodes: TNode[],
  query?: string,
  options: ResolveNodeFromListOptions<TNode> = {},
): string {
  const q = normalizeOptionalString(query) ?? "";
  if (!q) {
    if (options.allowDefault === true && options.pickDefaultNode) {
      const picked = options.pickDefaultNode(nodes);
      if (picked) {
        return picked.nodeId;
      }
    }
    throw new Error("node required");
  }
  return resolveNodeIdFromCandidates(nodes, q, options.allowCompactDisplayName);
}

/** Resolves a full node entry, preserving synthetic defaults returned by the picker. */
export function resolveNodeFromNodeList<TNode extends NodeMatchCandidate>(
  nodes: TNode[],
  query?: string,
  options: ResolveNodeFromListOptions<TNode> = {},
): TNode {
  const nodeId = resolveNodeIdFromNodeList(nodes, query, options);
  // Default pickers may return a node not present in the original list; keep that id usable.
  return nodes.find((node) => node.nodeId === nodeId) ?? ({ nodeId } as TNode);
}

/** Caller-supplied error wording for capability-gated node selection. */
export type EligibleNodeMessages<TNode extends NodeMatchCandidate> = {
  /** Exact-id match that is not eligible; `eligibleIds` is sorted or "none". */
  ineligibleExact: (query: string, eligibleIds: string) => string;
  /** Display-name/query resolution among eligible nodes failed. */
  nameResolveFailed: (reason: string, eligibleIds: string) => string;
  /** No eligible node exists. */
  noneEligible: () => string;
  /** Several eligible nodes exist and no query disambiguates them. */
  multipleEligible: (eligible: TNode[]) => string;
};

function formatNodeIdList(nodes: NodeMatchCandidate[]): string {
  return nodes.length > 0
    ? nodes
        .map((node) => node.nodeId)
        .toSorted()
        .join(", ")
    : "none";
}

/**
 * Resolves a capability-gated node from the full node list. Exact ids are
 * checked before eligible-name resolution so an ineligible id cannot redirect
 * to an eligible node that shares its display name.
 */
export function resolveEligibleNodeFromList<TNode extends NodeMatchCandidate>(
  nodes: TNode[],
  query: string | undefined,
  isEligible: (node: TNode) => boolean,
  messages: EligibleNodeMessages<TNode>,
): TNode {
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
      const nodeId = resolveNodeIdFromNodeList(eligible, trimmed);
      const match = eligible.find((node) => node.nodeId === nodeId);
      if (match) {
        return match;
      }
    } catch (error) {
      throw new Error(messages.nameResolveFailed(formatErrorMessage(error), eligibleIds), {
        cause: error,
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
