// Persisted settings normalizers shared by the settings storage owner.

/** Unknown shapes fall back to []; stale and duplicate ids are dropped. */
export function normalizePinnedAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const pinned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const agentId = entry.trim();
    if (agentId && !pinned.includes(agentId)) {
      pinned.push(agentId);
    }
  }
  return pinned;
}
