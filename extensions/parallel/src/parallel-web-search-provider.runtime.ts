import { createRequire } from "node:module";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import {
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  readStringArrayParam,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildParallelCacheKey,
  invalidSearchQueriesPayload,
  mapParallelResults,
  normalizeParallelClientModel,
  normalizeParallelObjective,
  normalizeParallelResults,
  normalizeParallelSearchQueries,
  normalizeParallelSessionId,
  PARALLEL_SESSION_ID_MAX_LENGTH,
  type ParallelSearchResponse,
  resolveParallelSearchCount,
  stripParallelGeneratedSessionId,
} from "./parallel-search-normalize.js";

const PARALLEL_BASE_URL = "https://api.parallel.ai";
const PARALLEL_SEARCH_PATHNAME = "/v1/search";
const PARALLEL_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
// Parallel's /v1/search returns a bounded result set, but the body is external
// (web-search upstream) and untrusted. Cap the successful JSON read so a
// hostile or malfunctioning endpoint streaming an unbounded body cannot force
// the runtime to buffer the whole payload before parsing. 16 MiB matches the
// shared provider JSON cap (readProviderJsonResponse default).
const PARALLEL_SEARCH_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;

const require = createRequire(import.meta.url);
const PLUGIN_VERSION = readPluginPackageVersion({ require });
const USER_AGENT = `openclaw-parallel/${PLUGIN_VERSION} (${process.platform})`;

type ParallelConfig = {
  apiKey?: string;
  baseUrl?: string;
};

function resolveParallelConfig(searchConfig?: SearchConfigRecord): ParallelConfig {
  const parallel = searchConfig?.parallel;
  return parallel && typeof parallel === "object" && !Array.isArray(parallel)
    ? (parallel as ParallelConfig)
    : {};
}

function resolveParallelApiKey(parallel?: ParallelConfig): string | undefined {
  return (
    readConfiguredSecretString(
      parallel?.apiKey,
      "plugins.entries.parallel.config.webSearch.apiKey",
    ) ?? readProviderEnvValue(["PARALLEL_API_KEY"])
  );
}

function invalidBaseUrlPayload(value: string) {
  return {
    error: "invalid_base_url",
    message: `plugins.entries.parallel.config.webSearch.baseUrl must be a valid http(s) URL. Got: ${value}`,
    docs: "https://docs.openclaw.ai/tools/parallel-search",
  };
}

function resolveParallelSearchEndpoint(
  parallel?: ParallelConfig,
): { endpoint: string } | { error: string; message: string; docs: string } {
  const configured = normalizeOptionalString(parallel?.baseUrl);
  if (!configured) {
    return { endpoint: `${PARALLEL_BASE_URL}${PARALLEL_SEARCH_PATHNAME}` };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(configured) && !/^https?:\/\//i.test(configured)) {
    return invalidBaseUrlPayload(configured);
  }
  const candidate = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalidBaseUrlPayload(configured);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalidBaseUrlPayload(configured);
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith(PARALLEL_SEARCH_PATHNAME)
    ? pathname
    : `${pathname === "" ? "" : pathname}${PARALLEL_SEARCH_PATHNAME}`;
  parsed.hash = "";
  return { endpoint: parsed.toString() };
}

function missingParallelKeyPayload() {
  return {
    error: "missing_parallel_api_key",
    message:
      "web_search (parallel) needs a Parallel API key. Set PARALLEL_API_KEY in the Gateway environment, or configure plugins.entries.parallel.config.webSearch.apiKey.",
    docs: "https://docs.openclaw.ai/tools/parallel-search",
  };
}

async function runParallelSearch(params: {
  apiKey: string;
  endpoint: string;
  objective?: string;
  searchQueries: readonly string[];
  maxResults: number;
  sessionId?: string;
  clientModel?: string;
  timeoutSeconds: number;
}): Promise<ParallelSearchResponse> {
  const body: Record<string, unknown> = {
    search_queries: [...params.searchQueries],
    advanced_settings: { max_results: params.maxResults },
  };
  if (params.objective) {
    body.objective = params.objective;
  }
  if (params.sessionId) {
    body.session_id = params.sessionId;
  }
  if (params.clientModel) {
    body.client_model = params.clientModel;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: params.endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": params.apiKey,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await readResponseTextLimited(res, PARALLEL_ERROR_BODY_LIMIT_BYTES).catch(
          () => "",
        );
        throw new Error(`Parallel API error (${res.status}): ${detail || res.statusText}`);
      }
      return await readProviderJsonResponse<ParallelSearchResponse>(res, "Parallel API", {
        maxBytes: PARALLEL_SEARCH_RESPONSE_LIMIT_BYTES,
      });
    },
  );
}

export async function executeParallelWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "parallel",
    resolveProviderWebSearchPluginConfig(ctx.config, "parallel"),
  ) as SearchConfigRecord | undefined;
  const parallelConfig = resolveParallelConfig(searchConfig);
  const apiKey = resolveParallelApiKey(parallelConfig);
  if (!apiKey) {
    return missingParallelKeyPayload();
  }
  const endpointResult = resolveParallelSearchEndpoint(parallelConfig);
  if ("error" in endpointResult) {
    return endpointResult;
  }
  const endpoint = endpointResult.endpoint;

  // Generic `query` arg fallback: openclaw's operator-facing CLI
  // (`openclaw capability web.search ...`) always passes the shared
  // lowest-common-denominator shape `{ query, count, limit }` to whatever
  // provider is active and doesn't know about Parallel's richer
  // `{ objective, search_queries }` schema. When `search_queries` is absent
  // we promote `query` into the lone search query. `objective` stays unset
  // in that case rather than being faked from the keyword string.
  const objective = normalizeParallelObjective(readStringParam(args, "objective"));
  const cliQuery = normalizeParallelObjective(readStringParam(args, "query"));
  let searchQueries = normalizeParallelSearchQueries(readStringArrayParam(args, "search_queries"));
  if (searchQueries.length === 0 && cliQuery) {
    searchQueries = normalizeParallelSearchQueries([cliQuery]);
  }
  if (searchQueries.length === 0) {
    return invalidSearchQueriesPayload();
  }
  // Always pass max_results so Parallel matches the openclaw web_search default
  // of 5 instead of Parallel's own default of 10.
  const count = resolveParallelSearchCount(args, searchConfig?.maxResults);
  const sessionId = normalizeParallelSessionId(
    readStringParam(args, "session_id"),
    PARALLEL_SESSION_ID_MAX_LENGTH,
  );
  const clientModel = normalizeParallelClientModel(readStringParam(args, "client_model"));
  const cacheKey = buildParallelCacheKey({
    endpoint,
    objective,
    searchQueries,
    count,
    sessionId,
    clientModel,
  });
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const response = await runParallelSearch({
    apiKey,
    endpoint,
    objective,
    searchQueries,
    maxResults: count,
    sessionId,
    clientModel,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
  });
  const results = mapParallelResults(response);

  const payload: Record<string, unknown> = {
    ...(objective ? { objective } : {}),
    searchQueries,
    provider: "parallel",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "parallel",
      wrapped: true,
    },
    results,
  };
  if (typeof response.search_id === "string") {
    payload.searchId = response.search_id;
  }
  if (typeof response.session_id === "string") {
    payload.sessionId = response.session_id;
  }
  if (Array.isArray(response.warnings) && response.warnings.length > 0) {
    payload.warnings = response.warnings;
  }
  if (Array.isArray(response.usage) && response.usage.length > 0) {
    payload.usage = response.usage;
  }

  // Don't persist a Parallel-generated session id into the shared cache:
  // identical queries from unrelated tasks would otherwise share that id.
  // Caller-supplied session ids are already part of the cache key.
  const cachePayload = sessionId ? payload : stripParallelGeneratedSessionId(payload);
  writeCachedSearchPayload(cacheKey, cachePayload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}

export const testing = {
  buildParallelCacheKey,
  invalidSearchQueriesPayload,
  missingParallelKeyPayload,
  normalizeParallelClientModel,
  normalizeParallelObjective,
  normalizeParallelResults,
  normalizeParallelSearchQueries,
  normalizeParallelSessionId,
  resolveParallelApiKey,
  resolveParallelConfig,
  resolveParallelSearchCount,
  resolveParallelSearchEndpoint,
  PARALLEL_ERROR_BODY_LIMIT_BYTES,
  PARALLEL_SEARCH_RESPONSE_LIMIT_BYTES,
  USER_AGENT,
} as const;

export { testing as __testing };
