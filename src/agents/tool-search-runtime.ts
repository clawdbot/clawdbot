import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { levenshteinDistance } from "../shared/levenshtein-distance.js";
import { resolveAgentToolExecutionSchema } from "./agent-tool-availability.js";
import {
  finalizeToolTerminalPresentation,
  getBeforeToolCallFailureDisposition,
  isPreExecutionBlockedToolResult,
} from "./agent-tools.before-tool-call.js";
import { runWithToolExecutionValidation } from "./agent-tools.execution-validation.js";
import { getChannelAgentToolMeta } from "./channel-tool-metadata.js";
import type { AgentToolResult } from "./runtime/index.js";
import { bindJoinedCollectorInvocation } from "./subagents/swarm/swarm-collector-capability.js";
import { isAgentToolReplaySafe } from "./tool-replay-safety.js";
import {
  isToolResultError,
  isTrustedToolExecutionPreflightError,
  protectNetworkToolExecutionError,
} from "./tool-result-error.js";
import {
  compactToolSearchCatalogEntry,
  prepareToolSearchCatalogExecutionTool,
  readToolSearchCatalogTelemetry,
  resolveCatalog,
  visibleCatalogEntries,
} from "./tool-search-catalog.js";
import { renderToolSearchControlText } from "./tool-search-control-result.js";
import {
  buildLexicalIndex,
  readParameterText,
  scoreLexical,
  tokenizeDocument,
  tokenizeQuery,
} from "./tool-search-ranking.js";
import { readToolSearchLimit } from "./tool-search-request.js";
import { snapshotToolSearchTargetTranscriptResult } from "./tool-search-transcript.js";
import type {
  CatalogVisibilityOptions,
  ToolSearchCallOptions,
  ToolSearchCatalogEntry,
  ToolSearchCatalogSession,
  ToolSearchCatalogToolExecutor,
  ToolSearchConfig,
  ToolSearchToolContext,
  UnknownToolErrorOptions,
  UnknownToolRecoverySurface,
} from "./tool-search-types.js";
import { asToolParamsRecord, jsonResult, ToolInputError } from "./tools/common.js";

function describeEntry(entry: ToolSearchCatalogEntry) {
  return {
    ...compactToolSearchCatalogEntry(entry),
    parameters: entry.parameters ?? {},
    ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
  };
}

/**
 * Text indexed for one catalog entry. Parameter names and their descriptions are
 * included because they often carry the only words a task shares with a tool:
 * "post a message to a channel" reaches a tool whose description says only
 * "Send a message" through its `channel` parameter. Codex and the Claude API
 * tool-search tools index argument metadata for the same reason.
 */
function toolSearchEntryText(entry: ToolSearchCatalogEntry, parameterText?: string): string {
  // Only first-party schemas are walked. MCP and client parameters are untrusted
  // and deliberately never traversed: compactToolSearchCatalogEntry reports them
  // as "unknown" for the same reason, and a client may hand us a lazy object that
  // throws on property access.
  const parameters =
    parameterText ?? (entry.source === "openclaw" ? readParameterText(entry.parameters) : "");
  return [entry.name, entry.id, entry.label ?? "", entry.description, parameters]
    .filter(Boolean)
    .join(" ");
}

function tokenizeLookupValue(input: string): Set<string> {
  return new Set(normalizeStringEntries(input.toLowerCase().split(/[^a-z0-9]+/u)));
}

function scoreUnknownToolSuggestion(needle: string, entry: ToolSearchCatalogEntry): number {
  const normalizedNeedle = needle.toLowerCase();
  const name = entry.name.toLowerCase();
  const id = entry.id.toLowerCase();
  const label = (entry.label ?? "").toLowerCase();
  const description = entry.description.toLowerCase();
  const needleTokens = tokenizeLookupValue(needle);
  const entryTokens = tokenizeLookupValue(
    `${entry.name} ${entry.id} ${entry.label ?? ""} ${entry.description}`,
  );
  let score = 0;
  if ((name && normalizedNeedle.includes(name)) || id.includes(normalizedNeedle)) {
    score += 40;
  }
  if (name && needleTokens.has(name)) {
    score += 40;
  }
  for (const token of needleTokens) {
    if (entryTokens.has(token)) {
      score += 12;
    }
  }
  if (label.includes(normalizedNeedle) || description.includes(normalizedNeedle)) {
    score += 8;
  }
  return score;
}

function formatUnknownToolIdError(
  needle: string,
  entries: readonly ToolSearchCatalogEntry[],
  options: UnknownToolErrorOptions = {},
): string {
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const suggestions = uniqueStrings(
    entries
      .map((entry) => ({
        value: options.exactIdOnly || (nameCounts.get(entry.name) ?? 0) > 1 ? entry.id : entry.name,
        score: scoreUnknownToolSuggestion(needle, entry),
      }))
      .filter((candidate) => candidate.score > 0)
      .toSorted((a, b) => b.score - a.score || a.value.localeCompare(b.value))
      .map((candidate) => candidate.value),
  ).slice(0, 3);
  const recoveryText =
    options.recoverySurface === "code-mode"
      ? "Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name."
      : options.recoverySurface === "catalog"
        ? "Use catalog.search to find a callable tool handle, then call the handle or use its describe method."
        : "Use tool_search to find a tool, tool_describe to inspect it, then tool_call with the exact id or name.";
  if (suggestions.length === 0) {
    return `Unknown tool id: ${needle}. ${recoveryText}`;
  }
  return `Unknown tool id: ${needle}. Did you mean: ${suggestions.join(", ")}? ${recoveryText}`;
}

function findEntry(
  catalog: ToolSearchCatalogSession,
  id: string,
  options?: CatalogVisibilityOptions,
  errorOptions?: UnknownToolErrorOptions,
): ToolSearchCatalogEntry {
  const needle = id.trim();
  const entries = visibleCatalogEntries(catalog, options);
  const exactIdEntry = entries.find((candidate) => candidate.id === needle);
  if (exactIdEntry) {
    return exactIdEntry;
  }
  const namedEntries = entries.filter((candidate) => candidate.name === needle);
  if (namedEntries.length > 1) {
    throw new ToolInputError(`Ambiguous tool name: ${needle}; use an exact tool id.`);
  }
  const namedEntry = namedEntries[0];
  if (!namedEntry) {
    throw new ToolInputError(formatUnknownToolIdError(needle, entries, errorOptions));
  }
  return namedEntry;
}

function findEntryByExactId(
  catalog: ToolSearchCatalogSession,
  id: string,
  errorOptions: UnknownToolErrorOptions = {},
): ToolSearchCatalogEntry {
  const needle = id.trim();
  const entry = catalog.entries.find((candidate) => candidate.id === needle);
  if (!entry) {
    throw new ToolInputError(
      formatUnknownToolIdError(needle, catalog.entries, { ...errorOptions, exactIdOnly: true }),
    );
  }
  return entry;
}

const TOOL_SEARCH_SELECTOR_KEYS = ["id", "toolId", "name"] as const;

function readToolSearchSelector(params: Record<string, unknown>): string | undefined {
  const value = params.id ?? params.toolId ?? params.name;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function readToolSearchId(args: unknown): string {
  const params = asToolParamsRecord(args);
  const value = readToolSearchSelector(params);
  if (value === undefined) {
    throw new ToolInputError("id must be a non-empty string.");
  }
  return value.trim();
}

export function readToolSearchCallArgs(
  args: unknown,
  catalog?: ToolSearchCatalogSession,
): { id: string; input: unknown } {
  const params = asToolParamsRecord(args);
  const dottedInput = Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => key.startsWith("args.") && key.length > 5)
      .map(([key, value]) => [key.slice(5), value]),
  );
  const nestedInput = params.args ?? params.input;
  if (nestedInput != null) {
    return {
      id: readToolSearchId(params),
      input: isRecord(nestedInput) ? { ...dottedInput, ...nestedInput } : nestedInput,
    };
  }

  const matchingSelectors = catalog
    ? TOOL_SEARCH_SELECTOR_KEYS.flatMap((key) => {
        const value = params[key];
        if (typeof value !== "string") {
          return [];
        }
        const matches = catalog.entries.filter(
          (entry) => entry.id === value || entry.name === value,
        );
        return matches.length > 0 ? [{ key, matches }] : [];
      })
    : [];
  const matchedToolIds = new Set(
    matchingSelectors.flatMap(({ matches }) => matches.map((entry) => entry.id)),
  );
  if (matchedToolIds.size > 1) {
    throw new ToolInputError(
      "Ambiguous tool selectors: pass the target tool id and nest target arguments under args.",
    );
  }
  const matchingSelector = matchingSelectors[0]?.key;
  const selector = matchingSelector ?? TOOL_SEARCH_SELECTOR_KEYS.find((key) => params[key] != null);
  const id = readToolSearchId(selector ? { [selector]: params[selector] } : params);

  // Remove every alias that actually identifies the selected catalog tool;
  // unmatched id/name fields can still be required arguments of that tool.
  const wrapperKeys = new Set<string>([
    "args",
    "input",
    ...matchingSelectors.map(({ key }) => key),
    ...(matchingSelector ? [] : [selector ?? "id"]),
  ]);
  const targetInputEntries = Object.entries(params).filter(([key]) => !wrapperKeys.has(key));
  const flattenedInput = Object.fromEntries(
    targetInputEntries.filter(([key]) => !(key.startsWith("args.") && key.length > 5)),
  );
  return { id, input: { ...dottedInput, ...flattenedInput } };
}

export function prepareToolSearchDispatcherArguments(args: unknown): unknown {
  if (!isRecord(args) || TOOL_SEARCH_SELECTOR_KEYS.some((key) => Object.hasOwn(args, key))) {
    return args;
  }
  const nestedInput = args.args ?? args.input;
  if (!isRecord(nestedInput)) {
    return args;
  }
  const selectorValue = readToolSearchSelector(nestedInput);
  if (selectorValue === undefined) {
    return args;
  }
  const { args: _wrappedArgs, input: _wrappedInput, ...outerRest } = args;
  return { ...outerRest, ...nestedInput, id: selectorValue };
}

type CatalogSchemaName = "inputSchema" | "outputSchema";
type CatalogSchemaValidation = ReturnType<
  typeof import("../plugins/schema-validator.js").validateJsonSchemaValue
>;
type CachedToolSearchIndex = {
  entries: Array<
    Pick<
      ToolSearchCatalogEntry,
      "id" | "source" | "name" | "label" | "description" | "parameters"
    > & {
      entry: ToolSearchCatalogEntry;
      parameterText: string;
    }
  >;
  index: ReturnType<typeof buildLexicalIndex<ToolSearchCatalogEntry>>;
};
type ToolSearchIndexCache = Map<
  boolean | NonNullable<CatalogVisibilityOptions["allowedIds"]>,
  CachedToolSearchIndex
>;

function matchesCachedToolSearchIndex(
  cached: CachedToolSearchIndex,
  entries: readonly ToolSearchCatalogEntry[],
): boolean {
  return (
    cached.entries.length === entries.length &&
    entries.every((entry, index) => {
      const snapshot = cached.entries[index];
      return (
        snapshot?.entry === entry &&
        snapshot.id === entry.id &&
        snapshot.source === entry.source &&
        snapshot.name === entry.name &&
        snapshot.label === entry.label &&
        snapshot.description === entry.description &&
        snapshot.parameters === entry.parameters &&
        snapshot.parameterText ===
          (entry.source === "openclaw" ? readParameterText(entry.parameters) : "")
      );
    })
  );
}

let schemaValidatorModulePromise:
  | Promise<typeof import("../plugins/schema-validator.js")>
  | undefined;

function getCatalogSchemaCacheKey(
  entry: ToolSearchCatalogEntry,
  schemaName: CatalogSchemaName,
  schema: unknown,
): string {
  const prefix = `tool-${schemaName === "inputSchema" ? "input" : "output"}:${entry.id}`;
  // Content keys reuse rebuilt tool schemas while invalidating in-place constraint changes.
  return `${prefix}:${JSON.stringify(schema)}`;
}

async function validateCatalogSchemaValue(
  entry: ToolSearchCatalogEntry,
  schemaName: CatalogSchemaName,
  value: unknown,
): Promise<CatalogSchemaValidation | undefined> {
  const schema =
    schemaName === "inputSchema"
      ? resolveAgentToolExecutionSchema(entry.tool, entry.parameters)
      : entry.outputSchema;
  if (entry.source !== "openclaw" || !schema) {
    return undefined;
  }
  try {
    schemaValidatorModulePromise ??= import("../plugins/schema-validator.js");
    const { validateJsonSchemaValue } = await schemaValidatorModulePromise;
    return validateJsonSchemaValue({
      schema: schema as never,
      cacheKey: getCatalogSchemaCacheKey(entry, schemaName, schema),
      value,
    });
  } catch (error) {
    throw new Error(`Tool "${entry.id}" has an invalid ${schemaName}.`, { cause: error });
  }
}

function formatCatalogInputError(
  entry: ToolSearchCatalogEntry,
  errors: import("../plugins/schema-validator.js").JsonSchemaValidationError[],
  value: unknown,
): string {
  const schema = isRecord(entry.parameters) ? entry.parameters : undefined;
  const propertyNames = isRecord(schema?.properties) ? Object.keys(schema.properties) : [];
  const knownProperties = new Set(propertyNames);
  const unexpectedProperties =
    schema?.additionalProperties === false && isRecord(value)
      ? Object.keys(value).filter((name) => !knownProperties.has(name))
      : errors.flatMap((error) => (error.additionalProperty ? [error.additionalProperty] : []));
  const suggestions = uniqueStrings(
    unexpectedProperties.flatMap((unexpected) => {
      const nearest = propertyNames
        .map((name) => ({ name, distance: levenshteinDistance(unexpected, name) }))
        .filter(
          ({ distance }) => distance <= Math.min(3, Math.max(1, Math.ceil(unexpected.length / 3))),
        )
        .toSorted(
          (left, right) => left.distance - right.distance || left.name.localeCompare(right.name),
        )[0];
      return nearest ? [nearest.name] : [];
    }),
  ).slice(0, 3);
  const details = errors.map((error) => error.text).join("; ");
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  return `Invalid arguments for tool "${entry.id}": ${details}.${hint}`;
}

async function assertCatalogInputMatchesSchema(
  entry: ToolSearchCatalogEntry,
  value: unknown,
): Promise<void> {
  const validation = await validateCatalogSchemaValue(entry, "inputSchema", value);
  if (validation && !validation.ok) {
    throw new ToolInputError(formatCatalogInputError(entry, validation.errors, value));
  }
}

async function assertCatalogOutputSchemaIsValid(entry: ToolSearchCatalogEntry): Promise<void> {
  // Compile before execution so a bad contract cannot follow a successful side effect.
  await validateCatalogSchemaValue(entry, "outputSchema", undefined);
}

async function assertCatalogOutputMatchesSchema(
  entry: ToolSearchCatalogEntry,
  result: AgentToolResult<unknown>,
): Promise<void> {
  if (!entry.outputSchema) {
    return;
  }
  if (isPreExecutionBlockedToolResult(result)) {
    const details = unwrapToolResultValue(result);
    const reason =
      isRecord(details) && typeof details.reason === "string" && details.reason.trim()
        ? details.reason
        : "Tool call blocked by policy";
    throw new Error(`Tool "${entry.id}" was blocked before execution: ${reason}`);
  }
  const validation = await validateCatalogSchemaValue(
    entry,
    "outputSchema",
    unwrapToolResultValue(result),
  );
  if (!validation || validation.ok) {
    return;
  }
  throw new Error(
    `Tool "${entry.id}" returned details that do not match its declared outputSchema.`,
  );
}

function sanitizeToolCallIdPart(value: string): string {
  const trimmed = value.trim();
  const safe = trimmed.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120);
  return safe || "call";
}

export class ToolSearchRuntime {
  private callSequence = 0;
  private readonly terminalTargetBatchByParent = new Map<string, boolean>();
  private readonly networkInvocations = new Map<string, { active: number; observed: boolean }>();
  private readonly searchIndexes = new WeakMap<ToolSearchCatalogSession, ToolSearchIndexCache>();

  constructor(
    private readonly ctx: ToolSearchToolContext,
    private readonly config: ToolSearchConfig,
    private readonly options: { prepareInput?: boolean; validateInput?: boolean } = {},
  ) {}

  search = async (query: string, options?: { limit?: number } & CatalogVisibilityOptions) => {
    const catalog = resolveCatalog(this.ctx);
    catalog.searchCount += 1;
    const limit = readToolSearchLimit(options?.limit, this.config);
    const entries = visibleCatalogEntries(catalog, options);
    // A query that is exactly a tool name or id is a request for that tool, not
    // a description of one. BM25 alone can rank a shorter entry that merely
    // mentions the word above it, and the limit then drops the tool asked for.
    const exact = query.trim().toLowerCase();
    const isExact = (entry: ToolSearchCatalogEntry) =>
      entry.name.toLowerCase() === exact || entry.id.toLowerCase() === exact;
    const exactMatches = entries.filter(isExact);
    // An unambiguous exact lookup never needs schema traversal or a BM25 index.
    if (limit === 1 && exactMatches.length === 1) {
      return exactMatches.slice(0, limit).map((entry) => compactToolSearchCatalogEntry(entry));
    }
    const indexKey = options?.allowedIds ?? options?.includeMcp !== false;
    let catalogIndexes = this.searchIndexes.get(catalog);
    if (!catalogIndexes) {
      catalogIndexes = new Map();
      this.searchIndexes.set(catalog, catalogIndexes);
    }
    let cachedIndex = catalogIndexes.get(indexKey);
    if (!cachedIndex || !matchesCachedToolSearchIndex(cachedIndex, entries)) {
      const indexedEntries = entries.map((entry) => ({
        entry,
        id: entry.id,
        source: entry.source,
        name: entry.name,
        label: entry.label,
        description: entry.description,
        parameters: entry.parameters,
        parameterText: entry.source === "openclaw" ? readParameterText(entry.parameters) : "",
      }));
      cachedIndex = {
        entries: indexedEntries,
        index: buildLexicalIndex(
          indexedEntries.map(({ entry, parameterText }) => ({
            value: entry,
            terms: tokenizeDocument(toolSearchEntryText(entry, parameterText)),
          })),
        ),
      };
      catalogIndexes.set(indexKey, cachedIndex);
    }
    const ranked = scoreLexical(cachedIndex.index, tokenizeQuery(query))
      .toSorted(
        (a, b) =>
          Number(isExact(b.value)) - Number(isExact(a.value)) ||
          Number(b.matchedLiteral) - Number(a.matchedLiteral) ||
          b.score - a.score ||
          a.value.id.localeCompare(b.value.id),
      )
      .map((hit) => hit.value);
    // A tool whose name is a stopword ("do") tokenizes to nothing and so never
    // reaches the ranking at all. Naming it exactly is still an unambiguous
    // request for it, which the previous scorer honored.
    const exactEntries = entries.filter((entry) => isExact(entry) && !ranked.includes(entry));
    return [...exactEntries, ...ranked]
      .slice(0, limit)
      .map((entry) => compactToolSearchCatalogEntry(entry));
  };

  all = (options?: CatalogVisibilityOptions) =>
    visibleCatalogEntries(resolveCatalog(this.ctx), options).map((entry) =>
      compactToolSearchCatalogEntry(entry),
    );

  namespaceEntries = () =>
    // Snapshot host metadata without rendering hints or retaining the executable tool.
    resolveCatalog(this.ctx).entries.map(
      ({ tool: _tool, outputSchema: _outputSchema, ...entry }) => {
        entry.parameters ??= {};
        return entry;
      },
    );

  describe = async (id: string, options?: CatalogVisibilityOptions & UnknownToolErrorOptions) => {
    const catalog = resolveCatalog(this.ctx);
    catalog.describeCount += 1;
    return describeEntry(findEntry(catalog, id, options, options));
  };

  call = async (id: string, input?: unknown, options?: ToolSearchCallOptions) => {
    const catalog = resolveCatalog(this.ctx);
    return await this.callEntry(catalog, findEntry(catalog, id, options, options), input, options);
  };

  callExactId = async (
    id: string,
    input?: unknown,
    options?: {
      parentToolCallId?: string;
      signal?: AbortSignal;
      onUpdate?: ToolSearchCallOptions["onUpdate"];
      recoverySurface?: UnknownToolRecoverySurface;
    },
  ) => {
    const catalog = resolveCatalog(this.ctx);
    return await this.callEntry(catalog, findEntryByExactId(catalog, id, options), input, options);
  };

  callValue = async (id: string, input?: unknown, options?: ToolSearchCallOptions) =>
    unwrapToolResultValue((await this.call(id, input, options)).result);

  hasNetworkContent(parentToolCallId?: string): boolean {
    return parentToolCallId
      ? this.networkInvocations.has(parentToolCallId)
      : this.networkInvocations.size > 0;
  }

  takeTerminalTargetBatch(parentToolCallId?: string): boolean {
    const parent =
      parentToolCallId ??
      (this.terminalTargetBatchByParent.size === 1
        ? (this.terminalTargetBatchByParent.keys().next().value ?? "")
        : "");
    const terminal = this.terminalTargetBatchByParent.get(parent) === true;
    return this.terminalTargetBatchByParent.delete(parent) && terminal;
  }

  isReplaySafeExactId = (id: string): boolean => {
    let entry: ToolSearchCatalogEntry;
    try {
      entry = findEntryByExactId(resolveCatalog(this.ctx), id);
    } catch {
      return false;
    }
    if (entry.source !== "openclaw") {
      return false;
    }
    const pluginMeta = getPluginToolMeta(entry.tool as Parameters<typeof getPluginToolMeta>[0]);
    if (pluginMeta) {
      return pluginMeta.mcp
        ? false
        : pluginMeta.replaySafe === true && pluginMeta.sideEffecting !== true;
    }
    if (getChannelAgentToolMeta(entry.tool as never)) {
      return false;
    }
    return isAgentToolReplaySafe(entry.tool);
  };

  private readonly callEntry = async (
    catalog: ToolSearchCatalogSession,
    entry: ToolSearchCatalogEntry,
    input?: unknown,
    options?: {
      parentToolCallId?: string;
      signal?: AbortSignal;
      onUpdate?: ToolSearchCallOptions["onUpdate"];
    },
  ) => {
    catalog.callCount += 1;
    const normalizedInput = input ?? {};
    const parentId = sanitizeToolCallIdPart(options?.parentToolCallId ?? "direct");
    const toolCallId = `tool_search_code:${parentId}:${entry.name}:${++this.callSequence}`;
    bindJoinedCollectorInvocation(entry.tool, toolCallId);
    await assertCatalogOutputSchemaIsValid(entry);
    const executeTool =
      this.ctx.executeTool ??
      (async (params: Parameters<ToolSearchCatalogToolExecutor>[0]) => {
        const result = await params.tool.execute(
          params.toolCallId,
          params.input,
          params.signal,
          params.onUpdate,
          undefined as never,
        );
        return await params.acceptResultBeforeProjection(result);
      });
    let preExecutionBlocked = false;
    // Reuse only this call's accepted snapshot; outer schema validation must still run.
    let acceptedSnapshot: AgentToolResult<unknown> | undefined;
    const acceptResultBeforeProjection = async (candidate: AgentToolResult<unknown>) => {
      if (isPreExecutionBlockedToolResult(candidate)) {
        // The JSON-safe snapshot drops the private blocked-result marker.
        preExecutionBlocked = true;
        await assertCatalogOutputMatchesSchema(entry, candidate);
      }
      const snapshot =
        candidate === acceptedSnapshot
          ? candidate
          : snapshotToolSearchTargetTranscriptResult(candidate);
      await assertCatalogOutputMatchesSchema(entry, snapshot);
      acceptedSnapshot = snapshot;
      return snapshot;
    };
    const validateInput = this.options.validateInput && entry.source === "openclaw";
    const executionTool = prepareToolSearchCatalogExecutionTool(entry, this.options);
    const runExecution = async () => {
      const parentToolCallId = options?.parentToolCallId ?? toolCallId;
      const signal = options?.signal ?? this.ctx.abortSignal;
      const networkInvocation =
        entry.tool.resultContentSource === "network"
          ? (this.networkInvocations.get(parentToolCallId) ?? { active: 0, observed: false })
          : undefined;
      if (networkInvocation) {
        networkInvocation.active += 1;
        this.networkInvocations.set(parentToolCallId, networkInvocation);
      }
      try {
        const result = await executeTool({
          tool: executionTool,
          toolName: entry.name,
          source: entry.source,
          sourceName: entry.sourceName,
          toolCallId,
          parentToolCallId: options?.parentToolCallId,
          replaySafe: this.isReplaySafeExactId(entry.id),
          input: normalizedInput,
          signal,
          onUpdate: options?.onUpdate,
          acceptResultBeforeProjection,
        });
        if (networkInvocation && !preExecutionBlocked) {
          networkInvocation.observed = true;
        }
        return result;
      } catch (error) {
        if (
          networkInvocation &&
          !preExecutionBlocked &&
          getBeforeToolCallFailureDisposition(error) === undefined &&
          !isTrustedToolExecutionPreflightError(error) &&
          !(signal?.aborted && error === signal.reason)
        ) {
          // Guest code can catch page-controlled errors and return their text.
          networkInvocation.observed = true;
        }
        throw error;
      } finally {
        if (networkInvocation && --networkInvocation.active === 0 && !networkInvocation.observed) {
          this.networkInvocations.delete(parentToolCallId);
        }
      }
    };
    let acceptedResult: AgentToolResult<unknown> | undefined;
    try {
      const result = validateInput
        ? await runWithToolExecutionValidation(
            toolCallId,
            async (finalInput) => await assertCatalogInputMatchesSchema(entry, finalInput),
            runExecution,
          )
        : await runExecution();
      acceptedResult = await acceptResultBeforeProjection(result);
      if (options?.parentToolCallId) {
        this.terminalTargetBatchByParent.set(
          options.parentToolCallId,
          this.terminalTargetBatchByParent.get(options.parentToolCallId) !== false &&
            acceptedResult.terminate === true,
        );
      }
      return { tool: compactToolSearchCatalogEntry(entry), result: acceptedResult };
    } finally {
      // Nested executors can reject after raw success; only outer acceptance owns the summary.
      finalizeToolTerminalPresentation({
        toolCallId,
        runId: this.ctx.runId,
        result: acceptedResult ?? { content: [], details: undefined },
        isError: acceptedResult === undefined || isToolResultError(acceptedResult),
      });
    }
  };

  telemetry() {
    return readToolSearchCatalogTelemetry(this.ctx);
  }
}

/** Preserve programmatic values while protecting the model-facing control output. */
export function formatToolSearchControlResult<T>(
  payload: T,
  runtime: ToolSearchRuntime | undefined,
  parentToolCallId?: string,
  terminalBatchStatus?: "waiting" | "completed" | "failed",
): AgentToolResult<T> {
  let result: AgentToolResult<T> = jsonResult(payload);
  const content = result.content[0];
  if (runtime?.hasNetworkContent(parentToolCallId) && content?.type === "text") {
    const { text } = renderToolSearchControlText(content.text, true);
    result = { ...result, content: [{ ...content, text }] };
  }
  const terminal =
    terminalBatchStatus !== "waiting" &&
    runtime?.takeTerminalTargetBatch(parentToolCallId) === true;
  // A failed guest cannot revoke an already completed tool's explicit terminal outcome.
  return terminal ? { ...result, terminate: true } : result;
}

/** Keep dynamic failures rejected without exposing network-controlled error text. */
export function formatToolSearchControlError(
  error: unknown,
  runtime: ToolSearchRuntime | undefined,
  parentToolCallId?: string,
  signal?: AbortSignal,
): unknown {
  if (
    !runtime?.hasNetworkContent(parentToolCallId) ||
    getBeforeToolCallFailureDisposition(error) !== undefined ||
    isTrustedToolExecutionPreflightError(error) ||
    (signal?.aborted && error === signal.reason)
  ) {
    return error;
  }
  return protectNetworkToolExecutionError(error, "Tool Search call failed.", signal);
}

function unwrapToolResultValue(result: AgentToolResult<unknown>): unknown {
  return isRecord(result) && "details" in result ? result.details : result;
}
