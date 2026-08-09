/**
 * Shared Z.AI Web Search provider metadata and credential lookup. Contract
 * tests and runtime provider creation both use this lightweight descriptor.
 */
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Canonical config path for the Z.AI API key. */
const ZAI_CREDENTIAL_PATH = "plugins.entries.zai-search.config.webSearch.apiKey";

function resolveZaiWebSearchPluginConfig(
  config: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const plugins = isRecord(config.plugins) ? config.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const entry = isRecord(entries?.["zai-search"]) ? entries["zai-search"] : undefined;
  const pluginConfig = isRecord(entry?.config) ? entry.config : undefined;
  return isRecord(pluginConfig?.webSearch) ? pluginConfig.webSearch : undefined;
}

/** Resolve Z.AI credentials from current plugin config. */
function resolveConfiguredZaiCredential(config: unknown): unknown {
  return resolveZaiWebSearchPluginConfig(config)?.apiKey;
}

/** Build the common Z.AI provider metadata without the runtime tool executor. */
export function buildZaiWebSearchProviderBase(): Omit<
  WebSearchProviderPlugin,
  "createTool"
> {
  return {
    id: "zai-search",
    label: "Z.AI Web Search",
    hint: "MCP web_search_prime · GLM Coding Plan included",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Z.AI API key",
    envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    placeholder: "zai-...",
    signupUrl: "https://z.ai/",
    docsUrl: "https://docs.z.ai/api-reference/tools/web-search",
    autoDetectOrder: 20,
    credentialPath: ZAI_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: ZAI_CREDENTIAL_PATH,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "zai-search" },
    }),
    getConfiguredCredentialValue: resolveConfiguredZaiCredential,
  };
}

export { ZAI_CREDENTIAL_PATH };
