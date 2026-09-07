import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import {
  listAvailableManifestContractPlugins,
  loadManifestMetadataSnapshot,
} from "../plugins/manifest-contract-eligibility.js";
import {
  loadBundledWebSearchProviderEntriesFromDir,
  loadInstalledWebSearchProviderEntriesFromRoot,
} from "../plugins/web-provider-public-artifacts.explicit.js";
import type { WebSearchProviderPlugin } from "../plugins/web-provider-types.js";

export type WebSearchProviderModelSchema = NonNullable<WebSearchProviderPlugin["modelSchema"]>;

function findProviderModelSchema(
  providers: readonly WebSearchProviderPlugin[],
  providerId: string,
): WebSearchProviderModelSchema | null {
  return providers.find((provider) => provider.id === providerId)?.modelSchema ?? null;
}

/** Resolves model-facing provider schema without activating or loading plugin runtime code. */
export function resolveWebSearchProviderModelSchema(params: {
  config?: OpenClawConfig;
  providerId: string;
  sandboxed?: boolean;
}): WebSearchProviderModelSchema | null {
  const providerId = params.providerId.trim().toLowerCase();
  if (!providerId) {
    return null;
  }

  const snapshot = loadManifestMetadataSnapshot({
    config: params.config,
  });
  const owner = listAvailableManifestContractPlugins({
    snapshot,
    contract: "webSearchProviders",
    value: providerId,
    config: params.config,
  })[0];
  if (owner && (!params.sandboxed || owner.origin === "bundled" || owner.trustedOfficialInstall)) {
    const publicProviders =
      owner.origin === "bundled"
        ? loadBundledWebSearchProviderEntriesFromDir({
            dirName: path.basename(owner.rootDir),
            pluginId: owner.id,
          })
        : loadInstalledWebSearchProviderEntriesFromRoot({
            pluginRoot: owner.rootDir,
            pluginId: owner.id,
          });
    const publicSchema = publicProviders
      ? findProviderModelSchema(publicProviders, providerId)
      : null;
    if (publicSchema) {
      return publicSchema;
    }
  }

  const activeProviders =
    getActiveRuntimePluginRegistry()?.webSearchProviders.map((entry) => entry.provider) ?? [];
  return findProviderModelSchema(activeProviders, providerId);
}
