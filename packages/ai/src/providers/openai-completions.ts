// OpenAI completions provider adapts chat completions to the agent runtime.
import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPartText,
  ChatCompletionDeveloperMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
} from "openai/resources/chat/completions.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import {
  applyProviderReportedUsageCost,
  calculateCost,
  clampThinkingLevel,
} from "../model-utils.js";
import { convertMessages } from "../openai-completions-messages.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import {
  resolveOpenAICompletionsCompat,
  type ResolvedOpenAICompletionsCompat,
} from "../transports/openai-completions-compat.js";
import { resolveOpenAIReasoningEffortMap } from "../transports/openai-reasoning-compat.js";
import { transportAbortError } from "../transports/transport-stream-shared.js";
import type {
  AssistantMessage,
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
import {
  clearPendingCommentaryText,
  rememberPendingCommentaryTags,
  tagPendingCommentaryText,
  type PendingCommentaryTags,
} from "../utils/assistant-text-phase.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { formatProviderError } from "../utils/provider-error.js";
import { createReasoningTagTextPartitioner } from "../utils/reasoning-tag-text-partitioner.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  withFirstStreamEventTimeout,
} from "../utils/stream-first-event-timeout.js";
import { splitSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import {
  resolveOpenAICompletionsResponseFormat,
  shouldOmitOllamaCompatResponseFormat,
} from "./openai-response-format.js";
import { mapOpenAIStopReason } from "./openai-stop-reason.js";
import {
  projectOpenAITools,
  reconcileOpenAICompletionsToolChoice,
  type OpenAIToolProjection,
} from "./openai-tool-projection.js";
import { buildBaseOptions } from "./simple-options.js";

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

export type { OpenAICompletionsOptions } from "../provider-options.js";
export { convertMessages } from "../openai-completions-messages.js";

interface OpenAICompatCacheControl {
  type: "ephemeral";
  ttl?: string;
}

type EncryptedReasoningDetail = {
  type: "reasoning.encrypted";
  id: string;
  data: string;
};

function isEncryptedReasoningDetail(detail: unknown): detail is EncryptedReasoningDetail {
  if (typeof detail !== "object" || detail === null) {
    return false;
  }
  const candidate = detail as Record<string, unknown>;
  return (
    candidate.type === "reasoning.encrypted" &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.data === "string" &&
    candidate.data.length > 0
  );
}

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
    const provisionalCommentaryTags: PendingCommentaryTags = new Map();

    let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
    try {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const compat = resolveOpenAICompletionsCompat(model);
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
        maxRetries: options?.maxRetries ?? 0,
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
      const pendingReasoningDetailsByToolCallId = new Map<string, string>();
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
        if (toolCallBlocksByFirstId.has(id)) {
          return;
        }
        toolCallBlocksByFirstId.set(id, block);
        // Some gateways emit encrypted reasoning before the referenced call.
        // Attach it once the first matching block exists so replay stays intact.
        const pendingDetail = pendingReasoningDetailsByToolCallId.get(id);
        if (pendingDetail) {
          block.thoughtSignature = pendingDetail;
          pendingReasoningDetailsByToolCallId.delete(id);
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

        // Some OpenAI-compatible endpoints deliver a full `message` instead of
        // `delta` (including refusal-only turns with content: null). Normalize
        // the same way the managed agent transport does.
        const choiceDelta =
          choice.delta ??
          (choice as { message?: ChatCompletionChunk["choices"][number]["delta"] }).message;
        if (choiceDelta) {
          // Some endpoints return reasoning in reasoning_content (llama.cpp),
          // or reasoning (other openai compatible endpoints)
          // Use the first non-empty reasoning field to avoid duplication
          // (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
          const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
          const deltaFields = choiceDelta as Record<string, unknown>;
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
            choiceDelta.content !== null &&
            choiceDelta.content !== undefined &&
            choiceDelta.content.length > 0
          ) {
            appendPartitionedContent(choiceDelta.content, Boolean(foundReasoningField));
          }

          // Chat Completions can put safety/structured-output refusals in a
          // top-level `refusal` field with content null. Surface that as
          // visible text so the assistant turn is not empty.
          const refusalText = typeof choiceDelta.refusal === "string" ? choiceDelta.refusal : "";
          if (refusalText.length > 0) {
            appendPartitionedContent(refusalText, Boolean(foundReasoningField));
          }

          if (choiceDelta.tool_calls && choiceDelta.tool_calls.length > 0) {
            flushPartitionedContent();
            // The tool-call lane is also a reasoning boundary; seal the thought
            // before toolcall_start so thinking_end never trails the action.
            sealNativeReasoningBeforeText();
            rememberPendingCommentaryTags(
              provisionalCommentaryTags,
              tagPendingCommentaryText(output.content),
            );
            for (const toolCall of choiceDelta.tool_calls) {
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

          const reasoningDetails = (choiceDelta as { reasoning_details?: unknown })
            .reasoning_details;
          if (Array.isArray(reasoningDetails)) {
            for (const detail of reasoningDetails) {
              if (isEncryptedReasoningDetail(detail)) {
                const serializedDetail = JSON.stringify(detail);
                const matchingToolCall = toolCallBlocksByFirstId.get(detail.id);
                if (matchingToolCall) {
                  matchingToolCall.thoughtSignature = serializedDetail;
                } else {
                  pendingReasoningDetailsByToolCallId.set(detail.id, serializedDetail);
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
        throw transportAbortError(options.signal);
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
      if (output.stopReason !== "toolUse") {
        clearPendingCommentaryText(provisionalCommentaryTags);
      }
      if (output.stopReason === "toolUse") {
        tagPendingCommentaryText(output.content);
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
      output.errorMessage = formatProviderError(error);
      // Some providers via OpenRouter give additional information in this field.
      const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata
        ?.raw;
      if (rawMetadata && !output.errorMessage.includes(rawMetadata)) {
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
  compat: ResolvedOpenAICompletionsCompat = resolveOpenAICompletionsCompat(model),
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

  if (sessionId && compat.sessionAffinity !== "none") {
    if (compat.sessionAffinity === "openrouter") {
      headers["x-session-id"] = sessionId;
    } else {
      headers.session_id = sessionId;
      headers["x-client-request-id"] = sessionId;
      headers["x-session-affinity"] = sessionId;
    }
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
    // OpenAI supports custom fetch, so sentinels stay opaque until guarded egress.
    fetch: getAiTransportHost().buildModelFetch(model),
  });
}

function buildParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
  compat: ResolvedOpenAICompletionsCompat = resolveOpenAICompletionsCompat(model),
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
    "reasoning_effort" | "response_format"
  > & {
    reasoning_effort?: string;
    response_format?: Record<string, unknown>;
    stream_options?: { include_usage: boolean };
    max_tokens?: number;
    prompt_cache_key?: string;
    prompt_cache_retention?: "24h";
    tool_stream?: boolean;
    enable_thinking?: boolean;
    chat_template_kwargs?: { enable_thinking: boolean; preserve_thinking: boolean };
    thinking?: { type: string; clear_thinking?: boolean };
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

  const requestedResponseFormat = options?.responseFormat;
  const responseFormat =
    requestedResponseFormat === undefined
      ? undefined
      : resolveOpenAICompletionsResponseFormat(
          shouldOmitOllamaCompatResponseFormat({
            provider: model.provider,
            baseUrl: model.baseUrl,
            hasTools: () => Boolean(context.tools?.length),
          })
            ? undefined
            : requestedResponseFormat,
          compat.supportsJsonSchemaResponseFormat,
        );
  if (responseFormat !== undefined) {
    params.response_format = responseFormat;
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

  // Provider compat is authoritative; keep model-level and literal values as fallbacks
  // for catalogs that have not adopted reasoningEffortMap.
  const reasoningEffortMap = resolveOpenAIReasoningEffortMap(model);
  const thinkingLevelMap = model.thinkingLevelMap as
    | Partial<Record<NonNullable<OpenAICompletionsOptions["reasoningEffort"]>, string | null>>
    | undefined;
  const reasoningEffort =
    options?.reasoningEffort === undefined
      ? undefined
      : (reasoningEffortMap[options.reasoningEffort] ??
        thinkingLevelMap?.[options.reasoningEffort] ??
        options.reasoningEffort);
  const reasoningEnabled = reasoningEffort !== undefined && reasoningEffort !== "none";
  const offReasoningEffort = reasoningEffortMap.off ?? model.thinkingLevelMap?.off;

  if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.thinking = reasoningEnabled
      ? { type: "enabled", clear_thinking: false }
      : { type: "disabled" };
  } else if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = reasoningEnabled;
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
    params.chat_template_kwargs = {
      enable_thinking: reasoningEnabled,
      preserve_thinking: true,
    };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    params.thinking = { type: reasoningEnabled ? "enabled" : "disabled" };
    if (reasoningEnabled && compat.supportsReasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
    // OpenRouter normalizes reasoning across providers via a nested reasoning object.
    const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
    if (reasoningEnabled) {
      openRouterParams.reasoning = { effort: reasoningEffort };
    } else if (offReasoningEffort !== null) {
      openRouterParams.reasoning = { effort: offReasoningEffort ?? "none" };
    }
  } else if (compat.thinkingFormat === "together" && model.reasoning) {
    const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
      reasoning?: { enabled: boolean };
      reasoning_effort?: string;
    };
    togetherParams.reasoning = { enabled: reasoningEnabled };
    if (reasoningEnabled && compat.supportsReasoningEffort) {
      togetherParams.reasoning_effort = reasoningEffort;
    }
  } else if (reasoningEnabled && model.reasoning && compat.supportsReasoningEffort) {
    // OpenAI-style reasoning_effort
    params.reasoning_effort = reasoningEffort;
  } else if (model.reasoning && compat.supportsReasoningEffort) {
    if (typeof offReasoningEffort === "string") {
      params.reasoning_effort = offReasoningEffort;
    }
  }

  // OpenRouter provider routing preferences
  if (compat.openRouterRouting) {
    params.provider = compat.openRouterRouting;
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
    if (!message || cacheOptOutIndexes.has(i)) {
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

  const lastTool: ChatCompletionToolWithCacheControl | undefined = tools.at(-1);
  if (!lastTool) {
    return;
  }
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
    cost?: unknown;
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
  applyProviderReportedUsageCost(usage, rawUsage.cost);
  return usage;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
