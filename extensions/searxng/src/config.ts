import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";

type SearxngPluginConfig = {
  webSearch?: {
    baseUrl?: unknown;
    categories?: string;
    language?: string;
  };
};

function normalizeConfiguredString(value: unknown, path: string): string | undefined {
  try {
    return normalizeSecretInput(
      normalizeResolvedSecretInputString({
        value,
        path,
      }),
    );
  } catch {
    return undefined;
  }
}

function readInlineEnvSecretRefValue(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as { source?: unknown; id?: unknown };
  if (record.source !== "env" || typeof record.id !== "string") {
    return undefined;
  }
  return normalizeSecretInput(env[record.id]);
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/u, "") || undefined;
}

export function resolveSearxngWebSearchConfig(
  config?: OpenClawConfig,
): SearxngPluginConfig["webSearch"] | undefined {
  const pluginConfig = config?.plugins?.entries?.searxng?.config as SearxngPluginConfig | undefined;
  const webSearch = pluginConfig?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveSearxngBaseUrl(
  config?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const webSearch = resolveSearxngWebSearchConfig(config);
  return (
    normalizeBaseUrl(
      normalizeConfiguredString(
        webSearch?.baseUrl,
        "plugins.entries.searxng.config.webSearch.baseUrl",
      ),
    ) ??
    normalizeBaseUrl(readInlineEnvSecretRefValue(webSearch?.baseUrl, env)) ??
    normalizeBaseUrl(normalizeSecretInput(env.SEARXNG_BASE_URL))
  );
}

export function resolveSearxngCategories(config?: OpenClawConfig): string | undefined {
  return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.categories);
}

export function resolveSearxngLanguage(config?: OpenClawConfig): string | undefined {
  return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.language);
}
