/** Builds agent tools registered by plugins, preserving plugin scope around callbacks and descriptors. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeUniqueStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../agents/glob-pattern.js";
import type { McpCodexToolAnnotations } from "../agents/mcp-codex-tool-approval.js";
import {
  DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  normalizeToolPolicyName,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { normalizeConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { McpCodexToolApprovalMode } from "../config/types.mcp.js";
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
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataManifestView } from "./plugin-metadata-snapshot.types.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { findUndeclaredPluginToolNames } from "./tool-contracts.js";
import {
  buildPluginToolDescriptorCacheKey,
  capturePluginToolDescriptor,
  createPluginToolDescriptorConfigCacheKeyMemo,
  pluginToolDescriptorCacheState,
  readCachedPluginToolDescriptors,
  type CachedPluginToolDescriptor,
  type PluginToolDescriptorConfigCacheKeyMemo,
  writeCachedPluginToolDescriptors,
} from "./tool-descriptor-cache.js";
import { isPluginToolAllowed } from "./tool-grant-allowlist.js";
import type { OpenClawPluginToolContext } from "./types.js";

/** MCP bridge metadata attached to plugin tools surfaced through agent tool lists. */
export type PluginToolMcpMeta = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  operation: "tool" | "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
  deniedBySession?: true;
  codexApproval?: {
    mode: McpCodexToolApprovalMode;
    annotations?: McpCodexToolAnnotations;
  };
  node?: {
    id: string;
    displayName?: string;
  };
};

/** Runtime metadata used to trace an agent tool back to its owning plugin registration. */
type PluginToolMeta = {
  pluginId: string;
  kind?: PluginManifestRecord["kind"];
  optional: boolean;
  replaySafe?: boolean;
  sideEffecting?: boolean;
  trustedLocalMedia?: boolean;
  mcp?: PluginToolMcpMeta;
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
const scopedPluginTools = new WeakMap<AnyAgentTool, Map<string, AnyAgentTool>>();
const pluginRegistryScopeIds = new WeakMap<PluginRegistry, number>();
let nextPluginRegistryScopeId = 1;

/** Attaches plugin ownership metadata to a concrete agent tool instance. */
export function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void {
  pluginToolMeta.set(tool, meta);
}

/** Reads plugin ownership metadata for a concrete agent tool instance. */
export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

/** Copies plugin ownership metadata when wrappers replace a tool object. */
export function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void {
  const meta = pluginToolMeta.get(source);
  if (meta) {
    pluginToolMeta.set(target, meta);
  }
}

function pluginToolScopeKey(
  entry: PluginToolRegistration,
  pluginRegistry: PluginRegistry | undefined,
): string {
  let registryScopeId = 0;
  if (pluginRegistry) {
    registryScopeId = pluginRegistryScopeIds.get(pluginRegistry) ?? nextPluginRegistryScopeId++;
    pluginRegistryScopeIds.set(pluginRegistry, registryScopeId);
  }
  return JSON.stringify([entry.pluginId, entry.source, registryScopeId]);
}

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
  const key = pluginToolScopeKey(entry, pluginRegistry);
  const scopedByKey = scopedPluginTools.get(tool);
  const cached = scopedByKey?.get(key);
  if (cached) {
    return cached;
  }

  const prepareArguments = tool.prepareArguments;
  const scopedPrepareArguments = prepareArguments
    ? (args: unknown) =>
        runWithPluginToolScope(entry, pluginRegistry, () =>
          Reflect.apply(prepareArguments, tool, [args]),
        )
    : undefined;
  const scopedExecute = (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) =>
    runWithPluginToolScope(
      entry,
      pluginRegistry,
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
  const nextScopedByKey = scopedByKey ?? new Map<string, AnyAgentTool>();
  nextScopedByKey.set(key, wrapped);
  scopedPluginTools.set(tool, nextScopedByKey);
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

/**
 * Builds a collision-proof key for plugin-owned tool metadata lookups.
 */
export function buildPluginToolMetadataKey(pluginId: string, toolName: string): string {
  return JSON.stringify([pluginId, toolName]);
}

/** Binds a side-effect declaration to the concrete plugin tool that owns it. */
export function getPluginToolSideEffectOwnerKey(tool: AnyAgentTool): string | undefined {
  const meta = getPluginToolMeta(tool);
  const toolName = normalizeToolPolicyName(tool.name);
  return meta?.sideEffecting && toolName
    ? buildPluginToolMetadataKey(meta.pluginId, toolName)
    : undefined;
}

function normalizeAllowlist(list?: string[]) {
  return new Set(normalizeUniqueStringEntries((list ?? []).map(normalizeToolPolicyName)));
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

function allowlistIncludesDefaultPluginTools(allowlist: Set<string>): boolean {
  return allowlist.size === 0 || allowlist.has(DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY);
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

function isManifestToolReplaySafe(params: {
  manifestPlugin: PluginManifestRecord | undefined;
  toolName: string;
}): boolean {
  return params.manifestPlugin?.toolMetadata?.[params.toolName]?.replaySafe === true;
}

function isManifestToolSideEffecting(params: {
  manifestPlugin: PluginManifestRecord | undefined;
  toolName: string;
}): boolean {
  return params.manifestPlugin?.toolMetadata?.[params.toolName]?.sideEffecting === true;
}

function isTrustedManifestLocalMediaTool(params: {
  manifestPlugin: PluginManifestRecord | undefined;
  toolName: string;
}): boolean {
  return (
    params.manifestPlugin?.origin === "bundled" &&
    params.manifestPlugin.contracts?.tools?.includes(params.toolName) === true
  );
}

function isOptionalToolAllowed(params: {
  toolName: string;
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  if (params.allowlist.has("*")) {
    return true;
  }
  if (isPluginToolAllowed(params.allowlist, params.pluginId, params.toolName)) {
    return true;
  }
  const pluginKey = normalizeToolPolicyName(params.pluginId);
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
  if (params.allowlist.has("*")) {
    return true;
  }
  const pluginKey = normalizeToolPolicyName(params.pluginId);
  if (params.allowlist.has(pluginKey) || params.allowlist.has("group:plugins")) {
    return true;
  }
  if (params.names.length === 0) {
    return true;
  }
  return params.names.some((name) => isPluginToolAllowed(params.allowlist, params.pluginId, name));
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
  allowlist: Set<string>;
}): boolean {
  if (!params.optional && allowlistIncludesDefaultPluginTools(params.allowlist)) {
    return true;
  }
  return isOptionalToolEntryPotentiallyAllowed(params);
}

function listManifestToolNamesForAllowlist(params: {
  plugin: PluginManifestRecord;
  toolNames: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): string[] {
  if (params.toolNames.length === 0) {
    return [];
  }
  if (params.allowlist.has("*") || params.allowlist.has("group:plugins")) {
    return [...params.toolNames];
  }
  const pluginKey = normalizeToolPolicyName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return [...params.toolNames];
  }
  const matchedToolNames = params.toolNames.filter((name) =>
    isPluginToolAllowed(params.allowlist, params.pluginId, name),
  );
  if (!allowlistIncludesDefaultPluginTools(params.allowlist)) {
    return matchedToolNames;
  }
  const defaultToolNames = params.toolNames.filter(
    (name) => !isManifestToolOptional(params.plugin, name),
  );
  return uniqueStrings([...defaultToolNames, ...matchedToolNames]);
}

function listManifestToolNamesForAvailability(params: {
  plugin: PluginManifestRecord;
  toolNames: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): string[] {
  return listManifestToolNamesForAllowlist(params);
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
  toolAllowlist?: string[];
  toolDenylist?: string[];
  hasAuthForProvider?: (providerId: string) => boolean;
  snapshot?: PluginMetadataManifestView;
}): string[] {
  const pluginIds = new Set<string>();
  const allowlist = normalizeAllowlist(params.toolAllowlist);
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
      })
    ) {
      continue;
    }
    if (
      normalizedPlugins.entries[plugin.id]?.enabled === false ||
      normalizedPlugins.deny.includes(plugin.id)
    ) {
      continue;
    }
    if (denylistBlocksPlugin({ pluginId: plugin.id, denylist })) {
      continue;
    }
    const toolNames = plugin.contracts?.tools ?? [];
    const selectedToolNames = listManifestToolNamesForAvailability({
      toolNames,
      plugin,
      pluginId: plugin.id,
      allowlist,
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
  clientCaps?: ReadonlySet<string>;
}): string {
  return buildPluginToolDescriptorCacheKey({
    pluginId: params.plugin.id,
    source: readPluginCacheSource(params.plugin),
    rootDir: params.plugin.rootDir,
    contractToolNames: params.plugin.contracts?.tools ?? [],
    ctx: params.ctx,
    currentRuntimeConfig: params.currentRuntimeConfig,
    configCacheKeyMemo: params.configCacheKeyMemo,
    clientCaps: params.clientCaps ? [...params.clientCaps] : undefined,
  });
}

function cachedDescriptorsCoverToolNames(params: {
  descriptors: readonly CachedPluginToolDescriptor[];
  toolNames: readonly string[];
}): boolean {
  const descriptorNames = new Set(
    params.descriptors.map((entry) => normalizeToolPolicyName(entry.descriptor.name)),
  );
  return params.toolNames.every((name) => descriptorNames.has(normalizeToolPolicyName(name)));
}

function createCachedDescriptorPluginTool(params: {
  descriptor: CachedPluginToolDescriptor;
  plugin: PluginManifestRecord;
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
    ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema as never } : {}),
    ...(params.descriptor.requiredClientCaps
      ? { requiredClientCaps: [...params.descriptor.requiredClientCaps] }
      : {}),
    ...(params.descriptor.resultContentSource
      ? { resultContentSource: params.descriptor.resultContentSource }
      : {}),
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
        retainedRegistry: pluginToolDescriptorCacheState.runtimeRegistries.get(params.descriptor),
        onRetainRegistry: (retainedRegistry) => {
          pluginToolDescriptorCacheState.runtimeRegistries.set(params.descriptor, retainedRegistry);
        },
      });
      const candidates = registry?.tools.filter((candidate) => candidate.pluginId === pluginId);
      if (!candidates || candidates.length === 0) {
        throw new Error(`plugin tool runtime unavailable (${pluginId}): ${toolName}`);
      }
      const requestedToolName = normalizeToolPolicyName(toolName);
      const matchingNamedCandidates: PluginToolRegistration[] = [];
      const unnamedCandidates: PluginToolRegistration[] = [];
      for (const candidate of candidates) {
        if (candidate.names.length === 0) {
          unnamedCandidates.push(candidate);
          continue;
        }
        if (candidate.names.some((name) => normalizeToolPolicyName(name) === requestedToolName)) {
          matchingNamedCandidates.push(candidate);
        }
      }
      const resolveCandidateTool = (
        candidate: PluginToolRegistration,
      ): AnyAgentTool | undefined => {
        const manifestPlugin = resolvePluginMetadataSnapshot({
          config: params.loadContext.config,
          workspaceDir: params.loadContext.workspaceDir,
          env: params.loadContext.env,
        }).byPluginId.get(pluginId);
        if (
          blocksHostRestrictedConversationReadRegistration({
            entry: candidate,
            manifestPlugin,
            ctx: params.ctx,
          })
        ) {
          return undefined;
        }
        const resolved = resolvePluginToolFactory(candidate, registry, params.ctx);
        const listRaw: unknown[] = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
        for (const toolRaw of listRaw) {
          const malformedReason = describeMalformedPluginTool(toolRaw);
          if (malformedReason) {
            continue;
          }
          const runtimeTool = toolRaw as AnyAgentTool;
          if (normalizeToolPolicyName(readPluginToolName(runtimeTool)) === requestedToolName) {
            return runtimeTool;
          }
        }
        return undefined;
      };
      for (const candidate of [...matchingNamedCandidates, ...unnamedCandidates]) {
        let matchedTool: AnyAgentTool | undefined;
        try {
          matchedTool = resolveCandidateTool(candidate);
        } catch {
          continue;
        }
        if (matchedTool) {
          return matchedTool.execute(toolCallId, executeParams, signal, onUpdate);
        }
      }
      throw new Error(`plugin tool runtime missing (${pluginId}): ${toolName}`);
    },
  };
  if (params.descriptor.displaySummary) {
    tool.displaySummary = params.descriptor.displaySummary;
  }
  setPluginToolMeta(tool, {
    pluginId,
    ...(params.plugin.kind ? { kind: params.plugin.kind } : {}),
    optional: params.descriptor.optional,
    replaySafe: isManifestToolReplaySafe({
      manifestPlugin: params.plugin,
      toolName,
    }),
    sideEffecting: isManifestToolSideEffecting({
      manifestPlugin: params.plugin,
      toolName,
    }),
    trustedLocalMedia: isTrustedManifestLocalMediaTool({
      manifestPlugin: params.plugin,
      toolName,
    }),
  });
  return tool;
}

function resolveCachedPluginTools(params: {
  snapshot: PluginMetadataManifestView;
  config: PluginLoadOptions["config"];
  availabilityConfig: PluginLoadOptions["config"];
  env: NodeJS.ProcessEnv;
  allowlist: Set<string>;
  denylist: ReturnType<typeof normalizeDenylist>;
  hasAuthForProvider?: (providerId: string) => boolean;
  onlyPluginIds: readonly string[];
  existing: Set<string>;
  existingNormalized: Set<string>;
  pluginToolOwnersByName: Map<string, string>;
  ctx: OpenClawPluginToolContext;
  loadContext: ReturnType<typeof resolvePluginRuntimeLoadContext>;
  runtimeOptions: PluginLoadOptions["runtimeOptions"];
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
  configCacheKeyMemo: PluginToolDescriptorConfigCacheKeyMemo;
  clientCaps: ReadonlySet<string>;
}): { tools: AnyAgentTool[]; handledPluginIds: Set<string> } {
  const tools: AnyAgentTool[] = [];
  const handledPluginIds = new Set<string>();
  const onlyPluginIdSet = new Set(params.onlyPluginIds);
  for (const plugin of params.snapshot.plugins) {
    if (!onlyPluginIdSet.has(plugin.id)) {
      continue;
    }
    if (denylistBlocksPlugin({ pluginId: plugin.id, denylist: params.denylist })) {
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
    const allowedToolNames = listManifestToolNamesForAvailability({
      plugin,
      toolNames: contractToolNames,
      pluginId: plugin.id,
      allowlist: params.allowlist,
    }).filter(
      (toolName) =>
        !denylistBlocksPluginTool({
          pluginId: plugin.id,
          toolName,
          denylist: params.denylist,
        }),
    );
    const availableToolNames = filterManifestToolNamesForAvailability({
      plugin,
      toolNames: allowedToolNames,
      config: params.availabilityConfig,
      env: params.env,
      hasAuthForProvider: params.hasAuthForProvider,
    });
    if (availableToolNames.length === 0) {
      continue;
    }
    if (params.existingNormalized.has(normalizeToolPolicyName(plugin.id))) {
      continue;
    }
    const cached = readCachedPluginToolDescriptors(
      buildPluginDescriptorCacheKey({
        plugin,
        ctx: params.ctx,
        currentRuntimeConfig: params.currentRuntimeConfig,
        configCacheKeyMemo: params.configCacheKeyMemo,
        clientCaps: params.clientCaps,
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
    const localNormalizedNames = new Set<string>();
    const availableNormalizedToolNames = new Set(availableToolNames.map(normalizeToolPolicyName));
    for (const cachedDescriptor of cached) {
      const normalizedDescriptorName = normalizeToolPolicyName(cachedDescriptor.descriptor.name);
      // Live auth is intentionally absent from the descriptor cache key, so re-project
      // every cached name through current manifest availability before optional grants.
      if (!availableNormalizedToolNames.has(normalizedDescriptorName)) {
        continue;
      }
      if (!hasRequiredClientCaps(cachedDescriptor.requiredClientCaps, params.clientCaps)) {
        continue;
      }
      if (
        blocksHostRestrictedConversationReadTool({
          pluginId: plugin.id,
          toolNames: [cachedDescriptor.descriptor.name],
          bundledOwner: plugin.origin === "bundled",
          ctx: params.ctx,
        })
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
        denylistBlocksPluginTool({
          pluginId: plugin.id,
          toolName: cachedDescriptor.descriptor.name,
          denylist: params.denylist,
        })
      ) {
        continue;
      }
      if (
        localNormalizedNames.has(normalizedDescriptorName) ||
        params.existingNormalized.has(normalizedDescriptorName)
      ) {
        hasNameConflict = true;
        break;
      }
      localNormalizedNames.add(normalizedDescriptorName);
      pluginTools.push(
        createCachedDescriptorPluginTool({
          descriptor: cachedDescriptor,
          plugin,
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
      params.existingNormalized.add(normalizeToolPolicyName(pluginTool.name));
      params.pluginToolOwnersByName.set(normalizeToolPolicyName(pluginTool.name), plugin.id);
      tools.push(pluginTool);
    }
    handledPluginIds.add(plugin.id);
  }
  return { tools, handledPluginIds };
}

function resolvePluginToolRegistry(params: {
  loadOptions: PluginLoadOptions;
  onlyPluginIds?: readonly string[];
  retainedRegistry?: PluginRegistry;
  onRetainRegistry?: (registry: PluginRegistry) => void;
}) {
  const requestedPluginIds = params.onlyPluginIds;
  if (registryHasScopedPluginTools(params.retainedRegistry, requestedPluginIds)) {
    return params.retainedRegistry;
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
  if (registryHasScopedPluginTools(registry, requestedPluginIds)) {
    params.onRetainRegistry?.(registry);
  }
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
  const normalized = normalizePluginsConfig(context.config.plugins);
  if (!normalized.enabled) {
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
  const onlyPluginIds = resolvePluginToolRuntimePluginIds({
    config: context.config,
    availabilityConfig: params.context.runtimeConfig ?? context.config,
    workspaceDir: context.workspaceDir,
    env,
    toolAllowlist: params.toolAllowlist,
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
  return { context, env, loadOptions, onlyPluginIds, runtimeOptions, snapshot };
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
  const { context, env, onlyPluginIds, runtimeOptions, snapshot } = loadState;
  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolPolicyName(tool)));
  // Tracks which plugin registered each tool name so the plugin-id conflict
  // guard below cannot fire against the plugin's own tools (a plugin may
  // register several tools, one of which shares the plugin id, e.g. canvas).
  const pluginToolOwnersByName = new Map<string, string>();
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const denylist = normalizeDenylist(params.toolDenylist);
  const configCacheKeyMemo = createPluginToolDescriptorConfigCacheKeyMemo();
  const clientCaps = new Set(params.clientCaps ?? []);
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
    denylist,
    hasAuthForProvider: params.hasAuthForProvider,
    onlyPluginIds,
    existing,
    existingNormalized,
    pluginToolOwnersByName,
    ctx: params.context,
    loadContext: context,
    runtimeOptions,
    currentRuntimeConfig: currentRuntimeConfigForDescriptorCache,
    configCacheKeyMemo,
    clientCaps,
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
  const preparedOrExplicitRegistry =
    context === params.preparedRuntime?.loadContext
      ? params.preparedRuntime.registry
      : params.runtimeRegistry;
  let registry = registryHasScopedPluginTools(
    preparedOrExplicitRegistry,
    runtimePluginIds,
    snapshot.plugins,
  )
    ? preparedOrExplicitRegistry
    : undefined;
  if (!registry) {
    registry = resolvePluginToolRegistry({
      loadOptions,
      onlyPluginIds: runtimePluginIds,
    });
  }
  if (!registry) {
    context.logger.warn(
      `plugin tool registry unavailable for plugin ids [${runtimePluginIds.join(", ")}]`,
    );
    return tools;
  }

  const scopedPluginIds = new Set(runtimePluginIds);
  const registryToolPluginIds = new Set(registry.tools.map((entry) => entry.pluginId));
  const missingRegistryToolPluginIds = runtimePluginIds.filter(
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
  const capturedDescriptorsByPluginId = new Map<string, CachedPluginToolDescriptor[]>();
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
            !isOptionalToolAllowed({
              toolName,
              pluginId: entry.pluginId,
              allowlist,
            })
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
          isOptionalToolAllowed({
            toolName: readPluginToolName(tool),
            pluginId: entry.pluginId,
            allowlist,
          }),
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
      pluginToolMeta.set(tool, {
        pluginId: entry.pluginId,
        ...(manifestPlugin?.kind ? { kind: manifestPlugin.kind } : {}),
        optional,
        replaySafe: isManifestToolReplaySafe({
          manifestPlugin,
          toolName: tool.name,
        }),
        sideEffecting: isManifestToolSideEffecting({
          manifestPlugin,
          toolName: tool.name,
        }),
        trustedLocalMedia: isTrustedManifestLocalMediaTool({
          manifestPlugin,
          toolName: tool.name,
        }),
      });
      if (manifestPlugin) {
        const capturedDescriptors = capturedDescriptorsByPluginId.get(entry.pluginId) ?? [];
        capturedDescriptors.push(
          capturePluginToolDescriptor({
            pluginId: entry.pluginId,
            tool,
            optional,
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
      plugin: manifestPlugin,
      toolNames: manifestPlugin.contracts?.tools ?? [],
      pluginId,
      allowlist,
    }).filter(
      (toolName) =>
        !denylistBlocksPluginTool({
          pluginId,
          toolName,
          denylist,
        }),
    );
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
          clientCaps,
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
