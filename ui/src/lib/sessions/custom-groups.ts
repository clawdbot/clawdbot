// Pure helpers for the gateway-owned custom session group catalog.
// Catalog storage and member updates live on the gateway (sessions.groups.*);
// the SessionCapability mirrors the catalog into state.groups.

/** Move one custom group before another while preserving every other group. */
export function reorderSessionCustomGroups(
  groups: readonly string[],
  source: string,
  target: string,
  position: "before" | "after" = "before",
): string[] {
  const ordered = [...new Set(groups.map((name) => name.trim()).filter(Boolean))];
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
