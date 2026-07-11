/**
 * Anthropic provider runtime registration. It owns API-key/setup-token/Claude
 * CLI auth, dynamic model normalization, usage auth, media, and stream wrappers.
 */
import { formatCliCommand, parseDurationMs } from "openclaw/plugin-sdk/cli-runtime";
import { resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderResolveDynamicModelContext,
  ProviderNormalizeResolvedModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  type AuthProfileStore,
  buildTokenProfileId,
  createProviderApiKeyAuthMethod,
  listProfilesForProvider,
  type OpenClawConfig as ProviderAuthConfig,
  type ProviderAuthResult,
  suggestOAuthProfileIdForLegacyDefault,
  upsertAuthProfileWithLock,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";
import {
  cloneFirstTemplateModel,
  modelCostsEqual,
  NATIVE_ANTHROPIC_REPLAY_HOOKS,
  type ProviderPlugin,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  resolveClaudeThinkingProfile,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import * as claudeCliAuth from "./cli-auth-seam.js";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { buildClaudeCliCatalogEntries } from "./cli-catalog.js";
import { buildAnthropicCliMigrationResult } from "./cli-migration.js";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_OFF_THINKING_PROFILE,
} from "./cli-shared.js";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfigForProvider,
} from "./config-defaults.js";
import { anthropicMediaUnderstandingProvider } from "./media-understanding-provider.js";
import {
  createClaudeSessionNodeHostCommands,
  createClaudeSessionNodeInvokePolicies,
  registerClaudeSessionCatalog,
} from "./session-catalog.js";
import { wrapAnthropicProviderStream } from "./stream-wrappers.js";
import { fetchAnthropicUsage, resolveAnthropicUsageAuth } from "./usage.js";

const PROVIDER_ID = "anthropic";
type UpsertAuthProfileParams = Parameters<typeof upsertAuthProfileWithLock>[0];
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-opus-4-8";
const ANTHROPIC_OPUS_48_MODEL_ID = "claude-opus-4-8";
const ANTHROPIC_OPUS_48_DOT_MODEL_ID = "claude-opus-4.8";
const ANTHROPIC_OPUS_47_MODEL_ID = "claude-opus-4-7";
const ANTHROPIC_OPUS_47_DOT_MODEL_ID = "claude-opus-4.7";
const ANTHROPIC_GA_1M_CONTEXT_TOKENS = 1_048_576;
const ANTHROPIC_EXACT_1M_CONTEXT_TOKENS = 1_000_000;
const ANTHROPIC_MODERN_MAX_OUTPUT_TOKENS = 128_000;
// Anthropic's introductory rate expires at the documented UTC month boundary.
const ANTHROPIC_SONNET_5_STANDARD_PRICING_START_MS = Date.UTC(2026, 8, 1);
const ANTHROPIC_SONNET_5_PROMOTIONAL_COST = {
  input: 2,
  output: 10,
  cacheRead: 0.2,
  cacheWrite: 2.5,
};
const ANTHROPIC_SONNET_5_STANDARD_COST = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS = [
  ANTHROPIC_OPUS_46_MODEL_ID,
  ANTHROPIC_OPUS_46_DOT_MODEL_ID,
] as const;
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";
const ANTHROPIC_SETUP_TOKEN_NOTE_LINES = [
  "Anthropic setup-token auth is supported in OpenClaw.",
  "OpenClaw prefers Claude CLI reuse when it is available on the host.",
  "Anthropic staff told us this OpenClaw path is allowed again.",
  `If you want a direct API billing path instead, use ${formatCliCommand("openclaw models auth login --provider anthropic --method api-key --set-default")} or ${formatCliCommand("openclaw models auth login --provider anthropic --method cli --set-default")}.`,
] as const;

function resolveAnthropicSonnet5Cost(nowMs: number = Date.now()) {
  return nowMs >= ANTHROPIC_SONNET_5_STANDARD_PRICING_START_MS
    ? ANTHROPIC_SONNET_5_STANDARD_COST
    : ANTHROPIC_SONNET_5_PROMOTIONAL_COST;
}

const CLAUDE_CLI_CANONICAL_ALLOWLIST_REFS = CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS.map((ref) =>
  ref.startsWith(`${CLAUDE_CLI_BACKEND_ID}/`)
    ? `anthropic/${ref.slice(CLAUDE_CLI_BACKEND_ID.length + 1)}`
    : ref,
);

async function upsertAuthProfileWithLockOrThrow(params: UpsertAuthProfileParams): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throw new Error(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  }
}
const CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF = CLAUDE_CLI_DEFAULT_MODEL_REF.startsWith(
  `${CLAUDE_CLI_BACKEND_ID}/`,
)
  ? `anthropic/${CLAUDE_CLI_DEFAULT_MODEL_REF.slice(CLAUDE_CLI_BACKEND_ID.length + 1)}`
  : CLAUDE_CLI_DEFAULT_MODEL_REF;

function normalizeAnthropicSetupTokenInput(value: string): string {
  return value.replaceAll(/\s+/g, "").trim();
}

function resolveAnthropicSetupTokenProfileId(rawProfileId?: unknown): string {
  if (typeof rawProfileId === "string") {
    const trimmed = rawProfileId.trim();
    if (trimmed.length > 0) {
      if (trimmed.startsWith(`${PROVIDER_ID}:`)) {
        return trimmed;
      }
      return buildTokenProfileId({ provider: PROVIDER_ID, name: trimmed });
    }
  }
  return `${PROVIDER_ID}:default`;
}

function resolveAnthropicSetupTokenExpiry(rawExpiresIn?: unknown): number | undefined {
  if (typeof rawExpiresIn !== "string" || rawExpiresIn.trim().length === 0) {
    return undefined;
  }
  return resolveExpiresAtMsFromDurationMs(
    parseDurationMs(rawExpiresIn.trim(), { defaultUnit: "d" }),
  );
}

async function runAnthropicSetupTokenAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const providedToken =
    typeof ctx.opts?.token === "string" && ctx.opts.token.trim().length > 0
      ? normalizeAnthropicSetupTokenInput(ctx.opts.token)
      : undefined;
  const token =
    providedToken ??
    normalizeAnthropicSetupTokenInput(
      await ctx.prompter.text({
        message: "Paste Anthropic setup-token",
        validate: (value) => validateAnthropicSetupToken(normalizeAnthropicSetupTokenInput(value)),
      }),
    );
  const tokenError = validateAnthropicSetupToken(token);
  if (tokenError) {
    throw new Error(tokenError);
  }

  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts?.tokenProfileId);
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts?.tokenExpiresIn);

  return {
    profiles: [
      {
        profileId,
        credential: {
          type: "token",
          provider: PROVIDER_ID,
          token,
          ...(expires ? { expires } : {}),
        },
      },
    ],
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    notes: [...ANTHROPIC_SETUP_TOKEN_NOTE_LINES],
  };
}

async function runAnthropicSetupTokenNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<ProviderAuthConfig | null> {
  const rawToken =
    typeof ctx.opts.token === "string" ? normalizeAnthropicSetupTokenInput(ctx.opts.token) : "";
  const tokenError = validateAnthropicSetupToken(rawToken);
  if (tokenError) {
    ctx.runtime.error(
      ["Anthropic setup-token auth requires --token with a valid setup-token.", tokenError].join(
        "\n",
      ),
    );
    ctx.runtime.exit(1);
    return null;
  }

  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts.tokenProfileId);
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts.tokenExpiresIn);
  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential: {
      type: "token",
      provider: PROVIDER_ID,
      token: rawToken,
      ...(expires ? { expires } : {}),
    },
    agentDir: ctx.agentDir,
  });

  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[0]);
  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[1]);

  const withProfile = applyAuthProfileConfig(ctx.config, {
    profileId,
    provider: PROVIDER_ID,
    mode: "token",
  });
  const existingModelConfig =
    withProfile.agents?.defaults?.model && typeof withProfile.agents.defaults.model === "object"
      ? withProfile.agents.defaults.model
      : {};
  return {
    ...withProfile,
    agents: {
      ...withProfile.agents,
      defaults: {
        ...withProfile.agents?.defaults,
        model: {
          ...existingModelConfig,
          primary: DEFAULT_ANTHROPIC_MODEL,
        },
      },
    },
  };
}

function resolveAnthropic46ForwardCompatModel(params: {
  ctx: ProviderResolveDynamicModelContext;
  dashModelId: string;
  dotModelId: string;
  dashTemplateId: string;
  dotTemplateId: string;
  fallbackTemplateIds: readonly string[];
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
  if (trimmedModelId !== lower) {
    return undefined;
  }
  const is46Model =
    lower === params.dashModelId ||
    lower === params.dotModelId ||
    lower.startsWith(`${params.dashModelId}-`) ||
    lower.startsWith(`${params.dotModelId}-`);
  if (!is46Model) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(params.dashModelId)) {
    templateIds.push(lower.replace(params.dashModelId, params.dashTemplateId));
  }
  if (lower.startsWith(params.dotModelId)) {
    templateIds.push(lower.replace(params.dotModelId, params.dotTemplateId));
  }
  templateIds.push(...params.fallbackTemplateIds);

  return cloneFirstTemplateModel({
    providerId: PROVIDER_ID,
    modelId: trimmedModelId,
    templateIds,
    ctx: params.ctx,
    patch:
      normalizeLowercaseStringOrEmpty(params.ctx.provider) === CLAUDE_CLI_BACKEND_ID
        ? { provider: CLAUDE_CLI_BACKEND_ID }
        : undefined,
  });
}

function buildAnthropicForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
  const normalizedProvider = normalizeLowercaseStringOrEmpty(ctx.provider);
  if (trimmedModelId !== lower || !matchesAnthropicModernModel(lower)) {
    return undefined;
  }
  if (isAnthropicMandatoryClaude5Model(lower) && normalizedProvider !== PROVIDER_ID) {
    return undefined;
  }
  const provider =
    normalizedProvider === CLAUDE_CLI_BACKEND_ID ? CLAUDE_CLI_BACKEND_ID : PROVIDER_ID;
  return {
    id: trimmedModelId,
    name: trimmedModelId,
    provider,
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: isAnthropicMandatoryClaude5Model(trimmedModelId)
      ? { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
      : isAnthropicSonnet5Model(trimmedModelId) && provider === PROVIDER_ID
        ? resolveAnthropicSonnet5Cost()
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolveAnthropicFixedContextWindow(trimmedModelId) ?? 200_000,
    maxTokens: isAnthropic128kOutputModel(trimmedModelId)
      ? ANTHROPIC_MODERN_MAX_OUTPUT_TOKENS
      : 64_000,
    ...(supportsClaudeNativeXhighEffort({ id: trimmedModelId })
      ? {
          thinkingLevelMap: {
            ...(isAnthropicMandatoryClaude5Model(trimmedModelId)
              ? { off: "low" as const, minimal: "low" as const }
              : {}),
            xhigh: "xhigh",
            max: "max",
          },
        }
      : supportsAnthropicNativeMaxEffort(trimmedModelId)
        ? { thinkingLevelMap: { max: "max" } }
        : {}),
  };
}

function resolveAnthropicForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  return (
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_48_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_48_DOT_MODEL_ID,
      dashTemplateId: ANTHROPIC_OPUS_47_MODEL_ID,
      dotTemplateId: ANTHROPIC_OPUS_47_DOT_MODEL_ID,
      fallbackTemplateIds: ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS,
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_47_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_47_DOT_MODEL_ID,
      dashTemplateId: ANTHROPIC_OPUS_46_MODEL_ID,
      dotTemplateId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      fallbackTemplateIds: ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS,
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      dashTemplateId: ANTHROPIC_OPUS_47_MODEL_ID,
      dotTemplateId: ANTHROPIC_OPUS_46_MODEL_ID,
      fallbackTemplateIds: ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS,
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
      dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
      dashTemplateId: ANTHROPIC_SONNET_46_MODEL_ID,
      dotTemplateId: ANTHROPIC_SONNET_46_MODEL_ID,
      fallbackTemplateIds: [ANTHROPIC_SONNET_46_MODEL_ID, ANTHROPIC_SONNET_46_DOT_MODEL_ID],
    }) ??
    buildAnthropicForwardCompatModel(ctx)
  );
}

function isAnthropicGa1MModel(modelId: string): boolean {
  return supportsClaudeAdaptiveThinking({ id: modelId });
}

function isAnthropicFable5Model(modelId: string): boolean {
  return resolveClaudeFable5ModelIdentity({ id: modelId }) !== undefined;
}

function isAnthropicMythos5Model(modelId: string): boolean {
  return resolveClaudeMythos5ModelIdentity({ id: modelId }) !== undefined;
}

function isAnthropicMandatoryClaude5Model(modelId: string): boolean {
  return isAnthropicFable5Model(modelId) || isAnthropicMythos5Model(modelId);
}

function isAnthropicSonnet5Model(modelId: string): boolean {
  return resolveClaudeSonnet5ModelIdentity({ id: modelId }) !== undefined;
}

function resolveAnthropicFixedContextWindow(modelId: string): number | undefined {
  if (isAnthropicMandatoryClaude5Model(modelId) || isAnthropicSonnet5Model(modelId)) {
    return ANTHROPIC_EXACT_1M_CONTEXT_TOKENS;
  }
  return isAnthropicGa1MModel(modelId) ? ANTHROPIC_GA_1M_CONTEXT_TOKENS : undefined;
}

function isAnthropic128kOutputModel(modelId: string): boolean {
  if (isAnthropicMandatoryClaude5Model(modelId) || isAnthropicSonnet5Model(modelId)) {
    return true;
  }
  return /^claude-opus-4-8(?=$|[^a-z0-9])/.test(resolveClaudeModelIdentity({ id: modelId }));
}

function isAnthropicLargeImageModel(modelId: string): boolean {
  return supportsClaudeNativeXhighEffort({ id: modelId });
}

function isAnthropicMythosPreviewModel(modelId: string): boolean {
  return /(?:^|-)claude-mythos-preview(?=$|[^a-z0-9])/.test(
    resolveClaudeModelIdentity({ id: modelId }),
  );
}

function supportsAnthropicNativeMaxEffort(modelId: string): boolean {
  return supportsClaudeNativeMaxEffort({ id: modelId }) || isAnthropicMythosPreviewModel(modelId);
}

function hasConfiguredModelContextOverride(
  config: ProviderNormalizeResolvedModelContext["config"],
  provider: string,
  modelId: string,
): boolean {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (normalizeLowercaseStringOrEmpty(providerId) !== normalizedProvider) {
      continue;
    }
    if (!Array.isArray(providerConfig?.models)) {
      continue;
    }
    for (const model of providerConfig.models) {
      if (
        normalizeLowercaseStringOrEmpty(typeof model?.id === "string" ? model.id : "") !==
        normalizedModelId
      ) {
        continue;
      }
      if (
        (typeof model?.contextTokens === "number" && model.contextTokens > 0) ||
        (typeof model?.contextWindow === "number" && model.contextWindow > 0)
      ) {
        return true;
      }
    }
  }
  return false;
}

function applyAnthropicFixedContextWindow(params: {
  config?: ProviderNormalizeResolvedModelContext["config"];
  provider: string;
  modelId: string;
  contractModelId: string;
  model: ProviderRuntimeModel;
}): ProviderRuntimeModel | undefined {
  const fixedContextWindow = resolveAnthropicFixedContextWindow(params.contractModelId);
  if (fixedContextWindow === undefined) {
    return undefined;
  }
  if (hasConfiguredModelContextOverride(params.config, params.provider, params.modelId)) {
    return undefined;
  }
  const exactContextWindow =
    isAnthropicMandatoryClaude5Model(params.contractModelId) ||
    isAnthropicSonnet5Model(params.contractModelId);
  const nextContextWindow = exactContextWindow
    ? fixedContextWindow
    : Math.max(params.model.contextWindow ?? 0, fixedContextWindow);
  const nextContextTokens = exactContextWindow
    ? fixedContextWindow
    : typeof params.model.contextTokens === "number"
      ? Math.max(params.model.contextTokens, fixedContextWindow)
      : fixedContextWindow;
  if (
    nextContextWindow === params.model.contextWindow &&
    nextContextTokens === params.model.contextTokens
  ) {
    return undefined;
  }
  return {
    ...params.model,
    contextWindow: nextContextWindow,
    contextTokens: nextContextTokens,
  };
}

function applyAnthropicModernMaxTokens(params: {
  modelId: string;
  model: ProviderRuntimeModel;
}): ProviderRuntimeModel | undefined {
  if (!isAnthropic128kOutputModel(params.modelId)) {
    return undefined;
  }
  if ((params.model.maxTokens ?? 0) >= ANTHROPIC_MODERN_MAX_OUTPUT_TOKENS) {
    return undefined;
  }
  return {
    ...params.model,
    maxTokens: ANTHROPIC_MODERN_MAX_OUTPUT_TOKENS,
  };
}

function applyAnthropicThinkingLevelMap(params: {
  modelId: string;
  model: ProviderRuntimeModel;
}): ProviderRuntimeModel | undefined {
  const mandatoryClaude5 = isAnthropicMandatoryClaude5Model(params.modelId);
  const nativeXhigh = mandatoryClaude5 || supportsClaudeNativeXhighEffort({ id: params.modelId });
  if (!supportsAnthropicNativeMaxEffort(params.modelId)) {
    return undefined;
  }
  const current = params.model.thinkingLevelMap;
  const nativeDefaults = isAnthropicMythosPreviewModel(params.modelId)
    ? { max: "max" as const }
    : {
        ...(mandatoryClaude5 ? { off: "low" as const, minimal: "low" as const } : {}),
        xhigh: nativeXhigh ? ("xhigh" as const) : null,
        max: "max" as const,
      };
  const currentEfforts = current as Record<string, string | null | undefined> | undefined;
  if (Object.keys(nativeDefaults).every((level) => currentEfforts?.[level] !== undefined)) {
    return undefined;
  }
  return {
    ...params.model,
    thinkingLevelMap: {
      ...nativeDefaults,
      ...current,
    },
  };
}

function matchesAnthropicModernModel(modelId: string): boolean {
  return supportsClaudeAdaptiveThinking({ id: modelId }) || isAnthropicMythosPreviewModel(modelId);
}

function hasImageInput(input: unknown): boolean {
  return Array.isArray(input) && input.includes("image");
}

function supportsAnthropicImageInput(modelId: string, modelName?: string): boolean {
  return [modelId, modelName]
    .filter((value): value is string => typeof value === "string")
    .some((candidate) => matchesAnthropicModernModel(candidate));
}

function resolveAnthropicImageMediaInput(modelId: string, modelName?: string) {
  if (!supportsAnthropicImageInput(modelId, modelName)) {
    return undefined;
  }
  const refs = [modelId, modelName].filter((value): value is string => typeof value === "string");
  const largeImageModel = refs.some((ref) => isAnthropicLargeImageModel(ref));
  return {
    image: {
      maxSidePx: largeImageModel ? 2576 : 1568,
      preferredSidePx: largeImageModel ? 2576 : 1568,
      tokenMode: "provider" as const,
    },
  };
}

function applyAnthropicImageInputCapability(params: {
  modelId: string;
  model: ProviderRuntimeModel;
}): ProviderRuntimeModel | undefined {
  if (hasImageInput(params.model.input)) {
    return undefined;
  }
  if (!supportsAnthropicImageInput(params.modelId, params.model.name)) {
    return undefined;
  }
  return {
    ...params.model,
    input: ["text", "image"],
  };
}

function applyAnthropicSonnet5Cost(params: {
  modelId: string;
  model: ProviderRuntimeModel;
}): ProviderRuntimeModel | undefined {
  if (!isAnthropicSonnet5Model(params.modelId)) {
    return undefined;
  }
  const cost = resolveAnthropicSonnet5Cost();
  if (modelCostsEqual(params.model.cost, cost)) {
    return undefined;
  }
  return { ...params.model, cost };
}

function normalizeAnthropicResolvedModel(
  ctx: ProviderNormalizeResolvedModelContext,
): ProviderRuntimeModel | undefined {
  const contractModelId = resolveClaudeModelIdentity({
    id: ctx.modelId,
    params: ctx.model.params,
  });
  if (
    isAnthropicMandatoryClaude5Model(contractModelId) &&
    normalizeLowercaseStringOrEmpty(ctx.provider) !== PROVIDER_ID
  ) {
    return undefined;
  }
  const contractModel =
    (isAnthropicMandatoryClaude5Model(contractModelId) ||
      isAnthropicSonnet5Model(contractModelId)) &&
    !ctx.model.reasoning
      ? { ...ctx.model, reasoning: true }
      : ctx.model;
  const imageCapableModel =
    applyAnthropicImageInputCapability({
      modelId: contractModelId,
      model: contractModel,
    }) ?? contractModel;
  const mediaInput = resolveAnthropicImageMediaInput(contractModelId, imageCapableModel.name);
  const mediaInputModel = mediaInput
    ? {
        ...imageCapableModel,
        mediaInput: {
          ...mediaInput,
          ...imageCapableModel.mediaInput,
          image: {
            ...mediaInput.image,
            ...imageCapableModel.mediaInput?.image,
          },
        },
      }
    : imageCapableModel;
  const outputModel =
    applyAnthropicModernMaxTokens({
      modelId: contractModelId,
      model: mediaInputModel,
    }) ?? mediaInputModel;
  const thinkingLevelModel =
    applyAnthropicThinkingLevelMap({
      modelId: contractModelId,
      model: outputModel,
    }) ?? outputModel;
  const contextWindowModel =
    applyAnthropicFixedContextWindow({
      config: ctx.config,
      provider: ctx.provider,
      modelId: ctx.modelId,
      contractModelId,
      model: thinkingLevelModel,
    }) ?? thinkingLevelModel;
  const pricingModel =
    normalizeLowercaseStringOrEmpty(ctx.provider) === PROVIDER_ID
      ? (applyAnthropicSonnet5Cost({
          modelId: contractModelId,
          model: contextWindowModel,
        }) ?? contextWindowModel)
      : contextWindowModel;
  return pricingModel === ctx.model ? undefined : pricingModel;
}

function buildAnthropicAuthDoctorHint(params: {
  config?: ProviderAuthContext["config"];
  store: AuthProfileStore;
  profileId?: string;
}): string {
  const legacyProfileId = params.profileId ?? "anthropic:default";
  const suggested = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.config,
    store: params.store,
    provider: PROVIDER_ID,
    legacyProfileId,
  });
  if (!suggested || suggested === legacyProfileId) {
    return "";
  }

  const storeOauthProfiles = listProfilesForProvider(params.store, PROVIDER_ID)
    .filter((id) => params.store.profiles[id]?.type === "oauth")
    .join(", ");

  const cfgMode = params.config?.auth?.profiles?.[legacyProfileId]?.mode;
  const cfgProvider = params.config?.auth?.profiles?.[legacyProfileId]?.provider;

  return [
    "Doctor hint (for GitHub issue):",
    `- provider: ${PROVIDER_ID}`,
    `- config: ${legacyProfileId}${
      cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""
    }`,
    `- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
    `- suggested profile: ${suggested}`,
    `Fix: run "${formatCliCommand("openclaw doctor --yes")}"`,
  ].join("\n");
}

function resolveClaudeCliSyntheticAuth() {
  const credential = claudeCliAuth.readClaudeCliCredentialsForRuntime();
  if (!credential) {
    return undefined;
  }
  return credential.type === "oauth"
    ? {
        apiKey: credential.access,
        source: "Claude CLI native auth",
        mode: "oauth" as const,
        expiresAt: credential.expires,
      }
    : {
        apiKey: credential.token,
        source: "Claude CLI native auth",
        mode: "token" as const,
        expiresAt: credential.expires,
      };
}

async function runAnthropicCliMigration(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const credential = claudeCliAuth.readClaudeCliCredentialsForSetup();
  if (!credential) {
    throw new Error(
      [
        "Claude CLI is not authenticated on this host.",
        `Run ${formatCliCommand("claude auth login")} first, then re-run this setup.`,
      ].join("\n"),
    );
  }
  return buildAnthropicCliMigrationResult(ctx.config, credential);
}

async function runAnthropicCliMigrationNonInteractive(ctx: {
  config: ProviderAuthContext["config"];
  runtime: ProviderAuthContext["runtime"];
  agentDir?: string;
}): Promise<ProviderAuthContext["config"] | null> {
  const credential = claudeCliAuth.readClaudeCliCredentialsForSetupNonInteractive();
  if (!credential) {
    ctx.runtime.error(
      [
        'Auth choice "anthropic-cli" requires Claude CLI auth on this host.',
        `Run ${formatCliCommand("claude auth login")} first.`,
      ].join("\n"),
    );
    ctx.runtime.exit(1);
    return null;
  }

  const result = buildAnthropicCliMigrationResult(ctx.config, credential);
  const currentDefaults = ctx.config.agents?.defaults;
  const currentModel = currentDefaults?.model;
  const currentFallbacks =
    currentModel && typeof currentModel === "object" && "fallbacks" in currentModel
      ? currentModel.fallbacks
      : undefined;
  const migratedModel = result.configPatch?.agents?.defaults?.model;
  const migratedFallbacks =
    migratedModel && typeof migratedModel === "object" && "fallbacks" in migratedModel
      ? migratedModel.fallbacks
      : undefined;
  const nextFallbacks = Array.isArray(migratedFallbacks) ? migratedFallbacks : currentFallbacks;

  return {
    ...ctx.config,
    ...result.configPatch,
    agents: {
      ...ctx.config.agents,
      ...result.configPatch?.agents,
      defaults: {
        ...currentDefaults,
        ...result.configPatch?.agents?.defaults,
        model: {
          ...(Array.isArray(nextFallbacks) ? { fallbacks: nextFallbacks } : {}),
          primary: result.defaultModel,
        },
      },
    },
  };
}

/** Build the full Anthropic provider descriptor used by runtime registration. */
export function buildAnthropicProvider(): ProviderPlugin {
  const providerId = "anthropic";
  const defaultAnthropicModel = DEFAULT_ANTHROPIC_MODEL;
  return {
    id: providerId,
    label: "Anthropic",
    docsPath: "/providers/models",
    hookAliases: [CLAUDE_CLI_BACKEND_ID],
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    oauthProfileIdRepairs: [
      {
        legacyProfileId: "anthropic:default",
        promptLabel: "Anthropic",
      },
    ],
    auth: [
      {
        id: "cli",
        label: "Claude CLI",
        hint: "Reuse a local Claude CLI login and run Anthropic models through the Claude CLI runtime",
        kind: "custom",
        wizard: {
          choiceId: "anthropic-cli",
          choiceLabel: "Anthropic Claude CLI",
          choiceHint: "Reuse a local Claude CLI login on this host",
          assistantPriority: -20,
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key",
          modelAllowlist: {
            allowedKeys: [...CLAUDE_CLI_CANONICAL_ALLOWLIST_REFS],
            initialSelections: [CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF],
            message: "Claude CLI models",
          },
        },
        run: async (ctx: ProviderAuthContext) => await runAnthropicCliMigration(ctx),
        runNonInteractive: async (ctx) =>
          await runAnthropicCliMigrationNonInteractive({
            config: ctx.config,
            runtime: ctx.runtime,
            agentDir: ctx.agentDir,
          }),
      },
      {
        id: "setup-token",
        label: "Anthropic setup-token",
        hint: "Manual bearer token path",
        kind: "token",
        wizard: {
          choiceId: "setup-token",
          choiceLabel: "Anthropic setup-token",
          choiceHint: "Manual token path",
          assistantPriority: 40,
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key + token",
        },
        run: async (ctx: ProviderAuthContext) => await runAnthropicSetupTokenAuth(ctx),
        runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) =>
          await runAnthropicSetupTokenNonInteractive(ctx),
      },
      createProviderApiKeyAuthMethod({
        providerId,
        methodId: "api-key",
        label: "Anthropic API key",
        hint: "Direct Anthropic API key",
        optionKey: "anthropicApiKey",
        flagName: "--anthropic-api-key",
        envVar: "ANTHROPIC_API_KEY",
        promptMessage: "Enter Anthropic API key",
        defaultModel: defaultAnthropicModel,
        expectedProviders: ["anthropic"],
        wizard: {
          choiceId: "apiKey",
          choiceLabel: "Anthropic API key",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key",
        },
      }),
    ],
    normalizeConfig: ({ provider, providerConfig }) =>
      normalizeAnthropicProviderConfigForProvider({ provider, providerConfig }),
    applyConfigDefaults: ({ config, env }) => applyAnthropicConfigDefaults({ config, env }),
    resolveDynamicModel: (ctx) => {
      const model = resolveAnthropicForwardCompatModel(ctx);
      if (!model) {
        return undefined;
      }
      return (
        normalizeAnthropicResolvedModel({
          config: ctx.config,
          provider: ctx.provider,
          modelId: ctx.modelId,
          model,
        }) ?? model
      );
    },
    normalizeResolvedModel: (ctx) => normalizeAnthropicResolvedModel(ctx),
    resolveSyntheticAuth: ({ provider }) =>
      normalizeLowercaseStringOrEmpty(provider) === CLAUDE_CLI_BACKEND_ID
        ? resolveClaudeCliSyntheticAuth()
        : undefined,
    // Publish Claude CLI rows through the provider catalog hook.
    augmentModelCatalog: () => buildClaudeCliCatalogEntries(),
    ...NATIVE_ANTHROPIC_REPLAY_HOOKS,
    isModernModelRef: ({ provider, modelId }) =>
      matchesAnthropicModernModel(modelId) &&
      (!isAnthropicMandatoryClaude5Model(modelId) ||
        normalizeLowercaseStringOrEmpty(provider) === PROVIDER_ID),
    resolveReasoningOutputMode: () => "native",
    resolveThinkingProfile: ({ provider, modelId, params }) => {
      const contractModelId = resolveClaudeModelIdentity({ id: modelId, params });
      return isAnthropicMandatoryClaude5Model(contractModelId) &&
        normalizeLowercaseStringOrEmpty(provider) !== PROVIDER_ID
        ? CLAUDE_CLI_OFF_THINKING_PROFILE
        : resolveClaudeThinkingProfile(contractModelId, undefined, {
            includeNativeMax: [PROVIDER_ID, CLAUDE_CLI_BACKEND_ID].includes(
              normalizeLowercaseStringOrEmpty(provider),
            ),
          });
    },
    wrapStreamFn: wrapAnthropicProviderStream,
    resolveUsageAuth: resolveAnthropicUsageAuth,
    fetchUsageSnapshot: fetchAnthropicUsage,
    isCacheTtlEligible: () => true,
    buildAuthDoctorHint: (ctx) =>
      buildAnthropicAuthDoctorHint({
        config: ctx.config,
        store: ctx.store,
        profileId: ctx.profileId,
      }),
  };
}

/** Register Anthropic provider, Claude CLI backend, and media understanding provider. */
export function registerAnthropicPlugin(api: OpenClawPluginApi): void {
  api.registerCliBackend(buildAnthropicCliBackend());
  api.registerProvider(buildAnthropicProvider());
  api.registerMediaUnderstandingProvider(anthropicMediaUnderstandingProvider);
  registerClaudeSessionCatalog(api);
  for (const command of createClaudeSessionNodeHostCommands()) {
    api.registerNodeHostCommand(command);
  }
  for (const policy of createClaudeSessionNodeInvokePolicies()) {
    api.registerNodeInvokePolicy(policy);
  }
}
