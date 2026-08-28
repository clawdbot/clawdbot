// Tavily helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePositiveTimeoutSeconds } from "openclaw/plugin-sdk/provider-web-search";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { resolveReadOnlyEnvSecretRef } from "openclaw/plugin-sdk/secret-ref-readonly";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
const DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS = 30;
const DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS = 60;
const TAVILY_API_KEY_ENV_VAR = "TAVILY_API_KEY";
const TAVILY_DOCS_URL = "https://docs.openclaw.ai/tools/tavily";

export type TavilyCredentialResolution =
  | { status: "available"; value: string }
  | { status: "missing" }
  | { status: "blocked" };

export type TavilyRequestAuth = { mode: "keyed"; apiKey: string } | { mode: "keyless" };

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

function resolveConfiguredSecret(value: unknown, path: string, cfg?: OpenClawConfig) {
  return resolveReadOnlyEnvSecretRef({
    value,
    path,
    cfg,
    expectedEnvId: TAVILY_API_KEY_ENV_VAR,
    normalizeValue: normalizeSecretInput,
  });
}

export function resolveTavilyCredential(cfg?: OpenClawConfig): TavilyCredentialResolution {
  const search = resolveTavilySearchConfig(cfg);
  const resolved = resolveConfiguredSecret(
    search?.apiKey,
    "plugins.entries.tavily.config.webSearch.apiKey",
    cfg,
  );
  if (resolved.status === "available") {
    return { status: "available", value: resolved.value };
  }
  if (resolved.status === "blocked") {
    return { status: "blocked" };
  }
  const envKey = normalizeSecretInput(process.env.TAVILY_API_KEY);
  return envKey ? { status: "available", value: envKey } : { status: "missing" };
}

export function resolveTavilyApiKey(cfg?: OpenClawConfig): string | undefined {
  const resolved = resolveTavilyCredential(cfg);
  return resolved.status === "available" ? resolved.value : undefined;
}

export function allowsTavilyKeyless(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === new URL(DEFAULT_TAVILY_BASE_URL).origin;
  } catch {
    return false;
  }
}

function tavilyAuthError(surface: "search" | "extract", kind: "blocked" | "custom-base"): Error {
  const who = surface === "search" ? "web_search (tavily)" : "tavily_extract";
  if (kind === "blocked") {
    return new Error(
      `${who} credential is configured but unavailable. Fix plugins.entries.tavily.config.webSearch.apiKey, then retry. Docs: ${TAVILY_DOCS_URL}`,
    );
  }
  return new Error(
    `${who} needs a Tavily API key when using a custom base URL. Set TAVILY_API_KEY in the Gateway environment, or configure plugins.entries.tavily.config.webSearch.apiKey. Docs: ${TAVILY_DOCS_URL}`,
  );
}

export function resolveTavilyRequestAuth(
  cfg: OpenClawConfig | undefined,
  surface: "search" | "extract",
): TavilyRequestAuth {
  const credential = resolveTavilyCredential(cfg);
  if (credential.status === "blocked") {
    throw tavilyAuthError(surface, "blocked");
  }
  if (credential.status === "available") {
    return { mode: "keyed", apiKey: credential.value };
  }
  if (!allowsTavilyKeyless(resolveTavilyBaseUrl(cfg))) {
    throw tavilyAuthError(surface, "custom-base");
  }
  return { mode: "keyless" };
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
