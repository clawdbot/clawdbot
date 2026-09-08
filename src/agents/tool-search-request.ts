import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Guard } from "typebox/guard";
import {
  MAX_TOOL_SEARCH_BATCH_QUERIES,
  MAX_TOOL_SEARCH_BATCH_QUERY_BYTES,
  MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
  MAX_TOOL_SEARCH_RESULTS,
  type ToolSearchConfig,
  type ToolSearchRequest,
} from "./tool-search-types.js";
import { asToolParamsRecord, ToolInputError } from "./tools/common.js";

export function readToolSearchLimit(value: unknown, config: ToolSearchConfig): number {
  if (value === undefined) {
    return config.searchDefaultLimit;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolInputError("limit must be a positive integer.");
  }
  return Math.min(value, config.maxSearchLimit);
}

function readBatchToolSearchQuery(value: unknown, field: string, maxGraphemes?: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${field} must be a non-empty string.`);
  }
  const query = value.trim();
  if (maxGraphemes !== undefined && !Guard.IsMaxLength(query, maxGraphemes)) {
    throw new ToolInputError(`${field} must not exceed ${maxGraphemes} characters.`);
  }
  return query;
}

function readToolSearchArgs(
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

type BatchToolSearchEntry = { query: string; limit: number };

function readBatchToolSearchEntry(
  value: unknown,
  index: number,
  config: ToolSearchConfig,
): BatchToolSearchEntry {
  if (!isRecord(value)) {
    throw new ToolInputError(`queries[${index}] must be an object.`);
  }
  const query = readBatchToolSearchQuery(
    value.query,
    `queries[${index}].query`,
    MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
  );
  try {
    return { query, limit: readToolSearchLimit(value.limit, config) };
  } catch (error) {
    if (error instanceof ToolInputError) {
      throw new ToolInputError(`queries[${index}].${error.message}`);
    }
    throw error;
  }
}

function readBatchToolSearchRequest(
  searches: BatchToolSearchEntry[],
  config: ToolSearchConfig,
): ToolSearchRequest {
  if (searches.length > MAX_TOOL_SEARCH_BATCH_QUERIES) {
    throw new ToolInputError(
      `queries may contain at most ${MAX_TOOL_SEARCH_BATCH_QUERIES} entries.`,
    );
  }
  const requestedResults = searches.reduce((total, search) => total + search.limit, 0);
  if (requestedResults > MAX_TOOL_SEARCH_RESULTS) {
    throw new ToolInputError(
      `batch queries resolve to ${requestedResults} results, but may request at most ${MAX_TOOL_SEARCH_RESULTS} in total. An omitted limit counts as ${config.searchDefaultLimit}; set smaller per-query limits and retry.`,
    );
  }
  const serializedQueries = JSON.stringify(searches.map((search) => search.query));
  const serializedQueryBytes = new TextEncoder().encode(serializedQueries).byteLength;
  if (serializedQueryBytes > MAX_TOOL_SEARCH_BATCH_QUERY_BYTES) {
    throw new ToolInputError(
      `serialized batch query text may use at most ${MAX_TOOL_SEARCH_BATCH_QUERY_BYTES} UTF-8 bytes.`,
    );
  }
  return { kind: "batch", searches };
}

/** Normalize scalar and batch shapes without dropping independent searches. */
export function readToolSearchRequest(args: unknown, config: ToolSearchConfig): ToolSearchRequest {
  const params = asToolParamsRecord(args);
  const query = params.query ?? undefined;
  const queries = params.queries ?? undefined;
  const hasQuery = query !== undefined;
  const hasQueries = queries !== undefined;
  if (!hasQuery && !hasQueries) {
    throw new ToolInputError("provide query or queries.");
  }
  if (hasQueries && !Array.isArray(queries)) {
    throw new ToolInputError("queries must be a non-empty array.");
  }
  const batchEntries = Array.isArray(queries) ? queries : [];
  if (hasQuery && typeof query !== "string") {
    throw new ToolInputError("query must be a string.");
  }
  const singleQuery = typeof query === "string" && query.trim() ? query : undefined;
  if (batchEntries.length === 0) {
    if (singleQuery === undefined && hasQueries) {
      throw new ToolInputError("queries must be a non-empty array.");
    }
    return { kind: "single", search: readToolSearchArgs(params, config) };
  }
  if (singleQuery === undefined && (params.limit != null || params.options !== undefined)) {
    throw new ToolInputError("set limit on each batch query, not on the batch request.");
  }
  const searches = batchEntries.map((value, index) =>
    readBatchToolSearchEntry(value, index, config),
  );
  if (singleQuery !== undefined) {
    // Even identical text is an independent search with its own limit and budget.
    const single = readToolSearchArgs(params, config);
    searches.unshift({ query: single.query.trim(), limit: single.limit });
  }
  return readBatchToolSearchRequest(searches, config);
}
