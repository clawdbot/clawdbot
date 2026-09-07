import { stableStringify } from "@openclaw/normalization-core";
import { generateSecureHex } from "../infra/secure-random.js";
import { getPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tool-metadata.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { getBeforeToolCallDiagnosticOptions } from "./before-tool-call-metadata.js";
import { isCoreCodingSurfaceToolName } from "./core-tool-factory-descriptors.js";
import type { ToolDefinition } from "./sessions/index.js";
import { compactToolInputHint, compactToolOutputHint } from "./tool-schema-hints.js";
import { disposeToolSearchSchedule } from "./tool-search-scheduling.js";
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

const catalogMetadata = new WeakMap<
  ToolSearchCatalogSession,
  { fingerprint: string; toolExecutionAllow?: readonly string[] }
>();
const untrustedSchemaIdentities = new WeakMap<object, number>();
let nextUntrustedSchemaIdentity = 1;

function catalogEntriesFingerprint(entries: readonly ToolSearchCatalogEntry[]): string {
  return entries
    .map((entry) =>
      stableStringify([
        entry.id,
        entry.source,
        entry.sourceName ?? "",
        entry.mcp,
        entry.name,
        entry.label ?? "",
        entry.description,
        entry.directVisible === true,
        entry.source === "openclaw"
          ? stableStringify(entry.parameters)
          : untrustedSchemaFingerprint(entry.parameters),
        entry.source === "openclaw"
          ? stableStringify(entry.outputSchema)
          : untrustedSchemaFingerprint(entry.outputSchema),
      ]),
    )
    .toSorted()
    .join("\n");
}

function untrustedSchemaFingerprint(schema: unknown): string {
  if (schema === null || typeof schema !== "object") {
    return stableStringify(schema);
  }
  // Remote/client schemas may be attacker-sized or lazy hostile objects. Identity
  // invalidates reuse when their owning runtime replaces them without traversing them.
  const existing = untrustedSchemaIdentities.get(schema);
  if (existing !== undefined) {
    return `object:${existing}`;
  }
  const next = nextUntrustedSchemaIdentity++;
  untrustedSchemaIdentities.set(schema, next);
  return `object:${next}`;
}

function rebindCatalogExecutors(
  existingEntries: ToolSearchCatalogEntry[],
  currentEntries: readonly ToolSearchCatalogEntry[],
): ToolSearchCatalogEntry[] | undefined {
  const currentTools = new Map(currentEntries.map((entry) => [entry.id, entry.tool]));
  if (currentTools.size !== currentEntries.length || currentTools.size !== existingEntries.length) {
    return undefined;
  }
  // Keep identical same-run entries; changed executors need a detached descriptor snapshot.
  // Every exact ID must still resolve, so missing entries fail the reuse check below.
  const rebound = existingEntries.every(
    (entry) => entry.tool && currentTools.get(entry.id) === entry.tool,
  )
    ? existingEntries
    : existingEntries.map((entry) => {
        const tool = currentTools.get(entry.id);
        return tool ? { ...entry, tool } : undefined;
      });
  return rebound.every((entry): entry is ToolSearchCatalogEntry => entry !== undefined)
    ? rebound
    : undefined;
}

// Counter scopes ride inside model-visible telemetry and persisted tool results.
// Lowercase hex can never form a credential-shaped substring (hf_/sk-/ghp_/…),
// so tool-payload redaction leaves persisted results embedding the scope intact.
function generateCounterScope(): string {
  return generateSecureHex(12);
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
  if (!wrapperOptions || getBeforeToolCallDiagnosticOptions(tool)?.protectNetworkErrors === false) {
    return entry.tool;
  }
  return rewrapToolWithBeforeToolCallHook(tool, undefined, wrapperOptions);
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

function finalizeCatalogAvailability(
  entries: ToolSearchCatalogEntry[],
  toolExecutionAllow?: readonly string[],
): ToolSearchCatalogEntry[] {
  const orderedEntries = entries.toSorted((a, b) => a.id.localeCompare(b.id));
  // Client definitions win exact-name shadows, matching the guest projection.
  const tools = orderedEntries
    .toSorted((a, b) => Number(a.source === "client") - Number(b.source === "client"))
    .map((entry) => entry.tool);
  finalizeAgentToolAvailability(tools, { toolExecutionAllow });
  // The array is a fresh copy, but its descriptors may belong to retained snapshots.
  orderedEntries.forEach((entry, index) => {
    if (
      entry.parameters !== entry.tool.parameters ||
      entry.description !== entry.tool.description
    ) {
      orderedEntries[index] = {
        ...entry,
        parameters: entry.tool.parameters,
        description: entry.tool.description ?? "",
      };
    }
  });
  return orderedEntries;
}

function registerToolSearchCatalog(params: {
  catalogRef: ToolSearchCatalogRef;
  entries: ToolSearchCatalogEntry[];
  append?: boolean;
  toolExecutionAllow?: readonly string[];
}): void {
  const prior = params.append ? params.catalogRef.current : undefined;
  // Appending client definitions cannot widen the current run's execution policy.
  const toolExecutionAllow = prior
    ? catalogMetadata.get(prior)?.toolExecutionAllow
    : params.toolExecutionAllow;
  const byId = new Map((prior?.entries ?? []).map((entry) => [entry.id, entry]));
  for (const entry of params.entries) {
    byId.set(entry.id, entry);
  }
  const next = {
    entries: finalizeCatalogAvailability(Array.from(byId.values()), toolExecutionAllow),
    // Appended client tools extend the same counter lifetime. A replacement
    // gets a new scope so telemetry consumers never infer resets from values.
    counterScope: prior?.counterScope ?? generateCounterScope(),
    searchCount: prior?.searchCount ?? 0,
    describeCount: prior?.describeCount ?? 0,
    callCount: prior?.callCount ?? 0,
  };
  // Finalization can narrow schemas after last-write-wins registration.
  catalogMetadata.set(next, {
    fingerprint: catalogEntriesFingerprint(next.entries),
    toolExecutionAllow,
  });
  params.catalogRef.current = next;
  delete params.catalogRef.closedTelemetry;
  params.catalogRef.onChange?.();
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
      finalizeAgentToolAvailability(
        params.catalogRef.current.entries.map((entry) => entry.tool),
        {
          toolExecutionAllow: [],
        },
      );
    }
    params.catalogRef.current = undefined;
    disposeToolSearchSchedule(params.catalogRef);
    params.catalogRef.disposeObserver?.();
    params.catalogRef.onDispose?.forEach((dispose) => dispose());
    delete params.catalogRef.onChange;
    delete params.catalogRef.disposeObserver;
    delete params.catalogRef.onDispose;
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
  const metadata = catalogMetadata.get(current);
  const entries = finalizeCatalogAvailability(
    (params.baselineEntries ?? current.entries).filter((entry) =>
      params.allowedToolNames.has(entry.name),
    ),
    metadata?.toolExecutionAllow,
  );
  if (
    entries.length === current.entries.length &&
    entries.every((entry, index) => entry === current.entries[index])
  ) {
    return entries.length;
  }
  current.entries = entries;
  catalogMetadata.set(current, {
    ...metadata,
    fingerprint: catalogEntriesFingerprint(current.entries),
  });
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
  let catalog: ToolSearchCatalogEntry[] = [];
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
      const directVisible = params.isVisibleCatalogTool?.(tool) === true;
      catalog.push({ ...toCatalogEntry(tool, undefined, params.toolHookContext), directVisible });
      if (!directVisible) {
        continue;
      }
    }
    visible.push(tool);
  }
  // Callable bindings can change while descriptors stay equal; normalize before cache reuse.
  catalog = finalizeCatalogAvailability(catalog, params.toolExecutionAllow);
  const existingCatalog = catalogRef.current;
  const incomingFingerprint = existingCatalog ? catalogEntriesFingerprint(catalog) : undefined;
  const metadata = existingCatalog && catalogMetadata.get(existingCatalog);
  const reboundEntries =
    existingCatalog &&
    metadata &&
    metadata.fingerprint === incomingFingerprint &&
    stableStringify(metadata.toolExecutionAllow) === stableStringify(params.toolExecutionAllow)
      ? rebindCatalogExecutors(existingCatalog.entries, catalog)
      : undefined;
  if (existingCatalog && reboundEntries) {
    existingCatalog.entries = reboundEntries;
  } else {
    registerToolSearchCatalog({
      catalogRef,
      entries: catalog,
      toolExecutionAllow: params.toolExecutionAllow,
    });
  }
  return {
    tools: visible,
    compacted: catalog.length > 0,
    catalogToolCount: catalog.length,
    catalogRegistered: true,
    catalogReused: reboundEntries !== undefined,
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
