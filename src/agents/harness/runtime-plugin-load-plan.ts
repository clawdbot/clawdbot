/** Builds deterministic plugin load plans for selected harness, memory, and context-engine owners. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import { resolveManifestActivationPlan } from "../../plugins/activation-planner.js";
import { normalizePluginsConfigWithResolverCore } from "../../plugins/config-normalization-shared.js";
import {
  isTestDefaultMemorySlotDisabled,
  resolveEffectivePluginActivationState,
  resolveSelectedContextEnginePluginId,
} from "../../plugins/config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "../../plugins/default-enablement.js";
import {
  addConfiguredSlotPluginIds,
  normalizePluginsConfigForInstalledIndex,
} from "../../plugins/gateway-startup-plugin-config.js";
import { hashJson } from "../../plugins/installed-plugin-index-hash.js";
import { createInstalledPluginIndexScopeLookup } from "../../plugins/installed-plugin-index-scope-lookup.js";
import type { InstalledPluginIndex } from "../../plugins/installed-plugin-index.js";
import type {
  PluginMetadataSnapshot,
  PluginMetadataSnapshotPluginIdScope,
} from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  loadPluginRegistrySnapshot,
  normalizePluginsConfigWithRegistry,
} from "../../plugins/plugin-registry.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef,
} from "../../plugins/providers.js";
import {
  isDefaultAgentRuntimeId,
  OPENCLAW_AGENT_RUNTIME_ID,
  normalizeOptionalAgentRuntimeId,
} from "../agent-runtime-id.js";
import { collectConfiguredAgentHarnessRuntimes } from "../harness-runtimes.js";
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
  metadataSnapshot?: PluginMetadataSnapshot;
}): string[] {
  // Honor config-owned test defaults before discovery forces an implicit memory owner.
  if (isTestDefaultMemorySlotDisabled(params.config ?? {})) {
    return [];
  }
  const registry =
    params.metadataSnapshot?.index ??
    loadPluginRegistrySnapshot({ config: params.config, workspaceDir: params.workspaceDir });
  // The generation owns aliases; activation still follows this call's config.
  const plugins = params.metadataSnapshot
    ? normalizePluginsConfigWithResolverCore(
        params.config?.plugins,
        params.metadataSnapshot.normalizePluginId,
      )
    : normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
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

export function resolveAgentRuntimePluginSelections(
  config: OpenClawConfig | undefined,
  selections: readonly AgentHarnessPluginSelection[],
): AgentHarnessPluginSelection[] {
  return [
    ...collectConfiguredAgentHarnessRuntimes(config ?? {}).map((runtime) => ({
      runtime,
      provider: "",
      modelId: "",
    })),
    ...selections,
  ];
}

function resolveAgentRuntimeMetadataPluginIds(params: {
  config?: OpenClawConfig;
  selections: readonly AgentHarnessPluginSelection[];
  shorthandModelIds?: readonly string[];
  index: InstalledPluginIndex;
}): string[] | undefined {
  const lookup = createInstalledPluginIndexScopeLookup(params.index);
  const pluginsConfig = normalizePluginsConfigForInstalledIndex(params.config?.plugins, lookup);
  if (!pluginsConfig.enabled) {
    return [];
  }
  const pluginIds = new Set<string>();
  lookup.addShorthandModelOwners(pluginIds, params.shorthandModelIds ?? []);
  const selections = resolveAgentRuntimePluginSelections(params.config, params.selections);
  const providerIds = dedupePluginIds(selections.map((selection) => selection.provider));
  for (const providerId of providerIds) {
    const providerPluginIds = new Set<string>();
    lookup.addDirectProviderOwners(providerPluginIds, [providerId]);
    if (providerPluginIds.size === 0) {
      lookup.addProviderContributionOwners(providerPluginIds, [providerId]);
    }
    if (providerPluginIds.size !== 1) {
      return undefined;
    }
    for (const pluginId of providerPluginIds) {
      pluginIds.add(pluginId);
    }
  }
  const runtimeIds = dedupePluginIds(
    selections
      .map((selection) => resolveSelectedAgentHarnessRuntime(selection, params.config))
      .filter(
        (runtime) => !isDefaultAgentRuntimeId(runtime) && runtime !== OPENCLAW_AGENT_RUNTIME_ID,
      ),
  );
  if (!lookup.hasAgentHarnessOwners(runtimeIds)) {
    return undefined;
  }
  lookup.addAgentHarnessOwners(pluginIds, runtimeIds);
  addConfiguredSlotPluginIds(pluginIds, {
    activationSourceConfig: params.config ?? {},
    activationSourcePlugins: pluginsConfig,
    lookup,
  });
  if (!lookup.hasInstalledPluginIds(pluginIds)) {
    return undefined;
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Narrows cold manifest preparation to candidates needed by one selected runtime generation. */
export function createAgentRuntimeMetadataPluginIdScope(params: {
  config?: OpenClawConfig;
  workspaceDir: string;
  selections: readonly AgentHarnessPluginSelection[];
  shorthandModelIds?: readonly string[];
}): PluginMetadataSnapshotPluginIdScope & { key: string } {
  return {
    key: hashJson({
      kind: "agent-runtime",
      config: params.config ?? null,
      workspaceDir: params.workspaceDir,
      selections: params.selections,
      shorthandModelIds: params.shorthandModelIds ?? [],
    }),
    resolve: ({ index }) =>
      resolveAgentRuntimeMetadataPluginIds({
        config: params.config,
        selections: params.selections,
        shorthandModelIds: params.shorthandModelIds,
        index,
      }),
  };
}

// Every selected model provider must join the immutable run generation before
// request-time hooks resolve; late provider loading is intentionally forbidden.
function resolveSelectedProviderOwnerPluginIds(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): string[] {
  const providerOwnerPluginIds = dedupePluginIds(
    resolveOwningPluginIdsForProviderRef(params) ?? [],
  );
  if (providerOwnerPluginIds.length === 0) {
    return [];
  }
  const safeProviderOwnerPluginIds = dedupePluginIds([
    ...resolveBundledProviderCompatPluginIds({
      config: params.config,
      workspaceDir: params.workspaceDir,
      onlyPluginIds: providerOwnerPluginIds,
      manifestRegistry: params.metadataSnapshot?.manifestRegistry,
    }),
    ...resolveActivatableProviderOwnerPluginIds({
      pluginIds: providerOwnerPluginIds,
      config: params.config,
      workspaceDir: params.workspaceDir,
      ...(params.metadataSnapshot
        ? {
            registry: params.metadataSnapshot.index,
            manifestRegistry: params.metadataSnapshot.manifestRegistry,
          }
        : {}),
    }),
  ]);
  return providerOwnerPluginIds.filter((pluginId) => safeProviderOwnerPluginIds.includes(pluginId));
}

/** Resolve manifest owners required by one selected non-core harness runtime. */
export function resolveAgentHarnessOwnerPluginIds(params: {
  runtime: string;
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  providerOwnerPluginIds?: readonly string[];
  metadataSnapshot?: PluginMetadataSnapshot;
}): string[] {
  const harnessPluginIds = resolveManifestActivationPlan({
    trigger: { kind: "agentHarness", runtime: params.runtime },
    config: params.config,
    workspaceDir: params.workspaceDir,
    requireExplicitManifestOwnerTrust: true,
    manifestRecords: params.metadataSnapshot?.plugins,
  }).entries.map((entry) => entry.pluginId);
  if (
    harnessPluginIds.length === 0 ||
    params.runtime !== "codex" ||
    !harnessPluginIds.includes("codex") ||
    restrictiveAllowlistOmitsPlugin(params.config, "codex")
  ) {
    return harnessPluginIds;
  }
  const providerOwnerPluginIds =
    params.providerOwnerPluginIds ?? resolveSelectedProviderOwnerPluginIds(params);
  if (providerOwnerPluginIds.length === 0) {
    return harnessPluginIds;
  }
  return dedupePluginIds([
    ...harnessPluginIds,
    ...providerOwnerPluginIds.filter((pluginId) => pluginId !== "codex"),
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

// Returns whether a selection needs a plugin-owned harness in its prepared generation.
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

/** Folds selected harness, memory, and context-engine owners into one deterministic load plan. */
export function resolveAgentRuntimePluginLoadPlan(params: {
  config?: OpenClawConfig;
  workspaceDir: string;
  basePluginIds?: readonly string[];
  selections: readonly AgentHarnessPluginSelection[];
  metadataSnapshot?: PluginMetadataSnapshot;
}): { config?: OpenClawConfig; pluginIds?: string[] } {
  let config = params.config;
  const memoryPluginIds = resolveSelectedMemoryPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    metadataSnapshot: params.metadataSnapshot,
  });
  const contextEnginePluginId = resolveSelectedContextEnginePluginId(params.config);
  const contextEnginePluginIds = contextEnginePluginId ? [contextEnginePluginId] : [];
  const basePluginIds = (params.basePluginIds ?? []).filter(
    (pluginId) => !restrictiveAllowlistOmitsPlugin(params.config, pluginId),
  );
  const pluginIds = [...basePluginIds, ...memoryPluginIds, ...contextEnginePluginIds];
  const forceActivatedPluginIds = [...memoryPluginIds, ...contextEnginePluginIds];
  for (const selection of params.selections) {
    const runtime = resolveSelectedAgentHarnessRuntime(selection, config);
    const providerOwnerPluginIds = resolveSelectedProviderOwnerPluginIds({
      provider: selection.provider,
      config,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.metadataSnapshot,
    });
    pluginIds.push(...providerOwnerPluginIds);
    forceActivatedPluginIds.push(...providerOwnerPluginIds);
    if (!requiresAgentHarnessPluginSelection(selection, config)) {
      continue;
    }
    const harnessPluginIds = resolveAgentHarnessOwnerPluginIds({
      runtime,
      provider: selection.provider,
      config,
      workspaceDir: params.workspaceDir,
      providerOwnerPluginIds,
      metadataSnapshot: params.metadataSnapshot,
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
