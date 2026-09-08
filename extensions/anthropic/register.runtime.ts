/**
 * Anthropic provider runtime registration. It owns API-key/setup-token/Claude
 * CLI auth, dynamic model normalization, usage auth, media, and stream wrappers.
 */
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderNormalizeResolvedModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildManifestModelProviderConfig,
  type ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  cloneFirstTemplateModel,
  type ModelCompatConfig,
  modelCostsEqual,
  type ProviderPlugin,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  resolveClaudeThinkingProfile,
  supportsClaude1MContext,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import {
  CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF,
  CLAUDE_CLI_OFF_THINKING_PROFILE,
  CLAUDE_CLI_PROFILE_ID,
  CLAUDE_MODEL_ID_ALIASES,
} from "./cli-constants.js";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
  supportsClaudeDynamicSystemPromptSections,
} from "./cli-shared.js";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfigForProvider,
} from "./config-defaults.js";
import { resolveFastModeSupport } from "./fast-mode-policy.js";
import { acceptsAnthropicLiveModelContract } from "./live-model-contract-gate.js";
import { anthropicMediaUnderstandingProvider } from "./media-understanding-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import anthropicProviderDiscovery from "./provider-discovery.js";
import {
  createClaudeSessionNodeInvokePolicies,
  registerClaudeSessionDiscovery,
} from "./session-catalog-registration.js";
import { isAnthropicOAuthApiKey, wrapAnthropicProviderStream } from "./stream-wrappers.js";
import { fetchAnthropicUsage, resolveAnthropicUsageAuth } from "./usage.js";

// Registration needs descriptors, not auth persistence or external credential discovery.
const loadAuthRuntime = createLazyRuntimeModule(() => import("./auth.runtime.js"));
// Static registration must not initialize live catalog transport and policy.
const buildOpenAICompatibleProviderCatalog = createLazyRuntimeMethod(
  createLazyRuntimeModule(() => import("openclaw/plugin-sdk/provider-catalog-live-runtime")),
  (runtime) => runtime.buildOpenAICompatibleProviderCatalog,
);

const PROVIDER_ID = "anthropic";

// Anthropic-native error descriptors stay with the Anthropic provider hook.
function classifyAnthropicFailoverDescriptor(value: string | undefined) {
  switch (value?.trim().toUpperCase()) {
    case "RATE_LIMIT_ERROR":
      return "rate_limit" as const;
    case "API_ERROR":
      return "server_error" as const;
    default:
      return undefined;
  }
}
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-opus-5";
const ANTHROPIC_OPUS_48_MODEL_ID = "claude-opus-4-8";
const ANTHROPIC_OPUS_48_DOT_MODEL_ID = "claude-opus-4.8";
const ANTHROPIC_OPUS_47_MODEL_ID = "claude-opus-4-7";
const ANTHROPIC_OPUS_47_DOT_MODEL_ID = "claude-opus-4.7";
const ANTHROPIC_1M_CONTEXT_TOKENS = 1_000_000;
const ANTHROPIC_MODERN_MAX_OUTPUT_TOKENS = 128_000;
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS = [
  ANTHROPIC_OPUS_46_MODEL_ID,
  ANTHROPIC_OPUS_46_DOT_MODEL_ID,
] as const;
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";
function buildAnthropicCatalogProvider() {
  return buildManifestModelProviderConfig({
    providerId: PROVIDER_ID,
    catalog: manifest.modelCatalog.providers.anthropic,
  });
}

/**
 * Discovery credentials arrive as either an API key or a Claude subscription
 * OAuth access token. Anthropic rejects an OAuth token sent as `x-api-key`, and
 * rejects the request outright when both auth headers are present, so the two
 * shapes must select mutually exclusive headers.
 */
function buildAnthropicDiscoveryAuthHeaders(key: string | undefined): Record<string, string> {
  if (!key) {
    return {};
  }
  return isAnthropicOAuthApiKey(key) ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
}

/**
 * Live discovery replaces the seed catalog with whatever `/v1/models` returns.
 * Anthropic does not publish every model it serves, so replacement alone would
 * hide shipped entries that have no live row. Re-add the manifest models the
 * live response omitted; discovered rows still win on shared ids.
 */
function restoreUnpublishedAnthropicModels(result: ProviderCatalogResult): ProviderCatalogResult {
  if (!result || !("provider" in result)) {
    return result;
  }
  const discovered = result.provider.models ?? [];
  if (discovered.length === 0) {
    return result;
  }
  const discoveredIds = new Set(discovered.map((model) => model.id));
  const unpublished = (buildAnthropicCatalogProvider().models ?? []).filter(
    (model) => !discoveredIds.has(model.id),
  );
  if (unpublished.length === 0) {
    return result;
  }
  // Discovered rows arrive id-sorted; keep the appended tail sorted too so the
  // catalog stays byte-stable for prompt caching.
  return {
    ...result,
    provider: {
      ...result.provider,
      models: [...discovered, ...unpublished.toSorted((a, b) => a.id.localeCompare(b.id))],
    },
  };
}

function resolveAnthropicModelCost(modelId: string) {
  // Snapshots share their dateless model's price; unlisted deployments retain
  // their discovered cost instead of inheriting a different version's pricing.
  const normalized = resolveClaudeModelIdentity({ id: modelId }).replace(/-\d{8}$/, "");
  const id = CLAUDE_MODEL_ID_ALIASES.get(normalized) ?? normalized;
  return manifest.modelCatalog.providers.anthropic.models.find((model) => model.id === id)?.cost;
}

const CLAUDE_CLI_CANONICAL_ALLOWLIST_REFS = CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS.map((ref) =>
  ref.startsWith(`${CLAUDE_CLI_BACKEND_ID}/`)
    ? `anthropic/${ref.slice(CLAUDE_CLI_BACKEND_ID.length + 1)}`
    : ref,
);

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

function resolveAnthropicSnapshotModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const modelId = ctx.modelId.trim();
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const match = /^(claude-[a-z0-9]+(?:-[a-z0-9]+)*)-\d{8}$/.exec(normalizedModelId);
  if (
    modelId !== normalizedModelId ||
    normalizeLowercaseStringOrEmpty(ctx.provider) !== PROVIDER_ID ||
    !match
  ) {
    return undefined;
  }
  const templateId = match[1]!;
  const captured = cloneFirstTemplateModel({
    providerId: PROVIDER_ID,
    modelId,
    templateIds: [templateId],
    ctx,
  });
  if (captured) {
    return captured;
  }
  const template = resolveAnthropicManifestModel(templateId);
  return template ? { ...template, id: modelId, name: modelId } : undefined;
}

/** Newest Claude generation whose request contract this plugin encodes. */
const ANTHROPIC_NEWEST_KNOWN_GENERATION = { major: 5, minor: 0 } as const;

/**
 * Read the generation from either Claude id order: `claude-<family>-<major>[-<minor>]`
 * (4.6 onward) and `claude-<major>[-<minor>]-<family>` (through 3.7). The minor
 * capture is bounded to two digits so a trailing snapshot date such as
 * `claude-opus-4-20250514` does not parse as a minor version.
 */
function resolveAnthropicModelGeneration(
  modelId: string,
): { major: number; minor: number } | undefined {
  const match =
    /claude-[a-z]+-(\d{1,2})(?:-(\d{1,2}))?(?![0-9])/.exec(modelId) ??
    /claude-(\d{1,2})(?:-(\d{1,2}))?(?![0-9])/.exec(modelId);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: match[2] === undefined ? 0 : Number(match[2]) };
}

/**
 * Claude ids from a generation newer than anything this plugin encodes. Request
 * shaping is selected by version predicates in `@openclaw/llm-core`, so such an
 * id would otherwise fall through to pre-4.6 shaping — manual `budget_tokens`
 * plus caller sampling params — which current models reject outright.
 */
function isAnthropicUnreleasedGenerationModel(modelId: string): boolean {
  if (matchesAnthropicModernModel(modelId)) {
    return false;
  }
  const generation = resolveAnthropicModelGeneration(modelId);
  if (!generation) {
    return false;
  }
  return (
    generation.major > ANTHROPIC_NEWEST_KNOWN_GENERATION.major ||
    (generation.major === ANTHROPIC_NEWEST_KNOWN_GENERATION.major &&
      generation.minor > ANTHROPIC_NEWEST_KNOWN_GENERATION.minor)
  );
}

/**
 * Route an unreleased id onto the newest contract we encode, matching family
 * when we recognize it. Stamping `canonicalModelId` is the same seam Bedrock and
 * Mantle use to map a provider-native id onto a canonical Claude contract, so
 * shaping follows without teaching the shared contracts about unknown ids.
 */
function resolveAnthropicUnreleasedCanonicalModelId(modelId: string): string {
  return /(?:^|-)claude-sonnet-/.test(modelId) ? "claude-sonnet-5" : "claude-opus-5";
}

// Dynamic rows use the manifest as the provider-owned offline contract when a lifecycle registry
// has no template yet. Keeping one normalized index avoids reparsing catalog metadata per run.
let anthropicManifestModelIndex: Map<string, ProviderRuntimeModel> | undefined;

function resolveAnthropicManifestModel(modelId: string): ProviderRuntimeModel | undefined {
  if (!anthropicManifestModelIndex) {
    anthropicManifestModelIndex = new Map();
    const catalog = buildAnthropicCatalogProvider();
    for (const model of catalog.models ?? []) {
      const api = model.api ?? catalog.api;
      const baseUrl = model.baseUrl ?? catalog.baseUrl;
      if (api && baseUrl) {
        anthropicManifestModelIndex.set(model.id, {
          ...model,
          input: model.input.filter(
            (item): item is "text" | "image" => item === "text" || item === "image",
          ),
          provider: PROVIDER_ID,
          api,
          baseUrl,
        });
      }
    }
  }
  return anthropicManifestModelIndex.get(modelId);
}

function resolveAnthropicManifestCompat(
  provider: string,
  modelId: string,
): ModelCompatConfig | undefined {
  return normalizeLowercaseStringOrEmpty(provider) === PROVIDER_ID
    ? resolveAnthropicManifestModel(modelId)?.compat
    : undefined;
}

function buildAnthropicForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
  const normalizedProvider = normalizeLowercaseStringOrEmpty(ctx.provider);
  const unreleasedGeneration = isAnthropicUnreleasedGenerationModel(lower);
  if (trimmedModelId !== lower || !(matchesAnthropicModernModel(lower) || unreleasedGeneration)) {
    return undefined;
  }
  if (isAnthropicMandatoryClaude5Model(lower) && normalizedProvider !== PROVIDER_ID) {
    return undefined;
  }
  const provider =
    normalizedProvider === CLAUDE_CLI_BACKEND_ID ? CLAUDE_CLI_BACKEND_ID : PROVIDER_ID;
  // This hand-built row replaces the catalog row when the runtime prefers
  // plugin-resolved modern models, so it must carry the catalog's compat
  // capability metadata (for example compat.codeMode) instead of dropping it.
  // Registry compat wins when present (it may carry config overrides); the
  // manifest index covers empty-registry runs such as env-key-only sessions.
  const catalogModel = ctx.modelRegistry.find(provider, trimmedModelId) as
    | Pick<ProviderRuntimeModel, "compat">
    | null
    | undefined;
  const compat = catalogModel?.compat ?? resolveAnthropicManifestCompat(provider, trimmedModelId);
  return {
    id: trimmedModelId,
    name: trimmedModelId,
    provider,
    ...(compat ? { compat } : {}),
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: (provider === PROVIDER_ID ? resolveAnthropicModelCost(trimmedModelId) : undefined) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: resolveAnthropicFixedContextWindow(provider, trimmedModelId) ?? 200_000,
    maxTokens: isAnthropic128kOutputModel(trimmedModelId)
      ? ANTHROPIC_MODERN_MAX_OUTPUT_TOKENS
      : 64_000,
    ...(unreleasedGeneration
      ? { params: { canonicalModelId: resolveAnthropicUnreleasedCanonicalModelId(lower) } }
      : {}),
    ...(supportsClaudeNativeXhighEffort({ id: trimmedModelId })
      ? {
          thinkingLevelMap: {
            ...(isAnthropicMandatoryClaude5Model(trimmedModelId)
              ? { minimal: "low" as const }
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
    resolveAnthropicSnapshotModel(ctx) ??
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
  return supportsClaude1MContext({ id: modelId });
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

function isAnthropicOpus5Model(modelId: string): boolean {
  return resolveClaudeOpus5ModelIdentity({ id: modelId }) !== undefined;
}

// Claude 5 models ship 1M context as the model default (no [1m] CLI opt-in).
function isAnthropicExact1MClaude5Model(modelId: string): boolean {
  return (
    isAnthropicMandatoryClaude5Model(modelId) ||
    isAnthropicSonnet5Model(modelId) ||
    isAnthropicOpus5Model(modelId)
  );
}

function resolveAnthropicFixedContextWindow(provider: string, modelId: string): number | undefined {
  return isAnthropicExact1MClaude5Model(modelId) ||
    (isAnthropicGa1MModel(modelId) &&
      (normalizeLowercaseStringOrEmpty(provider) !== CLAUDE_CLI_BACKEND_ID ||
        normalizeLowercaseStringOrEmpty(modelId).endsWith("[1m]")))
    ? ANTHROPIC_1M_CONTEXT_TOKENS
    : undefined;
}

function isAnthropic128kOutputModel(modelId: string): boolean {
  return isAnthropicExact1MClaude5Model(modelId) || isAnthropicGa1MModel(modelId);
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

function hasConfiguredModelOverride(
  config: ProviderNormalizeResolvedModelContext["config"],
  provider: string,
  modelId: string,
  override: "context" | "cost",
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
        override === "cost"
          ? model?.cost !== undefined
          : (typeof model?.contextTokens === "number" && model.contextTokens > 0) ||
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
  const fixedContextWindow = resolveAnthropicFixedContextWindow(
    params.provider,
    params.contractModelId,
  );
  if (fixedContextWindow === undefined) {
    return undefined;
  }
  if (hasConfiguredModelOverride(params.config, params.provider, params.modelId, "context")) {
    return undefined;
  }
  const exactContextWindow = isAnthropicExact1MClaude5Model(params.contractModelId);
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
        ...(mandatoryClaude5 ? { minimal: "low" as const } : {}),
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
    isAnthropicExact1MClaude5Model(contractModelId) && !ctx.model.reasoning
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
  // Provider catalog defaults must not replace explicit operator pricing.
  const cost = resolveAnthropicModelCost(contractModelId);
  const pricingModel =
    normalizeLowercaseStringOrEmpty(ctx.provider) === PROVIDER_ID &&
    !hasConfiguredModelOverride(ctx.config, ctx.provider, ctx.modelId, "cost") &&
    cost &&
    !modelCostsEqual(contextWindowModel.cost, cost)
      ? { ...contextWindowModel, cost }
      : contextWindowModel;
  return pricingModel === ctx.model ? undefined : pricingModel;
}

/** Build the full Anthropic provider descriptor used by runtime registration. */
export function buildAnthropicProvider(): ProviderPlugin {
  const providerId = "anthropic";
  const defaultAnthropicModel = DEFAULT_ANTHROPIC_MODEL;
  return {
    id: providerId,
    label: "Anthropic",
    deprecatedProfileIds: [CLAUDE_CLI_PROFILE_ID],
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
        hint: "Keep using a local Claude CLI login and run Anthropic models through the Claude CLI runtime",
        kind: "custom",
        wizard: {
          choiceId: "anthropic-cli",
          choiceLabel: "Anthropic Claude CLI",
          choiceHint: "Keep using an existing Claude Code CLI login on this host",
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
        run: async (ctx: ProviderAuthContext) =>
          await (await loadAuthRuntime()).runAnthropicCliMigration(ctx),
        runNonInteractive: async (ctx) =>
          await (
            await loadAuthRuntime()
          ).runAnthropicCliMigrationNonInteractive({
            config: ctx.config,
            runtime: ctx.runtime,
            agentDir: ctx.agentDir,
          }),
      },
      {
        id: "setup-token",
        label: "Anthropic setup-token",
        hint: "Paste a long-lived token created with 'claude setup-token'",
        kind: "token",
        wizard: {
          choiceId: "setup-token",
          choiceLabel: "Anthropic setup-token",
          choiceHint: "Token created by running 'claude setup-token' in your terminal",
          assistantPriority: 40,
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key + token",
        },
        run: async (ctx: ProviderAuthContext) =>
          await (await loadAuthRuntime()).runAnthropicSetupTokenAuth(ctx, defaultAnthropicModel),
        validateNonInteractive: async (ctx) =>
          Boolean((await loadAuthRuntime()).validateAnthropicSetupTokenNonInteractive(ctx)),
        runNonInteractive: async (ctx) =>
          await (
            await loadAuthRuntime()
          ).runAnthropicSetupTokenNonInteractive(ctx, defaultAnthropicModel),
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
    catalog: {
      order: "simple",
      run: async (ctx) =>
        restoreUnpublishedAnthropicModels(
          await buildOpenAICompatibleProviderCatalog({
            discoveryMode: "strict",
            ctx,
            providerId,
            buildProvider: buildAnthropicCatalogProvider,
            modelDiscovery: {
              endpointPath: "v1/models",
              buildRequestHeaders: ({ apiKey, discoveryApiKey }) => ({
                "anthropic-version": "2023-06-01",
                ...buildAnthropicDiscoveryAuthHeaders(discoveryApiKey ?? apiKey),
              }),
              acceptUnknownModel: acceptsAnthropicLiveModelContract,
            },
          }),
        ),
    },
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: buildAnthropicCatalogProvider() }),
    },
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
    prepareSyntheticAuth: anthropicProviderDiscovery.prepareSyntheticAuth,
    ...buildProviderReplayFamilyHooks({ family: "native-anthropic-by-model" }),
    isModernModelRef: ({ provider, modelId }) =>
      matchesAnthropicModernModel(modelId) &&
      (!isAnthropicMandatoryClaude5Model(modelId) ||
        normalizeLowercaseStringOrEmpty(provider) === PROVIDER_ID),
    resolveReasoningOutputMode: () => "native",
    classifyFailoverReason: ({ code, errorType }) =>
      classifyAnthropicFailoverDescriptor(errorType) ?? classifyAnthropicFailoverDescriptor(code),
    resolveThinkingProfile: ({ provider, modelId, params }) => {
      const contractModelId = resolveClaudeModelIdentity({ id: modelId, params });
      return isAnthropicMythos5Model(contractModelId) &&
        normalizeLowercaseStringOrEmpty(provider) !== PROVIDER_ID
        ? CLAUDE_CLI_OFF_THINKING_PROFILE
        : resolveClaudeThinkingProfile(contractModelId, undefined, {
            includeNativeMax: [PROVIDER_ID, CLAUDE_CLI_BACKEND_ID].includes(
              normalizeLowercaseStringOrEmpty(provider),
            ),
          });
    },
    wrapStreamFn: wrapAnthropicProviderStream,
    resolveFastModeSupport,
    resolveUsageAuth: resolveAnthropicUsageAuth,
    fetchUsageSnapshot: fetchAnthropicUsage,
    isCacheTtlEligible: () => true,
    buildAuthDoctorHint: async (ctx) =>
      (await loadAuthRuntime()).buildAnthropicAuthDoctorHint({
        config: ctx.config,
        store: ctx.store,
        profileId: ctx.profileId,
      }),
  };
}

/** Register Anthropic provider, Claude CLI backend, and media understanding provider. */
export function registerAnthropicPlugin(api: OpenClawPluginApi): void {
  let supportsDynamicSystemPromptSections = false;
  // Catalog discovery must not materialize the runtime for a CLI-only capability probe.
  // First CLI executions share and await it before resolving immutable process argv.
  const ensureDynamicSystemPromptSectionsSupport = createLazyRuntimeModule(async () => {
    try {
      const result = await api.runtime.system.runCommandWithTimeout(["claude", "--version"], {
        timeoutMs: 1_500,
        killProcessTree: true,
        maxOutputBytes: { stdout: 1_024, stderr: 1_024 },
      });
      supportsDynamicSystemPromptSections =
        result?.code === 0 && supportsClaudeDynamicSystemPromptSections(result.stdout);
    } catch {
      supportsDynamicSystemPromptSections = false;
    }
  });
  api.registerCliBackend(
    buildAnthropicCliBackend({
      ensureDynamicSystemPromptSectionsSupport,
      supportsDynamicSystemPromptSections: () => supportsDynamicSystemPromptSections,
    }),
  );
  api.registerProvider(buildAnthropicProvider());
  api.registerMediaUnderstandingProvider(anthropicMediaUnderstandingProvider);
  registerClaudeSessionDiscovery(api);
  for (const policy of createClaudeSessionNodeInvokePolicies()) {
    api.registerNodeInvokePolicy(policy);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
