/** Prepares only the provider owners needed by a model config mutation. */
import { tryResolveConfiguredAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { modelKey, type ModelRef } from "../../agents/model-ref-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import { resolvePluginProviderRegistryCore } from "../../plugins/providers.runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";

export function withModelCommandProviderRuntime<T>(
  params: {
    runtimeConfig: OpenClawConfig;
    selectModelRefs: () => readonly (ModelRef | undefined)[];
  },
  run: () => T,
): T {
  const config = params.runtimeConfig;
  const env = process.env;
  const workspaceDir = tryResolveConfiguredAgentWorkspaceDir(config, env);
  const metadataSnapshot = loadManifestMetadataSnapshot({ config, env, workspaceDir });
  const providerRefs = new Set<string>();
  const modelRefs = new Set<string>();
  // Reuse the operation's selection policy with hooks fenced off. Combining
  // alternate source/runtime interpretations would activate unused providers.
  const selections = withPluginRuntimeGenerationScope({ metadataSnapshot }, params.selectModelRefs);
  for (const ref of selections) {
    if (ref) {
      providerRefs.add(ref.provider);
      modelRefs.add(modelKey(ref.provider, ref.model));
    }
  }
  const selected = providerRefs.size
    ? resolvePluginProviderRegistryCore({
        config,
        env,
        workspaceDir,
        pluginMetadataSnapshot: metadataSnapshot,
        providerRefs: [...providerRefs],
        modelRefs: [...modelRefs],
        registryScope: "exact",
        activate: false,
      })
    : undefined;
  return withPluginRuntimeGenerationScope(
    { metadataSnapshot, pluginRegistry: selected?.registry },
    run,
  );
}
