import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Google provider module implements model/runtime integration.
import type {
  OpenClawPluginApi,
  ProviderFetchUsageSnapshotContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchGeminiUsage } from "openclaw/plugin-sdk/provider-usage";
import { GOOGLE_GEMINI_CLI_PROVIDER_ID } from "./gemini-cli-auth-home.js";
import { formatGoogleOauthApiKey, parseGoogleUsageToken } from "./oauth-token-shared.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const PROVIDER_ID = GOOGLE_GEMINI_CLI_PROVIDER_ID;
const PROVIDER_LABEL = "Gemini CLI runtime";

const loadOauthRuntimeModule = createLazyRuntimeModule(() => import("./oauth.runtime.js"));

async function fetchGeminiCliUsage(ctx: ProviderFetchUsageSnapshotContext) {
  return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}

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
    refreshOAuth: async (cred) => {
      const { refreshGeminiCliOAuthToken } = await loadOauthRuntimeModule();
      return await refreshGeminiCliOAuthToken(cred);
    },
    resolveUsageAuth: async (ctx) => {
      const auth = await ctx.resolveOAuthToken();
      if (!auth) {
        return null;
      }
      return {
        ...auth,
        token: parseGoogleUsageToken(auth.token),
      };
    },
    fetchUsageSnapshot: async (ctx) => await fetchGeminiCliUsage(ctx),
  };
}

export function registerGoogleGeminiCliProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleGeminiCliProvider());
}
