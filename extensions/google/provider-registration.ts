// Google provider module implements model/runtime integration.
import type {
  OpenClawPluginApi,
  ProviderReasoningOutputModeContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeGoogleModelId } from "./model-id.js";
import { GOOGLE_GEMINI_DEFAULT_MODEL, applyGoogleGeminiModelDefault } from "./onboard.js";
import {
  buildGoogleStaticCatalogProvider,
  buildGoogleVertexStaticCatalogProvider,
} from "./provider-catalog.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";
import {
  isGoogleVertexBaseUrl,
  normalizeGoogleProviderConfig,
  resolveGoogleGenerativeAiTransport,
} from "./provider-policy.js";
import {
  createGoogleGenerativeAiTransportStreamFn,
  createGoogleVertexTransportStreamFn,
} from "./transport-stream.js";
import { resolveGoogleVertexConfigApiKey } from "./vertex-adc.js";

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
        label: "Google Gemini API key",
        hint: "Free API key from aistudio.google.com/apikey",
        optionKey: "geminiApiKey",
        flagName: "--gemini-api-key",
        envVar: "GEMINI_API_KEY",
        promptMessage: "Enter Gemini API key",
        defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
        expectedProviders: ["google"],
        applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
        wizard: {
          choiceId: "gemini-api-key",
          choiceLabel: "Google Gemini API key",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Gemini API key + OAuth",
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
    normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
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
