import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Firecrawl provider module implements model/runtime integration.
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import {
  createWebSearchProviderContractFields,
  enablePluginInConfig,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const FIRECRAWL_CREDENTIAL_PATH = "plugins.entries.firecrawl.config.webSearch.apiKey";

const loadFirecrawlClientModule = createLazyRuntimeModule(() => import("./firecrawl-client.js"));

const GenericFirecrawlSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

function getConfiguredFirecrawlFetchCredentialFallback(config?: {
  plugins?: { entries?: { firecrawl?: { config?: unknown } } };
}) {
  const pluginConfig = asOptionalRecord(config?.plugins?.entries?.firecrawl?.config);
  const value = asOptionalRecord(pluginConfig?.webFetch)?.apiKey;
  return value === undefined
    ? undefined
    : {
        path: "plugins.entries.firecrawl.config.webFetch.apiKey",
        value,
      };
}

function createFirecrawlSearchProvider(keyless: boolean): WebSearchProviderPlugin {
  const id = keyless ? "firecrawl-free" : "firecrawl";
  const credentialPath = keyless ? "" : FIRECRAWL_CREDENTIAL_PATH;

  return {
    id,
    label: keyless ? "Firecrawl Search (Free)" : "Firecrawl Search",
    hint: keyless
      ? "Free web search via Firecrawl's hosted starter tier — no API key required"
      : "Structured results with optional result scraping",
    onboardingScopes: ["text-inference"],
    ...(keyless
      ? {
          requiresCredential: false,
          envVars: [],
          placeholder: "(no key needed)",
        }
      : {
          credentialLabel: "Firecrawl API key",
          envVars: ["FIRECRAWL_API_KEY"],
          placeholder: "fc-...",
        }),
    signupUrl: "https://www.firecrawl.dev/",
    docsUrl: "https://docs.openclaw.ai/tools/firecrawl",
    ...(keyless ? {} : { autoDetectOrder: 60 }),
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "scoped", scopeId: id },
      ...(keyless
        ? { selectionPluginId: "firecrawl" }
        : { configuredCredential: { pluginId: "firecrawl" } }),
    }),
    ...(keyless
      ? {}
      : {
          applySelectionConfig: (config) => {
            const enabled = enablePluginInConfig(config, "firecrawl");
            if (!enabled.enabled || enabled.config.tools?.web?.fetch?.provider) {
              return enabled.config;
            }
            return {
              ...enabled.config,
              tools: {
                ...enabled.config.tools,
                web: {
                  ...enabled.config.tools?.web,
                  fetch: {
                    ...enabled.config.tools?.web?.fetch,
                    provider: "firecrawl",
                  },
                },
              },
            };
          },
          getConfiguredCredentialFallback: getConfiguredFirecrawlFetchCredentialFallback,
        }),
    createTool: (ctx) => ({
      description: keyless
        ? "Search the web using Firecrawl's free hosted starter tier (no API key required). Returns structured results with snippets. Use firecrawl_search for Firecrawl-specific knobs like sources or categories."
        : "Search the web using Firecrawl. Returns structured results with snippets from Firecrawl Search. Use firecrawl_search for Firecrawl-specific knobs like sources or categories.",
      parameters: GenericFirecrawlSearchSchema,
      execute: async (args, executionContext) => {
        executionContext?.signal?.throwIfAborted();
        const { runFirecrawlSearch } = await loadFirecrawlClientModule();
        return await runFirecrawlSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: readPositiveIntegerParam(args, "count", {
            message: "count must be an integer from 1 to 10",
            max: 10,
          }),
          ...(keyless ? { access: "keyless" as const } : {}),
          ...(executionContext?.signal ? { signal: executionContext.signal } : {}),
        });
      },
    }),
  };
}

export function createFirecrawlWebSearchProvider(): WebSearchProviderPlugin {
  return createFirecrawlSearchProvider(false);
}

export function createFirecrawlFreeWebSearchProvider(): WebSearchProviderPlugin {
  return createFirecrawlSearchProvider(true);
}
