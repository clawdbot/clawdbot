import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  ProviderAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStoreForLocalUpdate,
  listProfilesForProvider,
  type OAuthCredential,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { loginOpenAICodexOAuth } from "openclaw/plugin-sdk/provider-auth-login";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
  normalizeProviderId,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { fetchCodexUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeLowercaseStringOrEmpty, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import {
  OPENAI_CODEX_DEVICE_PAIRING_HINT,
  OPENAI_CODEX_DEVICE_PAIRING_LABEL,
  OPENAI_CODEX_LOGIN_HINT,
  OPENAI_CODEX_LOGIN_LABEL,
  OPENAI_WIZARD_GROUP,
} from "./auth-choice-copy.js";
import { isOpenAIApiBaseUrl, isOpenAICodexBaseUrl } from "./base-url.js";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./default-models.js";
import { resolveCodexAuthIdentity } from "./openai-codex-auth-identity.js";
import { buildOpenAICodexProvider } from "./openai-codex-catalog.js";
import { loginOpenAICodexDeviceCode } from "./openai-codex-device-code.js";
import {
  buildOpenAIResponsesProviderHooks,
  buildOpenAISyntheticCatalogEntry,
  cloneFirstTemplateModel,
  findCatalogTemplate,
  matchesExactOrPrefix,
} from "./shared.js";

const PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const OPENAI_CODEX_LOGIN_ASSISTANT_PRIORITY = -30;
const OPENAI_CODEX_DEVICE_PAIRING_ASSISTANT_PRIORITY = -10;
const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID = "gpt-5.4-codex";
const OPENAI_CODEX_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_CODEX_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS = 1_050_000;
const OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_54_MINI_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_CODEX_GPT_54_COST = {
  input: 2.5,
  output: 15,
  cacheRead: 0.25,
  cacheWrite: 0,
} as const;
const OPENAI_CODEX_GPT_54_PRO_COST = {
  input: 30,
  output: 180,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
const OPENAI_CODEX_GPT_54_MINI_COST = {
  input: 0.75,
  output: 4.5,
  cacheRead: 0.075,
  cacheWrite: 0,
} as const;
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"] as const;
/** Legacy codex rows first; fall back to catalog `gpt-5.4` when the API omits 5.3/5.2. */
const OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS = [
  ...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
  OPENAI_CODEX_GPT_54_MODEL_ID,
] as const;
const OPENAI_CODEX_GPT_54_MINI_TEMPLATE_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  "gpt-5.1-codex-mini",
  ...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
] as const;
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT_53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS = 128_000;
const OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS = 128_000;
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;
const OPENAI_CODEX_XHIGH_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
  OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
  OPENAI_CODEX_GPT_53_MODEL_ID,
  OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
  "gpt-5.2-codex",
  "gpt-5.1-codex",
] as const;
const OPENAI_CODEX_MODERN_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
  OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
  "gpt-5.2",
  "gpt-5.2-codex",
  OPENAI_CODEX_GPT_53_MODEL_ID,
  OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
] as const;

function isLegacyCodexCompatBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  return !!trimmed && /^https?:\/\/api\.githubcopilot\.com(?:\/v1)?\/?$/iu.test(trimmed);
}

function normalizeCodexTransportFields(params: {
  api?: ProviderRuntimeModel["api"] | null;
  baseUrl?: string;
}): {
  api?: ProviderRuntimeModel["api"];
  baseUrl?: string;
} {
  const useCodexTransport =
    !params.baseUrl ||
    isOpenAIApiBaseUrl(params.baseUrl) ||
    isOpenAICodexBaseUrl(params.baseUrl) ||
    isLegacyCodexCompatBaseUrl(params.baseUrl);
  const api =
    useCodexTransport &&
    (!params.api || params.api === "openai-responses" || params.api === "openai-completions")
      ? "openai-codex-responses"
      : (params.api ?? undefined);
  const baseUrl =
    api === "openai-codex-responses" && useCodexTransport ? OPENAI_CODEX_BASE_URL : params.baseUrl;
  return { api, baseUrl };
}

function normalizeCodexTransport(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const lowerModelId = normalizeLowercaseStringOrEmpty(model.id);
  const canonicalModelId =
    lowerModelId === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID ? OPENAI_CODEX_GPT_54_MODEL_ID : model.id;
  const canonicalName =
    normalizeLowercaseStringOrEmpty(model.name) === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID
      ? OPENAI_CODEX_GPT_54_MODEL_ID
      : model.name;
  const normalizedTransport = normalizeCodexTransportFields({
    api: model.api,
    baseUrl: model.baseUrl,
  });
  const api = normalizedTransport.api ?? model.api;
  const baseUrl = normalizedTransport.baseUrl ?? model.baseUrl;
  if (
    api === model.api &&
    baseUrl === model.baseUrl &&
    canonicalModelId === model.id &&
    canonicalName === model.name
  ) {
    return model;
  }
  return {
    ...model,
    id: canonicalModelId,
    name: canonicalName,
    api,
    baseUrl,
  };
}

function resolveCodexForwardCompatModel(ctx: ProviderResolveDynamicModelContext) {
  const trimmedModelId = ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);

  let templateIds: readonly string[];
  let patch: Parameters<typeof cloneFirstTemplateModel>[0]["patch"];
  if (lower === OPENAI_CODEX_GPT_54_MODEL_ID || lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS;
    patch = {
      contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
      contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      cost: OPENAI_CODEX_GPT_54_COST,
    };
  } else if (lower === OPENAI_CODEX_GPT_54_PRO_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS;
    patch = {
      contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
      contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      cost: OPENAI_CODEX_GPT_54_PRO_COST,
    };
  } else if (lower === OPENAI_CODEX_GPT_54_MINI_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_MINI_TEMPLATE_MODEL_IDS;
    patch = {
      contextWindow: OPENAI_CODEX_GPT_54_MINI_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      cost: OPENAI_CODEX_GPT_54_MINI_COST,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_SPARK_MODEL_ID) {
    templateIds = [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS];
    patch = {
      api: "openai-codex-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_MODEL_ID) {
    templateIds = OPENAI_CODEX_TEMPLATE_MODEL_IDS;
  } else {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId:
        lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID
          ? OPENAI_CODEX_GPT_54_MODEL_ID
          : trimmedModelId,
      templateIds,
      ctx,
      patch,
    }) ??
    normalizeModelCompat({
      id:
        lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID
          ? OPENAI_CODEX_GPT_54_MODEL_ID
          : trimmedModelId,
      name:
        lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID
          ? OPENAI_CODEX_GPT_54_MODEL_ID
          : trimmedModelId,
      api: "openai-codex-responses",
      provider: PROVIDER_ID,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: patch?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      contextTokens: patch?.contextTokens,
      maxTokens: patch?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    } as ProviderRuntimeModel)
  );
}

async function refreshOpenAICodexOAuthCredential(cred: OAuthCredential) {
  try {
    const { refreshOpenAICodexToken } = await import("./openai-codex-provider.runtime.js");
    const refreshed = await refreshOpenAICodexToken(cred.refresh);
    return {
      ...cred,
      ...refreshed,
      type: "oauth" as const,
      provider: PROVIDER_ID,
      email: cred.email,
      displayName: cred.displayName,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    if (
      /extract\s+accountid\s+from\s+token/i.test(message) &&
      typeof cred.access === "string" &&
      cred.access.trim().length > 0
    ) {
      return cred;
    }
    throw error;
  }
}

async function runOpenAICodexOAuth(ctx: ProviderAuthContext) {
  let creds;
  try {
    creds = await loginOpenAICodexOAuth({
      prompter: ctx.prompter,
      runtime: ctx.runtime,
      isRemote: ctx.isRemote,
      openUrl: ctx.openUrl,
      localBrowserMessage: "Complete sign-in in browser…",
    });
  } catch {
    return { profiles: [] };
  }
  if (!creds) {
    return { profiles: [] };
  }

  const identity = resolveCodexAuthIdentity({
    accessToken: creds.access,
    email: readStringValue(creds.email),
  });

  return buildOauthProviderAuthResult({
    providerId: PROVIDER_ID,
    defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    email: identity.email,
    profileName: identity.profileName,
  });
}

async function runOpenAICodexDeviceCode(ctx: ProviderAuthContext) {
  const spin = ctx.prompter.progress("Starting device code flow…");
  try {
    const creds = await loginOpenAICodexDeviceCode({
      onProgress: (message) => spin.update(message),
      onVerification: async ({ verificationUrl, userCode, expiresInMs }) => {
        const expiresInMinutes = Math.max(1, Math.round(expiresInMs / 60_000));
        const codeLine = ctx.isRemote
          ? "Code: [shown on the local device only]"
          : `Code: ${userCode}`;
        await ctx.prompter.note(
          [
            ctx.isRemote
              ? "Open this URL in your LOCAL browser and enter the code below."
              : "Open this URL in your browser and enter the code below.",
            `URL: ${verificationUrl}`,
            codeLine,
            `Code expires in ${expiresInMinutes} minutes. Never share it.`,
          ].join("\n"),
          "OpenAI Codex device code",
        );
        if (ctx.isRemote) {
          ctx.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${verificationUrl}\n`);
          return;
        }
        try {
          await ctx.openUrl(verificationUrl);
          ctx.runtime.log(`Open: ${verificationUrl}`);
        } catch {
          ctx.runtime.log(`Open manually: ${verificationUrl}`);
        }
      },
    });
    spin.stop("OpenAI device code complete");

    const identity = resolveCodexAuthIdentity({
      accessToken: creds.access,
    });

    return buildOauthProviderAuthResult({
      providerId: PROVIDER_ID,
      defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      email: identity.email,
      profileName: identity.profileName,
    });
  } catch (error) {
    spin.stop("OpenAI device code failed");
    ctx.runtime.error(formatErrorMessage(error));
    await ctx.prompter.note(
      "Trouble with device code login? See https://docs.openclaw.ai/start/faq",
      "OAuth help",
    );
    throw error;
  }
}

function buildOpenAICodexAuthDoctorHint(ctx: { profileId?: string }) {
  if (ctx.profileId !== CODEX_CLI_PROFILE_ID) {
    return undefined;
  }
  return "Deprecated profile. Run `openclaw models auth login --provider openai-codex` or `openclaw configure`.";
}

export function buildOpenAICodexProviderPlugin(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "OpenAI Codex",
    docsPath: "/providers/models",
    oauthProfileIdRepairs: [
      {
        legacyProfileId: "openai-codex:default",
        promptLabel: "OpenAI Codex",
      },
    ],
    auth: [
      {
        id: "oauth",
        label: OPENAI_CODEX_LOGIN_LABEL,
        hint: OPENAI_CODEX_LOGIN_HINT,
        kind: "oauth",
        wizard: {
          choiceId: "openai-codex",
          choiceLabel: OPENAI_CODEX_LOGIN_LABEL,
          choiceHint: OPENAI_CODEX_LOGIN_HINT,
          assistantPriority: OPENAI_CODEX_LOGIN_ASSISTANT_PRIORITY,
          ...OPENAI_WIZARD_GROUP,
        },
        run: async (ctx) => await runOpenAICodexOAuth(ctx),
      },
      {
        id: "device-code",
        label: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
        hint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
        kind: "device_code",
        wizard: {
          choiceId: "openai-codex-device-code",
          choiceLabel: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
          choiceHint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
          assistantPriority: OPENAI_CODEX_DEVICE_PAIRING_ASSISTANT_PRIORITY,
          ...OPENAI_WIZARD_GROUP,
        },
        run: async (ctx) => {
          try {
            return await runOpenAICodexDeviceCode(ctx);
          } catch {
            return { profiles: [] };
          }
        },
      },
    ],
    catalog: {
      order: "profile",
      run: async (ctx) => {
        const authStore = ensureAuthProfileStoreForLocalUpdate(ctx.agentDir);
        if (listProfilesForProvider(authStore, PROVIDER_ID).length === 0) {
          return null;
        }
        return {
          provider: buildOpenAICodexProvider(),
        };
      },
    },
    resolveDynamicModel: (ctx) => resolveCodexForwardCompatModel(ctx),
    buildAuthDoctorHint: (ctx) => buildOpenAICodexAuthDoctorHint(ctx),
    resolveThinkingProfile: ({ modelId }) => ({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        ...(matchesExactOrPrefix(modelId, OPENAI_CODEX_XHIGH_MODEL_IDS)
          ? [{ id: "xhigh" as const }]
          : []),
      ],
    }),
    isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_CODEX_MODERN_MODEL_IDS),
    preferRuntimeResolvedModel: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return false;
      }
      const id = ctx.modelId.trim().toLowerCase();
      return id === OPENAI_CODEX_GPT_54_MODEL_ID || id === OPENAI_CODEX_GPT_54_PRO_MODEL_ID;
    },
    ...buildOpenAIResponsesProviderHooks(),
    resolveReasoningOutputMode: () => "native",
    normalizeResolvedModel: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return undefined;
      }
      return normalizeCodexTransport(ctx.model);
    },
    normalizeTransport: ({ provider, api, baseUrl }) => {
      if (normalizeProviderId(provider) !== PROVIDER_ID) {
        return undefined;
      }
      const normalized = normalizeCodexTransportFields({ api, baseUrl });
      if (normalized.api === api && normalized.baseUrl === baseUrl) {
        return undefined;
      }
      return normalized;
    },
    resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
    fetchUsageSnapshot: async (ctx) =>
      await fetchCodexUsage(ctx.token, ctx.accountId, ctx.timeoutMs, ctx.fetchFn),
    refreshOAuth: async (cred) => await refreshOpenAICodexOAuthCredential(cred),
    augmentModelCatalog: (ctx) => {
      const gpt54Template = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS,
      });
      const gpt54MiniTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_CODEX_GPT_54_MINI_TEMPLATE_MODEL_IDS,
      });
      const sparkTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS],
      });
      return [
        buildOpenAISyntheticCatalogEntry(gpt54Template, {
          id: OPENAI_CODEX_GPT_54_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
          contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
          cost: OPENAI_CODEX_GPT_54_COST,
        }),
        buildOpenAISyntheticCatalogEntry(gpt54Template, {
          id: OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
          contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
          cost: OPENAI_CODEX_GPT_54_PRO_COST,
        }),
        buildOpenAISyntheticCatalogEntry(gpt54MiniTemplate, {
          id: OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_CODEX_GPT_54_MINI_CONTEXT_TOKENS,
          cost: OPENAI_CODEX_GPT_54_MINI_COST,
        }),
        buildOpenAISyntheticCatalogEntry(sparkTemplate, {
          id: OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
          reasoning: true,
          input: ["text"],
          contextWindow: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
        }),
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
  };
}
