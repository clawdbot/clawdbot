import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, streamSimple } from "@earendil-works/pi-ai";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import { LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import { ensureLmstudioModelLoaded } from "./models.fetch.js";
import { resolveLmstudioInferenceBase } from "./models.js";
import {
  createLmstudioSyntheticToolCallId,
  parseLmstudioPlainTextToolCalls,
} from "./plain-text-tool-calls.js";
import { resolveLmstudioProviderHeaders, resolveLmstudioRuntimeApiKey } from "./runtime.js";

const log = createSubsystemLogger("extensions/lmstudio/stream");

type StreamOptions = Parameters<StreamFn>[2];
type StreamModel = Parameters<StreamFn>[0];
type StreamContext = Parameters<StreamFn>[1];

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

function resolveContextToolNames(context: StreamContext): Set<string> {
  const tools = (context as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return new Set();
  }
  const names = tools
    .map((tool) => {
      const record = toRecord(tool);
      return typeof record?.name === "string" && record.name.trim() ? record.name : undefined;
    })
    .filter((name): name is string => Boolean(name));
  return new Set(names);
}

function couldStillBePlainTextToolCall(text: string): boolean {
  if (text.length > 256_000) {
    return false;
  }
  const trimmed = text.trimStart();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("<|channel|>") ||
    trimmed.startsWith("commentary") ||
    trimmed.startsWith("analysis") ||
    trimmed.startsWith("final")
  );
}

function createLmstudioToolCallBlock(parsed: {
  arguments: Record<string, unknown>;
  name: string;
}): Record<string, unknown> {
  return {
    type: "toolCall",
    id: createLmstudioSyntheticToolCallId(),
    name: parsed.name,
    arguments: parsed.arguments,
    partialArgs: JSON.stringify(parsed.arguments),
  };
}

function promoteLmstudioPlainTextToolCalls(
  message: unknown,
  toolNames: Set<string>,
): Record<string, unknown> | undefined {
  const messageRecord = toRecord(message);
  if (!messageRecord) {
    return undefined;
  }
  if (!Array.isArray(messageRecord.content)) {
    if (typeof messageRecord.content !== "string" || !messageRecord.content.trim()) {
      return undefined;
    }
    const parsed = parseLmstudioPlainTextToolCalls(messageRecord.content, toolNames);
    if (!parsed) {
      return undefined;
    }
    return {
      ...messageRecord,
      content: parsed.map(createLmstudioToolCallBlock),
      stopReason: "toolUse",
    };
  }
  if (
    messageRecord.content.some((block) => toRecord(block)?.type === "toolCall") ||
    messageRecord.content.length === 0
  ) {
    return undefined;
  }

  let promoted = false;
  const nextContent: Array<Record<string, unknown>> = [];
  for (const block of messageRecord.content) {
    const blockRecord = toRecord(block);
    if (!blockRecord) {
      return undefined;
    }
    if (blockRecord.type !== "text") {
      nextContent.push(blockRecord);
      continue;
    }
    const text = typeof blockRecord.text === "string" ? blockRecord.text : "";
    if (!text.trim()) {
      continue;
    }
    const parsed = parseLmstudioPlainTextToolCalls(text, toolNames);
    if (!parsed) {
      return undefined;
    }
    nextContent.push(...parsed.map(createLmstudioToolCallBlock));
    promoted = true;
  }

  if (!promoted) {
    return undefined;
  }
  return {
    ...messageRecord,
    content: nextContent,
    stopReason: "toolUse",
  };
}

function emitPromotedToolCallEvents(
  stream: { push(event: unknown): void },
  message: Record<string, unknown>,
): void {
  const content = Array.isArray(message.content) ? message.content : [];
  content.forEach((block, contentIndex) => {
    const record = toRecord(block);
    if (record?.type !== "toolCall") {
      return;
    }
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
    stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta: typeof record.partialArgs === "string" ? record.partialArgs : "{}",
      partial: message,
    });
  });
}

function wrapLmstudioPlainTextToolCalls(
  source: ReturnType<StreamFn>,
  context: StreamContext,
): ReturnType<StreamFn> {
  const toolNames = resolveContextToolNames(context);
  if (toolNames.size === 0) {
    return source;
  }
  const output = createAssistantMessageEventStream();
  const stream = output as unknown as { push(event: unknown): void; end(): void };

  void (async () => {
    const bufferedTextEvents: unknown[] = [];
    let bufferedText = "";
    let ended = false;
    const endStream = () => {
      if (!ended) {
        ended = true;
        stream.end();
      }
    };
    const flushBufferedTextEvents = () => {
      for (const event of bufferedTextEvents.splice(0)) {
        stream.push(event);
      }
      bufferedText = "";
    };

    try {
      for await (const event of source as AsyncIterable<unknown>) {
        const record = toRecord(event);
        const type = typeof record?.type === "string" ? record.type : "";

        if (type === "text_start" || type === "text_delta" || type === "text_end") {
          bufferedTextEvents.push(event);
          if (typeof record?.delta === "string") {
            bufferedText += record.delta;
          } else if (typeof record?.content === "string" && !bufferedText) {
            bufferedText = record.content;
          }
          if (!couldStillBePlainTextToolCall(bufferedText)) {
            flushBufferedTextEvents();
          }
          continue;
        }

        if (type === "done") {
          const promotedMessage = promoteLmstudioPlainTextToolCalls(record?.message, toolNames);
          if (promotedMessage) {
            bufferedTextEvents.splice(0);
            bufferedText = "";
            emitPromotedToolCallEvents(stream, promotedMessage);
            stream.push({ ...record, reason: "toolUse", message: promotedMessage });
          } else {
            flushBufferedTextEvents();
            stream.push(event);
          }
          endStream();
          return;
        }

        flushBufferedTextEvents();
        stream.push(event);
        if (type === "error") {
          endStream();
          return;
        }
      }
      flushBufferedTextEvents();
    } catch (error) {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      endStream();
    }
  })();

  return output as ReturnType<StreamFn>;
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
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
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
    const providerConfig = ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID];
    if (!shouldPreloadLmstudioModels(providerConfig)) {
      const stream = underlying(withLmstudioUsageCompat(model), context, options);
      return (async () => {
        const resolvedStream = stream instanceof Promise ? await stream : stream;
        return wrapLmstudioPlainTextToolCalls(resolvedStream, context);
      })();
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
          const cooldownSec = Math.max(0, Math.round((annotated.cooldownMs ?? 0) / 1000));
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
      const stream = underlying(withLmstudioUsageCompat(model), context, options);
      const resolvedStream = stream instanceof Promise ? await stream : stream;
      return wrapLmstudioPlainTextToolCalls(resolvedStream, context);
    })();
  };
}
