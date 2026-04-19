import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const EXA_CREDENTIAL_PATH = "plugins.entries.exa.config.webSearch.apiKey";
const EXA_SEARCH_TYPES = ["auto", "neural", "fast", "deep", "deep-reasoning", "instant"] as const;
const EXA_FRESHNESS_VALUES = ["day", "week", "month", "year"] as const;
const EXA_MAX_SEARCH_COUNT = 100;

type ExaWebSearchRuntime = typeof import("./exa-web-search-provider.runtime.js");

let exaWebSearchRuntimePromise: Promise<ExaWebSearchRuntime> | undefined;

function loadExaWebSearchRuntime(): Promise<ExaWebSearchRuntime> {
  exaWebSearchRuntimePromise ??= import("./exa-web-search-provider.runtime.js");
  return exaWebSearchRuntimePromise;
}

const ExaSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-100, subject to Exa search-type limits).",
      minimum: 1,
      maximum: EXA_MAX_SEARCH_COUNT,
    },
    freshness: {
      type: "string",
      enum: [...EXA_FRESHNESS_VALUES],
      description: 'Filter by time: "day", "week", "month", or "year".',
    },
    date_after: {
      type: "string",
      description: "Only results published after this date (YYYY-MM-DD).",
    },
    date_before: {
      type: "string",
      description: "Only results published before this date (YYYY-MM-DD).",
    },
    type: {
      type: "string",
      enum: [...EXA_SEARCH_TYPES],
      description:
        'Exa search mode: "auto", "neural", "fast", "deep", "deep-reasoning", or "instant".',
    },
    contents: {
      type: "object",
      properties: {
        highlights: {
          description:
            "Highlights config: true, or an object with maxCharacters, query, numSentences, or highlightsPerUrl.",
        },
        text: {
          description: "Text config: true, or an object with maxCharacters.",
        },
        summary: {
          description: "Summary config: true, or an object with query.",
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createExaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "exa",
    label: "Exa Search",
    hint: "Neural + keyword search with date filters and content extraction",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Exa API key",
    envVars: ["EXA_API_KEY"],
    placeholder: "exa-...",
    signupUrl: "https://exa.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 65,
    credentialPath: EXA_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: EXA_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "exa" },
      configuredCredential: { pluginId: "exa" },
      selectionPluginId: "exa",
    }),
    createTool: (ctx) => ({
      description:
        "Search the web using Exa AI. Supports neural or keyword search, publication date filters, and optional highlights or text extraction.",
      parameters: ExaSearchSchema,
      execute: async (args) => {
        const { executeExaWebSearchProviderTool } = await loadExaWebSearchRuntime();
        return await executeExaWebSearchProviderTool(ctx, args);
      },
    }),
  };
}
