import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  mergeScopedSearchConfig,
  parseIsoDateRange,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
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
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const EXA_SEARCH_TYPES = ["auto", "neural", "fast", "deep", "deep-reasoning", "instant"] as const;
const EXA_FRESHNESS_VALUES = ["day", "week", "month", "year"] as const;
const EXA_MAX_SEARCH_COUNT = 100;

type ExaConfig = {
  apiKey?: string;
};

type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];
type ExaFreshness = (typeof EXA_FRESHNESS_VALUES)[number];

type ExaTextContentsOption = boolean | { maxCharacters?: number };
type ExaHighlightsContentsOption =
  | boolean
  | {
      maxCharacters?: number;
      query?: string;
      numSentences?: number;
      highlightsPerUrl?: number;
    };
type ExaSummaryContentsOption = boolean | { query?: string };

type ExaContentsArgs = {
  highlights?: ExaHighlightsContentsOption;
  text?: ExaTextContentsOption;
  summary?: ExaSummaryContentsOption;
};

type ExaSearchResult = {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  highlights?: unknown;
  highlightScores?: unknown;
  summary?: unknown;
  text?: unknown;
};

type ExaSearchResponse = {
  results?: unknown;
};

function normalizeExaFreshness(value: string | undefined): ExaFreshness | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  if (!trimmed) {
    return undefined;
  }
  return EXA_FRESHNESS_VALUES.includes(trimmed as ExaFreshness)
    ? (trimmed as ExaFreshness)
    : undefined;
}

function resolveExaConfig(searchConfig?: SearchConfigRecord): ExaConfig {
  const exa = searchConfig?.exa;
  return exa && typeof exa === "object" && !Array.isArray(exa) ? (exa as ExaConfig) : {};
}

function resolveExaApiKey(exa?: ExaConfig): string | undefined {
  return (
    readConfiguredSecretString(exa?.apiKey, "tools.web.search.exa.apiKey") ??
    readProviderEnvValue(["EXA_API_KEY"])
  );
}

function resolveExaDescription(result: ExaSearchResult): string {
  const highlights = result.highlights;
  if (Array.isArray(highlights)) {
    const highlightText = highlights
      .map((entry) => normalizeOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
    if (highlightText) {
      return highlightText;
    }
  }
  const summary = normalizeOptionalString(result.summary);
  if (summary) {
    return summary;
  }
  return normalizeOptionalString(result.text) ?? "";
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function invalidContentsPayload(message: string) {
  return {
    error: "invalid_contents",
    message,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function isErrorPayload(value: unknown): value is { error: string; message: string; docs: string } {
  return Boolean(
    value && typeof value === "object" && "error" in value && "message" in value && "docs" in value,
  );
}

function resolveExaSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(EXA_MAX_SEARCH_COUNT, Math.floor(parsed)));
}

function parseExaContents(
  rawContents: unknown,
): { value?: ExaContentsArgs } | { error: string; message: string; docs: string } {
  if (rawContents === undefined) {
    return { value: undefined };
  }
  if (!rawContents || typeof rawContents !== "object" || Array.isArray(rawContents)) {
    return invalidContentsPayload(
      "contents must be an object with optional text, highlights, and summary fields.",
    );
  }

  const raw = rawContents as Record<string, unknown>;
  const allowedKeys = new Set(["text", "highlights", "summary"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return invalidContentsPayload(
        `contents has unknown field "${key}". Only "text", "highlights", and "summary" are allowed.`,
      );
    }
  }

  const parsed: ExaContentsArgs = {};

  const parseText = (
    value: unknown,
  ): ExaTextContentsOption | { error: string; message: string; docs: string } => {
    if (typeof value === "boolean") {
      return value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalidContentsPayload("contents.text must be a boolean or an object.");
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== "maxCharacters") {
        return invalidContentsPayload(
          `contents.text has unknown field "${key}". Only "maxCharacters" is allowed.`,
        );
      }
    }
    if ("maxCharacters" in obj && parsePositiveInteger(obj.maxCharacters) === undefined) {
      return invalidContentsPayload("contents.text.maxCharacters must be a positive integer.");
    }
    return parsePositiveInteger(obj.maxCharacters)
      ? { maxCharacters: parsePositiveInteger(obj.maxCharacters) }
      : {};
  };

  const parseHighlights = (
    value: unknown,
  ): ExaHighlightsContentsOption | { error: string; message: string; docs: string } => {
    if (typeof value === "boolean") {
      return value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalidContentsPayload("contents.highlights must be a boolean or an object.");
    }
    const obj = value as Record<string, unknown>;
    const allowed = new Set(["maxCharacters", "query", "numSentences", "highlightsPerUrl"]);
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        return invalidContentsPayload(
          `contents.highlights has unknown field "${key}". Allowed fields are "maxCharacters", "query", "numSentences", and "highlightsPerUrl".`,
        );
      }
    }
    if ("maxCharacters" in obj && parsePositiveInteger(obj.maxCharacters) === undefined) {
      return invalidContentsPayload(
        "contents.highlights.maxCharacters must be a positive integer.",
      );
    }
    if ("numSentences" in obj && parsePositiveInteger(obj.numSentences) === undefined) {
      return invalidContentsPayload("contents.highlights.numSentences must be a positive integer.");
    }
    if ("highlightsPerUrl" in obj && parsePositiveInteger(obj.highlightsPerUrl) === undefined) {
      return invalidContentsPayload(
        "contents.highlights.highlightsPerUrl must be a positive integer.",
      );
    }
    if ("query" in obj && typeof obj.query !== "string") {
      return invalidContentsPayload("contents.highlights.query must be a string.");
    }
    return {
      ...(parsePositiveInteger(obj.maxCharacters)
        ? { maxCharacters: parsePositiveInteger(obj.maxCharacters) }
        : {}),
      ...(typeof obj.query === "string" ? { query: obj.query } : {}),
      ...(parsePositiveInteger(obj.numSentences)
        ? { numSentences: parsePositiveInteger(obj.numSentences) }
        : {}),
      ...(parsePositiveInteger(obj.highlightsPerUrl)
        ? { highlightsPerUrl: parsePositiveInteger(obj.highlightsPerUrl) }
        : {}),
    };
  };

  const parseSummary = (
    value: unknown,
  ): ExaSummaryContentsOption | { error: string; message: string; docs: string } => {
    if (typeof value === "boolean") {
      return value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalidContentsPayload("contents.summary must be a boolean or an object.");
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== "query") {
        return invalidContentsPayload(
          `contents.summary has unknown field "${key}". Only "query" is allowed.`,
        );
      }
    }
    if ("query" in obj && typeof obj.query !== "string") {
      return invalidContentsPayload("contents.summary.query must be a string.");
    }
    return typeof obj.query === "string" ? { query: obj.query } : {};
  };

  if ("text" in raw) {
    const parsedText = parseText(raw.text);
    if (isErrorPayload(parsedText)) {
      return parsedText;
    }
    parsed.text = parsedText;
  }
  if ("highlights" in raw) {
    const parsedHighlights = parseHighlights(raw.highlights);
    if (isErrorPayload(parsedHighlights)) {
      return parsedHighlights;
    }
    parsed.highlights = parsedHighlights;
  }
  if ("summary" in raw) {
    const parsedSummary = parseSummary(raw.summary);
    if (isErrorPayload(parsedSummary)) {
      return parsedSummary;
    }
    parsed.summary = parsedSummary;
  }

  return { value: parsed };
}

function normalizeExaResults(payload: unknown): ExaSearchResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = (payload as ExaSearchResponse).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter((entry): entry is ExaSearchResult =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

function resolveFreshnessStartDate(freshness: ExaFreshness): string {
  const now = new Date();
  if (freshness === "day") {
    now.setUTCDate(now.getUTCDate() - 1);
    return now.toISOString();
  }
  if (freshness === "week") {
    now.setUTCDate(now.getUTCDate() - 7);
    return now.toISOString();
  }
  if (freshness === "month") {
    const currentDay = now.getUTCDate();
    now.setUTCDate(1);
    now.setUTCMonth(now.getUTCMonth() - 1);
    const lastDayOfTargetMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    now.setUTCDate(Math.min(currentDay, lastDayOfTargetMonth));
    return now.toISOString();
  }
  now.setUTCFullYear(now.getUTCFullYear() - 1);
  return now.toISOString();
}

async function runExaSearch(params: {
  apiKey: string;
  query: string;
  count: number;
  freshness?: ExaFreshness;
  dateAfter?: string;
  dateBefore?: string;
  type: ExaSearchType;
  contents?: ExaContentsArgs;
  timeoutSeconds: number;
}): Promise<ExaSearchResult[]> {
  const body: Record<string, unknown> = {
    query: params.query,
    numResults: params.count,
    type: params.type,
    contents: params.contents ?? { highlights: true },
  };

  if (params.dateAfter) {
    body.startPublishedDate = params.dateAfter;
  } else if (params.freshness) {
    body.startPublishedDate = resolveFreshnessStartDate(params.freshness);
  }
  if (params.dateBefore) {
    body.endPublishedDate = params.dateBefore;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: EXA_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": params.apiKey,
          "x-exa-integration": "openclaw",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Exa API error (${res.status}): ${detail || res.statusText}`);
      }
      try {
        return normalizeExaResults(await res.json());
      } catch (error) {
        throw new Error(`Exa API returned invalid JSON: ${String(error)}`, { cause: error });
      }
    },
  );
}

function missingExaKeyPayload() {
  return {
    error: "missing_exa_api_key",
    message:
      "web_search (exa) needs an Exa API key. Set EXA_API_KEY in the Gateway environment, or configure tools.web.search.exa.apiKey.",
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

export async function executeExaWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "exa",
    resolveProviderWebSearchPluginConfig(ctx.config, "exa"),
  ) as SearchConfigRecord | undefined;
  const params = args;
  const exaConfig = resolveExaConfig(searchConfig);
  const apiKey = resolveExaApiKey(exaConfig);
  if (!apiKey) {
    return missingExaKeyPayload();
  }

  const query = readStringParam(params, "query", { required: true });
  const rawType = readStringParam(params, "type");
  const type: ExaSearchType = EXA_SEARCH_TYPES.includes(rawType as ExaSearchType)
    ? (rawType as ExaSearchType)
    : "auto";
  const count =
    readNumberParam(params, "count", { integer: true }) ?? searchConfig?.maxResults ?? undefined;
  const rawFreshness = readStringParam(params, "freshness");
  const freshness = normalizeExaFreshness(rawFreshness);
  if (rawFreshness && !freshness) {
    return {
      error: "invalid_freshness",
      message: 'freshness must be one of "day", "week", "month", or "year".',
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const rawDateAfter = readStringParam(params, "date_after");
  const rawDateBefore = readStringParam(params, "date_before");
  if (freshness && (rawDateAfter || rawDateBefore)) {
    return {
      error: "conflicting_time_filters",
      message:
        "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  const parsedDateRange = parseIsoDateRange({
    rawDateAfter,
    rawDateBefore,
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be earlier than or equal to date_before.",
  });
  if ("error" in parsedDateRange) {
    return parsedDateRange;
  }
  const { dateAfter, dateBefore } = parsedDateRange;

  const parsedContents = parseExaContents(params.contents);
  if (isErrorPayload(parsedContents)) {
    return parsedContents;
  }
  const contents =
    parsedContents.value && Object.keys(parsedContents.value).length > 0
      ? parsedContents.value
      : undefined;

  const cacheKey = buildSearchCacheKey([
    "exa",
    type,
    query,
    resolveExaSearchCount(count, DEFAULT_SEARCH_COUNT),
    freshness,
    dateAfter,
    dateBefore,
    contents?.highlights ? JSON.stringify(contents.highlights) : undefined,
    contents?.text ? JSON.stringify(contents.text) : undefined,
    contents?.summary ? JSON.stringify(contents.summary) : undefined,
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const results = await runExaSearch({
    apiKey,
    query,
    count: resolveExaSearchCount(count, DEFAULT_SEARCH_COUNT),
    freshness,
    dateAfter,
    dateBefore,
    type,
    contents,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
  });

  const payload = {
    query,
    provider: "exa",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "exa",
      wrapped: true,
    },
    results: results.map((entry) => {
      const title = typeof entry.title === "string" ? entry.title : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      const description = resolveExaDescription(entry);
      const summary = normalizeOptionalString(entry.summary) ?? "";
      const highlightScores = Array.isArray(entry.highlightScores)
        ? entry.highlightScores.filter(
            (score): score is number => typeof score === "number" && Number.isFinite(score),
          )
        : [];
      const published =
        typeof entry.publishedDate === "string" && entry.publishedDate
          ? entry.publishedDate
          : undefined;
      return Object.assign(
        {
          title: title ? wrapWebContent(title, `web_search`) : ``,
          url,
          description: description ? wrapWebContent(description, `web_search`) : ``,
          published,
          siteName: resolveSiteName(url) || undefined,
        },
        summary ? { summary: wrapWebContent(summary, `web_search`) } : {},
        highlightScores.length > 0 ? { highlightScores } : {},
      );
    }),
  };

  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}

export const __testing = {
  normalizeExaResults,
  normalizeExaFreshness,
  parseExaContents,
  resolveExaApiKey,
  resolveExaConfig,
  resolveExaDescription,
  resolveExaSearchCount,
  resolveFreshnessStartDate,
} as const;
