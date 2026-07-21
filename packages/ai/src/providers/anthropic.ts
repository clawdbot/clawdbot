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
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import {
  createAnthropicInlineImageBudget,
  normalizeAnthropicInlineContent,
  resolveAnthropicImageMediaType,
  type AnthropicInlineImageBudget,
} from "../internal/anthropic-inline-images.js";
import { calculateCost, clampThinkingLevel } from "../model-utils.js";
import type {
  AnthropicMessagesCompat,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  CacheRetention,
  Context,
  Message,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "../types.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
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
  prepareClaudeSonnet5RequestContext,
  resolveClaudeNativeThinkingLevelMap,
  resolveClaudeSonnet5ModelIdentity,
  requiresClaudeAdaptiveThinking,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
  usesClaudeFable5MessagesContract,
  usesClaudeStreamingRefusalContract,
} from "./anthropic-model-contract.js";
import { applyAnthropicRefusal } from "./anthropic-refusal.js";
import {
  ANTHROPIC_SERVER_SIDE_FALLBACK_BETA,
  CLAUDE_FABLE_5_FALLBACK_MODEL_COST,
  applyAnthropicFallbackBoundary,
  buildAnthropicServerSideFallbacks,
  readAnthropicFallbackBoundary,
} from "./anthropic-server-fallback.js";
import {
  ANTHROPIC_OMITTED_REASONING_TEXT,
  findActiveAnthropicToolTurnAssistantIndex,
} from "./anthropic-thinking-replay.js";
import {
  projectAnthropicTools,
  reconcileAnthropicToolChoice,
  resolveOriginalAnthropicToolName,
  type AnthropicProjectedToolChoice,
  type AnthropicToolProjection,
} from "./anthropic-tool-projection.js";
import {
  readAnthropicCacheWriteUsage,
  readAnthropicPromptUsageSnapshot,
  readAnthropicUsageTokenCount,
  readLastAnthropicIterationUsage,
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
import { transformMessages } from "./transform-messages.js";

const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;
const EMPTY_ERROR_TOOL_RESULT_TEXT = "[tool error with no output]";

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

// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.75";
const claudeCodeBillingSystemBlock = `x-anthropic-billing-header: cc_version=${claudeCodeVersion}; cc_entrypoint=sdk-cli;`;

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;

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

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

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

export interface AnthropicOptions extends StreamOptions {
  /**
   * Enable extended thinking.
   * For Opus 4.6+ and Sonnet 4.6: uses adaptive thinking (model decides when/how much to think).
   * For older models: uses budget-based thinking with thinkingBudgetTokens.
   */
  thinkingEnabled?: boolean;
  /**
   * Token budget for extended thinking (older models only).
   * Ignored for Opus 4.6+ and Sonnet 4.6, which use adaptive thinking.
   */
  thinkingBudgetTokens?: number;
  /**
   * Effort level for adaptive thinking (Opus 4.6+ and Sonnet 4.6).
   * Controls how much thinking Claude allocates:
   * - "max": Always thinks with no constraints (Opus 4.6 only)
   * - "xhigh": Highest reasoning level (Opus 4.7+)
   * - "high": Always thinks, deep reasoning (default)
   * - "medium": Moderate thinking, may skip for simple queries
   * - "low": Minimal thinking, skips for simple tasks
   * Ignored for older models.
   */
  effort?: AnthropicEffort;
  /**
   * Controls how thinking content is returned in API responses.
   * - "summarized": Thinking blocks contain summarized thinking text (default here).
   * - "omitted": Thinking blocks return an empty thinking field; the encrypted
   *   signature still travels back for multi-turn continuity. Use for faster
   *   time-to-first-text-token when your UI does not surface thinking.
   *
   * Note: Anthropic's API default for Claude Opus 4.7+ and Claude Mythos Preview
   * is "omitted". We default to "summarized" here to keep behavior consistent
   * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
   */
  thinkingDisplay?: AnthropicThinkingDisplay;
  interleavedThinking?: boolean;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  /**
   * Pre-built Anthropic client instance. When provided, skips internal client
   * construction entirely. Use this to inject alternative SDK clients such as
   * `AnthropicVertex` that shares the same messaging API.
   */
  client?: Anthropic;
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
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
        { cause: error },
      );
    }
  }

  if ((sawMessageStart || requireMessageStop) && !sawMessageEnd) {
    throw new Error("Anthropic stream ended before message_stop");
  }
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const requestContext = prepareClaudeSonnet5RequestContext(model, context);
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
      let params = builtParams.params;
      const toolProjection = builtParams.toolProjection;
      const nextParams = await requestOptions?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as MessageCreateParamsStreaming;
      }
      applyClaudeRequestContract(params as unknown as Record<string, unknown>, model);
      const sdkRequestOptions = {
        ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
        ...(requestOptions?.timeoutMs !== undefined ? { timeout: requestOptions.timeoutMs } : {}),
        maxRetries: requestOptions?.maxRetries ?? 0,
      };
      const response = await client.messages
        .create({ ...params, stream: true }, sdkRequestOptions)
        .asResponse();
      await requestOptions?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );

      type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & {
        index: number;
      };
      const blocks = output.content as Block[];
      const blockIndexes = new Map<number, number>();

      for await (const event of iterateAnthropicEvents(response, refusalBuffer !== undefined)) {
        if (event.type === "message_start") {
          output.responseId = event.message.id;
          output.responseModel = event.message.model;
          const promptUsage = readAnthropicPromptUsageSnapshot(event.message.usage);
          const messageStartPromptTokens = promptUsage
            ? promptUsage.input + promptUsage.cacheRead + promptUsage.cacheWrite
            : 0;
          messageStartPromptUsage = messageStartPromptTokens > 0 ? promptUsage : undefined;
          const inputTokens = readAnthropicUsageTokenCount(event.message.usage.input_tokens);
          if (inputTokens !== undefined) {
            output.usage.input = inputTokens;
          }
          const outputTokens = readAnthropicUsageTokenCount(event.message.usage.output_tokens);
          if (outputTokens !== undefined) {
            output.usage.output = outputTokens;
          }
          const cacheReadTokens =
            event.message.usage.cache_read_input_tokens == null
              ? 0
              : readAnthropicUsageTokenCount(event.message.usage.cache_read_input_tokens);
          if (cacheReadTokens !== undefined) {
            output.usage.cacheRead = cacheReadTokens;
          }
          const cacheWriteTokens =
            event.message.usage.cache_creation_input_tokens == null
              ? 0
              : readAnthropicUsageTokenCount(event.message.usage.cache_creation_input_tokens);
          if (cacheWriteTokens !== undefined) {
            output.usage.cacheWrite = cacheWriteTokens;
          }
          const cacheWriteUsage = readAnthropicCacheWriteUsage(event.message.usage);
          if (cacheWriteUsage.cacheWrite1h !== undefined) {
            output.usage.cacheWrite1h = cacheWriteUsage.cacheWrite1h;
          }
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          if (messageStartPromptUsage && outputTokens !== undefined) {
            output.usage.contextUsage = {
              state: "available",
              promptTokens: messageStartPromptTokens,
              totalTokens: messageStartPromptTokens + output.usage.output,
            };
          }
          calculateCost(costModel, output.usage);
          // Defer start until after message_start so that pre-stream SSE errors
          // (e.g. invalid thinking signatures) arrive before any non-error event
          // is yielded, keeping yieldedOutput=false in pumpStreamWithRecovery
          // and allowing the thinking-block recovery retry to fire.
          eventSink.push({ type: "start", partial: output });
        } else if (event.type === "content_block_start") {
          const fallbackBoundary = refusalBuffer
            ? readAnthropicFallbackBoundary(event.content_block)
            : null;
          if (fallbackBoundary) {
            // Server-side fallback boundary: pre-boundary thinking/tool blocks
            // must not replay or execute, and the buffered preview events
            // reference them, so rebuild the deferred timeline from the
            // surviving text prefix the fallback model continued from.
            refusalBuffer?.discard();
            blockIndexes.clear();
            applyAnthropicFallbackBoundary({
              output,
              boundary: fallbackBoundary,
              provider: model.provider,
            });
            // Cost intentionally mirrors top-level usage (serving attempt at
            // serving-model rates). A mid-stream decline's billed partial is
            // only in usage.iterations and is not folded in here.
            costModel = { ...model, cost: CLAUDE_FABLE_5_FALLBACK_MODEL_COST };
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
            eventSink.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
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
              block.partialJson += event.delta.partial_json;
              block.arguments = parseStreamingJson(block.partialJson);
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
              block.arguments = parseStreamingJson(block.partialJson);
              // Finalize in-place and strip the scratch buffer so replay only
              // carries parsed arguments.
              delete (block as { partialJson?: string }).partialJson;
              eventSink.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block,
                partial: output,
              });
            }
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) {
            if (event.delta.stop_reason === "refusal") {
              applyAnthropicRefusal(output, event.delta.stop_details, model.provider);
            } else {
              output.stopReason = mapStopReason(event.delta.stop_reason);
            }
          }
          // Only update usage fields if present (not null).
          // Preserves input_tokens from message_start when proxies omit it in message_delta.
          if (event.usage) {
            const inputTokens = readAnthropicUsageTokenCount(event.usage.input_tokens);
            if (inputTokens !== undefined) {
              output.usage.input = inputTokens;
            }
            const outputTokens = readAnthropicUsageTokenCount(event.usage.output_tokens);
            if (outputTokens !== undefined) {
              output.usage.output = outputTokens;
            }
            // Match the SDK stream accumulator: null means no update, not a zero counter.
            const cacheReadTokens = readAnthropicUsageTokenCount(
              event.usage.cache_read_input_tokens,
            );
            if (cacheReadTokens !== undefined) {
              output.usage.cacheRead = cacheReadTokens;
            }
            const cacheWriteTokens = readAnthropicUsageTokenCount(
              event.usage.cache_creation_input_tokens,
            );
            if (cacheWriteTokens !== undefined) {
              output.usage.cacheWrite = cacheWriteTokens;
            }
            const cacheWriteUsage = readAnthropicCacheWriteUsage(event.usage);
            if (cacheWriteUsage.cacheWrite1h !== undefined) {
              output.usage.cacheWrite1h = cacheWriteUsage.cacheWrite1h;
            }
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            const iterationUsage = readLastAnthropicIterationUsage(event.usage);
            if (iterationUsage.state === "valid") {
              output.usage.contextUsage = {
                state: "available",
                promptTokens: iterationUsage.usage.contextPromptTokens,
                totalTokens: iterationUsage.usage.totalTokens,
              };
            } else if (iterationUsage.state === "invalid") {
              output.usage.contextUsage = { state: "unavailable" };
            } else if (
              outputTokens !== undefined &&
              (messageStartPromptUsage !== undefined ||
                (inputTokens !== undefined &&
                  cacheReadTokens !== undefined &&
                  cacheWriteTokens !== undefined))
            ) {
              const promptTokens =
                output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
              output.usage.contextUsage = {
                state: "available",
                promptTokens,
                totalTokens: promptTokens + output.usage.output,
              };
            } else {
              output.usage.contextUsage = { state: "unavailable" };
            }
          }
          calculateCost(costModel, output.usage);
        }
      }

      if (requestOptions?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage ?? "An unknown error occurred");
      }

      refusalBuffer?.flush();
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      if (refusalBuffer) {
        refusalBuffer.discard();
        output.content = [];
      }
      output.stopReason = requestOptions?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

function normalizeAnthropicToolChoice(
  thinkingEnabled: boolean,
  toolChoice: NonNullable<AnthropicOptions["toolChoice"]>,
): AnthropicProjectedToolChoice {
  if (
    thinkingEnabled &&
    (toolChoice === "any" || (typeof toolChoice === "object" && toolChoice.type === "tool"))
  ) {
    return { type: "auto" as const };
  }
  return typeof toolChoice === "string" ? { type: toolChoice } : toolChoice;
}

/**
 * Check if a model supports adaptive thinking (Fable 5, Opus 4.6+, Sonnet 4.6).
 */
function supportsAdaptiveThinking(model: Model<"anthropic-messages">): boolean {
  return supportsClaudeAdaptiveThinking(model);
}

function normalizeAnthropicThinkingOptions(
  model: Model<"anthropic-messages">,
  options: AnthropicOptions | undefined,
): AnthropicOptions | undefined {
  if (options?.thinkingEnabled !== true || supportsAdaptiveThinking(model)) {
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

function supportsNativeXhighEffort(model: Model<"anthropic-messages">): boolean {
  return supportsClaudeNativeXhighEffort(model);
}

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Model metadata owns the provider-specific extended effort mapping.
 */
function mapThinkingLevelToEffort(
  model: Model<"anthropic-messages">,
  level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
  const requestedLevel = level as ModelThinkingLevel | undefined;
  const hasCanonicalAlias = typeof model.params?.canonicalModelId === "string";
  const thinkingLevelMap = resolveClaudeNativeThinkingLevelMap(model);
  const clampModel = {
    ...model,
    ...(hasCanonicalAlias ? { reasoning: true } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
  const clampedLevel = requestedLevel
    ? clampThinkingLevel(clampModel, requestedLevel)
    : requestedLevel;
  const mapped = clampedLevel ? thinkingLevelMap?.[clampedLevel] : undefined;
  if (typeof mapped === "string") {
    return mapped as AnthropicEffort;
  }

  switch (clampedLevel) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return supportsNativeXhighEffort(model) ? "xhigh" : "high";
    case "max":
      return supportsClaudeNativeMaxEffort(model) ? "max" : "high";
    default:
      return "high";
  }
}

type AnthropicSimpleStreamOptions = SimpleStreamOptions & {
  toolChoice?: AnthropicOptions["toolChoice"];
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
    maxTokens: clampMaxTokensToModel(model, options?.maxTokens ?? model.maxTokens),
    toolChoice: options?.toolChoice,
  };
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  if (options?.reasoning === "off" && !mandatoryAdaptiveThinking) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: false,
    } satisfies AnthropicOptions);
  }
  const reasoning =
    options?.reasoning === "off"
      ? mandatoryAdaptiveThinking
        ? "low"
        : "high"
      : options?.reasoning;
  if (resolveClaudeSonnet5ModelIdentity(model)) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort: mapThinkingLevelToEffort(model, reasoning ?? "high"),
    } satisfies AnthropicOptions);
  }
  if (!reasoning) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: mandatoryAdaptiveThinking,
      ...(mandatoryAdaptiveThinking ? { effort: "high" as const } : {}),
    } satisfies AnthropicOptions);
  }

  // For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
  // For older models: use budget-based thinking
  if (supportsAdaptiveThinking(model)) {
    const effort = mapThinkingLevelToEffort(model, reasoning);
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort,
    } satisfies AnthropicOptions);
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
  } satisfies AnthropicOptions);
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
  if (!usesClaudeFable5MessagesContract(model) || model.provider !== "anthropic") {
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
  const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinking(model);
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
          "user-agent": `claude-cli/${claudeCodeVersion}`,
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
  options?: AnthropicOptions,
  serverSideFallback = false,
): Promise<{
  params: MessageCreateParamsStreaming;
  toolProjection?: AnthropicToolProjection;
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
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    messages: await convertMessages(
      context.messages,
      model,
      isOAuthTokenResult,
      cacheControl,
      messageCacheControlLimit,
      replayThinkingEnabled,
      compat.allowEmptySignature,
    ),
    max_tokens: options?.maxTokens ?? model.maxTokens,
    stream: true,
  };

  if (system) {
    params.system = system;
  }

  // Fable safety classifiers can decline benign-adjacent work; server-side
  // fallback re-serves the same call on claude-opus-4-8 instead of failing
  // the turn. Only set when createClient added the matching beta header.
  if (serverSideFallback) {
    (params as { fallbacks?: Array<{ model: string }> }).fallbacks =
      buildAnthropicServerSideFallbacks();
  }

  // Thinking and post-4.6 Claude models reject custom temperature values.
  if (
    options?.temperature !== undefined &&
    !options?.thinkingEnabled &&
    !supportsNativeXhighEffort(model)
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
  if (mandatoryAdaptiveThinking || model.reasoning || supportsAdaptiveThinking(model)) {
    if (mandatoryAdaptiveThinking || options?.thinkingEnabled) {
      // Default to "summarized" so Opus 4.7+ and Mythos Preview behave like
      // older Claude 4 models (whose API default is also "summarized").
      const display: AnthropicThinkingDisplay = options?.thinkingDisplay ?? "summarized";
      if (supportsAdaptiveThinking(model)) {
        // Adaptive thinking: Claude decides when and how much to think.
        params.thinking = { type: "adaptive", display };
        const effort = options?.effort ?? (mandatoryAdaptiveThinking ? "high" : undefined);
        if (effort) {
          // The Anthropic SDK types can lag newly supported effort values such as "xhigh".
          params.output_config =
            effort === "xhigh"
              ? ({ effort } as unknown as NonNullable<
                  MessageCreateParamsStreaming["output_config"]
                >)
              : { effort };
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

  return { params, toolProjection };
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

async function convertMessages(
  messages: Message[],
  model: Model<"anthropic-messages">,
  isOAuthTokenValue: boolean,
  cacheControl?: CacheControlEphemeral,
  messageCacheControlLimit = 4,
  replayThinkingEnabled = true,
  allowEmptySignature = false,
): Promise<MessageParam[]> {
  const params: MessageParam[] = [];
  const imageBudget = createAnthropicInlineImageBudget();
  // Param indexes for transient runtime-context carriers — excluded from
  // cache_control breakpoint selection so the deepest breakpoint anchors on the
  // last stable user turn, not the volatile carrier appended after it.
  const cacheBreakpointOptOutParamIndexes = new Set<number>();

  // Transform messages for cross-provider compatibility
  const transformedMessages = transformMessages(messages, model, normalizeToolCallId);
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
      const blocks: ContentBlockParam[] = [];
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
            name: isOAuthTokenValue ? toClaudeCodeName(block.name) : block.name,
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

  if (cacheControl && params.length > 0 && messageCacheControlLimit > 0) {
    let fallbackToolResult: ContentBlockParam | undefined;

    for (let i = params.length - 1; i >= 0; i--) {
      const message = params[i];
      if (!message || message.role !== "user" || cacheBreakpointOptOutParamIndexes.has(i)) {
        continue;
      }

      if (Array.isArray(message.content)) {
        for (let j = message.content.length - 1; j >= 0; j--) {
          const block = message.content[j];
          if (!block) {
            continue;
          }
          if (block.type === "text" || block.type === "image") {
            if (fallbackToolResult && messageCacheControlLimit === 1) {
              applyContentBlockCacheControl(fallbackToolResult, cacheControl);
              return params;
            }
            applyContentBlockCacheControl(block, cacheControl);
            if (fallbackToolResult && messageCacheControlLimit > 1) {
              applyContentBlockCacheControl(fallbackToolResult, cacheControl);
            }
            return params;
          }
          if (block.type === "tool_result" && fallbackToolResult === undefined) {
            fallbackToolResult = block;
          }
        }
        continue;
      }

      if (typeof message.content === "string") {
        if (fallbackToolResult && messageCacheControlLimit === 1) {
          applyContentBlockCacheControl(fallbackToolResult, cacheControl);
          return params;
        }
        message.content = [
          {
            type: "text",
            text: message.content,
            cache_control: cacheControl,
          },
        ] as ContentBlockParam[];
        if (fallbackToolResult && messageCacheControlLimit > 1) {
          applyContentBlockCacheControl(fallbackToolResult, cacheControl);
        }
        return params;
      }
    }

    if (fallbackToolResult) {
      applyContentBlockCacheControl(fallbackToolResult, cacheControl);
    }
  }

  return params;
}

function applyContentBlockCacheControl(
  block: ContentBlockParam,
  cacheControl: CacheControlEphemeral,
): void {
  (block as ContentBlockParam & { cache_control?: CacheControlEphemeral }).cache_control =
    cacheControl;
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
      text: claudeCodeBillingSystemBlock,
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
    isOAuthTokenLocal ? toClaudeCodeName(name) : name,
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

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    case "pause_turn": // Stop is good enough -> resubmit
      return "stop";
    case "stop_sequence":
      return "stop"; // We don't supply stop sequences, so this should never happen
    case "sensitive": // Content flagged by safety filters (not yet in SDK types)
      return "error";
    default:
      // Handle unknown stop reasons gracefully (API may add new values)
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
