/** Evaluates one resolved provider hook before applying manifest model-id policy. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeProviderModelIdWithManifest } from "./manifest-model-id-normalization.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import type { ProviderNormalizeModelIdContext, ProviderPlugin } from "./types.js";

export type ProviderModelIdNormalizationParams = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
  providerPlugin?: ProviderPlugin;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
  context: ProviderNormalizeModelIdContext;
};

export function normalizeProviderModelIdWithResolvedPlugin(
  params: ProviderModelIdNormalizationParams,
  plugin: Pick<ProviderPlugin, "normalizeModelId"> | undefined,
): string | undefined {
  return (
    normalizeOptionalString(plugin?.normalizeModelId?.(params.context)) ??
    normalizeProviderModelIdWithManifest({
      ...params,
      plugins: params.pluginMetadataSnapshot?.manifestRegistry.plugins ?? params.plugins,
    })
  );
}
