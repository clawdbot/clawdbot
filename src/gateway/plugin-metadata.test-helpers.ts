import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

function ownerEntries(value: ReadonlyMap<string, readonly string[]>) {
  return [...value].map(([id, owners]) => [id, [...owners]] as const);
}

/** Verifies the manifest-derived fields of a trimmed metadata fixture agree. */
export function assertPluginMetadataSnapshotConsistency(snapshot: PluginMetadataSnapshot): void {
  const plugins = snapshot.manifestRegistry.plugins;
  const pluginIds = plugins.map((plugin) => plugin.id);
  if (JSON.stringify(snapshot.plugins.map((plugin) => plugin.id)) !== JSON.stringify(pluginIds)) {
    throw new Error("plugin metadata fixture registry and plugin list diverged");
  }
  if (snapshot.metrics.manifestPluginCount !== plugins.length) {
    throw new Error("plugin metadata fixture manifest count diverged");
  }
  if (snapshot.metrics.indexPluginCount !== snapshot.index.plugins.length) {
    throw new Error("plugin metadata fixture index count diverged");
  }

  const expectedProviderOwners = new Map<string, string[]>();
  const expectedCliBackendOwners = new Map<string, string[]>();
  const appendOwner = (owners: Map<string, string[]>, id: string, pluginId: string) => {
    const existing = owners.get(id) ?? [];
    if (!existing.includes(pluginId)) {
      owners.set(id, [...existing, pluginId]);
    }
  };

  for (const plugin of plugins) {
    if (snapshot.byPluginId.get(plugin.id) !== plugin) {
      throw new Error(`plugin metadata fixture lookup diverged for ${plugin.id}`);
    }
    const providers = new Set(plugin.providers);
    const cliBackends = new Set([...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])]);
    const authRefs = new Set([
      ...(plugin.providerAuthChoices ?? []).map((choice) => choice.choiceId),
      ...(plugin.providerAuthChoices ?? []).flatMap((choice) => choice.deprecatedChoiceIds ?? []),
    ]);

    for (const provider of providers) {
      appendOwner(expectedProviderOwners, provider, plugin.id);
    }
    for (const [alias, provider] of Object.entries(plugin.providerAuthAliases ?? {})) {
      if (typeof provider !== "string") {
        continue;
      }
      if (!providers.has(alias) || !providers.has(provider)) {
        throw new Error(`plugin metadata fixture alias ${alias} is outside ${plugin.id} providers`);
      }
      appendOwner(expectedProviderOwners, alias, plugin.id);
    }
    for (const choice of plugin.providerAuthChoices ?? []) {
      if (!providers.has(choice.provider)) {
        throw new Error(
          `plugin metadata fixture auth choice ${choice.choiceId} has an unknown provider`,
        );
      }
    }
    for (const backend of cliBackends) {
      appendOwner(expectedCliBackendOwners, normalizeProviderId(backend), plugin.id);
    }
    for (const ref of plugin.syntheticAuthRefs ?? []) {
      if (!providers.has(ref) && !cliBackends.has(ref) && !authRefs.has(ref)) {
        throw new Error(`plugin metadata fixture synthetic auth ref ${ref} has no owner`);
      }
    }
  }

  if (
    JSON.stringify(ownerEntries(snapshot.owners.providers)) !==
    JSON.stringify(ownerEntries(expectedProviderOwners))
  ) {
    throw new Error("plugin metadata fixture provider owners diverged");
  }
  if (
    JSON.stringify(ownerEntries(snapshot.owners.cliBackends)) !==
    JSON.stringify(ownerEntries(expectedCliBackendOwners))
  ) {
    throw new Error("plugin metadata fixture CLI backend owners diverged");
  }
}
