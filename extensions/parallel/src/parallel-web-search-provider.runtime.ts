import { createRequire } from "node:module";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringArrayParam,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const PARALLEL_BASE_URL = "https://api.parallel.ai";
const PARALLEL_SEARCH_PATHNAME = "/v1/search";
const PARALLEL_MAX_SEARCH_COUNT = 40;
// Parallel v1 Search caps each search_queries entry at 200 chars, the
// objective field at 5000, and accepts up to 5 search queries. See
// https://docs.parallel.ai/search/best-practices.
const PARALLEL_MAX_SEARCH_QUERY_CHARS = 200;
const PARALLEL_MAX_OBJECTIVE_CHARS = 5000;
const PARALLEL_MAX_SEARCH_QUERIES = 5;
const PARALLEL_SESSION_ID_MAX_LENGTH = 1000;
const PARALLEL_CLIENT_MODEL_MAX_LENGTH = 100;

const require = createRequire(import.meta.url);
const PLUGIN_VERSION = readPluginPackageVersion({ require });
const USER_AGENT = `openclaw-parallel/${PLUGIN_VERSION} (${process.platform})`;

type ParallelConfig = {
  apiKey?: string;
  baseUrl?: string;
};

type ParallelSearchResult = {
  title?: unknown;
  url?: unknown;
  publish_date?: unknown;
  excerpts?: unknown;
};

type ParallelSearchResponse = {
  search_id?: unknown;
  session_id?: unknown;
  results?: unknown;
  warnings?: unknown;
  usage?: unknown;
};

function resolveParallelConfig(searchConfig?: SearchConfigRecord): ParallelConfig {
  const parallel = searchConfig?.parallel;
  return parallel && typeof parallel === "object" && !Array.isArray(parallel)
    ? (parallel as ParallelConfig)
    : {};
}

function resolveParallelApiKey(parallel?: ParallelConfig): string | undefined {
  return (
    readConfiguredSecretString(parallel?.apiKey, "tools.web.search.parallel.apiKey") ??
    readProviderEnvValue(["PARALLEL_API_KEY"])
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

function resolveParallelSearchCount(value: number): number {
  return Math.max(1, Math.min(PARALLEL_MAX_SEARCH_COUNT, Math.floor(value)));
}

function normalizeParallelSessionId(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed && trimmed.length <= PARALLEL_SESSION_ID_MAX_LENGTH ? trimmed : undefined;
}

function normalizeParallelObjective(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= PARALLEL_MAX_OBJECTIVE_CHARS
    ? trimmed
    : trimmed.slice(0, PARALLEL_MAX_OBJECTIVE_CHARS);
}

function normalizeParallelClientModel(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= PARALLEL_CLIENT_MODEL_MAX_LENGTH
    ? trimmed
    : trimmed.slice(0, PARALLEL_CLIENT_MODEL_MAX_LENGTH);
}

// Parallel's API caps each entry at 200 chars and accepts up to 5 queries.
// We trim, drop empties/duplicates, truncate over-long entries to the API's
// hard limit, and cap to the API's maximum so a malformed call from the
// model doesn't 422 the request. See https://docs.parallel.ai/search/best-practices.
function normalizeParallelSearchQueries(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of candidates) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const capped =
      trimmed.length <= PARALLEL_MAX_SEARCH_QUERY_CHARS
        ? trimmed
        : trimmed.slice(0, PARALLEL_MAX_SEARCH_QUERY_CHARS);
    if (seen.has(capped)) {
      continue;
    }
    seen.add(capped);
    out.push(capped);
    if (out.length === PARALLEL_MAX_SEARCH_QUERIES) {
      break;
    }
  }
  return out;
}

function invalidSearchQueriesPayload() {
  return {
    error: "invalid_search_queries",
    message:
      "search_queries must be a non-empty array of keyword strings (max 5, max 200 chars each). See https://docs.parallel.ai/search/best-practices.",
    docs: "https://docs.openclaw.ai/tools/parallel-search",
  };
}

function normalizeParallelResults(payload: unknown): ParallelSearchResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = (payload as ParallelSearchResponse).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter((entry): entry is ParallelSearchResult =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

function buildParallelCacheKey(params: {
  endpoint: string;
  objective?: string;
  searchQueries: readonly string[];
  count: number;
  sessionId?: string;
  clientModel?: string;
}): string {
  return buildSearchCacheKey([
    "parallel",
    params.endpoint,
    params.objective,
    // Search queries are already normalized (trimmed, deduped, length-capped,
    // ≤5) before reaching the cache key so the join is stable.
    params.searchQueries.join(""),
    params.count,
    // Different Parallel sessions can return different ranked excerpts for
    // the same query set, so partition cached payloads by caller-provided
    // session.
    params.sessionId,
    // Parallel tailors defaults/optimizations to client_model per its docs,
    // so partition cached payloads by it; otherwise two models hitting the
    // same query inside the cache TTL would silently share ranked excerpts.
    params.clientModel,
  ]);
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
        const detail = await res.text().catch(() => "");
        throw new Error(`Parallel API error (${res.status}): ${detail || res.statusText}`);
      }
      try {
        return (await res.json()) as ParallelSearchResponse;
      } catch (cause) {
        throw new Error("Parallel API returned malformed JSON", { cause });
      }
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
  // in that case rather than being faked from the keyword string — Parallel
  // documents `objective` as natural-language intent and treats it as
  // optional, so leaving it absent is more honest than reusing the keyword.
  // Agent callers that supply `objective`/`search_queries` explicitly take
  // precedence, and the documented schema still requires the native pair so
  // the model is encouraged to provide both.
  const objective = normalizeParallelObjective(readStringParam(args, "objective"));
  const cliQuery = normalizeParallelObjective(readStringParam(args, "query"));
  let searchQueries = normalizeParallelSearchQueries(readStringArrayParam(args, "search_queries"));
  if (searchQueries.length === 0 && cliQuery) {
    searchQueries = normalizeParallelSearchQueries([cliQuery]);
  }
  if (searchQueries.length === 0) {
    return invalidSearchQueriesPayload();
  }
  const requestedCount =
    readNumberParam(args, "count", { integer: true }) ??
    (typeof searchConfig?.maxResults === "number" ? searchConfig.maxResults : undefined);
  // Always pass max_results so Parallel matches the openclaw web_search
  // default of 5 instead of falling back to Parallel's own default of 10.
  // Switching providers should not silently change result volume / token cost.
  const count = resolveParallelSearchCount(requestedCount ?? DEFAULT_SEARCH_COUNT);
  const sessionId = normalizeParallelSessionId(readStringParam(args, "session_id"));
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
  const results = normalizeParallelResults(response).map((entry) => {
    const title = typeof entry.title === "string" ? entry.title : "";
    const url = typeof entry.url === "string" ? entry.url : "";
    const published =
      typeof entry.publish_date === "string" && entry.publish_date ? entry.publish_date : undefined;
    const excerpts = Array.isArray(entry.excerpts)
      ? entry.excerpts
          .filter((e): e is string => typeof e === "string")
          .map((e) => wrapWebContent(e, "web_search"))
      : [];
    const description = excerpts.join("\n\n");
    return Object.assign(
      {
        title: title ? wrapWebContent(title, "web_search") : "",
        url,
        description,
        siteName: resolveSiteName(url) || undefined,
      },
      published ? { published } : {},
      excerpts.length > 0 ? { excerpts } : {},
    );
  });

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
  // identical queries from unrelated tasks would otherwise share that id and
  // an agent threading `sessionId` into follow-ups would group unrelated
  // tasks on Parallel's side. Caller-supplied session ids are already part
  // of the cache key, so a cache-hit will only ever return the matching id.
  const cachePayload = sessionId ? payload : stripParallelGeneratedSessionId(payload);
  writeCachedSearchPayload(cacheKey, cachePayload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}

function stripParallelGeneratedSessionId(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!("sessionId" in payload)) {
    return payload;
  }
  const { sessionId: _omitted, ...rest } = payload;
  void _omitted;
  return rest;
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
  USER_AGENT,
} as const;

export { testing as __testing };
