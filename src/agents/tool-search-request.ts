import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Guard } from "typebox/guard";
import type { ToolSearchConfig } from "./tool-search-types.js";
import {
  MAX_TOOL_SEARCH_BATCH_QUERIES,
  MAX_TOOL_SEARCH_BATCH_QUERY_BYTES,
  MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
  MAX_TOOL_SEARCH_RESULTS,
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

function readBatchToolSearchQuery(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${field} must be a non-empty string.`);
  }
  const query = value.trim();
  if (!Guard.IsMaxLength(query, MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES)) {
    throw new ToolInputError(
      `${field} must not exceed ${MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES} characters.`,
    );
  }
  return query;
}

export function readToolSearchBatchRequest(
  args: unknown,
  config: ToolSearchConfig,
): Array<{ query: string; limit: number }> {
  const params = asToolParamsRecord(args);
  if (!Array.isArray(params.queries) || params.queries.length === 0) {
    throw new ToolInputError("queries must be a non-empty array.");
  }
  if (params.queries.length > MAX_TOOL_SEARCH_BATCH_QUERIES) {
    throw new ToolInputError(
      `queries may contain at most ${MAX_TOOL_SEARCH_BATCH_QUERIES} entries.`,
    );
  }

  const searches = params.queries.map((value, index) => {
    if (!isRecord(value)) {
      throw new ToolInputError(`queries[${index}] must be an object.`);
    }
    const query = readBatchToolSearchQuery(value.query, `queries[${index}].query`);
    try {
      return { query, limit: readToolSearchLimit(value.limit, config) };
    } catch (error) {
      if (error instanceof ToolInputError) {
        throw new ToolInputError(`queries[${index}].${error.message}`);
      }
      throw error;
    }
  });
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
  return searches;
}
