// Builds setup descriptors from plugin provider and manifest metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginManifestRecord } from "./manifest-registry.js";

type SetupDescriptorRecord = Pick<
  PluginManifestRecord,
  "providers" | "cliBackends" | "providerAuthAliases" | "setup"
>;

/** Lists setup provider ids and auth aliases owned by one plugin manifest. */
export function listSetupProviderIds(record: SetupDescriptorRecord): readonly string[] {
  const providerIds = record.setup?.providers?.map((entry) => entry.id) ?? record.providers;
  const normalizedProviderIds = new Set(providerIds.map(normalizeProviderId));
  const aliases = Object.entries(record.providerAuthAliases ?? {})
    .filter(([, target]) => normalizedProviderIds.has(normalizeProviderId(target)))
    .map(([alias]) => alias);
  return [...providerIds, ...aliases];
}

/** Lists setup CLI backend ids from setup metadata or manifest contribution ids. */
export function listSetupCliBackendIds(record: SetupDescriptorRecord): readonly string[] {
  return record.setup?.cliBackends ?? record.cliBackends;
}
