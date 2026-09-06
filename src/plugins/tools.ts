/** Builds agent tools registered by plugins, preserving plugin scope around callbacks and descriptors. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../agents/glob-pattern.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { normalizeConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import { isInvalidConfigError } from "../config/io.invalid-config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getLoadedRuntimePluginRegistry,
  registryMatchesManifestPluginIds,
} from "./active-runtime-registry.js";
import {
  isBundledConversationReadToolRegistration,
  isHostRestrictedConversationReadTool,
  registrationIncludesHostRestrictedConversationReadTool,
} from "./compat/conversation-read-tools.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { loadPluginRegistryHandle, type PluginLoadOptions } from "./loader.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestContractSnapshot,
} from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { hasManifestToolAvailability } from "./manifest-tool-availability.js";
import type { PluginMetadataManifestView } from "./plugin-metadata-snapshot.types.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { buildPluginRuntimeLoadOptions } from "./runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";
import { findUndeclaredPluginToolNames } from "./tool-contracts.js";
import { createPluginToolAllowlist, type PluginToolAllowlist } from "./tool-grant-allowlist.js";
import { copyPluginToolMeta, setPluginToolMeta } from "./tool-metadata.js";
import type { OpenClawPluginToolContext } from "./types.js";

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

function runWithPluginToolScope<T>(
  entry: PluginToolRegistration,
  pluginRegistry: PluginRegistry | undefined,
  run: () => T,
): T {
  return withPluginRuntimeRegistryScope(pluginRegistry, () =>
    withPluginRuntimePluginScope(
      {
        pluginId: entry.pluginId,
        ...(entry.source ? { pluginSource: entry.source } : {}),
      },
      run,
    ),
  );
}

function isAgentTool(value: unknown): value is AnyAgentTool {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { execute?: unknown }).execute === "function"
  );
}

function wrapPluginToolCallbacks(
  entry: PluginToolRegistration,
  pluginRegistry: PluginRegistry | undefined,
  tool: AnyAgentTool,
): AnyAgentTool {
  const record = pluginRegistry?.plugins.find((candidate) => candidate.id === entry.pluginId);
  const authority = pluginRegistry
    ? capturePluginLifecycleAuthority(pluginRegistry, record, { scopedRuntime: true })
    : undefined;
  // Direct SDK contributions can lack records. Capture that choice once so a
  // removed record never falls back to registry authority or rebinds on publication.
  const runScoped = <T>(run: () => T): T => {
    if (!authority?.()) {
      throw new Error(`Plugin "${entry.pluginId}" tool runtime is no longer active.`);
    }
    return runWithPluginToolScope(entry, pluginRegistry, run);
  };
  const prepareArguments = tool.prepareArguments;
  const scopedPrepareArguments = prepareArguments
    ? (args: unknown) => runScoped(() => Reflect.apply(prepareArguments, tool, [args]))
    : undefined;
  const scopedExecute = async (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) =>
    runScoped(
      () =>
        Reflect.apply(tool.execute, tool, [toolCallId, params, signal, onUpdate]) as ReturnType<
          AnyAgentTool["execute"]
        >,
    );
  const wrapped = new Proxy<AnyAgentTool>(tool, {
    get(target, prop) {
      if (prop === "prepareArguments" && scopedPrepareArguments) {
        return scopedPrepareArguments;
      }
      if (prop === "execute") {
        return scopedExecute;
      }
      return Reflect.get(target, prop, target);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "prepareArguments" && scopedPrepareArguments) {
        return {
          configurable: true,
          enumerable: Object.prototype.propertyIsEnumerable.call(target, prop),
          value: scopedPrepareArguments,
          writable: true,
        };
      }
      if (prop === "execute") {
        return {
          configurable: true,
          enumerable: Object.prototype.propertyIsEnumerable.call(target, prop),
          value: scopedExecute,
          writable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });

  copyPluginToolMeta(tool, wrapped);
  return wrapped;
}

function wrapPluginToolFactoryResult(
  entry: PluginToolRegistration,
  pluginRegistry: PluginRegistry | undefined,
  result: PluginToolFactoryResult,
): PluginToolFactoryResult {
  if (Array.isArray(result)) {
    return result.map((tool) =>
      isAgentTool(tool) ? wrapPluginToolCallbacks(entry, pluginRegistry, tool) : tool,
    );
  }
  return isAgentTool(result) ? wrapPluginToolCallbacks(entry, pluginRegistry, result) : result;
}

function resolvePluginToolFactory(
  entry: PluginToolRegistration,
  pluginRegistry: PluginRegistry | undefined,
  ctx: OpenClawPluginToolContext,
) {
  return runWithPluginToolScope(entry, pluginRegistry, () =>
    wrapPluginToolFactoryResult(entry, pluginRegistry, entry.factory(ctx)),
  );
}

function blocksHostRestrictedConversationReadTool(params: {
  pluginId: string;
  toolNames: readonly string[];
  bundledOwner: boolean;
  ctx: OpenClawPluginToolContext;
}): boolean {
  if (
    normalizeConversationReadInvocationOrigin(params.ctx.conversationReadOrigin) ===
      "direct-operator" ||
    params.bundledOwner
  ) {
    return false;
  }
  return params.toolNames.some((toolName) =>
    isHostRestrictedConversationReadTool({ pluginId: params.pluginId, toolName }),
  );
}

function blocksHostRestrictedConversationReadRegistration(params: {
  entry: PluginToolRegistration;
  manifestPlugin: PluginManifestRecord | undefined;
  ctx: OpenClawPluginToolContext;
}): boolean {
  return (
    registrationIncludesHostRestrictedConversationReadTool(params.entry) &&
    blocksHostRestrictedConversationReadTool({
      pluginId: params.entry.pluginId,
      toolNames: [...params.entry.names, ...(params.entry.declaredNames ?? [])],
      bundledOwner: isBundledConversationReadToolRegistration({
        entry: params.entry,
        manifestPlugin: params.manifestPlugin,
      }),
      ctx: params.ctx,
    })
  );
}

function normalizeDenylist(list?: string[]) {
  return compileGlobPatterns({
    raw: list,
    normalize: normalizeToolPolicyName,
  });
}

function denylistBlocksName(name: string, denylist: ReturnType<typeof normalizeDenylist>): boolean {
  const normalized = normalizeToolPolicyName(name);
  return normalized ? matchesAnyGlobPattern(normalized, denylist) : false;
}

function denylistBlocksPlugin(params: {
  pluginId: string;
  denylist: ReturnType<typeof normalizeDenylist>;
}): boolean {
  return (
    denylistBlocksName(params.pluginId, params.denylist) ||
    matchesAnyGlobPattern("group:plugins", params.denylist)
  );
}

function denylistBlocksPluginTool(params: {
  pluginId: string;
  toolName: string;
  denylist: ReturnType<typeof normalizeDenylist>;
}): boolean {
  return (
    denylistBlocksPlugin({ pluginId: params.pluginId, denylist: params.denylist }) ||
    denylistBlocksName(params.toolName, params.denylist)
  );
}

function isManifestToolOptional(plugin: PluginManifestRecord, toolName: string): boolean {
  return plugin.toolMetadata?.[toolName]?.optional === true;
}

function isPluginToolOptional(params: {
  entry: PluginToolRegistration;
  manifestPlugin: PluginManifestRecord | undefined;
  toolName: string;
}): boolean {
  return (
    params.entry.optional ||
    (params.manifestPlugin ? isManifestToolOptional(params.manifestPlugin, params.toolName) : false)
  );
}

function setManifestPluginToolMeta(
  tool: AnyAgentTool,
  pluginId: string,
  plugin: PluginManifestRecord | undefined,
  optional: boolean,
): void {
  const metadata = plugin?.toolMetadata?.[tool.name];
  setPluginToolMeta(tool, {
    pluginId,
    ...(plugin?.kind ? { kind: plugin.kind } : {}),
    optional,
    replaySafe: metadata?.replaySafe === true,
    sideEffecting: metadata?.sideEffecting === true,
    trustedLocalMedia:
      plugin?.origin === "bundled" && plugin.contracts?.tools?.includes(tool.name) === true,
  });
}

function readPluginToolName(tool: unknown): string {
  if (!isRecord(tool)) {
    return "";
  }
  // Optional-tool allowlists need a best-effort name before full shape validation.
  return typeof tool.name === "string" ? tool.name.trim() : "";
}

function hasRequiredClientCaps(
  requiredClientCaps: unknown,
  clientCaps: ReadonlySet<string>,
): boolean {
  // Leave malformed metadata for describeMalformedPluginTool so one plugin
  // cannot abort resolution before the normal isolation diagnostic runs.
  if (requiredClientCaps === undefined) {
    return true;
  }
  if (
    !Array.isArray(requiredClientCaps) ||
    requiredClientCaps.some((requiredCap) => typeof requiredCap !== "string")
  ) {
    return true;
  }
  return !requiredClientCaps.some((requiredCap) => !clientCaps.has(requiredCap));
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
  pluginRegistry: PluginRegistry | undefined;
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
    resolved = resolvePluginToolFactory(params.entry, params.pluginRegistry, params.ctx);
  } catch (err) {
    failed = true;
    // Suppress the resolver-side log only for invalid-config errors whose
    // diagnostic was already emitted by the config loader (throwInvalidConfig
    // sets diagnosticEmitted). Directly-created or wrapped tagged errors have
    // no prior log, so they still need the resolver diagnostic here.
    if (!(isInvalidConfigError(err) && err.diagnosticEmitted)) {
      params.logError(`plugin tool failed (${params.entry.pluginId}): ${String(err)}`);
    }
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
  if (
    tool.requiredClientCaps !== undefined &&
    (!Array.isArray(tool.requiredClientCaps) ||
      tool.requiredClientCaps.some((requiredCap) => typeof requiredCap !== "string"))
  ) {
    return `${name} requiredClientCaps must be an array of strings`;
  }
  return undefined;
}

function pluginToolNamesMatchAllowlist(params: {
  names: readonly string[];
  pluginId: string;
  optional: boolean;
  allowlist: PluginToolAllowlist;
}): boolean {
  return (
    (!params.optional && params.allowlist.includesDefaults) ||
    (params.allowlist.size > 0 &&
      (params.names.length === 0 ||
        params.names.some((name) => params.allowlist.allowsTool(params.pluginId, name))))
  );
}

function listManifestToolNamesForAllowlist(params: {
  plugin: PluginManifestRecord;
  toolNames: readonly string[];
  pluginId: string;
  allowlist: PluginToolAllowlist;
}): string[] {
  if (params.allowlist.allowsPlugin(params.pluginId)) {
    return [...params.toolNames];
  }
  const matchedToolNames = params.toolNames.filter((name) =>
    params.allowlist.allowsTool(params.pluginId, name),
  );
  if (!params.allowlist.includesDefaults) {
    return matchedToolNames;
  }
  const defaultToolNames = params.toolNames.filter(
    (name) => !isManifestToolOptional(params.plugin, name),
  );
  return uniqueStrings([...defaultToolNames, ...matchedToolNames]);
}

function isManifestToolNameAvailable(params: {
  plugin: PluginManifestRecord;
  toolName: string;
  config: PluginLoadOptions["config"];
  env: NodeJS.ProcessEnv;
  hasAuthForProvider?: (providerId: string) => boolean;
}): boolean {
  return hasManifestToolAvailability({
    plugin: params.plugin,
    toolNames: [params.toolName],
    config: params.config,
    env: params.env,
    hasAuthForProvider: params.hasAuthForProvider,
  });
}

function filterManifestToolNamesForAvailability(params: {
  plugin: PluginManifestRecord;
  toolNames: readonly string[];
  config: PluginLoadOptions["config"];
  env: NodeJS.ProcessEnv;
  hasAuthForProvider?: (providerId: string) => boolean;
}): string[] {
  return params.toolNames.filter((toolName) =>
    isManifestToolNameAvailable({
      plugin: params.plugin,
      toolName,
      config: params.config,
      env: params.env,
      hasAuthForProvider: params.hasAuthForProvider,
    }),
  );
}

function resolvePluginToolRuntimePluginIds(params: {
  config: PluginLoadOptions["config"];
  availabilityConfig?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  allowlist: PluginToolAllowlist;
  toolDenylist?: string[];
  hasAuthForProvider?: (providerId: string) => boolean;
  snapshot?: PluginMetadataManifestView;
}): string[] {
  const pluginIds = new Set<string>();
  const denylist = normalizeDenylist(params.toolDenylist);
  const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
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
        normalizedConfig: normalizedPlugins,
      })
    ) {
      continue;
    }
    if (denylistBlocksPlugin({ pluginId: plugin.id, denylist })) {
      continue;
    }
    const toolNames = plugin.contracts?.tools ?? [];
    const selectedToolNames = listManifestToolNamesForAllowlist({
      toolNames,
      plugin,
      pluginId: plugin.id,
      allowlist: params.allowlist,
    }).filter(
      (toolName) =>
        !denylistBlocksPluginTool({
          pluginId: plugin.id,
          toolName,
          denylist,
        }),
    );
    if (
      selectedToolNames.length > 0 &&
      hasManifestToolAvailability({
        plugin,
        toolNames: selectedToolNames,
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

function resolvePluginToolRegistry(params: {
  loadOptions: PluginLoadOptions;
  onlyPluginIds?: readonly string[];
  runtimeRegistry?: PluginRegistry;
  manifestPlugins?: PluginMetadataManifestView["plugins"];
}) {
  const requestedPluginIds = params.onlyPluginIds;
  // Tools belong to the prepared generation, even when
  // process-global discovery would select a different registry.
  if (
    registryHasScopedPluginTools(params.runtimeRegistry, requestedPluginIds, params.manifestPlugins)
  ) {
    return params.runtimeRegistry;
  }
  const activeRegistry = getLoadedRuntimePluginRegistry({
    loadOptions: params.loadOptions,
    workspaceDir: params.loadOptions.workspaceDir,
    requiredPluginIds: requestedPluginIds,
  });
  if (registryHasScopedPluginTools(activeRegistry, requestedPluginIds)) {
    return activeRegistry;
  }
  const registry = loadPluginRegistryHandle({
    ...params.loadOptions,
    activate: false,
    ...(requestedPluginIds === undefined ? {} : { onlyPluginIds: [...requestedPluginIds] }),
  });
  return registry;
}

function registryHasScopedPluginTools(
  registry: PluginRegistry | undefined,
  pluginIds: readonly string[] | undefined,
  manifestPlugins?: PluginMetadataManifestView["plugins"],
): registry is PluginRegistry {
  if (!registry) {
    return false;
  }
  if (pluginIds === undefined) {
    return (registry.tools?.length ?? 0) > 0;
  }
  const scopedPluginIds = new Set(pluginIds);
  if (scopedPluginIds.size === 0) {
    return true;
  }
  const registryPluginIds = new Set(registry.tools.map((entry) => entry.pluginId));
  return (
    Array.from(scopedPluginIds).every((pluginId) => registryPluginIds.has(pluginId)) &&
    (manifestPlugins === undefined ||
      registryMatchesManifestPluginIds(registry, manifestPlugins, pluginIds))
  );
}

type PreparedPluginToolRuntime = {
  loadContext?: ReturnType<typeof resolvePluginRuntimeLoadContext>;
  metadataSnapshot: PluginMetadataManifestView;
  registry?: PluginRegistry;
};

function resolvePluginToolLoadState(params: {
  context: OpenClawPluginToolContext;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
  preparedRuntime?: PreparedPluginToolRuntime;
}):
  | {
      context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
      env: NodeJS.ProcessEnv;
      loadOptions: PluginLoadOptions;
      onlyPluginIds: string[];
      allowlist: PluginToolAllowlist;
      runtimeOptions: PluginLoadOptions["runtimeOptions"];
      snapshot: PluginMetadataManifestView;
    }
  | undefined {
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const preparedLoadContext = params.preparedRuntime?.loadContext;
  // The prepared runtime already owns one immutable Gateway plugin generation. Per-turn config
  // and workspace projections cannot invalidate that executable graph or reopen discovery.
  const usePreparedRuntime = preparedLoadContext !== undefined && env === preparedLoadContext.env;
  const context = usePreparedRuntime
    ? preparedLoadContext
    : resolvePluginRuntimeLoadContext({
        config: baseConfig,
        env,
        workspaceDir: params.context.workspaceDir,
      });
  if (context.config.plugins?.enabled === false) {
    return undefined;
  }

  const runtimeOptions = params.allowGatewaySubagentBinding
    ? { allowGatewaySubagentBinding: true as const }
    : undefined;
  const snapshot =
    usePreparedRuntime && params.preparedRuntime
      ? params.preparedRuntime.metadataSnapshot
      : loadManifestContractSnapshot({
          config: context.config,
          workspaceDir: context.workspaceDir,
          env,
        });
  const allowlist = createPluginToolAllowlist(params.toolAllowlist);
  const onlyPluginIds = resolvePluginToolRuntimePluginIds({
    config: context.config,
    availabilityConfig: params.context.runtimeConfig ?? context.config,
    workspaceDir: context.workspaceDir,
    env,
    allowlist,
    toolDenylist: params.toolDenylist,
    hasAuthForProvider: params.hasAuthForProvider,
    snapshot,
  });
  const loadOptions = buildPluginRuntimeLoadOptions(context, {
    activate: false,
    toolDiscovery: true,
    onlyPluginIds,
    runtimeOptions,
  });
  return { context, env, loadOptions, onlyPluginIds, allowlist, runtimeOptions, snapshot };
}

export function ensureStandalonePluginToolRegistryLoaded(params: {
  context: OpenClawPluginToolContext;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): PluginRegistry | undefined {
  const loadState = resolvePluginToolLoadState(params);
  if (!loadState) {
    return undefined;
  }
  const registry = loadPluginRegistryHandle(loadState.loadOptions);
  if (registryHasScopedPluginTools(registry, loadState.onlyPluginIds)) {
    return registry;
  }
  return resolvePluginToolRegistry({
    loadOptions: loadState.loadOptions,
    onlyPluginIds: loadState.onlyPluginIds,
  });
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  clientCaps?: string[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
  runtimeRegistry?: PluginRegistry;
  preparedRuntime?: PreparedPluginToolRuntime;
}): AnyAgentTool[] {
  // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
  // This matters a lot for unit tests and for tool construction hot paths.
  const loadState = resolvePluginToolLoadState(params);
  if (!loadState) {
    return [];
  }
  const { context, env, onlyPluginIds, allowlist, runtimeOptions, snapshot } = loadState;
  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolPolicyName(tool)));
  // Tracks which plugin registered each tool name so the plugin-id conflict
  // guard below cannot fire against the plugin's own tools (a plugin may
  // register several tools, one of which shares the plugin id, e.g. canvas).
  const pluginToolOwnersByName = new Map<string, string>();
  const denylist = normalizeDenylist(params.toolDenylist);
  const clientCaps = new Set(params.clientCaps ?? []);
  const runtimeRegistry =
    context === params.preparedRuntime?.loadContext
      ? params.preparedRuntime.registry
      : params.runtimeRegistry;
  if (onlyPluginIds.length === 0) {
    return tools;
  }
  const loadOptions = buildPluginRuntimeLoadOptions(context, {
    activate: false,
    toolDiscovery: true,
    onlyPluginIds,
    runtimeOptions,
  });
  const registry = resolvePluginToolRegistry({
    loadOptions,
    onlyPluginIds,
    runtimeRegistry,
    manifestPlugins: snapshot.plugins,
  });
  if (!registry) {
    context.logger.warn(
      `plugin tool registry unavailable for plugin ids [${onlyPluginIds.join(", ")}]`,
    );
    return tools;
  }

  const scopedPluginIds = new Set(onlyPluginIds);
  const registryToolPluginIds = new Set(registry.tools.map((entry) => entry.pluginId));
  const missingRegistryToolPluginIds = onlyPluginIds.filter(
    (pluginId) => !registryToolPluginIds.has(pluginId),
  );
  for (const pluginId of missingRegistryToolPluginIds) {
    registry.diagnostics.push({
      level: "warn",
      pluginId,
      source: "plugin-tools",
      message: `plugin tool registry did not include selected plugin tools after cold load (${pluginId})`,
    });
  }
  const blockedPlugins = new Set<string>();
  const factoryTimingStartedAt = Date.now();
  const factoryTimings: PluginToolFactoryTiming[] = [];
  const manifestPluginsById = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));

  for (const entry of registry.tools) {
    if (!scopedPluginIds.has(entry.pluginId)) {
      continue;
    }
    if (denylistBlocksPlugin({ pluginId: entry.pluginId, denylist })) {
      continue;
    }
    if (blockedPlugins.has(entry.pluginId)) {
      continue;
    }
    const pluginIdKey = normalizeToolPolicyName(entry.pluginId);
    // A name owned by this same plugin (e.g. the canvas plugin's own `canvas`
    // tool registered by an earlier entry) is not a conflict; only core names
    // and other plugins' tools shadow the plugin id.
    if (
      existingNormalized.has(pluginIdKey) &&
      pluginToolOwnersByName.get(pluginIdKey) !== entry.pluginId
    ) {
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
    const manifestPlugin = manifestPluginsById.get(entry.pluginId);
    const declaredNames = entry.names ?? [];
    const availabilityNames =
      declaredNames.length > 0 ? declaredNames : (entry.declaredNames ?? []);
    const allowlistNames = manifestPlugin
      ? filterManifestToolNamesForAvailability({
          plugin: manifestPlugin,
          toolNames: availabilityNames,
          config: params.context.runtimeConfig ?? context.config,
          env,
          hasAuthForProvider: params.hasAuthForProvider,
        }).filter(
          (toolName) =>
            !denylistBlocksPluginTool({
              pluginId: entry.pluginId,
              toolName,
              denylist,
            }),
        )
      : declaredNames;
    if (manifestPlugin && availabilityNames.length > 0 && allowlistNames.length === 0) {
      continue;
    }
    if (
      !pluginToolNamesMatchAllowlist({
        names: allowlistNames,
        pluginId: entry.pluginId,
        optional: entry.optional,
        allowlist,
      })
    ) {
      continue;
    }
    if (
      blocksHostRestrictedConversationReadRegistration({
        entry,
        manifestPlugin,
        ctx: params.context,
      })
    ) {
      continue;
    }
    const factoryResult = resolvePluginToolFactoryEntry({
      entry,
      pluginRegistry: registry,
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
    const selectedManifestToolNames =
      manifestPlugin && availabilityNames.length > 0
        ? new Set(allowlistNames.map((name) => normalizeToolPolicyName(name)))
        : undefined;
    const manifestContractToolNames =
      manifestPlugin && availabilityNames.length > 0
        ? new Set(availabilityNames.map((name) => normalizeToolPolicyName(name)))
        : undefined;
    const availableList = manifestPlugin
      ? listRaw.filter((tool) => {
          const toolName = readPluginToolName(tool);
          const normalizedToolName = normalizeToolPolicyName(toolName);
          if (
            isManifestToolOptional(manifestPlugin, toolName) &&
            !allowlist.allowsTool(entry.pluginId, toolName)
          ) {
            return false;
          }
          if (
            selectedManifestToolNames &&
            manifestContractToolNames?.has(normalizedToolName) &&
            !selectedManifestToolNames.has(normalizedToolName)
          ) {
            return false;
          }
          return isManifestToolNameAvailable({
            plugin: manifestPlugin,
            toolName,
            config: params.context.runtimeConfig ?? context.config,
            env,
            hasAuthForProvider: params.hasAuthForProvider,
          });
        })
      : listRaw;
    const policyAvailableList = availableList.filter(
      (tool) =>
        !denylistBlocksPluginTool({
          pluginId: entry.pluginId,
          toolName: readPluginToolName(tool),
          denylist,
        }),
    );
    const list = entry.optional
      ? policyAvailableList.filter((tool) =>
          allowlist.allowsTool(entry.pluginId, readPluginToolName(tool)),
        )
      : policyAvailableList;
    const clientAvailableList = list.filter((tool) =>
      isRecord(tool) ? hasRequiredClientCaps(tool.requiredClientCaps, clientCaps) : true,
    );
    if (clientAvailableList.length === 0) {
      continue;
    }
    const normalizedNameSet = new Set<string>();
    for (const toolRaw of clientAvailableList) {
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
      const normalizedToolName = normalizeToolPolicyName(tool.name);
      if (normalizedNameSet.has(normalizedToolName) || existingNormalized.has(normalizedToolName)) {
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
      normalizedNameSet.add(normalizedToolName);
      existing.add(tool.name);
      existingNormalized.add(normalizedToolName);
      pluginToolOwnersByName.set(normalizedToolName, entry.pluginId);
      const optional = isPluginToolOptional({
        entry,
        manifestPlugin,
        toolName: tool.name,
      });
      setManifestPluginToolMeta(tool, entry.pluginId, manifestPlugin, optional);
      tools.push(tool);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
