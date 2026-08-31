import { parseAgentSessionKey } from "../routing/session-key.js";

type CanonicalOwnerEvidenceItem = {
  canonicalKey: string;
  canonicalOwnerSessionKey?: string;
  sessionKey: string;
  storedKey: string;
  target: { agentId: string; sqlitePath: string };
};

/** Projects transcript-owner evidence through aliases and indexes every proven source key. */
export function applyCanonicalOwnerEvidence(
  inventory: CanonicalOwnerEvidenceItem[],
): Map<string, Set<string>> {
  const bySessionKey = new Map(
    inventory.map((item) => [`${item.target.sqlitePath}\0${item.sessionKey}`, item] as const),
  );
  const resolveCanonicalKey = (
    item: CanonicalOwnerEvidenceItem,
    seen = new Set<string>(),
  ): string => {
    if (!item.canonicalOwnerSessionKey) {
      return item.canonicalKey;
    }
    const identity = `${item.target.sqlitePath}\0${item.sessionKey}`;
    const owner = bySessionKey.get(`${item.target.sqlitePath}\0${item.canonicalOwnerSessionKey}`);
    if (!owner || seen.has(identity)) {
      return item.canonicalKey;
    }
    seen.add(identity);
    return owner.canonicalOwnerSessionKey ? resolveCanonicalKey(owner, seen) : owner.canonicalKey;
  };
  const canonicalKeysByStoredKey = new Map<string, Set<string>>();
  for (const item of inventory) {
    item.canonicalKey = resolveCanonicalKey(item);
    const ownerAgentId = parseAgentSessionKey(item.storedKey)?.agentId ?? item.target.agentId;
    // Never synthesize folded aliases from a canonical row: the lowercase peer may be a
    // distinct case-sensitive session whose row was pruned. Only inventoried keys are proof.
    for (const key of [item.sessionKey, item.storedKey]) {
      for (const sqlitePath of [item.target.sqlitePath, "*"]) {
        const mappingKey = `${sqlitePath}\0${ownerAgentId}\0${key}`;
        const mapped = canonicalKeysByStoredKey.get(mappingKey) ?? new Set<string>();
        mapped.add(item.canonicalKey);
        canonicalKeysByStoredKey.set(mappingKey, mapped);
      }
    }
  }
  return canonicalKeysByStoredKey;
}
