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
    const existing = preloadInFlight.get(preloadKey);
    const preloadPromise =
      existing ??
      ensureLmstudioModelLoadedBestEffort({
        baseUrl: resolvedBaseUrl,
        modelKey,
        requestedContextLength,
        options,
        ctx,
        modelHeaders: resolveModelHeaders(model),
      }).finally(() => {
        preloadInFlight.delete(preloadKey);
      });
    if (!existing) {
      preloadInFlight.set(preloadKey, preloadPromise);
    }

    return (async () => {
      try {
        await preloadPromise;
      } catch (error) {
        log.warn(
          `LM Studio inference preload failed for "${modelKey}"; continuing without preload: ${String(error)}`,
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
