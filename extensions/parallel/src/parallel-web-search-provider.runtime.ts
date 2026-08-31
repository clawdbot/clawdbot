import { createRequire } from "node:module";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import {
  mergeScopedSearchConfig,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
} from "openclaw/plugin-sdk/provider-web-search";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildParallelCacheKey,
  executeParallelSearchRequest,
  normalizeParallelClientModel,
  normalizeParallelObjective,
  normalizeParallelResults,
  normalizeParallelSearchQueries,
  type ParallelSearchResponse,
  resolveParallelSearchCount,
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
  signal?: AbortSignal;
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
      signal: params.signal,
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
        // Provider/proxy error pages can reflect request headers (including the
        // x-api-key), and the empty-body statusText fallback is server-controlled
        // too. Redact in two passes before the detail lands in user-facing error
        // text: the tools-mode pass masks header-shaped reflections while the
        // header name is intact (a configured pattern like api[_-]?key would
        // otherwise rewrite the name first and hide the shape from the
        // structured matcher), then the canonical tool-payload redactor applies
        // the operator's logging.redactPatterns on top of the built-in defaults.
        throw new Error(
          `Parallel API error (${res.status}): ${redactToolPayloadText(redactSensitiveText(detail || res.statusText, { mode: "tools" }))}`,
        );
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
  signal?: AbortSignal,
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

  return executeParallelSearchRequest({
    provider: "parallel",
    endpoint,
    args,
    searchConfig,
    signal,
    search: ({ count, ...request }, timeoutSeconds) =>
      runParallelSearch({
        ...request,
        apiKey,
        endpoint,
        maxResults: count,
        timeoutSeconds,
        signal,
      }),
  });
}

export const testing = {
  buildParallelCacheKey,
  missingParallelKeyPayload,
  normalizeParallelClientModel,
  normalizeParallelObjective,
  normalizeParallelResults,
  normalizeParallelSearchQueries,
  resolveParallelApiKey,
  resolveParallelSearchCount,
  resolveParallelSearchEndpoint,
  PARALLEL_SEARCH_RESPONSE_LIMIT_BYTES,
  USER_AGENT,
} as const;
