const FEATURED_PROVIDER_AUTH_GROUP_ORDER = new Map<string, number>([
  ["openai", 0],
  ["openrouter", 1],
  ["xai", 2],
  ["google", 3],
  ["anthropic", 4],
]);

/** Keep native and CLI onboarding on one first-tier provider order. */
export function isFeaturedProviderAuthChoiceGroup(groupId: string): boolean {
  return FEATURED_PROVIDER_AUTH_GROUP_ORDER.has(groupId);
}

export function compareProviderAuthChoiceGroups(
  a: { id: string; label: string },
  b: { id: string; label: string },
): number {
  const priorityA = FEATURED_PROVIDER_AUTH_GROUP_ORDER.get(a.id) ?? Number.POSITIVE_INFINITY;
  const priorityB = FEATURED_PROVIDER_AUTH_GROUP_ORDER.get(b.id) ?? Number.POSITIVE_INFINITY;
  return (
    priorityA - priorityB ||
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
    a.id.localeCompare(b.id, undefined, { sensitivity: "base" })
  );
}
