import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginRegistry } from "../plugins/registry-types.js";

/** Records OAuth renewal owners once for an immutable prepared runtime generation. */
export function resolvePreparedOAuthRefreshProviderIds(params: {
  oauthProviders: readonly { id: string }[];
  providerRegistrations: readonly PluginRegistry["providers"][number][];
}): readonly string[] {
  const providerIds = new Set(
    params.oauthProviders.map((provider) => normalizeProviderId(provider.id)).filter(Boolean),
  );
  for (const registration of params.providerRegistrations) {
    if (!registration.provider.refreshOAuth) {
      continue;
    }
    for (const providerId of [
      registration.provider.id,
      ...(registration.provider.aliases ?? []),
      ...(registration.provider.hookAliases ?? []),
    ]) {
      const normalized = normalizeProviderId(providerId);
      if (normalized) {
        providerIds.add(normalized);
      }
    }
  }
  return Object.freeze([...providerIds].toSorted((left, right) => left.localeCompare(right)));
}
