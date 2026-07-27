// Lmstudio plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPlainTextToolCallCompatWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import { asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import { ensureLmstudioModelLoaded } from "./models.fetch.js";
import { resolveLmstudioInferenceBase } from "./models.js";
import { resolveLmstudioProviderHeaders, resolveLmstudioRuntimeApiKey } from "./runtime.js";

const log = createSubsystemLogger("extensions/lmstudio/stream");

type StreamOptions = Parameters<StreamFn>[2];
type StreamModel = Parameters<StreamFn>[0];

const preloadInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Cooldown state for the LM Studio preload endpoint.
 *
 * Without this, every chat request would retry preload ~every 2s even when
 * LM Studio has rejected the load (for example the memory guardrail will keep
 * rejecting until the user adjusts the setting or frees RAM). That produced
 * hundreds of `LM Studio inference preload failed` WARN lines per hour without
 * actually helping the user. The cooldown applies an exponential backoff per
 * preloadKey and, while the cooldown is active, the wrapper skips the preload
 * step entirely and proceeds directly to streaming — the model is often
 * already loaded from the user's LM Studio UI, so inference can succeed even
 * when preload keeps being rejected.
 */
type PreloadCooldownEntry = {
  untilMs: number;
  consecutiveFailures: number;
  resolvedModelKey?: string;
};

const preloadCooldown = new Map<string, PreloadCooldownEntry>();

const PRELOAD_BACKOFF_BASE_MS = 5_000;
const PRELOAD_BACKOFF_MAX_MS = 300_000;

function computePreloadBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const raw = PRELOAD_BACKOFF_BASE_MS * 2 ** exponent;
  return Math.min(PRELOAD_BACKOFF_MAX_MS, raw);
}

function recordPreloadSuccess(preloadKey: string): void {
  preloadCooldown.delete(preloadKey);
}

function recordPreloadFailure(
  preloadKey: string,
  now: number,
  resolvedModelKey?: string,
): PreloadCooldownEntry {
  const existing = preloadCooldown.get(preloadKey);
  const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
  const persistedResolvedModelKey = resolvedModelKey ?? existing?.resolvedModelKey;
  const entry: PreloadCooldownEntry = {
    consecutiveFailures,
    untilMs: now + computePreloadBackoffMs(consecutiveFailures),
    ...(persistedResolvedModelKey ? { resolvedModelKey: persistedResolvedModelKey } : {}),
  };
  preloadCooldown.set(preloadKey, entry);
  return entry;
}

function isPreloadCoolingDown(preloadKey: string, now: number): PreloadCooldownEntry | undefined {
  const entry = preloadCooldown.get(preloadKey);
  if (!entry) {
    return undefined;
  }
  if (entry.untilMs <= now) {
    preloadCooldown.delete(preloadKey);
    return undefined;
  }
  return entry;
}

function normalizeLmstudioModelKey(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.toLowerCase().startsWith("lmstudio/")) {
    return trimmed.slice("lmstudio/".length).trim();
  }
  return trimmed;
}

function resolveRequestedContextLength(model: StreamModel): number | undefined {
  const withContextTokens = model as StreamModel & { contextTokens?: unknown };
  const contextTokens = asPositiveSafeInteger(withContextTokens.contextTokens);
  if (contextTokens !== undefined) {
    return contextTokens;
  }
  const contextWindow = asPositiveSafeInteger(model.contextWindow);
  if (contextWindow !== undefined) {
    return contextWindow;
  }
  return undefined;
}

function resolveModelHeaders(model: StreamModel): Record<string, string> | undefined {
  if (!model.headers || typeof model.headers !== "object" || Array.isArray(model.headers)) {
    return undefined;
  }
  return model.headers;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function shouldPreloadLmstudioModels(value: unknown): boolean {
  const providerConfig = toRecord(value);
  const params = toRecord(providerConfig?.params);
  return params?.preload !== false;
}

function withLmstudioUsageCompat(model: StreamModel): StreamModel {
  return {
    ...model,
    compat: {
      ...(model.compat && typeof model.compat === "object" ? model.compat : {}),
      supportsUsageInStreaming: true,
    },
  };
}

function withLmstudioResolvedModelKey(
  model: StreamModel,
  resolvedModelKey: string | undefined,
): StreamModel {
  if (!resolvedModelKey || model.id === resolvedModelKey) {
    return model;
  }
  return {
    ...model,
    id: resolvedModelKey,
  };
}

function resolveLmstudioModelKeyFromError(error: unknown): string | undefined {
  let current = error;
  const seen = new Set<object>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { cause?: unknown; resolvedModelKey?: unknown };
    const resolvedModelKey =
      typeof record.resolvedModelKey === "string" ? record.resolvedModelKey.trim() : "";
    if (resolvedModelKey) {
      return resolvedModelKey;
    }
    current = record.cause;
  }
  return undefined;
}

function createPreloadKey(params: {
  baseUrl: string;
  modelKey: string;
  requestedContextLength?: number;
}) {
  return `${params.baseUrl}::${params.modelKey}::${params.requestedContextLength ?? "default"}`;
}

async function ensureLmstudioModelLoadedBestEffort(params: {
  baseUrl: string;
  modelKey: string;
  requestedContextLength?: number;
  options: StreamOptions;
  ctx: ProviderWrapStreamFnContext;
  modelHeaders?: Record<string, string>;
}): Promise<string> {
  const providerConfig = params.ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID];
  const providerHeaders = { ...providerConfig?.headers, ...params.modelHeaders };
  const runtimeApiKey =
    typeof params.options?.apiKey === "string" && params.options.apiKey.trim().length > 0
      ? params.options.apiKey.trim()
      : undefined;
  const headers = await resolveLmstudioProviderHeaders({
    config: params.ctx.config,
    headers: providerHeaders,
  });
  const configuredApiKey =
    runtimeApiKey !== undefined
      ? undefined
      : await resolveLmstudioRuntimeApiKey({
          config: params.ctx.config,
          agentDir: params.ctx.agentDir,
          headers: providerHeaders,
        });

  return await ensureLmstudioModelLoaded({
    baseUrl: params.baseUrl,
    apiKey: runtimeApiKey ?? configuredApiKey,
    headers,
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
    modelKey: params.modelKey,
    requestedContextLength: params.requestedContextLength,
  });
}

export function wrapLmstudioInferencePreload(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  // LM Studio does not ride the shared OpenAI provider hook stack, so the
  // thinking-level payload rewrite must be composed here: without it, thinking
  // "off" leaves the transport's defaulted reasoning_effort (an enabled level)
  // in requests to binary-thinking servers.
  const streamWithThinkingLevel = createOpenAICompatibleCompletionsThinkingOffWrapper(
    createPlainTextToolCallCompatWrapper(underlying),
    ctx.thinkingLevel,
  );
  return (model, context, options) => {
    if (model.provider !== LMSTUDIO_PROVIDER_ID) {
      return underlying(model, context, options);
    }
    const modelKey = normalizeLmstudioModelKey(model.id);
    if (!modelKey) {
      return underlying(model, context, options);
    }
    const providerConfig = ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID];
    if (!shouldPreloadLmstudioModels(providerConfig)) {
      return streamWithThinkingLevel(withLmstudioUsageCompat(model), context, options);
    }
    const providerBaseUrl = providerConfig?.baseUrl;
    const resolvedBaseUrl = resolveLmstudioInferenceBase(
      typeof model.baseUrl === "string" ? model.baseUrl : providerBaseUrl,
    );
    const requestedContextLength = resolveRequestedContextLength(model);
    const preloadKey = createPreloadKey({
      baseUrl: resolvedBaseUrl,
      modelKey,
      requestedContextLength,
    });

    const cooldownEntry = isPreloadCoolingDown(preloadKey, Date.now());
    const existing = preloadInFlight.get(preloadKey);
    const preloadPromise: Promise<string | undefined> | undefined =
      existing ??
      (cooldownEntry
        ? undefined
        : (() => {
            const created = ensureLmstudioModelLoadedBestEffort({
              baseUrl: resolvedBaseUrl,
              modelKey,
              requestedContextLength,
              options,
              ctx,
              modelHeaders: resolveModelHeaders(model),
            })
              .then(
                (resolvedModelKey) => {
                  recordPreloadSuccess(preloadKey);
                  return resolvedModelKey;
                },
                (error: unknown) => {
                  const resolvedModelKey = resolveLmstudioModelKeyFromError(error);
                  const entry = recordPreloadFailure(preloadKey, Date.now(), resolvedModelKey);
                  throw Object.assign(new Error("preload-failed"), {
                    cause: error,
                    consecutiveFailures: entry.consecutiveFailures,
                    cooldownMs: entry.untilMs - Date.now(),
                    resolvedModelKey,
                  });
                },
              )
              .finally(() => {
                preloadInFlight.delete(preloadKey);
              });
            preloadInFlight.set(preloadKey, created);
            return created;
          })());

    return (async () => {
      let resolvedModelKey: string | undefined;
      if (preloadPromise) {
        try {
          resolvedModelKey = await preloadPromise;
        } catch (error) {
          const annotated = error as {
            cause?: unknown;
            consecutiveFailures?: number;
            cooldownMs?: number;
          };
          resolvedModelKey = resolveLmstudioModelKeyFromError(error);
          const cause = annotated.cause ?? error;
          const failures = annotated.consecutiveFailures ?? 1;
          const cooldownSec = Math.max(0, Math.round((annotated.cooldownMs ?? 0) / 1000));
          log.warn(
            `LM Studio inference preload failed for "${modelKey}" (${failures} consecutive failure${
              failures === 1 ? "" : "s"
            }, next preload attempt skipped for ~${cooldownSec}s); continuing without preload: ${String(cause)}`,
          );
        }
      } else if (cooldownEntry) {
        resolvedModelKey = cooldownEntry.resolvedModelKey;
        log.debug(
          `LM Studio inference preload for "${modelKey}" skipped while backoff active (${cooldownEntry.consecutiveFailures} prior failures)`,
        );
      }
      // LM Studio uses OpenAI-compatible streaming usage payloads when requested via
      // `stream_options.include_usage`. Force this compat flag at call time so usage
      // reporting remains enabled even when catalog entries omitted compat metadata.
      const streamModel = withLmstudioResolvedModelKey(model, resolvedModelKey);
      const stream = streamWithThinkingLevel(
        withLmstudioUsageCompat(streamModel),
        context,
        options,
      );
      const resolvedStream = stream instanceof Promise ? await stream : stream;
      return resolvedStream;
    })();
  };
}
