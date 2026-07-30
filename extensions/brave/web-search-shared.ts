/**
 * Shared Brave Search provider metadata and credential lookup. Contract tests
 * and runtime provider creation both use this lightweight descriptor.
 */
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Canonical config path for the Brave Search API key. */
const BRAVE_CREDENTIAL_PATH = "plugins.entries.brave.config.webSearch.apiKey";

function resolveBraveWebSearchPluginConfig(config: unknown): Record<string, unknown> | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const plugins = isRecord(config.plugins) ? config.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const entry = isRecord(entries?.brave) ? entries.brave : undefined;
  const pluginConfig = isRecord(entry?.config) ? entry.config : undefined;
  return isRecord(pluginConfig?.webSearch) ? pluginConfig.webSearch : undefined;
}

/** Resolve Brave credentials from current plugin config. */
function resolveConfiguredBraveCredential(config: unknown): unknown {
  return resolveBraveWebSearchPluginConfig(config)?.apiKey;
}

/** Build the common Brave provider metadata without the runtime tool executor. */
export function buildBraveWebSearchProviderBase(): Omit<WebSearchProviderPlugin, "createTool"> {
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
    credentialPath: BRAVE_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: BRAVE_CREDENTIAL_PATH,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "brave" },
    }),
    getConfiguredCredentialValue: resolveConfiguredBraveCredential,
  };
}
