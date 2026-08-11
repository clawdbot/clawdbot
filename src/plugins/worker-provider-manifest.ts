import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { normalizeWorkerProviderIds } from "./worker-provider-id.js";

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function manifestOwnsWorkerProvider(
  manifest: PluginManifestRecord | undefined,
  providerIds: ReadonlySet<string>,
): boolean {
  return normalizeWorkerProviderIds(manifest?.contracts?.workerProviders ?? []).some((id) =>
    providerIds.has(id),
  );
}

export function listBundledWorkerProviderOwners(
  registry: PluginManifestRegistry,
  providerIds: readonly string[],
): Array<{ pluginId: string; providerId: string }> {
  const selected = new Set(normalizeWorkerProviderIds(providerIds));
  return registry.plugins
    .filter((plugin) => plugin.origin === "bundled")
    .flatMap((plugin) =>
      normalizeWorkerProviderIds(plugin.contracts?.workerProviders ?? [])
        .filter((providerId) => selected.has(providerId))
        .map((providerId) => ({ pluginId: plugin.id, providerId })),
    )
    .toSorted(
      (left, right) =>
        compareText(left.pluginId, right.pluginId) ||
        compareText(left.providerId, right.providerId),
    );
}

/** Auto-enable bundled owners needed to reconcile leases after profile removal. */
export function resolveDurableWorkerProviderAutoEnabledReasons(
  registry: PluginManifestRegistry,
  providerIds: readonly string[],
): Record<string, string[]> {
  const reasons: Record<string, string[]> = Object.create(null);
  for (const { pluginId, providerId } of listBundledWorkerProviderOwners(registry, providerIds)) {
    (reasons[pluginId] ??= []).push(`${providerId} durable worker lease`);
  }
  return reasons;
}
