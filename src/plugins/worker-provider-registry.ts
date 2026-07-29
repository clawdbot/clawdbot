/** Deterministic lookup helpers for plugin-registered cloud-worker providers. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { normalizeCapabilityProviderId } from "./provider-registry-shared.js";
import type { PluginRegistry } from "./registry-types.js";
import type { WorkerProvider } from "./types.js";

type WorkerProviderRegistryView = Pick<PluginRegistry, "workerProviders">;
type WorkerProviderValidation = { ok: true; id: string } | { ok: false; message: string };

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function normalizeWorkerProviderIds(providerIds: readonly string[]): string[] {
  const normalized = providerIds
    .map(normalizeCapabilityProviderId)
    .filter((id): id is string => id !== undefined);
  return [...new Set(normalized)].toSorted(compareText);
}

export function collectConfiguredWorkerProviderIds(config: OpenClawConfig): string[] {
  return normalizeWorkerProviderIds(
    Object.values(config.cloudWorkers?.profiles ?? {}).map((profile) => profile.provider),
  );
}

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

/** Validates the provider methods, normalized id, and manifest ownership contract. */
export function validateWorkerProviderContract(
  provider: WorkerProvider,
  declaredIds: readonly string[],
): WorkerProviderValidation {
  const missingMethod = (["provision", "inspect", "destroy"] as const).find(
    (method) => typeof provider[method] !== "function",
  );
  if (missingMethod) {
    return { ok: false, message: `worker provider registration missing method: ${missingMethod}` };
  }
  if (provider.renew !== undefined && typeof provider.renew !== "function") {
    return { ok: false, message: "worker provider registration renew must be a function" };
  }
  if (
    provider.resolveSshIdentity !== undefined &&
    typeof provider.resolveSshIdentity !== "function"
  ) {
    return {
      ok: false,
      message: "worker provider registration resolveSshIdentity must be a function",
    };
  }
  const id = normalizeCapabilityProviderId(provider.id);
  if (!id) {
    return { ok: false, message: "worker provider registration missing valid id" };
  }
  const declared = declaredIds.some((candidate) => normalizeCapabilityProviderId(candidate) === id);
  return declared
    ? { ok: true, id }
    : { ok: false, message: `plugin must declare contracts.workerProviders for provider: ${id}` };
}
/** Resolves one provider by its normalized manifest capability id. */
export function resolveWorkerProvider(
  registry: WorkerProviderRegistryView,
  providerId: string,
): WorkerProvider | undefined {
  const normalizedId = normalizeCapabilityProviderId(providerId);
  return normalizedId ? registry.workerProviders.get(normalizedId)?.provider : undefined;
}
