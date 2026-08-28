import { pruneMapToMaxSize } from "../infra/map-size.js";
import { generateSecureToken } from "../infra/secure-random.js";
import { getPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tools.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { isCoreCodingSurfaceToolName } from "./core-tool-factory-descriptors.js";
import type { ToolDefinition } from "./sessions/index.js";
import { compactToolInputHint, compactToolOutputHint } from "./tool-schema-hints.js";
import {
  TOOL_SEARCH_CONTROL_TOOL_NAMES,
  type CatalogSource,
  type CatalogTool,
  type CatalogVisibilityOptions,
  type ToolSearchCatalogApplyResult,
  type ToolSearchCatalogCompactionParams,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogSession,
  type ToolSearchCatalogTelemetry,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import { ToolInputError, type AnyAgentTool } from "./tools/common.js";

const MAX_REUSABLE_CATALOG_SNAPSHOTS = 256;
const reusableCatalogSnapshots = new Map<
  string,
  { entries: ToolSearchCatalogEntry[]; fingerprint: string }
>();
const catalogFingerprints = new WeakMap<ToolSearchCatalogSession, string>();
const catalogToolIdentities = new WeakMap<object, number>();
const untrustedSchemaIdentities = new WeakMap<object, number>();
let nextCatalogToolIdentity = 1;
let nextUntrustedSchemaIdentity = 1;

export function getReusableCatalogSnapshotCountForTest(): number {
  return reusableCatalogSnapshots.size;
}

function reusableCatalogKey(input: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  if (input.sessionId?.trim()) {
    return `session:${input.sessionId.trim()}`;
  }
  if (input.sessionKey?.trim()) {
    return `key:${input.sessionKey.trim()}`;
  }
  const agentId = input.agentId?.trim();
  return agentId ? `agent:${agentId}` : undefined;
}

function stableJsonFingerprint(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (seen.has(value)) {
    return '"[Circular]"';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonFingerprint(item, seen)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJsonFingerprint(record[key], seen)}`);
  return `{${entries.join(",")}}`;
}

function catalogToolIdentity(tool: CatalogTool): number {
  const existing = catalogToolIdentities.get(tool);
  if (existing !== undefined) {
    return existing;
  }
  const next = nextCatalogToolIdentity;
  nextCatalogToolIdentity += 1;
  catalogToolIdentities.set(tool, next);
  return next;
}

function untrustedSchemaFingerprint(schema: unknown): string {
  if (schema === null || typeof schema !== "object") {
    return stableJsonFingerprint(schema);
  }
  const existing = untrustedSchemaIdentities.get(schema);
  if (existing !== undefined) {
    return `object:${existing}`;
  }
  const next = nextUntrustedSchemaIdentity;
  nextUntrustedSchemaIdentity += 1;
  untrustedSchemaIdentities.set(schema, next);
  return `object:${next}`;
}

function catalogEntriesFingerprint(entries: readonly ToolSearchCatalogEntry[]): string {
  // Executable identities are part of reuse because function bodies are not JSON-stable.
  return entries
    .map((entry) =>
      [
        entry.id,
        entry.source,
        entry.sourceName ?? "",
        stableJsonFingerprint(entry.mcp),
        entry.name,
        entry.label ?? "",
        entry.description,
        // Remote/client schemas may be attacker-sized. Object identity still
        // invalidates reuse when a schema object is replaced without walking it.
        entry.source === "openclaw"
          ? stableJsonFingerprint(entry.parameters)
          : untrustedSchemaFingerprint(entry.parameters),
        entry.source === "openclaw"
          ? stableJsonFingerprint(entry.outputSchema)
          : untrustedSchemaFingerprint(entry.outputSchema),
        String(catalogToolIdentity(entry.tool)),
      ]
        .map((part) => JSON.stringify(part))
        .join(":"),
    )
    .toSorted()
    .join("\n");
}

function restoreToolSearchCatalog(params: {
  catalogRef: ToolSearchCatalogRef;
  entries: ToolSearchCatalogEntry[];
  fingerprint: string;
}): void {
  const next = {
    entries: params.entries,
    counterScope: generateSecureToken(12),
    searchCount: 0,
    describeCount: 0,
    callCount: 0,
  };
  params.catalogRef.current = next;
  delete params.catalogRef.closedTelemetry;
  catalogFingerprints.set(next, params.fingerprint);
  params.catalogRef.onChange?.();
}

function rememberReusableCatalog(key: string | undefined, catalog: ToolSearchCatalogSession): void {
  if (!key) {
    return;
  }
  const fingerprint = catalogFingerprints.get(catalog);
  if (!fingerprint) {
    return;
  }
  if (reusableCatalogSnapshots.has(key)) {
    reusableCatalogSnapshots.delete(key);
  }
  reusableCatalogSnapshots.set(key, { entries: catalog.entries, fingerprint });
  pruneMapToMaxSize(reusableCatalogSnapshots, MAX_REUSABLE_CATALOG_SNAPSHOTS);
}

function classifyTool(tool: CatalogTool): {
  source: CatalogSource;
  sourceName?: string;
  mcp?: PluginToolMcpMeta;
} {
  const meta = getPluginToolMeta(tool as AnyAgentTool);
  const pluginId = meta?.pluginId?.trim();
  const mcp = meta?.mcp;
  if (mcp) {
    return { source: "mcp", sourceName: mcp.safeServerName || pluginId || "mcp", mcp };
  }
  if (pluginId === "bundle-mcp") {
    return { source: "mcp", sourceName: pluginId };
  }
  if (pluginId) {
    return { source: "openclaw", sourceName: pluginId };
  }
  return { source: "openclaw", sourceName: "core" };
}

function makeCatalogId(tool: CatalogTool, source: CatalogSource, sourceName?: string): string {
  const owner = sourceName?.trim() || "core";
  return `${source}:${owner}:${tool.name}`;
}

function wrapCatalogTool(tool: AnyAgentTool, hookContext?: HookContext): AnyAgentTool {
  if (!hookContext || isToolWrappedWithBeforeToolCallHook(tool)) {
    return tool;
  }
  return wrapToolWithBeforeToolCallHook(tool, hookContext);
}

export function prepareToolSearchCatalogExecutionTool(
  entry: ToolSearchCatalogEntry,
  options: { prepareInput?: boolean; validateInput?: boolean },
): CatalogTool {
  const prepareInput =
    options.prepareInput &&
    entry.source === "openclaw" &&
    "prepareBeforeToolCallParams" in entry.tool &&
    typeof entry.tool.prepareBeforeToolCallParams === "function";
  const validateInput = options.validateInput && entry.source === "openclaw";
  if (!prepareInput && !validateInput) {
    return entry.tool;
  }
  // SAFETY: both gates above restrict wrapper execution to OpenClaw-owned catalog tools.
  const tool = entry.tool as AnyAgentTool;
  const wrapperOptions = options.prepareInput ? { protectNetworkErrors: false } : undefined;
  if (!isToolWrappedWithBeforeToolCallHook(tool)) {
    return wrapToolWithBeforeToolCallHook(tool, undefined, wrapperOptions);
  }
  return wrapperOptions
    ? rewrapToolWithBeforeToolCallHook(tool, undefined, wrapperOptions)
    : entry.tool;
}

function toCatalogEntry(
  tool: CatalogTool,
  sourceOverride?: CatalogSource,
  hookContext?: HookContext,
): ToolSearchCatalogEntry {
  const classified = classifyTool(tool);
  const source = sourceOverride ?? classified.source;
  const sourceName = sourceOverride === "client" ? "client" : classified.sourceName;
  const catalogTool =
    source === "client" ? tool : wrapCatalogTool(tool as AnyAgentTool, hookContext);
  return {
    id: makeCatalogId(tool, source, sourceName),
    source,
    sourceName,
    ...(source === "mcp" && classified.mcp ? { mcp: classified.mcp } : {}),
    name: tool.name,
    label: tool.label,
    description: tool.description ?? "",
    parameters: tool.parameters,
    ...(source === "openclaw" && (tool as AnyAgentTool).outputSchema
      ? { outputSchema: (tool as AnyAgentTool).outputSchema }
      : {}),
    tool: catalogTool,
  };
}

function shouldCatalogTool(tool: AnyAgentTool): boolean {
  return !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name) && tool.catalogMode !== "direct-only";
}

/**
 * Core file/shell primitives and caller-required names (e.g. message when it is
 * the only reply path) stay visible while remaining searchable. Both must
 * resolve to trusted OpenClaw tools: an MCP lookalike must never become a
 * direct delivery or core-coding tool.
 */
export function isDirectVisibleCatalogTool(
  tool: AnyAgentTool,
  directToolNames: ReadonlySet<string>,
): boolean {
  const classified = classifyTool(tool);
  return (
    classified.source === "openclaw" &&
    (directToolNames.has(tool.name) ||
      (isCoreCodingSurfaceToolName(tool.name) && classified.sourceName === "core"))
  );
}

export function registerHeadlessToolSearchCatalog(params: {
  catalogRef: ToolSearchCatalogRef;
  tools: readonly AnyAgentTool[];
  hookContext?: HookContext;
}): void {
  const { catalogRef, tools, hookContext } = params;
  const entries = tools
    .filter((tool) => shouldCatalogTool(tool))
    .map((tool) => {
      const scopedTool =
        hookContext && isToolWrappedWithBeforeToolCallHook(tool)
          ? rewrapToolWithBeforeToolCallHook(tool, hookContext)
          : tool;
      return toCatalogEntry(scopedTool, undefined, hookContext);
    });
  registerToolSearchCatalog({ catalogRef, entries });
}

export function collectUniqueCatalogToolNames(tools: readonly AnyAgentTool[]): Set<string> {
  const nameCounts = new Map<string, number>();
  for (const tool of tools) {
    if (shouldCatalogTool(tool)) {
      nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
    }
  }
  return new Set(
    Array.from(nameCounts)
      .filter(([, count]) => count === 1)
      .map(([name]) => name),
  );
}

function registerToolSearchCatalog(params: {
  catalogRef: ToolSearchCatalogRef;
  entries: ToolSearchCatalogEntry[];
  append?: boolean;
  fingerprint?: string;
}): ToolSearchCatalogSession {
  const prior = params.append ? params.catalogRef.current : undefined;
  const byId = new Map((prior?.entries ?? []).map((entry) => [entry.id, entry]));
  for (const entry of params.entries) {
    byId.set(entry.id, entry);
  }
  const next = {
    entries: Array.from(byId.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
    // Appended client tools extend the same counter lifetime. A replacement
    // gets a new scope so telemetry consumers never infer resets from values.
    counterScope: prior?.counterScope ?? generateSecureToken(12),
    searchCount: prior?.searchCount ?? 0,
    describeCount: prior?.describeCount ?? 0,
    callCount: prior?.callCount ?? 0,
  };
  // The supplied fingerprint describes the input entries. Duplicate IDs are
  // last-write-wins, so recompute when registration changed the entry set.
  const fingerprint =
    params.fingerprint !== undefined && next.entries.length === params.entries.length
      ? params.fingerprint
      : catalogEntriesFingerprint(next.entries);
  catalogFingerprints.set(next, fingerprint);
  params.catalogRef.current = next;
  delete params.catalogRef.closedTelemetry;
  params.catalogRef.onChange?.();
  return next;
}

export function clearToolSearchCatalog(params: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
}): void {
  if (params.catalogRef) {
    // Capture only aggregate facts before releasing executable state. Disposal
    // can wake an in-flight wait that still needs its final diagnostics.
    if (params.catalogRef.current) {
      params.catalogRef.closedTelemetry = getTelemetry(params.catalogRef.current);
    }
    params.catalogRef.current = undefined;
    params.catalogRef.disposeObserver?.();
    params.catalogRef.onDispose?.forEach((dispose) => dispose());
    delete params.catalogRef.onChange;
    delete params.catalogRef.disposeObserver;
    delete params.catalogRef.onDispose;
  }
  if (!params.runId?.trim()) {
    const snapshotKey = reusableCatalogKey(params);
    if (snapshotKey) {
      reusableCatalogSnapshots.delete(snapshotKey);
    }
  }
}

/** Restricts a run-scoped catalog to an already-resolved set of concrete tool names. */
export function restrictToolSearchCatalog(params: {
  catalogRef?: ToolSearchCatalogRef;
  allowedToolNames: ReadonlySet<string>;
  baselineEntries?: readonly ToolSearchCatalogEntry[];
}): number {
  const current = params.catalogRef?.current;
  if (!current) {
    return 0;
  }
  const entries = (params.baselineEntries ?? current.entries).filter((entry) =>
    params.allowedToolNames.has(entry.name),
  );
  if (
    entries.length === current.entries.length &&
    entries.every((entry, index) => entry === current.entries[index])
  ) {
    return entries.length;
  }
  current.entries = entries;
  catalogFingerprints.set(current, catalogEntriesFingerprint(entries));
  params.catalogRef?.onChange?.();
  return entries.length;
}

export function resolveCatalog(ctx: ToolSearchToolContext): ToolSearchCatalogSession {
  const catalog = ctx.catalogRef?.current;
  if (!catalog) {
    throw new ToolInputError("Tool Search catalog is unavailable for this run.");
  }
  return catalog;
}

function getTelemetry(catalog: ToolSearchCatalogSession): ToolSearchCatalogTelemetry {
  const sources: Record<CatalogSource, number> = { openclaw: 0, mcp: 0, client: 0 };
  for (const entry of catalog.entries) {
    sources[entry.source] += 1;
  }
  return {
    catalogSize: catalog.entries.length,
    sources,
    counterScope: catalog.counterScope,
    searchCount: catalog.searchCount,
    describeCount: catalog.describeCount,
    callCount: catalog.callCount,
  };
}

export function readToolSearchCatalogTelemetry(
  ctx: ToolSearchToolContext,
): ToolSearchCatalogTelemetry {
  const closed = ctx.catalogRef?.closedTelemetry;
  if (!ctx.catalogRef?.current && closed) {
    return { ...closed, sources: { ...closed.sources } };
  }
  return getTelemetry(resolveCatalog(ctx));
}

export function visibleCatalogEntries(
  catalog: ToolSearchCatalogSession,
  options?: CatalogVisibilityOptions,
): ToolSearchCatalogEntry[] {
  const { includeMcp, allowedIds } = options ?? {};
  if (includeMcp !== false && !allowedIds) {
    return catalog.entries;
  }
  return catalog.entries.filter(
    (entry) =>
      (includeMcp !== false || entry.source !== "mcp") && (!allowedIds || allowedIds.has(entry.id)),
  );
}

export function compactToolSearchCatalogEntry(entry: ToolSearchCatalogEntry) {
  const output =
    entry.source === "openclaw" ? compactToolOutputHint(entry.outputSchema) : undefined;
  // Node provenance is namespace-only metadata; generic Tool Search keeps its
  // existing MCP result shape outside Code Mode.
  const mcp = entry.mcp
    ? {
        serverName: entry.mcp.serverName,
        safeServerName: entry.mcp.safeServerName,
        toolName: entry.mcp.toolName,
        operation: entry.mcp.operation,
      }
    : undefined;
  return {
    id: entry.id,
    source: entry.source,
    sourceName: entry.sourceName,
    ...(mcp ? { mcp } : {}),
    name: entry.name,
    label: entry.label,
    description: entry.description,
    input: entry.source === "openclaw" ? compactToolInputHint(entry.parameters) : "unknown",
    ...(output ? { output } : {}),
  };
}

export function createToolSearchCatalogRef(): ToolSearchCatalogRef {
  return {};
}

export function applyToolCatalogCompaction(
  params: ToolSearchCatalogCompactionParams,
): ToolSearchCatalogApplyResult {
  if (!params.enabled) {
    return {
      tools: params.tools,
      compacted: false,
      catalogToolCount: 0,
      catalogRegistered: false,
      catalogReused: false,
    };
  }
  const hasControlTool = params.tools.some((tool) => params.isVisibleControlTool(tool));
  const catalogRef = params.catalogRef;
  if (!hasControlTool || !catalogRef) {
    return {
      tools: params.tools.filter((tool) => !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)),
      compacted: false,
      catalogToolCount: 0,
      catalogRegistered: false,
      catalogReused: false,
    };
  }

  const visible: AnyAgentTool[] = [];
  const catalog: ToolSearchCatalogEntry[] = [];
  const shouldCatalog = (tool: AnyAgentTool) =>
    shouldCatalogTool(tool) && (params.shouldCatalogTool?.(tool) ?? true);
  for (const tool of params.tools) {
    if (params.isVisibleControlTool(tool)) {
      visible.push(tool);
      continue;
    }
    if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)) {
      continue;
    }
    if (shouldCatalog(tool)) {
      catalog.push(toCatalogEntry(tool, undefined, params.toolHookContext));
      if (!params.isVisibleCatalogTool?.(tool)) {
        continue;
      }
    }
    visible.push(tool);
  }
  // Hook-wrapped entries carry run context and have fresh executable identities, so
  // their snapshots cannot be reused and would only retain the completed run.
  const hasHookBoundEntry = catalog.some((entry) =>
    isToolWrappedWithBeforeToolCallHook(entry.tool as AnyAgentTool),
  );
  const reusableKey = hasHookBoundEntry ? undefined : reusableCatalogKey(params);
  const existingCatalog = catalogRef.current;
  const incomingFingerprint =
    existingCatalog || reusableKey ? catalogEntriesFingerprint(catalog) : undefined;
  if (existingCatalog && catalogFingerprints.get(existingCatalog) === incomingFingerprint) {
    return {
      tools: visible,
      compacted: catalog.length > 0,
      catalogToolCount: catalog.length,
      catalogRegistered: true,
      catalogReused: true,
    };
  }

  const reusableSnapshot = reusableKey ? reusableCatalogSnapshots.get(reusableKey) : undefined;
  if (reusableSnapshot && reusableSnapshot.fingerprint === incomingFingerprint) {
    restoreToolSearchCatalog({
      catalogRef,
      entries: reusableSnapshot.entries,
      fingerprint: reusableSnapshot.fingerprint,
    });
    if (reusableKey) {
      reusableCatalogSnapshots.delete(reusableKey);
      reusableCatalogSnapshots.set(reusableKey, reusableSnapshot);
    }
    return {
      tools: visible,
      compacted: catalog.length > 0,
      catalogToolCount: catalog.length,
      catalogRegistered: true,
      catalogReused: true,
    };
  }

  const registered = registerToolSearchCatalog({
    catalogRef,
    entries: catalog,
    fingerprint: incomingFingerprint,
  });
  rememberReusableCatalog(reusableKey, registered);
  return {
    tools: visible,
    compacted: catalog.length > 0,
    catalogToolCount: catalog.length,
    catalogRegistered: true,
    catalogReused: false,
  };
}

export function addClientToolsToToolCatalog(params: {
  tools: ToolDefinition[];
  enabled: boolean;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
}): { tools: ToolDefinition[]; compacted: boolean; catalogToolCount: number } {
  const catalogRef = params.catalogRef;
  if (!params.enabled || !catalogRef?.current || params.tools.length === 0) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  registerToolSearchCatalog({
    catalogRef,
    entries: params.tools.map((tool) => toCatalogEntry(tool, "client")),
    append: true,
  });
  return { tools: [], compacted: params.tools.length > 0, catalogToolCount: params.tools.length };
}
