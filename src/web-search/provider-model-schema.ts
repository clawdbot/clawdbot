import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry.js";
import { resolveBundledWebSearchProvidersFromPublicArtifacts } from "../plugins/web-provider-public-artifacts.js";
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
}): WebSearchProviderModelSchema | null {
  const providerId = params.providerId.trim().toLowerCase();
  if (!providerId) {
    return null;
  }

  const ownerPluginId = resolveManifestContractOwnerPluginId({
    config: params.config,
    contract: "webSearchProviders",
    value: providerId,
    origin: "bundled",
  });
  if (ownerPluginId) {
    const publicProviders = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: params.config,
      onlyPluginIds: [ownerPluginId],
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
