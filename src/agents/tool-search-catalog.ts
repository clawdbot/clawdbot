import { uniqueStrings, uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { getPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tools.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
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
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import { ToolInputError, type AnyAgentTool } from "./tools/common.js";

const MAX_REUSABLE_CATALOG_SNAPSHOTS = 256;
const SESSION_CATALOGS_KEY = Symbol.for("openclaw.toolSearch.sessionCatalogs");
const globalToolSearchState = globalThis as typeof globalThis & {
  [SESSION_CATALOGS_KEY]?: Map<string, ToolSearchCatalogSession>;
};

export const sessionCatalogs =
  globalToolSearchState[SESSION_CATALOGS_KEY] ??
  (globalToolSearchState[SESSION_CATALOGS_KEY] = new Map<string, ToolSearchCatalogSession>());
export const reusableCatalogSnapshots = new Map<
  string,
  { entries: ToolSearchCatalogEntry[]; fingerprint: string }
>();
const catalogFingerprints = new WeakMap<ToolSearchCatalogSession, string>();
const catalogToolIdentities = new WeakMap<object, number>();
const untrustedSchemaIdentities = new WeakMap<object, number>();
let nextCatalogToolIdentity = 1;
let nextUntrustedSchemaIdentity = 1;

function sessionCatalogKeys(input: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
}): string[] {
  const runId = input.runId?.trim();
  if (runId) {
    return [`run:${runId}`];
  }
  const keys: string[] = [];
  if (input.sessionId?.trim()) {
    keys.push(`session:${input.sessionId.trim()}`);
  }
  if (input.sessionKey?.trim()) {
    keys.push(`key:${input.sessionKey.trim()}`);
  }
  if (input.agentId?.trim()) {
    keys.push(`agent:${input.agentId.trim()}`);
  }
  return uniqueStrings(keys);
}

function sessionCatalogKey(input: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
}): string | undefined {
  return sessionCatalogKeys(input)[0];
}

function reusableCatalogKey(input: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  return sessionCatalogKey({
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    agentId: input.agentId,
  });
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
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  entries: ToolSearchCatalogEntry[];
  fingerprint: string;
}): ToolSearchCatalogSession | undefined {
  const keys = sessionCatalogKeys(params);
  if (keys.length === 0 && !params.catalogRef) {
    return undefined;
  }
  const next = {
    entries: params.entries,
    searchCount: 0,
    describeCount: 0,
    callCount: 0,
  };
  if (params.catalogRef) {
    params.catalogRef.current = next;
  }
  catalogFingerprints.set(next, params.fingerprint);
  for (const key of keys) {
    sessionCatalogs.set(key, next);
  }
  return next;
}

function bindToolSearchCatalog(params: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  catalog: ToolSearchCatalogSession;
}): void {
  if (params.catalogRef) {
    params.catalogRef.current = params.catalog;
  }
  for (const key of sessionCatalogKeys(params)) {
    sessionCatalogs.set(key, params.catalog);
  }
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
  while (reusableCatalogSnapshots.size > MAX_REUSABLE_CATALOG_SNAPSHOTS) {
    const oldestKey = reusableCatalogSnapshots.keys().next().value;
    if (!oldestKey) {
      break;
    }
    reusableCatalogSnapshots.delete(oldestKey);
  }
}

export function classifyTool(tool: CatalogTool): {
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
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  entries: ToolSearchCatalogEntry[];
  append?: boolean;
}): ToolSearchCatalogSession | undefined {
  const keys = sessionCatalogKeys(params);
  const primaryKey = keys[0];
  if (!primaryKey && !params.catalogRef) {
    return undefined;
  }
  const prior = params.append
    ? (params.catalogRef?.current ?? (primaryKey ? sessionCatalogs.get(primaryKey) : undefined))
    : undefined;
  const byId = new Map<string, ToolSearchCatalogEntry>();
  for (const entry of prior?.entries ?? []) {
    byId.set(entry.id, entry);
  }
  for (const entry of params.entries) {
    byId.set(entry.id, entry);
    byId.set(entry.name, entry);
  }
  const next = {
    entries: uniqueValues(byId.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
    searchCount: prior?.searchCount ?? 0,
    describeCount: prior?.describeCount ?? 0,
    callCount: prior?.callCount ?? 0,
  };
  catalogFingerprints.set(next, catalogEntriesFingerprint(next.entries));
  if (params.catalogRef) {
    params.catalogRef.current = next;
  }
  for (const key of keys) {
    sessionCatalogs.set(key, next);
  }
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
    params.catalogRef.current = undefined;
  }
  for (const key of sessionCatalogKeys(params)) {
    sessionCatalogs.delete(key);
  }
  if (!params.runId?.trim()) {
    const snapshotKey = reusableCatalogKey(params);
    if (snapshotKey) {
      reusableCatalogSnapshots.delete(snapshotKey);
    }
  }
}

export function resolveCatalog(ctx: ToolSearchToolContext): ToolSearchCatalogSession {
  if (ctx.catalogRef?.current) {
    return ctx.catalogRef.current;
  }
  const keys = sessionCatalogKeys(ctx);
  for (const key of keys) {
    const catalog = sessionCatalogs.get(key);
    if (catalog) {
      return catalog;
    }
  }
  if (ctx.runId?.trim()) {
    throw new ToolInputError("Tool Search catalog is unavailable for this run.");
  }
  const uniqueCatalogs = uniqueValues(sessionCatalogs.values());
  if (uniqueCatalogs.length === 1 && uniqueCatalogs[0]) {
    return uniqueCatalogs[0];
  }
  throw new ToolInputError("Tool Search catalog is unavailable for this run.");
}

export function visibleCatalogEntries(
  catalog: ToolSearchCatalogSession,
  options?: CatalogVisibilityOptions,
): ToolSearchCatalogEntry[] {
  return options?.includeMcp === false
    ? catalog.entries.filter((entry) => entry.source !== "mcp")
    : catalog.entries;
}

export function compactToolSearchCatalogEntry(entry: ToolSearchCatalogEntry) {
  const output =
    entry.source === "openclaw" ? compactToolOutputHint(entry.outputSchema) : undefined;
  return {
    id: entry.id,
    source: entry.source,
    sourceName: entry.sourceName,
    ...(entry.mcp ? { mcp: entry.mcp } : {}),
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
  const key = sessionCatalogKey(params);
  if (!hasControlTool || (!key && !params.catalogRef)) {
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
  const incomingFingerprint = catalogEntriesFingerprint(catalog);
  const existingCatalog =
    params.catalogRef?.current ?? (key ? sessionCatalogs.get(key) : undefined);
  if (existingCatalog && catalogFingerprints.get(existingCatalog) === incomingFingerprint) {
    bindToolSearchCatalog({ ...params, catalog: existingCatalog });
    return {
      tools: visible,
      compacted: catalog.length > 0,
      catalogToolCount: catalog.length,
      catalogRegistered: true,
      catalogReused: true,
    };
  }

  const reusableKey = reusableCatalogKey(params);
  const reusableSnapshot = reusableKey ? reusableCatalogSnapshots.get(reusableKey) : undefined;
  if (reusableSnapshot?.fingerprint === incomingFingerprint) {
    restoreToolSearchCatalog({
      ...params,
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

  const registered = registerToolSearchCatalog({ ...params, entries: catalog, append: false });
  if (registered) {
    rememberReusableCatalog(reusableKey, registered);
  }
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
  const key = sessionCatalogKey(params);
  if (!params.enabled || (!key && !params.catalogRef)) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  const existing = params.catalogRef?.current ?? (key ? sessionCatalogs.get(key) : undefined);
  if (!existing) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  registerToolSearchCatalog({
    ...params,
    entries: params.tools.map((tool) => toCatalogEntry(tool, "client")),
    append: true,
  });
  return { tools: [], compacted: params.tools.length > 0, catalogToolCount: params.tools.length };
}
