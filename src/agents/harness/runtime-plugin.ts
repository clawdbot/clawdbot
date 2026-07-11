/**
 * Ensures runtime plugins required by selected native harnesses are installed.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRouteOverridePresence } from "../../plugin-sdk/provider-model-types.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import { resolveManifestActivationPlan } from "../../plugins/activation-planner.js";
import { resolveEffectivePluginActivationState } from "../../plugins/config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "../../plugins/default-enablement.js";
import {
  loadPluginRegistrySnapshot,
  normalizePluginsConfigWithRegistry,
} from "../../plugins/plugin-registry.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef,
} from "../../plugins/providers.js";
import { isDefaultAgentRuntimeId, OPENCLAW_AGENT_RUNTIME_ID } from "../agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { isCliRuntimeAliasForProvider } from "../model-runtime-aliases.js";
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
  const allow = config?.plugins?.allow ?? [];
  return allow.length > 0 && !allow.includes(pluginId);
}

function resolveSelectedMemoryPluginIds(params: {
  config: OpenClawConfig | undefined;
  workspaceDir: string;
}): string[] {
  const registry = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const plugins = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
  const memorySlot = plugins.slots.memory;
  if (
    typeof memorySlot !== "string" ||
    memorySlot.trim().length === 0 ||
    restrictiveAllowlistOmitsPlugin(params.config, memorySlot)
  ) {
    return [];
  }
  const plugin = registry.plugins.find((entry) => entry.pluginId === memorySlot);
  if (!plugin?.startup.memory) {
    return [];
  }
  const activationState = resolveEffectivePluginActivationState({
    id: plugin.pluginId,
    origin: plugin.origin,
    config: plugins,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
  });
  return activationState.activated ? [plugin.pluginId] : [];
}

/** Resolve manifest owners required by one selected non-core harness runtime. */
export function resolveAgentHarnessOwnerPluginIds(params: {
  runtime: string;
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
}): string[] {
  const activationPlan = resolveManifestActivationPlan({
    trigger: { kind: "agentHarness", runtime: params.runtime },
    config: params.config,
    workspaceDir: params.workspaceDir,
    requireExplicitManifestOwnerTrust: true,
  });
  const harnessPluginIds = activationPlan.entries.map((entry) => entry.pluginId);
  if (harnessPluginIds.length === 0) {
    return [];
  }
  if (params.runtime !== "codex") {
    return harnessPluginIds;
  }
  if (!harnessPluginIds.includes("codex")) {
    return harnessPluginIds;
  }
  if (restrictiveAllowlistOmitsPlugin(params.config, "codex")) {
    // Respect a restrictive allowlist even when Codex would normally pull in provider owner
    // plugins. Operators who set an allowlist expect no implicit plugin expansion.
    return harnessPluginIds;
  }
  const providerOwnerPluginIds = dedupePluginIds(
    resolveOwningPluginIdsForProviderRef({
      provider: params.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
    }) ?? [],
  );
  if (providerOwnerPluginIds.length === 0) {
    return harnessPluginIds;
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
    ...harnessPluginIds,
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

/** Ensures the plugin that owns the selected harness runtime is loaded before harness selection. */
export async function ensureSelectedAgentHarnessPlugin(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  workspaceDir: string;
}): Promise<void> {
  const pinnedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const runtimeOverride = normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);
  const policy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  const requestedRuntime = pinnedHarnessId ?? runtimeOverride;
  const runtime =
    requestedRuntime && !isDefaultAgentRuntimeId(requestedRuntime)
      ? requestedRuntime
      : policy.runtime;
  if (
    isDefaultAgentRuntimeId(runtime) ||
    runtime === OPENCLAW_AGENT_RUNTIME_ID ||
    isCliRuntimeAliasForProvider({
      runtime,
      provider: params.provider,
      cfg: params.config,
    })
  ) {
    return;
  }

  const { ensurePluginRegistryLoaded } =
    await import("../../plugins/runtime/runtime-registry-loader.js");
  const pluginIds = resolveAgentHarnessOwnerPluginIds({
    runtime,
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  if (pluginIds.length === 0) {
    return;
  }
  const memoryPluginIds = resolveSelectedMemoryPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const scopedPluginIds = dedupePluginIds([...pluginIds, ...memoryPluginIds]);
  const configWithAllowedRuntimePlugins = withRuntimePluginIdsAllowed({
    config: params.config,
    requiredPluginId: runtime,
    pluginIds: scopedPluginIds,
  });
  const activatedConfig =
    withActivatedPluginIds({
      config: configWithAllowedRuntimePlugins,
      pluginIds: scopedPluginIds,
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
    onlyPluginIds: scopedPluginIds,
  });
}
