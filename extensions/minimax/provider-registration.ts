// Minimax provider module implements model/runtime integration.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginApi,
  OpenClawConfig,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderCatalogContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  MINIMAX_OAUTH_MARKER,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildProviderReplayFamilyHooks,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { fetchMinimaxUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isMiniMaxModernModelId,
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_TEXT_MODEL_CATALOG,
  MINIMAX_TEXT_MODEL_ORDER,
} from "./api.js";
import { DEFAULT_MINIMAX_MAX_TOKENS, resolveMinimaxApiCost } from "./model-definitions.js";
import type { MiniMaxRegion } from "./oauth.js";
import { applyMinimaxApiConfig, applyMinimaxApiConfigCn } from "./onboard.js";
import {
  buildMinimaxPortalProvider,
  buildMinimaxProvider,
  resolveMinimaxCatalogBaseUrl,
} from "./provider-catalog.js";
import { resolveMinimaxThinkingProfile } from "./thinking.js";

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
  groupHint: "M3 (recommended)",
} as const;
const HYBRID_ANTHROPIC_OPENAI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "hybrid-anthropic-openai",
  anthropicModelDropThinkingBlocks: true,
});
const MINIMAX_PROVIDER_HOOKS = {
  ...HYBRID_ANTHROPIC_OPENAI_REPLAY_HOOKS,
  ...buildProviderStreamFamilyHooks("minimax-fast-mode"),
  resolveReasoningOutputMode: () => "native" as const,
  resolveThinkingProfile: ({ modelId }: { modelId: string }) =>
    resolveMinimaxThinkingProfile(modelId),
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

function getProviderBaseUrl(cfg: OpenClawConfig, providerId: string): string | undefined {
  return normalizeOptionalString(cfg.models?.providers?.[providerId]?.baseUrl);
}

function resolveMinimaxUsageBaseUrl(cfg: OpenClawConfig): string | undefined {
  return getProviderBaseUrl(cfg, PORTAL_PROVIDER_ID) ?? getProviderBaseUrl(cfg, API_PROVIDER_ID);
}

function buildPortalProviderCatalog(params: { baseUrl: string; apiKey: string }) {
  return {
    ...buildMinimaxPortalProvider(),
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
  };
}

function findMinimaxCatalogModel(modelId: string) {
  const normalizedModelId = modelId.trim().toLowerCase();
  const catalogId = MINIMAX_TEXT_MODEL_ORDER.find((id) => id.toLowerCase() === normalizedModelId);
  return catalogId ? { id: catalogId, model: MINIMAX_TEXT_MODEL_CATALOG[catalogId] } : undefined;
}

function resolveMinimaxDynamicModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const catalogModel = findMinimaxCatalogModel(params.ctx.modelId);
  if (!catalogModel) {
    return undefined;
  }
  return normalizeModelCompat({
    id: catalogModel.id,
    name: catalogModel.model.name,
    provider: params.providerId,
    api: "anthropic-messages",
    baseUrl:
      normalizeOptionalString(params.ctx.providerConfig?.baseUrl) ?? resolveMinimaxCatalogBaseUrl(),
    reasoning: catalogModel.model.reasoning,
    input: [...catalogModel.model.input],
    cost: resolveMinimaxApiCost(catalogModel.id),
    contextWindow: catalogModel.model.contextWindow,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  });
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
        note: (message, title) => ctx.prompter.note(message, title),
        progress,
        region,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
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
                [portalModelRef("MiniMax-M3")]: { alias: "minimax-m3" },
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

function buildMinimaxApiProviderPlugin(): ProviderPlugin {
  return {
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
    staticCatalog: {
      order: "simple",
      run: async (ctx) => ({ providers: { [API_PROVIDER_ID]: buildMinimaxProvider(ctx.env) } }),
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
    resolveDynamicModel: (ctx) => resolveMinimaxDynamicModel({ providerId: API_PROVIDER_ID, ctx }),
    isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId),
    fetchUsageSnapshot: async (ctx) =>
      await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, {
        baseUrl: resolveMinimaxUsageBaseUrl(ctx.config),
      }),
  };
}

function buildMinimaxPortalProviderPlugin(): ProviderPlugin {
  return {
    id: PORTAL_PROVIDER_ID,
    label: PROVIDER_LABEL,
    hookAliases: ["minimax-portal-cn"],
    docsPath: "/providers/minimax",
    envVars: ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
    catalog: {
      run: async (ctx) => resolvePortalCatalog(ctx),
    },
    staticCatalog: {
      run: async (ctx) => ({
        providers: { [PORTAL_PROVIDER_ID]: buildMinimaxPortalProvider(ctx.env) },
      }),
    },
    auth: [createMinimaxOAuthMethod("global"), createMinimaxOAuthMethod("cn")],
    ...MINIMAX_PROVIDER_HOOKS,
    resolveDynamicModel: (ctx) =>
      resolveMinimaxDynamicModel({ providerId: PORTAL_PROVIDER_ID, ctx }),
    isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId),
  };
}

export function registerMinimaxProviders(api: OpenClawPluginApi) {
  api.registerProvider(buildMinimaxApiProviderPlugin());
  api.registerProvider(buildMinimaxPortalProviderPlugin());
}
