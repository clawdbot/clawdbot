import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";

export type DeclaredProviderOwnerIndex = ReadonlyMap<string, ReadonlySet<string>>;

type ProviderOwnerManifest = {
  id: string;
  providers: readonly string[];
  setup?: { providers?: readonly { id: string }[] };
};

/** Captures declared receivers independently from plugins triggered by a provider. */
export function buildDeclaredProviderOwnerIndex(
  manifests: readonly ProviderOwnerManifest[],
): DeclaredProviderOwnerIndex {
  const winners = new Map<string, ProviderOwnerManifest>();
  for (const plugin of manifests) {
    if (!winners.has(plugin.id)) {
      winners.set(plugin.id, plugin);
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const phase of ["runtime", "setup"] as const) {
    const runtimeRefs = new Set(owners.keys());
    for (const plugin of winners.values()) {
      const refs =
        phase === "runtime"
          ? plugin.providers
          : (plugin.setup?.providers?.map((entry) => entry.id) ?? []);
      for (const ref of refs) {
        const normalized = normalizeProviderId(ref);
        if (phase === "setup" && runtimeRefs.has(normalized)) {
          continue;
        }
        const ids = owners.get(normalized) ?? new Set<string>();
        ids.add(plugin.id);
        owners.set(normalized, ids);
      }
    }
  }
  return owners;
}

export function matchesDeclaredProviderOwner(
  owners: DeclaredProviderOwnerIndex | undefined,
  provider: string,
  pluginId: string,
): boolean {
  return owners?.get(normalizeProviderId(provider))?.has(pluginId) ?? true;
}
