// Firecrawl helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePositiveTimeoutSeconds } from "openclaw/plugin-sdk/provider-web-fetch";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { resolveReadOnlyEnvSecretRef } from "openclaw/plugin-sdk/secret-ref-readonly";

export const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_FIRECRAWL_SEARCH_TIMEOUT_SECONDS = 30;
const DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_SECONDS = 60;
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 172_800_000;
const FIRECRAWL_API_KEY_ENV_VAR = "FIRECRAWL_API_KEY";
type FirecrawlOperation = "search" | "fetch";

type FirecrawlSearchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
    }
  | undefined;

type PluginEntryConfig =
  | {
      webSearch?: {
        apiKey?: unknown;
        baseUrl?: string;
      };
      webFetch?: {
        apiKey?: unknown;
        baseUrl?: string;
        onlyMainContent?: boolean;
        maxAgeMs?: number;
        timeoutSeconds?: number;
      };
    }
  | undefined;

type FirecrawlFetchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
      onlyMainContent?: boolean;
      maxAgeMs?: number;
      timeoutSeconds?: number;
    }
  | undefined;

function resolveFirecrawlSearchConfig(cfg?: OpenClawConfig): FirecrawlSearchConfig {
  const pluginConfig = cfg?.plugins?.entries?.firecrawl?.config as PluginEntryConfig;
  const pluginWebSearch = pluginConfig?.webSearch;
  if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) {
    return pluginWebSearch;
  }
  return undefined;
}

function resolveFirecrawlFetchConfig(cfg?: OpenClawConfig): FirecrawlFetchConfig {
  const pluginConfig = cfg?.plugins?.entries?.firecrawl?.config as PluginEntryConfig;
  const pluginWebFetch = pluginConfig?.webFetch;
  if (pluginWebFetch && typeof pluginWebFetch === "object" && !Array.isArray(pluginWebFetch)) {
    return pluginWebFetch;
  }
  return undefined;
}

function resolveConfiguredSecret(value: unknown, path: string, cfg?: OpenClawConfig) {
  return resolveReadOnlyEnvSecretRef({
    value,
    path,
    cfg,
    expectedEnvId: FIRECRAWL_API_KEY_ENV_VAR,
    normalizeValue: normalizeSecretInput,
  });
}

export function resolveFirecrawlApiKey(
  cfg: OpenClawConfig | undefined,
  operation: FirecrawlOperation,
): string | undefined {
  const pluginConfig = cfg?.plugins?.entries?.firecrawl?.config as PluginEntryConfig;
  const search = resolveFirecrawlSearchConfig(cfg);
  const searchCandidate = {
    value: search?.apiKey,
    path: "plugins.entries.firecrawl.config.webSearch.apiKey",
  };
  const fetchCandidate = {
    value: pluginConfig?.webFetch?.apiKey,
    path: "plugins.entries.firecrawl.config.webFetch.apiKey",
  };
  const configuredCandidates =
    operation === "search" ? [searchCandidate, fetchCandidate] : [fetchCandidate, searchCandidate];
  let blockedConfiguredSecret = false;
  for (const candidate of configuredCandidates) {
    const resolved = resolveConfiguredSecret(candidate.value, candidate.path, cfg);
    if (resolved.status === "available") {
      return resolved.value;
    }
    if (resolved.status === "blocked") {
      blockedConfiguredSecret = true;
    }
  }
  if (blockedConfiguredSecret) {
    return undefined;
  }
  return normalizeSecretInput(process.env[FIRECRAWL_API_KEY_ENV_VAR]) || undefined;
}

export function resolveFirecrawlBaseUrl(
  cfg: OpenClawConfig | undefined,
  operation: FirecrawlOperation,
): string {
  const search = resolveFirecrawlSearchConfig(cfg);
  const fetch = resolveFirecrawlFetchConfig(cfg);
  const searchBaseUrl = typeof search?.baseUrl === "string" ? search.baseUrl.trim() : "";
  const fetchBaseUrl = typeof fetch?.baseUrl === "string" ? fetch.baseUrl.trim() : "";
  const configured =
    (operation === "search" ? searchBaseUrl || fetchBaseUrl : fetchBaseUrl || searchBaseUrl) ||
    normalizeSecretInput(process.env.FIRECRAWL_BASE_URL) ||
    "";
  return configured || DEFAULT_FIRECRAWL_BASE_URL;
}

export function resolveFirecrawlOnlyMainContent(cfg?: OpenClawConfig, override?: boolean): boolean {
  if (typeof override === "boolean") {
    return override;
  }
  const fetch = resolveFirecrawlFetchConfig(cfg);
  if (typeof fetch?.onlyMainContent === "boolean") {
    return fetch.onlyMainContent;
  }
  return true;
}

export function resolveFirecrawlMaxAgeMs(cfg?: OpenClawConfig, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const fetch = resolveFirecrawlFetchConfig(cfg);
  if (
    typeof fetch?.maxAgeMs === "number" &&
    Number.isFinite(fetch.maxAgeMs) &&
    fetch.maxAgeMs >= 0
  ) {
    return Math.floor(fetch.maxAgeMs);
  }
  return DEFAULT_FIRECRAWL_MAX_AGE_MS;
}

export function resolveFirecrawlScrapeTimeoutSeconds(
  cfg?: OpenClawConfig,
  override?: number,
): number {
  const fetch = resolveFirecrawlFetchConfig(cfg);
  return resolvePositiveTimeoutSeconds(
    override,
    resolvePositiveTimeoutSeconds(fetch?.timeoutSeconds, DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_SECONDS),
  );
}

export function resolveFirecrawlSearchTimeoutSeconds(override?: number): number {
  return resolvePositiveTimeoutSeconds(override, DEFAULT_FIRECRAWL_SEARCH_TIMEOUT_SECONDS);
}
