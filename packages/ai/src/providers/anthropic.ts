// Anthropic provider adapts Anthropic streams and tool calls for the runtime.
import Anthropic from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/core/streaming.js";
import type {
  CacheControlEphemeral,
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import {
  createAnthropicInlineImageBudget,
  normalizeAnthropicInlineContent,
  resolveAnthropicImageMediaType,
  type AnthropicInlineImageBudget,
} from "../internal/anthropic-inline-images.js";
import { calculateCost } from "../model-utils.js";
import type { AnthropicOptions, AnthropicThinkingDisplay } from "../provider-options.js";
import { transformProviderMessages as transformMessages } from "../provider-transcript-transform.js";
import {
  buildAnthropicReplayPlan,
  createCompactionCapture,
  isAnthropicReplayRejection,
  suppressAnthropicCompaction,
  type AnthropicCompactionBlock,
} from "../transports/anthropic-compaction-replay.js";
import { applyAnthropicCacheControlToMessages } from "../transports/anthropic-payload-policy.js";
import {
  finalizeTerminalToolCallArguments,
  notifyProviderHttpResponse,
  transportAbortError,
} from "../transports/transport-stream-shared.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type {
  AnthropicMessagesCompat,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  CacheRetention,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "../types.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  createToolArgumentPreviewSchedule,
  parseJsonWithRepair,
  parseStreamingJson,
  type ToolArgumentPreviewSchedule,
} from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import { projectProviderError } from "../utils/provider-error.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../utils/system-prompt-cache-boundary.js";
import {
  omitFoundryBearerCredentialHeaders,
  usesFoundryBearerAuth,
} from "./anthropic-auth-headers.js";
import {
  applyClaudeRequestContract,
  ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
  ANTHROPIC_CLAUDE_CODE_VERSION,
  mapAnthropicStopReason,
  prepareClaudeNoPrefillRequestContext,
  resolveAnthropicThinkingEffort,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  requiresClaudeAdaptiveThinking,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeXhighEffort,
  usesClaudeFable5MessagesContract,
  usesClaudeStreamingRefusalContract,
} from "./anthropic-model-contract.js";
import { applyAnthropicRefusal } from "./anthropic-refusal.js";
import {
  ANTHROPIC_SERVER_SIDE_FALLBACK_BETA,
  ANTHROPIC_SERVER_SIDE_FALLBACKS,
  applyAnthropicFallbackBoundary,
  readAnthropicFallbackBoundary,
  resolveAnthropicFallbackServingModelCost,
} from "./anthropic-server-fallback.js";
import {
  ANTHROPIC_OMITTED_REASONING_TEXT,
  findActiveAnthropicToolTurnAssistantIndex,
} from "./anthropic-thinking-replay.js";
import {
  normalizeAnthropicToolCallId,
  normalizeAnthropicToolChoice,
  projectAnthropicTools,
  reconcileAnthropicToolChoice,
  resolveOriginalAnthropicToolName,
  toClaudeCodeToolName,
  type AnthropicToolProjection,
} from "./anthropic-tool-projection.js";
import {
  applyAnthropicMessageDeltaUsage,
  applyAnthropicMessageStartUsage,
  type AnthropicPromptUsageSnapshot,
} from "./anthropic-usage.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampMaxTokensToModel,
} from "./simple-options.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultBlockText,
  extractToolResultText,
  isImageWithMediaPayload,
} from "./tool-result-text.js";

const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;
const EMPTY_ERROR_TOOL_RESULT_TEXT = "[tool error with no output]";

type AnthropicCompactionOptions = AnthropicOptions & {
  anthropicServerCompaction?: boolean;
  authProfileId?: string;
};

function getCacheControl(
  model: Model<"anthropic-messages">,
  cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
  const retention = resolveCacheRetention(cacheRetention);
  if (retention === "none") {
    return { retention };
  }
  const ttl =
    retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
  return {
    retention,
    cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
  };
}

/**
 * Convert content blocks to Anthropic API format
 */
async function convertContentBlocks(
  content: readonly unknown[],
  isError: boolean,
  imageBudget: AnthropicInlineImageBudget,
): Promise<
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
    >
> {
  const text = extractToolResultText(content);
  const mediaPlaceholder = describeToolResultMediaPlaceholder(content);
  const hasImages = content.some(isImageWithMediaPayload);

  if (!hasImages) {
    const sanitized = sanitizeSurrogates(text);
    return sanitized.trim().length > 0
      ? sanitized
      : (mediaPlaceholder ?? (isError ? EMPTY_ERROR_TOOL_RESULT_TEXT : ""));
  }

  const blocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: {
          type: "base64";
          media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
          data: string;
        };
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
      blocks.push({ type: "text" as const, text: sanitizeSurrogates(blockText) });
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
          mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/jpeg",
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
        type: "base64" as const,
        media_type: resolveAnthropicImageMediaType(normalizedImage.mimeType),
        data: normalizedImage.data,
      },
    });
  }
  if (!hasTextBlock) {
    blocks.unshift({ type: "text" as const, text: mediaPlaceholder ?? "(see attached image)" });
  }

  return blocks;
}

export type {
  AnthropicEffort,
  AnthropicOptions,
  AnthropicThinkingDisplay,
} from "../provider-options.js";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;

function getAnthropicCompat(model: Model<"anthropic-messages">): Required<AnthropicMessagesCompat> {
  // Auto-detect session affinity and cache control support from provider
  const isFireworks = model.provider === "fireworks";
  const isCloudflareAiGatewayAnthropic =
    model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
  return {
    supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
    sendSessionAffinityHeaders:
      model.compat?.sendSessionAffinityHeaders ?? (isFireworks || isCloudflareAiGatewayAnthropic),
    supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
    allowEmptySignature: model.compat?.allowEmptySignature ?? false,
  };
}

function mergeHeaders(
  ...headerSources: (Record<string, string | null> | undefined)[]
): Record<string, string | null> {
  const merged: Record<string, string | null> = {};
  for (const headers of headerSources) {
    if (headers) {
      Object.assign(merged, headers);
    }
  }
  return merged;
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);

async function* iterateAnthropicEvents(
  response: Response,
  requireMessageStop = false,
): AsyncGenerator<RawMessageStreamEvent> {
  if (!response.body) {
    throw new Error("Attempted to iterate over an Anthropic response with no body");
  }

  let sawMessageStart = false;
  let sawMessageEnd = false;

  for await (const sse of Stream.rawEvents(response)) {
    if (sse.event === "error") {
      throw new Error(sse.data);
    }

    if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
      continue;
    }

    try {
      const event = parseJsonWithRepair(sse.data) as RawMessageStreamEvent;
      if (event.type === "message_start") {
        sawMessageStart = true;
      } else if (event.type === "message_stop") {
        sawMessageEnd = true;
      }
      yield event;
    } catch (error) {
      // Frame payloads carry model output, so surface the shared malformed-fragment
      // error instead of echoing them. The SyntaxError stays reachable on `cause`.
      if (error instanceof SyntaxError) {
        throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
      }
      throw error;
    }
  }

  if ((sawMessageStart || requireMessageStop) && !sawMessageEnd) {
    throw new Error("Anthropic stream ended before message_stop");
  }
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicCompactionOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicCompactionOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const requestContext = prepareClaudeNoPrefillRequestContext(model, context);
  const requestOptions = normalizeAnthropicThinkingOptions(model, options);

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    // Classifier refusals can invalidate partial output, so no event is safe
    // to expose until the terminal stop reason is known.
    const refusalBuffer = usesClaudeStreamingRefusalContract(model)
      ? createDeferredEventBuffer<AssistantMessageEvent>(stream, () =>
          notifyLlmRequestActivity(requestOptions?.signal),
        )
      : undefined;
    const eventSink = refusalBuffer ?? stream;
    // Fallback-served turns bill at the serving model's rates; a boundary
    // swaps this to the fallback model's cost table.
    let costModel = model;
    let messageStartPromptUsage: AnthropicPromptUsageSnapshot | undefined;
    let usedCompactionReplay = false;

    try {
      let client: Anthropic;
      let isOAuth: boolean;
      // The beta-gated fallbacks param may only ship on clients we built,
      // where the matching beta header is guaranteed; injected clients carry
      // caller-owned headers.
      let serverSideFallback = false;

      if (requestOptions?.client) {
        client = requestOptions.client;
        isOAuth = false;
      } else {
        const apiKey = requestOptions?.apiKey ?? getEnvApiKey(model.provider) ?? "";

        let copilotDynamicHeaders: Record<string, string> | undefined;
        if (model.provider === "github-copilot") {
          const hasImages = hasCopilotVisionInput(requestContext.messages);
          copilotDynamicHeaders = buildCopilotDynamicHeaders({
            messages: requestContext.messages,
            hasImages,
          });
        }

        const cacheRetention = requestOptions?.cacheRetention ?? resolveCacheRetention();
        const cacheSessionId = cacheRetention === "none" ? undefined : requestOptions?.sessionId;

        const created = createClient(
          model,
          apiKey,
          requestOptions?.thinkingEnabled === true,
          requestOptions?.interleavedThinking ?? true,
          shouldUseFineGrainedToolStreamingBeta(model, requestContext),
          requestOptions?.headers,
          copilotDynamicHeaders,
          cacheSessionId,
        );
        client = created.client;
        isOAuth = created.isOAuthToken;
        serverSideFallback = created.serverSideFallback;
      }
      const builtParams = await buildParams(
        model,
        requestContext,
        isOAuth,
        requestOptions,
        serverSideFallback,
      );
      usedCompactionReplay = builtParams.usedCompactionReplay;
      let params = builtParams.params;
      const toolProjection = builtParams.toolProjection;
      const nextParams = await requestOptions?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as MessageCreateParamsStreaming;
      }
      applyClaudeRequestContract(params, model);
      const sdkRequestOptions = {
        ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
        ...(requestOptions?.timeoutMs !== undefined ? { timeout: requestOptions.timeoutMs } : {}),
        maxRetries: requestOptions?.maxRetries ?? 0,
      };
      const response = await client.messages
        .create({ ...params, stream: true }, sdkRequestOptions)
        .asResponse();
      await notifyProviderHttpResponse({ options: requestOptions, response, model });

      type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson?: string })) & {
        index: number;
      };
      const blocks = output.content as Block[];
      const blockIndexes = new Map<number, number>();
      // Preview schedules are per active tool call; WeakMap keys die with the block.
      const toolArgumentPreviewSchedules = new WeakMap<
        Extract<Block, { type: "toolCall" }>,
        ToolArgumentPreviewSchedule
      >();
      const sealedToolCalls: Array<{
        block: Extract<Block, { type: "toolCall" }>;
        contentIndex: number;
      }> = [];
      const compactionCapture = createCompactionCapture(output, model, requestOptions);

      for await (const event of iterateAnthropicEvents(response, refusalBuffer !== undefined)) {
        if (event.type === "message_start") {
          output.responseId = event.message.id;
          output.responseModel = event.message.model;
          messageStartPromptUsage = applyAnthropicMessageStartUsage(
            output.usage,
            event.message.usage,
          );
          calculateCost(costModel, output.usage);
          // Defer start until after message_start so that pre-stream SSE errors
          // (e.g. invalid thinking signatures) arrive before any non-error event
          // is yielded, keeping yieldedOutput=false in pumpStreamWithRecovery
          // and allowing the thinking-block recovery retry to fire.
          eventSink.push({ type: "start", partial: output });
        } else if (event.type === "content_block_start") {
          const rawContentBlock = isRecord(event.content_block) ? event.content_block : undefined;
          if (
            requestOptions?.anthropicServerCompaction === true &&
            compactionCapture.begin(event.index, rawContentBlock, output.content.length)
          ) {
            continue;
          }
          const fallbackBoundary = refusalBuffer
            ? readAnthropicFallbackBoundary(event.content_block)
            : null;
          if (fallbackBoundary) {
            // Server-side fallback boundary: pre-boundary thinking/tool blocks
            // must not replay or execute, and the buffered preview events
            // reference them, so rebuild the deferred timeline from the
            // surviving text prefix the fallback model continued from.
            refusalBuffer?.discard();
            sealedToolCalls.length = 0;
            blockIndexes.clear();
            applyAnthropicFallbackBoundary({
              output,
              boundary: fallbackBoundary,
              provider: model.provider,
            });
            // Fallback-only iteration partials stay outside the serving-model
            // estimate. Compaction responses are the exception: usage policy
            // aggregates their complete billed iteration list.
            costModel = {
              ...model,
              cost: resolveAnthropicFallbackServingModelCost({
                requestedModelId: model.id,
                servingModelId: fallbackBoundary.toModel,
                requestedCost: model.cost,
              }),
            };
            calculateCost(costModel, output.usage);
            eventSink.push({ type: "start", partial: output });
            for (const [i, block] of blocks.entries()) {
              if (block.type !== "text") {
                continue;
              }
              delete (block as Partial<Block>).index;
              eventSink.push({ type: "text_start", contentIndex: i, partial: output });
              if (block.text) {
                eventSink.push({
                  type: "text_delta",
                  contentIndex: i,
                  delta: block.text,
                  partial: output,
                });
              }
              eventSink.push({
                type: "text_end",
                contentIndex: i,
                content: block.text,
                partial: output,
              });
            }
          } else if (event.content_block.type === "text") {
            const block: Block = {
              type: "text",
              text: "",
              index: event.index,
            };
            output.content.push(block);
            blockIndexes.set(event.index, output.content.length - 1);
            eventSink.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "thinking") {
            const block: Block = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
              index: event.index,
            };
            output.content.push(block);
            blockIndexes.set(event.index, output.content.length - 1);
            eventSink.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "redacted_thinking") {
            const block: Block = {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: event.content_block.data,
              redacted: true,
              index: event.index,
            };
            output.content.push(block);
            blockIndexes.set(event.index, output.content.length - 1);
            eventSink.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "tool_use") {
            const block: Block = {
              type: "toolCall",
              id: event.content_block.id,
              name: isOAuth
                ? resolveOriginalAnthropicToolName(event.content_block.name, toolProjection)
                : event.content_block.name,
              arguments: (event.content_block.input as Record<string, unknown>) ?? {},
              partialJson: "",
              index: event.index,
            };
            output.content.push(block);
            blockIndexes.set(event.index, output.content.length - 1);
            toolArgumentPreviewSchedules.set(block, createToolArgumentPreviewSchedule());
            eventSink.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
        } else if (event.type === "content_block_delta") {
          const rawDelta = isRecord(event.delta) ? event.delta : undefined;
          if (compactionCapture.delta(event.index, rawDelta)) {
            continue;
          } else if (event.delta.type === "text_delta") {
            const index = blockIndexes.get(event.index);
            const block = index === undefined ? undefined : blocks[index];
            if (index !== undefined && block?.type === "text") {
              block.text += event.delta.text;
              eventSink.push({
                type: "text_delta",
                contentIndex: index,
                delta: event.delta.text,
                partial: output,
              });
            }
          } else if (event.delta.type === "thinking_delta") {
            const index = blockIndexes.get(event.index);
            const block = index === undefined ? undefined : blocks[index];
            if (index !== undefined && block?.type === "thinking") {
              block.thinking += event.delta.thinking;
              eventSink.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: event.delta.thinking,
                partial: output,
              });
            }
          } else if (event.delta.type === "input_json_delta") {
            const index = blockIndexes.get(event.index);
            const block = index === undefined ? undefined : blocks[index];
            if (index !== undefined && block?.type === "toolCall") {
              block.partialJson = (block.partialJson ?? "") + event.delta.partial_json;
              // Preview refresh is scheduled geometrically; the terminal
              // finalize re-parses the full buffer authoritatively either way.
              if (toolArgumentPreviewSchedules.get(block)?.(block.partialJson.length)) {
                block.arguments = parseStreamingJson(block.partialJson);
              }
              eventSink.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: event.delta.partial_json,
                partial: output,
              });
            }
          } else if (event.delta.type === "signature_delta") {
            const index = blockIndexes.get(event.index);
            const block = index === undefined ? undefined : blocks[index];
            if (index !== undefined && block?.type === "thinking") {
              block.thinkingSignature = block.thinkingSignature || "";
              block.thinkingSignature += event.delta.signature;
            }
          }
        } else if (event.type === "content_block_stop") {
          if (compactionCapture.complete(event.index)) {
            continue;
          }
          const index = blockIndexes.get(event.index);
          const block = index === undefined ? undefined : blocks[index];
          if (index !== undefined && block) {
            blockIndexes.delete(event.index);
            delete (block as Partial<Block>).index;
            if (block.type === "text") {
              eventSink.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              eventSink.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              sealedToolCalls.push({ block, contentIndex: index });
            }
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) {
            if (event.delta.stop_reason === "refusal") {
              applyAnthropicRefusal(output, event.delta.stop_details, model.provider);
            } else {
              output.stopReason = mapAnthropicStopReason(event.delta.stop_reason);
            }
          }
          // Only update usage fields if present (not null).
          // Preserves input_tokens from message_start when proxies omit it in message_delta.
          if (event.usage) {
            applyAnthropicMessageDeltaUsage(output.usage, event.usage, messageStartPromptUsage);
          }
          calculateCost(costModel, output.usage);
        }
      }

      if (requestOptions?.signal?.aborted) {
        throw transportAbortError(requestOptions.signal);
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage ?? "An unknown error occurred");
      }
      if ([...blockIndexes.values()].some((index) => blocks[index]?.type === "toolCall")) {
        throw new Error("Provider completed stream with an incomplete tool call");
      }
      finalizeTerminalToolCallArguments(
        sealedToolCalls.map(({ block }) => block),
        (block) =>
          block.partialJson && block.partialJson.length > 0 ? block.partialJson : block.arguments,
      );
      for (const sealed of sealedToolCalls) {
        delete sealed.block.partialJson;
        eventSink.push({
          type: "toolcall_end",
          contentIndex: sealed.contentIndex,
          toolCall: sealed.block,
          partial: output,
        });
      }

      refusalBuffer?.flush();
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.content = output.content.filter((block) => block.type !== "toolCall");
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      if (refusalBuffer) {
        refusalBuffer.discard();
        output.content = [];
      }
      if (usedCompactionReplay && isAnthropicReplayRejection(error)) {
        suppressAnthropicCompaction(output, model, requestOptions);
      }
      const terminal = projectProviderError(error, requestOptions?.signal);
      Object.assign(output, terminal);
      stream.push({ type: "error", reason: terminal.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

function normalizeAnthropicThinkingOptions(
  model: Model<"anthropic-messages">,
  options: AnthropicCompactionOptions | undefined,
): AnthropicCompactionOptions | undefined {
  if (options?.thinkingEnabled !== true || supportsClaudeAdaptiveThinking(model)) {
    return options;
  }

  const budgetTokens = options.thinkingBudgetTokens ?? ANTHROPIC_MIN_THINKING_BUDGET_TOKENS;
  const maxTokens = options.maxTokens ?? model.maxTokens;
  if (budgetTokens >= ANTHROPIC_MIN_THINKING_BUDGET_TOKENS && budgetTokens < maxTokens) {
    return options;
  }

  // Manual thinking is one request-wide mode: replay, sampling, tool choice,
  // headers, and payload construction must all observe the disabled state.
  return { ...options, thinkingEnabled: false, thinkingBudgetTokens: undefined };
}

type AnthropicSimpleStreamOptions = SimpleStreamOptions & {
  anthropicServerCompaction?: boolean;
  authProfileId?: string;
  toolChoice?: AnthropicCompactionOptions["toolChoice"];
};

export const streamSimpleAnthropic: StreamFunction<
  "anthropic-messages",
  AnthropicSimpleStreamOptions
> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicSimpleStreamOptions,
) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = {
    ...buildBaseOptions(model, options, apiKey),
    anthropicServerCompaction: options?.anthropicServerCompaction,
    authProfileId: options?.authProfileId,
    maxTokens: clampMaxTokensToModel(model, options?.maxTokens ?? model.maxTokens),
    toolChoice: options?.toolChoice,
  };
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  if (options?.reasoning === "off" && !mandatoryAdaptiveThinking) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: false,
    } satisfies AnthropicCompactionOptions);
  }
  const reasoning =
    options?.reasoning === "off"
      ? mandatoryAdaptiveThinking
        ? "low"
        : "high"
      : options?.reasoning;
  if (resolveClaudeOpus5ModelIdentity(model) || resolveClaudeSonnet5ModelIdentity(model)) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort: resolveAnthropicThinkingEffort(model, reasoning ?? "high"),
    } satisfies AnthropicCompactionOptions);
  }
  if (!reasoning) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: mandatoryAdaptiveThinking,
      ...(mandatoryAdaptiveThinking ? { effort: "high" as const } : {}),
    } satisfies AnthropicCompactionOptions);
  }

  // For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
  // For older models: use budget-based thinking
  if (supportsClaudeAdaptiveThinking(model)) {
    const effort = resolveAnthropicThinkingEffort(model, reasoning);
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort,
    } satisfies AnthropicCompactionOptions);
  }

  // Undefined means the caller did not request an output cap; let the helper use the model cap.
  // Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
  const adjusted = adjustMaxTokensForThinking(
    base.maxTokens,
    model.maxTokens,
    reasoning,
    options?.thinkingBudgets,
  );
  // Sub-minimum budgets (< 1024) resolve to thinking disabled so downstream
  // consumers (payload, replay, temperature, tool-choice) see consistent state.
  const thinkingEnabled = adjusted.thinkingBudget >= ANTHROPIC_MIN_THINKING_BUDGET_TOKENS;
  // When thinking cannot fit, restore the visible-output cap instead of keeping
  // the thinking-inflated request limit from adjustMaxTokensForThinking.
  const maxTokens = thinkingEnabled
    ? adjusted.maxTokens
    : clampMaxTokensToModel(model, options?.maxTokens ?? model.maxTokens);
  return streamAnthropic(model, context, {
    ...base,
    maxTokens,
    thinkingEnabled,
    thinkingBudgetTokens: thinkingEnabled ? adjusted.thinkingBudget : undefined,
  } satisfies AnthropicCompactionOptions);
};

function isOAuthToken(apiKey: string): boolean {
  // Inspect the host-resolved shape only for auth routing; the SDK still receives the sentinel.
  return getAiTransportHost().resolveSecretSentinel(apiKey).includes("sk-ant-oat");
}

function isAnthropicPublicEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return true;
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

/**
 * Server-side refusal fallback is a first-party Claude API beta: proxies and
 * Bedrock/Vertex/Foundry reject the `fallbacks` param, and OAuth (Claude Code
 * identity) requests are excluded until the beta is verified there.
 */
function supportsAnthropicServerSideFallback(model: Model<"anthropic-messages">): boolean {
  if (
    (!usesClaudeFable5MessagesContract(model) &&
      resolveClaudeOpus5ModelIdentity(model) === undefined) ||
    model.provider !== "anthropic"
  ) {
    return false;
  }
  return isAnthropicPublicEndpoint(model.baseUrl);
}

function createClient(
  model: Model<"anthropic-messages">,
  apiKey: string,
  thinkingEnabled: boolean,
  interleavedThinking: boolean,
  useFineGrainedToolStreamingBeta: boolean,
  optionsHeaders?: Record<string, string>,
  dynamicHeaders?: Record<string, string>,
  sessionId?: string,
): { client: Anthropic; isOAuthToken: boolean; serverSideFallback: boolean } {
  // Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
  // The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
  const needsInterleavedBeta = interleavedThinking && !supportsClaudeAdaptiveThinking(model);
  const betaFeatures: string[] = [];
  if (useFineGrainedToolStreamingBeta) {
    betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  if (needsInterleavedBeta) {
    betaFeatures.push(INTERLEAVED_THINKING_BETA);
  }
  const fetchOptions =
    /^kimi(?:-|$)/.test(model.provider) && thinkingEnabled
      ? { sanitizeSse: false as const }
      : undefined;
  // Anthropic supports custom fetch, so sentinels stay opaque until guarded egress.
  const fetch = getAiTransportHost().buildModelFetch(model, undefined, fetchOptions);

  if (model.provider === "cloudflare-ai-gateway") {
    const client = new Anthropic({
      apiKey,
      authToken: null,
      baseURL: resolveCloudflareBaseUrl(model),
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          Authorization: null,
          ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
        },
        model.headers,
        optionsHeaders,
      ),
      fetch,
    });

    return { client, isOAuthToken: false, serverSideFallback: false };
  }

  // Copilot: Bearer auth, selective betas.
  if (model.provider === "github-copilot") {
    const client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
        },
        model.headers,
        dynamicHeaders,
        optionsHeaders,
      ),
      fetch,
    });

    return { client, isOAuthToken: false, serverSideFallback: false };
  }

  if (
    usesFoundryBearerAuth({
      ...model,
      headers: resolveAiTransportHeaderSentinels(model.headers),
    })
  ) {
    const client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
        },
        omitFoundryBearerCredentialHeaders(model.headers),
        dynamicHeaders,
        optionsHeaders,
      ),
      fetch,
    });

    return { client, isOAuthToken: false, serverSideFallback: false };
  }

  // OAuth: Bearer auth, Claude Code identity headers
  if (isOAuthToken(apiKey)) {
    const client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
          "user-agent": `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION}`,
          "x-app": "cli",
        },
        model.headers,
        optionsHeaders,
      ),
      fetch,
    });

    return { client, isOAuthToken: true, serverSideFallback: false };
  }

  // API key auth
  const serverSideFallback = supportsAnthropicServerSideFallback(model);
  if (serverSideFallback) {
    betaFeatures.push(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA);
  }
  const sessionAffinityHeaders: Record<string, string | null> =
    sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders
      ? { "x-session-affinity": sessionId }
      : {};
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: mergeHeaders(
      {
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
      },
      sessionAffinityHeaders,
      model.headers,
      optionsHeaders,
    ),
    fetch,
  });

  return { client, isOAuthToken: false, serverSideFallback };
}

async function buildParams(
  model: Model<"anthropic-messages">,
  context: Context,
  isOAuthTokenResult: boolean,
  options?: AnthropicCompactionOptions,
  serverSideFallback = false,
): Promise<{
  params: MessageCreateParamsStreaming;
  toolProjection?: AnthropicToolProjection;
  usedCompactionReplay: boolean;
}> {
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  const replayThinkingEnabled = mandatoryAdaptiveThinking || options?.thinkingEnabled === true;
  const { cacheControl } = getCacheControl(model, options?.cacheRetention);
  const system = buildAnthropicSystemBlocks(context.systemPrompt, isOAuthTokenResult, cacheControl);
  const compat = getAnthropicCompat(model);
  const convertedTools = context.tools
    ? convertTools(
        context.tools,
        isOAuthTokenResult,
        compat.supportsEagerToolInputStreaming,
        compat.supportsCacheControlOnTools ? cacheControl : undefined,
      )
    : undefined;
  const tools = convertedTools?.tools;
  const toolProjection = convertedTools?.projection;
  const systemCacheControlCount = countNativeCacheControlMarkers(system);
  const toolCacheControlCount = countNativeCacheControlMarkers(tools);
  const messageCacheControlLimit = Math.max(
    0,
    ANTHROPIC_CACHE_CONTROL_LIMIT - systemCacheControlCount - toolCacheControlCount,
  );
  const replayPlan = buildAnthropicReplayPlan(context.messages, model, {
    enabled: !isOAuthTokenResult && options?.anthropicServerCompaction === true,
    authProfileId: options?.authProfileId,
    sessionId: options?.sessionId,
  });
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    messages: await convertMessages(
      replayPlan.messages,
      model,
      isOAuthTokenResult,
      cacheControl,
      messageCacheControlLimit,
      replayThinkingEnabled,
      compat.allowEmptySignature,
      replayPlan.compaction,
    ),
    max_tokens: options?.maxTokens ?? model.maxTokens,
    stream: true,
  };

  if (system) {
    params.system = system;
  }

  // Fable 5 and Opus 5 safety classifiers can decline benign-adjacent work.
  // Anthropic owns the per-category fallback recommendation so routing can
  // evolve without a client release.
  if (serverSideFallback) {
    (params as { fallbacks?: "default" }).fallbacks = ANTHROPIC_SERVER_SIDE_FALLBACKS;
  }

  // Thinking and post-4.6 Claude models reject custom temperature values.
  if (
    options?.temperature !== undefined &&
    !options?.thinkingEnabled &&
    !supportsClaudeNativeXhighEffort(model)
  ) {
    params.temperature = options.temperature;
  }

  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop_sequences = options.stop;
  }

  if (tools && tools.length > 0) {
    params.tools = tools;
  }

  // Configure thinking mode: always-on adaptive (Fable 5 and Mythos 5),
  // adaptive (Opus 4.6+ and Sonnet 4.6),
  // budget-based (older models), or explicitly disabled.
  if (mandatoryAdaptiveThinking || model.reasoning || supportsClaudeAdaptiveThinking(model)) {
    if (mandatoryAdaptiveThinking || options?.thinkingEnabled) {
      // Default to "summarized" so Opus 4.7+ and Mythos Preview behave like
      // older Claude 4 models (whose API default is also "summarized").
      const display: AnthropicThinkingDisplay = options?.thinkingDisplay ?? "summarized";
      if (supportsClaudeAdaptiveThinking(model)) {
        // Adaptive thinking: Claude decides when and how much to think.
        params.thinking = { type: "adaptive", display };
        const effort = options?.effort ?? (mandatoryAdaptiveThinking ? "high" : undefined);
        if (effort) {
          params.output_config = { effort };
        }
      } else {
        // Budget-based thinking for older models.
        params.thinking = {
          type: "enabled",
          budget_tokens: options?.thinkingBudgetTokens ?? ANTHROPIC_MIN_THINKING_BUDGET_TOKENS,
          display,
        };
      }
    } else if (options?.thinkingEnabled === false) {
      params.thinking = { type: "disabled" };
    }
  }

  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
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

  return { params, toolProjection, usedCompactionReplay: replayPlan.compaction !== undefined };
}

async function convertMessages(
  messages: Message[],
  model: Model<"anthropic-messages">,
  isOAuthTokenValue: boolean,
  cacheControl?: CacheControlEphemeral,
  messageCacheControlLimit = 4,
  replayThinkingEnabled = true,
  allowEmptySignature = false,
  compaction?: AnthropicCompactionBlock,
): Promise<MessageParam[]> {
  const params: MessageParam[] = [];
  const imageBudget = createAnthropicInlineImageBudget();
  // Param indexes for transient runtime-context carriers — excluded from
  // cache_control breakpoint selection so the deepest breakpoint anchors on the
  // last stable user turn, not the volatile carrier appended after it.
  const cacheBreakpointOptOutParamIndexes = new Set<number>();

  // Transform messages for cross-provider compatibility
  const transformedMessages = transformMessages(messages, model, normalizeAnthropicToolCallId);
  const activeToolTurnAssistantIndex = replayThinkingEnabled
    ? -1
    : findActiveAnthropicToolTurnAssistantIndex(transformedMessages);

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (!msg) {
      continue;
    }

    if (msg.role === "user") {
      const isRuntimeContextCarrier = msg.runtimeContextCarrier === true;
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          if (isRuntimeContextCarrier) {
            cacheBreakpointOptOutParamIndexes.add(params.length);
          }
          params.push({
            role: "user",
            content: sanitizeSurrogates(msg.content),
          });
        }
      } else {
        const normalizedContent = await normalizeAnthropicInlineContent(msg.content, imageBudget);
        const blocks: ContentBlockParam[] = normalizedContent.map((item) => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text),
            };
          }
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: resolveAnthropicImageMediaType(item.mimeType),
              data: item.data,
            },
          };
        });
        const filteredBlocks = blocks.filter((b) => {
          if (b.type === "text") {
            return b.text.trim().length > 0;
          }
          return true;
        });
        if (filteredBlocks.length === 0) {
          continue;
        }
        if (isRuntimeContextCarrier) {
          cacheBreakpointOptOutParamIndexes.add(params.length);
        }
        params.push({
          role: "user",
          content: filteredBlocks,
        });
      }
    } else if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] =
        i === 0 && compaction ? ([compaction] as unknown as ContentBlockParam[]) : [];
      let omittedThinking = false;

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) {
            continue;
          }
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(block.text),
          });
        } else if (block.type === "thinking") {
          if (!replayThinkingEnabled && i !== activeToolTurnAssistantIndex) {
            omittedThinking = true;
            continue;
          }
          // Redacted thinking: pass the opaque payload back as redacted_thinking
          if (block.redacted) {
            if (!block.thinkingSignature) {
              throw new Error("redacted thinking block is missing its opaque signature");
            }
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature,
            });
            continue;
          }
          const thinkingSignature = block.thinkingSignature?.trim();
          const hasNativeThinkingSignature =
            Boolean(thinkingSignature) && thinkingSignature !== "reasoning_content";
          if (block.thinking.trim().length === 0 && !hasNativeThinkingSignature) {
            continue;
          }
          // If thinking signature is missing/empty (e.g., from aborted stream),
          // convert to plain text block without <thinking> tags to avoid API rejection
          // and prevent Claude from mimicking the tags in responses
          if (!thinkingSignature && !allowEmptySignature) {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(block.thinking),
            });
          } else {
            // OpenAI-compatible reasoning markers are field names, not native
            // Anthropic replay signatures; sending them bricks persisted replays.
            if (thinkingSignature === "reasoning_content") {
              continue;
            }
            blocks.push({
              type: "thinking",
              thinking: block.thinking,
              signature: thinkingSignature ?? "",
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: isOAuthTokenValue ? toClaudeCodeToolName(block.name) : block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length === 0 && omittedThinking) {
        blocks.push({ type: "text", text: ANTHROPIC_OMITTED_REASONING_TEXT });
      }
      if (blocks.length === 0) {
        continue;
      }
      params.push({
        role: "assistant",
        content: blocks,
      });
    } else if (msg.role === "toolResult") {
      // Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
      const toolResults: ContentBlockParam[] = [];
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: await convertContentBlocks(msg.content, msg.isError, imageBudget),
        is_error: msg.isError,
      });

      let j = i + 1;
      while (j < transformedMessages.length) {
        const nextMsg = transformedMessages.at(j);
        if (nextMsg?.role !== "toolResult") {
          break;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: await convertContentBlocks(nextMsg.content, nextMsg.isError, imageBudget),
          is_error: nextMsg.isError,
        });
        j++;
      }

      i = j - 1;
      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }

  if (cacheControl) {
    applyAnthropicCacheControlToMessages(
      params,
      cacheControl,
      messageCacheControlLimit,
      cacheBreakpointOptOutParamIndexes,
    );
  }

  return params;
}

function buildAnthropicSystemBlocks(
  systemPrompt: string | undefined,
  isOAuthTokenResult: boolean,
  cacheControl: CacheControlEphemeral | undefined,
): TextBlockParam[] | undefined {
  const blocks: TextBlockParam[] = [];
  if (isOAuthTokenResult) {
    // Anthropic uses this first system block to route Claude subscription OAuth billing.
    blocks.push({
      type: "text",
      text: ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
    });
    blocks.push({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    });
  }
  if (systemPrompt) {
    blocks.push(...buildSystemPromptBlocks(systemPrompt, cacheControl));
  }
  return blocks.length > 0 ? blocks : undefined;
}

function buildSystemPromptBlocks(
  systemPrompt: string,
  cacheControl: CacheControlEphemeral | undefined,
): TextBlockParam[] {
  if (!cacheControl) {
    return [
      { type: "text", text: sanitizeSurrogates(stripSystemPromptCacheBoundary(systemPrompt)) },
    ];
  }

  const split = splitSystemPromptCacheBoundary(systemPrompt);
  if (!split) {
    return [
      {
        type: "text",
        text: sanitizeSurrogates(systemPrompt),
        cache_control: cacheControl,
      },
    ];
  }

  const blocks: TextBlockParam[] = [];
  if (split.stablePrefix) {
    blocks.push({
      type: "text",
      text: sanitizeSurrogates(split.stablePrefix),
      cache_control: cacheControl,
    });
  }
  if (split.dynamicSuffix) {
    blocks.push({ type: "text", text: sanitizeSurrogates(split.dynamicSuffix) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function countNativeCacheControlMarkers(blocks: unknown): number {
  if (!Array.isArray(blocks)) {
    return 0;
  }

  let count = 0;
  for (const block of blocks) {
    if (block && typeof block === "object" && "cache_control" in block) {
      count += 1;
    }
  }
  return count;
}

function shouldUseFineGrainedToolStreamingBeta(
  model: Model<"anthropic-messages">,
  context: Context,
): boolean {
  return (
    Boolean(context.tools?.length) && !getAnthropicCompat(model).supportsEagerToolInputStreaming
  );
}

function convertTools(
  tools: Tool[],
  isOAuthTokenLocal: boolean,
  supportsEagerToolInputStreaming: boolean,
  cacheControl?: CacheControlEphemeral,
): {
  projection: AnthropicToolProjection;
  tools: Anthropic.Messages.Tool[];
} {
  const projection = projectAnthropicTools(tools, (name) =>
    isOAuthTokenLocal ? toClaudeCodeToolName(name) : name,
  );
  const convertedTools: Anthropic.Messages.Tool[] = [];
  for (const [index, tool] of projection.tools.entries()) {
    const convertedTool: Anthropic.Messages.Tool = {
      name: tool.wireName,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
    if (supportsEagerToolInputStreaming) {
      convertedTool.eager_input_streaming = true;
    }
    if (cacheControl && index === projection.tools.length - 1) {
      convertedTool.cache_control = cacheControl;
    }
    convertedTools.push(convertedTool);
  }
  return {
    projection,
    tools: convertedTools,
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
