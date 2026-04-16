import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import { ensureLmstudioModelLoaded } from "./models.fetch.js";
import { resolveLmstudioInferenceBase } from "./models.js";
import { resolveLmstudioProviderHeaders, resolveLmstudioRuntimeApiKey } from "./runtime.js";

const log = createSubsystemLogger("extensions/lmstudio/stream");

type StreamOptions = Parameters<StreamFn>[2];
type StreamModel = Parameters<StreamFn>[0];

const preloadInFlight = new Map<string, Promise<void>>();

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

function recordPreloadFailure(preloadKey: string, now: number): PreloadCooldownEntry {
  const existing = preloadCooldown.get(preloadKey);
  const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
  const entry: PreloadCooldownEntry = {
    consecutiveFailures,
    untilMs: now + computePreloadBackoffMs(consecutiveFailures),
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

/** Test-only hook for clearing preload cooldown state between cases. */
export function __resetLmstudioPreloadCooldownForTest(): void {
  preloadCooldown.clear();
  preloadInFlight.clear();
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
  const contextTokens =
    typeof withContextTokens.contextTokens === "number" &&
    Number.isFinite(withContextTokens.contextTokens)
      ? Math.floor(withContextTokens.contextTokens)
      : undefined;
  if (contextTokens && contextTokens > 0) {
    return contextTokens;
  }
  const contextWindow =
    typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
      ? Math.floor(model.contextWindow)
      : undefined;
  if (contextWindow && contextWindow > 0) {
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

function createPreloadKey(params: {
  baseUrl: string;
  modelKey: string;
  requestedContextLength?: number;
}) {
  return `${params.baseUrl}::${params.modelKey}::${params.requestedContextLength ?? "default"}`;
}

function buildLmstudioPreloadSsrFPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

async function ensureLmstudioModelLoadedBestEffort(params: {
  baseUrl: string;
  modelKey: string;
  requestedContextLength?: number;
  options: StreamOptions;
  ctx: ProviderWrapStreamFnContext;
  modelHeaders?: Record<string, string>;
}): Promise<void> {
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

  await ensureLmstudioModelLoaded({
    baseUrl: params.baseUrl,
    apiKey: runtimeApiKey ?? configuredApiKey,
    headers,
    ssrfPolicy: buildLmstudioPreloadSsrFPolicy(params.baseUrl),
    modelKey: params.modelKey,
    requestedContextLength: params.requestedContextLength,
  });
}

export function wrapLmstudioInferencePreload(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== LMSTUDIO_PROVIDER_ID) {
      return underlying(model, context, options);
    }
    const modelKey = normalizeLmstudioModelKey(model.id);
    if (!modelKey) {
      return underlying(model, context, options);
    }
    const providerBaseUrl = ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID]?.baseUrl;
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
    const preloadPromise: Promise<void> | undefined =
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
                () => {
                  recordPreloadSuccess(preloadKey);
                },
                (error) => {
                  const entry = recordPreloadFailure(preloadKey, Date.now());
                  throw Object.assign(new Error("preload-failed"), {
                    cause: error,
                    consecutiveFailures: entry.consecutiveFailures,
                    cooldownMs: entry.untilMs - Date.now(),
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
      if (preloadPromise) {
        try {
          await preloadPromise;
        } catch (error) {
          const annotated = error as {
            cause?: unknown;
            consecutiveFailures?: number;
            cooldownMs?: number;
          };
          const cause = annotated.cause ?? error;
          const failures = annotated.consecutiveFailures ?? 1;
          const cooldownSec = Math.max(
            0,
            Math.round((annotated.cooldownMs ?? 0) / 1000),
          );
          log.warn(
            `LM Studio inference preload failed for "${modelKey}" (${failures} consecutive failure${
              failures === 1 ? "" : "s"
            }, next preload attempt skipped for ~${cooldownSec}s); continuing without preload: ${String(cause)}`,
          );
        }
      } else if (cooldownEntry) {
        log.debug(
          `LM Studio inference preload for "${modelKey}" skipped while backoff active (${cooldownEntry.consecutiveFailures} prior failures)`,
        );
      }
      // LM Studio uses OpenAI-compatible streaming usage payloads when requested via
      // `stream_options.include_usage`. Force this compat flag at call time so usage
      // reporting remains enabled even when catalog entries omitted compat metadata.
      const modelWithUsageCompat = {
        ...model,
        compat: {
          ...(model.compat && typeof model.compat === "object" ? model.compat : {}),
          supportsUsageInStreaming: true,
        },
      };
      const stream = underlying(modelWithUsageCompat, context, options);
      return stream instanceof Promise ? await stream : stream;
    })();
  };
}
