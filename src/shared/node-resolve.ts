import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { type NodeMatchCandidate, resolveNodeIdFromCandidates } from "./node-match.js";

type ResolveNodeFromListOptions<TNode extends NodeMatchCandidate> = {
  allowDefault?: boolean;
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
  return resolveNodeIdFromCandidates(nodes, q);
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
