// Xai plugin module implements x search behavior.
import {
  jsonResult,
  normalizeToIsoDate,
  readCache,
  readStringArrayParam,
  readStringParam,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  isXaiToolEnabled,
  resolveXaiToolApiKeyWithAuth,
  type XaiToolAuthContext,
} from "./src/tool-auth-shared.js";
import { resolveEffectiveXSearchConfig } from "./src/x-search-config.js";
import {
  buildXaiXSearchPayload,
  requestXaiXSearch,
  resolveXaiXSearchEndpoint,
  resolveXaiXSearchInlineCitations,
  resolveXaiXSearchMaxTurns,
  resolveXaiXSearchModel,
  type XaiXSearchOptions,
} from "./src/x-search-shared.js";
import {
  buildMissingXSearchApiKeyPayload,
  createXSearchToolDefinition,
  X_SEARCH_HANDLE_LIMIT,
} from "./x-search-tool-shared.js";

class PluginToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const X_SEARCH_CACHE_KEY = Symbol.for("openclaw.xai.x-search.cache");

type XSearchCacheEntry = {
  expiresAt: number;
  insertedAt: number;
  value: Record<string, unknown>;
};

function getSharedXSearchCache(): Map<string, XSearchCacheEntry> {
  const root = globalThis as Record<PropertyKey, unknown>;
  const existing = root[X_SEARCH_CACHE_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, XSearchCacheEntry>;
  }
  const next = new Map<string, XSearchCacheEntry>();
  root[X_SEARCH_CACHE_KEY] = next;
  return next;
}

const X_SEARCH_CACHE = getSharedXSearchCache();

function normalizeOptionalIsoDate(value: string | undefined, label: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new PluginToolInputError(`${label} must use YYYY-MM-DD`);
  }
  if (!normalizeToIsoDate(trimmed)) {
    throw new PluginToolInputError(`${label} must be a valid calendar date`);
  }
  return trimmed;
}

function validateXSearchHandleFilters(params: {
  allowedXHandles?: string[];
  excludedXHandles?: string[];
}): void {
  if (params.allowedXHandles && params.excludedXHandles) {
    throw new PluginToolInputError(
      "allowed_x_handles and excluded_x_handles cannot be used together",
    );
  }
  for (const [label, handles] of [
    ["allowed_x_handles", params.allowedXHandles],
    ["excluded_x_handles", params.excludedXHandles],
  ] as const) {
    if (handles && handles.length > X_SEARCH_HANDLE_LIMIT) {
      throw new PluginToolInputError(
        `${label} cannot contain more than ${X_SEARCH_HANDLE_LIMIT} handles`,
      );
    }
  }
}

function buildXSearchCacheKey(params: {
  query: string;
  model: string;
  endpoint: string;
  inlineCitations: boolean;
  maxTurns?: number;
  options: Omit<XaiXSearchOptions, "query">;
}) {
  return JSON.stringify([
    "x_search",
    params.model,
    params.endpoint,
    params.query,
    params.inlineCitations,
    params.maxTurns ?? null,
    params.options.allowedXHandles ?? null,
    params.options.excludedXHandles ?? null,
    params.options.fromDate ?? null,
    params.options.toDate ?? null,
    params.options.enableImageUnderstanding ?? false,
    params.options.enableVideoUnderstanding ?? false,
  ]);
}

export function createXSearchTool(options?: {
  config?: unknown;
  runtimeConfig?: Record<string, unknown> | null;
  auth?: XaiToolAuthContext;
}) {
  const xSearchConfig = resolveEffectiveXSearchConfig(options?.config as never);
  const runtimeConfig = options?.runtimeConfig ?? getRuntimeConfigSnapshot();
  if (
    !isXaiToolEnabled({
      enabled: typeof xSearchConfig?.enabled === "boolean" ? xSearchConfig.enabled : undefined,
      runtimeConfig: (runtimeConfig ?? undefined) as never,
      sourceConfig: options?.config as never,
      auth: options?.auth,
    })
  ) {
    return null;
  }

  return createXSearchToolDefinition(async (_toolCallId, args, signal) => {
    signal?.throwIfAborted();
    const apiKey = await resolveXaiToolApiKeyWithAuth({
      sourceConfig: options?.config as never,
      runtimeConfig: (runtimeConfig ?? undefined) as never,
      auth: options?.auth,
    });
    if (!apiKey) {
      return jsonResult(buildMissingXSearchApiKeyPayload());
    }

    const query = readStringParam(args, "query", { required: true });
    const allowedXHandles = readStringArrayParam(args, "allowed_x_handles");
    const excludedXHandles = readStringArrayParam(args, "excluded_x_handles");
    validateXSearchHandleFilters({ allowedXHandles, excludedXHandles });
    const fromDate = normalizeOptionalIsoDate(readStringParam(args, "from_date"), "from_date");
    const toDate = normalizeOptionalIsoDate(readStringParam(args, "to_date"), "to_date");
    if (fromDate && toDate && fromDate > toDate) {
      throw new PluginToolInputError("from_date must be on or before to_date");
    }

    const xSearchOptions: XaiXSearchOptions = {
      query,
      allowedXHandles,
      excludedXHandles,
      fromDate,
      toDate,
      enableImageUnderstanding: args.enable_image_understanding === true,
      enableVideoUnderstanding: args.enable_video_understanding === true,
    };
    const xSearchConfigRecord = xSearchConfig;
    const model = resolveXaiXSearchModel(xSearchConfigRecord);
    const endpoint = resolveXaiXSearchEndpoint(xSearchConfigRecord);
    const inlineCitations = resolveXaiXSearchInlineCitations(xSearchConfigRecord);
    const maxTurns = resolveXaiXSearchMaxTurns(xSearchConfigRecord);
    const cacheKey = buildXSearchCacheKey({
      query,
      model,
      endpoint,
      inlineCitations,
      maxTurns,
      options: {
        allowedXHandles,
        excludedXHandles,
        fromDate,
        toDate,
        enableImageUnderstanding: xSearchOptions.enableImageUnderstanding,
        enableVideoUnderstanding: xSearchOptions.enableVideoUnderstanding,
      },
    });
    const cached = readCache(X_SEARCH_CACHE, cacheKey);
    if (cached) {
      return jsonResult({ ...cached.value, cached: true });
    }

    const startedAt = Date.now();
    const result = await requestXaiXSearch({
      apiKey,
      endpoint,
      model,
      timeoutSeconds: resolveTimeoutSeconds(xSearchConfig?.timeoutSeconds, 30),
      inlineCitations,
      maxTurns,
      options: xSearchOptions,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const payload = buildXaiXSearchPayload({
      query,
      model,
      tookMs: Date.now() - startedAt,
      content: result.content,
      citations: result.citations,
      inlineCitations: result.inlineCitations,
      truncated: result.truncated,
      options: xSearchOptions,
    });
    writeCache(
      X_SEARCH_CACHE,
      cacheKey,
      payload,
      resolveCacheTtlMs(xSearchConfig?.cacheTtlMinutes, 15),
    );
    return jsonResult(payload);
  });
}
