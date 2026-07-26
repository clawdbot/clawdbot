// Pure helpers for custom session groups and their sidebar section tokens.
// Catalog storage and member updates live on the gateway (sessions.groups.*);
// the SessionCapability mirrors the catalog into state.groups.

const BUILT_IN_SESSION_SECTION_IDS = new Set(["ungrouped", "groups", "work"]);

export function readSessionCustomGroupNames(payload: unknown): string[] {
  const groups = (payload as { groups?: Array<{ name?: unknown }> } | null)?.groups;
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups.flatMap((group) =>
    typeof group?.name === "string" && group.name.trim() ? [group.name.trim()] : [],
  );
}

/** Validate and deduplicate a persisted partial section order. */
export function normalizeSessionSectionOrderTokens(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    let token: string | null = null;
    if (BUILT_IN_SESSION_SECTION_IDS.has(entry)) {
      token = entry;
    } else if (entry.startsWith("category:")) {
      const name = entry.slice("category:".length).trim();
      token = name ? `category:${name}` : null;
    }
    if (token && !normalized.includes(token)) {
      normalized.push(token);
    }
  }
  return normalized;
}

/** Move one entry relative to another while preserving every other entry. */
export function moveSessionOrderEntry(
  order: readonly string[],
  source: string,
  target: string,
  position: "before" | "after",
): string[] {
  const ordered = [...order];
  const sourceIndex = ordered.indexOf(source);
  const targetIndex = ordered.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return ordered;
  }
  const [moved] = ordered.splice(sourceIndex, 1);
  if (!moved) {
    return ordered;
  }
  const targetInsertionIndex = ordered.indexOf(target) + (position === "after" ? 1 : 0);
  ordered.splice(targetInsertionIndex, 0, moved);
  return ordered;
}
