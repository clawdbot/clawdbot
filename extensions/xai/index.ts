// Xai plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { OPENAI_COMPATIBLE_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import { defaultToolStreamExtraParams } from "openclaw/plugin-sdk/provider-stream-shared";
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import {
  applyXaiRuntimeModelCompat,
  buildXaiImageGenerationProvider,
  normalizeXaiModelId,
  resolveXaiTransport,
} from "./api.js";
import {
  buildMissingCodeExecutionApiKeyPayload,
  createCodeExecutionToolDefinition,
} from "./code-execution-tool-shared.js";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildLiveXaiOAuthProvider,
  buildLiveXaiProvider,
  buildXaiProvider,
} from "./provider-catalog.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { buildXaiRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildXaiSpeechProvider } from "./speech-provider.js";
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
import { buildXaiMediaUnderstandingProvider } from "./stt.js";
import { buildXaiVideoGenerationProvider } from "./video-generation-provider.js";
import { createXaiWebSearchProvider } from "./web-search.js";
import {
  buildMissingXSearchApiKeyPayload,
  createXSearchToolDefinition,
} from "./x-search-tool-shared.js";
import {
  createXaiDeviceCodeAuthMethod,
  createXaiOAuthAuthMethod,
  refreshXaiOAuthCredential,
} from "./xai-oauth.js";

const PROVIDER_ID = "xai";
type CodeExecutionModule = typeof import("./code-execution.js");
type XSearchModule = typeof import("./x-search.js");

const XAI_CREDIT_OR_SPENDING_LIMIT_RE =
  /\b(?:used all available credits|monthly spending limit|purchase more credits|raise your spending limit)\b/i;
const XAI_RATE_LIMIT_RE = /\b(?:rate limit exceeded|too many requests)\b/i;

let codeExecutionModulePromise: Promise<CodeExecutionModule> | undefined;
let xSearchModulePromise: Promise<XSearchModule> | undefined;

function loadCodeExecutionModule(): Promise<CodeExecutionModule> {
  codeExecutionModulePromise ??= import("./code-execution.js");
  return codeExecutionModulePromise;
}

function loadXSearchModule(): Promise<XSearchModule> {
  xSearchModulePromise ??= import("./x-search.js");
  return xSearchModulePromise;
}

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

function createLazyCodeExecutionTool(ctx: {
  config?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  hasAuthForProvider?: XaiToolAuthContext["hasAuthForProvider"];
  resolveApiKeyForProvider?: XaiToolAuthContext["resolveApiKeyForProvider"];
}) {
  const effectiveConfig = ctx.runtimeConfig ?? ctx.config;
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

function createLazyXSearchTool(ctx: {
  config?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  hasAuthForProvider?: XaiToolAuthContext["hasAuthForProvider"];
  resolveApiKeyForProvider?: XaiToolAuthContext["resolveApiKeyForProvider"];
}) {
  const effectiveConfig = ctx.runtimeConfig ?? ctx.config;
  if (!isXSearchEnabled(effectiveConfig, ctx)) {
    return null;
  }

  return createXSearchToolDefinition(async (toolCallId: string, args: Record<string, unknown>) => {
    const { createXSearchTool } = await loadXSearchModule();
    const tool = createXSearchTool({
      config: ctx.config as never,
      runtimeConfig: (ctx.runtimeConfig as never) ?? null,
      auth: ctx,
    });
    if (!tool) {
      return jsonResult(buildMissingXSearchApiKeyPayload());
    }
    return await tool.execute(toolCallId, args);
  });
}

export default defineSingleProviderPluginEntry({
  id: "xai",
  name: "xAI Plugin",
  description: "Bundled xAI plugin",
  provider: {
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
        try {
          const { resolveApiKeyForProvider } =
            await import("openclaw/plugin-sdk/provider-auth-runtime");
          const runtimeAuth = await resolveApiKeyForProvider({
            provider: PROVIDER_ID,
            cfg: ctx.config,
            ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
            ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
            ...(auth.profileId
              ? {
                  profileId: auth.profileId,
                  lockedProfile: true,
                }
              : {}),
          });
          if (runtimeAuth?.mode === "oauth" && runtimeAuth.apiKey) {
            return {
              provider: await buildLiveXaiOAuthProvider({
                discoveryApiKey: runtimeAuth.apiKey,
              }),
            };
          }
        } catch {
          if (auth.mode === "oauth") {
            // OAuth discovery is advisory; fall through so configured API-key
            // auth can still publish the standard xAI catalog.
          }
        }
        if (auth.apiKey) {
          return {
            provider: await buildLiveXaiProvider({
              apiKey: auth.apiKey,
              discoveryApiKey: auth.discoveryApiKey,
            }),
          };
        }

        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey.apiKey) {
          return null;
        }
        return {
          provider: await buildLiveXaiProvider({
            apiKey: apiKey.apiKey,
            discoveryApiKey: apiKey.discoveryApiKey,
          }),
        };
      },
      staticRun: async () => ({
        provider: buildXaiProvider(),
      }),
    },
    ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    prepareExtraParams: (ctx) => defaultToolStreamExtraParams(ctx.extraParams),
    wrapStreamFn: wrapXaiProviderStream,
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
    normalizeResolvedModel: ({ model }) => applyXaiRuntimeModelCompat(model),
    normalizeTransport: ({ provider, api, baseUrl }) =>
      resolveXaiTransport({ provider, api, baseUrl }),
    normalizeModelId: ({ modelId }) => normalizeXaiModelId(modelId),
    resolveDynamicModel: (ctx) => resolveXaiForwardCompatModel({ providerId: PROVIDER_ID, ctx }),
    refreshOAuth: refreshXaiOAuthCredential,
    resolveThinkingProfile,
    isModernModelRef: ({ modelId }) => isModernXaiModel(modelId),
    classifyFailoverReason: ({ errorMessage }) => classifyXaiFailoverReason(errorMessage),
  },
  register(api) {
    api.registerWebSearchProvider(createXaiWebSearchProvider());
    api.registerMediaUnderstandingProvider(buildXaiMediaUnderstandingProvider());
    api.registerVideoGenerationProvider(buildXaiVideoGenerationProvider());
    api.registerImageGenerationProvider(buildXaiImageGenerationProvider());
    api.registerSpeechProvider(buildXaiSpeechProvider());
    api.registerRealtimeTranscriptionProvider(buildXaiRealtimeTranscriptionProvider());
    api.registerTool((ctx) => createLazyCodeExecutionTool(ctx), { name: "code_execution" });
    api.registerTool((ctx) => createLazyXSearchTool(ctx), { name: "x_search" });
  },
});
