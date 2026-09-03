// Node match helpers score and select nodes from names, ids, and addresses.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

/**
 * Shared node-selection policy for CLI, gateway-facing SDK helpers, and plugins.
 *
 * Exact ids, remote IPs, normalized display names, and long id prefixes are the
 * only accepted query shapes; fuzzy ordering lives here so callers agree.
 */

/** Node fields accepted by shared CLI/API node selection helpers. */
export type NodeMatchCandidate = {
  /** Stable node id used for RPC/session routing. */
  nodeId: string;
  /** Human-facing node name used for fuzzy operator input. */
  displayName?: string;
  /** Tailscale or network address accepted as an exact match. */
  remoteIp?: string;
  /** Connected nodes win only after the strongest match type is chosen. */
  connected?: boolean;
  /** Client id used to prefer current OpenClaw nodes over legacy migration ties. */
  clientId?: string;
};

/** Normalizes human node names into stable lookup keys for fuzzy CLI/API matching. */
function normalizeNodeKey(value: string) {
  // Emoji components can also be marks (variation selectors and keycaps); drop
  // them so decorated and plain display-name selectors stay equivalent.
  // Retain script marks only when attached to a surviving letter/number; marks
  // on stripped emoji or symbols must not become invisible selector bytes.
  const normalized = normalizeLowercaseStringOrEmpty(value.normalize("NFC"))
    .replace(/(?=\p{M})\p{Emoji_Component}/gu, "")
    .replace(/(?<![\p{L}\p{M}\p{N}])\p{M}+/gu, "");
  return normalized
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function compactNormalizedNodeKey(value: string) {
  return value.replace(/-/g, "");
}

function listKnownNodes(nodes: NodeMatchCandidate[]): string {
  return nodes
    .map((n) => n.displayName || n.remoteIp || n.nodeId)
    .filter(Boolean)
    .join(", ");
}

function formatNodeCandidateLabel(node: NodeMatchCandidate): string {
  const label = node.displayName || node.remoteIp || node.nodeId;
  const details = [`node=${node.nodeId}`];
  const clientId = normalizeOptionalString(node.clientId);
  if (clientId) {
    details.push(`client=${clientId}`);
  }
  return `${label} [${details.join(", ")}]`;
}

function isCurrentOpenClawClient(clientId: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(clientId) ?? "";
  return normalized.startsWith("openclaw-");
}

function isLegacyClawdbotClient(clientId: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(clientId) ?? "";
  return normalized.startsWith("clawdbot-") || normalized.startsWith("moldbot-");
}

function pickPreferredLegacyMigrationMatch(
  matches: NodeMatchCandidate[],
): NodeMatchCandidate | undefined {
  const current = matches.filter((match) => isCurrentOpenClawClient(match.clientId));
  if (current.length !== 1) {
    return undefined;
  }
  const legacyCount = matches.filter((match) => isLegacyClawdbotClient(match.clientId)).length;
  if (legacyCount === 0 || current.length + legacyCount !== matches.length) {
    return undefined;
  }
  // During Clawdbot -> OpenClaw migration, a unique current client should win only
  // when every other tie is a known legacy client for the same human-facing node.
  return current[0];
}

function resolveMatchScore(
  node: NodeMatchCandidate,
  query: string,
  queryNormalized: string,
  allowCompactDisplayName: boolean,
): number {
  // Match class outranks selection heuristics: exact ids beat IPs, names, and id prefixes.
  if (node.nodeId === query) {
    return 4_000;
  }
  if (typeof node.remoteIp === "string" && node.remoteIp === query) {
    return 3_000;
  }
  const name = typeof node.displayName === "string" ? node.displayName : "";
  const nameNormalized = name ? normalizeNodeKey(name) : "";
  if (nameNormalized && nameNormalized === queryNormalized) {
    return 2_000;
  }
  if (
    allowCompactDisplayName &&
    nameNormalized &&
    compactNormalizedNodeKey(nameNormalized) === compactNormalizedNodeKey(queryNormalized)
  ) {
    return 1_900;
  }
  if (query.length >= 6 && node.nodeId.startsWith(query)) {
    return 1_000;
  }
  return 0;
}

/** Resolves a single node id or throws an operator-readable unknown/ambiguous-node error. */
export function resolveNodeIdFromCandidates(
  nodes: NodeMatchCandidate[],
  query: string,
  allowCompactDisplayName = false,
): string {
  const q = query.trim();
  if (!q) {
    throw new Error("node required");
  }

  const normalized = normalizeNodeKey(q);
  const scoredMatches = nodes
    .map((node) => ({
      node,
      matchScore: resolveMatchScore(node, q, normalized, allowCompactDisplayName),
    }))
    .filter((match) => match.matchScore > 0);
  if (scoredMatches.length === 0) {
    const known = listKnownNodes(nodes);
    throw new Error(`unknown node: ${q}${known ? ` (known: ${known})` : ""}`);
  }

  const topMatchScore = Math.max(...scoredMatches.map((match) => match.matchScore));
  const strongestMatches = scoredMatches
    .filter((match) => match.matchScore === topMatchScore)
    .map((match) => match.node);

  // Connected state only breaks ties within the strongest match class. Client
  // identity may disambiguate known legacy migrations, never other current nodes.
  const connectedMatches = strongestMatches.filter((match) => match.connected === true);
  const matches = connectedMatches.length > 0 ? connectedMatches : strongestMatches;
  if (matches.length === 1) {
    return matches[0]?.nodeId ?? "";
  }

  const preferred = pickPreferredLegacyMigrationMatch(matches);
  if (preferred) {
    return preferred.nodeId;
  }

  throw new Error(
    `ambiguous node: ${q} (matches: ${matches.map(formatNodeCandidateLabel).join(", ")})`,
  );
}
