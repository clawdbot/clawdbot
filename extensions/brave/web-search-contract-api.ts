import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLegacyTopLevelBraveCredential(
  config: unknown,
): { path: string; value: unknown } | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const tools = isRecord(config.tools) ? config.tools : undefined;
  const web = isRecord(tools?.web) ? tools.web : undefined;
  const search = isRecord(web?.search) ? web.search : undefined;
  if (!search || !("apiKey" in search)) {
    return undefined;
  }
  return { path: "tools.web.search.apiKey", value: search.apiKey };
}

function resolveProviderWebSearchPluginConfig(
  config: unknown,
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

function resolveConfiguredBraveCredential(config: unknown): unknown {
  return (
    resolveProviderWebSearchPluginConfig(config, "brave")?.apiKey ??
    resolveLegacyTopLevelBraveCredential(config)?.value
  );
}

export function createBraveWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.brave.config.webSearch.apiKey";

  return {
    id: "brave",
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Brave Search API key",
    envVars: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
    docsUrl: "https://docs.openclaw.ai/tools/brave-search",
    autoDetectOrder: 10,
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "brave" },
    }),
    getConfiguredCredentialValue: resolveConfiguredBraveCredential,
    getConfiguredCredentialFallback: resolveLegacyTopLevelBraveCredential,
    createTool: () => null,
  };
}
