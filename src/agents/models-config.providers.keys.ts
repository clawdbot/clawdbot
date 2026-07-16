/** Canonical provider-key handling shared by models.json merge boundaries. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";

export function normalizeProviderMapKeys<T>(
  providers: Record<string, T> | null | undefined,
): Record<string, T> {
  const normalized: Record<string, T> = {};
  const canonicalKeys = new Set<string>();
  for (const [key, value] of Object.entries(providers ?? {})) {
    const providerKey = normalizeProviderId(key);
    if (!providerKey) {
      continue;
    }
    if (key === providerKey) {
      canonicalKeys.add(providerKey);
      // A prior alias inserted this key at the alias's position. Reinsert it so
      // canonical spelling also controls deterministic provider order.
      delete normalized[providerKey];
      normalized[providerKey] = value;
      continue;
    }
    // Exact canonical spelling wins over aliases regardless of object order.
    // Without one, the later variant wins, matching existing trim-collision behavior.
    if (!canonicalKeys.has(providerKey)) {
      normalized[providerKey] = value;
    }
  }
  return normalized;
}
