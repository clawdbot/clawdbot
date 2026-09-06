import type {
  OpenClawPluginApi,
  ProviderReasoningOutputModeContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeGoogleModelId } from "./model-id.js";
import { GOOGLE_GEMINI_DEFAULT_MODEL, applyGoogleGeminiModelDefault } from "./onboard.js";
import {
  buildGoogleLiveCatalogProvider,
  buildGoogleStaticCatalogProvider,
  buildGoogleVertexStaticCatalogProvider,
} from "./provider-catalog.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import {
  isGoogleNativeVideoModelId,
  isModernGoogleModel,
  resolveGoogleGeminiForwardCompatModel,
} from "./provider-models.js";
import {
  isOfficialGoogleAiStudioBaseUrl,
  isGoogleVertexBaseUrl,
  normalizeGoogleProviderConfig,
  resolveGoogleGenerativeAiTransport,
} from "./provider-policy.js";
import {
  createGoogleGenerativeAiTransportStreamFn,
  createGoogleVertexTransportStreamFn,
} from "./transport-stream.js";
import { resolveGoogleVertexConfigApiKey } from "./vertex-adc.js";

function normalizeGoogleVideoInput(
  ctx: Parameters<NonNullable<ProviderPlugin["normalizeResolvedModel"]>>[0],
) {
  const input = (ctx.model.input as string[]).filter((type) => type !== "video");
  const supportsVideo =
    ctx.provider === "google" &&
    ctx.model.api === "google-generative-ai" &&
    isOfficialGoogleAiStudioBaseUrl(ctx.model.baseUrl) &&
    isGoogleNativeVideoModelId(ctx.modelId);
  return { ...ctx.model, input: supportsVideo ? [...input, "video"] : input } as typeof ctx.model;
}

function resolveGoogleReasoningOutputMode(
  ctx: ProviderReasoningOutputModeContext,
): "native" | "tagged" {
  if (ctx.provider === "google" || ctx.provider === "google-vertex") {
    const api = ctx.model?.api ?? ctx.modelApi;
    if (!api || api === "google-generative-ai" || api === "google-vertex") {
      return "native";
    }
  }
  return "tagged";
}

export function buildGoogleProvider(): ProviderPlugin {
  return {
    id: "google",
    label: "Google AI Studio",
    docsPath: "/providers/models",
    hookAliases: ["google-antigravity", "google-vertex"],
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: "google",
        methodId: "api-key",
        label: "Google AI Studio API key",
        hint: "Supported API-key access from aistudio.google.com/apikey",
        optionKey: "geminiApiKey",
        flagName: "--gemini-api-key",
        envVar: "GEMINI_API_KEY",
        promptMessage: "Enter Google AI Studio API key",
        defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
        expectedProviders: ["google"],
        applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
        wizard: {
          choiceId: "gemini-api-key",
          choiceLabel: "Google AI Studio API key",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Supported API-key setup",
        },
      }),
    ],
    normalizeTransport: ({ provider, api, baseUrl }) =>
      resolveGoogleGenerativeAiTransport({ provider, api, baseUrl }),
    normalizeConfig: ({ provider, providerConfig }) =>
      normalizeGoogleProviderConfig(provider, providerConfig),
    resolveConfigApiKey: ({ provider, env }) =>
      provider === "google-vertex" ? resolveGoogleVertexConfigApiKey(env) : undefined,
    staticCatalog: {
      order: "simple",
      run: async () => ({
        providers: {
          google: buildGoogleStaticCatalogProvider(),
          "google-vertex": buildGoogleVertexStaticCatalogProvider(),
        },
      }),
    },
    catalog: {
      order: "simple",
      run: async (ctx) => {
        if (ctx.providerIds && !ctx.providerIds.includes("google")) {
          return null;
        }
        const auth = ctx.resolveProviderApiKey("google");
        if (!auth.apiKey) {
          return null;
        }
        return await runLiveProviderCatalog({
          providerId: "google",
          profileId: auth.profileId,
          run: async () => ({
            providers: {
              google: await buildGoogleLiveCatalogProvider({
                discoveryMode: "strict",
                apiKey: auth.apiKey,
                discoveryApiKey: auth.discoveryApiKey,
              }),
            },
          }),
        });
      },
    },
    normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
    normalizeResolvedModel: normalizeGoogleVideoInput,
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: ctx.provider,
        ctx,
      }),
    createStreamFn: ({ model }) => {
      if (
        model.api === "google-vertex" ||
        (model.api === "google-generative-ai" &&
          (model.provider === "google-vertex" || isGoogleVertexBaseUrl(model.baseUrl)))
      ) {
        return createGoogleVertexTransportStreamFn();
      }
      if (model.api === "google-generative-ai") {
        return createGoogleGenerativeAiTransportStreamFn();
      }
      return undefined;
    },
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    // Gemini 2.5+ delivers reasoning via native thinkingParts (thinkingConfig.includeThoughts).
    // Tagged mode simultaneously injects <think>/<final> which the model opens before a tool
    // call, never closes, leaving the post-tool turn empty (payloads=0). The CLI backend keeps
    // tagged mode because it emits JSON text, not native thought parts.
    resolveReasoningOutputMode: resolveGoogleReasoningOutputMode,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
  };
}

export function registerGoogleProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleProvider());
}
