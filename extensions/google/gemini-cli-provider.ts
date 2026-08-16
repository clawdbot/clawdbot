// Google provider module implements model/runtime integration.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { GOOGLE_GEMINI_CLI_PROVIDER_ID } from "./gemini-cli-auth-home.js";
import { formatGoogleOauthApiKey } from "./oauth-token-shared.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const PROVIDER_ID = GOOGLE_GEMINI_CLI_PROVIDER_ID;
const PROVIDER_LABEL = "Gemini CLI runtime";

export function buildGoogleGeminiCliProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    docsPath: "/providers/models",
    aliases: ["gemini-cli"],
    envVars: [],
    auth: [],
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: PROVIDER_ID,
        ctx,
      }),
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    formatApiKey: (cred) => formatGoogleOauthApiKey(cred),
  };
}

export function registerGoogleGeminiCliProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleGeminiCliProvider());
}
