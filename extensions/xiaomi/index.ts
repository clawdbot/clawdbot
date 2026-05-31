import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawConfig,
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
  ProviderAuthResult,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  type SecretInput,
  upsertAuthProfileWithLock,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  applyModelCompatPatch,
  buildProviderReplayFamilyHooks,
} from "openclaw/plugin-sdk/provider-model-shared";
import { PROVIDER_LABELS } from "openclaw/plugin-sdk/provider-usage";
import {
  applyXiaomiConfig,
  applyXiaomiTokenPlanConfig,
  XIAOMI_DEFAULT_MODEL_REF,
  XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_REF,
} from "./onboard.js";
import {
  buildXiaomiProvider,
  buildXiaomiTokenPlanProvider,
  XIAOMI_PROVIDER_ID,
  XIAOMI_TOKEN_PLAN_PROVIDER_ID,
  type XiaomiTokenPlanRegion,
} from "./provider-catalog.js";
import { buildXiaomiSpeechProvider } from "./speech-provider.js";
import { createMiMoThinkingWrapper } from "./stream.js";
import { resolveMiMoThinkingProfile } from "./thinking.js";

type UpsertAuthProfileParams = Parameters<typeof upsertAuthProfileWithLock>[0];

const PAYG_FLAG_NAME = "--xiaomi-api-key";
const PAYG_OPTION_KEY = "xiaomiApiKey";
const PAYG_ENV_VAR = "XIAOMI_API_KEY";
const TOKEN_PLAN_FLAG_NAME = "--xiaomi-token-plan-api-key";
const TOKEN_PLAN_OPTION_KEY = "xiaomiTokenPlanApiKey";
const TOKEN_PLAN_ENV_VAR = "XIAOMI_TOKEN_PLAN_API_KEY";
const XIAOMI_WIZARD_GROUP = {
  groupId: "xiaomi",
  groupLabel: "Xiaomi",
  groupHint: "Pay-as-you-go / Token Plan",
};
const XIAOMI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "openai-compatible",
    dropReasoningFromHistory: false,
  }),
  normalizeResolvedModel: ({ model }: { model: ProviderRuntimeModel }) =>
    applyModelCompatPatch(model, { omitEmptyArrayItems: true }),
  wrapStreamFn: (ctx: {
    streamFn?: Parameters<typeof createMiMoThinkingWrapper>[0];
    thinkingLevel?: Parameters<typeof createMiMoThinkingWrapper>[1];
  }) => createMiMoThinkingWrapper(ctx.streamFn, ctx.thinkingLevel),
  resolveThinkingProfile: ({ modelId }: { modelId: string }) => resolveMiMoThinkingProfile(modelId),
  isModernModelRef: ({ modelId }: { modelId: string }) =>
    Boolean(resolveMiMoThinkingProfile(modelId)),
};

function trimConfiguredBaseUrl(
  ctx: ProviderCatalogContext,
  providerId: string,
): string | undefined {
  const configuredProvider = ctx.config.models?.providers?.[providerId];
  const baseUrl =
    typeof configuredProvider?.baseUrl === "string" ? configuredProvider.baseUrl.trim() : "";
  return baseUrl || undefined;
}

function hasConfiguredProviderEntry(ctx: ProviderCatalogContext, providerId: string): boolean {
  const configuredProvider = ctx.config.models?.providers?.[providerId];
  return Boolean(configuredProvider && typeof configuredProvider === "object");
}

function resolveXiaomiCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: () => ReturnType<typeof buildXiaomiProvider>;
  requireConfiguredProvider?: boolean;
  requireBaseUrl?: boolean;
}) {
  const apiKey = params.ctx.resolveProviderApiKey(params.providerId).apiKey;
  if (!apiKey) {
    return null;
  }
  if (
    params.requireConfiguredProvider === true &&
    !hasConfiguredProviderEntry(params.ctx, params.providerId)
  ) {
    return null;
  }
  const explicitBaseUrl = trimConfiguredBaseUrl(params.ctx, params.providerId);
  if (params.requireBaseUrl === true && !explicitBaseUrl) {
    return null;
  }
  return {
    provider: {
      ...params.buildProvider(),
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
      apiKey,
    },
  };
}

async function upsertAuthProfileWithLockOrThrow(params: UpsertAuthProfileParams): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throw new Error(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  }
}

function buildXiaomiKeyMismatchMessage(params: {
  actualKey: string;
  expectedKind: "payg" | "token-plan";
}): string | undefined {
  const normalized = params.actualKey.trim().toLowerCase();
  const expectedPrefix = params.expectedKind === "payg" ? "sk-" : "tp-";
  const kindLabel = params.expectedKind === "payg" ? "pay-as-you-go" : "Token Plan";

  if (normalized.startsWith(expectedPrefix)) {
    return undefined;
  }
  if (params.expectedKind === "payg" && normalized.startsWith("tp-")) {
    return (
      "This looks like a Xiaomi MiMo Token Plan key (tp-...). " +
      "Re-run onboarding with one of: --auth-choice xiaomi-token-plan-cn, " +
      "--auth-choice xiaomi-token-plan-sgp, or --auth-choice xiaomi-token-plan-ams."
    );
  }
  if (params.expectedKind === "token-plan" && normalized.startsWith("sk-")) {
    return (
      "This looks like a Xiaomi MiMo pay-as-you-go key (sk-...). " +
      `Re-run onboarding with --auth-choice xiaomi-api-key or pass ${PAYG_FLAG_NAME}.`
    );
  }
  return (
    `Xiaomi MiMo ${kindLabel} keys must start with "${expectedPrefix}". ` +
    "The entered key does not match the expected format."
  );
}

function assertCompatibleXiaomiKey(params: {
  actualKey: string;
  expectedKind: "payg" | "token-plan";
}): void {
  const message = buildXiaomiKeyMismatchMessage(params);
  if (message) {
    throw new Error(message);
  }
}

function resolveProfileId(providerId: string): string {
  return `${providerId}:default`;
}

async function runXiaomiApiKeyAuth(
  ctx: ProviderAuthContext,
  params: {
    providerId: string;
    optionKey: string;
    envVar: string;
    promptMessage: string;
    expectedKind: "payg" | "token-plan";
    defaultModel: string;
    applyConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  },
): Promise<ProviderAuthResult> {
  let capturedSecretInput: SecretInput | undefined;
  let capturedCredential = false;
  let capturedMode: "plaintext" | "ref" | undefined;
  const profileId = resolveProfileId(params.providerId);
  const apiKey = await ensureApiKeyFromOptionEnvOrPrompt({
    token:
      normalizeOptionalSecretInput(ctx.opts?.[params.optionKey]) ??
      normalizeOptionalSecretInput(ctx.opts?.token),
    tokenProvider: normalizeOptionalSecretInput(ctx.opts?.[params.optionKey])
      ? params.providerId
      : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
    secretInputMode:
      ctx.allowSecretRefPrompt === false
        ? (ctx.secretInputMode ?? "plaintext")
        : ctx.secretInputMode,
    config: ctx.config,
    env: ctx.env,
    expectedProviders: [params.providerId],
    provider: params.providerId,
    envLabel: params.envVar,
    promptMessage: params.promptMessage,
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: ctx.prompter,
    setCredential: async (key, mode) => {
      capturedSecretInput = key;
      capturedCredential = true;
      capturedMode = mode;
    },
  });
  assertCompatibleXiaomiKey({
    actualKey: apiKey,
    expectedKind: params.expectedKind,
  });
  if (!capturedCredential) {
    throw new Error(`Missing Xiaomi API key for provider "${params.providerId}".`);
  }
  const credentialInput = capturedSecretInput ?? "";
  return {
    profiles: [
      {
        profileId,
        credential: buildApiKeyCredential(
          params.providerId,
          credentialInput,
          undefined,
          capturedMode ? { secretInputMode: capturedMode } : undefined,
        ),
      },
    ],
    configPatch: params.applyConfig(ctx.config),
    defaultModel: params.defaultModel,
  };
}

async function runXiaomiApiKeyAuthNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
  params: {
    providerId: string;
    optionKey: string;
    flagName: `--${string}`;
    envVar: string;
    expectedKind: "payg" | "token-plan";
    applyConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  },
) {
  const resolved = await ctx.resolveApiKey({
    provider: params.providerId,
    flagValue: normalizeOptionalSecretInput(ctx.opts[params.optionKey]),
    flagName: params.flagName,
    envVar: params.envVar,
  });
  if (!resolved) {
    return null;
  }
  assertCompatibleXiaomiKey({
    actualKey: resolved.key,
    expectedKind: params.expectedKind,
  });

  const profileId = resolveProfileId(params.providerId);
  if (resolved.source !== "profile") {
    const credential = ctx.toApiKeyCredential({
      provider: params.providerId,
      resolved,
    });
    if (!credential) {
      return null;
    }
    await upsertAuthProfileWithLockOrThrow({
      profileId,
      credential,
      agentDir: ctx.agentDir,
    });
  }

  const next = applyAuthProfileConfig(ctx.config, {
    profileId,
    provider: params.providerId,
    mode: "api_key",
  });
  return params.applyConfig(next);
}

function createPaygAuthMethod(): ProviderAuthMethod {
  return {
    id: "api-key",
    label: "Xiaomi API key (Pay-as-you-go)",
    hint: "Endpoint: api.xiaomimimo.com/v1",
    kind: "api_key",
    wizard: {
      choiceId: "xiaomi-api-key",
      choiceLabel: "Xiaomi API key (Pay-as-you-go)",
      choiceHint: "Endpoint: api.xiaomimimo.com/v1",
      ...XIAOMI_WIZARD_GROUP,
    },
    run: async (ctx) =>
      await runXiaomiApiKeyAuth(ctx, {
        providerId: XIAOMI_PROVIDER_ID,
        optionKey: PAYG_OPTION_KEY,
        envVar: PAYG_ENV_VAR,
        promptMessage: "Enter Xiaomi MiMo API key (pay-as-you-go, sk-...)",
        expectedKind: "payg",
        defaultModel: XIAOMI_DEFAULT_MODEL_REF,
        applyConfig: applyXiaomiConfig,
      }),
    runNonInteractive: async (ctx) =>
      await runXiaomiApiKeyAuthNonInteractive(ctx, {
        providerId: XIAOMI_PROVIDER_ID,
        optionKey: PAYG_OPTION_KEY,
        flagName: PAYG_FLAG_NAME,
        envVar: PAYG_ENV_VAR,
        expectedKind: "payg",
        applyConfig: applyXiaomiConfig,
      }),
  };
}

function createTokenPlanAuthMethod(region: XiaomiTokenPlanRegion): ProviderAuthMethod {
  const regionLabel = region === "ams" ? "Europe" : region === "cn" ? "China" : "Singapore";
  const choiceId = `xiaomi-token-plan-${region}`;
  const choiceLabel = `Xiaomi Token Plan (${regionLabel})`;
  const choiceHint = `Endpoint preset: token-plan-${region}.xiaomimimo.com/v1`;
  return {
    id: `token-plan-${region}`,
    label: choiceLabel,
    hint: choiceHint,
    kind: "api_key",
    wizard: {
      choiceId,
      choiceLabel,
      choiceHint,
      ...XIAOMI_WIZARD_GROUP,
    },
    run: async (ctx) =>
      await runXiaomiApiKeyAuth(ctx, {
        providerId: XIAOMI_TOKEN_PLAN_PROVIDER_ID,
        optionKey: TOKEN_PLAN_OPTION_KEY,
        envVar: TOKEN_PLAN_ENV_VAR,
        promptMessage: `Enter Xiaomi MiMo Token Plan API key (tp-...) for ${regionLabel}`,
        expectedKind: "token-plan",
        defaultModel: XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyXiaomiTokenPlanConfig(cfg, region),
      }),
    runNonInteractive: async (ctx) =>
      await runXiaomiApiKeyAuthNonInteractive(ctx, {
        providerId: XIAOMI_TOKEN_PLAN_PROVIDER_ID,
        optionKey: TOKEN_PLAN_OPTION_KEY,
        flagName: TOKEN_PLAN_FLAG_NAME,
        envVar: TOKEN_PLAN_ENV_VAR,
        expectedKind: "token-plan",
        applyConfig: (cfg) => applyXiaomiTokenPlanConfig(cfg, region),
      }),
  };
}

export default definePluginEntry({
  id: XIAOMI_PROVIDER_ID,
  name: "Xiaomi Provider",
  description: "Bundled Xiaomi provider plugin",
  register(api) {
    api.registerProvider({
      id: XIAOMI_PROVIDER_ID,
      label: "Xiaomi",
      docsPath: "/providers/xiaomi",
      envVars: [PAYG_ENV_VAR],
      auth: [createPaygAuthMethod()],
      catalog: {
        order: "simple",
        run: async (ctx) =>
          resolveXiaomiCatalog({
            ctx,
            providerId: XIAOMI_PROVIDER_ID,
            buildProvider: buildXiaomiProvider,
          }),
      },
      ...XIAOMI_PROVIDER_HOOKS,
      resolveUsageAuth: async (ctx) => {
        const apiKey = ctx.resolveApiKeyFromConfigAndStore({
          providerIds: [XIAOMI_PROVIDER_ID],
          envDirect: [ctx.env.XIAOMI_API_KEY],
        });
        return apiKey ? { token: apiKey } : null;
      },
      fetchUsageSnapshot: async () => ({
        provider: XIAOMI_PROVIDER_ID,
        displayName: PROVIDER_LABELS.xiaomi,
        windows: [],
      }),
    });

    api.registerProvider({
      id: XIAOMI_TOKEN_PLAN_PROVIDER_ID,
      label: "Xiaomi Token Plan",
      docsPath: "/providers/xiaomi",
      envVars: [TOKEN_PLAN_ENV_VAR],
      auth: [
        createTokenPlanAuthMethod("ams"),
        createTokenPlanAuthMethod("cn"),
        createTokenPlanAuthMethod("sgp"),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) =>
          resolveXiaomiCatalog({
            ctx,
            providerId: XIAOMI_TOKEN_PLAN_PROVIDER_ID,
            buildProvider: buildXiaomiTokenPlanProvider,
            requireConfiguredProvider: true,
            requireBaseUrl: true,
          }),
      },
      ...XIAOMI_PROVIDER_HOOKS,
      resolveUsageAuth: async (ctx) => {
        const apiKey = ctx.resolveApiKeyFromConfigAndStore({
          providerIds: [XIAOMI_TOKEN_PLAN_PROVIDER_ID],
          envDirect: [ctx.env.XIAOMI_TOKEN_PLAN_API_KEY],
        });
        return apiKey ? { token: apiKey } : null;
      },
      fetchUsageSnapshot: async () => ({
        provider: XIAOMI_TOKEN_PLAN_PROVIDER_ID,
        displayName: "Xiaomi MiMo Token Plan",
        windows: [],
      }),
    });

    api.registerSpeechProvider(buildXiaomiSpeechProvider());
  },
});
