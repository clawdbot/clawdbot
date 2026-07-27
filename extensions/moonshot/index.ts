// Moonshot plugin entrypoint registers its OpenClaw integration.
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildOpenAICompatibleReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { applyMoonshotNativeStreamingUsageCompat } from "./api.js";
import { moonshotMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyMoonshotConfig, applyMoonshotConfigCn } from "./onboard.js";
import {
  buildMoonshotProvider,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./provider-catalog.js";
import { isMoonshotAlwaysThinkingModelId, resolveThinkingProfile } from "./provider-policy-api.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const PROVIDER_ID = "moonshot";
const CANONICAL_MOONSHOT_CATALOG_BASE_URLS = new Set([MOONSHOT_BASE_URL, MOONSHOT_CN_BASE_URL]);
const moonshotThinkingStreamHooks = buildProviderStreamFamilyHooks("moonshot-thinking");

function usesCanonicalMoonshotCatalogBaseUrl(baseUrl: string): boolean {
  return CANONICAL_MOONSHOT_CATALOG_BASE_URLS.has(baseUrl.trim().replace(/\/+$/, ""));
}

async function resolveMoonshotCatalog(ctx: ProviderCatalogContext) {
  const result = await buildSingleProviderApiKeyCatalog({
    ctx,
    providerId: PROVIDER_ID,
    buildProvider: buildMoonshotProvider,
    allowExplicitBaseUrl: true,
  });
  if (!result || !("provider" in result)) {
    return result;
  }
  const auth = ctx.resolveProviderApiKey(PROVIDER_ID);
  return {
    provider: await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: PROVIDER_ID,
      providerConfig: result.provider,
      apiKey: auth.apiKey,
      discoveryApiKey: auth.discoveryApiKey,
      ...(usesCanonicalMoonshotCatalogBaseUrl(result.provider.baseUrl)
        ? {
            fetchGuard: (params) =>
              fetchWithSsrFGuard(
                withTrustedEnvProxyGuardedFetchMode({ ...params, requireHttps: true }),
              ),
          }
        : {}),
    }),
  };
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  description: "Bundled Moonshot provider plugin",
  provider: {
    label: "Moonshot",
    docsPath: "/providers/moonshot",
    aliases: ["moonshotai", "moonshot-ai"],
    auth: [
      {
        methodId: "api-key",
        label: "Kimi API key (.ai)",
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfig(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi)",
        },
      },
      {
        methodId: "api-key-cn",
        label: "Kimi API key (.cn)",
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key (.cn)",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfigCn(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi)",
        },
      },
    ],
    catalog: {
      order: "simple",
      run: resolveMoonshotCatalog,
      staticRun: async () => ({ provider: buildMoonshotProvider() }),
    },
    applyNativeStreamingUsageCompat: ({ providerConfig }) =>
      applyMoonshotNativeStreamingUsageCompat(providerConfig),
    buildReplayPolicy: ({ modelApi, modelId }) =>
      buildOpenAICompatibleReplayPolicy(modelApi, {
        modelId,
        sanitizeToolCallIds: modelApi === "openai-completions",
        duplicateToolCallIdStyle: "openai",
        dropReasoningFromHistory: false,
      }),
    ...moonshotThinkingStreamHooks,
    wrapSimpleCompletionStreamFn: (ctx) =>
      isMoonshotAlwaysThinkingModelId(ctx.modelId)
        ? moonshotThinkingStreamHooks.wrapStreamFn?.(ctx)
        : ctx.streamFn,
    resolveThinkingProfile,
    isModernModelRef: ({ modelId }) => isMoonshotAlwaysThinkingModelId(modelId),
  },
  register(api) {
    api.registerMediaUnderstandingProvider(moonshotMediaUnderstandingProvider);
    api.registerWebSearchProvider(createKimiWebSearchProvider());
  },
});
