import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateCloudWorkerProfileSettings } from "../config/zod-schema.cloud-workers.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { normalizePluginsConfig } from "./config-state.js";
import { passesManifestOwnerBasePolicy } from "./manifest-owner-policy.js";
import { normalizeCapabilityProviderId } from "./provider-registry-shared.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import type { WorkerProfile } from "./types.js";
import { collectConfiguredWorkerProviderIds } from "./worker-provider-config.js";

function configuredSettings(config: OpenClawConfig, providerId: string) {
  return Object.entries(config.cloudWorkers?.profiles ?? {})
    .filter(([, profile]) => normalizeCapabilityProviderId(profile.provider) === providerId)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([id, profile]) => [id, profile.settings ?? {}] as const);
}

/** Maintains configured providers without loading plugins or borrowing a successor's authority. */
export async function maintainConfiguredWorkerProviders(params: {
  getRegistry: () => PluginRegistry;
  getConfig: () => OpenClawConfig;
  signal: AbortSignal;
  warn: (message: string) => void;
}): Promise<void> {
  const registry = params.getRegistry();
  const config = params.getConfig();
  if (params.signal.aborted) {
    return;
  }
  const pluginPolicy = structuredClone(config.plugins);
  const normalizedConfig = normalizePluginsConfig(config.plugins);
  const tasks = collectConfiguredWorkerProviderIds(config).flatMap((providerId) => {
    const registration = registry.workerProviders.get(providerId);
    const provider = registration?.provider;
    const maintain = provider?.maintain;
    const owner = registry.plugins.find((record) => record.id === registration?.pluginId);
    const isOwnerCurrent = owner && capturePluginLifecycleAuthority(registry, owner);
    if (!registration || !provider || !maintain || !owner || !isOwnerCurrent?.()) {
      return [];
    }
    if (!passesManifestOwnerBasePolicy({ plugin: owner, normalizedConfig })) {
      return [];
    }
    const settings = configuredSettings(config, providerId);
    if (settings.some(([, value]) => validateCloudWorkerProfileSettings(value) !== undefined)) {
      params.warn(
        `Worker provider maintenance skipped invalid settings (${providerId.slice(0, 128)})`,
      );
      return [];
    }
    const snapshot = structuredClone(settings);
    return [
      async () => {
        let active = true;
        const assertCurrent = () => {
          params.signal.throwIfAborted();
          const currentConfig = params.getConfig();
          if (
            !active ||
            params.getRegistry() !== registry ||
            registry.workerProviders.get(providerId) !== registration ||
            provider.maintain !== maintain ||
            !isOwnerCurrent() ||
            !isDeepStrictEqual(currentConfig.plugins, pluginPolicy) ||
            !isDeepStrictEqual(configuredSettings(currentConfig, providerId), snapshot)
          ) {
            throw new Error("Worker provider maintenance is no longer current");
          }
        };
        try {
          assertCurrent();
          await maintain.call(provider, {
            // SAFETY: validateCloudWorkerProfileSettings checked every setting as bounded finite JSON before cloning.
            profiles: structuredClone(snapshot.map(([, value]) => value)) as WorkerProfile[],
            signal: params.signal,
            assertCurrent,
          });
        } catch {
          if (!params.signal.aborted) {
            params.warn(`Worker provider maintenance failed (${providerId.slice(0, 128)})`);
          }
        } finally {
          // A retained callback cannot authorize effects after its invocation has settled.
          active = false;
        }
      },
    ];
  });
  await runTasksWithConcurrency({ tasks, limit: 4 });
}
