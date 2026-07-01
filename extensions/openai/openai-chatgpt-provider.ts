// Openai provider module implements model/runtime integration.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthResult,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { CODEX_CLI_PROFILE_ID, type OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
  normalizeProviderId,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { fetchCodexUsage } from "openclaw/plugin-sdk/provider-usage";
import {
  normalizeLowercaseStringOrEmpty,
  readStringValue,
  uniqueValues,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
  OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
  OPENAI_CHATGPT_LOGIN_HINT,
  OPENAI_CHATGPT_LOGIN_LABEL,
  OPENAI_CODEX_WIZARD_GROUP,
} from "./auth-choice-copy.js";
import {
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  OPENAI_CODEX_RESPONSES_BASE_URL,
} from "./base-url.js";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./default-models.js";
import { resolveCodexAuthIdentity } from "./openai-chatgpt-auth-identity.js";
import { loginOpenAICodexDeviceCode } from "./openai-chatgpt-device-code.js";
import { loginOpenAICodexOAuth } from "./openai-chatgpt-oauth.runtime.js";
import {
  buildOpenAIResponsesProviderHooks,
  buildOpenAISyntheticCatalogEntry,
  cloneFirstTemplateModel,
  findCatalogTemplate,
  matchesExactOrPrefix,
} from "./shared.js";
import { resolveOpenAICodexThinkingProfile } from "./thinking-policy.js";

const PROVIDER_ID = "openai";
const OPENAI_CODEX_BASE_URL = OPENAI_CODEX_RESPONSES_BASE_URL;
const OPENAI_CODEX_LOGIN_ASSISTANT_PRIORITY = -30;
const OPENAI_CODEX_DEVICE_PAIRING_ASSISTANT_PRIORITY = -10;
const OPENAI_CODEX_GPT_56_MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
const OPENAI_CODEX_GPT_56_THINKING_LEVEL_MAP = {
  off: null,
  xhigh: "xhigh",
  max: "max",
} as const;
const OPENAI_CODEX_GPT_55_MODEL_ID = "gpt-5.5";
const OPENAI_CODEX_GPT_55_PRO_MODEL_ID = "gpt-5.5-pro";
const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID = "gpt-5.4-codex";
const OPENAI_CODEX_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_CODEX_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_CODEX_GPT_53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_GPT_56_CONTEXT_TOKENS = 372_000;
const OPENAI_CODEX_GPT_55_CODEX_CONTEXT_TOKENS = 400_000;
const OPENAI_CODEX_GPT_55_DEFAULT_RUNTIME_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_55_PRO_NATIVE_CONTEXT_TOKENS = 1_000_000;
const OPENAI_CODEX_GPT_55_PRO_DEFAULT_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS = 1_050_000;
const OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_54_MINI_NATIVE_CONTEXT_TOKENS = 400_000;
const OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS = 128_000;
const OPENAI_CODEX_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_CODEX_GPT_55_PRO_COST = {
  input: 30,
  output: 180,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
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
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex"] as const;
/** Legacy codex rows first; fall back to catalog `gpt-5.4` when the API omits 5.3/5.2. */
const OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS = [
  ...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
  OPENAI_CODEX_GPT_54_MODEL_ID,
] as const;
const OPENAI_CODEX_GPT_55_PRO_TEMPLATE_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
  ...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
] as const;
const OPENAI_CODEX_MODERN_MODEL_IDS = [
  ...OPENAI_CODEX_GPT_56_MODEL_IDS,
  OPENAI_CODEX_GPT_55_MODEL_ID,
  OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
  OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
  OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
] as const;
const OPENAI_CODEX_IMAGE_CAPABLE_MODEL_IDS = [
  ...OPENAI_CODEX_GPT_56_MODEL_IDS,
  OPENAI_CODEX_GPT_55_MODEL_ID,
  OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
  OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
] as const;

function isOpenAIOrLegacyCodexProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === PROVIDER_ID;
}

function isLegacyCodexCompatBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  return (
    trimmed !== undefined && /^https?:\/\/api\.githubcopilot\.com(?:\/v1)?\/?$/iu.test(trimmed)
  );
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
      ? "openai-chatgpt-responses"
      : (params.api ?? undefined);
  const baseUrl =
    api === "openai-chatgpt-responses" && useCodexTransport
      ? OPENAI_CODEX_BASE_URL
      : params.baseUrl;
  return { api, baseUrl };
}

function hasImageInput(input: unknown): boolean {
  return Array.isArray(input) && input.includes("image");
}

function matchesOpenAICodexImageCapableModel(modelId: string, modelName?: string): boolean {
  return [modelId, modelName]
    .filter((value): value is string => typeof value === "string")
    .some((candidate) => matchesExactOrPrefix(candidate, OPENAI_CODEX_IMAGE_CAPABLE_MODEL_IDS));
}

/**
 * Restore native `["text", "image"]` input capability on resolved Codex rows
 * for known image-capable modern model IDs (GPT-5.4 through GPT-5.6).
 * Persisted/configured model rows can omit the `input` field
 * entirely when they were written by older OpenClaw versions. When that row wins
 * the catalog merge, `modelSupportsInput(entry, "image")` returns false and the
 * gateway's `chat.send` handler offloads inbound images as `media://inbound/<id>`
 * claim-check URIs instead of inlining them.
 *
 * Mirrors the Anthropic precedent set by upstream #83756.
 */
function applyOpenAICodexImageInputCapability(params: {
  modelId: string;
  model: ProviderRuntimeModel;
}): ProviderRuntimeModel | undefined {
  if (hasImageInput(params.model.input)) {
    return undefined;
  }
  if (!matchesOpenAICodexImageCapableModel(params.modelId, params.model.name)) {
    return undefined;
  }
  return {
    ...params.model,
    input: ["text", "image"],
  };
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
  const synthBaseUrl = ctx.providerConfig?.baseUrl ?? OPENAI_CODEX_BASE_URL;

  if (OPENAI_CODEX_GPT_56_MODEL_IDS.some((modelId) => modelId === lower)) {
    const model = ctx.modelRegistry.find(PROVIDER_ID, trimmedModelId) as
      | ProviderRuntimeModel
      | undefined;
    const registeredModel = withDefaultCodexContextMetadata({
      model: withCodexTransport(model, synthBaseUrl),
      contextWindow: OPENAI_CODEX_GPT_56_CONTEXT_TOKENS,
      contextTokens: OPENAI_CODEX_GPT_56_CONTEXT_TOKENS,
    });
    if (registeredModel) {
      return normalizeModelCompat({
        ...registeredModel,
        thinkingLevelMap: {
          ...OPENAI_CODEX_GPT_56_THINKING_LEVEL_MAP,
          ...registeredModel.thinkingLevelMap,
        },
      } as ProviderRuntimeModel);
    }
    return normalizeModelCompat({
      id: trimmedModelId,
      name: trimmedModelId,
      api: "openai-chatgpt-responses",
      provider: PROVIDER_ID,
      baseUrl: synthBaseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: OPENAI_CODEX_GPT_56_CONTEXT_TOKENS,
      contextTokens: OPENAI_CODEX_GPT_56_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      thinkingLevelMap: OPENAI_CODEX_GPT_56_THINKING_LEVEL_MAP,
    } as ProviderRuntimeModel);
  }

  if (lower === OPENAI_CODEX_GPT_55_MODEL_ID) {
    const model = ctx.modelRegistry.find(PROVIDER_ID, trimmedModelId) as
      | ProviderRuntimeModel
      | undefined;
    return (
      withDefaultCodexContextMetadata({
        model: withCodexTransport(model, synthBaseUrl),
        contextWindow: OPENAI_CODEX_GPT_55_CODEX_CONTEXT_TOKENS,
        contextTokens: OPENAI_CODEX_GPT_55_DEFAULT_RUNTIME_CONTEXT_TOKENS,
      }) ??
      normalizeModelCompat({
        id: trimmedModelId,
        name: trimmedModelId,
        api: "openai-chatgpt-responses",
        provider: PROVIDER_ID,
        baseUrl: synthBaseUrl,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: OPENAI_CODEX_GPT_55_CODEX_CONTEXT_TOKENS,
        contextTokens: OPENAI_CODEX_GPT_55_DEFAULT_RUNTIME_CONTEXT_TOKENS,
        maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      } as ProviderRuntimeModel)
    );
  }

  let templateIds: readonly string[];
  let patch: Parameters<typeof cloneFirstTemplateModel>[0]["patch"];
  if (lower === OPENAI_CODEX_GPT_55_PRO_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_55_PRO_TEMPLATE_MODEL_IDS;
    patch = {
      contextWindow: OPENAI_CODEX_GPT_55_PRO_NATIVE_CONTEXT_TOKENS,
      contextTokens: OPENAI_CODEX_GPT_55_PRO_DEFAULT_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      cost: OPENAI_CODEX_GPT_55_PRO_COST,
    };
  } else if (
    lower === OPENAI_CODEX_GPT_54_MODEL_ID ||
    lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID
  ) {
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
    templateIds = OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS;
    patch = {
      contextWindow: OPENAI_CODEX_GPT_54_MINI_NATIVE_CONTEXT_TOKENS,
      contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      cost: OPENAI_CODEX_GPT_54_MINI_COST,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_SPARK_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS;
    patch = {
      input: ["text"],
      contextWindow: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
      contextTokens: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      cost: OPENAI_CODEX_GPT_54_MINI_COST,
    };
  } else {
    return undefined;
  }
  patch = {
    ...patch,
    api: "openai-chatgpt-responses",
    baseUrl: synthBaseUrl,
  };

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
      api: "openai-chatgpt-responses",
      provider: PROVIDER_ID,
      baseUrl: synthBaseUrl,
      reasoning: true,
      input: patch?.input ?? ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: patch?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      contextTokens: patch?.contextTokens,
      maxTokens: patch?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    } as ProviderRuntimeModel)
  );
}

function withDefaultCodexContextMetadata(params: {
  model: ProviderRuntimeModel | undefined;
  contextWindow: number;
  contextTokens: number;
}): ProviderRuntimeModel | undefined {
  if (!params.model) {
    return undefined;
  }
  const contextTokens =
    typeof params.model.contextTokens === "number"
      ? params.model.contextTokens
      : typeof params.model.contextWindow === "number" && params.model.contextWindow > 0
        ? Math.min(params.contextTokens, params.model.contextWindow)
        : params.contextTokens;
  const input = params.model.input?.includes("image")
    ? params.model.input
    : uniqueValues<"text" | "image">([...(params.model.input ?? ["text"]), "image"]);
  return {
    ...params.model,
    input,
    contextWindow: params.contextWindow,
    contextTokens,
  };
}

function withCodexTransport(
  model: ProviderRuntimeModel | undefined,
  baseUrl: string,
): ProviderRuntimeModel | undefined {
  if (!model) {
    return undefined;
  }
  return normalizeModelCompat({
    ...model,
    api: "openai-chatgpt-responses",
    baseUrl,
  } as ProviderRuntimeModel);
}

function buildCodexCredentialExtra(identity: {
  accountId?: string;
  chatgptPlanType?: string;
}): Record<string, unknown> | undefined {
  const extra = {
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
    ...(identity.chatgptPlanType ? { chatgptPlanType: identity.chatgptPlanType } : {}),
  };
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function buildOpenAICodexAuthConfigPatch(): NonNullable<ProviderAuthResult["configPatch"]> {
  return {
    agents: {
      defaults: {
        models: {
          [OPENAI_CODEX_DEFAULT_MODEL]: {},
        },
      },
    },
  };
}

async function refreshOpenAICodexOAuthCredential(cred: OAuthCredential) {
  try {
    const { refreshOpenAICodexToken } = await import("./openai-chatgpt-provider.runtime.js");
    const refreshed = await refreshOpenAICodexToken(cred.refresh);
    const identity = resolveCodexAuthIdentity({
      accessToken: refreshed.access,
      email: cred.email,
    });
    return {
      ...cred,
      ...refreshed,
      type: "oauth" as const,
      provider: PROVIDER_ID,
      email: identity.email ?? cred.email,
      displayName: cred.displayName,
      ...buildCodexCredentialExtra(identity),
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

type OpenAICodexOAuthContext = ProviderAuthContext & {
  signal?: AbortSignal;
  onManualCodeInput?: () => Promise<string>;
};

async function runOpenAICodexOAuth(ctx: OpenAICodexOAuthContext) {
  const creds = await loginOpenAICodexOAuth({
    prompter: ctx.prompter,
    runtime: ctx.runtime,
    oauth: ctx.oauth,
    isRemote: ctx.isRemote,
    openUrl: ctx.openUrl,
    signal: ctx.signal,
    onManualCodeInput: ctx.onManualCodeInput,
    localBrowserMessage: "Complete sign-in in browser…",
  });
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
    configPatch: buildOpenAICodexAuthConfigPatch(),
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    email: identity.email,
    profileName: identity.profileName,
    credentialExtra: buildCodexCredentialExtra(identity),
  });
}

async function runOpenAICodexDeviceCode(ctx: ProviderAuthContext) {
  const spin = ctx.prompter.progress("Starting device code flow…");
  try {
    const creds = await loginOpenAICodexDeviceCode({
      onProgress: (message) => spin.update(message),
      onVerification: async ({ verificationUrl, userCode, expiresInMs }) => {
        const expiresInMinutes = Math.max(1, Math.round(expiresInMs / 60_000));
        // The prompter note is the user-facing TTY surface, so remote/headless
        // users need the code there; keep the persistent runtime log URL-only.
        await ctx.prompter.note(
          [
            ctx.isRemote
              ? "Open this URL in your LOCAL browser and enter the code below."
              : "Open this URL in your browser and enter the code below.",
            `URL: ${verificationUrl}`,
            `Code: ${userCode}`,
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
      configPatch: buildOpenAICodexAuthConfigPatch(),
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      email: identity.email,
      profileName: identity.profileName,
      credentialExtra: buildCodexCredentialExtra(identity),
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
  return "Deprecated profile. Run `openclaw models auth login --provider openai` or `openclaw configure`.";
}

export function buildOpenAIChatGPTAuthMethods(): ProviderAuthMethod[] {
  return [
    {
      id: "oauth",
      label: OPENAI_CHATGPT_LOGIN_LABEL,
      hint: OPENAI_CHATGPT_LOGIN_HINT,
      kind: "oauth",
      wizard: {
        choiceId: "openai",
        choiceLabel: OPENAI_CHATGPT_LOGIN_LABEL,
        choiceHint: OPENAI_CHATGPT_LOGIN_HINT,
        assistantPriority: OPENAI_CODEX_LOGIN_ASSISTANT_PRIORITY,
        onboardingFeatured: true,
        ...OPENAI_CODEX_WIZARD_GROUP,
      },
      run: async (ctx) => await runOpenAICodexOAuth(ctx),
    },
    {
      id: "device-code",
      label: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
      hint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
      kind: "device_code",
      wizard: {
        choiceId: "openai-device-code",
        choiceLabel: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
        choiceHint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
        assistantPriority: OPENAI_CODEX_DEVICE_PAIRING_ASSISTANT_PRIORITY,
        ...OPENAI_CODEX_WIZARD_GROUP,
      },
      run: async (ctx) => await runOpenAICodexDeviceCode(ctx),
    },
  ];
}

export function buildOpenAICodexProviderHooks(): Pick<
  ProviderPlugin,
  | "resolveDynamicModel"
  | "buildAuthDoctorHint"
  | "resolveThinkingProfile"
  | "isModernModelRef"
  | "preferRuntimeResolvedModel"
  | "normalizeResolvedModel"
  | "normalizeTransport"
  | "resolveUsageAuth"
  | "fetchUsageSnapshot"
  | "refreshOAuth"
  | "augmentModelCatalog"
  | "resolveReasoningOutputMode"
> {
  return {
    resolveDynamicModel: (ctx) => resolveCodexForwardCompatModel(ctx),
    buildAuthDoctorHint: (ctx) => buildOpenAICodexAuthDoctorHint(ctx),
    resolveThinkingProfile: ({ modelId }) => resolveOpenAICodexThinkingProfile(modelId),
    isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_CODEX_MODERN_MODEL_IDS),
    preferRuntimeResolvedModel: (ctx) => {
      if (!isOpenAIOrLegacyCodexProvider(ctx.provider)) {
        return false;
      }
      const id = ctx.modelId.trim().toLowerCase();
      return [
        ...OPENAI_CODEX_GPT_56_MODEL_IDS,
        OPENAI_CODEX_GPT_55_MODEL_ID,
        OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
        OPENAI_CODEX_GPT_54_MODEL_ID,
        OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
        OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
        OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
      ].includes(id);
    },
    ...buildOpenAIResponsesProviderHooks(),
    resolveReasoningOutputMode: () => "native",
    normalizeResolvedModel: (ctx) => {
      if (!isOpenAIOrLegacyCodexProvider(ctx.provider)) {
        return undefined;
      }
      const transportNormalized = normalizeCodexTransport(ctx.model);
      const imageCapable =
        applyOpenAICodexImageInputCapability({
          modelId: ctx.modelId,
          model: transportNormalized,
        }) ?? transportNormalized;
      return imageCapable === ctx.model ? undefined : imageCapable;
    },
    normalizeTransport: ({ provider, api, baseUrl }) => {
      if (!isOpenAIOrLegacyCodexProvider(provider)) {
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
      const gpt55ProTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_CODEX_GPT_55_PRO_TEMPLATE_MODEL_IDS,
      });
      return [
        buildOpenAISyntheticCatalogEntry(gpt55ProTemplate, {
          id: OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_CODEX_GPT_55_PRO_NATIVE_CONTEXT_TOKENS,
          contextTokens: OPENAI_CODEX_GPT_55_PRO_DEFAULT_CONTEXT_TOKENS,
          cost: OPENAI_CODEX_GPT_55_PRO_COST,
        }),
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
        buildOpenAISyntheticCatalogEntry(gpt54Template, {
          id: OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_CODEX_GPT_54_MINI_NATIVE_CONTEXT_TOKENS,
          contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
          cost: OPENAI_CODEX_GPT_54_MINI_COST,
        }),
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
  };
}
