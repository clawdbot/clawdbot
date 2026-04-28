import {
  jsonResult,
  readCache,
  readStringArrayParam,
  readStringParam,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isXaiToolEnabled, resolveXaiToolApiKey } from "./src/tool-auth-shared.js";
import { resolveEffectiveXSearchConfig } from "./src/x-search-config.js";
import {
  buildXaiXSearchPayload,
  requestXaiXSearch,
  resolveXaiXSearchInlineCitations,
  resolveXaiXSearchMaxTurns,
  resolveXaiXSearchModel,
  type XaiXSearchOptions,
} from "./src/x-search-shared.js";
import {
  buildMissingXSearchApiKeyPayload,
  createXSearchToolDefinition,
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

function resolveXSearchConfig(cfg?: unknown): Record<string, unknown> | undefined {
  return resolveEffectiveXSearchConfig(cfg as never);
}

function resolveXSearchEnabled(params: {
  cfg?: unknown;
  config?: Record<string, unknown>;
  runtimeConfig?: unknown;
}): boolean {
  return isXaiToolEnabled({
    enabled: params.config?.enabled as boolean | undefined,
    runtimeConfig: params.runtimeConfig as never,
    sourceConfig: params.cfg as never,
  });
}

function resolveXSearchApiKey(params: {
  sourceConfig?: unknown;
  runtimeConfig?: unknown;
}): string | undefined {
  return resolveXaiToolApiKey(params as never);
}

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
  const [year, month, day] = trimmed.split("-").map((entry) => Number.parseInt(entry, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new PluginToolInputError(`${label} must be a valid calendar date`);
  }
  return trimmed;
}

function buildXSearchCacheKey(params: {
  query: string;
  model: string;
  inlineCitations: boolean;
  maxTurns?: number;
  options: Omit<XaiXSearchOptions, "query">;
}) {
  return JSON.stringify([
    "x_search",
    params.model,
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
}) {
  const xSearchConfig = resolveXSearchConfig(options?.config);
  const runtimeConfig = options?.runtimeConfig ?? getRuntimeConfigSnapshot();
  if (
    !resolveXSearchEnabled({
      cfg: options?.config,
      config: xSearchConfig,
      runtimeConfig: runtimeConfig ?? undefined,
    })
  ) {
    return null;
  }

  return createXSearchToolDefinition(async (_toolCallId: string, args: Record<string, unknown>) => {
    const apiKey = resolveXSearchApiKey({
      sourceConfig: options?.config,
      runtimeConfig: runtimeConfig ?? undefined,
    });
    if (!apiKey) {
      return jsonResult(buildMissingXSearchApiKeyPayload());
    }

    const query = readStringParam(args, "query", { required: true });
    const allowedXHandles = readStringArrayParam(args, "allowed_x_handles");
    const excludedXHandles = readStringArrayParam(args, "excluded_x_handles");
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
    const inlineCitations = resolveXaiXSearchInlineCitations(xSearchConfigRecord);
    const maxTurns = resolveXaiXSearchMaxTurns(xSearchConfigRecord);
    const cacheKey = buildXSearchCacheKey({
      query,
      model,
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
      model,
      timeoutSeconds: resolveTimeoutSeconds(xSearchConfig?.timeoutSeconds, 30),
      inlineCitations,
      maxTurns,
      options: xSearchOptions,
    });
    const payload = buildXaiXSearchPayload({
      query,
      model,
      tookMs: Date.now() - startedAt,
      content: result.content,
      citations: result.citations,
      inlineCitations: result.inlineCitations,
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
