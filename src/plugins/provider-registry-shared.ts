// Shares provider registry normalization helpers across plugin paths.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

/** Normalizes provider ids used by capability-provider registries. */
export function normalizeCapabilityProviderId(providerId: string | undefined): string | undefined {
  const normalized = normalizeOptionalLowercaseString(providerId);
  return normalized && !isBlockedObjectKey(normalized) ? normalized : undefined;
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
