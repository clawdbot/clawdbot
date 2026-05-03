import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestContractSnapshot,
} from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { hasManifestToolAvailability } from "./manifest-tool-availability.js";
import type { PluginMetadataManifestView } from "./plugin-metadata-snapshot.types.js";
import type { PluginToolRegistration } from "./registry-types.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "./runtime/standalone-runtime-registry-loader.js";
import { findUndeclaredPluginToolNames } from "./tool-contracts.js";
import {
  buildPluginToolDescriptorCacheKey,
  capturePluginToolDescriptor,
  createPluginToolDescriptorConfigCacheKeyMemo,
  readCachedPluginToolDescriptors,
  type CachedPluginToolDescriptor,
  type PluginToolDescriptorConfigCacheKeyMemo,
  writeCachedPluginToolDescriptors,
} from "./tool-descriptor-cache.js";
import type { OpenClawPluginToolContext } from "./types.js";

export {
  resetPluginToolDescriptorCache,
  resetPluginToolDescriptorCache as resetPluginToolFactoryCache,
} from "./tool-descriptor-cache.js";

export type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};

type PluginToolFactoryTimingResult = "array" | "error" | "null" | "single";

type PluginToolFactoryTiming = {
  pluginId: string;
  names: string[];
  durationMs: number;
  elapsedMs: number;
  result: PluginToolFactoryTimingResult;
  resultCount: number;
  optional: boolean;
};

type PluginToolFactoryResult = AnyAgentTool | AnyAgentTool[] | null | undefined;

const log = createSubsystemLogger("plugins/tools");
const PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS = 5_000;
const PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS = 1_000;
const PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT = 20;

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

export function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void {
  pluginToolMeta.set(tool, meta);
}

export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

export function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void {
  const meta = pluginToolMeta.get(source);
  if (meta) {
    pluginToolMeta.set(target, meta);
  }
}

/**
 * Builds a collision-proof key for plugin-owned tool metadata lookups.
 */
export function buildPluginToolMetadataKey(pluginId: string, toolName: string): string {
  return JSON.stringify([pluginId, toolName]);
}

function normalizeAllowlist(list?: string[]) {
  return new Set((list ?? []).map(normalizeToolName).filter(Boolean));
}

function isOptionalToolAllowed(params: {
  toolName: string;
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  const toolName = normalizeToolName(params.toolName);
  if (params.allowlist.has(toolName)) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return true;
  }
  return params.allowlist.has("group:plugins");
}

function isOptionalToolEntryPotentiallyAllowed(params: {
  names: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey) || params.allowlist.has("group:plugins")) {
    return true;
  }
  if (params.names.length === 0) {
    return true;
  }
  return params.names.some((name) => params.allowlist.has(normalizeToolName(name)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readPluginToolName(tool: unknown): string {
  if (!isRecord(tool)) {
    return "";
  }
  // Optional-tool allowlists need a best-effort name before full shape validation.
  return typeof tool.name === "string" ? tool.name.trim() : "";
}

function toElapsedMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function describePluginToolFactoryResult(
  resolved: AnyAgentTool | AnyAgentTool[] | null | undefined,
  failed: boolean,
): { result: PluginToolFactoryTimingResult; resultCount: number } {
  if (failed) {
    return { result: "error", resultCount: 0 };
  }
  if (!resolved) {
    return { result: "null", resultCount: 0 };
  }
  if (Array.isArray(resolved)) {
    return { result: "array", resultCount: resolved.length };
  }
  return { result: "single", resultCount: 1 };
}

function createPluginToolFactoryTiming(params: {
  pluginId: string;
  names: string[];
  durationMs: number;
  elapsedMs: number;
  resolved: PluginToolFactoryResult;
  failed: boolean;
  optional: boolean;
}): PluginToolFactoryTiming {
  const result = describePluginToolFactoryResult(params.resolved, params.failed);
  return {
    pluginId: params.pluginId,
    names: params.names,
    durationMs: params.durationMs,
    elapsedMs: params.elapsedMs,
    result: result.result,
    resultCount: result.resultCount,
    optional: params.optional,
  };
}

function resolvePluginToolFactoryEntry(params: {
  entry: PluginToolRegistration;
  ctx: OpenClawPluginToolContext;
  declaredNames: string[];
  factoryTimingStartedAt: number;
  logError: (message: string) => void;
}): {
  resolved: PluginToolFactoryResult;
  failed: boolean;
  timing: PluginToolFactoryTiming;
} {
  let resolved: PluginToolFactoryResult = null;
  let failed = false;
  const factoryStartedAt = Date.now();

  try {
    resolved = params.entry.factory(params.ctx);
  } catch (err) {
    failed = true;
    params.logError(`plugin tool failed (${params.entry.pluginId}): ${String(err)}`);
  }

  const factoryEndedAt = Date.now();
  return {
    resolved,
    failed,
    timing: createPluginToolFactoryTiming({
      pluginId: params.entry.pluginId,
      names: params.declaredNames,
      durationMs: toElapsedMs(factoryEndedAt - factoryStartedAt),
      elapsedMs: toElapsedMs(factoryEndedAt - params.factoryTimingStartedAt),
      resolved,
      failed,
      optional: params.entry.optional,
    }),
  };
}

function formatPluginToolFactoryTiming(timing: PluginToolFactoryTiming): string {
  const names = timing.names.length > 0 ? timing.names.join("|") : "-";
  return [
    `${timing.pluginId}:${timing.durationMs}ms@${timing.elapsedMs}ms`,
    `names=[${names}]`,
    `result=${timing.result}`,
    `count=${timing.resultCount}`,
    `optional=${String(timing.optional)}`,
  ].join(" ");
}

function formatPluginToolFactoryTimingSummary(params: {
  totalMs: number;
  timings: PluginToolFactoryTiming[];
}): string {
  const ranked = params.timings
    .toSorted(
      (left, right) =>
        right.durationMs - left.durationMs || left.pluginId.localeCompare(right.pluginId),
    )
    .slice(0, PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT);
  const omitted = Math.max(0, params.timings.length - ranked.length);
  const factories =
    ranked.length > 0
      ? ranked.map((timing) => formatPluginToolFactoryTiming(timing)).join(", ")
      : "none";
  return [
    "[trace:plugin-tools] factory timings",
    `totalMs=${params.totalMs}`,
    `factoryCount=${params.timings.length}`,
    `shown=${ranked.length}`,
    `omitted=${omitted}`,
    `factories=${factories}`,
  ].join(" ");
}

function shouldWarnPluginToolFactoryTimings(params: {
  totalMs: number;
  timings: PluginToolFactoryTiming[];
}): boolean {
  return (
    params.totalMs >= PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS ||
    params.timings.some((timing) => timing.durationMs >= PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS)
  );
}

function describeMalformedPluginTool(tool: unknown): string | undefined {
  if (!isRecord(tool)) {
    return "tool must be an object";
  }
  const name = readPluginToolName(tool);
  if (!name) {
    return "missing non-empty name";
  }
  if (typeof tool.execute !== "function") {
    return `${name} missing execute function`;
  }
  if (!isRecord(tool.parameters)) {
    return `${name} missing parameters object`;
  }
  return undefined;
}

function pluginToolNamesMatchAllowlist(params: {
  names: readonly string[];
  pluginId: string;
  optional: boolean;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return !params.optional;
  }
  return isOptionalToolEntryPotentiallyAllowed(params);
}

function manifestToolContractMatchesAllowlist(params: {
  toolNames: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.toolNames.length === 0) {
    return false;
  }
  if (params.allowlist.size === 0) {
    return true;
  }
  if (params.allowlist.has("*") || params.allowlist.has("group:plugins")) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return true;
  }
  return params.toolNames.some((name) => params.allowlist.has(normalizeToolName(name)));
}

function listManifestToolNamesForAvailability(params: {
  toolNames: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): string[] {
  if (
    params.allowlist.size === 0 ||
    params.allowlist.has("*") ||
    params.allowlist.has("group:plugins")
  ) {
    return [...params.toolNames];
  }
  if (params.allowlist.has(normalizeToolName(params.pluginId))) {
    return [...params.toolNames];
  }
  return params.toolNames.filter((name) => params.allowlist.has(normalizeToolName(name)));
}

function resolvePluginToolRuntimePluginIds(params: {
  config: PluginLoadOptions["config"];
  availabilityConfig?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  toolAllowlist?: string[];
  hasAuthForProvider?: (providerId: string) => boolean;
  snapshot?: PluginMetadataManifestView;
}): string[] {
  const pluginIds = new Set<string>();
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const snapshot =
    params.snapshot ??
    loadManifestContractSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  for (const plugin of snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    const toolNames = plugin.contracts?.tools ?? [];
    if (
      manifestToolContractMatchesAllowlist({
        toolNames,
        pluginId: plugin.id,
        allowlist,
      }) &&
      hasManifestToolAvailability({
        plugin,
        toolNames: listManifestToolNamesForAvailability({
          toolNames,
          pluginId: plugin.id,
          allowlist,
        }),
        config: params.availabilityConfig ?? params.config,
        env: params.env,
        hasAuthForProvider: params.hasAuthForProvider,
      })
    ) {
      pluginIds.add(plugin.id);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

function readPluginCacheSource(plugin: PluginManifestRecord): string {
  const source = (plugin as { source?: unknown; manifestPath?: unknown }).source;
  if (typeof source === "string" && source.trim()) {
    return source;
  }
  const manifestPath = (plugin as { manifestPath?: unknown }).manifestPath;
  if (typeof manifestPath === "string" && manifestPath.trim()) {
    return manifestPath;
  }
  return plugin.id;
}

function buildPluginDescriptorCacheKey(params: {
  plugin: PluginManifestRecord;
  ctx: OpenClawPluginToolContext;
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
  configCacheKeyMemo?: PluginToolDescriptorConfigCacheKeyMemo;
}): string {
  return buildPluginToolDescriptorCacheKey({
    pluginId: params.plugin.id,
    source: readPluginCacheSource(params.plugin),
    rootDir: params.plugin.rootDir,
    contractToolNames: params.plugin.contracts?.tools ?? [],
    ctx: params.ctx,
    currentRuntimeConfig: params.currentRuntimeConfig,
    configCacheKeyMemo: params.configCacheKeyMemo,
  });
}

function cachedDescriptorsCoverToolNames(params: {
  descriptors: readonly CachedPluginToolDescriptor[];
  toolNames: readonly string[];
}): boolean {
  const descriptorNames = new Set(
    params.descriptors.map((entry) => normalizeToolName(entry.descriptor.name)),
  );
  return params.toolNames.every((name) => descriptorNames.has(normalizeToolName(name)));
}

function createCachedDescriptorPluginTool(params: {
  descriptor: CachedPluginToolDescriptor;
  ctx: OpenClawPluginToolContext;
  loadContext: ReturnType<typeof resolvePluginRuntimeLoadContext>;
  runtimeOptions: PluginLoadOptions["runtimeOptions"];
}): AnyAgentTool {
  const { descriptor } = params.descriptor;
  const pluginId = descriptor.owner.kind === "plugin" ? descriptor.owner.pluginId : "";
  const toolName = descriptor.name;
  const tool: AnyAgentTool = {
    name: descriptor.name,
    label: descriptor.title ?? descriptor.name,
    description: descriptor.description,
    parameters: descriptor.inputSchema as never,
    async execute(toolCallId, executeParams, signal, onUpdate) {
      const loadOptions = buildPluginRuntimeLoadOptions(params.loadContext, {
        activate: false,
        toolDiscovery: true,
        onlyPluginIds: [pluginId],
        ...(params.runtimeOptions ? { runtimeOptions: params.runtimeOptions } : {}),
      });
      const registry = resolvePluginToolRegistry({
        loadOptions,
        onlyPluginIds: [pluginId],
      });
      const entry = registry?.tools.find(
        (candidate) =>
          candidate.pluginId === pluginId &&
          (candidate.names.length > 0 ? candidate.names : (candidate.declaredNames ?? [])).some(
            (name) => normalizeToolName(name) === normalizeToolName(toolName),
          ),
      );
      if (!entry) {
        throw new Error(`plugin tool runtime unavailable (${pluginId}): ${toolName}`);
      }
      const resolved = entry.factory(params.ctx);
      const listRaw: unknown[] = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
      for (const toolRaw of listRaw) {
        const malformedReason = describeMalformedPluginTool(toolRaw);
        if (malformedReason) {
          throw new Error(`plugin tool is malformed (${pluginId}): ${malformedReason}`);
        }
        const runtimeTool = toolRaw as AnyAgentTool;
        if (normalizeToolName(runtimeTool.name) === normalizeToolName(toolName)) {
          return runtimeTool.execute(toolCallId, executeParams, signal, onUpdate);
        }
      }
      throw new Error(`plugin tool runtime missing (${pluginId}): ${toolName}`);
    },
  };
  if (params.descriptor.displaySummary) {
    tool.displaySummary = params.descriptor.displaySummary;
  }
  if (params.descriptor.ownerOnly === true) {
    tool.ownerOnly = true;
  }
  setPluginToolMeta(tool, {
    pluginId,
    optional: params.descriptor.optional,
  });
  return tool;
}

function resolveCachedPluginTools(params: {
  snapshot: PluginMetadataManifestView;
  config: PluginLoadOptions["config"];
  availabilityConfig: PluginLoadOptions["config"];
  env: NodeJS.ProcessEnv;
  allowlist: Set<string>;
  hasAuthForProvider?: (providerId: string) => boolean;
  onlyPluginIds: readonly string[];
  existing: Set<string>;
  existingNormalized: Set<string>;
  ctx: OpenClawPluginToolContext;
  loadContext: ReturnType<typeof resolvePluginRuntimeLoadContext>;
  runtimeOptions: PluginLoadOptions["runtimeOptions"];
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
  configCacheKeyMemo: PluginToolDescriptorConfigCacheKeyMemo;
}): { tools: AnyAgentTool[]; handledPluginIds: Set<string> } {
  const tools: AnyAgentTool[] = [];
  const handledPluginIds = new Set<string>();
  const onlyPluginIdSet = new Set(params.onlyPluginIds);
  for (const plugin of params.snapshot.plugins) {
    if (!onlyPluginIdSet.has(plugin.id)) {
      continue;
    }
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    const contractToolNames = plugin.contracts?.tools ?? [];
    const availableToolNames = listManifestToolNamesForAvailability({
      toolNames: contractToolNames,
      pluginId: plugin.id,
      allowlist: params.allowlist,
    });
    if (
      !hasManifestToolAvailability({
        plugin,
        toolNames: availableToolNames,
        config: params.availabilityConfig,
        env: params.env,
        hasAuthForProvider: params.hasAuthForProvider,
      })
    ) {
      continue;
    }
    if (params.existingNormalized.has(normalizeToolName(plugin.id))) {
      continue;
    }
    const cached = readCachedPluginToolDescriptors(
      buildPluginDescriptorCacheKey({
        plugin,
        ctx: params.ctx,
        currentRuntimeConfig: params.currentRuntimeConfig,
        configCacheKeyMemo: params.configCacheKeyMemo,
      }),
    );
    if (
      !cached ||
      !cachedDescriptorsCoverToolNames({
        descriptors: cached,
        toolNames: availableToolNames,
      })
    ) {
      continue;
    }
    const pluginTools: AnyAgentTool[] = [];
    let hasNameConflict = false;
    const localNames = new Set<string>();
    for (const cachedDescriptor of cached) {
      if (
        !cachedDescriptor.optional &&
        !availableToolNames.some(
          (name) => normalizeToolName(name) === normalizeToolName(cachedDescriptor.descriptor.name),
        )
      ) {
        continue;
      }
      if (
        cachedDescriptor.optional &&
        !isOptionalToolAllowed({
          toolName: cachedDescriptor.descriptor.name,
          pluginId: plugin.id,
          allowlist: params.allowlist,
        })
      ) {
        continue;
      }
      if (
        localNames.has(cachedDescriptor.descriptor.name) ||
        params.existing.has(cachedDescriptor.descriptor.name)
      ) {
        hasNameConflict = true;
        break;
      }
      localNames.add(cachedDescriptor.descriptor.name);
      pluginTools.push(
        createCachedDescriptorPluginTool({
          descriptor: cachedDescriptor,
          ctx: params.ctx,
          loadContext: params.loadContext,
          runtimeOptions: params.runtimeOptions,
        }),
      );
    }
    if (hasNameConflict) {
      continue;
    }
    for (const pluginTool of pluginTools) {
      params.existing.add(pluginTool.name);
      params.existingNormalized.add(normalizeToolName(pluginTool.name));
      tools.push(pluginTool);
    }
    handledPluginIds.add(plugin.id);
  }
  return { tools, handledPluginIds };
}

function resolvePluginToolRegistry(params: {
  loadOptions: PluginLoadOptions;
  onlyPluginIds?: readonly string[];
}) {
  const lookup = {
    env: params.loadOptions.env,
    loadOptions: params.loadOptions,
    workspaceDir: params.loadOptions.workspaceDir,
    requiredPluginIds: params.onlyPluginIds,
  };
  return (
    getLoadedRuntimePluginRegistry({
      ...lookup,
      surface: "channel",
    }) ??
    getLoadedRuntimePluginRegistry({
      env: lookup.env,
      workspaceDir: lookup.workspaceDir,
      requiredPluginIds: lookup.requiredPluginIds,
      surface: "active",
    })
  );
}

function resolvePluginToolLoadState(params: {
  context: OpenClawPluginToolContext;
  toolAllowlist?: string[];
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}):
  | {
      context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
      env: NodeJS.ProcessEnv;
      loadOptions: PluginLoadOptions;
      onlyPluginIds: string[];
      runtimeOptions: PluginLoadOptions["runtimeOptions"];
      snapshot: PluginMetadataManifestView;
    }
  | undefined {
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const context = resolvePluginRuntimeLoadContext({
    config: baseConfig,
    env,
    workspaceDir: params.context.workspaceDir,
  });
  const normalized = normalizePluginsConfig(context.config.plugins);
  if (!normalized.enabled) {
    return undefined;
  }

  const runtimeOptions = params.allowGatewaySubagentBinding
    ? { allowGatewaySubagentBinding: true as const }
    : undefined;
  const snapshot = loadManifestContractSnapshot({
    config: context.config,
    workspaceDir: context.workspaceDir,
    env,
  });
  const onlyPluginIds = resolvePluginToolRuntimePluginIds({
    config: context.config,
    availabilityConfig: params.context.runtimeConfig ?? context.config,
    workspaceDir: context.workspaceDir,
    env,
    toolAllowlist: params.toolAllowlist,
    hasAuthForProvider: params.hasAuthForProvider,
    snapshot,
  });
  const loadOptions = buildPluginRuntimeLoadOptions(context, {
    activate: false,
    toolDiscovery: true,
    onlyPluginIds,
    runtimeOptions,
  });
  return { context, env, loadOptions, onlyPluginIds, runtimeOptions, snapshot };
}

export function ensureStandalonePluginToolRegistryLoaded(params: {
  context: OpenClawPluginToolContext;
  toolAllowlist?: string[];
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): void {
  const loadState = resolvePluginToolLoadState(params);
  if (!loadState) {
    return;
  }
  ensureStandaloneRuntimePluginRegistryLoaded({
    surface: "channel",
    requiredPluginIds: loadState.onlyPluginIds,
    loadOptions: loadState.loadOptions,
  });
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool[] {
  // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
  // This matters a lot for unit tests and for tool construction hot paths.
  const loadState = resolvePluginToolLoadState(params);
  if (!loadState) {
    return [];
  }
  const { context, env, onlyPluginIds, runtimeOptions, snapshot } = loadState;
  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const configCacheKeyMemo = createPluginToolDescriptorConfigCacheKeyMemo();
  let currentRuntimeConfigForDescriptorCache: PluginLoadOptions["config"] | null | undefined =
    params.context.runtimeConfig;
  if (currentRuntimeConfigForDescriptorCache === undefined && params.context.getRuntimeConfig) {
    try {
      currentRuntimeConfigForDescriptorCache = params.context.getRuntimeConfig();
    } catch {
      currentRuntimeConfigForDescriptorCache = null;
    }
  }
  const cached = resolveCachedPluginTools({
    snapshot,
    config: context.config,
    availabilityConfig: params.context.runtimeConfig ?? context.config,
    env,
    allowlist,
    hasAuthForProvider: params.hasAuthForProvider,
    onlyPluginIds,
    existing,
    existingNormalized,
    ctx: params.context,
    loadContext: context,
    runtimeOptions,
    currentRuntimeConfig: currentRuntimeConfigForDescriptorCache,
    configCacheKeyMemo,
  });
  tools.push(...cached.tools);
  const runtimePluginIds = onlyPluginIds.filter(
    (pluginId) => !cached.handledPluginIds.has(pluginId),
  );
  if (runtimePluginIds.length === 0) {
    return tools;
  }
  const loadOptions = buildPluginRuntimeLoadOptions(context, {
    activate: false,
    toolDiscovery: true,
    onlyPluginIds: runtimePluginIds,
    runtimeOptions,
  });
  const registry = resolvePluginToolRegistry({
    loadOptions,
    onlyPluginIds: runtimePluginIds,
  });
  if (!registry) {
    return tools;
  }

  const scopedPluginIds = new Set(runtimePluginIds);
  const blockedPlugins = new Set<string>();
  const factoryTimingStartedAt = Date.now();
  const factoryTimings: PluginToolFactoryTiming[] = [];
  const capturedDescriptorsByPluginId = new Map<string, CachedPluginToolDescriptor[]>();
  const manifestPluginsById = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));

  for (const entry of registry.tools) {
    if (!scopedPluginIds.has(entry.pluginId)) {
      continue;
    }
    if (blockedPlugins.has(entry.pluginId)) {
      continue;
    }
    const pluginIdKey = normalizeToolName(entry.pluginId);
    if (existingNormalized.has(pluginIdKey)) {
      const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
      if (!params.suppressNameConflicts) {
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
      }
      blockedPlugins.add(entry.pluginId);
      continue;
    }
    const declaredNames = entry.names ?? [];
    if (
      !pluginToolNamesMatchAllowlist({
        names: declaredNames,
        pluginId: entry.pluginId,
        optional: entry.optional,
        allowlist,
      })
    ) {
      continue;
    }
    const factoryResult = resolvePluginToolFactoryEntry({
      entry,
      ctx: params.context,
      declaredNames,
      factoryTimingStartedAt,
      logError: (message) => context.logger.error(message),
    });
    factoryTimings.push(factoryResult.timing);
    if (factoryResult.failed) {
      continue;
    }
    const { resolved } = factoryResult;
    if (!resolved) {
      if (declaredNames.length > 0) {
        context.logger.debug?.(
          `plugin tool factory returned null (${entry.pluginId}): [${declaredNames.join(", ")}]`,
        );
      }
      continue;
    }
    const listRaw: unknown[] = Array.isArray(resolved) ? resolved : [resolved];
    const list = entry.optional
      ? listRaw.filter((tool) =>
          isOptionalToolAllowed({
            toolName: readPluginToolName(tool),
            pluginId: entry.pluginId,
            allowlist,
          }),
        )
      : listRaw;
    if (list.length === 0) {
      continue;
    }
    const nameSet = new Set<string>();
    for (const toolRaw of list) {
      // Plugin factories run at request time and can return arbitrary values; isolate
      // malformed tools here so one bad plugin tool cannot poison every provider.
      const malformedReason = describeMalformedPluginTool(toolRaw);
      if (malformedReason) {
        const message = `plugin tool is malformed (${entry.pluginId}): ${malformedReason}`;
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
        continue;
      }
      const tool = toolRaw as AnyAgentTool;
      const undeclared = entry.declaredNames
        ? findUndeclaredPluginToolNames({
            declaredNames: entry.declaredNames,
            toolNames: [tool.name],
          })
        : [];
      if (undeclared.length > 0) {
        const message = `plugin tool is undeclared (${entry.pluginId}): ${undeclared.join(", ")}`;
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
        continue;
      }
      if (nameSet.has(tool.name) || existing.has(tool.name)) {
        const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
        if (!params.suppressNameConflicts) {
          context.logger.error(message);
          registry.diagnostics.push({
            level: "error",
            pluginId: entry.pluginId,
            source: entry.source,
            message,
          });
        }
        continue;
      }
      nameSet.add(tool.name);
      existing.add(tool.name);
      pluginToolMeta.set(tool, {
        pluginId: entry.pluginId,
        optional: entry.optional,
      });
      const manifestPlugin = manifestPluginsById.get(entry.pluginId);
      if (manifestPlugin) {
        const capturedDescriptors = capturedDescriptorsByPluginId.get(entry.pluginId) ?? [];
        capturedDescriptors.push(
          capturePluginToolDescriptor({
            pluginId: entry.pluginId,
            tool,
            optional: entry.optional,
          }),
        );
        capturedDescriptorsByPluginId.set(entry.pluginId, capturedDescriptors);
      }
      tools.push(tool);
    }
  }

  for (const [pluginId, descriptors] of capturedDescriptorsByPluginId) {
    const manifestPlugin = manifestPluginsById.get(pluginId);
    if (!manifestPlugin) {
      continue;
    }
    const availableToolNames = listManifestToolNamesForAvailability({
      toolNames: manifestPlugin.contracts?.tools ?? [],
      pluginId,
      allowlist,
    });
    if (
      cachedDescriptorsCoverToolNames({
        descriptors,
        toolNames: availableToolNames,
      })
    ) {
      writeCachedPluginToolDescriptors({
        cacheKey: buildPluginDescriptorCacheKey({
          plugin: manifestPlugin,
          ctx: params.context,
          currentRuntimeConfig: currentRuntimeConfigForDescriptorCache,
          configCacheKeyMemo,
        }),
        descriptors,
      });
    }
  }

  if (factoryTimings.length > 0) {
    const totalMs =
      factoryTimings.at(-1)?.elapsedMs ?? toElapsedMs(Date.now() - factoryTimingStartedAt);
    const timingSummary = { totalMs, timings: factoryTimings };
    if (shouldWarnPluginToolFactoryTimings(timingSummary)) {
      log.warn(formatPluginToolFactoryTimingSummary(timingSummary));
    } else if (log.isEnabled("trace")) {
      log.trace(formatPluginToolFactoryTimingSummary(timingSummary));
    }
  }

  return tools;
}
