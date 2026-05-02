import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";

type WebGuardedFetchModule = Pick<
  typeof import("./web-guarded-fetch.js"),
  "withSelfHostedWebToolsEndpoint" | "withTrustedWebToolsEndpoint"
>;

let webGuardedFetchPromise: Promise<WebGuardedFetchModule> | null = null;

async function loadTrustedWebToolsEndpoint(): Promise<
  WebGuardedFetchModule["withTrustedWebToolsEndpoint"]
> {
  webGuardedFetchPromise ??= import("./web-guarded-fetch.js");
  return (await webGuardedFetchPromise).withTrustedWebToolsEndpoint;
}

async function loadSelfHostedWebToolsEndpoint(): Promise<
  WebGuardedFetchModule["withSelfHostedWebToolsEndpoint"]
> {
  webGuardedFetchPromise ??= import("./web-guarded-fetch.js");
  return (await webGuardedFetchPromise).withSelfHostedWebToolsEndpoint;
}

export type SearchConfigRecord = (NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : never
  : never) &
  Record<string, unknown>;

type UnsupportedWebSearchFilterName =
  | "country"
  | "language"
  | "freshness"
  | "date_after"
  | "date_before";

export const DEFAULT_SEARCH_COUNT = 5;
export const MAX_SEARCH_COUNT = 10;
export const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

export function resolveSearchTimeoutSeconds(searchConfig?: SearchConfigRecord): number {
  return resolveTimeoutSeconds(searchConfig?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
}

export function resolveSearchCacheTtlMs(searchConfig?: SearchConfigRecord): number {
  return resolveCacheTtlMs(searchConfig?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
}

export function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

export function readConfiguredSecretString(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(normalizeResolvedSecretInputString({ value, path })) || undefined;
}

export function readProviderEnvValue(envVars: string[]): string | undefined {
  for (const envVar of envVars) {
    const value = normalizeSecretInput(process.env[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export async function withTrustedWebSearchEndpoint<T>(
  params: {
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
    signal?: AbortSignal;
  },
  run: (response: Response) => Promise<T>,
): Promise<T> {
  const withTrustedWebToolsEndpoint = await loadTrustedWebToolsEndpoint();
  return withTrustedWebToolsEndpoint(
    {
      url: params.url,
      init: params.init,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
    },
    async ({ response }) => run(response),
  );
}

export async function withSelfHostedWebSearchEndpoint<T>(
  params: {
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
    signal?: AbortSignal;
  },
  run: (response: Response) => Promise<T>,
): Promise<T> {
  const withSelfHostedWebToolsEndpoint = await loadSelfHostedWebToolsEndpoint();
  return withSelfHostedWebToolsEndpoint(
    {
      url: params.url,
      init: params.init,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
    },
    async ({ response }) => run(response),
  );
}

export async function postTrustedWebToolsJson<T>(
  params: {
    url: string;
    timeoutSeconds: number;
    apiKey: string;
    body: Record<string, unknown>;
    errorLabel: string;
    maxErrorBytes?: number;
    extraHeaders?: Record<string, string>;
    signal?: AbortSignal;
  },
  parseResponse: (response: Response) => Promise<T>,
): Promise<T> {
  const withTrustedWebToolsEndpoint = await loadTrustedWebToolsEndpoint();
  return withTrustedWebToolsEndpoint(
    {
      url: params.url,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "POST",
        headers: {
          ...params.extraHeaders,
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params.body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const detail = await readResponseText(response, {
          maxBytes: params.maxErrorBytes ?? 64_000,
        });
        throw new Error(
          `${params.errorLabel} API error (${response.status}): ${detail.text || response.statusText}`,
        );
      }
      return await parseResponse(response);
    },
  );
}

export async function throwWebSearchApiError(res: Response, providerLabel: string): Promise<never> {
  const detailResult = await readResponseText(res, { maxBytes: 64_000 });
  const detail = detailResult.text;
  throw new Error(`${providerLabel} API error (${res.status}): ${detail || res.statusText}`);
}

export function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const PERPLEXITY_RECENCY_VALUES = new Set(["day", "week", "month", "year"]);

export const FRESHNESS_TO_RECENCY: Record<string, string> = {
  pd: "day",
  pw: "week",
  pm: "month",
  py: "year",
};
const RECENCY_TO_FRESHNESS: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERPLEXITY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isoToPerplexityDate(iso: string): string | undefined {
  const match = iso.match(ISO_DATE_PATTERN);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}/${year}`;
}

export function normalizeToIsoDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (ISO_DATE_PATTERN.test(trimmed)) {
    return isValidIsoDate(trimmed) ? trimmed : undefined;
  }
  const match = trimmed.match(PERPLEXITY_DATE_PATTERN);
  if (match) {
    const [, month, day, year] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return isValidIsoDate(iso) ? iso : undefined;
  }
  return undefined;
}

export function parseIsoDateRange(params: {
  rawDateAfter?: string;
  rawDateBefore?: string;
  invalidDateAfterMessage: string;
  invalidDateBeforeMessage: string;
  invalidDateRangeMessage: string;
  docs?: string;
}):
  | { dateAfter?: string; dateBefore?: string }
  | {
      error: "invalid_date" | "invalid_date_range";
      message: string;
      docs: string;
    } {
  const docs = params.docs ?? "https://docs.openclaw.ai/tools/web";
  const dateAfter = params.rawDateAfter ? normalizeToIsoDate(params.rawDateAfter) : undefined;
  if (params.rawDateAfter && !dateAfter) {
    return {
      error: "invalid_date",
      message: params.invalidDateAfterMessage,
      docs,
    };
  }

  const dateBefore = params.rawDateBefore ? normalizeToIsoDate(params.rawDateBefore) : undefined;
  if (params.rawDateBefore && !dateBefore) {
    return {
      error: "invalid_date",
      message: params.invalidDateBeforeMessage,
      docs,
    };
  }

  if (dateAfter && dateBefore && dateAfter > dateBefore) {
    return {
      error: "invalid_date_range",
      message: params.invalidDateRangeMessage,
      docs,
    };
  }

  return { dateAfter, dateBefore };
}

export function normalizeFreshness(
  value: string | undefined,
  provider: "brave" | "perplexity",
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return provider === "brave" ? lower : FRESHNESS_TO_RECENCY[lower];
  }
  if (PERPLEXITY_RECENCY_VALUES.has(lower)) {
    return provider === "perplexity" ? lower : RECENCY_TO_FRESHNESS[lower];
  }
  if (provider === "brave") {
    const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
    if (match) {
      const [, start, end] = match;
      if (isValidIsoDate(start) && isValidIsoDate(end) && start <= end) {
        return `${start}to${end}`;
      }
    }
  }

  return undefined;
}

export function readCachedSearchPayload(cacheKey: string): Record<string, unknown> | undefined {
  const cached = readCache(SEARCH_CACHE, cacheKey);
  return cached ? { ...cached.value, cached: true } : undefined;
}

export function buildSearchCacheKey(parts: Array<string | number | boolean | undefined>): string {
  return normalizeCacheKey(
    parts.map((part) => (part === undefined ? "default" : String(part))).join(":"),
  );
}

export function writeCachedSearchPayload(
  cacheKey: string,
  payload: Record<string, unknown>,
  ttlMs: number,
): void {
  writeCache(SEARCH_CACHE, cacheKey, payload, ttlMs);
}

function readUnsupportedSearchFilter(
  params: Record<string, unknown>,
): UnsupportedWebSearchFilterName | undefined {
  for (const name of ["country", "language", "freshness", "date_after", "date_before"] as const) {
    const value = params[name];
    if (typeof value === "string" && value.trim()) {
      return name;
    }
  }

  return undefined;
}

function describeUnsupportedSearchFilter(name: UnsupportedWebSearchFilterName): string {
  switch (name) {
    case "country":
      return "country filtering";
    case "language":
      return "language filtering";
    case "freshness":
      return "freshness filtering";
    case "date_after":
    case "date_before":
      return "date_after/date_before filtering";
  }
  throw new Error("Unsupported web search filter");
}

export function buildUnsupportedSearchFilterResponse(
  params: Record<string, unknown>,
  provider: string,
  docs = "https://docs.openclaw.ai/tools/web",
):
  | {
      error: string;
      message: string;
      docs: string;
    }
  | undefined {
  const unsupported = readUnsupportedSearchFilter(params);
  if (!unsupported) {
    return undefined;
  }

  const label = describeUnsupportedSearchFilter(unsupported);
  const supportedLabel =
    unsupported === "date_after" || unsupported === "date_before" ? "date filtering" : label;

  return {
    error: unsupported.startsWith("date_")
      ? "unsupported_date_filter"
      : `unsupported_${unsupported}`,
    message: `${label} is not supported by the ${provider} provider. Only Brave and Perplexity support ${supportedLabel}.`,
    docs,
  };
}
