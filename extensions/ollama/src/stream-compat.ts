import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type {
  OpenClawConfig,
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeProviderId,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  createMoonshotThinkingWrapper,
  createPayloadPatchStreamWrapper,
  resolveMoonshotThinkingType,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { shouldWrapOllamaCompatMoonshotThinking } from "./model-behavior.js";

export type OllamaThinkValue = boolean | "low" | "medium" | "high";

export function resolveConfiguredOllamaProviderConfig(params: {
  config?: OpenClawConfig;
  providerId?: string;
}) {
  const providerId = params.providerId?.trim();
  if (!providerId) {
    return undefined;
  }
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const direct = providers[providerId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(providerId);
  for (const [candidateId, candidate] of Object.entries(providers)) {
    if (normalizeProviderId(candidateId) === normalized) {
      return candidate;
    }
  }
  return undefined;
}

export function isOllamaCompatProvider(model: {
  provider?: string;
  baseUrl?: string;
  api?: string;
}): boolean {
  const providerId = normalizeProviderId(model.provider ?? "");
  if (providerId === "ollama") {
    return true;
  }
  if (!model.baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(model.baseUrl);
    if (isLoopbackHost(parsed.hostname) && parsed.port === "11434") {
      return true;
    }

    // Allow remote/LAN Ollama OpenAI-compatible endpoints when the provider id
    // itself indicates Ollama usage (for example "my-ollama").
    const providerHintsOllama = providerId.includes("ollama");
    const isOllamaPort = parsed.port === "11434";
    const isOllamaCompatPath = parsed.pathname === "/" || /^\/v1\/?$/i.test(parsed.pathname);
    return providerHintsOllama && isOllamaPort && isOllamaCompatPath;
  } catch {
    return false;
  }
}

export function resolveOllamaCompatNumCtxEnabled(params: {
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  return resolveConfiguredOllamaProviderConfig(params)?.injectNumCtxForOpenAICompat ?? true;
}

export function shouldInjectOllamaCompatNumCtx(params: {
  model: { api?: string; provider?: string; baseUrl?: string };
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  if (params.model.api !== "openai-completions") {
    return false;
  }
  if (!isOllamaCompatProvider(params.model)) {
    return false;
  }
  return resolveOllamaCompatNumCtxEnabled({
    config: params.config,
    providerId: params.providerId,
  });
}

export function wrapOllamaCompatNumCtx(baseFn: StreamFn | undefined, numCtx: number): StreamFn {
  return createPayloadPatchStreamWrapper(baseFn, ({ payload }) => {
    if (!payload.options || typeof payload.options !== "object") {
      payload.options = {};
    }
    (payload.options as Record<string, unknown>).num_ctx = numCtx;
  });
}

function createOllamaThinkingWrapper(
  baseFn: StreamFn | undefined,
  think: OllamaThinkValue,
): StreamFn {
  return createPayloadPatchStreamWrapper(baseFn, ({ payload }) => {
    payload.think = think;
  });
}

function resolveOllamaThinkValue(thinkingLevel: unknown): OllamaThinkValue | undefined {
  if (thinkingLevel === "off") {
    return false;
  }
  if (thinkingLevel === "low" || thinkingLevel === "medium" || thinkingLevel === "high") {
    return thinkingLevel;
  }
  if (thinkingLevel === "minimal") {
    return "low";
  }
  if (thinkingLevel === "xhigh" || thinkingLevel === "adaptive" || thinkingLevel === "max") {
    return "high";
  }
  return undefined;
}

export function resolveOllamaThinkParamValue(
  params: Record<string, unknown> | undefined,
): OllamaThinkValue | undefined {
  const raw = params?.think ?? params?.thinking;
  if (typeof raw === "boolean") {
    return raw;
  }
  if (raw === "off") {
    return false;
  }
  if (raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  if (raw === "minimal") {
    return "low";
  }
  if (raw === "xhigh" || raw === "adaptive" || raw === "max") {
    return "high";
  }
  return undefined;
}

export function shouldForwardNativeOllamaThink(
  model: ProviderRuntimeModel | undefined,
  think: OllamaThinkValue,
): boolean {
  // Ollama accepts top-level `think` as the native chat contract, but rejects
  // truthy values for models known not to expose thinking support.
  return think === false || model?.reasoning !== false;
}

export function resolveOllamaConfiguredNumCtx(model: ProviderRuntimeModel): number | undefined {
  const raw = model.params?.num_ctx;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return Math.floor(raw);
}

function resolveOllamaNumCtx(model: ProviderRuntimeModel): number {
  return (
    resolveOllamaConfiguredNumCtx(model) ??
    Math.max(
      1,
      Math.floor(
        model.contextTokens ?? model.contextWindow ?? model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      ),
    )
  );
}

export function createConfiguredOllamaCompatStreamWrapper(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  let streamFn = ctx.streamFn;
  const model = ctx.model;
  let injectNumCtx = false;
  const isNativeOllamaTransport = model?.api === "ollama";

  if (model) {
    const providerId =
      typeof model.provider === "string" && model.provider.trim().length > 0
        ? model.provider
        : ctx.provider;
    if (
      shouldInjectOllamaCompatNumCtx({
        model,
        config: ctx.config,
        providerId,
      })
    ) {
      injectNumCtx = true;
    }
  }

  if (injectNumCtx && model) {
    streamFn = wrapOllamaCompatNumCtx(streamFn, resolveOllamaNumCtx(model));
  }

  const configuredThinkValue = model ? resolveOllamaThinkParamValue(model.params) : undefined;
  const runtimeThinkValue = isNativeOllamaTransport
    ? resolveOllamaThinkValue(ctx.thinkingLevel)
    : undefined;
  // "off" is also the implicit agent default. Preserve explicit native Ollama
  // model config unless the active run requests a non-off thinking level.
  const ollamaThinkValue =
    runtimeThinkValue === false && configuredThinkValue !== undefined
      ? undefined
      : runtimeThinkValue;
  if (ollamaThinkValue !== undefined && shouldForwardNativeOllamaThink(model, ollamaThinkValue)) {
    streamFn = createOllamaThinkingWrapper(streamFn, ollamaThinkValue);
  }

  if (
    normalizeProviderId(ctx.provider) === "ollama" &&
    shouldWrapOllamaCompatMoonshotThinking(ctx.modelId)
  ) {
    const thinkingType = resolveMoonshotThinkingType({
      configuredThinking: ctx.extraParams?.thinking,
      thinkingLevel: ctx.thinkingLevel,
    });
    streamFn = createMoonshotThinkingWrapper(streamFn, thinkingType);
  }

  return streamFn;
}
