import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProvider,
} from "../../plugins/providers.js";
import { resolveAgentHarnessPolicy } from "./policy.js";

function dedupePluginIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const pluginId = value.trim();
    if (!pluginId || seen.has(pluginId)) {
      continue;
    }
    seen.add(pluginId);
    result.push(pluginId);
  }
  return result;
}

function restrictiveAllowlistOmitsPlugin(config: OpenClawConfig | undefined, pluginId: string) {
  if (config?.plugins?.bundledDiscovery === "compat") {
    return false;
  }
  const allow = config?.plugins?.allow ?? [];
  return allow.length > 0 && !allow.includes(pluginId);
}

function resolveCodexHarnessPluginIds(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
}): string[] {
  if (restrictiveAllowlistOmitsPlugin(params.config, "codex")) {
    return ["codex"];
  }
  const providerOwnerPluginIds = dedupePluginIds(
    resolveOwningPluginIdsForProvider({
      provider: params.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
    }) ?? [],
  );
  if (providerOwnerPluginIds.length === 0) {
    return ["codex"];
  }
  const safeProviderOwnerPluginIds = dedupePluginIds([
    ...resolveBundledProviderCompatPluginIds({
      config: params.config,
      workspaceDir: params.workspaceDir,
      onlyPluginIds: providerOwnerPluginIds,
    }),
    ...resolveActivatableProviderOwnerPluginIds({
      pluginIds: providerOwnerPluginIds,
      config: params.config,
      workspaceDir: params.workspaceDir,
    }),
  ]);
  return dedupePluginIds([
    "codex",
    ...providerOwnerPluginIds.filter(
      (pluginId) => pluginId !== "codex" && safeProviderOwnerPluginIds.includes(pluginId),
    ),
  ]);
}

function withRuntimePluginIdsAllowed(params: {
  config?: OpenClawConfig;
  requiredPluginId: string;
  pluginIds: readonly string[];
}): OpenClawConfig | undefined {
  if (params.pluginIds.length === 0) {
    return params.config;
  }
  if (restrictiveAllowlistOmitsPlugin(params.config, params.requiredPluginId)) {
    return params.config;
  }
  const allow = dedupePluginIds([...(params.config?.plugins?.allow ?? []), ...params.pluginIds]);
  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      allow,
    },
  };
}

export async function ensureSelectedAgentHarnessPlugin(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  agentHarnessRuntimeOverride?: string;
  workspaceDir: string;
}): Promise<void> {
  const runtimeOverride = params.agentHarnessRuntimeOverride?.trim();
  const policy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const runtime =
    runtimeOverride && runtimeOverride !== "auto" && runtimeOverride !== "default"
      ? runtimeOverride
      : policy.runtime;
  if (runtime !== "codex") {
    return;
  }

  const { ensurePluginRegistryLoaded } =
    await import("../../plugins/runtime/runtime-registry-loader.js");
  const pluginIds = resolveCodexHarnessPluginIds({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const configWithAllowedRuntimePlugins = withRuntimePluginIdsAllowed({
    config: params.config,
    requiredPluginId: "codex",
    pluginIds,
  });
  const activatedConfig =
    withActivatedPluginIds({
      config: configWithAllowedRuntimePlugins,
      pluginIds,
    }) ?? configWithAllowedRuntimePlugins;
  ensurePluginRegistryLoaded({
    scope: "all",
    ...(activatedConfig
      ? {
          config: activatedConfig,
          activationSourceConfig: activatedConfig,
        }
      : {}),
    workspaceDir: params.workspaceDir,
    onlyPluginIds: pluginIds,
  });
}
