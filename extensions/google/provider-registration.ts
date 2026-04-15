import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  GOOGLE_GEMINI_DEFAULT_MODEL,
  applyGoogleGeminiModelDefault,
  normalizeGoogleProviderConfig,
  normalizeGoogleModelId,
  resolveGoogleGenerativeAiTransport,
} from "./api.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

export function registerGoogleProvider(api: OpenClawPluginApi) {
  api.registerProvider({
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
        hint: "AI Studio / Gemini API key",
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
    normalizeTransport: ({ api, baseUrl }) => resolveGoogleGenerativeAiTransport({ api, baseUrl }),
    normalizeConfig: ({ provider, providerConfig }) =>
      normalizeGoogleProviderConfig(provider, providerConfig),
    normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: ctx.provider,
        ctx,
      }),
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
  });
}
