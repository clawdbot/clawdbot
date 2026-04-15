import { Type } from "@sinclair/typebox";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  formatCliCommand,
  getScopedCredentialValue,
  mergeScopedSearchConfig,
  normalizeCacheKey,
  readCache,
  readNumberParam,
  readStringParam,
  resolveCacheTtlMs,
  resolveProviderWebSearchPluginConfig,
  resolveTimeoutSeconds,
  resolveWebSearchProviderCredential,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  type WebSearchProviderSetupContext,
  type WebSearchProviderPlugin,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  requestXaiWebSearch,
  resolveXaiInlineCitations,
  resolveXaiWebSearchModel,
} from "./src/web-search-shared.js";
import {
  resolveEffectiveXSearchConfig,
  setPluginXSearchConfigValue,
} from "./src/x-search-config.js";
import { XAI_DEFAULT_X_SEARCH_MODEL } from "./src/x-search-shared.js";

const XAI_WEB_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

const X_SEARCH_MODEL_OPTIONS = [
  {
    value: XAI_DEFAULT_X_SEARCH_MODEL,
    label: XAI_DEFAULT_X_SEARCH_MODEL,
    hint: "default · fast, no reasoning",
  },
  {
    value: "grok-4-1-fast",
    label: "grok-4-1-fast",
    hint: "fast with reasoning",
  },
] as const;

function resolveXSearchConfigRecord(
  config?: WebSearchProviderSetupContext["config"],
): Record<string, unknown> | undefined {
  return resolveEffectiveXSearchConfig(config);
}

async function runXaiSearchProviderSetup(
  ctx: WebSearchProviderSetupContext,
): Promise<WebSearchProviderSetupContext["config"]> {
  const existingXSearch = resolveXSearchConfigRecord(ctx.config);
  if (existingXSearch?.enabled === false) {
    return ctx.config;
  }

  await ctx.prompter.note(
    [
      "x_search lets your agent search X (formerly Twitter) posts via xAI.",
      "It reuses the same xAI API key you just configured for Grok web search.",
      `You can change this later with ${formatCliCommand("openclaw configure --section web")}.`,
    ].join("\n"),
    "X search",
  );

  const enableChoice = await ctx.prompter.select<"yes" | "skip">({
    message: "Enable x_search too?",
    options: [
      {
        value: "yes",
        label: "Yes, enable x_search",
        hint: "Search X posts with the same xAI key",
      },
      {
        value: "skip",
        label: "Skip for now",
        hint: "Keep Grok web_search only",
      },
    ],
    initialValue: existingXSearch?.enabled === true || ctx.quickstartDefaults ? "yes" : "skip",
  });

  if (enableChoice === "skip") {
    return ctx.config;
  }

  const existingModel =
    typeof existingXSearch?.model === "string" && existingXSearch.model.trim()
      ? existingXSearch.model.trim()
      : "";
  const knownModel = X_SEARCH_MODEL_OPTIONS.find((entry) => entry.value === existingModel)?.value;
  const modelPick = await ctx.prompter.select<string>({
    message: "Grok model for x_search",
    options: [
      ...X_SEARCH_MODEL_OPTIONS,
      { value: "__custom__", label: "Enter custom model name", hint: "" },
    ],
    initialValue: knownModel ?? XAI_DEFAULT_X_SEARCH_MODEL,
  });

  let model = modelPick;
  if (modelPick === "__custom__") {
    const customModel = await ctx.prompter.text({
      message: "Custom Grok model name",
      initialValue: existingModel || XAI_DEFAULT_X_SEARCH_MODEL,
      placeholder: XAI_DEFAULT_X_SEARCH_MODEL,
    });
    model = customModel.trim() || XAI_DEFAULT_X_SEARCH_MODEL;
  }

  const next = structuredClone(ctx.config);
  setPluginXSearchConfigValue(next, "enabled", true);
  setPluginXSearchConfigValue(next, "model", model || XAI_DEFAULT_X_SEARCH_MODEL);
  return next;
}

function runXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `grok:${params.model}:${String(params.inlineCitations)}:${params.query}`,
  );
  const cached = readCache(XAI_WEB_SEARCH_CACHE, cacheKey);
  if (cached) {
    return Promise.resolve({ ...cached.value, cached: true });
  }

  return (async () => {
    const startedAt = Date.now();
    const result = await requestXaiWebSearch({
      query: params.query,
      model: params.model,
      apiKey: params.apiKey,
      timeoutSeconds: params.timeoutSeconds,
      inlineCitations: params.inlineCitations,
    });
    const payload = buildXaiWebSearchPayload({
      query: params.query,
      provider: "grok",
      model: params.model,
      tookMs: Date.now() - startedAt,
      content: result.content,
      citations: result.citations,
      inlineCitations: result.inlineCitations,
    });

    writeCache(XAI_WEB_SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  })();
}

function resolveXaiToolSearchConfig(ctx: {
  config?: Record<string, unknown>;
  searchConfig?: Record<string, unknown>;
}) {
  return mergeScopedSearchConfig(
    ctx.searchConfig,
    "grok",
    resolveProviderWebSearchPluginConfig(ctx.config, "xai"),
  );
}

function resolveXaiWebSearchCredential(searchConfig?: Record<string, unknown>): string | undefined {
  return resolveWebSearchProviderCredential({
    credentialValue: getScopedCredentialValue(searchConfig, "grok"),
    path: "tools.web.search.grok.apiKey",
    envVars: ["XAI_API_KEY"],
  });
}

export function createXaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "grok",
    label: "Grok (xAI)",
    hint: "Requires xAI API key · xAI web-grounded responses",
    onboardingScopes: ["text-inference"],
    credentialLabel: "xAI API key",
    envVars: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 30,
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.xai.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig?: Record<string, unknown>) =>
      getScopedCredentialValue(searchConfig, "grok"),
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) =>
      setScopedCredentialValue(searchConfigTarget, "grok", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "xai")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "xai", "apiKey", value);
    },
    runSetup: runXaiSearchProviderSetup,
    createTool: (ctx) => {
      const searchConfig = resolveXaiToolSearchConfig(ctx);
      return {
        description:
          "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query string." }),
          count: Type.Optional(
            Type.Number({
              description: "Number of results to return (1-10).",
              minimum: 1,
              maximum: 10,
            }),
          ),
        }),
        execute: async (args: Record<string, unknown>) => {
          const apiKey = resolveXaiWebSearchCredential(searchConfig);

          if (!apiKey) {
            return {
              error: "missing_xai_api_key",
              message:
                "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
              docs: "https://docs.openclaw.ai/tools/web",
            };
          }

          const query = readStringParam(args, "query", { required: true });
          void readNumberParam(args, "count", { integer: true });

          return await runXaiWebSearch({
            query,
            model: resolveXaiWebSearchModel(searchConfig),
            apiKey,
            timeoutSeconds: resolveTimeoutSeconds(
              searchConfig?.timeoutSeconds,
              DEFAULT_TIMEOUT_SECONDS,
            ),
            inlineCitations: resolveXaiInlineCitations(searchConfig),
            cacheTtlMs: resolveCacheTtlMs(searchConfig?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
          });
        },
      };
    },
  };
}

export const __testing = {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  resolveXaiToolSearchConfig,
  resolveXaiInlineCitations,
  resolveXaiWebSearchCredential,
  resolveXaiWebSearchModel,
  requestXaiWebSearch,
};
