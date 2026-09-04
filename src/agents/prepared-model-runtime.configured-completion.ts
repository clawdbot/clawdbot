import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { resolveLoadedProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.configured.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

export function completeConfiguredRuntimeModels(
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  modelRegistry: ModelRegistry,
): readonly PreparedConfiguredRuntimeModel[] {
  if (!pluginGeneration.pluginRegistry) {
    return agentFacts.configuredRuntimeModels;
  }
  const { input, configuredModelRefs, configuredRuntimeModels, env } = agentFacts;
  const { config, agentDir, workspaceDir } = input;
  // Both startup and full discovery complete static misses from their captured registry;
  // borrowing an ambient plugin generation would change configured model ownership.
  return withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: pluginGeneration.pluginRegistry,
    },
    () => {
      const existing = new Map(
        configuredRuntimeModels.map((configured) => [
          buildModelCatalogMergeKey(configured.provider, configured.modelId),
          configured,
        ]),
      );
      const completed: PreparedConfiguredRuntimeModel[] = [];
      const seen = new Set<string>();
      for (const ref of configuredModelRefs) {
        const { provider, modelId } = ref;
        const key = buildModelCatalogMergeKey(provider, modelId);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const model =
          existing.get(key)?.model ??
          resolveLoadedProviderRuntimePlugin({
            provider,
            modelId,
            config,
            workspaceDir,
            env,
          })?.resolveDynamicModel?.({
            config,
            agentDir,
            workspaceDir,
            provider,
            modelId,
            modelRegistry,
            providerConfig:
              config.models?.providers?.[provider] ??
              findNormalizedProviderValue(config.models?.providers, provider),
          });
        if (model) {
          completed.push({ ...ref, model });
        }
      }
      return completed;
    },
  );
}
