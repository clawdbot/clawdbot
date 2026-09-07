// Google provider module implements model/runtime integration.
import { createHash } from "node:crypto";
import {
  createProviderHttpError,
  formatProviderHttpErrorMessage,
  readProviderJsonObjectResponse,
  truncateErrorDetail,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  MAX_SEARCH_COUNT,
  parseWebSearchTimeFilters,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
  readStringParam,
  resolveCitationRedirectUrl,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleApiClientHeaders } from "../google-api-client-header.js";
import {
  resolveGeminiConfig,
  resolveGeminiBaseUrl,
  resolveGeminiModel,
  type GeminiConfig,
} from "./gemini-web-search-provider.shared.js";

type GeminiFreshness = "day" | "week" | "month" | "year";

type GeminiTimeRangeFilter = {
  startTime: string;
  endTime: string;
};

const GEMINI_PROVIDER_OWNED_HEADER_NAMES = new Set([
  "content-type",
  "x-goog-api-client",
  "x-goog-api-key",
]);

// Headers validates field syntax, but Undici does not implement Fetch's
// forbidden-request-header checks. These names can otherwise be consumed,
// ignored, or rejected only after the request reaches the transport.
const GEMINI_UNSAFE_REQUEST_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function throwMalformedGeminiResponse(): never {
  throw new Error("Gemini API error: malformed JSON response");
}

const GEMINI_FRESHNESS_DAYS: Record<GeminiFreshness, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const GEMINI_DAY_FRESHNESS_HINT = "Prioritize web sources published in the last 24 hours.";

// Gemini's google_search.time_range_filter accepts second-precision RFC 3339
// only. Despite the underlying google.protobuf.Timestamp type accepting "0, 3,
// 6 or 9 fractional digits", the Search grounding endpoint rejects any
// non-zero fractional component with
//   "[FIELD_INVALID] Granularity of nano is not supported".
// Strip the fractional-second component before serializing.
function toGeminiTimeRangeTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function isoDateStart(value: string): string {
  return `${value}T00:00:00Z`;
}

function isoDateExclusiveEnd(value: string): string {
  const end = new Date(`${value}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return toGeminiTimeRangeTimestamp(end);
}

function freshnessStartTime(freshness: GeminiFreshness, now: Date): string {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - GEMINI_FRESHNESS_DAYS[freshness]);
  return toGeminiTimeRangeTimestamp(start);
}

function queryWithSoftFreshness(query: string, freshness?: GeminiFreshness): string {
  if (freshness !== "day") {
    return query;
  }
  return `${query}\n\nSearch recency instruction: ${GEMINI_DAY_FRESHNESS_HINT} If no matching recent sources are available, state that limitation and use the most relevant available sources.`;
}

function resolveGeminiTimeRangeFilter(
  args: Record<string, unknown>,
  now = new Date(),
):
  | {
      timeRangeFilter?: GeminiTimeRangeFilter;
      freshness?: GeminiFreshness;
      dateAfter?: string;
      dateBefore?: string;
    }
  | {
      error:
        | "invalid_freshness"
        | "invalid_date"
        | "invalid_date_range"
        | "conflicting_time_filters";
      message: string;
      docs: string;
    } {
  const rawFreshness = readStringParam(args, "freshness");
  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  const parsedTimeFilters = parseWebSearchTimeFilters({
    rawDateAfter,
    rawDateBefore,
    rawFreshness,
    freshnessProvider: "perplexity",
    invalidFreshnessMessage:
      "freshness must be day, week, month, year, or the shortcuts pd, pw, pm, py.",
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be before date_before.",
  });
  if ("error" in parsedTimeFilters) {
    return parsedTimeFilters;
  }

  const { freshness, dateAfter, dateBefore } = parsedTimeFilters;
  if (freshness) {
    // Gemini rejects 24-hour google_search.timeRangeFilter windows, while
    // wider freshness windows still preserve the hard grounding contract.
    if (freshness === "day") {
      return {
        freshness,
      };
    }
    return {
      freshness,
      timeRangeFilter: {
        startTime: freshnessStartTime(freshness, now),
        endTime: toGeminiTimeRangeTimestamp(now),
      },
    };
  }

  if (!dateAfter && !dateBefore) {
    return {};
  }

  return {
    dateAfter,
    dateBefore,
    timeRangeFilter: {
      startTime: dateAfter ? isoDateStart(dateAfter) : "1970-01-01T00:00:00Z",
      endTime: dateBefore ? isoDateExclusiveEnd(dateBefore) : toGeminiTimeRangeTimestamp(now),
    },
  };
}

function resolveGeminiRuntimeApiKey(gemini?: GeminiConfig): string | undefined {
  return (
    readConfiguredSecretString(gemini?.apiKey, "plugins.entries.google.config.webSearch.apiKey") ??
    readProviderEnvValue(["GEMINI_API_KEY"]) ??
    readConfiguredSecretString(gemini?.providerApiKey, "models.providers.google.apiKey")
  );
}

function resolveGeminiWebSearchHeaders(gemini?: GeminiConfig): Record<string, string> | undefined {
  if (!isRecord(gemini?.headers)) {
    return undefined;
  }
  const headers = new Headers();
  for (const [name, input] of Object.entries(gemini.headers)) {
    const path = `plugins.entries.google.config.webSearch.headers[${JSON.stringify(name)}]`;
    const value =
      typeof input === "string"
        ? input
        : normalizeResolvedSecretInputString({ value: input, path });
    if (value === undefined) {
      throw new Error(`${path} must be a string or resolved SecretRef.`);
    }
    let normalizedName: string;
    let normalizedValue: string;
    try {
      const candidate = new Headers([[name, value]]);
      const [entry] = candidate.entries();
      if (!entry) {
        throw new Error("missing normalized header entry");
      }
      [normalizedName, normalizedValue] = entry;
    } catch {
      throw new Error(`${path} is not a valid HTTP header.`);
    }
    if (GEMINI_UNSAFE_REQUEST_HEADER_NAMES.has(normalizedName)) {
      throw new Error(`${path} uses a reserved or framing HTTP header.`);
    }
    if (GEMINI_PROVIDER_OWNED_HEADER_NAMES.has(normalizedName)) {
      continue;
    }
    headers.set(normalizedName, normalizedValue);
  }
  const entries = [...headers.entries()];
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function buildGeminiRequestHeaders(params: {
  apiKey: string;
  baseUrl: string;
  operatorHeaders?: Record<string, string>;
}): HeadersInit {
  const providerHeaders = {
    "Content-Type": "application/json",
    "x-goog-api-key": params.apiKey,
    ...resolveGoogleApiClientHeaders({
      baseUrl: params.baseUrl,
      api: "google-generative-ai",
      capability: "other",
      transport: "http",
    }),
  };
  if (!params.operatorHeaders) {
    return providerHeaders;
  }
  const headers = new Headers(params.operatorHeaders);
  for (const [name, value] of Object.entries(providerHeaders)) {
    headers.set(name, value);
  }
  return headers;
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  timeRangeFilter?: GeminiTimeRangeFilter;
  headers?: Record<string, string>;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${params.baseUrl}/models/${params.model}:generateContent`;
  const googleSearch =
    params.timeRangeFilter === undefined ? {} : { timeRangeFilter: params.timeRangeFilter };

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "POST",
        headers: buildGeminiRequestHeaders({
          apiKey: params.apiKey,
          baseUrl: params.baseUrl,
          operatorHeaders: params.headers,
        }),
        body: JSON.stringify({
          contents: [{ parts: [{ text: params.query }] }],
          tools: [{ google_search: googleSearch }],
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const error = await createProviderHttpError(res, "Gemini API error");
        throw new Error(error.message.replace(/key=[^&\s]+/giu, "key=***"));
      }

      const data = await readProviderJsonObjectResponse(res, "Gemini API error");

      if (data.error !== undefined) {
        if (!isRecord(data.error)) {
          throwMalformedGeminiResponse();
        }
        const rawMessage =
          normalizeOptionalString(data.error.message) ??
          normalizeOptionalString(data.error.status) ??
          "unknown";
        throw new Error(
          formatProviderHttpErrorMessage({
            label: "Gemini API error",
            status: typeof data.error.code === "number" ? data.error.code : 0,
            detail: rawMessage.replace(/key=[^&\s]+/giu, "key=***"),
          }),
        );
      }

      if (
        (data.candidates !== undefined && !Array.isArray(data.candidates)) ||
        (data.promptFeedback !== undefined && !isRecord(data.promptFeedback))
      ) {
        throwMalformedGeminiResponse();
      }
      const candidate: unknown = data.candidates?.[0];
      if (candidate !== undefined && !isRecord(candidate)) {
        throwMalformedGeminiResponse();
      }
      const candidateContent = candidate?.content;
      if (candidateContent !== undefined && !isRecord(candidateContent)) {
        throwMalformedGeminiResponse();
      }
      const parts = candidateContent?.parts;
      if (parts !== undefined && !Array.isArray(parts)) {
        throwMalformedGeminiResponse();
      }
      const content = (parts ?? [])
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : undefined))
        .filter((text): text is string => Boolean(text))
        .join("\n");
      const groundingMetadata = candidate?.groundingMetadata;
      if (groundingMetadata !== undefined && !isRecord(groundingMetadata)) {
        throwMalformedGeminiResponse();
      }
      const groundingChunks = groundingMetadata?.groundingChunks;
      if (groundingChunks !== undefined && !Array.isArray(groundingChunks)) {
        throwMalformedGeminiResponse();
      }
      if (!content) {
        const reasons = [data.promptFeedback?.blockReason, candidate?.finishReason];
        if (
          reasons.some((reason) => reason !== undefined && typeof reason !== "string") ||
          parts?.some(
            (part) => !isRecord(part) || (part.text !== undefined && typeof part.text !== "string"),
          )
        ) {
          throwMalformedGeminiResponse();
        }
        // No answer is not proof of zero search matches. Keep the thrown seam
        // so explicit selection and automatic fallback retain their behavior.
        const reason = reasons.map((value) => normalizeOptionalString(value)).find(Boolean);
        const detail = reason ? ` (${truncateErrorDetail(reason, 120)})` : "";
        throw new Error(`Gemini search returned no final answer${detail}.`);
      }
      const rawCitations = (groundingChunks ?? []).flatMap((chunk) => {
        if (!isRecord(chunk) || !isRecord(chunk.web) || typeof chunk.web.uri !== "string") {
          return [];
        }
        return [
          {
            url: chunk.web.uri,
            title: typeof chunk.web.title === "string" ? chunk.web.title : undefined,
          },
        ];
      });

      const citations: Array<{ url: string; title?: string }> = [];
      for (let index = 0; index < rawCitations.length; index += 10) {
        const batch = rawCitations.slice(index, index + 10);
        const resolved = await Promise.all(
          batch.map(async (citation) =>
            Object.assign({}, citation, { url: await resolveCitationRedirectUrl(citation.url) }),
          ),
        );
        citations.push(...resolved);
      }

      return { content, citations };
    },
  );
}

export async function executeGeminiSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
  context?: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  context?.signal?.throwIfAborted();
  const unsupportedResponse = buildUnsupportedSearchFilterResponse(
    {
      country: args.country,
      language: args.language,
    },
    "gemini",
  );
  if (unsupportedResponse) {
    return unsupportedResponse;
  }

  const timeRange = resolveGeminiTimeRangeFilter(args);
  if ("error" in timeRange) {
    return timeRange;
  }

  const geminiConfig = resolveGeminiConfig(searchConfig);
  const apiKey = resolveGeminiRuntimeApiKey(geminiConfig);
  if (!apiKey) {
    return {
      error: "missing_gemini_api_key",
      message:
        "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, configure plugins.entries.google.config.webSearch.apiKey, or reuse models.providers.google.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const query = readStringParam(args, "query", { required: true });
  void readPositiveIntegerParam(args, "count", {
    max: MAX_SEARCH_COUNT,
    message: `count must be an integer from 1 to ${MAX_SEARCH_COUNT}.`,
  });
  const model = resolveGeminiModel(geminiConfig);
  const baseUrl = resolveGeminiBaseUrl(geminiConfig);
  const headers = resolveGeminiWebSearchHeaders(geminiConfig);
  const headersCacheKey = headers
    ? createHash("sha256")
        .update(
          JSON.stringify(
            Object.entries(headers).toSorted(([left], [right]) => left.localeCompare(right)),
          ),
        )
        .digest("hex")
    : undefined;
  const cacheKey = buildSearchCacheKey([
    "gemini",
    query,
    baseUrl,
    model,
    timeRange.freshness,
    timeRange.dateAfter,
    timeRange.dateBefore,
    headersCacheKey,
  ]);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const result = await runGeminiSearch({
    query: queryWithSoftFreshness(query, timeRange.freshness),
    apiKey,
    baseUrl,
    model,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
    signal: context?.signal,
    timeRangeFilter: timeRange.timeRangeFilter,
    headers,
  });
  context?.signal?.throwIfAborted();
  const payload = {
    query,
    provider: "gemini",
    model,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "gemini",
      wrapped: true,
    },
    content: wrapWebContent(result.content),
    citations: result.citations,
  };
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
