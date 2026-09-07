// OpenAI completions provider adapts chat completions to the agent runtime.
import type OpenAI from "openai";
import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel } from "../model-utils.js";
import { reasoningTagTextPolicy, type OpenAICompletionsOptions } from "../provider-options.js";
// OpenAI completions provider adapts chat completions to the agent runtime.
import { createAssistantOutput } from "../transports/assistant-output.js";
import {
  resolveOpenAICompletionsCompat,
  type ResolvedOpenAICompletionsCompat,
} from "../transports/openai-completions-compat.js";
import { buildOpenAICompletionsRequest } from "../transports/openai-completions-params.js";
import { processCompletionsStream } from "../transports/openai-completions-stream.js";
import {
  createOpenAIProviderAcceptanceHook,
  isOpenAICompletionsThinkingEnabled,
} from "../transports/openai-transport-shared.js";
import { resolveOpencodeSessionHeaders } from "../transports/session-affinity.js";
import {
  assignTransportErrorDetails,
  transportAbortError,
  withProviderResponseHook,
} from "../transports/transport-stream-shared.js";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "../types.js";
import {
  clearPendingCommentaryText,
  tagUnresolvedTextAsCommentary,
  type PendingCommentaryTags,
} from "../utils/assistant-text-phase.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../utils/stream-first-event-timeout.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { finalizeOpenAICompletionsToolCalls } from "./openai-completions-tool-calls.js";
import { createOpenAIProviderClient } from "./openai-provider-client.js";
import { buildBaseOptions } from "./simple-options.js";

export type { OpenAICompletionsOptions } from "../provider-options.js";
export { convertMessages } from "../openai-completions-messages.js";

export const streamOpenAICompletions: StreamFunction<
  "openai-completions",
  OpenAICompletionsOptions
> = (model: Model<"openai-completions">, context: Context, options?: OpenAICompletionsOptions) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const output = createAssistantOutput(model);
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
      const client = createClient(
        model,
        context,
        apiKey,
        resolveOpencodeSessionHeaders(model, options),
        cacheSessionId,
        compat,
      );
      let params = buildOpenAICompletionsRequest(model, context, options, {
        mode: "direct",
        compat,
        cacheRetention,
      });
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

  return createOpenAIProviderClient(model, apiKey, headers, optionsHeaders);
}
