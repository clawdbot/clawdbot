import {
  createProviderHttpError,
  formatProviderHttpErrorMessage,
  readProviderJsonObjectResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  normalizeFreshness,
  parseIsoDateRange,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveCitationRedirectUrl,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
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

type GeminiGroundingResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwMalformedGeminiResponse(): never {
  throw new Error("Gemini API error: malformed JSON response");
}

const GEMINI_FRESHNESS_DAYS: Record<GeminiFreshness, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function isoDateStart(value: string): string {
  return `${value}T00:00:00Z`;
}

function isoDateExclusiveEnd(value: string): string {
  const end = new Date(`${value}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString();
}

function freshnessStartTime(freshness: GeminiFreshness, now: Date): string {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - GEMINI_FRESHNESS_DAYS[freshness]);
  return start.toISOString();
}

function resolveGeminiTimeRangeFilter(
  args: Record<string, unknown>,
  now = new Date(),
):
  | { timeRangeFilter?: GeminiTimeRangeFilter }
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
  const freshness = rawFreshness
    ? (normalizeFreshness(rawFreshness, "perplexity") as GeminiFreshness | undefined)
    : undefined;
  if (rawFreshness && !freshness) {
    return {
      error: "invalid_freshness",
      message: "freshness must be day, week, month, year, or the shortcuts pd, pw, pm, py.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  if (rawFreshness && (rawDateAfter || rawDateBefore)) {
    return {
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const parsedDateRange = parseIsoDateRange({
    rawDateAfter,
    rawDateBefore,
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be before date_before.",
  });
  if ("error" in parsedDateRange) {
    return parsedDateRange;
  }

  if (freshness) {
    return {
      timeRangeFilter: {
        startTime: freshnessStartTime(freshness, now),
        endTime: now.toISOString(),
      },
    };
  }

  const { dateAfter, dateBefore } = parsedDateRange;
  if (!dateAfter && !dateBefore) {
    return {};
  }

  return {
    timeRangeFilter: {
      startTime: dateAfter ? isoDateStart(dateAfter) : "1970-01-01T00:00:00Z",
      endTime: dateBefore ? isoDateExclusiveEnd(dateBefore) : now.toISOString(),
    },
  };
}

export function resolveGeminiRuntimeApiKey(gemini?: GeminiConfig): string | undefined {
  return (
    readConfiguredSecretString(gemini?.apiKey, "tools.web.search.gemini.apiKey") ??
    readProviderEnvValue(["GEMINI_API_KEY"]) ??
    readConfiguredSecretString(gemini?.providerApiKey, "models.providers.google.apiKey")
  );
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  timeRangeFilter?: GeminiTimeRangeFilter;
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
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": params.apiKey,
        },
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

      const data = (await readProviderJsonObjectResponse(
        res,
        "Gemini API error",
      )) as GeminiGroundingResponse;

      if (data.error) {
        const rawMessage = data.error.message || data.error.status || "unknown";
        throw new Error(
          formatProviderHttpErrorMessage({
            label: "Gemini API error",
            status: data.error.code ?? 0,
            detail: rawMessage.replace(/key=[^&\s]+/giu, "key=***"),
          }),
        );
      }

      if (!Array.isArray(data.candidates)) {
        throwMalformedGeminiResponse();
      }
      const candidate = data.candidates[0];
      if (!isRecord(candidate) || !isRecord(candidate.content)) {
        throwMalformedGeminiResponse();
      }
      const parts = candidate.content.parts;
      if (!Array.isArray(parts)) {
        throwMalformedGeminiResponse();
      }
      const content = parts
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : undefined))
        .filter((text): text is string => Boolean(text))
        .join("\n");
      if (!content) {
        throwMalformedGeminiResponse();
      }
      const groundingMetadata = candidate.groundingMetadata;
      const groundingChunks =
        groundingMetadata === undefined
          ? []
          : isRecord(groundingMetadata) && Array.isArray(groundingMetadata.groundingChunks)
            ? groundingMetadata.groundingChunks
            : undefined;
      if (!groundingChunks) {
        throwMalformedGeminiResponse();
      }
      const rawCitations = groundingChunks.flatMap((chunk) => {
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
  const count =
    readNumberParam(args, "count", { integer: true }) ?? searchConfig?.maxResults ?? undefined;
  const model = resolveGeminiModel(geminiConfig);
  const baseUrl = resolveGeminiBaseUrl(geminiConfig);
  const cacheKey = buildSearchCacheKey([
    "gemini",
    query,
    resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    baseUrl,
    model,
    timeRange.timeRangeFilter?.startTime,
    timeRange.timeRangeFilter?.endTime,
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const result = await runGeminiSearch({
    query,
    apiKey,
    baseUrl,
    model,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
    signal: context?.signal,
    timeRangeFilter: timeRange.timeRangeFilter,
  });
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
  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}
