// OpenAI completions provider adapts chat completions to the agent runtime.
import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPartText,
  ChatCompletionDeveloperMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
} from "openai/resources/chat/completions.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { clampThinkingLevel } from "../model-utils.js";
import { convertMessages, hasToolCallHistory } from "../openai-completions-messages.js";
import { reasoningTagTextPolicy, type OpenAICompletionsOptions } from "../provider-options.js";
import {
  resolveOpenAICompletionsCompat,
  type ResolvedOpenAICompletionsCompat,
} from "../transports/openai-completions-compat.js";
import { processCompletionsStream } from "../transports/openai-completions-stream.js";
import { resolveOpenAIReasoningEffortMap } from "../transports/openai-reasoning-compat.js";
import {
  createOpenAIProviderAcceptanceHook,
  isOpenAICompletionsThinkingEnabled,
  resolveOpenAIClientBaseUrl,
} from "../transports/openai-transport-shared.js";
import {
  assignTransportErrorDetails,
  transportAbortError,
  withProviderResponseHook,
} from "../transports/transport-stream-shared.js";
import type {
  AssistantMessage,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  Tool,
} from "../types.js";
import {
  clearPendingCommentaryText,
  tagUnresolvedTextAsCommentary,
  type PendingCommentaryTags,
} from "../utils/assistant-text-phase.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sortPromptCacheToolsByName } from "../utils/prompt-cache-stability.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../utils/stream-first-event-timeout.js";
import { splitSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { finalizeOpenAICompletionsToolCalls } from "./openai-completions-tool-calls.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import {
  resolveOpenAICompletionsResponseFormat,
  shouldOmitOllamaCompatResponseFormat,
} from "./openai-response-format.js";
import {
  projectOpenAITools,
  reconcileOpenAICompletionsToolChoice,
  type OpenAIToolProjection,
} from "./openai-tool-projection.js";
import { buildBaseOptions } from "./simple-options.js";

export type { OpenAICompletionsOptions } from "../provider-options.js";
export { convertMessages } from "../openai-completions-messages.js";

interface OpenAICompatCacheControl {
  type: "ephemeral";
  ttl?: string;
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
      const shouldEmitReasoning = Boolean(
        model.reasoning &&
        options?.reasoningEffort &&
        isOpenAICompletionsThinkingEnabled(options.reasoningEffort),
      );
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
        maxRetries: 0,
      };
      const { data: openaiStream, response } = await client.chat.completions
        .create(
          params as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          requestOptions,
        )
        .withResponse();
      const hookedOpenAIStream = withProviderResponseHook({
        stream: openaiStream,
        signal: firstEventAbort.signal,
        abort: firstEventAbort.abort,
        hook: createOpenAIProviderAcceptanceHook(options, response, model),
        onReady: () => stream.push({ type: "start", partial: output }),
      });

      type StreamingBlock = AssistantMessage["content"][number];
      const finishedBlocks = new Set<StreamingBlock>();
      const contentIndices = new WeakMap<StreamingBlock, number>();
      let openTextBlock: StreamingBlock | undefined;
      let openThinkingBlock: StreamingBlock | undefined;
      const finishBlock = (block: StreamingBlock) => {
        const contentIndex = contentIndices.get(block);
        if (contentIndex === undefined || finishedBlocks.has(block)) {
          return;
        }
        finishedBlocks.add(block);
        if (block.type === "text") {
          openTextBlock = undefined;
          stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
        } else if (block.type === "thinking") {
          openThinkingBlock = undefined;
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: block.thinking,
            partial: output,
          });
        } else if (block.type === "toolCall") {
          stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
        }
      };
      const directEventStream = {
        push(event: Parameters<typeof stream.push>[0]) {
          if (
            event.type === "text_start" ||
            event.type === "thinking_start" ||
            event.type === "toolcall_start"
          ) {
            const block = output.content[event.contentIndex];
            if (block) {
              contentIndices.set(block, event.contentIndex);
              if (block.type === "text") {
                openTextBlock = block;
              } else if (block.type === "thinking") {
                openThinkingBlock = block;
              }
            }
          }
          stream.push(event);
        },
      };
      try {
        await processCompletionsStream(hookedOpenAIStream, output, model, directEventStream, {
          mode: "direct",
          beforeContentBlock(nextType) {
            if (openThinkingBlock) {
              finishBlock(openThinkingBlock);
            }
            if (openTextBlock && nextType !== "toolCall") {
              finishBlock(openTextBlock);
            }
          },
          provisionalCommentaryTags,
          signal: options?.signal,
          emitReasoning: shouldEmitReasoning,
          strictReasoningTags: reasoningTagTextPolicy.isStrict(options),
          firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
          abortFirstEventStream: firstEventAbort.abort,
          onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
        });
        if (options?.signal?.aborted) {
          throw transportAbortError(options.signal);
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error(
            output.errorMessage ||
              (output.stopReason === "aborted"
                ? "Request was aborted"
                : "Provider returned an invalid tool call"),
          );
        }
      } catch (error) {
        for (const block of output.content) {
          if (block.type !== "toolCall") {
            finishBlock(block);
          }
        }
        throw error;
      }
      for (const block of output.content) {
        if (block.type !== "toolCall" || output.stopReason === "toolUse") {
          finishBlock(block);
        }
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      const terminal = assignTransportErrorDetails(output, error, options?.signal);
      finalizeOpenAICompletionsToolCalls(output, { allowSilentToolCallPromotion: false });
      clearPendingCommentaryText(provisionalCommentaryTags);
      tagUnresolvedTextAsCommentary(output);
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // Streaming scratch buffers are only used during parsing; never persist them.
        delete (block as { partialArgs?: string }).partialArgs;
        delete (block as { streamIndex?: number }).streamIndex;
      }
      stream.push({ type: "error", reason: terminal.stopReason, error: output });
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

  const baseUrl = isCloudflareProvider(model.provider)
    ? resolveCloudflareBaseUrl(model)
    : model.baseUrl;
  return new OpenAI({
    apiKey,
    baseURL: resolveOpenAIClientBaseUrl(model, baseUrl),
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    maxRetries: 0,
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
    } else if (hasToolCallHistory(context.messages)) {
      params.tools = [];
    }
    if (compat.zaiToolStream && converted.tools.length > 0) {
      params.tool_stream = true;
    }
  } else if (hasToolCallHistory(context.messages)) {
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
    tools: sortPromptCacheToolsByName(projection.tools).map((tool) => ({
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
