import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  MINIMAX_OAUTH_MARKER,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { MINIMAX_FAST_MODE_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import { fetchMinimaxUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { isMiniMaxModernModelId, MINIMAX_DEFAULT_MODEL_ID } from "./api.js";
import type { MiniMaxRegion } from "./oauth.js";
import { applyMinimaxApiConfig, applyMinimaxApiConfigCn } from "./onboard.js";
import { buildMinimaxPortalProvider, buildMinimaxProvider } from "./provider-catalog.js";

const API_PROVIDER_ID = "minimax";
const PORTAL_PROVIDER_ID = "minimax-portal";
const PROVIDER_LABEL = "MiniMax";
const DEFAULT_MODEL = MINIMAX_DEFAULT_MODEL_ID;
const DEFAULT_BASE_URL_CN = "https://api.minimaxi.com/anthropic";
const DEFAULT_BASE_URL_GLOBAL = "https://api.minimax.io/anthropic";
const MINIMAX_USAGE_ENV_VAR_KEYS = [
  "MINIMAX_OAUTH_TOKEN",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
  "MINIMAX_API_KEY",
] as const;
const MINIMAX_WIZARD_GROUP = {
  groupId: "minimax",
  groupLabel: "MiniMax",
  groupHint: "M2.7 (recommended)",
} as const;
const HYBRID_ANTHROPIC_OPENAI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "hybrid-anthropic-openai",
  anthropicModelDropThinkingBlocks: true,
});
const MINIMAX_PROVIDER_HOOKS = {
  ...HYBRID_ANTHROPIC_OPENAI_REPLAY_HOOKS,
  ...MINIMAX_FAST_MODE_STREAM_HOOKS,
  resolveReasoningOutputMode: () => "native" as const,
};

function getDefaultBaseUrl(region: MiniMaxRegion): string {
  return region === "cn" ? DEFAULT_BASE_URL_CN : DEFAULT_BASE_URL_GLOBAL;
}

function resolveMinimaxRegionLabel(region: MiniMaxRegion): string {
  return region === "cn" ? "CN" : "Global";
}

function resolveMinimaxEndpointHint(region: MiniMaxRegion): string {
  return region === "cn" ? "CN endpoint - api.minimaxi.com" : "Global endpoint - api.minimax.io";
}

function apiModelRef(modelId: string): string {
  return `${API_PROVIDER_ID}/${modelId}`;
}

function portalModelRef(modelId: string): string {
  return `${PORTAL_PROVIDER_ID}/${modelId}`;
}

function buildPortalProviderCatalog(params: { baseUrl: string; apiKey: string }) {
  return {
    ...buildMinimaxPortalProvider(),
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
  };
}

function resolveApiCatalog(ctx: ProviderCatalogContext) {
  const apiKey = ctx.resolveProviderApiKey(API_PROVIDER_ID).apiKey;
  if (!apiKey) {
    return null;
  }
  return {
    provider: {
      ...buildMinimaxProvider(ctx.env),
      apiKey,
    },
  };
}

function resolvePortalCatalog(ctx: ProviderCatalogContext) {
  const explicitProvider = ctx.config.models?.providers?.[PORTAL_PROVIDER_ID];
  const envApiKey = ctx.resolveProviderApiKey(PORTAL_PROVIDER_ID).apiKey;
  const authStore = ensureAuthProfileStore(ctx.agentDir, {
    allowKeychainPrompt: false,
  });
  const hasProfiles = listProfilesForProvider(authStore, PORTAL_PROVIDER_ID).length > 0;
  const explicitApiKey = normalizeOptionalString(explicitProvider?.apiKey);
  const apiKey = envApiKey ?? explicitApiKey ?? (hasProfiles ? MINIMAX_OAUTH_MARKER : undefined);
  if (!apiKey) {
    return null;
  }

  const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl);

  return {
    provider: buildPortalProviderCatalog({
      baseUrl: explicitBaseUrl || buildMinimaxPortalProvider(ctx.env).baseUrl,
      apiKey,
    }),
  };
}

function createOAuthHandler(region: MiniMaxRegion) {
  const defaultBaseUrl = getDefaultBaseUrl(region);
  const regionLabel = resolveMinimaxRegionLabel(region);

  return async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const progress = ctx.prompter.progress(`Starting MiniMax OAuth (${regionLabel})…`);
    try {
      const { loginMiniMaxPortalOAuth } = await import("./oauth.runtime.js");
      const result = await loginMiniMaxPortalOAuth({
        openUrl: ctx.openUrl,
        note: ctx.prompter.note,
        progress,
        region,
      });

      progress.stop("MiniMax OAuth complete");

      if (result.notification_message) {
        await ctx.prompter.note(result.notification_message, "MiniMax OAuth");
      }

      const baseUrl = result.resourceUrl || defaultBaseUrl;

      return buildOauthProviderAuthResult({
        providerId: PORTAL_PROVIDER_ID,
        defaultModel: portalModelRef(DEFAULT_MODEL),
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
        configPatch: {
          models: {
            providers: {
              [PORTAL_PROVIDER_ID]: {
                baseUrl,
                api: "anthropic-messages",
                authHeader: true,
                models: [],
              },
            },
          },
          agents: {
            defaults: {
              models: {
                [portalModelRef("MiniMax-M2.7")]: { alias: "minimax-m2.7" },
                [portalModelRef("MiniMax-M2.7-highspeed")]: {
                  alias: "minimax-m2.7-highspeed",
                },
              },
            },
          },
        },
        notes: [
          "MiniMax OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
          `Base URL defaults to ${defaultBaseUrl}. Override models.providers.${PORTAL_PROVIDER_ID}.baseUrl if needed.`,
          ...(result.notification_message ? [result.notification_message] : []),
        ],
      });
    } catch (err) {
      const errorMsg = formatErrorMessage(err);
      progress.stop(`MiniMax OAuth failed: ${errorMsg}`);
      await ctx.prompter.note(
        "If OAuth fails, verify your MiniMax account has portal access and try again.",
        "MiniMax OAuth",
      );
      throw err;
    }
  };
}

function createMinimaxApiKeyMethod(region: MiniMaxRegion) {
  const regionLabel = resolveMinimaxRegionLabel(region);
  const endpointHint = resolveMinimaxEndpointHint(region);
  const isCn = region === "cn";
  return createProviderApiKeyAuthMethod({
    providerId: API_PROVIDER_ID,
    methodId: isCn ? "api-cn" : "api-global",
    label: `MiniMax API key (${regionLabel})`,
    hint: endpointHint,
    optionKey: "minimaxApiKey",
    flagName: "--minimax-api-key",
    envVar: "MINIMAX_API_KEY",
    promptMessage: isCn
      ? "Enter MiniMax CN API key (sk-api- or sk-cp-)\nhttps://platform.minimaxi.com/user-center/basic-information/interface-key"
      : "Enter MiniMax API key (sk-api- or sk-cp-)\nhttps://platform.minimax.io/user-center/basic-information/interface-key",
    profileId: isCn ? "minimax:cn" : "minimax:global",
    allowProfile: false,
    defaultModel: apiModelRef(DEFAULT_MODEL),
    expectedProviders: isCn ? ["minimax", "minimax-cn"] : ["minimax"],
    applyConfig: (cfg) => (isCn ? applyMinimaxApiConfigCn(cfg) : applyMinimaxApiConfig(cfg)),
    wizard: {
      choiceId: isCn ? "minimax-cn-api" : "minimax-global-api",
      choiceLabel: `MiniMax API key (${regionLabel})`,
      choiceHint: endpointHint,
      ...MINIMAX_WIZARD_GROUP,
    },
  });
}

function createMinimaxOAuthMethod(region: MiniMaxRegion) {
  const regionLabel = resolveMinimaxRegionLabel(region);
  const endpointHint = resolveMinimaxEndpointHint(region);
  const isCn = region === "cn";
  return {
    id: isCn ? "oauth-cn" : "oauth",
    label: `MiniMax OAuth (${regionLabel})`,
    hint: endpointHint,
    kind: "device_code" as const,
    wizard: {
      choiceId: isCn ? "minimax-cn-oauth" : "minimax-global-oauth",
      choiceLabel: `MiniMax OAuth (${regionLabel})`,
      choiceHint: endpointHint,
      ...MINIMAX_WIZARD_GROUP,
    },
    run: createOAuthHandler(region),
  };
}

export function registerMinimaxProviders(api: OpenClawPluginApi) {
  api.registerProvider({
    id: API_PROVIDER_ID,
    label: PROVIDER_LABEL,
    hookAliases: ["minimax-cn"],
    docsPath: "/providers/minimax",
    envVars: ["MINIMAX_API_KEY"],
    auth: [createMinimaxApiKeyMethod("global"), createMinimaxApiKeyMethod("cn")],
    catalog: {
      order: "simple",
      run: async (ctx) => resolveApiCatalog(ctx),
    },
    resolveUsageAuth: async (ctx) => {
      const portalOauth = await ctx.resolveOAuthToken({ provider: PORTAL_PROVIDER_ID });
      if (portalOauth) {
        return portalOauth;
      }
      const apiKey = ctx.resolveApiKeyFromConfigAndStore({
        providerIds: [API_PROVIDER_ID, PORTAL_PROVIDER_ID],
        envDirect: MINIMAX_USAGE_ENV_VAR_KEYS.map((name) => ctx.env[name]),
      });
      return apiKey ? { token: apiKey } : null;
    },
    ...MINIMAX_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId),
    fetchUsageSnapshot: async (ctx) =>
      await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
  });

  api.registerProvider({
    id: PORTAL_PROVIDER_ID,
    label: PROVIDER_LABEL,
    hookAliases: ["minimax-portal-cn"],
    docsPath: "/providers/minimax",
    envVars: ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
    catalog: {
      run: async (ctx) => resolvePortalCatalog(ctx),
    },
    auth: [createMinimaxOAuthMethod("global"), createMinimaxOAuthMethod("cn")],
    ...MINIMAX_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId),
  });
}
