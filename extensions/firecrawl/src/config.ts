// Firecrawl helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/extension-shared";
import { resolvePositiveTimeoutSeconds } from "openclaw/plugin-sdk/provider-web-fetch";
import { resolveSecretInputString, normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";

export const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_FIRECRAWL_SEARCH_TIMEOUT_SECONDS = 30;
const DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_SECONDS = 60;
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 172_800_000;
const FIRECRAWL_API_KEY_ENV_VAR = "FIRECRAWL_API_KEY";

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

type ConfiguredSecretResolution =
  | { status: "available"; value: string }
  | { status: "missing" }
  | { status: "blocked" };

function resolveConfiguredSecret(
  value: unknown,
  path: string,
  cfg?: OpenClawConfig,
): ConfiguredSecretResolution {
  const resolved = resolveSecretInputString({
    value,
    path,
    defaults: cfg?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    const normalized = normalizeSecretInput(resolved.value);
    return normalized ? { status: "available", value: normalized } : { status: "missing" };
  }
  if (resolved.status === "missing") {
    return { status: "missing" };
  }
  if (resolved.ref.source !== "env") {
    return { status: "blocked" };
  }
  const envVarName = resolved.ref.id.trim();
  if (envVarName !== FIRECRAWL_API_KEY_ENV_VAR) {
    return { status: "blocked" };
  }
  if (
    !canResolveEnvSecretRefInReadOnlyPath({
      cfg,
      provider: resolved.ref.provider,
      id: envVarName,
    })
  ) {
    return { status: "blocked" };
  }
  const envValue = normalizeSecretInput(process.env[envVarName]);
  return envValue ? { status: "available", value: envValue } : { status: "missing" };
}

export function resolveFirecrawlApiKey(cfg?: OpenClawConfig): string | undefined {
  const pluginConfig = cfg?.plugins?.entries?.firecrawl?.config as PluginEntryConfig;
  const search = resolveFirecrawlSearchConfig(cfg);
  const configuredCandidates: Array<{ value: unknown; path: string }> = [
    {
      value: pluginConfig?.webFetch?.apiKey,
      path: "plugins.entries.firecrawl.config.webFetch.apiKey",
    },
    {
      value: search?.apiKey,
      path: "plugins.entries.firecrawl.config.webSearch.apiKey",
    },
  ];
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

export function resolveFirecrawlBaseUrl(cfg?: OpenClawConfig): string {
  const search = resolveFirecrawlSearchConfig(cfg);
  const fetch = resolveFirecrawlFetchConfig(cfg);
  const configured =
    (typeof search?.baseUrl === "string" ? search.baseUrl.trim() : "") ||
    (typeof fetch?.baseUrl === "string" ? fetch.baseUrl.trim() : "") ||
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
