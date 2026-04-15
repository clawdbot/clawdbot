import type {
  SearchConfigRecord,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";
import { isRecord } from "openclaw/plugin-sdk/text-runtime";
import {
  createBraveSchema,
  mapBraveLlmContextResults,
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
  resolveBraveConfig,
  resolveBraveMode,
} from "./brave-web-search-provider.shared.js";

type ConfigInput = Parameters<
  NonNullable<WebSearchProviderPlugin["getConfiguredCredentialValue"]>
>[0];
type ConfigTarget = Parameters<
  NonNullable<WebSearchProviderPlugin["setConfiguredCredentialValue"]>
>[0];

function resolveProviderWebSearchPluginConfig(
  config: ConfigInput,
  pluginId: string,
): Record<string, unknown> | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const plugins = isRecord(config.plugins) ? config.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const entry = isRecord(entries?.[pluginId]) ? entries[pluginId] : undefined;
  const pluginConfig = isRecord(entry?.config) ? entry.config : undefined;
  return isRecord(pluginConfig?.webSearch) ? pluginConfig.webSearch : undefined;
}

function ensureObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function setProviderWebSearchPluginConfigValue(
  configTarget: ConfigTarget,
  pluginId: string,
  key: string,
  value: unknown,
): void {
  const plugins = ensureObject(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureObject(plugins, "entries");
  const entry = ensureObject(entries, pluginId);
  if (entry.enabled === undefined) {
    entry.enabled = true;
  }
  const config = ensureObject(entry, "config");
  const webSearch = ensureObject(config, "webSearch");
  webSearch[key] = value;
}

function setTopLevelCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  value: unknown,
): void {
  searchConfigTarget.apiKey = value;
}

function mergeScopedSearchConfig(
  searchConfig: Record<string, unknown> | undefined,
  key: string,
  pluginConfig: Record<string, unknown> | undefined,
  options?: { mirrorApiKeyToTopLevel?: boolean },
): Record<string, unknown> | undefined {
  if (!pluginConfig) {
    return searchConfig;
  }

  const currentScoped = isRecord(searchConfig?.[key]) ? searchConfig?.[key] : {};
  const next: Record<string, unknown> = {
    ...searchConfig,
    [key]: {
      ...currentScoped,
      ...pluginConfig,
    },
  };

  if (options?.mirrorApiKeyToTopLevel && pluginConfig.apiKey !== undefined) {
    next.apiKey = pluginConfig.apiKey;
  }

  return next;
}

function createBraveToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  const braveMode = resolveBraveMode(resolveBraveConfig(searchConfig));

  return {
    description:
      braveMode === "llm-context"
        ? "Search the web using Brave Search LLM Context API. Returns pre-extracted page content (text chunks, tables, code blocks) optimized for LLM grounding."
        : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.",
    parameters: createBraveSchema(),
    execute: async (args) => {
      const { executeBraveSearch } = await import("./brave-web-search-provider.runtime.js");
      return await executeBraveSearch(args, searchConfig);
    },
  };
}

export function createBraveWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "brave",
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Brave Search API key",
    envVars: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
    docsUrl: "https://docs.openclaw.ai/brave-search",
    autoDetectOrder: 10,
    credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.brave.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => searchConfig?.apiKey,
    setCredentialValue: setTopLevelCredentialValue,
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "brave")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "brave", "apiKey", value);
    },
    createTool: (ctx) =>
      createBraveToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          "brave",
          resolveProviderWebSearchPluginConfig(ctx.config, "brave"),
          { mirrorApiKeyToTopLevel: true },
        ),
      ),
  };
}

export const __testing = {
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
  resolveBraveMode,
  mapBraveLlmContextResults,
} as const;
