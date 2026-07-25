// Tavily helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/extension-shared";
import { resolvePositiveTimeoutSeconds } from "openclaw/plugin-sdk/provider-web-search";
import { resolveSecretInputString, normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
const DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS = 30;
const DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS = 60;
const TAVILY_API_KEY_ENV_VAR = "TAVILY_API_KEY";

type TavilySearchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
    }
  | undefined;

type PluginEntryConfig = {
  webSearch?: {
    apiKey?: unknown;
    baseUrl?: string;
  };
};

function resolveTavilySearchConfig(cfg?: OpenClawConfig): TavilySearchConfig {
  const pluginConfig = cfg?.plugins?.entries?.tavily?.config as PluginEntryConfig;
  const pluginWebSearch = pluginConfig?.webSearch;
  if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) {
    return pluginWebSearch;
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
  // Explicit unavailable refs must not silently borrow an unrelated ambient credential.
  if (resolved.ref.source !== "env") {
    return { status: "blocked" };
  }
  const envVarName = resolved.ref.id.trim();
  if (envVarName !== TAVILY_API_KEY_ENV_VAR) {
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

export function resolveTavilyApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = resolveTavilySearchConfig(cfg);
  const resolved = resolveConfiguredSecret(
    search?.apiKey,
    "plugins.entries.tavily.config.webSearch.apiKey",
    cfg,
  );
  if (resolved.status === "available") {
    return resolved.value;
  }
  if (resolved.status === "blocked") {
    return undefined;
  }
  return normalizeSecretInput(process.env.TAVILY_API_KEY) || undefined;
}

export function resolveTavilyBaseUrl(cfg?: OpenClawConfig): string {
  const search = resolveTavilySearchConfig(cfg);
  const configured =
    (normalizeOptionalString(search?.baseUrl) ?? "") ||
    normalizeSecretInput(process.env.TAVILY_BASE_URL) ||
    "";
  return configured || DEFAULT_TAVILY_BASE_URL;
}

export function resolveTavilySearchTimeoutSeconds(override?: number): number {
  return resolvePositiveTimeoutSeconds(override, DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS);
}

export function resolveTavilyExtractTimeoutSeconds(override?: number): number {
  return resolvePositiveTimeoutSeconds(override, DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS);
}
