import type {
  AssistantMessageDiagnostic,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  StreamFn,
  TextContent,
  Usage,
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
import {
  createAnthropicInlineImageBudget,
  normalizeAnthropicInlineContent,
  resolveAnthropicImageMediaType,
  type AnthropicInlineImageBudget,
} from "../internal/anthropic-inline-images.js";
import { calculateCost } from "../model-utils.js";
import type { AnthropicOptions, AnthropicThinkingDisplay } from "../provider-options.js";
import {
  omitFoundryBearerCredentialHeaders,
  usesFoundryBearerAuth,
} from "../providers/anthropic-auth-headers.js";
import {
  buildAnthropicGuardedFetch,
  canGuardAnthropicServerFallbackDispatch,
} from "../providers/anthropic-guarded-fetch.js";
import {
  applyClaudeRequestContract,
  ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
  ANTHROPIC_CLAUDE_CODE_VERSION,
  defaultsClaudeAdaptiveThinking,
  mapAnthropicStopReason,
  prepareClaudeNoPrefillRequestContext,
  requiresClaudeAdaptiveThinking,
  resolveAnthropicThinkingEffort,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeXhighEffort,
  usesClaudeFable5MessagesContract,
  usesClaudeStreamingRefusalContract,
} from "../providers/anthropic-model-contract.js";
import { applyAnthropicRefusal } from "../providers/anthropic-refusal.js";
import {
  ANTHROPIC_SERVER_SIDE_FALLBACK_BETA,
  ANTHROPIC_SERVER_SIDE_FALLBACKS,
  applyAnthropicFallbackContentBoundary,
  applyAnthropicFallbackServingModel,
  assertAnthropicServerFallbackPayloadAuthorized,
  isCanonicalAnthropicPublicUrl,
  preserveAnthropicServerFallbackBetaHeader,
  readAnthropicFallbackBoundary,
  resolveAnthropicFallbackServingModelCost,
  snapshotAnthropicServerFallbackAuthorization,
} from "../providers/anthropic-server-fallback.js";
import {
  anthropicSseTailHasModelFragment,
  classifyUnknownAnthropicSseFrame,
  createAnthropicStreamTerminalCompleteness,
  decodeAnthropicSseField,
  isMatchingAnthropicSseEventPayload,
  type AnthropicEndpointAuthoritySnapshot,
} from "../providers/anthropic-stream-terminal.js";
import {
  ANTHROPIC_OMITTED_REASONING_TEXT,
  findActiveAnthropicToolTurnAssistantIndex,
} from "../providers/anthropic-thinking-replay.js";
import {
  normalizeAnthropicToolCallId,
  normalizeAnthropicToolChoice,
  projectAnthropicTools,
  reconcileAnthropicToolChoice,
  resolveOriginalAnthropicToolName,
  toClaudeCodeToolName,
  type AnthropicToolProjection,
} from "../providers/anthropic-tool-projection.js";
import {
  createAnthropicTransportAccounting,
  inheritAnthropicTransportAccountingContext,
  type AnthropicFallbackResolution,
  type AnthropicTransportAccounting,
} from "../providers/anthropic-transport-accounting.js";
import {
  applyAnthropicMessageDeltaUsage,
  applyAnthropicMessageStartUsage,
  type AnthropicPromptUsageSnapshot,
} from "../providers/anthropic-usage.js";
import { adjustMaxTokensForThinking } from "../providers/simple-options.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultBlockText,
  extractToolResultText,
  isImageWithMediaPayload,
} from "../providers/tool-result-text.js";
import { tagPendingCommentaryText } from "../utils/assistant-text-phase.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "./anthropic-payload-policy.js";
import { resolveProviderEndpoint, transformTransportMessages } from "./host-policy.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./json-unsafe-integers.js";
import {
  coerceTransportToolCallArguments,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
  transportAbortError,
} from "./transport-stream-shared.js";
import {
  createAbortError as createNamedAbortError,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  parseRetryAfterSeconds,
  readResponseTextSnippet,
  resolveModelHeaderSentinels,
  resolveSecretSentinel,
} from "./transport-utils.js";

type ContextUsage = NonNullable<Usage["contextUsage"]>;

const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES = 8 * 1024;
const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS = 400;
const ANTHROPIC_STANDALONE_DONE_EVENT = Symbol("openclaw_standalone_done");
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
  Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets" | "stop">;
type AnthropicMessagesClient = {
  messages: {
    stream(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<Record<string, unknown>>;
  };
};

function resolveAnthropicRequestModelId(model: AnthropicTransportModel): string {
  if (isDirectAnthropicModel(model) && /^anthropic\//i.test(model.id)) {
    return model.id.replace(/^anthropic\//i, "");
  }
  return model.id;
}

type TransportContentBlock =
  | { type: "text"; text: string; index?: number; textSignature?: string }
  | {
      type: "thinking";
      thinking: string;
      thinkingSignature: string;
      redacted?: boolean;
      index?: number;
    }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: unknown;
      partialJson?: string;
      index?: number;
    };

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<TransportContentBlock>;
  api: "anthropic-messages";
  provider: string;
  model: string;
  responseModel?: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tokenCountsOrigin?: Usage["tokenCountsOrigin"];
    tokenCountsObserved?: Usage["tokenCountsObserved"];
    reasoningTokens?: number;
    cacheWrite1h?: number;
    contextUsage?: ContextUsage;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
  diagnostics?: AssistantMessageDiagnostic[];
};

function applyAnthropicFallbackResolution(params: {
  model: AnthropicTransportModel;
  output: MutableAssistantOutput;
  resolution: AnthropicFallbackResolution;
}): AnthropicTransportModel {
  for (const transition of params.resolution.productTransitions) {
    applyAnthropicFallbackServingModel({
      output: params.output,
      boundary: transition,
      provider: params.model.provider,
    });
  }
  const servingModel =
    params.resolution.servingModel ?? params.resolution.productTransitions.at(-1)?.toModel ?? null;
  const costModel = {
    ...params.model,
    cost: resolveAnthropicFallbackServingModelCost({
      requestedModelId: params.model.id,
      servingModelId: servingModel,
      requestedCost: params.model.cost,
    }),
  };
  calculateCost(costModel, params.output.usage);
  return costModel;
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

function isAnthropicOAuthToken(apiKey: string): boolean {
  // Auth routing may inspect the real shape, but guarded fetch still receives the sentinel.
  const resolved = resolveSecretSentinel(apiKey);
  return (resolved ?? apiKey).includes("sk-ant-oat");
}

function isDirectAnthropicModel(model: Pick<AnthropicTransportModel, "provider" | "baseUrl">) {
  if (normalizeLowercaseStringOrEmpty(model.provider) !== "anthropic") {
    return false;
  }
  const endpointClass = resolveProviderEndpoint(model.baseUrl).endpointClass;
  return endpointClass === "default" || endpointClass === "anthropic-public";
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
    isDirectAnthropicModel(model) &&
    isCanonicalAnthropicPublicUrl(model.baseUrl)
  );
}

function supportsReasoningContentReplay(
  model: Pick<AnthropicTransportModel, "provider" | "baseUrl">,
): boolean {
  return resolveProviderEndpoint(model.baseUrl).endpointClass === "xiaomi-native";
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

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";

async function convertContentBlocks(
  content: readonly unknown[],
  model: { input: readonly string[] },
  imageBudget: AnthropicInlineImageBudget,
) {
  const text = extractToolResultText(content);
  const mediaPlaceholder = describeToolResultMediaPlaceholder(content);
  const hasImages = model.input.includes("image") && content.some(isImageWithMediaPayload);
  if (!hasImages) {
    return sanitizeNonEmptyTransportPayloadText(text, mediaPlaceholder ?? "(no output)");
  }
  const blocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      }
  > = [];
  let hasTextBlock = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    const blockText = extractToolResultBlockText(block);
    if (blockText) {
      blocks.push({ type: "text", text: sanitizeTransportPayloadText(blockText) });
      hasTextBlock = true;
    }
    if (!isImageWithMediaPayload(record)) {
      continue;
    }
    const [normalizedImage] = await normalizeAnthropicInlineContent(
      [
        {
          type: "image" as const,
          data: typeof record.data === "string" ? record.data : "",
          mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png",
        },
      ],
      imageBudget,
    );
    if (normalizedImage?.type !== "image") {
      continue;
    }
    blocks.push({
      type: "image" as const,
      source: {
        type: "base64",
        media_type: resolveAnthropicImageMediaType(normalizedImage.mimeType),
        data: normalizedImage.data,
      },
    });
  }
  if (!hasTextBlock) {
    blocks.unshift({ type: "text", text: mediaPlaceholder ?? "(see attached image)" });
  }
  return blocks;
}

async function convertAnthropicMessages(
  messages: Context["messages"],
  model: AnthropicTransportModel,
  isOAuthToken: boolean,
  options: {
    allowReasoningContentReplay?: boolean;
    cacheBreakpointOptOutMessageIndexes: Set<number>;
    replayThinkingEnabled?: boolean;
  },
): Promise<Array<Record<string, unknown>>> {
  const params: Array<Record<string, unknown>> = [];
  const imageBudget = createAnthropicInlineImageBudget();
  const allowReasoningContentReplay = options.allowReasoningContentReplay === true;
  const replayThinkingEnabled = options.replayThinkingEnabled !== false;
  const transformedMessages = transformTransportMessages(
    messages,
    model,
    normalizeAnthropicToolCallId,
  );
  const activeToolTurnAssistantIndex = replayThinkingEnabled
    ? -1
    : findActiveAnthropicToolTurnAssistantIndex(transformedMessages);
  for (let i = 0; i < transformedMessages.length; i += 1) {
    const msg = transformedMessages[i];
    if (!msg) {
      continue;
    }
    if (msg.role === "user") {
      const isRuntimeContextCarrier = msg.runtimeContextCarrier === true;
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          const userParam = {
            role: "user",
            content: sanitizeTransportPayloadText(msg.content),
          };
          if (isRuntimeContextCarrier) {
            options.cacheBreakpointOptOutMessageIndexes.add(params.length);
          }
          params.push(userParam);
        }
        continue;
      }
      const normalizedContent = model.input.includes("image")
        ? await normalizeAnthropicInlineContent(
            msg.content as readonly (TextContent | ImageContent)[],
            imageBudget,
          )
        : msg.content.map((item) =>
            item.type === "image"
              ? { type: "text" as const, text: NON_VISION_USER_IMAGE_PLACEHOLDER }
              : item,
          );
      const blocks: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: string; data: string };
          }
      > = normalizedContent.map((item) =>
        item.type === "text"
          ? {
              type: "text",
              text: sanitizeTransportPayloadText(item.text),
            }
          : {
              type: "image",
              source: {
                type: "base64",
                media_type: resolveAnthropicImageMediaType(item.mimeType),
                data: item.data,
              },
            },
      );
      let filteredBlocks = model.input.includes("image")
        ? blocks
        : blocks.filter((block) => block.type !== "image");
      filteredBlocks = filteredBlocks.filter(
        (block) => block.type !== "text" || block.text.trim().length > 0,
      );
      if (filteredBlocks.length === 0) {
        continue;
      }
      const userParam = {
        role: "user",
        content: filteredBlocks,
      };
      if (isRuntimeContextCarrier) {
        options.cacheBreakpointOptOutMessageIndexes.add(params.length);
      }
      params.push(userParam);
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      const reasoningContent: string[] = [];
      let omittedThinking = false;
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            blocks.push({
              type: "text",
              text: sanitizeTransportPayloadText(block.text),
            });
          }
          continue;
        }
        if (block.type === "thinking") {
          const thinkingSignature = block.thinkingSignature?.trim();
          const isReasoningContent = thinkingSignature === "reasoning_content";
          if (!replayThinkingEnabled && i !== activeToolTurnAssistantIndex && !isReasoningContent) {
            omittedThinking = true;
            continue;
          }
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature,
            });
            continue;
          }
          const hasNativeThinkingSignature = Boolean(thinkingSignature) && !isReasoningContent;
          if (block.thinking.trim().length === 0 && !hasNativeThinkingSignature) {
            continue;
          }
          if (!thinkingSignature) {
            blocks.push({
              type: "text",
              text: sanitizeTransportPayloadText(block.thinking),
            });
          } else {
            const thinking =
              thinkingSignature === "reasoning_content"
                ? sanitizeTransportPayloadText(block.thinking)
                : block.thinking;
            if (thinkingSignature === "reasoning_content") {
              if (allowReasoningContentReplay) {
                blocks.push({
                  type: "thinking",
                  thinking,
                  signature: thinkingSignature,
                });
                reasoningContent.push(thinking);
              }
              continue;
            }
            blocks.push({
              type: "thinking",
              thinking,
              signature: thinkingSignature,
            });
          }
          continue;
        }
        if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: isOAuthToken ? toClaudeCodeToolName(block.name) : block.name,
            input: coerceTransportToolCallArguments(block.arguments),
          });
        }
      }
      if (blocks.length === 0 && omittedThinking) {
        blocks.push({ type: "text", text: ANTHROPIC_OMITTED_REASONING_TEXT });
      }
      if (blocks.length > 0) {
        const assistantMsg: Record<string, unknown> = { role: "assistant", content: blocks };
        if (reasoningContent.length > 0) {
          assistantMsg.reasoning_content = reasoningContent.join("\n");
        } else if (allowReasoningContentReplay) {
          blocks.unshift({
            type: "thinking",
            thinking: "",
            signature: "reasoning_content",
          });
        }
        params.push(assistantMsg);
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const toolResult = msg;
      const toolResults: Array<Record<string, unknown>> = [
        {
          type: "tool_result",
          tool_use_id: toolResult.toolCallId,
          content: await convertContentBlocks(toolResult.content, model, imageBudget),
          is_error: toolResult.isError,
        },
      ];
      let j = i + 1;
      while (j < transformedMessages.length) {
        const nextMsg = transformedMessages.at(j);
        if (nextMsg?.role !== "toolResult") {
          break;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: await convertContentBlocks(nextMsg.content, model, imageBudget),
          is_error: nextMsg.isError,
        });
        j += 1;
      }
      i = j - 1;
      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }
  return params;
}

function ensureNonEmptyAnthropicMessages(messages: Array<Record<string, unknown>>) {
  return messages.length > 0
    ? messages
    : [{ role: "user", content: EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT }];
}

function convertAnthropicTools(tools: Context["tools"], isOAuthToken: boolean) {
  const projection = projectAnthropicTools(tools ?? [], (name) =>
    isOAuthToken ? toClaudeCodeToolName(name) : name,
  );
  const converted: Array<{
    name: string;
    description?: string;
    input_schema: {
      type: "object";
      properties: unknown;
      required: unknown;
    };
  }> = [];
  for (const tool of projection.tools) {
    converted.push({
      name: tool.wireName,
      description: tool.description,
      input_schema: tool.inputSchema,
    });
  }
  return { projection, tools: converted };
}

function parseAnthropicToolCallArguments(inputJson: string): unknown {
  return parseJsonObjectPreservingUnsafeIntegers(inputJson) ?? parseStreamingJson(inputJson);
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

function parseAnthropicSseEventData(data: string): unknown {
  try {
    return parseJsonWithRepair(data);
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

const ANTHROPIC_MESSAGE_SSE_EVENTS = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);
const ANTHROPIC_SSE_FRAME_BOUNDARY = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/u;

function normalizeAnthropicSseFrame(frame: string): string {
  return frame.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function parseAnthropicSseFrame(
  frame: string,
): Record<string, unknown> | { type: typeof ANTHROPIC_STANDALONE_DONE_EVENT } | undefined {
  const frameLines = frame.split("\n");
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of frameLines) {
    if (line.startsWith(":")) {
      continue;
    }
    const field = decodeAnthropicSseField(line);
    if (field.field === "event") {
      eventName = field.value;
    } else if (field.field === "data") {
      dataLines.push(field.value);
    }
  }
  const data = dataLines.join("\n");
  if (!data) {
    return undefined;
  }
  if (data.trim() === "[DONE]") {
    return eventName === undefined ? { type: ANTHROPIC_STANDALONE_DONE_EVENT } : undefined;
  }
  if (!ANTHROPIC_MESSAGE_SSE_EVENTS.has(eventName ?? "")) {
    if (eventName === "error") {
      const parsed = parseAnthropicSseEventData(data);
      return isMatchingAnthropicSseEventPayload(eventName, parsed)
        ? parsed
        : { type: "__openclaw_anthropic_sse_event_mismatch" };
    }
    if (eventName === undefined && /^\s*[{[]/u.test(data)) {
      const parsed = parseAnthropicSseEventData(data);
      return classifyUnknownAnthropicSseFrame(data, () => parsed) === "model_event"
        ? { type: "__openclaw_anthropic_sse_event_mismatch" }
        : undefined;
    }
    return classifyUnknownAnthropicSseFrame(data, JSON.parse) === "model_event"
      ? { type: "__openclaw_anthropic_sse_event_mismatch" }
      : undefined;
  }
  const parsed = parseAnthropicSseEventData(data);
  if (!isMatchingAnthropicSseEventPayload(eventName ?? "", parsed)) {
    return { type: "__openclaw_anthropic_sse_event_mismatch" };
  }
  return parsed;
}

async function* parseAnthropicSseBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown> | { type: typeof ANTHROPIC_STANDALONE_DONE_EVENT }> {
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
      buffer = `${buffer}${decoder.decode(value, { stream: true })}`;
      let frameBoundary = ANTHROPIC_SSE_FRAME_BOUNDARY.exec(buffer);
      while (frameBoundary) {
        const frameEnd = frameBoundary.index;
        assertAnthropicSsePendingBufferWithinLimit(frameEnd);
        const frame = normalizeAnthropicSseFrame(buffer.slice(0, frameEnd));
        buffer = buffer.slice(frameEnd + frameBoundary[0].length);
        const parsed = parseAnthropicSseFrame(frame);
        if (parsed) {
          yield parsed;
          if (parsed.type === ANTHROPIC_STANDALONE_DONE_EVENT) {
            return;
          }
        }
        frameBoundary = ANTHROPIC_SSE_FRAME_BOUNDARY.exec(buffer);
      }
      assertAnthropicSsePendingBufferWithinLimit(buffer.length);
    }
    const tailBuffer = `${buffer}${decoder.decode()}`;
    assertAnthropicSsePendingBufferWithinLimit(tailBuffer.length);
    if (anthropicSseTailHasModelFragment(tailBuffer)) {
      yield { type: "__openclaw_anthropic_sse_incomplete_tail" };
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
      async *stream(body: Record<string, unknown>, options?: { signal?: AbortSignal }) {
        const headers = mergeTransportHeaders(
          {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            ...(params.apiKey ? { "x-api-key": params.apiKey } : {}),
            ...(params.authToken ? { authorization: `Bearer ${params.authToken}` } : {}),
          },
          params.defaultHeaders,
        );
        const response = await params.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        if (!response.ok) {
          const detail = await readAnthropicMessagesErrorBodySnippet(response);
          throw new Error(formatAnthropicMessagesHttpError(response, detail));
        }
        if (!response.body) {
          return;
        }
        yield* parseAnthropicSseBody(response.body, options?.signal);
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
  serverSideFallback: boolean;
  transportAccounting?: AnthropicTransportAccounting;
}) {
  const { model, context, apiKey, options, serverSideFallback, transportAccounting } = params;
  const needsInterleavedBeta =
    (options?.interleavedThinking ?? true) && !supportsClaudeAdaptiveThinking(model);
  // Kimi's Anthropic thinking SSE is already well-formed for this parser, but
  // the OpenAI SDK compatibility sanitizer can stall before the text block.
  const guardedFetch = buildAnthropicGuardedFetch({
    model,
    sanitizeSse:
      isKimiAnthropicProvider(model.provider) && options?.thinkingEnabled === true
        ? false
        : undefined,
    serverSideFallback,
    transportAccounting,
  });
  const finishClient = (
    client: AnthropicMessagesClient,
    isOAuthTokenResult: boolean,
  ): {
    client: AnthropicMessagesClient;
    getEndpointAuthority: () => AnthropicEndpointAuthoritySnapshot;
    isOAuthToken: boolean;
  } => ({
    client,
    getEndpointAuthority: guardedFetch.getEndpointAuthority,
    isOAuthToken: isOAuthTokenResult,
  });
  if (model.provider === "github-copilot") {
    const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
    return finishClient(
      createAnthropicMessagesClient({
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
        fetch: guardedFetch.fetch,
      }),
      false,
    );
  }
  if (usesFoundryBearerAuth(resolveModelHeaderSentinels(model))) {
    const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
    return finishClient(
      createAnthropicMessagesClient({
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
        fetch: guardedFetch.fetch,
      }),
      false,
    );
  }
  const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
  if (needsInterleavedBeta) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }
  if (isAnthropicOAuthToken(apiKey)) {
    const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: true });
    return finishClient(
      createAnthropicMessagesClient({
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
        fetch: guardedFetch.fetch,
      }),
      true,
    );
  }
  if (serverSideFallback) {
    betaFeatures.push(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA);
  }
  const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: false });
  return finishClient(
    createAnthropicMessagesClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: preserveAnthropicServerFallbackBetaHeader(
        mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
          },
          model.headers,
          options?.headers,
        ),
        serverSideFallback,
      ),
      fetch: guardedFetch.fetch,
    }),
    false,
  );
}

async function buildAnthropicParams(
  model: AnthropicTransportModel,
  context: Context,
  isOAuthToken: boolean,
  options: AnthropicTransportOptions | undefined,
  serverSideFallback: boolean,
): Promise<{
  params: Record<string, unknown>;
  toolProjection?: AnthropicToolProjection;
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
  const payloadPolicy = resolveAnthropicPayloadPolicy({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    cacheRetention: options?.cacheRetention,
    enableCacheControl: true,
  });
  // Transient runtime-context carrier indexes skip cache anchoring so the breakpoint
  // stays on the last stable user turn; conversion-to-policy must not splice messages.
  const cacheBreakpointOptOutMessageIndexes = new Set<number>();
  const messages = await convertAnthropicMessages(context.messages, model, isOAuthToken, {
    allowReasoningContentReplay: supportsReasoningContentReplay(model),
    cacheBreakpointOptOutMessageIndexes,
    replayThinkingEnabled,
  });
  const params: Record<string, unknown> = {
    model: resolveAnthropicRequestModelId(model),
    messages: ensureNonEmptyAnthropicMessages(messages),
    max_tokens: maxTokens,
    stream: true,
  };
  // Fable 5 and Opus 5 safety classifiers can decline benign-adjacent work.
  // Anthropic owns the per-category fallback recommendation so routing can
  // evolve without a client release.
  if (serverSideFallback) {
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
  if (
    options?.temperature !== undefined &&
    !options.thinkingEnabled &&
    !supportsClaudeNativeXhighEffort(model)
  ) {
    params.temperature = options.temperature;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop_sequences = options.stop;
  }
  let toolProjection: AnthropicToolProjection | undefined;
  if (context.tools) {
    const convertedTools = convertAnthropicTools(context.tools, isOAuthToken);
    toolProjection = convertedTools.projection;
    if (convertedTools.tools.length > 0) {
      params.tools = convertedTools.tools;
    }
  }
  if (mandatoryAdaptiveThinking || model.reasoning || supportsClaudeAdaptiveThinking(model)) {
    if (mandatoryAdaptiveThinking || options?.thinkingEnabled) {
      if (supportsClaudeAdaptiveThinking(model)) {
        // Default display to "summarized" so Opus 4.7+/Fable 5 return a thinking
        // summary like older Claude 4 models — mirrors the provider path
        // (llm/providers/anthropic.ts). Without it the adaptive request omits the
        // summary and only an encrypted signature comes back, so the 🧠 lane is
        // blank (the live agent transport previously sent this for opus-4-8).
        const display: AnthropicThinkingDisplay = options?.thinkingDisplay ?? "summarized";
        params.thinking = { type: "adaptive", display };
        const effort = options?.effort ?? (mandatoryAdaptiveThinking ? "high" : undefined);
        if (effort) {
          params.output_config = { effort };
        }
      } else {
        params.thinking = {
          type: "enabled",
          budget_tokens: options?.thinkingBudgetTokens ?? 1024,
        };
      }
    } else if (options?.thinkingEnabled === false) {
      params.thinking = { type: "disabled" };
    }
  }
  if (options?.metadata && typeof options.metadata.user_id === "string") {
    params.metadata = { user_id: options.metadata.user_id };
  }
  if (options?.toolChoice) {
    const normalizedToolChoice = normalizeAnthropicToolChoice(
      replayThinkingEnabled,
      options.toolChoice,
    );
    const projectedToolChoice = toolProjection
      ? reconcileAnthropicToolChoice(normalizedToolChoice, toolProjection)
      : normalizedToolChoice;
    if (projectedToolChoice) {
      params.tool_choice = projectedToolChoice;
    }
  }
  applyAnthropicPayloadPolicyToParams(params, payloadPolicy, cacheBreakpointOptOutMessageIndexes);
  return { params, toolProjection };
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
  const resolved = inheritAnthropicTransportAccountingContext<AnthropicTransportOptions>(options, {
    temperature: options?.temperature,
    stop: options?.stop,
    maxTokens: baseMaxTokens,
    signal: options?.signal,
    apiKey,
    requestId: options?.requestId,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    interleavedThinking: options?.interleavedThinking,
    toolChoice: options?.toolChoice,
    thinkingBudgets: options?.thinkingBudgets,
    reasoning,
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
      const output: MutableAssistantOutput = {
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
        ? createDeferredEventBuffer<unknown>(stream, () =>
            notifyLlmRequestActivity(options?.signal),
          )
        : undefined;
      const eventSink = refusalBuffer ?? stream;
      // Fallback-served turns bill at the serving model's rates; a boundary
      // swaps this to the fallback model's cost table.
      let costModel = model;
      let messageStartPromptUsage: AnthropicPromptUsageSnapshot | undefined;
      let transportAccounting: AnthropicTransportAccounting | undefined;
      let transportAccountingCompleted = false;
      let providerInvocationStarted = false;
      let getEndpointAuthority: (() => AnthropicEndpointAuthoritySnapshot) | undefined;
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
        const effectiveModel = {
          ...model,
          baseUrl: resolveAnthropicBaseUrl(model.baseUrl),
        };
        const requestContext = prepareClaudeNoPrefillRequestContext(effectiveModel, context);
        const serverSideFallback =
          !isAnthropicOAuthToken(apiKey) &&
          useAnthropicServerSideFallback(effectiveModel) &&
          canGuardAnthropicServerFallbackDispatch();
        transportAccounting = createAnthropicTransportAccounting({
          fallbackBoundaryAuthority: serverSideFallback
            ? "server_authoritative"
            : "client_provisional",
          model,
          options: transportOptions,
          serverFallbackEnabled: serverSideFallback,
        });
        const createdClient = createAnthropicTransportClient({
          model: effectiveModel,
          context: requestContext,
          apiKey,
          options: transportOptions,
          serverSideFallback,
          transportAccounting: transportOptions.requestId ? transportAccounting : undefined,
        });
        const { client, isOAuthToken } = createdClient;
        const readEndpointAuthority = createdClient.getEndpointAuthority;
        getEndpointAuthority = readEndpointAuthority;
        const builtParams = await buildAnthropicParams(
          effectiveModel,
          requestContext,
          isOAuthToken,
          transportOptions,
          serverSideFallback,
        );
        let params = builtParams.params;
        const fallbackAuthorization = serverSideFallback
          ? snapshotAnthropicServerFallbackAuthorization(params)
          : undefined;
        const toolProjection = builtParams.toolProjection;
        const nextParams = await transportOptions.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as Record<string, unknown>;
        }
        applyClaudeRequestContract(params, effectiveModel);
        assertAnthropicServerFallbackPayloadAuthorized({
          authorization: fallbackAuthorization,
          payload: params,
        });
        transportAccounting?.observeFinalRequestPayload(params);
        providerInvocationStarted = true;
        const anthropicStream = client.messages.stream(
          { ...params, stream: true },
          transportOptions.signal ? { signal: transportOptions.signal } : undefined,
        );
        const blocks = output.content;
        const blockIndexes = new Map<number, number>();
        // Signature deltas are opaque and only complete at content_block_stop.
        // Keep partial bytes out of output so interrupted streams cannot poison replay.
        const pendingThinkingSignatures = new Map<number, string>();
        const allowReasoningContentReplay = supportsReasoningContentReplay(model);
        const reasoningContentThinkingBlocks = new Map<number, number>();
        const reasoningContentTextBlocks = new Map<number, number>();
        let terminalCompleteness:
          | ReturnType<typeof createAnthropicStreamTerminalCompleteness>
          | undefined;
        const resolveTerminalCompleteness = () =>
          (terminalCompleteness ??= (() => {
            const endpointAuthority = readEndpointAuthority();
            if (endpointAuthority.traceState !== "exact") {
              transportAccounting?.observeSemanticCoverage("transport_endpoint_authority_partial");
            }
            return createAnthropicStreamTerminalCompleteness({
              requireMessageStop:
                endpointAuthority.requiresMessageStop || refusalBuffer !== undefined,
            });
          })());
        const pendingTextEnds: Array<Parameters<typeof eventSink.push>[0]> = [];
        // Hold text_end until tool-boundary classification is known.
        const flushPendingTextEnds = () => {
          for (const event of pendingTextEnds) {
            eventSink.push(event);
          }
          pendingTextEnds.length = 0;
        };
        const eventIndexKey = (eventIndex: unknown) =>
          typeof eventIndex === "number" ? eventIndex : -1;
        const appendReasoningContentThinkingDelta = (
          eventIndex: unknown,
          rawText: unknown,
        ): boolean => {
          if (typeof rawText !== "string") {
            return false;
          }
          const text = sanitizeTransportPayloadText(rawText);
          if (text.length === 0) {
            return false;
          }
          const key = eventIndexKey(eventIndex);
          let contentIndex = reasoningContentThinkingBlocks.get(key);
          let block =
            contentIndex === undefined
              ? undefined
              : (output.content[contentIndex] as TransportContentBlock | undefined);
          if (!block || block.type !== "thinking") {
            block = { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" };
            output.content.push(block);
            contentIndex = output.content.length - 1;
            reasoningContentThinkingBlocks.set(key, contentIndex);
            eventSink.push({
              type: "thinking_start",
              contentIndex,
              partial: output as never,
            });
          }
          block.thinking += text;
          block.thinkingSignature = "reasoning_content";
          eventSink.push({
            type: "thinking_delta",
            contentIndex,
            delta: text,
            partial: output as never,
          });
          return true;
        };
        const appendReasoningContentTextDelta = (
          eventIndex: unknown,
          rawText: unknown,
        ): boolean => {
          if (typeof rawText !== "string") {
            return false;
          }
          const text = sanitizeTransportPayloadText(rawText);
          if (text.length === 0) {
            return false;
          }
          const key = eventIndexKey(eventIndex);
          let contentIndex = reasoningContentTextBlocks.get(key);
          let block =
            contentIndex === undefined
              ? undefined
              : (output.content[contentIndex] as TransportContentBlock | undefined);
          if (!block || block.type !== "text") {
            block = { type: "text", text: "" };
            output.content.push(block);
            contentIndex = output.content.length - 1;
            reasoningContentTextBlocks.set(key, contentIndex);
            eventSink.push({
              type: "text_start",
              contentIndex,
              partial: output as never,
            });
          }
          block.text += text;
          eventSink.push({
            type: "text_delta",
            contentIndex,
            delta: text,
            partial: output as never,
          });
          return true;
        };
        const finishReasoningContentSidecars = (eventIndex: unknown) => {
          const key = eventIndexKey(eventIndex);
          const thinkingContentIndex = reasoningContentThinkingBlocks.get(key);
          if (thinkingContentIndex !== undefined) {
            reasoningContentThinkingBlocks.delete(key);
            const block = output.content[thinkingContentIndex];
            if (block?.type === "thinking") {
              eventSink.push({
                type: "thinking_end",
                contentIndex: thinkingContentIndex,
                content: block.thinking,
                partial: output as never,
              });
            }
          }
          const textContentIndex = reasoningContentTextBlocks.get(key);
          if (textContentIndex === undefined) {
            return;
          }
          reasoningContentTextBlocks.delete(key);
          const block = output.content[textContentIndex];
          if (block?.type === "text") {
            eventSink.push({
              type: "text_end",
              contentIndex: textContentIndex,
              content: block.text,
              partial: output as never,
            });
          }
        };
        for await (const event of anthropicStream) {
          const currentTerminalCompleteness = resolveTerminalCompleteness();
          if (event.type === ANTHROPIC_STANDALONE_DONE_EVENT) {
            currentTerminalCompleteness.observeStandaloneDone();
            break;
          }
          if (event.type === "error") {
            const error = event.error as { message?: string } | undefined;
            throw new Error(error?.message || "Anthropic Messages stream failed");
          }
          if (event.type === "message_start") {
            currentTerminalCompleteness.observeMessageStart();
            const message = event.message as
              | { id?: string; model?: string; usage?: Record<string, unknown> }
              | undefined;
            const usage = message?.usage ?? {};
            output.responseId = typeof message?.id === "string" ? message.id : undefined;
            output.responseModel = typeof message?.model === "string" ? message.model : undefined;
            messageStartPromptUsage = applyAnthropicMessageStartUsage(output.usage, usage);
            calculateCost(costModel, output.usage);
            // Defer start until after message_start so that pre-stream SSE errors
            // (e.g. invalid thinking signatures) arrive before any non-error event
            // is yielded, keeping yieldedOutput=false in pumpStreamWithRecovery
            // and allowing the thinking-block recovery retry to fire.
            eventSink.push({ type: "start", partial: output as never });
            continue;
          }
          if (event.type === "message_stop") {
            currentTerminalCompleteness.observeMessageStop();
            continue;
          }
          if (event.type === "content_block_start") {
            currentTerminalCompleteness.observeContentBlockStart(event.index);
            const contentBlock = event.content_block as Record<string, unknown> | undefined;
            const index = typeof event.index === "number" ? event.index : -1;
            const fallbackBoundary = refusalBuffer
              ? readAnthropicFallbackBoundary(contentBlock)
              : null;
            if (!fallbackBoundary) {
              transportAccounting.observeFallbackContent();
            }
            if (fallbackBoundary) {
              // Server-side fallback boundary: pre-boundary thinking/tool
              // blocks must not replay or execute, and the buffered preview
              // events reference them, so rebuild the deferred timeline from
              // the surviving text prefix the fallback model continued from.
              refusalBuffer?.discard();
              pendingTextEnds.length = 0;
              blockIndexes.clear();
              pendingThinkingSignatures.clear();
              applyAnthropicFallbackContentBoundary(output);
              transportAccounting.observeFallbackBoundary(fallbackBoundary);
              eventSink.push({ type: "start", partial: output as never });
              for (const [i, block] of output.content.entries()) {
                if (block.type !== "text") {
                  continue;
                }
                delete block.index;
                eventSink.push({
                  type: "text_start",
                  contentIndex: i,
                  partial: output as never,
                });
                if (block.text) {
                  eventSink.push({
                    type: "text_delta",
                    contentIndex: i,
                    delta: block.text,
                    partial: output as never,
                  });
                }
                pendingTextEnds.push({
                  type: "text_end",
                  contentIndex: i,
                  content: block.text,
                  partial: output as never,
                });
              }
              continue;
            }
            pendingThinkingSignatures.delete(index);
            if (contentBlock?.type === "text") {
              const text =
                typeof contentBlock.text === "string"
                  ? sanitizeTransportPayloadText(contentBlock.text)
                  : "";
              const block: TransportContentBlock = { type: "text", text, index };
              output.content.push(block);
              const contentIndex = output.content.length - 1;
              blockIndexes.set(index, contentIndex);
              eventSink.push({
                type: "text_start",
                contentIndex,
                partial: output as never,
              });
              if (text.length > 0) {
                eventSink.push({
                  type: "text_delta",
                  contentIndex,
                  delta: text,
                  partial: output as never,
                });
              }
              continue;
            }
            if (contentBlock?.type === "thinking") {
              const thinking =
                typeof contentBlock.thinking === "string" ? contentBlock.thinking : "";
              const block: TransportContentBlock = {
                type: "thinking",
                thinking,
                thinkingSignature:
                  typeof contentBlock.signature === "string" ? contentBlock.signature : "",
                index,
              };
              output.content.push(block);
              const contentIndex = output.content.length - 1;
              blockIndexes.set(index, contentIndex);
              eventSink.push({
                type: "thinking_start",
                contentIndex,
                partial: output as never,
              });
              if (thinking.length > 0) {
                eventSink.push({
                  type: "thinking_delta",
                  contentIndex,
                  delta: thinking,
                  partial: output as never,
                });
              }
              continue;
            }
            if (contentBlock?.type === "redacted_thinking") {
              const block: TransportContentBlock = {
                type: "thinking",
                thinking: "[Reasoning redacted]",
                thinkingSignature: typeof contentBlock.data === "string" ? contentBlock.data : "",
                redacted: true,
                index,
              };
              output.content.push(block);
              blockIndexes.set(index, output.content.length - 1);
              eventSink.push({
                type: "thinking_start",
                contentIndex: output.content.length - 1,
                partial: output as never,
              });
              continue;
            }
            if (contentBlock?.type === "tool_use") {
              tagPendingCommentaryText(output.content);
              flushPendingTextEnds();
              const block: TransportContentBlock = {
                type: "toolCall",
                id: typeof contentBlock.id === "string" ? contentBlock.id : "",
                name:
                  typeof contentBlock.name === "string"
                    ? isOAuthToken
                      ? resolveOriginalAnthropicToolName(contentBlock.name, toolProjection)
                      : contentBlock.name
                    : "",
                arguments:
                  contentBlock.input && typeof contentBlock.input === "object"
                    ? (contentBlock.input as Record<string, unknown>)
                    : {},
                partialJson: "",
                index,
              };
              output.content.push(block);
              blockIndexes.set(index, output.content.length - 1);
              eventSink.push({
                type: "toolcall_start",
                contentIndex: output.content.length - 1,
                partial: output as never,
              });
            }
            continue;
          }
          if (event.type === "content_block_delta") {
            currentTerminalCompleteness.observeContentBlockDelta(event.index);
            const delta = event.delta as Record<string, unknown> | undefined;
            const eventIndex = typeof event.index === "number" ? event.index : undefined;
            let index = eventIndex === undefined ? undefined : blockIndexes.get(eventIndex);
            let block = index === undefined ? undefined : blocks[index];
            if (allowReasoningContentReplay) {
              const appendedThinking = appendReasoningContentThinkingDelta(
                event.index,
                delta?.reasoning_content,
              );
              const hasNativeAnthropicDelta =
                (delta?.type === "text_delta" && typeof delta.text === "string") ||
                (delta?.type === "thinking_delta" && typeof delta.thinking === "string") ||
                (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") ||
                (delta?.type === "signature_delta" && typeof delta.signature === "string");
              let appendedContent = false;
              if (
                !hasNativeAnthropicDelta &&
                typeof delta?.content === "string" &&
                delta.content.length > 0
              ) {
                const text = sanitizeTransportPayloadText(delta.content);
                if (text.length > 0) {
                  if (block?.type === "text") {
                    block.text += text;
                    eventSink.push({
                      type: "text_delta",
                      contentIndex: index,
                      delta: text,
                      partial: output as never,
                    });
                    appendedContent = true;
                  } else {
                    appendedContent = appendReasoningContentTextDelta(event.index, text);
                  }
                }
              }
              if ((appendedThinking || appendedContent) && !hasNativeAnthropicDelta) {
                continue;
              }
            }
            if (!block && delta?.type === "text_delta" && typeof delta.text === "string") {
              const recoveredIndex = typeof event.index === "number" ? event.index : blocks.length;
              block = { type: "text", text: "", index: recoveredIndex };
              output.content.push(block);
              index = output.content.length - 1;
              if (typeof event.index === "number") {
                blockIndexes.set(event.index, index);
              }
              eventSink.push({
                type: "text_start",
                contentIndex: index,
                partial: output as never,
              });
            }
            if (
              block?.type === "text" &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              block.text += delta.text;
              eventSink.push({
                type: "text_delta",
                contentIndex: index,
                delta: delta.text,
                partial: output as never,
              });
              continue;
            }
            if (
              block?.type === "thinking" &&
              delta?.type === "thinking_delta" &&
              typeof delta.thinking === "string"
            ) {
              block.thinking += delta.thinking;
              eventSink.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: delta.thinking,
                partial: output as never,
              });
              continue;
            }
            if (
              block?.type === "toolCall" &&
              delta?.type === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              const partialJson = `${block.partialJson ?? ""}${delta.partial_json}`;
              block.partialJson = partialJson;
              block.arguments = parseAnthropicToolCallArguments(partialJson);
              eventSink.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: delta.partial_json,
                partial: output as never,
              });
              continue;
            }
            if (
              block?.type === "thinking" &&
              delta?.type === "signature_delta" &&
              typeof delta.signature === "string"
            ) {
              const signatureIndex = eventIndexKey(event.index);
              const pendingSignature = pendingThinkingSignatures.get(signatureIndex);
              if (pendingSignature === undefined) {
                block.thinkingSignature = "";
                pendingThinkingSignatures.set(signatureIndex, delta.signature);
              } else {
                pendingThinkingSignatures.set(signatureIndex, pendingSignature + delta.signature);
              }
            }
            continue;
          }
          if (event.type === "content_block_stop") {
            currentTerminalCompleteness.observeContentBlockStop(event.index);
            const eventIndex = typeof event.index === "number" ? event.index : undefined;
            const pendingSignature =
              eventIndex === undefined ? undefined : pendingThinkingSignatures.get(eventIndex);
            if (eventIndex !== undefined) {
              pendingThinkingSignatures.delete(eventIndex);
            }
            const index = eventIndex === undefined ? undefined : blockIndexes.get(eventIndex);
            const block = index === undefined ? undefined : blocks[index];
            if (eventIndex === undefined || index === undefined || !block) {
              finishReasoningContentSidecars(event.index);
              continue;
            }
            blockIndexes.delete(eventIndex);
            delete block.index;
            if (block.type === "text") {
              pendingTextEnds.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output as never,
              });
              finishReasoningContentSidecars(event.index);
              continue;
            }
            if (block.type === "thinking") {
              if (pendingSignature !== undefined) {
                block.thinkingSignature = pendingSignature;
              }
              eventSink.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output as never,
              });
              finishReasoningContentSidecars(event.index);
              continue;
            }
            if (block.type === "toolCall") {
              delete block.partialJson;
              eventSink.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block as never,
                partial: output as never,
              });
              finishReasoningContentSidecars(event.index);
            }
            continue;
          }
          if (event.type === "message_delta") {
            currentTerminalCompleteness.observeMessageDelta();
            const delta = event.delta as
              | { stop_reason?: string; stop_details?: unknown }
              | undefined;
            const usage = event.usage as Record<string, unknown> | undefined;
            if (delta?.stop_reason) {
              transportAccounting?.observeFallbackContent();
              if (delta.stop_reason === "refusal") {
                applyAnthropicRefusal(output, delta.stop_details, model.provider);
              } else {
                output.stopReason = mapAnthropicStopReason(delta.stop_reason);
              }
              currentTerminalCompleteness.observeMappedStopReason(delta.stop_reason);
            }
            applyAnthropicMessageDeltaUsage(output.usage, usage, messageStartPromptUsage);
            if (delta?.stop_reason) {
              transportAccounting?.observeTerminalUsage(usage);
            }
            calculateCost(costModel, output.usage);
            // Gate on the turn CONTAINING a tool call, not the provider's stop_reason
            // label: Bedrock/Vertex-proxied routes (e.g. pioneer) report "end_turn" on
            // tool-using turns. No-op for direct Anthropic (already "toolUse" here).
            if (
              output.stopReason === "toolUse" ||
              output.content.some((block) => block.type === "toolCall")
            ) {
              tagPendingCommentaryText(output.content);
            }
            flushPendingTextEnds();
            continue;
          }
          currentTerminalCompleteness.observeStructuralIncomplete();
        }
        flushPendingTextEnds();
        if (
          blockIndexes.size > 0 ||
          pendingThinkingSignatures.size > 0 ||
          reasoningContentThinkingBlocks.size > 0 ||
          reasoningContentTextBlocks.size > 0 ||
          blocks.some(
            (block) => block.type === "toolCall" && Object.hasOwn(block as object, "partialJson"),
          )
        ) {
          resolveTerminalCompleteness().observeStructuralIncomplete();
        }
        const terminalEvidence = resolveTerminalCompleteness().assertComplete();
        transportAccounting?.sealTerminalUsage();
        if (terminalEvidence.state === "unverified") {
          transportAccounting?.observeSemanticCoverage("transport_terminal_unverified");
        }
        if (transportOptions.signal?.aborted) {
          throw transportAbortError(transportOptions.signal);
        }
        const terminalError =
          output.stopReason === "aborted" || output.stopReason === "error"
            ? new Error(output.errorMessage ?? "An unknown error occurred")
            : undefined;
        if (transportAccounting) {
          const fallbackResolution = terminalError
            ? transportAccounting.completeFailure(terminalError)
            : transportAccounting.completeSuccess();
          costModel = applyAnthropicFallbackResolution({
            model,
            output,
            resolution: fallbackResolution,
          });
          transportAccountingCompleted = true;
        }
        if (terminalError) {
          throw terminalError;
        }
        refusalBuffer?.flush();
        // Backstop: streaming tags commentary at the tool-boundary above, but
        // replay/non-streaming assembly may reach here with tool calls untagged.
        // Idempotent, so it never double-tags the streaming path. Gate on the turn
        // containing a tool call (not stop_reason) so proxied Bedrock/Vertex routes
        // that mislabel tool turns as "end_turn" still tag their narration.
        if (
          output.stopReason === "toolUse" ||
          output.content.some((block) => block.type === "toolCall")
        ) {
          tagPendingCommentaryText(output.content);
        }
        flushPendingTextEnds();
        finalizeTransportStream({ stream, output });
      } catch (error) {
        const endpointAuthority = getEndpointAuthority?.();
        if (
          providerInvocationStarted &&
          transportAccounting &&
          (!endpointAuthority || endpointAuthority.traceState !== "exact")
        ) {
          transportAccounting?.observeSemanticCoverage("transport_endpoint_authority_partial");
        }
        const failureResolution = transportAccounting?.fail(error);
        if (!transportAccountingCompleted) {
          output.responseModel = model.id;
        }
        if (!transportAccountingCompleted && failureResolution) {
          for (const transition of failureResolution.productTransitions) {
            applyAnthropicFallbackServingModel({
              output,
              boundary: transition,
              provider: model.provider,
            });
          }
        }
        if (refusalBuffer) {
          refusalBuffer.discard();
          output.content = [];
        }
        failTransportStream({
          stream,
          output,
          signal: options?.signal,
          error,
          cleanup: () => {
            for (const block of output.content) {
              delete block.index;
            }
          },
        });
      }
    })();
    return eventStream as ReturnType<StreamFn>;
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
