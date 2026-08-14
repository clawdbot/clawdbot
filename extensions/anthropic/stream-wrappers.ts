/**
 * Anthropic stream wrappers. They add beta headers, service tier/fast-mode
 * payload fields, and thinking-prefill cleanup around provider stream functions.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveProviderEndpoint,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaude1MContext,
  supportsClaudeFastMode,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyAnthropicPayloadPolicyToParams,
  composeProviderStreamWrappers,
  createAnthropicThinkingPrefillPayloadWrapper,
  createPayloadPatchStreamWrapper,
  resolveAnthropicPayloadPolicy,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeFastMode,
  normalizeLowercaseStringOrEmpty,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const log = createSubsystemLogger("anthropic-stream");

const ANTHROPIC_CONTEXT_1M_BETA_LEGACY = "context-1m-2025-08-07";
const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_FAST_MODE_COST_MULTIPLIER = 2;
const OPENCLAW_DEFAULT_ANTHROPIC_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;
const OPENCLAW_OAUTH_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  ...OPENCLAW_DEFAULT_ANTHROPIC_BETAS,
] as const;

type AnthropicServiceTier = "auto" | "standard_only";
type DynamicFastMode = boolean | (() => boolean | undefined);

function isAnthropic1MModel(modelId: string): boolean {
  return supportsClaude1MContext({ id: modelId });
}

function parseHeaderList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  betas: string[],
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find(
    (key) => normalizeLowercaseStringOrEmpty(key) === "anthropic-beta",
  );
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : [];
  const values = Array.from(new Set([...existing, ...betas]));
  const key = existingKey ?? "anthropic-beta";
  merged[key] = values.join(",");
  return merged;
}

/**
 * Claude subscription credentials are OAuth access tokens rather than API keys.
 * Anthropic authenticates them through `Authorization: Bearer`, so every caller
 * that builds request auth must branch on this instead of assuming `x-api-key`.
 */
export function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function resolveAnthropicFastServiceTier(enabled: boolean): AnthropicServiceTier {
  return enabled ? "auto" : "standard_only";
}

function isDirectAnthropicApiModel(model: Parameters<StreamFn>[0]): boolean {
  if (
    normalizeLowercaseStringOrEmpty(model.provider) !== "anthropic" ||
    normalizeLowercaseStringOrEmpty(model.api) !== "anthropic-messages"
  ) {
    return false;
  }
  const endpointClass = resolveProviderEndpoint(model.baseUrl).endpointClass;
  return endpointClass === "default" || endpointClass === "anthropic-public";
}

function applyAnthropicFastModePricing(model: Parameters<StreamFn>[0]): Parameters<StreamFn>[0] {
  return {
    ...model,
    cost: {
      input: model.cost.input * ANTHROPIC_FAST_MODE_COST_MULTIPLIER,
      output: model.cost.output * ANTHROPIC_FAST_MODE_COST_MULTIPLIER,
      cacheRead: model.cost.cacheRead * ANTHROPIC_FAST_MODE_COST_MULTIPLIER,
      cacheWrite: model.cost.cacheWrite * ANTHROPIC_FAST_MODE_COST_MULTIPLIER,
    },
  };
}

function normalizeAnthropicServiceTier(value: unknown): AnthropicServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (normalized === "auto" || normalized === "standard_only") {
    return normalized;
  }
  return undefined;
}

function hasConfiguredAnthropicBeta(extraParams: Record<string, unknown> | undefined): boolean {
  const configured = extraParams?.anthropicBeta;
  if (typeof configured === "string") {
    return configured.trim().length > 0;
  }
  if (!Array.isArray(configured)) {
    return false;
  }
  return configured.some((beta) => typeof beta === "string" && beta.trim().length > 0);
}

/** Resolve configured Anthropic beta headers from extra model params. */
export function resolveAnthropicBetas(
  extraParams: Record<string, unknown> | undefined,
  _modelId: string,
): string[] | undefined {
  const betas = new Set<string>();
  const configured = extraParams?.anthropicBeta;
  if (typeof configured === "string" && configured.trim()) {
    for (const beta of parseHeaderList(configured)) {
      betas.add(beta);
    }
  } else if (Array.isArray(configured)) {
    for (const beta of configured) {
      if (typeof beta === "string" && beta.trim()) {
        for (const betaValue of parseHeaderList(beta)) {
          betas.add(betaValue);
        }
      }
    }
  }

  // Newer Claude 4.x 1M context is GA. Keep context1m as a context-sizing
  // opt-in, but do not send the retired beta even if it remains in older config.
  betas.delete(ANTHROPIC_CONTEXT_1M_BETA_LEGACY);

  return betas.size > 0 ? [...betas] : undefined;
}

/** Wrap a stream function to merge OpenClaw and configured Anthropic beta headers. */
export function createAnthropicBetaHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  betas: string[],
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const isOauth = isAnthropicOAuthApiKey(options?.apiKey);
    const effectiveBetas = betas.filter((beta) => beta !== ANTHROPIC_CONTEXT_1M_BETA_LEGACY);

    const openClawBetas = isOauth
      ? (OPENCLAW_OAUTH_ANTHROPIC_BETAS as readonly string[])
      : (OPENCLAW_DEFAULT_ANTHROPIC_BETAS as readonly string[]);
    const allBetas = [...new Set([...openClawBetas, ...effectiveBetas])];
    return underlying(model, context, {
      ...options,
      headers: mergeAnthropicBetaHeader(options?.headers, allBetas),
    });
  };
}

/** Wrap a stream function with native fast mode or the legacy Priority Tier mapping. */
export function createAnthropicFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: DynamicFastMode,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const fastPayloadWrapper = createPayloadPatchStreamWrapper(underlying, ({ payload }) => {
    delete payload.service_tier;
    payload.speed = "fast";
  });
  return (model, context, options) => {
    const resolved = typeof enabled === "function" ? enabled() : enabled;
    if (resolved === undefined) {
      return underlying(model, context, options);
    }
    if (supportsClaudeFastMode(model)) {
      if (
        !resolved ||
        isAnthropicOAuthApiKey(options?.apiKey) ||
        !isDirectAnthropicApiModel(model)
      ) {
        return underlying(model, context, options);
      }
      return fastPayloadWrapper(applyAnthropicFastModePricing(model), context, {
        ...options,
        headers: mergeAnthropicBetaHeader(options?.headers, [ANTHROPIC_FAST_MODE_BETA]),
      });
    }
    return createAnthropicServiceTierWrapper(underlying, resolveAnthropicFastServiceTier(resolved))(
      model,
      context,
      options,
    );
  };
}

/** Wrap a stream function with an explicit Anthropic service tier when allowed. */
export function createAnthropicServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  serviceTier: AnthropicServiceTier,
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload, model }) => {
      const payloadPolicy = resolveAnthropicPayloadPolicy({
        provider: readStringValue(model.provider),
        api: readStringValue(model.api),
        baseUrl: readStringValue(model.baseUrl),
        serviceTier,
      });
      applyAnthropicPayloadPolicyToParams(payload, payloadPolicy, new Set());
    },
    {
      shouldPatch: ({ model, options }) => {
        // Opus 5 and Sonnet 5 do not support Priority Tier; omit service_tier entirely.
        if (
          isAnthropicOAuthApiKey(options?.apiKey) ||
          resolveClaudeOpus5ModelIdentity(model) !== undefined ||
          resolveClaudeSonnet5ModelIdentity(model) !== undefined
        ) {
          return false;
        }
        return resolveAnthropicPayloadPolicy({
          provider: readStringValue(model.provider),
          api: readStringValue(model.api),
          baseUrl: readStringValue(model.baseUrl),
          serviceTier,
        }).allowsServiceTier;
      },
    },
  );
}

/** Wrap a stream function to strip trailing assistant prefill before thinking requests. */
function createAnthropicThinkingPrefillWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn, (stripped) => {
    log.warn(
      `removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because Anthropic extended thinking requires conversations to end with a user turn`,
    );
  });
}

/** Resolve Anthropic fast-mode setting from model extra params. */
export function resolveAnthropicFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
  const fastMode =
    typeof raw === "function"
      ? normalizeFastMode((raw as () => unknown)() as string | boolean | null | undefined)
      : normalizeFastMode(raw as string | boolean | null | undefined);
  return fastMode === "auto" ? undefined : fastMode;
}

/** Resolve Anthropic service tier from model extra params. */
export function resolveAnthropicServiceTier(
  extraParams: Record<string, unknown> | undefined,
): AnthropicServiceTier | undefined {
  const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
  const normalized = normalizeAnthropicServiceTier(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid Anthropic service tier param: ${rawSummary}`);
  }
  return normalized;
}

/** Compose all Anthropic stream wrappers for one provider/model context. */
export function wrapAnthropicProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  const anthropicBetas = resolveAnthropicBetas(ctx.extraParams, ctx.modelId);
  const needsAnthropicBetaWrapper =
    anthropicBetas !== undefined ||
    hasConfiguredAnthropicBeta(ctx.extraParams) ||
    (ctx.extraParams?.context1m === true && isAnthropic1MModel(ctx.modelId));
  const serviceTier = resolveAnthropicServiceTier(ctx.extraParams);
  const hasFastModeParam =
    ctx.extraParams !== undefined &&
    (Object.hasOwn(ctx.extraParams, "fastMode") || Object.hasOwn(ctx.extraParams, "fast_mode"));
  return composeProviderStreamWrappers(
    ctx.streamFn,
    needsAnthropicBetaWrapper
      ? (streamFn) => createAnthropicBetaHeadersWrapper(streamFn, anthropicBetas ?? [])
      : undefined,
    serviceTier
      ? (streamFn) => createAnthropicServiceTierWrapper(streamFn, serviceTier)
      : undefined,
    hasFastModeParam && serviceTier === undefined
      ? (streamFn) =>
          createAnthropicFastModeWrapper(streamFn, () => resolveAnthropicFastMode(ctx.extraParams))
      : undefined,
    (streamFn) => createAnthropicThinkingPrefillWrapper(streamFn),
  );
}
