/** Builds deterministic plugin load plans for selected native harness and memory owners. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import { resolveManifestActivationPlan } from "../../plugins/activation-planner.js";
import {
  isTestDefaultMemorySlotDisabled,
  resolveEffectivePluginActivationState,
} from "../../plugins/config-state.js";
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

export type AgentHarnessPluginSelection = {
  provider: string;
  modelId: string;
  runtime?: string;
  agentId?: string;
};

function dedupePluginIds(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const pluginId = value.trim();
    if (pluginId && !result.includes(pluginId)) {
      result.push(pluginId);
    }
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
  // Honor config-owned test defaults before discovery forces an implicit memory owner.
  if (isTestDefaultMemorySlotDisabled(params.config ?? {})) {
    return [];
  }
  const registry = loadPluginRegistrySnapshot(params);
  const plugins = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
  const memorySlot = plugins.slots.memory;
  if (
    typeof memorySlot !== "string" ||
    restrictiveAllowlistOmitsPlugin(params.config, memorySlot)
  ) {
    return [];
  }
  const plugin = registry.plugins.find((entry) => entry.pluginId === memorySlot);
  if (!plugin?.startup.memory) {
    return [];
  }
  return resolveEffectivePluginActivationState({
    id: plugin.pluginId,
    origin: plugin.origin,
    config: plugins,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
  }).activated
    ? [plugin.pluginId]
    : [];
}

/** Resolve manifest owners required by one selected non-core harness runtime. */
export function resolveAgentHarnessOwnerPluginIds(params: {
  runtime: string;
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
}): string[] {
  const harnessPluginIds = resolveManifestActivationPlan({
    trigger: { kind: "agentHarness", runtime: params.runtime },
    config: params.config,
    workspaceDir: params.workspaceDir,
    requireExplicitManifestOwnerTrust: true,
  }).entries.map((entry) => entry.pluginId);
  if (
    harnessPluginIds.length === 0 ||
    params.runtime !== "codex" ||
    !harnessPluginIds.includes("codex") ||
    restrictiveAllowlistOmitsPlugin(params.config, "codex")
  ) {
    return harnessPluginIds;
  }
  const providerOwnerPluginIds = dedupePluginIds(
    resolveOwningPluginIdsForProviderRef(params) ?? [],
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
    ...harnessPluginIds,
    ...providerOwnerPluginIds.filter(
      (pluginId) => pluginId !== "codex" && safeProviderOwnerPluginIds.includes(pluginId),
    ),
  ]);
}

function withRuntimePluginIdsAllowed(
  config: OpenClawConfig | undefined,
  pluginIds: readonly string[],
  materializeAllowlist: boolean,
): OpenClawConfig | undefined {
  const existingAllowlist = config?.plugins?.allow ?? [];
  if (pluginIds.length === 0 || (!materializeAllowlist && existingAllowlist.length === 0)) {
    return config;
  }
  return {
    ...config,
    plugins: {
      ...config?.plugins,
      allow: dedupePluginIds([...existingAllowlist, ...pluginIds]),
    },
  };
}

export function resolveSelectedAgentHarnessRuntime(
  selection: AgentHarnessPluginSelection,
  config?: OpenClawConfig,
) {
  const requestedRuntime = normalizeOptionalAgentRuntimeId(selection.runtime);
  return requestedRuntime && !isDefaultAgentRuntimeId(requestedRuntime)
    ? requestedRuntime
    : resolveAgentHarnessPolicy({
        provider: selection.provider,
        modelId: selection.modelId,
        config,
        agentId: selection.agentId,
      }).runtime;
}

/** Returns whether a selection needs a plugin-owned harness in its prepared generation. */
export function requiresAgentHarnessPluginSelection(
  selection: AgentHarnessPluginSelection,
  config?: OpenClawConfig,
): boolean {
  const runtime = resolveSelectedAgentHarnessRuntime(selection, config);
  if (isDefaultAgentRuntimeId(runtime) || runtime === OPENCLAW_AGENT_RUNTIME_ID) {
    return false;
  }
  // Codex is a native plugin harness, never a CLI backend alias. Keep this hot-path decision
  // independent of setup-registry discovery for every model candidate on every turn.
  return (
    runtime === "codex" ||
    !isCliRuntimeAliasForProvider({ runtime, provider: selection.provider, cfg: config })
  );
}

/** Folds selected harness and memory owners into one deterministic plugin load plan. */
export function resolveAgentRuntimePluginLoadPlan(params: {
  config?: OpenClawConfig;
  workspaceDir: string;
  basePluginIds?: readonly string[];
  selections: readonly AgentHarnessPluginSelection[];
}): { config?: OpenClawConfig; pluginIds?: string[] } {
  let config = params.config;
  const memoryPluginIds = resolveSelectedMemoryPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const basePluginIds = (params.basePluginIds ?? []).filter(
    (pluginId) => !restrictiveAllowlistOmitsPlugin(params.config, pluginId),
  );
  const pluginIds = [...basePluginIds, ...memoryPluginIds];
  const forceActivatedPluginIds = [...memoryPluginIds];
  for (const selection of params.selections) {
    const runtime = resolveSelectedAgentHarnessRuntime(selection, config);
    if (!requiresAgentHarnessPluginSelection(selection, config)) {
      continue;
    }
    const harnessPluginIds = resolveAgentHarnessOwnerPluginIds({
      runtime,
      provider: selection.provider,
      config,
      workspaceDir: params.workspaceDir,
    });
    pluginIds.push(...harnessPluginIds);
    const allowedHarnessPluginIds =
      runtime === "codex"
        ? restrictiveAllowlistOmitsPlugin(params.config, "codex")
          ? []
          : harnessPluginIds
        : harnessPluginIds.filter(
            (pluginId) => !restrictiveAllowlistOmitsPlugin(params.config, pluginId),
          );
    forceActivatedPluginIds.push(...allowedHarnessPluginIds);
  }
  const scopedPluginIds = dedupePluginIds(pluginIds).toSorted((left, right) =>
    left.localeCompare(right),
  );
  config = withRuntimePluginIdsAllowed(
    config,
    [...basePluginIds, ...forceActivatedPluginIds],
    params.basePluginIds !== undefined,
  );
  const activatedConfig =
    withActivatedPluginIds({ config, pluginIds: forceActivatedPluginIds.toSorted() }) ?? config;
  if (
    params.basePluginIds === undefined &&
    (params.config?.plugins?.allow?.length ?? 0) === 0 &&
    activatedConfig?.plugins
  ) {
    // A standalone full load must not turn forced owners into discovery policy.
    const plugins = { ...activatedConfig.plugins };
    if (params.config?.plugins?.allow === undefined) {
      delete plugins.allow;
    } else {
      plugins.allow = params.config.plugins.allow;
    }
    config = { ...activatedConfig, plugins };
  } else {
    config = activatedConfig;
  }
  return {
    ...(config ? { config } : {}),
    ...(params.basePluginIds === undefined && scopedPluginIds.length === 0
      ? {}
      : { pluginIds: scopedPluginIds }),
  };
}
