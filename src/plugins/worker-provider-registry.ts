/** Deterministic lookup helpers for plugin-registered cloud-worker providers. */
import { normalizeCapabilityProviderId } from "./provider-registry-shared.js";
import type { PluginRegistry } from "./registry-types.js";
import type { WorkerProvider } from "./types.js";

type WorkerProviderRegistryView = Pick<PluginRegistry, "workerProviders">;
type WorkerProviderValidation = { ok: true; id: string } | { ok: false; message: string };

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
    provider.provisionBeforeInstallation !== undefined &&
    typeof provider.provisionBeforeInstallation !== "boolean"
  ) {
    return {
      ok: false,
      message: "worker provider registration provisionBeforeInstallation must be a boolean",
    };
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
