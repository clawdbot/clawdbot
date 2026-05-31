import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { type NodeMatchCandidate, resolveNodeIdFromCandidates } from "./node-match.js";

type ResolveNodeFromListOptions<TNode extends NodeMatchCandidate> = {
  allowDefault?: boolean;
  pickDefaultNode?: (nodes: TNode[]) => TNode | null;
};

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

export function resolveNodeFromNodeList<TNode extends NodeMatchCandidate>(
  nodes: TNode[],
  query?: string,
  options: ResolveNodeFromListOptions<TNode> = {},
): TNode {
  const nodeId = resolveNodeIdFromNodeList(nodes, query, options);
  return nodes.find((node) => node.nodeId === nodeId) ?? ({ nodeId } as TNode);
}
