// OpenAI completions provider adapts chat completions to the agent runtime.
import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionDeveloperMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { calculateCost, clampThinkingLevel } from "../model-utils.js";
import type {
  AssistantMessage,
  CacheRetention,
  Context,
  ImageContent,
  Message,
  Model,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { createReasoningTagTextPartitioner } from "../utils/reasoning-tag-text-partitioner.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  withFirstStreamEventTimeout,
} from "../utils/stream-first-event-timeout.js";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../utils/system-prompt-cache-boundary.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import { mapOpenAIStopReason } from "./openai-stop-reason.js";
import {
  projectOpenAITools,
  reconcileOpenAICompletionsToolChoice,
  type OpenAICompletionsToolChoice,
  type OpenAIToolProjection,
} from "./openai-tool-projection.js";
import { buildBaseOptions } from "./simple-options.js";
import { describeToolResultMediaPlaceholder, extractToolResultText } from "./tool-result-text.js";
import { transformMessages } from "./transform-messages.js";

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      return true;
    }
    if (msg.role === "assistant") {
      // Assistant content can be a raw string from transcript replay; a string
      // never carries tool calls, so it should not count toward tool history.
      if (Array.isArray(msg.content) && msg.content.some((block) => block.type === "toolCall")) {
        return true;
      }
    }
  }
  return false;
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
  return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
  return block.type === "toolCall";
}

function isImageContentBlock(block: { type: string }): block is ImageContent {
  return block.type === "image";
}

const EMPTY_TOOL_RESULT_TEXT = "(no output)";

function sanitizeToolResultText(text: string, fallback: string): string {
  const sanitized = sanitizeSurrogates(text);
  return sanitized.trim().length > 0 ? sanitized : fallback;
}

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: OpenAICompletionsToolChoice;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

interface OpenAICompatCacheControl {
  type: "ephemeral";
  ttl?: string;
}

type ResolvedOpenAICompletionsCompat = Omit<
  Required<OpenAICompletionsCompat>,
  "cacheControlFormat"
> & {
  cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

type ChatCompletionInstructionMessageParam =
  | ChatCompletionDeveloperMessageParam
  | ChatCompletionSystemMessageParam;

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
  cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
  cache_control?: OpenAICompatCacheControl;
};

export const streamOpenAICompletions: StreamFunction<
  "openai-completions",
  OpenAICompletionsOptions
> = (model: Model<"openai-completions">, context: Context, options?: OpenAICompletionsOptions) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
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

    let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
    try {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const compat = getCompat(model);
      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
      const client = createClient(model, context, apiKey, options?.headers, cacheSessionId, compat);
      let params = buildParams(model, context, options, compat, cacheRetention);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as typeof params;
      }
      firstEventAbort = createFirstStreamEventAbortController(options?.signal);
      const requestOptions = {
        signal: firstEventAbort.signal,
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      };
      const { data: openaiStream, response } = await client.chat.completions
        .create(
          params as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          requestOptions,
        )
        .withResponse();
      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );
      stream.push({ type: "start", partial: output });

      interface StreamingToolCallBlock extends ToolCall {
        partialArgs?: string;
        streamIndex?: number;
      }
      type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
      type StreamingToolCallDelta = NonNullable<
        ChatCompletionChunk.Choice.Delta["tool_calls"]
      >[number];

      let textBlock: TextContent | null = null;
      let thinkingBlock: ThinkingContent | null = null;
      let hasFinishReason = false;
      const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
      const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
      const toolCallBlocksByFirstId = new Map<string, StreamingToolCallBlock>();
      const blocks = output.content as StreamingBlock[];
      // A block can be finished mid-stream (native reasoning sealed at the
      // text-lane transition) and again by the end-of-stream loop; guard so its
      // *_end event is emitted exactly once.
      const finishedBlocks = new Set<StreamingBlock>();
      const contentIndices = new WeakMap<StreamingBlock, number>();
      const appendBlock = (block: StreamingBlock) => {
        contentIndices.set(block, blocks.length);
        blocks.push(block);
      };
      const getContentIndex = (block: StreamingBlock) => contentIndices.get(block) ?? -1;
      const rememberFirstToolCallById = (id: string, block: StreamingToolCallBlock) => {
        if (!toolCallBlocksByFirstId.has(id)) {
          toolCallBlocksByFirstId.set(id, block);
        }
      };
      const finishBlock = (block: StreamingBlock) => {
        const contentIndex = getContentIndex(block);
        if (contentIndex === -1 || finishedBlocks.has(block)) {
          return;
        }
        finishedBlocks.add(block);
        if (block.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex,
            content: block.text,
            partial: output,
          });
        } else if (block.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: block.thinking,
            partial: output,
          });
        } else if (block.type === "toolCall") {
          block.arguments = parseStreamingJson(block.partialArgs);
          // Finalize in-place and strip the scratch buffers so replay only
          // carries parsed arguments.
          delete block.partialArgs;
          delete block.streamIndex;
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall: block,
            partial: output,
          });
        }
      };
      const ensureTextBlock = () => {
        if (!textBlock) {
          textBlock = { type: "text", text: "" };
          appendBlock(textBlock);
          stream.push({
            type: "text_start",
            contentIndex: getContentIndex(textBlock),
            partial: output,
          });
        }
        return textBlock;
      };
      const ensureThinkingBlock = (thinkingSignature: string) => {
        if (!thinkingBlock) {
          thinkingBlock = {
            type: "thinking",
            thinking: "",
            thinkingSignature,
          };
          appendBlock(thinkingBlock);
          stream.push({
            type: "thinking_start",
            contentIndex: getContentIndex(thinkingBlock),
            partial: output,
          });
        }
        return thinkingBlock;
      };
      // Native-thinking providers (e.g. deepseek `reasoning_content`) stream the
      // reasoning lane, then switch to the answer via `content` with no boundary
      // event. Seal the open thought when visible text begins so `thinking_end`
      // precedes the answer; tag-based <think> reasoning has no native thinking
      // block (it is closed by the partitioner), so this is a no-op there.
      const sealNativeReasoningBeforeText = () => {
        if (thinkingBlock && !reasoningTagTextPartitioner.isInsideReasoning()) {
          finishBlock(thinkingBlock);
          thinkingBlock = null;
        }
      };
      const appendTextDelta = (delta: string) => {
        sealNativeReasoningBeforeText();
        const block = ensureTextBlock();
        block.text += delta;
        stream.push({
          type: "text_delta",
          contentIndex: getContentIndex(block),
          delta,
          partial: output,
        });
      };
      const appendThinkingDelta = (thinkingSignature: string, delta: string) => {
        const block = ensureThinkingBlock(thinkingSignature);
        block.thinking += delta;
        stream.push({
          type: "thinking_delta",
          contentIndex: getContentIndex(block),
          delta,
          partial: output,
        });
      };
      const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
        const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
        let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
        if (!block && toolCall.id) {
          block = toolCallBlocksById.get(toolCall.id);
        }
        if (!block) {
          block = {
            type: "toolCall",
            id: toolCall.id || "",
            name: toolCall.function?.name || "",
            arguments: {},
            partialArgs: "",
            streamIndex,
          };
          if (streamIndex !== undefined) {
            toolCallBlocksByIndex.set(streamIndex, block);
          }
          if (toolCall.id) {
            toolCallBlocksById.set(toolCall.id, block);
            rememberFirstToolCallById(toolCall.id, block);
          }
          appendBlock(block);
          stream.push({
            type: "toolcall_start",
            contentIndex: getContentIndex(block),
            partial: output,
          });
        }
        if (streamIndex !== undefined && block.streamIndex === undefined) {
          block.streamIndex = streamIndex;
          toolCallBlocksByIndex.set(streamIndex, block);
        }
        if (toolCall.id) {
          toolCallBlocksById.set(toolCall.id, block);
        }
        return block;
      };
      const reasoningTagTextPartitioner = createReasoningTagTextPartitioner();
      const appendPartitionedContent = (text: string, hasMirroredReasoning: boolean) => {
        const routedDeltas = hasMirroredReasoning
          ? reasoningTagTextPartitioner.push(text)
          : reasoningTagTextPartitioner.pushVisible(text);
        for (const delta of routedDeltas) {
          if (delta.kind === "text") {
            appendTextDelta(delta.text);
          }
        }
      };
      const flushPartitionedContent = () => {
        for (const delta of reasoningTagTextPartitioner.flush()) {
          if (delta.kind === "text") {
            appendTextDelta(delta.text);
          }
        }
      };

      const guardedOpenaiStream = withFirstStreamEventTimeout(openaiStream, {
        provider: model.provider,
        api: model.api,
        model: model.id,
        timeoutMs: getFirstStreamEventTimeoutMs(options) ?? 0,
        stage: "completions",
        abort: firstEventAbort.abort,
        onTimeout: getFirstStreamEventTimeoutHandler(options),
        hint: "The provider may be stalled while parsing the tool payload; retry with a smaller tool surface or enable OPENCLAW_DEBUG_MODEL_PAYLOAD=tools to inspect exposed tools.",
      });

      for await (const chunk of guardedOpenaiStream) {
        if (!chunk || typeof chunk !== "object") {
          continue;
        }

        // OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
        // and each chunk in a streamed completion carries the same id.
        output.responseId ||= chunk.id;
        if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
          output.responseModel ||= chunk.model;
        }
        if (chunk.usage) {
          output.usage = parseChunkUsage(chunk.usage, model);
        }

        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        if (!choice) {
          continue;
        }

        // Fallback: some providers (e.g., Moonshot) return usage
        // in choice.usage instead of the standard chunk.usage
        const choiceUsage = (
          choice as typeof choice & { usage?: Parameters<typeof parseChunkUsage>[0] }
        ).usage;
        if (!chunk.usage && choiceUsage) {
          output.usage = parseChunkUsage(choiceUsage, model);
        }

        if (choice.finish_reason) {
          const finishReasonResult = mapOpenAIStopReason(choice.finish_reason);
          output.stopReason = finishReasonResult.stopReason;
          if (finishReasonResult.errorMessage) {
            output.errorMessage = finishReasonResult.errorMessage;
          }
          hasFinishReason = true;
        }

        if (choice.delta) {
          // Some endpoints return reasoning in reasoning_content (llama.cpp),
          // or reasoning (other openai compatible endpoints)
          // Use the first non-empty reasoning field to avoid duplication
          // (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
          const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
          const deltaFields = choice.delta as Record<string, unknown>;
          const shouldEmitReasoning = Boolean(model.reasoning && options?.reasoningEffort);
          let foundReasoningField: string | null = null;
          for (const field of reasoningFields) {
            const value = deltaFields[field];
            if (typeof value === "string" && value.length > 0) {
              foundReasoningField = field;
              break;
            }
          }
          if (foundReasoningField) {
            reasoningTagTextPartitioner.markStrict();
          }
          if (shouldEmitReasoning && foundReasoningField) {
            const delta = deltaFields[foundReasoningField];
            if (typeof delta === "string" && delta.length > 0) {
              const thinkingSignature =
                model.provider === "opencode-go" && foundReasoningField === "reasoning"
                  ? "reasoning_content"
                  : foundReasoningField;
              appendThinkingDelta(thinkingSignature, delta);
            }
          }
          if (
            choice.delta.content !== null &&
            choice.delta.content !== undefined &&
            choice.delta.content.length > 0
          ) {
            appendPartitionedContent(choice.delta.content, Boolean(foundReasoningField));
          }

          if (choice?.delta?.tool_calls) {
            flushPartitionedContent();
            // The tool-call lane is also a reasoning boundary; seal the thought
            // before toolcall_start so thinking_end never trails the action.
            sealNativeReasoningBeforeText();
            for (const toolCall of choice.delta.tool_calls) {
              const block = ensureToolCallBlock(toolCall);
              if (!block.id && toolCall.id) {
                block.id = toolCall.id;
                toolCallBlocksById.set(toolCall.id, block);
                rememberFirstToolCallById(toolCall.id, block);
              }
              if (!block.name && toolCall.function?.name) {
                block.name = toolCall.function.name;
              }

              let delta = "";
              if (toolCall.function?.arguments) {
                delta = toolCall.function.arguments;
                block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
                block.arguments = parseStreamingJson(block.partialArgs);
              }
              stream.push({
                type: "toolcall_delta",
                contentIndex: getContentIndex(block),
                delta,
                partial: output,
              });
            }
          }

          const reasoningDetails = (choice.delta as { reasoning_details?: unknown })
            .reasoning_details;
          if (reasoningDetails && Array.isArray(reasoningDetails)) {
            for (const detail of reasoningDetails) {
              if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
                const matchingToolCall = toolCallBlocksByFirstId.get(detail.id);
                if (matchingToolCall) {
                  matchingToolCall.thoughtSignature = JSON.stringify(detail);
                }
              }
            }
          }
        }
      }

      flushPartitionedContent();

      for (const block of blocks) {
        finishBlock(block);
      }
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "error") {
        throw new Error(output.errorMessage || "Provider returned an error stop reason");
      }
      if (!hasFinishReason) {
        throw new Error("Stream ended without finish_reason");
      }

      const hasToolCalls = output.content.some((block) => block.type === "toolCall");
      const hasVisibleText = output.content.some(
        (block) => block.type === "text" && block.text.trim().length > 0,
      );
      if (output.stopReason === "toolUse" && !hasToolCalls) {
        output.stopReason = "stop";
      }
      if (output.stopReason === "stop" && hasToolCalls && !hasVisibleText) {
        output.stopReason = "toolUse";
      }
      if (hasToolCalls && output.stopReason !== "toolUse") {
        output.content = output.content.filter((block) => block.type !== "toolCall");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // Streaming scratch buffers are only used during parsing; never persist them.
        delete (block as { partialArgs?: string }).partialArgs;
        delete (block as { streamIndex?: number }).streamIndex;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      // Some providers via OpenRouter give additional information in this field.
      const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata
        ?.raw;
      if (rawMetadata) {
        output.errorMessage += `\n${rawMetadata}`;
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      firstEventAbort?.dispose();
    }
  })();

  return stream;
};

export const streamSimpleOpenAICompletions: StreamFunction<
  "openai-completions",
  SimpleStreamOptions
> = (model: Model<"openai-completions">, context: Context, options?: SimpleStreamOptions) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const reasoningEffort =
    clampedReasoning === "off"
      ? undefined
      : clampedReasoning === "max"
        ? "xhigh"
        : clampedReasoning;
  const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;

  return streamOpenAICompletions(model, context, {
    ...base,
    reasoningEffort,
    toolChoice,
  } satisfies OpenAICompletionsOptions);
};

function createClient(
  model: Model<"openai-completions">,
  context: Context,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
  sessionId?: string,
  compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    const copilotHeaders = buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages,
    });
    Object.assign(headers, copilotHeaders);
  }

  if (sessionId && compat.sendSessionAffinityHeaders) {
    headers.session_id = sessionId;
    headers["x-client-request-id"] = sessionId;
    headers["x-session-affinity"] = sessionId;
  }

  // Merge options headers last so they can override defaults
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  const defaultHeaders =
    model.provider === "cloudflare-ai-gateway"
      ? {
          ...headers,
          Authorization: headers.Authorization ?? null,
          "cf-aig-authorization": `Bearer ${apiKey}`,
        }
      : headers;

  return new OpenAI({
    apiKey,
    baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    fetch: getAiTransportHost().buildModelFetch(model),
  });
}

function buildParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
  compat: ResolvedOpenAICompletionsCompat = getCompat(model),
  cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention),
) {
  const cacheControl = getCompatCacheControl(compat, cacheRetention);
  // Transient runtime-context carrier indexes skip cache anchoring so the breakpoint
  // stays on the last stable user turn; conversion-to-policy must not splice messages.
  const cacheOptOutIndexes = new Set<number>();
  const messages = convertMessages(model, context, compat, {
    cacheOptOutIndexes,
    preserveSystemPromptCacheBoundary: cacheControl !== undefined,
  });

  type ChatCompletionRequestParams = Omit<
    OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    "reasoning_effort"
  > & {
    reasoning_effort?: string;
    stream_options?: { include_usage: boolean };
    max_tokens?: number;
    prompt_cache_key?: string;
    prompt_cache_retention?: "24h";
    tool_stream?: boolean;
    enable_thinking?: boolean;
    chat_template_kwargs?: { enable_thinking: boolean; preserve_thinking: boolean };
    thinking?: { type: string };
    provider?: unknown;
    providerOptions?: unknown;
  };

  const supportsPromptCacheKey =
    model.baseUrl.includes("api.openai.com") || compat.supportsPromptCacheKey;
  const promptCacheKey =
    supportsPromptCacheKey && cacheRetention !== "none"
      ? clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId)
      : undefined;
  const params: ChatCompletionRequestParams = {
    model: model.id,
    messages,
    stream: true,
    prompt_cache_key: promptCacheKey,
    prompt_cache_retention:
      supportsPromptCacheKey && cacheRetention === "long" && compat.supportsLongCacheRetention
        ? "24h"
        : undefined,
  };

  if (compat.supportsUsageInStreaming) {
    params.stream_options = { include_usage: true };
  }

  if (compat.supportsStore) {
    params.store = false;
  }

  if (options?.maxTokens) {
    const maxTokens = clampOpenAICompletionsMaxTokens(model, options.maxTokens);
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = maxTokens;
    } else {
      params.max_completion_tokens = maxTokens;
    }
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop = options.stop;
  }

  let toolProjection: OpenAIToolProjection | undefined;
  if (context.tools) {
    const converted = convertTools(context.tools, compat);
    toolProjection = converted.projection;
    if (converted.tools.length > 0) {
      params.tools = converted.tools;
    } else if (hasToolHistory(context.messages)) {
      params.tools = [];
    }
    if (compat.zaiToolStream && converted.tools.length > 0) {
      params.tool_stream = true;
    }
  } else if (hasToolHistory(context.messages)) {
    // Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results
    params.tools = [];
  }

  if (cacheControl) {
    applyAnthropicCacheControl(messages, params.tools, cacheControl, cacheOptOutIndexes);
  }

  if (options?.toolChoice) {
    const toolChoice = reconcileOpenAICompletionsToolChoice(
      options.toolChoice,
      toolProjection ?? projectOpenAITools([]),
    );
    if (toolChoice !== undefined) {
      params.tool_choice = toolChoice;
    }
  }

  if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.enable_thinking = Boolean(options?.reasoningEffort);
  } else if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = Boolean(options?.reasoningEffort);
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
    params.chat_template_kwargs = {
      enable_thinking: Boolean(options?.reasoningEffort),
      preserve_thinking: true,
    };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    params.thinking = { type: options?.reasoningEffort ? "enabled" : "disabled" };
    if (options?.reasoningEffort && compat.supportsReasoningEffort) {
      params.reasoning_effort =
        model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
    // OpenRouter normalizes reasoning across providers via a nested reasoning object.
    const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
    if (options?.reasoningEffort) {
      openRouterParams.reasoning = {
        effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
      };
    } else if (model.thinkingLevelMap?.off !== null) {
      openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
    }
  } else if (compat.thinkingFormat === "together" && model.reasoning) {
    const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
      reasoning?: { enabled: boolean };
      reasoning_effort?: string;
    };
    togetherParams.reasoning = { enabled: Boolean(options?.reasoningEffort) };
    if (options?.reasoningEffort && compat.supportsReasoningEffort) {
      togetherParams.reasoning_effort =
        model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    }
  } else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    // OpenAI-style reasoning_effort
    params.reasoning_effort =
      model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
  } else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    const offValue = model.thinkingLevelMap?.off;
    if (typeof offValue === "string") {
      params.reasoning_effort = offValue;
    }
  }

  // OpenRouter provider routing preferences
  if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
    params.provider = model.compat.openRouterRouting;
  }

  // Vercel AI Gateway provider routing preferences
  if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
    const routing = model.compat.vercelGatewayRouting;
    if (routing.only || routing.order) {
      const gatewayOptions: Record<string, string[]> = {};
      if (routing.only) {
        gatewayOptions.only = routing.only;
      }
      if (routing.order) {
        gatewayOptions.order = routing.order;
      }
      params.providerOptions = { gateway: gatewayOptions };
    }
  }

  return params;
}

function clampOpenAICompletionsMaxTokens(
  model: Model<"openai-completions">,
  requestedMaxTokens: number,
): number {
  const modelMaxTokens =
    typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0
      ? Math.floor(model.maxTokens)
      : undefined;
  return modelMaxTokens === undefined || requestedMaxTokens <= modelMaxTokens
    ? requestedMaxTokens
    : modelMaxTokens;
}

function getCompatCacheControl(
  compat: ResolvedOpenAICompletionsCompat,
  cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
  if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
    return undefined;
  }

  const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
  return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

function applyAnthropicCacheControl(
  messages: ChatCompletionMessageParam[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  cacheControl: OpenAICompatCacheControl,
  cacheOptOutIndexes: ReadonlySet<number>,
): void {
  addCacheControlToSystemPrompt(messages, cacheControl);
  addCacheControlToLastTool(tools, cacheControl);
  addCacheControlToLastConversationMessage(messages, cacheControl, cacheOptOutIndexes);
}

function addCacheControlToSystemPrompt(
  messages: ChatCompletionMessageParam[],
  cacheControl: OpenAICompatCacheControl,
): void {
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      addCacheControlToInstructionMessage(message, cacheControl);
      return;
    }
  }
}

function addCacheControlToLastConversationMessage(
  messages: ChatCompletionMessageParam[],
  cacheControl: OpenAICompatCacheControl,
  cacheOptOutIndexes: ReadonlySet<number>,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (cacheOptOutIndexes.has(i)) {
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      if (addCacheControlToMessage(message, cacheControl)) {
        return;
      }
    }
  }
}

function addCacheControlToLastTool(
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  cacheControl: OpenAICompatCacheControl,
): void {
  if (!tools || tools.length === 0) {
    return;
  }

  const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
  lastTool.cache_control = cacheControl;
}

function addCacheControlToInstructionMessage(
  message: ChatCompletionInstructionMessageParam,
  cacheControl: OpenAICompatCacheControl,
): boolean {
  return addCacheControlToTextContent(message, cacheControl);
}

function addCacheControlToMessage(
  message: ChatCompletionMessageParam,
  cacheControl: OpenAICompatCacheControl,
): boolean {
  if (message.role === "user" || message.role === "assistant") {
    return addCacheControlToTextContent(message, cacheControl);
  }
  return false;
}

function addCacheControlToTextContent(
  message:
    | ChatCompletionInstructionMessageParam
    | ChatCompletionAssistantMessageParam
    | Extract<ChatCompletionMessageParam, { role: "user" }>,
  cacheControl: OpenAICompatCacheControl,
): boolean {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length === 0) {
      return false;
    }
    message.content = buildCacheControlledTextParts(content, cacheControl);
    return true;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part?.type === "text") {
      const text = (part as ChatCompletionTextPartWithCacheControl).text;
      content.splice(i, 1, ...buildCacheControlledTextParts(text, cacheControl));
      return true;
    }
  }

  return false;
}

function buildCacheControlledTextParts(
  text: string,
  cacheControl: OpenAICompatCacheControl,
): ChatCompletionTextPartWithCacheControl[] {
  const split = splitSystemPromptCacheBoundary(text);
  if (!split) {
    return [{ type: "text", text, cache_control: cacheControl }];
  }

  const parts: ChatCompletionTextPartWithCacheControl[] = [];
  if (split.stablePrefix) {
    parts.push({
      type: "text",
      text: split.stablePrefix,
      cache_control: cacheControl,
    });
  }
  if (split.dynamicSuffix) {
    parts.push({ type: "text", text: split.dynamicSuffix });
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

export function convertMessages(
  model: Model<"openai-completions">,
  context: Context,
  compat: ResolvedOpenAICompletionsCompat,
  options: {
    cacheOptOutIndexes?: Set<number>;
    preserveSystemPromptCacheBoundary?: boolean;
  } = {},
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  const normalizeToolCallId = (id: string): string => {
    // Handle pipe-separated IDs from OpenAI Responses API
    // Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
    // These come from providers like github-copilot, openai, opencode
    // Extract just the call_id part and normalize it
    if (id.includes("|")) {
      const [callId] = id.split("|");
      // Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
      return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    }

    if (model.provider === "openai") {
      return id.length > 40 ? id.slice(0, 40) : id;
    }
    return id;
  };

  const transformedMessages = transformMessages(context.messages, model, (id) =>
    normalizeToolCallId(id),
  );

  if (context.systemPrompt) {
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
    const role = useDeveloperRole ? "developer" : "system";
    const systemPrompt = options.preserveSystemPromptCacheBoundary
      ? context.systemPrompt
      : stripSystemPromptCacheBoundary(context.systemPrompt);
    params.push({
      role,
      content: sanitizeSurrogates(systemPrompt),
    });
  }

  let lastRole: string | null = null;

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    // Some providers don't allow user messages directly after tool results
    // Insert a synthetic assistant message to bridge the gap
    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      msg.role === "user"
    ) {
      params.push({
        role: "assistant",
        content: "I have processed the tool results.",
      });
    }

    if (msg.role === "user") {
      const isRuntimeContextCarrier = msg.runtimeContextCarrier === true;
      if (typeof msg.content === "string") {
        const userParam: ChatCompletionMessageParam = {
          role: "user",
          content: sanitizeSurrogates(msg.content),
        };
        if (isRuntimeContextCarrier) {
          options.cacheOptOutIndexes?.add(params.length);
        }
        params.push(userParam);
      } else {
        const content: ChatCompletionContentPart[] = msg.content.map(
          (item): ChatCompletionContentPart => {
            if (item.type === "text") {
              return {
                type: "text",
                text: sanitizeSurrogates(item.text),
              } satisfies ChatCompletionContentPartText;
            }
            return {
              type: "image_url",
              image_url: {
                url: `data:${item.mimeType};base64,${item.data}`,
              },
            } satisfies ChatCompletionContentPartImage;
          },
        );
        if (content.length === 0) {
          continue;
        }
        const userParam: ChatCompletionMessageParam = {
          role: "user",
          content,
        };
        if (isRuntimeContextCarrier) {
          options.cacheOptOutIndexes?.add(params.length);
        }
        params.push(userParam);
      }
    } else if (msg.role === "assistant") {
      // Some providers don't accept null content, use empty string instead
      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };

      const assistantTextParts = msg.content
        .filter(isTextContentBlock)
        .filter((block) => block.text.trim().length > 0)
        .map(
          (block) =>
            ({
              type: "text",
              text: sanitizeSurrogates(block.text),
            }) satisfies ChatCompletionContentPartText,
        );
      const assistantText = assistantTextParts.map((part) => part.text).join("");

      const nonEmptyThinkingBlocks = msg.content
        .filter(isThinkingContentBlock)
        .filter((block) => block.thinking.trim().length > 0);
      if (nonEmptyThinkingBlocks.length > 0) {
        if (compat.requiresThinkingAsText) {
          // Convert thinking blocks to plain text (no tags to avoid model mimicking them)
          const thinkingText = nonEmptyThinkingBlocks
            .map((block) => sanitizeSurrogates(block.thinking))
            .join("\n\n");
          assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
        } else {
          // Always send assistant content as a plain string (OpenAI Chat Completions
          // API standard format). Sending as an array of {type:"text", text:"..."}
          // objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
          // NVIDIA NIM) to mirror the content-block structure literally in their
          // output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
          if (assistantText.length > 0) {
            assistantMsg.content = assistantText;
          }

          // Use the signature from the first thinking block if available (for llama.cpp server + gpt-oss)
          let signature = nonEmptyThinkingBlocks[0].thinkingSignature;
          if (model.provider === "opencode-go" && signature === "reasoning") {
            signature = "reasoning_content";
          }
          if (signature && signature.length > 0) {
            (assistantMsg as typeof assistantMsg & Record<string, unknown>)[signature] =
              nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
          }
        }
      } else if (assistantText.length > 0) {
        // Always send assistant content as a plain string (OpenAI Chat Completions
        // API standard format). Sending as an array of {type:"text", text:"..."}
        // objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
        // NVIDIA NIM) to mirror the content-block structure literally in their
        // output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
        assistantMsg.content = assistantText;
      }

      const toolCalls = msg.content.filter(isToolCallBlock);
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
        const reasoningDetails = toolCalls
          .filter((tc) => tc.thoughtSignature)
          .map((tc) => {
            try {
              return JSON.parse(tc.thoughtSignature!);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (reasoningDetails.length > 0) {
          (
            assistantMsg as typeof assistantMsg & { reasoning_details?: unknown }
          ).reasoning_details = reasoningDetails;
        }
      }
      if (
        compat.requiresReasoningContentOnAssistantMessages &&
        model.reasoning &&
        (assistantMsg as { reasoning_content?: string }).reasoning_content === undefined
      ) {
        (assistantMsg as { reasoning_content?: string }).reasoning_content = "";
      }
      // Skip assistant messages that have no content and no tool calls.
      // Some providers require "either content or tool_calls, but not none".
      // Other providers also don't accept empty assistant messages.
      // This handles aborted assistant responses that got no content.
      const content = assistantMsg.content;
      const hasContent =
        content !== null &&
        content !== undefined &&
        (typeof content === "string" ? content.length > 0 : content.length > 0);
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      let j = i;

      for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
        const toolMsg = transformedMessages[j] as ToolResultMessage;

        // Extract text and image content
        const textResult = extractToolResultText(toolMsg.content);
        const mediaPlaceholder = describeToolResultMediaPlaceholder(toolMsg.content);
        const hasImages = toolMsg.content.some((c) => c.type === "image");

        // Always send tool result with text (or placeholder if only images)
        const content = sanitizeToolResultText(
          textResult,
          mediaPlaceholder ?? EMPTY_TOOL_RESULT_TEXT,
        );
        // Some providers require the 'name' field in tool results
        const toolResultMsg: ChatCompletionToolMessageParam = {
          role: "tool",
          content,
          tool_call_id: toolMsg.toolCallId,
        };
        if (compat.requiresToolResultName && toolMsg.toolName) {
          (toolResultMsg as typeof toolResultMsg & { name?: string }).name = toolMsg.toolName;
        }
        params.push(toolResultMsg);

        if (hasImages && model.input.includes("image")) {
          for (const block of toolMsg.content) {
            if (isImageContentBlock(block)) {
              imageBlocks.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.mimeType};base64,${block.data}`,
                },
              });
            }
          }
        }
      }

      i = j - 1;

      if (imageBlocks.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          params.push({
            role: "assistant",
            content: "I have processed the tool results.",
          });
        }

        params.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Attached image(s) from tool result:",
            },
            ...imageBlocks,
          ],
        });
        lastRole = "user";
      } else {
        lastRole = "toolResult";
      }
      continue;
    }

    lastRole = msg.role;
  }

  return params;
}

function convertTools(
  tools: Tool[],
  compat: ResolvedOpenAICompletionsCompat,
): {
  projection: OpenAIToolProjection;
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
} {
  const projection = projectOpenAITools(tools);
  return {
    projection,
    tools: projection.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        // Only include strict if provider supports it. Some reject unknown fields.
        ...(compat.supportsStrictMode && { strict: false }),
      },
    })),
  };
}

function parseChunkUsage(
  rawUsage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  },
  model: Model<"openai-completions">,
): AssistantMessage["usage"] {
  const promptTokens = rawUsage.prompt_tokens || 0;
  const cacheReadTokens =
    rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
  const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

  // Follow documented OpenAI/OpenRouter semantics: cached_tokens is cache-read
  // tokens (hits). OpenAI does not document or emit cache_write_tokens, but
  // OpenRouter-compatible providers can include it as a separate write count.
  // OpenRouter's own provider/tests affirm the separate mapping:
  // https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409
  // Do not subtract writes from cached_tokens, otherwise spec-compliant
  // providers are under-reported. DS4 mirrors this contract too:
  // https://github.com/antirez/ds4/pull/29
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  // OpenAI completion_tokens already includes reasoning_tokens.
  const outputTokens = rawUsage.completion_tokens || 0;
  const usage: AssistantMessage["usage"] = {
    input,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 * Returns a fully resolved OpenAICompletionsCompat object with all fields set.
 */
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
  const provider = model.provider;
  const baseUrl = model.baseUrl;

  const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
  const isTogether =
    provider === "together" ||
    baseUrl.includes("api.together.ai") ||
    baseUrl.includes("api.together.xyz");
  const isMoonshot =
    provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
  const isCloudflareWorkersAI =
    provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
  const isCloudflareAiGateway =
    provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");

  const isNonStandard =
    provider === "cerebras" ||
    baseUrl.includes("cerebras.ai") ||
    provider === "xai" ||
    baseUrl.includes("api.x.ai") ||
    isTogether ||
    baseUrl.includes("chutes.ai") ||
    baseUrl.includes("deepseek.com") ||
    isZai ||
    isMoonshot ||
    provider === "opencode" ||
    baseUrl.includes("opencode.ai") ||
    isCloudflareWorkersAI ||
    isCloudflareAiGateway;

  const useMaxTokens =
    baseUrl.includes("chutes.ai") || isMoonshot || isCloudflareAiGateway || isTogether;

  const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
  const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com");
  const isXiaomi = provider === "xiaomi" || baseUrl.includes("xiaomimimo.com");
  const cacheControlFormat =
    provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;

  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort:
      !isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway,
    supportsUsageInStreaming: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: isDeepSeek || isXiaomi,
    thinkingFormat: isDeepSeek
      ? "deepseek"
      : isXiaomi
        ? "deepseek"
        : isZai
          ? "zai"
          : isTogether
            ? "together"
            : provider === "openrouter" || baseUrl.includes("openrouter.ai")
              ? "openrouter"
              : "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    zaiToolStream: false,
    supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway,
    cacheControlFormat,
    sendSessionAffinityHeaders: false,
    supportsPromptCacheKey: false,
    supportsLongCacheRetention: !(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway),
  };
}

/**
 * Get resolved compatibility settings for a model.
 * Uses explicit model.compat if provided, otherwise auto-detects from provider/URL.
 */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
  const detected = detectCompat(model);
  if (!model.compat) {
    return detected;
  }

  return {
    supportsStore: model.compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort:
      model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    supportsUsageInStreaming:
      model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    requiresReasoningContentOnAssistantMessages:
      model.compat.requiresReasoningContentOnAssistantMessages ??
      detected.requiresReasoningContentOnAssistantMessages,
    thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting: model.compat.openRouterRouting ?? {},
    vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
    zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
    supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
    cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
    sendSessionAffinityHeaders:
      model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
    supportsPromptCacheKey: model.compat.supportsPromptCacheKey ?? detected.supportsPromptCacheKey,
    supportsLongCacheRetention:
      model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
  };
}
