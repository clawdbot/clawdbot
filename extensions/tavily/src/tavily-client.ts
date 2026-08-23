// Tavily plugin module implements tavily client behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  postTrustedWebToolsJson,
  readCache,
  resolveCacheTtlMs,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
  wrapWebContent,
} from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_TAVILY_BASE_URL,
  resolveTavilyApiKey,
  resolveTavilyBaseUrl,
  resolveTavilyExtractTimeoutSeconds,
  resolveTavilySearchTimeoutSeconds,
} from "./config.js";

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const EXTRACT_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const DEFAULT_SEARCH_COUNT = 5;
const TAVILY_SEARCH_MAX_CONTENT_CHARS = 20_000;
const TAVILY_EXTRACT_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const TAVILY_EXTRACT_MAX_CONTENT_CHARS = 20_000;
const TAVILY_EXTRACT_MAX_ERROR_CHARS = 4_000;
const TAVILY_EXTRACT_MAX_RESULTS = 20;
const TAVILY_RESULT_URL_MAX_CHARS = 2_048;
const TAVILY_PUBLISHED_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+Z-]{0,20})?$/u;

export type TavilySearchParams = {
  cfg?: OpenClawConfig;
  query: string;
  searchDepth?: string;
  topic?: string;
  maxResults?: number;
  includeAnswer?: boolean;
  timeRange?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  timeoutSeconds?: number;
  signal?: AbortSignal;
};

export type TavilyExtractParams = {
  cfg?: OpenClawConfig;
  urls: string[];
  query?: string;
  extractDepth?: string;
  chunksPerSource?: number;
  includeImages?: boolean;
  timeoutSeconds?: number;
  signal?: AbortSignal;
};

function normalizeTavilyResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > TAVILY_RESULT_URL_MAX_CHARS) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.href.length > TAVILY_RESULT_URL_MAX_CHARS
    ) {
      return undefined;
    }
    return url.href === `${value}/` ? value : url.href;
  } catch {
    return undefined;
  }
}

function resolveEndpoint(baseUrl: string, pathname: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return `${DEFAULT_TAVILY_BASE_URL}${pathname}`;
  }
  try {
    const url = new URL(trimmed);
    // Always append the endpoint pathname to the base URL path,
    // supporting both bare hosts and reverse-proxy path prefixes.
    url.pathname = url.pathname.replace(/\/$/, "") + pathname;
    return url.toString();
  } catch {
    return `${DEFAULT_TAVILY_BASE_URL}${pathname}`;
  }
}

async function postTavilyJson(params: {
  baseUrl: string;
  pathname: "/extract" | "/search";
  timeoutSeconds: number;
  apiKey: string;
  body: Record<string, unknown>;
  errorLabel: string;
  responseMaxBytes?: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  return postTrustedWebToolsJson(
    {
      url: resolveEndpoint(params.baseUrl, params.pathname),
      timeoutSeconds: params.timeoutSeconds,
      apiKey: params.apiKey,
      body: params.body,
      errorLabel: params.errorLabel,
      extraHeaders: { "X-Client-Source": "openclaw" },
      ...(params.signal ? { signal: params.signal } : {}),
    },
    async (response) =>
      readTavilyJsonResponse(response, params.errorLabel, {
        maxBytes: params.responseMaxBytes,
      }),
  );
}

async function readTavilyJsonResponse(
  response: Response,
  label: string,
  opts?: { maxBytes?: number },
): Promise<Record<string, unknown>> {
  return await readProviderJsonResponse<Record<string, unknown>>(response, label, opts);
}

export async function runTavilySearch(
  params: TavilySearchParams,
): Promise<Record<string, unknown>> {
  params.signal?.throwIfAborted();
  const apiKey = resolveTavilyApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "web_search (tavily) needs a Tavily API key. Set TAVILY_API_KEY in the Gateway environment, or configure plugins.entries.tavily.config.webSearch.apiKey.",
    );
  }
  const count =
    typeof params.maxResults === "number" && Number.isFinite(params.maxResults)
      ? Math.max(1, Math.min(20, Math.floor(params.maxResults)))
      : DEFAULT_SEARCH_COUNT;
  const timeoutSeconds = resolveTavilySearchTimeoutSeconds(params.timeoutSeconds);
  const baseUrl = resolveTavilyBaseUrl(params.cfg);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "tavily-search",
      q: params.query,
      count,
      baseUrl,
      searchDepth: params.searchDepth,
      topic: params.topic,
      includeAnswer: params.includeAnswer,
      timeRange: params.timeRange,
      includeDomains: params.includeDomains,
      excludeDomains: params.excludeDomains,
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const body: Record<string, unknown> = {
    query: params.query,
    max_results: count,
  };
  if (params.searchDepth) {
    body.search_depth = params.searchDepth;
  }
  if (params.topic) {
    body.topic = params.topic;
  }
  if (params.includeAnswer) {
    body.include_answer = true;
  }
  if (params.timeRange) {
    body.time_range = params.timeRange;
  }
  if (params.includeDomains?.length) {
    body.include_domains = params.includeDomains;
  }
  if (params.excludeDomains?.length) {
    body.exclude_domains = params.excludeDomains;
  }

  const start = Date.now();
  const payload = await postTavilyJson({
    baseUrl,
    pathname: "/search",
    timeoutSeconds,
    apiKey,
    body,
    errorLabel: "Tavily Search",
    ...(params.signal ? { signal: params.signal } : {}),
  });

  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  let remainingSearchContentChars = TAVILY_SEARCH_MAX_CONTENT_CHARS;
  let searchTruncated = rawResults.length > count;
  const wrapBoundedSearchContent = (value: string): string => {
    const bounded = truncateSanitizedExternalContent(value, remainingSearchContentChars);
    searchTruncated ||= bounded.truncated;
    remainingSearchContentChars -= bounded.text.length;
    return wrapWebContent(bounded.text, "web_search");
  };
  const results = rawResults.slice(0, count).flatMap((entry: unknown) => {
    if (!isRecord(entry)) {
      return [];
    }
    const url = normalizeTavilyResultUrl(entry.url);
    if (!url) {
      return [];
    }
    const published =
      typeof entry.published_date === "string" &&
      TAVILY_PUBLISHED_DATE_RE.test(entry.published_date)
        ? entry.published_date
        : undefined;
    return [
      {
        title: typeof entry.title === "string" ? wrapBoundedSearchContent(entry.title) : "",
        url,
        snippet: typeof entry.content === "string" ? wrapBoundedSearchContent(entry.content) : "",
        score: typeof entry.score === "number" ? entry.score : undefined,
        ...(published ? { published } : {}),
      },
    ];
  });

  const result: Record<string, unknown> = {
    query: params.query,
    provider: "tavily",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "tavily",
      wrapped: true,
    },
    results,
  };
  if (typeof payload.answer === "string" && payload.answer) {
    result.answer = wrapBoundedSearchContent(payload.answer);
  }
  if (searchTruncated) {
    result.truncated = true;
  }

  writeCache(
    SEARCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export async function runTavilyExtract(
  params: TavilyExtractParams,
): Promise<Record<string, unknown>> {
  params.signal?.throwIfAborted();
  const apiKey = resolveTavilyApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "tavily_extract needs a Tavily API key. Set TAVILY_API_KEY in the Gateway environment, or configure plugins.entries.tavily.config.webSearch.apiKey.",
    );
  }
  const baseUrl = resolveTavilyBaseUrl(params.cfg);
  const timeoutSeconds = resolveTavilyExtractTimeoutSeconds(params.timeoutSeconds);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "tavily-extract",
      urls: params.urls,
      baseUrl,
      query: params.query,
      extractDepth: params.extractDepth,
      chunksPerSource: params.chunksPerSource,
      includeImages: params.includeImages,
    }),
  );
  const cached = readCache(EXTRACT_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const body: Record<string, unknown> = { urls: params.urls };
  if (params.query) {
    body.query = params.query;
  }
  if (params.extractDepth) {
    body.extract_depth = params.extractDepth;
  }
  if (params.chunksPerSource) {
    body.chunks_per_source = params.chunksPerSource;
  }
  if (params.includeImages) {
    body.include_images = true;
  }

  const start = Date.now();
  const payload = await postTavilyJson({
    baseUrl,
    pathname: "/extract",
    timeoutSeconds,
    apiKey,
    body,
    errorLabel: "Tavily Extract",
    // Extract can include raw page content and image lists, unlike search metadata.
    responseMaxBytes: TAVILY_EXTRACT_RESPONSE_MAX_BYTES,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  let remainingContentChars = TAVILY_EXTRACT_MAX_CONTENT_CHARS;
  let remainingErrorChars = TAVILY_EXTRACT_MAX_ERROR_CHARS;
  let remainingImages = TAVILY_EXTRACT_MAX_RESULTS;
  let truncated = rawResults.length > TAVILY_EXTRACT_MAX_RESULTS;
  const wrapBoundedContent = (value: string, budget: "content" | "error"): string => {
    const available = budget === "content" ? remainingContentChars : remainingErrorChars;
    const bounded = truncateSanitizedExternalContent(value, available);
    truncated ||= bounded.truncated;
    if (budget === "content") {
      remainingContentChars -= bounded.text.length;
    } else {
      remainingErrorChars -= bounded.text.length;
    }
    return wrapExternalContent(bounded.text, { source: "web_fetch", includeWarning: false });
  };
  const results = rawResults.slice(0, TAVILY_EXTRACT_MAX_RESULTS).flatMap((entry: unknown) => {
    if (!isRecord(entry)) {
      return [];
    }
    const url = normalizeTavilyResultUrl(entry.url);
    if (!url) {
      return [];
    }
    const rawImages = Array.isArray(entry.images) ? entry.images : undefined;
    const images = rawImages?.slice(0, remainingImages).flatMap((image: unknown) => {
      const imageUrl = normalizeTavilyResultUrl(image);
      return imageUrl
        ? [wrapExternalContent(imageUrl, { source: "web_fetch", includeWarning: false })]
        : [];
    });
    if (rawImages && images) {
      truncated ||= rawImages.length > remainingImages;
      remainingImages -= images.length;
    }
    return [
      {
        url,
        rawContent:
          typeof entry.raw_content === "string"
            ? wrapBoundedContent(entry.raw_content, "content")
            : "",
        ...(typeof entry.content === "string"
          ? { content: wrapBoundedContent(entry.content, "content") }
          : {}),
        ...(images ? { images } : {}),
      },
    ];
  });
  const rawFailedResults = Array.isArray(payload.failed_results) ? payload.failed_results : [];
  truncated ||= rawFailedResults.length > TAVILY_EXTRACT_MAX_RESULTS;
  const failedResults = rawFailedResults
    .slice(0, TAVILY_EXTRACT_MAX_RESULTS)
    .flatMap((entry: unknown) => {
      if (!isRecord(entry)) {
        return [];
      }
      const url = normalizeTavilyResultUrl(entry.url);
      return url && typeof entry.error === "string"
        ? [{ url, error: wrapBoundedContent(entry.error, "error") }]
        : [];
    });

  const result: Record<string, unknown> = {
    provider: "tavily",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      provider: "tavily",
      wrapped: true,
    },
    results,
    ...(failedResults.length > 0 ? { failedResults } : {}),
    ...(truncated ? { truncated: true } : {}),
  };

  writeCache(
    EXTRACT_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export const testing = {
  readTavilyJsonResponse,
  resolveEndpoint,
};
