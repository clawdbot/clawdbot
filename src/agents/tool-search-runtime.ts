import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { getPluginToolMeta } from "../plugins/tools.js";
import { levenshteinDistance } from "../shared/levenshtein-distance.js";
import {
  isPreExecutionBlockedToolResult,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { runWithToolExecutionValidation } from "./agent-tools.execution-validation.js";
import { getChannelAgentToolMeta } from "./channel-tool-metadata.js";
import type { AgentToolResult } from "./runtime/index.js";
import { isAgentToolReplaySafe } from "./tool-replay-safety.js";
import {
  compactToolSearchCatalogEntry,
  resolveCatalog,
  visibleCatalogEntries,
} from "./tool-search-catalog.js";
import {
  buildLexicalIndex,
  scoreLexical,
  tokenizeDocument,
  tokenizeQuery,
} from "./tool-search-ranking.js";
import { snapshotToolSearchTargetTranscriptResult } from "./tool-search-transcript.js";
import type {
  CatalogSource,
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
import { asToolParamsRecord, ToolInputError } from "./tools/common.js";

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

/** Collects property names and descriptions from a JSON-Schema-shaped value. */
function readParameterText(parameters: unknown, depth = 0): string {
  if (depth > 4 || !isRecord(parameters)) {
    return "";
  }
  const parts: string[] = [];
  const description = parameters.description;
  if (typeof description === "string") {
    parts.push(description);
  }
  const properties = parameters.properties;
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      parts.push(name);
      parts.push(readParameterText(child, depth + 1));
    }
  }
  const items = parameters.items;
  if (items !== undefined) {
    parts.push(readParameterText(items, depth + 1));
  }
  return parts.filter(Boolean).join(" ");
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
      : options.recoverySurface === "tools"
        ? "Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name."
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

export function readToolSearchId(args: unknown): string {
  const params = asToolParamsRecord(args);
  const value = params.id ?? params.toolId ?? params.name;
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError("id must be a non-empty string.");
  }
  return value.trim();
}

function readToolSearchLimit(value: unknown, config: ToolSearchConfig): number {
  if (value === undefined) {
    return config.searchDefaultLimit;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolInputError("limit must be a positive integer.");
  }
  return Math.min(value, config.maxSearchLimit);
}

export function readToolSearchArgs(
  args: unknown,
  config: ToolSearchConfig,
): { query: string; limit: number } {
  const params = asToolParamsRecord(args);
  const query = params.query;
  if (typeof query !== "string") {
    throw new ToolInputError("query must be a string.");
  }
  const options = isRecord(params.options) ? params.options : undefined;
  return {
    query,
    limit: readToolSearchLimit(params.limit ?? options?.limit, config),
  };
}

export function readToolSearchCallArgs(
  args: unknown,
  catalog?: ToolSearchCatalogSession,
): { id: string; input: unknown } {
  const params = asToolParamsRecord(args);
  const nestedInput = params.args ?? params.input;
  if (nestedInput != null) {
    return { id: readToolSearchId(params), input: nestedInput };
  }

  const selectorKeys = ["id", "toolId", "name"] as const;
  const matchingSelectors = catalog
    ? selectorKeys.flatMap((key) => {
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
  const selector = matchingSelector ?? selectorKeys.find((key) => params[key] != null);
  const id = readToolSearchId(selector ? { [selector]: params[selector] } : params);

  // Remove every alias that actually identifies the selected catalog tool;
  // unmatched id/name fields can still be required arguments of that tool.
  const wrapperKeys = new Set<string>([
    "args",
    "input",
    ...matchingSelectors.map(({ key }) => key),
    ...(matchingSelector ? [] : [selector ?? "id"]),
  ]);
  const flattenedInput = Object.fromEntries(
    Object.entries(params).filter(([key]) => !wrapperKeys.has(key)),
  );
  return { id, input: flattenedInput };
}

function getTelemetry(catalog: ToolSearchCatalogSession) {
  const sources: Record<CatalogSource, number> = { openclaw: 0, mcp: 0, client: 0 };
  for (const entry of catalog.entries) {
    sources[entry.source] += 1;
  }
  return {
    catalogSize: catalog.entries.length,
    sources,
    searchCount: catalog.searchCount,
    describeCount: catalog.describeCount,
    callCount: catalog.callCount,
  };
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
const catalogSchemaCacheIds = new WeakMap<object, number>();
let nextCatalogSchemaCacheId = 0;

function getCatalogSchemaCacheKey(
  entry: ToolSearchCatalogEntry,
  schemaName: CatalogSchemaName,
  schema: unknown,
): string {
  const prefix = `tool-${schemaName === "inputSchema" ? "input" : "output"}:${entry.id}`;
  if (typeof schema !== "object" || schema === null) {
    return `${prefix}:${String(schema)}`;
  }
  let schemaCacheId = catalogSchemaCacheIds.get(schema);
  if (schemaCacheId === undefined) {
    schemaCacheId = nextCatalogSchemaCacheId++;
    catalogSchemaCacheIds.set(schema, schemaCacheId);
  }
  // Trusted schemas can be edited in place, so object identity alone cannot
  // safely reuse a compiled validator after its constraints have changed.
  return `${prefix}:${schemaCacheId}:${JSON.stringify(schema)}`;
}

async function validateCatalogSchemaValue(
  entry: ToolSearchCatalogEntry,
  schemaName: CatalogSchemaName,
  value: unknown,
): Promise<CatalogSchemaValidation | undefined> {
  const schema = schemaName === "inputSchema" ? entry.parameters : entry.outputSchema;
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
  private readonly searchIndexes = new WeakMap<
    ToolSearchCatalogSession,
    Map<boolean, CachedToolSearchIndex>
  >();

  constructor(
    private readonly ctx: ToolSearchToolContext,
    private readonly config: ToolSearchConfig,
    private readonly options: { validateInput?: boolean } = {},
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
    const includeMcp = options?.includeMcp !== false;
    let catalogIndexes = this.searchIndexes.get(catalog);
    if (!catalogIndexes) {
      catalogIndexes = new Map();
      this.searchIndexes.set(catalog, catalogIndexes);
    }
    let cachedIndex = catalogIndexes.get(includeMcp);
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
      catalogIndexes.set(includeMcp, cachedIndex);
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
    resolveCatalog(this.ctx).entries.map((entry) =>
      Object.assign(compactToolSearchCatalogEntry(entry), {
        parameters: entry.parameters ?? {},
      }),
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
      return pluginMeta.mcp ? false : pluginMeta.replaySafe === true;
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
    await assertCatalogOutputSchemaIsValid(entry);
    const parentId = sanitizeToolCallIdPart(options?.parentToolCallId ?? "direct");
    const toolCallId = `tool_search_code:${parentId}:${entry.name}:${++this.callSequence}`;
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
    const acceptResultBeforeProjection = async (candidate: AgentToolResult<unknown>) => {
      if (isPreExecutionBlockedToolResult(candidate)) {
        await assertCatalogOutputMatchesSchema(entry, candidate);
      }
      const snapshot = snapshotToolSearchTargetTranscriptResult(candidate);
      await assertCatalogOutputMatchesSchema(entry, snapshot);
      return snapshot;
    };
    const validateInput = this.options.validateInput && entry.source === "openclaw";
    const executionTool =
      validateInput && !isToolWrappedWithBeforeToolCallHook(entry.tool as never)
        ? wrapToolWithBeforeToolCallHook(entry.tool as never)
        : entry.tool;
    const runExecution = async () =>
      await executeTool({
        tool: executionTool,
        toolName: entry.name,
        source: entry.source,
        sourceName: entry.sourceName,
        toolCallId,
        parentToolCallId: options?.parentToolCallId,
        input: normalizedInput,
        signal: options?.signal ?? this.ctx.abortSignal,
        onUpdate: options?.onUpdate,
        acceptResultBeforeProjection,
      });
    const result = validateInput
      ? await runWithToolExecutionValidation(
          toolCallId,
          async (finalInput) => await assertCatalogInputMatchesSchema(entry, finalInput),
          runExecution,
        )
      : await runExecution();
    const acceptedResult = await acceptResultBeforeProjection(result);
    return { tool: compactToolSearchCatalogEntry(entry), result: acceptedResult };
  };

  telemetry() {
    return getTelemetry(resolveCatalog(this.ctx));
  }
}

function unwrapToolResultValue(result: AgentToolResult<unknown>): unknown {
  return isRecord(result) && "details" in result ? result.details : result;
}
