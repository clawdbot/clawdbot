import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

/** Normalizes provider ids used by capability-provider registries. */
export function normalizeCapabilityProviderId(providerId: string | undefined): string | undefined {
  const normalized = normalizeOptionalLowercaseString(providerId);
  return normalized && !isBlockedObjectKey(normalized) ? normalized : undefined;
}

// Canonical ids take precedence over aliases; ties retain registry order.
export function findCapabilityProviderEntry<
  T extends { provider: { id: string; aliases?: readonly string[] } },
>(entries: readonly T[], providerId: string): T | undefined {
  const normalizedProviderId = normalizeCapabilityProviderId(providerId);
  if (!normalizedProviderId) {
    return undefined;
  }
  return (
    entries.find(
      ({ provider }) =>
        isRecord(provider) && normalizeCapabilityProviderId(provider.id) === normalizedProviderId,
    ) ??
    entries.find(
      ({ provider }) =>
        isRecord(provider) &&
        Array.isArray(provider.aliases) &&
        provider.aliases.some(
          (alias) =>
            typeof alias === "string" &&
            normalizeCapabilityProviderId(alias) === normalizedProviderId,
        ),
    )
  );
}

export function matchesProviderPluginRef(
  provider: { id: string; aliases?: readonly string[]; hookAliases?: readonly string[] },
  providerId: string,
): boolean {
  const normalized = normalizeProviderId(providerId);
  return Boolean(
    normalized &&
    (normalizeProviderId(provider.id) === normalized ||
      [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
        (alias) => normalizeProviderId(alias) === normalized,
      )),
  );
}

/** Preserves ordered alias overrides, including aliases of replaced canonical entries. */
export function buildCapabilityProviderIndex<T extends { id: string; aliases?: readonly string[] }>(
  providers: readonly T[],
  mode: "canonical" | "aliases",
): Map<string, T> {
  const index = new Map<string, T>();

  for (const provider of providers) {
    const id = normalizeCapabilityProviderId(provider.id);
    if (!id) {
      continue;
    }
    index.set(id, provider);
    if (mode === "canonical") {
      continue;
    }
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeCapabilityProviderId(alias);
      if (normalizedAlias) {
        index.set(normalizedAlias, provider);
      }
    }
  }

  return index;
}
