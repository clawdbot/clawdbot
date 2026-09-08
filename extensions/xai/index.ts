import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Xai plugin entrypoint registers its OpenClaw integration.
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { defaultToolStreamExtraParams } from "openclaw/plugin-sdk/provider-stream-shared";
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildMissingCodeExecutionApiKeyPayload,
  createCodeExecutionToolDefinition,
} from "./code-execution-tool-shared.js";
import {
  createLazyXaiRealtimeTranscriptionProvider,
  createLazyXaiRealtimeVoiceProvider,
  createLazyXaiSpeechProvider,
} from "./lazy-capability-provider-factories.js";
import {
  createLazyXaiImageGenerationProvider,
  createLazyXaiMediaUnderstandingProvider,
  createLazyXaiVideoGenerationProvider,
} from "./lazy-capability-providers.js";
import { normalizeNativeXaiModelId } from "./model-compat.js";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildLiveXaiOAuthProvider,
  buildLiveXaiProvider,
  buildXaiProvider,
} from "./provider-catalog.js";
import { isXaiProviderId } from "./provider-id.js";
import {
  isModernXaiModel,
  normalizeXaiResolvedModel,
  resolveXaiForwardCompatModel,
} from "./provider-models.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { resolveXaiTransport } from "./provider-routing.js";
import {
  readPluginCodeExecutionConfig,
  resolveCodeExecutionEnabled,
} from "./src/code-execution-config.js";
import {
  isXaiToolEnabled,
  resolveFallbackXaiAuth,
  type XaiToolAuthContext,
} from "./src/tool-auth-shared.js";
import { resolveEffectiveXSearchConfig } from "./src/x-search-config.js";
import { wrapXaiProviderStream } from "./stream.js";
import { fetchXaiUsage } from "./usage.js";
import { createXaiWebSearchProvider } from "./web-search.js";
import {
  buildMissingXSearchApiKeyPayload,
  createXSearchToolDefinition,
} from "./x-search-tool-shared.js";
import {
  createXaiDeviceCodeAuthMethod,
  createXaiOAuthAuthMethod,
  refreshXaiOAuthCredential,
} from "./xai-oauth-entry.js";

const PROVIDER_ID = "xai";

const XAI_CREDIT_OR_SPENDING_LIMIT_RE =
  /\b(?:used all available credits|run out of credits|monthly spending limit|purchase more credits|raise your spending limit|need a Grok subscription)\b/i;
const XAI_RATE_LIMIT_RE = /\b(?:rate limit exceeded|too many requests)\b/i;

const loadCodeExecutionModule = createLazyRuntimeModule(() => import("./code-execution.js"));

const loadXSearchModule = createLazyRuntimeModule(() => import("./x-search.js"));

function classifyXaiFailoverReason(errorMessage: string) {
  if (XAI_CREDIT_OR_SPENDING_LIMIT_RE.test(errorMessage)) {
    return "billing" as const;
  }
  if (XAI_RATE_LIMIT_RE.test(errorMessage)) {
    return "rate_limit" as const;
  }
  return undefined;
}

function hasResolvableXaiApiKey(config: unknown, auth?: XaiToolAuthContext): boolean {
  return isXaiToolEnabled({ sourceConfig: config as never, auth });
}

function isCodeExecutionEnabled(config: unknown, auth?: XaiToolAuthContext): boolean {
  return resolveCodeExecutionEnabled({
    sourceConfig: config,
    runtimeConfig: config,
    config: readPluginCodeExecutionConfig(config),
    auth,
  });
}

function isXSearchEnabled(config: unknown, auth?: XaiToolAuthContext): boolean {
  const resolved =
    config && typeof config === "object"
      ? resolveEffectiveXSearchConfig(config as never)
      : undefined;
  if (resolved?.enabled === false) {
    return false;
  }
  return hasResolvableXaiApiKey(config, auth);
}

function shouldExposeXaiBilledTool(params: {
  activeProvider?: string;
  enabled?: unknown;
}): boolean {
  const activeProvider = params.activeProvider?.trim();
  if (!activeProvider || params.enabled === false) {
    return false;
  }
  // Cross-provider billing requires explicit consent; xAI models retain the
  // credential-backed default. Unknown providers fail closed.
  return isXaiProviderId(activeProvider) || params.enabled === true;
}

function createLazyCodeExecutionTool(ctx: OpenClawPluginToolContext) {
  const effectiveConfig = ctx.runtimeConfig ?? ctx.config;
  const codeExecutionConfig = readPluginCodeExecutionConfig(effectiveConfig);
  if (
    !shouldExposeXaiBilledTool({
      activeProvider: ctx.activeModel?.provider,
      enabled: codeExecutionConfig?.enabled,
    })
  ) {
    return null;
  }
  if (!isCodeExecutionEnabled(effectiveConfig, ctx)) {
    return null;
  }

  return createCodeExecutionToolDefinition(
    async (toolCallId: string, args: Record<string, unknown>) => {
      const { createCodeExecutionTool } = await loadCodeExecutionModule();
      const tool = createCodeExecutionTool({
        config: ctx.config as never,
        runtimeConfig: (ctx.runtimeConfig as never) ?? null,
        auth: ctx,
      });
      if (!tool) {
        return jsonResult(buildMissingCodeExecutionApiKeyPayload());
      }
      return await tool.execute(toolCallId, args);
    },
  );
}

function createLazyXSearchTool(ctx: OpenClawPluginToolContext) {
  const effectiveConfig = ctx.runtimeConfig ?? ctx.config;
  const xSearchConfig = resolveEffectiveXSearchConfig(effectiveConfig);
  if (
    !shouldExposeXaiBilledTool({
      activeProvider: ctx.activeModel?.provider,
      enabled: xSearchConfig?.enabled,
    })
  ) {
    return null;
  }
  if (!isXSearchEnabled(effectiveConfig, ctx)) {
    return null;
  }

  return createXSearchToolDefinition(async (toolCallId, args, signal) => {
    signal?.throwIfAborted();
    const { createXSearchTool } = await loadXSearchModule();
    signal?.throwIfAborted();
    const tool = createXSearchTool({
      config: ctx.config as never,
      runtimeConfig: (ctx.runtimeConfig as never) ?? null,
      auth: ctx,
    });
    if (!tool) {
      return jsonResult(buildMissingXSearchApiKeyPayload());
    }
    return await tool.execute(toolCallId, args, signal);
  });
}

export default defineSingleProviderPluginEntry({
  id: "xai",
  name: "xAI Plugin",
  description: "Bundled xAI plugin",
  provider: (pluginApi) => ({
    label: "xAI",
    aliases: ["x-ai"],
    docsPath: "/providers/xai",
    auth: [
      {
        methodId: "api-key",
        label: "xAI API key",
        hint: "API key",
        optionKey: "xaiApiKey",
        flagName: "--xai-api-key",
        envVar: "XAI_API_KEY",
        promptMessage: "Enter xAI API key",
        defaultModel: XAI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyXaiConfig(cfg),
        wizard: {
          groupLabel: "xAI (Grok)",
        },
      },
    ],
    extraAuth: [createXaiOAuthAuthMethod(), createXaiDeviceCodeAuthMethod()],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const auth = ctx.resolveProviderAuth(PROVIDER_ID);
        if (auth.preparationFailed) {
          return null;
        }
        const { resolveApiKeyForProvider } =
          await import("openclaw/plugin-sdk/provider-auth-runtime");
        const runtimeAuth = await resolveApiKeyForProvider({
          provider: PROVIDER_ID,
          cfg: ctx.config,
          ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
          ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
          ...(auth.profileId ? { profileId: auth.profileId, lockedProfile: true } : {}),
          // Prepared direct auth must not reopen failed profile candidates.
          ...(!auth.profileId && auth.mode !== "none" ? { allowAuthProfileFallback: false } : {}),
        }).catch(() => undefined);
        const selectedAuth =
          runtimeAuth?.mode === "oauth" && runtimeAuth.apiKey
            ? { ...runtimeAuth, oauth: true }
            : { ...(auth.apiKey ? auth : ctx.resolveProviderApiKey(PROVIDER_ID)), oauth: false };
        if (!selectedAuth.apiKey) {
          return null;
        }
        const apiKey = selectedAuth.apiKey;
        return await runLiveProviderCatalog({
          providerId: PROVIDER_ID,
          profileId: selectedAuth.profileId,
          run: async () => ({
            provider: selectedAuth.oauth
              ? await buildLiveXaiOAuthProvider({ discoveryApiKey: apiKey })
              : await buildLiveXaiProvider(selectedAuth),
          }),
        });
      },
      staticRun: async () => ({
        provider: buildXaiProvider(),
      }),
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    prepareExtraParams: (ctx) => defaultToolStreamExtraParams(ctx.extraParams),
    wrapStreamFn: (ctx) =>
      wrapXaiProviderStream(ctx, {
        clientVersion: pluginApi.runtime.version,
      }),
    // Provider-specific fallback auth stays owned by the xAI plugin so core
    // auth/discovery code can consume it generically without parsing xAI's
    // private config layout. Callers may receive a real key from the active
    // runtime snapshot or a non-secret SecretRef marker from source config.
    resolveSyntheticAuth: ({ config }) => {
      const fallbackAuth = resolveFallbackXaiAuth(config);
      if (!fallbackAuth) {
        return undefined;
      }
      return {
        apiKey: fallbackAuth.apiKey,
        source: fallbackAuth.source,
        mode: "api-key" as const,
      };
    },
    normalizeResolvedModel: ({ model }) => normalizeXaiResolvedModel(model),
    normalizeTransport: ({ provider, api, baseUrl }) =>
      resolveXaiTransport({ provider, api, baseUrl }),
    normalizeModelId: ({ modelId }) => normalizeNativeXaiModelId(modelId),
    resolveDynamicModel: (ctx) => resolveXaiForwardCompatModel({ providerId: PROVIDER_ID, ctx }),
    refreshOAuth: refreshXaiOAuthCredential,
    resolveUsageAuth: async (ctx) => {
      const oauth = await ctx.resolveOAuthToken();
      return oauth ? oauth : { handled: true };
    },
    fetchUsageSnapshot: async (ctx) => await fetchXaiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    resolveThinkingProfile,
    isModernModelRef: ({ modelId }) => isModernXaiModel(modelId),
    classifyFailoverReason: ({ errorMessage }) => classifyXaiFailoverReason(errorMessage),
  }),
  register(api) {
    api.registerWebSearchProvider(createXaiWebSearchProvider());
    api.registerMediaUnderstandingProvider(createLazyXaiMediaUnderstandingProvider());
    api.registerVideoGenerationProvider(createLazyXaiVideoGenerationProvider());
    api.registerImageGenerationProvider(createLazyXaiImageGenerationProvider());
    api.registerSpeechProvider(createLazyXaiSpeechProvider);
    api.registerRealtimeTranscriptionProvider(createLazyXaiRealtimeTranscriptionProvider);
    api.registerRealtimeVoiceProvider(createLazyXaiRealtimeVoiceProvider);
    api.registerTool((ctx) => createLazyCodeExecutionTool(ctx), { name: "code_execution" });
    api.registerTool((ctx) => createLazyXSearchTool(ctx), { name: "x_search" });
  },
});
