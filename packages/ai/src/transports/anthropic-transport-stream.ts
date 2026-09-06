import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFn,
} from "@openclaw/llm-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
/**
 * Native Anthropic Messages streaming transport.
 * Converts OpenClaw contexts/tools into Anthropic payloads, streams SSE events
 * back into runtime output blocks, and applies provider request policy.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import type { AnthropicOptions } from "../provider-options.js";
import {
  isAnthropicOAuthApiKey,
  omitFoundryBearerCredentialHeaders,
  usesFoundryBearerAuth,
} from "../providers/anthropic-auth-headers.js";
import {
  applyClaudeRequestContract,
  ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
  ANTHROPIC_CLAUDE_CODE_VERSION,
  defaultsClaudeAdaptiveThinking,
  prepareClaudeNoPrefillRequestContext,
  requiresClaudeAdaptiveThinking,
  resolveAnthropicThinkingEffort,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeAdaptiveThinking,
  usesClaudeFable5MessagesContract,
  usesClaudeStreamingRefusalContract,
} from "../providers/anthropic-model-contract.js";
import {
  ANTHROPIC_SERVER_SIDE_FALLBACK_BETA,
  ANTHROPIC_SERVER_SIDE_FALLBACKS,
} from "../providers/anthropic-server-fallback.js";
import { applyAnthropicThinkingBindingControls } from "../providers/anthropic-thinking-replay.js";
import {
  normalizeAnthropicToolCallId,
  type AnthropicToolProjection,
} from "../providers/anthropic-tool-projection.js";
import { adjustMaxTokensForThinking } from "../providers/simple-options.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import {
  buildAnthropicReplayPlan,
  isAnthropicReplayRejection,
  suppressAnthropicCompaction,
} from "./anthropic-compaction-replay.js";
import {
  convertAnthropicMessages,
  convertAnthropicTools,
  buildAnthropicGenerationParams,
} from "./anthropic-messages.js";
import {
  applyAnthropicPayloadPolicyToParams,
  applyAnthropicContextManagementToRequest,
  isDirectAnthropicModel,
  resolveAnthropicContextManagementBetaHeader,
  resolveAnthropicPayloadPolicy,
} from "./anthropic-payload-policy.js";
import { consumeAnthropicStream, type AnthropicStreamBlock } from "./anthropic-stream-reducer.js";
import {
  buildGuardedModelFetch,
  resolveProviderEndpoint,
  transformTransportMessages,
} from "./host-policy.js";
import {
  copyProviderAcceptanceObserver,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  notifyProviderHttpResponse,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";
import {
  createAbortError as createNamedAbortError,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  parseRetryAfterSeconds,
  readResponseTextSnippet,
  resolveModelHeaderSentinels,
} from "./transport-utils.js";

const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES = 8 * 1024;
const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS = 400;
const ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS = 10_000;
const ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS = 4_096;
const ANTHROPIC_MESSAGES_FALLBACK_CONTEXT_DIVISOR = 4;
// Mirror the fetch sanitizer cap here because compatible routes such as Kimi
// bypass that layer; without a parser-local guard, partial frames grow forever.
const ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS = 16 * 1024 * 1024;
type AnthropicTransportModel = Model<"anthropic-messages"> & {
  headers?: Record<string, string>;
  provider: string;
};

type AnthropicTransportOptions = AnthropicOptions &
  Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets" | "stop"> & {
    authProfileId?: string;
  };
type AnthropicMessagesClient = {
  messages: {
    stream(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal; headers?: Record<string, string> },
    ): Promise<{
      response: Response;
      stream: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>;
    }>;
  };
};

function resolveAnthropicRequestModelId(model: AnthropicTransportModel): string {
  if (isDirectAnthropicModel(model) && /^anthropic\//i.test(model.id)) {
    return model.id.replace(/^anthropic\//i, "");
  }
  return model.id;
}

const EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT = ".";

function resolvePositiveAnthropicTokenLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

function resolveAnthropicMessagesMaxTokens(params: {
  modelContextWindow: number | undefined;
  modelMaxTokens: number | undefined;
  requestedMaxTokens: number | undefined;
  useModelDefault?: boolean;
}): number | undefined {
  const requested = resolvePositiveAnthropicTokenLimit(params.requestedMaxTokens);
  if (requested !== undefined) {
    return requested;
  }
  const modelMax = resolvePositiveAnthropicTokenLimit(params.modelMaxTokens);
  if (modelMax !== undefined) {
    return params.useModelDefault ? modelMax : Math.min(modelMax, 32_000);
  }
  if (params.modelMaxTokens !== undefined) {
    return undefined;
  }
  // Anthropic requires max_tokens even when an optional custom-model row has no output cap.
  // Use a conservative compatibility baseline; higher model limits require explicit metadata.
  const contextWindow = resolvePositiveAnthropicTokenLimit(params.modelContextWindow);
  return contextWindow === undefined
    ? ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS
    : Math.max(
        1,
        Math.min(
          ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS,
          Math.floor(contextWindow / ANTHROPIC_MESSAGES_FALLBACK_CONTEXT_DIVISOR),
        ),
      );
}

function isKimiAnthropicProvider(provider: string | undefined): boolean {
  return /^kimi(?:-|$)/.test(normalizeLowercaseStringOrEmpty(provider ?? ""));
}

/**
 * Server-side refusal fallback is a first-party Claude API beta: proxies and
 * Bedrock/Vertex/Foundry reject the `fallbacks` param, and OAuth (Claude Code
 * identity) requests are excluded until the beta is verified there.
 */
function useAnthropicServerSideFallback(model: AnthropicTransportModel): boolean {
  return (
    (usesClaudeFable5MessagesContract(model) ||
      resolveClaudeOpus5ModelIdentity(model) !== undefined) &&
    isDirectAnthropicModel(model)
  );
}

function supportsReasoningContentReplay(
  model: Pick<AnthropicTransportModel, "provider" | "baseUrl">,
): boolean {
  return resolveProviderEndpoint(model).endpointClass === "xiaomi-native";
}

function buildAnthropicBetaHeader(
  model: AnthropicTransportModel,
  betaFeatures: readonly string[],
  params: { oauth: boolean },
): string | undefined {
  if (!isDirectAnthropicModel(model)) {
    return undefined;
  }
  return params.oauth
    ? `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`
    : betaFeatures.join(",");
}

function ensureNonEmptyAnthropicMessages(messages: Array<Record<string, unknown>>) {
  return messages.length > 0
    ? messages
    : [{ role: "user", content: EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT }];
}

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Resolve the effective Anthropic API base URL from model or environment. */
function resolveAnthropicBaseUrl(baseUrl?: string): string {
  return baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL;
}

/** Resolve the Anthropic Messages endpoint URL for the effective base URL. */
export function resolveAnthropicMessagesUrl(baseUrl?: string): string {
  const normalized = resolveAnthropicBaseUrl(baseUrl).replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function withEffectiveAnthropicBaseUrl(model: AnthropicTransportModel): AnthropicTransportModel {
  const baseUrl = resolveAnthropicBaseUrl(model.baseUrl);
  return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return createNamedAbortError(
    "Request was aborted",
    reason === undefined ? undefined : { cause: reason },
  );
}

function readAnthropicSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reader.cancel(signal.reason).catch(() => undefined);
      reject(createAbortError(signal));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(toErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

function parseAnthropicSseEventData(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
    }
    throw error;
  }
}

function assertAnthropicSsePendingBufferWithinLimit(pendingChars: number): void {
  if (pendingChars <= ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS) {
    return;
  }
  throw new Error(
    `Anthropic Messages SSE response exceeded max pending buffer size (${ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS} chars) without event boundary`,
  );
}

async function* parseAnthropicSseBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await readAnthropicSseChunk(reader, signal);
      if (done) {
        completed = true;
        break;
      }
      buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replaceAll("\r\n", "\n");
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd >= 0) {
        assertAnthropicSsePendingBufferWithinLimit(frameEnd);
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          yield parseAnthropicSseEventData(data);
        }
        frameEnd = buffer.indexOf("\n\n");
      }
      assertAnthropicSsePendingBufferWithinLimit(buffer.length);
    }
    const tailBuffer = `${buffer}${decoder.decode()}`.replaceAll("\r\n", "\n");
    assertAnthropicSsePendingBufferWithinLimit(tailBuffer.length);
    const tail = tailBuffer.trim();
    if (tail) {
      const data = tail
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") {
        yield parseAnthropicSseEventData(data);
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel(signal?.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function createAnthropicMessagesClient(params: {
  apiKey?: string | null;
  authToken?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  fetch: typeof fetch;
}): AnthropicMessagesClient {
  const url = resolveAnthropicMessagesUrl(params.baseURL);
  return {
    messages: {
      async stream(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal; headers?: Record<string, string> },
      ) {
        const headers = new Headers(
          mergeTransportHeaders(
            {
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              ...(params.apiKey ? { "x-api-key": params.apiKey } : {}),
              ...(params.authToken ? { authorization: `Bearer ${params.authToken}` } : {}),
            },
            params.defaultHeaders,
          ),
        );
        for (const [name, value] of Object.entries(options?.headers ?? {})) {
          headers.set(name, value);
        }
        const response = await params.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        return {
          response,
          stream: response.body ? parseAnthropicSseBody(response.body, options?.signal) : [],
        };
      },
    },
  };
}

function formatAnthropicMessagesHttpError(response: Response, detail: string): string {
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
  // Keep retry timing in the canonical error text so every retry owner sees the
  // same bounded signal without extending the public AssistantMessage contract.
  const retryAfterSuffix = Number.isFinite(retryAfterSeconds)
    ? `; Retry-After: ${Math.ceil(retryAfterSeconds ?? 0)} seconds`
    : "";
  return `HTTP ${response.status}: ${detail || "Anthropic Messages request failed"}${retryAfterSuffix}`;
}

async function readAnthropicMessagesErrorBodySnippet(response: Response): Promise<string> {
  try {
    return (
      (await readResponseTextSnippet(response, {
        maxBytes: ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES,
        maxChars: ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS,
        chunkTimeoutMs: ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS,
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(
            `Anthropic Messages error response stalled: no data received for ${chunkTimeoutMs}ms`,
          ),
      })) ?? ""
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.startsWith("Anthropic Messages error response stalled:")
    ) {
      return error.message;
    }
    return "";
  }
}

function createAnthropicTransportClient(params: {
  model: AnthropicTransportModel;
  context: Context;
  apiKey: string;
  options: AnthropicTransportOptions | undefined;
}) {
  const { model, context, apiKey, options } = params;
  const needsInterleavedBeta =
    (options?.interleavedThinking ?? true) && !supportsClaudeAdaptiveThinking(model);
  // Kimi's Anthropic thinking SSE is already well-formed for this parser, but
  // the OpenAI SDK compatibility sanitizer can stall before the text block.
  const fetch =
    isKimiAnthropicProvider(model.provider) && options?.thinkingEnabled === true
      ? buildGuardedModelFetch(model, undefined, { sanitizeSse: false })
      : buildGuardedModelFetch(model);
  if (model.provider === "github-copilot") {
    const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
    return {
      client: createAnthropicMessagesClient({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
          },
          model.headers,
          getAiTransportHost().buildCopilotDynamicHeaders(context.messages),
          options?.headers,
        ),
        fetch,
      }),
      isOAuthToken: false,
    };
  }
  if (usesFoundryBearerAuth(resolveModelHeaderSentinels(model))) {
    const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
    return {
      client: createAnthropicMessagesClient({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
          },
          omitFoundryBearerCredentialHeaders(model.headers),
          options?.headers,
        ),
        fetch,
      }),
      isOAuthToken: false,
    };
  }
  const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
  if (needsInterleavedBeta) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }
  if (isAnthropicOAuthApiKey(apiKey)) {
    const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: true });
    return {
      client: createAnthropicMessagesClient({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
            "user-agent": `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION}`,
            "x-app": "cli",
          },
          model.headers,
          options?.headers,
        ),
        fetch,
      }),
      isOAuthToken: true,
    };
  }
  if (useAnthropicServerSideFallback(model)) {
    betaFeatures.push(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA);
  }
  const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: false });
  const defaultHeaders = mergeTransportHeaders(
    {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
    },
    model.headers,
    options?.headers,
  );
  return {
    client: createAnthropicMessagesClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders,
      fetch,
    }),
    isOAuthToken: false,
    // Binding controls are verified only on direct API-key requests, not OAuth or proxies.
    directApiKeyBetaHeader: isDirectAnthropicModel(model)
      ? (new Headers(defaultHeaders).get("anthropic-beta") ?? "")
      : undefined,
  };
}

async function buildAnthropicParams(
  model: AnthropicTransportModel,
  context: Context,
  isOAuthToken: boolean,
  options: AnthropicTransportOptions | undefined,
): Promise<{
  params: Record<string, unknown>;
  toolProjection?: AnthropicToolProjection;
  usedCompactionReplay: boolean;
}> {
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  const replayThinkingEnabled = mandatoryAdaptiveThinking || options?.thinkingEnabled === true;
  const maxTokens = resolveAnthropicMessagesMaxTokens({
    modelContextWindow: model.contextWindow,
    modelMaxTokens: model.maxTokens,
    requestedMaxTokens: options?.maxTokens,
  });
  if (maxTokens === undefined) {
    throw new Error(
      `Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`,
    );
  }
  const payloadPolicy = resolveAnthropicPayloadPolicy(
    {
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      cacheRetention: options?.cacheRetention,
      enableCacheControl: true,
    },
    model,
  );
  const replayPlan = buildAnthropicReplayPlan(context.messages, model, {
    enabled: !isOAuthToken && options?.anthropicServerCompaction === true,
    authProfileId: options?.authProfileId,
    sessionId: options?.sessionId,
  });
  const messages = await convertAnthropicMessages(
    transformTransportMessages(replayPlan.messages, model, normalizeAnthropicToolCallId),
    model,
    isOAuthToken,
    {
      profile: "transport",
      allowReasoningContentReplay: supportsReasoningContentReplay(model),
      compaction: replayPlan.compaction,
      replayThinkingEnabled,
    },
  );
  const params: Record<string, unknown> = {
    model: resolveAnthropicRequestModelId(model),
    messages: ensureNonEmptyAnthropicMessages(messages),
    max_tokens: maxTokens,
    stream: true,
  };
  // Fable 5 and Opus 5 safety classifiers can decline benign-adjacent work.
  // Anthropic owns the per-category fallback recommendation so routing can
  // evolve without a client release.
  if (!isOAuthToken && useAnthropicServerSideFallback(model)) {
    params.fallbacks = ANTHROPIC_SERVER_SIDE_FALLBACKS;
  }
  if (isOAuthToken) {
    params.system = [
      // Anthropic requires this first block to route Claude subscription OAuth billing.
      {
        type: "text",
        text: ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      ...(context.systemPrompt
        ? [
            {
              type: "text",
              text: sanitizeTransportPayloadText(context.systemPrompt),
            },
          ]
        : []),
    ];
  } else if (context.systemPrompt) {
    params.system = [
      {
        type: "text",
        text: sanitizeTransportPayloadText(context.systemPrompt),
      },
    ];
  }
  const convertedTools = context.tools
    ? convertAnthropicTools(context.tools, isOAuthToken)
    : undefined;
  const toolProjection = convertedTools?.projection;
  Object.assign(
    params,
    buildAnthropicGenerationParams({
      model,
      options,
      tools: convertedTools?.tools,
      toolProjection,
      profile: "transport",
    }),
  );
  // Anthropic-family carriers are append-only, so they are stable cache anchors too.
  applyAnthropicPayloadPolicyToParams(params, payloadPolicy, new Set());
  return { params, toolProjection, usedCompactionReplay: replayPlan.compaction !== undefined };
}

function resolveAnthropicTransportOptions(
  model: AnthropicTransportModel,
  options: AnthropicTransportOptions | undefined,
  apiKey: string,
): AnthropicTransportOptions {
  const baseMaxTokens = resolveAnthropicMessagesMaxTokens({
    modelContextWindow: model.contextWindow,
    modelMaxTokens: model.maxTokens,
    requestedMaxTokens: options?.maxTokens,
    // Claude 5 defaults thinking on; the clamped 32k baseline starves thinking
    // plus response output, so these models keep their full catalog cap.
    useModelDefault:
      resolveClaudeSonnet5ModelIdentity(model) !== undefined ||
      resolveClaudeOpus5ModelIdentity(model) !== undefined,
  });
  if (baseMaxTokens === undefined) {
    throw new Error(
      `Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`,
    );
  }
  const reasoningModelMaxTokens =
    resolvePositiveAnthropicTokenLimit(model.maxTokens) ?? baseMaxTokens;
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  const reasoning =
    options?.reasoning === "off" && mandatoryAdaptiveThinking ? "low" : options?.reasoning;
  const resolved: AnthropicTransportOptions = copyProviderAcceptanceObserver(options, {
    temperature: options?.temperature,
    stop: options?.stop,
    maxTokens: baseMaxTokens,
    signal: options?.signal,
    apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    interleavedThinking: options?.interleavedThinking,
    toolChoice: options?.toolChoice,
    thinkingBudgets: options?.thinkingBudgets,
    reasoning,
    anthropicServerCompaction: options?.anthropicServerCompaction,
    anthropicCompactThreshold: options?.anthropicCompactThreshold,
    cacheTtlPruning: options?.cacheTtlPruning,
    ...(options?.authProfileId ? { authProfileId: options.authProfileId } : {}),
  });
  if (reasoning === "off") {
    resolved.thinkingEnabled = false;
    return resolved;
  }
  if (!reasoning) {
    resolved.thinkingEnabled = defaultsClaudeAdaptiveThinking(model);
    if (resolved.thinkingEnabled) {
      resolved.effort = "high";
    }
    return resolved;
  }
  if (supportsClaudeAdaptiveThinking(model)) {
    resolved.thinkingEnabled = true;
    resolved.effort = resolveAnthropicThinkingEffort(model, reasoning);
    return resolved;
  }
  const adjusted = adjustMaxTokensForThinking(
    baseMaxTokens,
    reasoningModelMaxTokens,
    reasoning === "max" ? "high" : reasoning,
    options?.thinkingBudgets,
  );
  // Sub-minimum budgets (< 1024) resolve to thinking disabled so downstream
  // consumers (payload, replay, temperature, tool-choice) see consistent state.
  const thinkingEnabled = adjusted.thinkingBudget >= 1024;
  resolved.maxTokens = adjusted.maxTokens;
  resolved.thinkingEnabled = thinkingEnabled;
  resolved.thinkingBudgetTokens = thinkingEnabled ? adjusted.thinkingBudget : undefined;
  return resolved;
}

/** Create the stream function used by Anthropic Messages transport models. */
export function createAnthropicMessagesTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = withEffectiveAnthropicBaseUrl(rawModel as AnthropicTransportModel);
    const options = rawOptions as AnthropicTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: model.provider,
        model: model.id,
        usage: createEmptyTransportUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      // Classifier refusals can invalidate partial output, so no event is safe
      // to expose until the terminal stop reason is known.
      const refusalBuffer = usesClaudeStreamingRefusalContract(model)
        ? createDeferredEventBuffer<AssistantMessageEvent>(stream)
        : undefined;
      let usedCompactionReplay = false;
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
        const requestContext = prepareClaudeNoPrefillRequestContext(model, context);
        const { client, isOAuthToken, directApiKeyBetaHeader } = createAnthropicTransportClient({
          model,
          context: requestContext,
          apiKey,
          options: transportOptions,
        });
        const builtParams = await buildAnthropicParams(
          model,
          requestContext,
          isOAuthToken,
          transportOptions,
        );
        usedCompactionReplay = builtParams.usedCompactionReplay;
        let params = builtParams.params;
        const toolProjection = builtParams.toolProjection;
        applyAnthropicContextManagementToRequest(
          params,
          model,
          transportOptions,
          directApiKeyBetaHeader,
        );
        const nextParams = await transportOptions.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as Record<string, unknown>;
        }
        applyClaudeRequestContract(params, model);
        const betaHeader = resolveAnthropicContextManagementBetaHeader(
          params,
          directApiKeyBetaHeader,
        );
        const bindingHeaders =
          applyAnthropicThinkingBindingControls(params, betaHeader) ??
          (betaHeader !== undefined ? { "anthropic-beta": betaHeader } : undefined);
        const { response, stream: anthropicStream } = await client.messages.stream(
          { ...params, stream: true },
          { signal: transportOptions.signal, headers: bindingHeaders },
        );
        await notifyProviderHttpResponse({ options: transportOptions, response, model });
        if (!response.ok) {
          const detail = await readAnthropicMessagesErrorBodySnippet(response);
          throw new Error(formatAnthropicMessagesHttpError(response, detail));
        }
        await consumeAnthropicStream({
          events: anthropicStream,
          model,
          options: transportOptions,
          output,
          stream,
          refusalBuffer,
          isOAuthToken,
          toolProjection,
          profile: "transport",
        });
        finalizeTransportStream({ stream, output });
      } catch (error) {
        failTransportStream({
          stream,
          output,
          signal: options?.signal,
          error,
          cleanup: () => {
            if (refusalBuffer) {
              refusalBuffer.discard();
              output.content = [];
            } else {
              output.content = output.content.filter((block) => block.type !== "toolCall");
            }
            if (usedCompactionReplay && isAnthropicReplayRejection(error)) {
              suppressAnthropicCompaction(output, model, options);
            }
            for (const block of output.content) {
              delete (block as AnthropicStreamBlock).index;
            }
          },
        });
      }
    })();
    return eventStream;
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
