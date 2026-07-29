// OpenAI Responses shared helpers map runtime messages, tools, and stream events.
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputItem,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputText,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../model-utils.js";
import { processResponsesStream } from "../transports/openai-responses-stream-internal.js";
import { transportAbortError } from "../transports/transport-stream-shared.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
  TextSignatureV1,
  Usage,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { shortHash } from "../utils/hash.js";
import { headersToRecord } from "../utils/headers.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  type FirstStreamEventInternalOptions,
} from "../utils/stream-first-event-timeout.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  resolveOpenAIReasoningEffortForModel,
  supportsOpenAIReasoningEffort,
  supportsOpenAITemperature,
} from "./openai-reasoning-effort.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  isImageWithMediaPayload,
} from "./tool-result-text.js";
import { transformMessages } from "./transform-messages.js";

// =============================================================================
// Utilities
// =============================================================================

const EMPTY_TOOL_RESULT_TEXT = "(no output)";

// itemId is undefined when the id has no separator so replay paths keep
// omitting the optional item id instead of serializing an empty string.
function splitResponsesToolCallId(id: string): [callId: string, itemId: string | undefined] {
  const separatorIndex = id.indexOf("|");
  return separatorIndex === -1
    ? [id, undefined]
    : [id.slice(0, separatorIndex), id.slice(separatorIndex + 1)];
}

function sanitizeToolResultText(text: string, fallback: string): string {
  const sanitized = sanitizeSurrogates(text);
  return sanitized.trim().length > 0 ? sanitized : fallback;
}

type ReplayableResponseOutputMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };
type ReplayableResponseReasoningItem = Omit<ResponseReasoningItem, "id"> & { id?: string };
function normalizeResponsesReasoningReplayItem(params: {
  item: ReplayableResponseReasoningItem;
  replayResponsesItemIds: boolean;
}): ReplayableResponseReasoningItem {
  const next = { ...(params.item as ReplayableResponseReasoningItem & Record<string, unknown>) };
  if (!Array.isArray(next.summary)) {
    next.summary = [];
  }
  if (!params.replayResponsesItemIds) {
    delete next.id;
  }
  return next as ReplayableResponseReasoningItem;
}

function parseTextSignature(
  signature: string | undefined,
): { id?: string; phase?: TextSignatureV1["phase"] } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
      if (parsed.v === 1) {
        const id = typeof parsed.id === "string" ? parsed.id : undefined;
        const phase =
          parsed.phase === "commentary" || parsed.phase === "final_answer"
            ? parsed.phase
            : undefined;
        // A reasoning-dropped replay keeps the phase but omits the paired id.
        if (id !== undefined || phase !== undefined) {
          return { id, phase };
        }
        return undefined;
      }
    } catch {
      // Fall through to legacy plain-string handling.
    }
  }
  return { id: signature };
}

function resolveReplayableResponsesMessageId(params: {
  textSignatureId?: string;
  fallbackId: string;
  fallbackOrdinal: number;
  previousReplayItemWasReasoning: boolean;
}): string | undefined {
  if (!params.textSignatureId) {
    return params.fallbackOrdinal === 0
      ? params.fallbackId
      : `${params.fallbackId}_${params.fallbackOrdinal}`;
  }
  return params.previousReplayItemWasReasoning ? params.textSignatureId : undefined;
}

interface OpenAIResponsesStreamOptions {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  resolveServiceTier?: (
    responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => ResponseCreateParamsStreaming["service_tier"] | undefined;
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
}

interface ConvertResponsesMessagesOptions {
  includeSystemPrompt?: boolean;
  replayResponsesItemIds?: boolean;
}
export { convertResponsesToolPayload };

type ResponsesRequestOptions = {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
};

type ResponsesStreamRequest = {
  withResponse(): Promise<{
    data: AsyncIterable<ResponseStreamEvent>;
    response: Response;
  }>;
};

type ResponsesStreamClient = {
  responses: {
    create(
      params: ResponseCreateParamsStreaming,
      options: ResponsesRequestOptions,
    ): ResponsesStreamRequest;
  };
};

type ResponsesLifecycleStreamOptions = Pick<
  StreamOptions,
  "signal" | "timeoutMs" | "maxRetries" | "onPayload" | "onResponse"
> &
  FirstStreamEventInternalOptions;

type OpenAIResponsesProcessStreamOptions = OpenAIResponsesStreamOptions &
  FirstStreamEventInternalOptions & { signal?: AbortSignal };

type ResponsesReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function isResponsesReasoningEffort(
  effort: string | undefined,
): effort is ResponsesReasoningEffort {
  return (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  );
}
type ResponsesReasoningSummary = "auto" | "detailed" | "concise" | null;

type ResponsesCommonParamsOptions = Pick<StreamOptions, "maxTokens" | "temperature"> & {
  reasoningEffort?: ResponsesReasoningEffort;
  reasoningSummary?: ResponsesReasoningSummary;
};

// =============================================================================
// Message conversion
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): ResponseInput {
  const messages: ResponseInput = [];
  const shouldReplayResponsesItemIds = options?.replayResponsesItemIds ?? true;

  const normalizeIdPart = (part: string): string => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };

  const buildForeignResponsesItemId = (itemId: string): string => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };

  const normalizeToolCallId = (
    id: string,
    targetModel: Model<TApi>,
    source: AssistantMessage,
  ): string => {
    void targetModel;
    if (!allowedToolCallProviders.has(model.provider)) {
      return normalizeIdPart(id);
    }
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    // The includes("|") guard above guarantees the item id component exists.
    const [callId, itemId = ""] = splitResponsesToolCallId(id);
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : normalizeIdPart(itemId);
    // OpenAI Responses API requires item id to start with "fc"
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
    const role =
      model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
    messages.push({
      type: "message",
      role,
      content: [
        {
          type: "input_text",
          text: sanitizeSurrogates(stripSystemPromptCacheBoundary(context.systemPrompt)),
        },
      ],
    });
  }

  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
        });
      } else {
        const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
          if (item.type === "text") {
            return {
              type: "input_text",
              text: sanitizeSurrogates(item.text),
            } satisfies ResponseInputText;
          }
          return {
            type: "input_image",
            detail: "auto",
            image_url: `data:${item.mimeType};base64,${item.data}`,
          } satisfies ResponseInputImage;
        });
        if (content.length === 0) {
          continue;
        }
        messages.push({
          type: "message",
          role: "user",
          content,
        });
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      let textFallbackOrdinal = 0;
      const assistantMsg = msg;
      let previousReplayItemWasReasoning = false;
      const isDifferentModel =
        assistantMsg.model !== model.id &&
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api;

      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            const reasoningItem = normalizeResponsesReasoningReplayItem({
              item: JSON.parse(block.thinkingSignature) as ReplayableResponseReasoningItem,
              replayResponsesItemIds: shouldReplayResponsesItemIds,
            });
            output.push(reasoningItem as ResponseInputItem);
            previousReplayItemWasReasoning = true;
          }
        } else if (block.type === "text") {
          const textBlock = block;
          const parsedSignature = parseTextSignature(textBlock.textSignature);
          let msgId = shouldReplayResponsesItemIds
            ? resolveReplayableResponsesMessageId({
                textSignatureId: parsedSignature?.id,
                fallbackId: `msg_${msgIndex}`,
                fallbackOrdinal: textFallbackOrdinal,
                previousReplayItemWasReasoning,
              })
            : undefined;
          if (!parsedSignature?.id) {
            textFallbackOrdinal += 1;
          }
          if (msgId && msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          const messageItem: ReplayableResponseOutputMessage = {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] },
            ],
            status: "completed",
            ...(msgId ? { id: msgId } : {}),
            phase: parsedSignature?.phase,
          };
          output.push(messageItem as ResponseInputItem);
          previousReplayItemWasReasoning = false;
        } else if (block.type === "toolCall") {
          const toolCall = block;
          const [callId, itemIdRaw] = splitResponsesToolCallId(toolCall.id);
          let itemId: string | undefined = shouldReplayResponsesItemIds ? itemIdRaw : undefined;

          // For different-model messages, set id to undefined to avoid pairing validation.
          // OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
          // By omitting the id, we avoid triggering that validation (like cross-provider does).
          if (shouldReplayResponsesItemIds && isDifferentModel && itemId?.startsWith("fc_")) {
            itemId = undefined;
          }

          output.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          });
          previousReplayItemWasReasoning = false;
        }
      }
      if (output.length === 0) {
        continue;
      }
      messages.push(...output);
    } else if (msg.role === "toolResult") {
      const textResult = extractToolResultText(msg.content);
      const sanitizedTextResult = sanitizeSurrogates(textResult);
      const hasImages = msg.content.some(isImageWithMediaPayload);
      const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);
      const hasText = sanitizedTextResult.trim().length > 0;
      const [callId] = splitResponsesToolCallId(msg.toolCallId);

      let output: string | ResponseFunctionCallOutputItemList;
      if (hasImages && model.input.includes("image")) {
        const contentParts: ResponseFunctionCallOutputItemList = [];

        if (hasText) {
          contentParts.push({
            type: "input_text",
            text: sanitizedTextResult,
          });
        } else if (mediaPlaceholder === "(see attached media)") {
          contentParts.push({
            type: "input_text",
            text: mediaPlaceholder,
          });
        }

        for (const block of msg.content) {
          if (isImageWithMediaPayload(block)) {
            contentParts.push({
              type: "input_image",
              detail: "auto",
              image_url: `data:${block.mimeType};base64,${block.data}`,
            });
          }
        }

        output = contentParts;
      } else {
        output = sanitizeToolResultText(textResult, mediaPlaceholder ?? EMPTY_TOOL_RESULT_TEXT);
      }

      messages.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
    msgIndex++;
  }

  return messages;
}

// =============================================================================
// Stream lifecycle
// =============================================================================

export function createResponsesAssistantOutput<TApi extends Api>(
  model: Model<TApi>,
  api: Api = model.api,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
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
}

export function resolveResponsesReasoningEffort<TApi extends Api>(
  model: Model<TApi>,
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
): ResponsesReasoningEffort | undefined {
  const clampedReasoning = reasoning ? clampThinkingLevel(model, reasoning) : undefined;
  if (!clampedReasoning || clampedReasoning === "off") {
    return undefined;
  }
  if (clampedReasoning === "max") {
    return supportsOpenAIReasoningEffort(model, "max") ? "max" : "xhigh";
  }
  if (
    clampedReasoning === "minimal" &&
    model.provider === "openai" &&
    supportsOpenAIReasoningEffort(model, "max")
  ) {
    const effort = resolveOpenAIReasoningEffortForModel({ model, effort: "minimal" });
    return isResponsesReasoningEffort(effort) ? effort : undefined;
  }
  return clampedReasoning;
}

export function applyCommonResponsesParams<TApi extends Api>(
  params: ResponseCreateParamsStreaming,
  model: Model<TApi>,
  context: Context,
  options?: ResponsesCommonParamsOptions,
  config?: { setDefaultReasoningOff?: boolean },
): void {
  if (options?.maxTokens) {
    params.max_output_tokens = Math.max(options.maxTokens, 16);
  }

  if (options?.temperature !== undefined && supportsOpenAITemperature(model)) {
    params.temperature = options.temperature;
  }

  if (context.tools) {
    const converted = convertResponsesToolPayload(context.tools, { model });
    if (converted.tools.length > 0) {
      params.tools = converted.tools;
    }
  }

  if (!model.reasoning) {
    return;
  }

  if (options?.reasoningEffort || options?.reasoningSummary) {
    const effort = options?.reasoningEffort
      ? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
      : "medium";
    params.reasoning = {
      effort: effort as NonNullable<typeof params.reasoning>["effort"],
      summary: options?.reasoningSummary || "auto",
    };
    params.include = ["reasoning.encrypted_content"];
  } else if ((config?.setDefaultReasoningOff ?? true) && model.thinkingLevelMap?.off !== null) {
    params.reasoning = {
      effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<
        typeof params.reasoning
      >["effort"],
    };
  }
}

function buildResponsesRequestOptions(
  options: ResponsesLifecycleStreamOptions | undefined,
): ResponsesRequestOptions {
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    maxRetries: options?.maxRetries ?? 0,
  };
}

function cleanStreamingScratchBuffers(output: AssistantMessage): void {
  for (const block of output.content) {
    delete (block as { index?: number }).index;
    // partialJson is only a streaming scratch buffer; never persist it.
    delete (block as { partialJson?: string }).partialJson;
  }
}

export async function runResponsesStreamLifecycle<TApi extends Api>(params: {
  stream: AssistantMessageEventStream;
  model: Model<TApi>;
  output: AssistantMessage;
  options?: ResponsesLifecycleStreamOptions;
  createClient: () => ResponsesStreamClient;
  buildParams: () => ResponseCreateParamsStreaming;
  processStreamOptions?: OpenAIResponsesProcessStreamOptions;
  formatError: (error: unknown) => string;
}): Promise<void> {
  const { stream, model, output, options } = params;

  let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
  try {
    const client = params.createClient();
    let requestParams = params.buildParams();
    const nextParams = await options?.onPayload?.(requestParams, model);
    if (nextParams !== undefined) {
      requestParams = nextParams as ResponseCreateParamsStreaming;
    }

    firstEventAbort = createFirstStreamEventAbortController(options?.signal);
    const { data: openaiStream, response } = await client.responses
      .create(requestParams, {
        ...buildResponsesRequestOptions(options),
        signal: firstEventAbort.signal,
      })
      .withResponse();
    await options?.onResponse?.(
      { status: response.status, headers: headersToRecord(response.headers) },
      model,
    );
    stream.push({ type: "start", partial: output });

    const firstEventTimeoutMs = getFirstStreamEventTimeoutMs(options);
    const onFirstEventTimeout = getFirstStreamEventTimeoutHandler(options);
    const processStreamOptions =
      params.processStreamOptions ||
      firstEventTimeoutMs !== undefined ||
      onFirstEventTimeout !== undefined
        ? {
            ...params.processStreamOptions,
            firstEventTimeoutMs:
              params.processStreamOptions?.firstEventTimeoutMs ?? firstEventTimeoutMs,
            abortFirstEventStream:
              params.processStreamOptions?.abortFirstEventStream ?? firstEventAbort.abort,
            onFirstEventTimeout:
              params.processStreamOptions?.onFirstEventTimeout ?? onFirstEventTimeout,
            signal: params.processStreamOptions?.signal ?? options?.signal,
          }
        : undefined;
    await processResponsesStream(openaiStream, output, stream, model, processStreamOptions);

    if (options?.signal?.aborted) {
      throw transportAbortError(options.signal);
    }

    if (output.stopReason === "aborted" || output.stopReason === "error") {
      throw new Error(output.errorMessage ?? "An unknown error occurred");
    }

    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  } catch (error) {
    cleanStreamingScratchBuffers(output);
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = params.formatError(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  } finally {
    firstEventAbort?.dispose();
  }
}
