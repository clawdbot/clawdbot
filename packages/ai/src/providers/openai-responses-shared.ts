// OpenAI Responses shared helpers map runtime messages, tools, and stream events.
import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputText,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost, clampThinkingLevel } from "../model-utils.js";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  StopReason,
  StreamOptions,
  TextContent,
  TextSignatureV1,
  ThinkingContent,
  ToolCall,
  Usage,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { shortHash } from "../utils/hash.js";
import { headersToRecord } from "../utils/headers.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  type FirstStreamEventInternalOptions,
  withFirstStreamEventTimeout,
} from "../utils/stream-first-event-timeout.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  resolveOpenAIReasoningEffortForModel,
  supportsOpenAIReasoningEffort,
  supportsOpenAITemperature,
} from "./openai-reasoning-effort.js";
import {
  AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE,
  OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE,
  type AzureResponsesTextContentPart,
  type AzureResponsesTextDeltaEvent,
  isAzureResponsesTextDeltaEvent,
  isResponsesTextContentPartType,
  resolveResponsesMessageSnapshotCollapse,
} from "./openai-responses-stream-compat.js";
import { convertResponsesToolPayload, convertResponsesTools } from "./openai-responses-tools.js";
import { describeToolResultMediaPlaceholder, extractToolResultText } from "./tool-result-text.js";
import { transformMessages } from "./transform-messages.js";

// =============================================================================
// Utilities
// =============================================================================

const EMPTY_TOOL_RESULT_TEXT = "(no output)";

function resolveResponsesToolCallId(
  item: { call_id?: unknown; id?: unknown },
  fallbackId?: string,
): string {
  const callId = typeof item.call_id === "string" ? item.call_id.trim() : "";
  const itemId = typeof item.id === "string" ? item.id.trim() : "";
  const [fallbackCallId = "", fallbackItemId = ""] = (fallbackId ?? "").split("|");
  const resolvedCallId = callId || fallbackCallId;
  const resolvedItemId = itemId || fallbackItemId;
  if (resolvedCallId) {
    return resolvedItemId ? `${resolvedCallId}|${resolvedItemId}` : resolvedCallId;
  }
  const generatedCallId = `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  return resolvedItemId ? `${generatedCallId}|${resolvedItemId}` : generatedCallId;
}

function sanitizeToolResultText(text: string, fallback: string): string {
  const sanitized = sanitizeSurrogates(text);
  return sanitized.trim().length > 0 ? sanitized : fallback;
}

type ReplayableResponseOutputMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };
type ReplayableResponseReasoningItem = Omit<ResponseReasoningItem, "id"> & { id?: string };
type ResponsesTextContentPart =
  | ResponseOutputMessage["content"][number]
  | AzureResponsesTextContentPart;
type ResponsesStreamOutputMessage = Omit<ResponseOutputMessage, "content"> & {
  content: ResponsesTextContentPart[];
};
type ResponsesContentPartAddedEvent = Extract<
  ResponseStreamEvent,
  { type: "response.content_part.added" }
>;
type ResponsesOutputItemDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_item.done" }
>;
type ResponsesInputTokensDetails = {
  cached_tokens?: number;
  cache_write_tokens?: number;
};
type AzureResponsesContentPartAddedEvent = Omit<ResponsesContentPartAddedEvent, "part"> & {
  part: AzureResponsesTextContentPart;
};
type AzureResponsesOutputItemDoneEvent = Omit<ResponsesOutputItemDoneEvent, "item"> & {
  item: ResponsesStreamOutputMessage;
};

export type OpenAIResponsesStreamEvent =
  | ResponseStreamEvent
  | AzureResponsesContentPartAddedEvent
  | AzureResponsesOutputItemDoneEvent
  | AzureResponsesTextDeltaEvent;

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

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
  const payload: TextSignatureV1 = { v: 1, id };
  if (phase) {
    payload.phase = phase;
  }
  return JSON.stringify(payload);
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
export { convertResponsesToolPayload, convertResponsesTools };
export type { ConvertResponsesToolsOptions } from "./openai-responses-tools.js";

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
  FirstStreamEventInternalOptions;

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
    const [callId, itemId] = id.split("|");
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
    const role = model.reasoning ? "developer" : "system";
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
          const [callId, itemIdRaw] = toolCall.id.split("|");
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
      const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
      const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);
      const hasText = sanitizedTextResult.trim().length > 0;
      const [callId] = msg.toolCallId.split("|");

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
          if (block.type === "image") {
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
    params.max_output_tokens = options.maxTokens;
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
    ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
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
          }
        : undefined;
    await processResponsesStream(openaiStream, output, stream, model, processStreamOptions);

    if (options?.signal?.aborted) {
      throw new Error("Request was aborted");
    }

    if (output.stopReason === "aborted" || output.stopReason === "error") {
      throw new Error("An unknown error occurred");
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

// =============================================================================
// Stream processing
// =============================================================================

export async function processResponsesStream<TApi extends Api>(
  openaiStream: AsyncIterable<OpenAIResponsesStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
  options?: OpenAIResponsesProcessStreamOptions,
): Promise<void> {
  let currentItem:
    | ResponseReasoningItem
    | ResponsesStreamOutputMessage
    | ResponseFunctionToolCall
    | null = null;
  let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null =
    null;
  type StreamingToolCallBlock = ToolCall & { partialJson: string };
  type StreamingToolCallIdentity = { itemId?: string; callId?: string };
  type StreamingToolCallState = StreamingToolCallIdentity & {
    block: StreamingToolCallBlock;
    contentIndex: number;
    argumentStreamReliable: boolean;
  };
  const toolCallsByOutputIndex = new Map<number, StreamingToolCallState>();
  const unindexedToolCalls = new Set<StreamingToolCallState>();
  let lastTextBlock: {
    block: TextContent;
    index: number;
    phase: TextSignatureV1["phase"] | undefined;
  } | null = null;
  // While a message item may still be a cumulative snapshot of lastTextBlock,
  // its public block is deferred so a collapsed item never leaves an
  // unbalanced text_start behind (#91959). null = no deferral in progress.
  let pendingMessageText: string | null = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;
  const readOutputIndex = (event: { output_index?: unknown }): number | undefined =>
    typeof event.output_index === "number" &&
    Number.isInteger(event.output_index) &&
    event.output_index >= 0
      ? event.output_index
      : undefined;
  const readIdentityValue = (value: unknown): string | undefined => {
    const identity = typeof value === "string" ? value.trim() : "";
    return identity || undefined;
  };
  const readEventToolCallIdentity = (event: { item_id?: unknown }): StreamingToolCallIdentity => ({
    itemId: readIdentityValue(event.item_id),
  });
  const readItemToolCallIdentity = (item: {
    id?: unknown;
    call_id?: unknown;
  }): StreamingToolCallIdentity => ({
    itemId: readIdentityValue(item.id),
    callId: readIdentityValue(item.call_id),
  });
  const identitiesConflict = (
    state: StreamingToolCallState,
    identity: StreamingToolCallIdentity,
  ): boolean =>
    Boolean(
      (state.itemId && identity.itemId && state.itemId !== identity.itemId) ||
      (state.callId && identity.callId && state.callId !== identity.callId),
    );
  const sharesIdentity = (
    state: StreamingToolCallState,
    identity: StreamingToolCallIdentity,
  ): boolean =>
    Boolean(
      (state.itemId && identity.itemId && state.itemId === identity.itemId) ||
      (state.callId && identity.callId && state.callId === identity.callId),
    );
  const adoptToolCallIdentity = (
    state: StreamingToolCallState,
    identity: StreamingToolCallIdentity,
  ): StreamingToolCallState => {
    state.itemId ??= identity.itemId;
    state.callId ??= identity.callId;
    return state;
  };
  const resolveCompatibleToolCall = (
    candidates: Iterable<StreamingToolCallState>,
    identity: StreamingToolCallIdentity,
  ): StreamingToolCallState | undefined => {
    const uniqueCandidates = [...new Set(candidates)];
    if (!identity.itemId && !identity.callId) {
      return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
    }
    const compatible = uniqueCandidates.filter((state) => !identitiesConflict(state, identity));
    const matches = compatible.filter((state) => sharesIdentity(state, identity));
    if (matches.length === 1) {
      return adoptToolCallIdentity(matches[0], identity);
    }
    // Only a sole active call may adopt an identity it did not already know.
    // Parallel calls require a positive match so missing indices stay fail-closed.
    return uniqueCandidates.length === 1 && compatible.length === 1 && matches.length === 0
      ? adoptToolCallIdentity(compatible[0], identity)
      : undefined;
  };
  const resolveStreamingToolCall = (
    event: { output_index?: unknown; item_id?: unknown },
    identity: StreamingToolCallIdentity = readEventToolCallIdentity(event),
  ): StreamingToolCallState | undefined => {
    const outputIndex = readOutputIndex(event);
    if (outputIndex !== undefined) {
      const indexed = toolCallsByOutputIndex.get(outputIndex);
      if (indexed) {
        return !identitiesConflict(indexed, identity)
          ? adoptToolCallIdentity(indexed, identity)
          : undefined;
      }
      // A compatibility stream may add calls without indices, then start
      // including them. Bind only the one identity-matched (or sole) candidate.
      const unindexed = resolveCompatibleToolCall(unindexedToolCalls, identity);
      if (unindexed) {
        unindexedToolCalls.delete(unindexed);
        toolCallsByOutputIndex.set(outputIndex, unindexed);
      }
      return unindexed;
    }

    return resolveCompatibleToolCall(
      [...toolCallsByOutputIndex.values(), ...unindexedToolCalls],
      identity,
    );
  };
  const forgetStreamingToolCall = (toolCall: StreamingToolCallState) => {
    for (const [trackedIndex, tracked] of toolCallsByOutputIndex) {
      if (tracked === toolCall) {
        toolCallsByOutputIndex.delete(trackedIndex);
      }
    }
    unindexedToolCalls.delete(toolCall);
  };
  const markActiveToolCallArgumentsUnreliable = () => {
    // An unrouteable argument event may belong to any active call. Only an
    // authoritative full argument snapshot can recover that call.
    for (const toolCall of new Set([...toolCallsByOutputIndex.values(), ...unindexedToolCalls])) {
      toolCall.argumentStreamReliable = false;
    }
  };
  const hasActiveStreamingToolCall = () =>
    toolCallsByOutputIndex.size > 0 || unindexedToolCalls.size > 0;
  // Opening fragments may carry the only function name. A conflicting
  // completion must never retarget an already-started call.
  const resolveCompletedToolCallName = (
    toolCall: StreamingToolCallState | undefined,
    value: unknown,
  ): string => {
    const streamedName = readIdentityValue(toolCall?.block.name);
    const completedName = readIdentityValue(value);
    if (streamedName && completedName && streamedName !== completedName) {
      throw new Error(
        `Responses stream changed tool-call function name from ${streamedName} to ${completedName}`,
      );
    }
    const name = completedName ?? streamedName;
    if (!name) {
      throw new Error("Responses stream completed tool call without a function name");
    }
    return name;
  };
  const appendPendingMessageDelta = (delta: string) => {
    pendingMessageText = `${pendingMessageText ?? ""}${delta}`;
    const priorText = lastTextBlock?.block.text ?? "";
    if (priorText.startsWith(pendingMessageText) || pendingMessageText.startsWith(priorText)) {
      return;
    }
    // Diverged from the prior text: this is a distinct message, so open its
    // block now and replay the withheld text as one delta.
    currentBlock = {
      type: "text",
      text: pendingMessageText,
      ...(currentItem?.type === "message" && currentItem.phase
        ? { textSignature: encodeTextSignatureV1(currentItem.id, currentItem.phase ?? undefined) }
        : {}),
    };
    blocks.push(currentBlock);
    stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
    stream.push({
      type: "text_delta",
      contentIndex: blockIndex(),
      delta: pendingMessageText,
      partial: output,
    });
    pendingMessageText = null;
  };

  const guardedStream = withFirstStreamEventTimeout(openaiStream, {
    provider: model.provider,
    api: model.api,
    model: model.id,
    timeoutMs: options?.firstEventTimeoutMs ?? 0,
    stage: "responses",
    abort: options?.abortFirstEventStream,
    onTimeout: options?.onFirstEventTimeout,
    hint: "The provider may be stalled while parsing the tool payload; retry with a smaller tool surface or enable OPENCLAW_DEBUG_MODEL_PAYLOAD=tools to inspect exposed tools.",
  });
  for await (const event of guardedStream) {
    if (event.type === "response.created") {
      output.responseId = event.response.id;
    } else if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item.type !== "message") {
        // Snapshot collapse only applies to back-to-back message items; any
        // other item is a real boundary (see resolveResponsesMessageSnapshotCollapse).
        lastTextBlock = null;
        pendingMessageText = null;
      }
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        if (lastTextBlock) {
          currentBlock = null;
          pendingMessageText = "";
        } else {
          currentBlock = {
            type: "text",
            text: "",
            ...(item.phase ? { textSignature: encodeTextSignatureV1(item.id, item.phase) } : {}),
          };
          output.content.push(currentBlock);
          stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
        }
      } else if (item.type === "function_call") {
        const outputIndex = readOutputIndex(event);
        if (outputIndex !== undefined && toolCallsByOutputIndex.has(outputIndex)) {
          throw new Error(`Responses stream reused active tool-call output index ${outputIndex}`);
        }
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: resolveResponsesToolCallId(item),
          name: readIdentityValue(item.name) ?? "",
          arguments: {},
          partialJson: item.arguments || "",
        };
        output.content.push(currentBlock);
        const contentIndex = blockIndex();
        const toolCallState = {
          block: currentBlock,
          contentIndex,
          argumentStreamReliable: true,
          ...readItemToolCallIdentity(item),
        };
        if (outputIndex !== undefined) {
          toolCallsByOutputIndex.set(outputIndex, toolCallState);
        } else {
          unindexedToolCalls.add(toolCallState);
        }
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      if (currentItem && currentItem.type === "reasoning") {
        currentItem.summary = currentItem.summary || [];
        currentItem.summary.push(event.part);
      }
    } else if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += "\n\n";
          lastPart.text += "\n\n";
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: "\n\n",
            partial: output,
          });
        }
      }
    } else if (event.type === "response.reasoning_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking += event.delta;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.content_part.added") {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        if (
          event.part.type === OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE ||
          event.part.type === AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE ||
          event.part.type === "refusal"
        ) {
          currentItem.content.push(event.part);
        }
      }
    } else if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (isResponsesTextContentPartType(lastPart?.type)) {
          lastPart.text += event.delta;
          if (pendingMessageText !== null) {
            appendPendingMessageDelta(event.delta);
          } else if (currentBlock?.type === "text") {
            currentBlock.text += event.delta;
            stream.push({
              type: "text_delta",
              contentIndex: blockIndex(),
              delta: event.delta,
              partial: output,
            });
          }
        }
      }
    } else if (isAzureResponsesTextDeltaEvent(event)) {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        let lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type !== "text") {
          lastPart = { type: "text", text: "" };
          currentItem.content.push(lastPart);
        }
        lastPart.text += event.delta;
        if (pendingMessageText !== null) {
          appendPendingMessageDelta(event.delta);
        } else if (currentBlock?.type === "text") {
          currentBlock.text += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "refusal") {
          lastPart.refusal += event.delta;
          if (pendingMessageText !== null) {
            appendPendingMessageDelta(event.delta);
          } else if (currentBlock?.type === "text") {
            currentBlock.text += event.delta;
            stream.push({
              type: "text_delta",
              contentIndex: blockIndex(),
              delta: event.delta,
              partial: output,
            });
          }
        }
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      const toolCall = resolveStreamingToolCall(event);
      if (toolCall) {
        toolCall.block.partialJson += event.delta;
        toolCall.block.arguments = parseStreamingJson(toolCall.block.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: toolCall.contentIndex,
          delta: event.delta,
          partial: output,
        });
      } else if (hasActiveStreamingToolCall()) {
        markActiveToolCallArgumentsUnreliable();
      }
    } else if (event.type === "response.function_call_arguments.done") {
      const toolCall = resolveStreamingToolCall(event);
      if (toolCall) {
        const previousPartialJson = toolCall.block.partialJson;
        const doneArguments = typeof event.arguments === "string" ? event.arguments : undefined;

        if (
          doneArguments !== undefined &&
          (doneArguments.length > 0 || previousPartialJson === "")
        ) {
          toolCall.block.partialJson = doneArguments;
          toolCall.block.arguments = parseStreamingJson(toolCall.block.partialJson);
          toolCall.argumentStreamReliable = true;
        }

        if (doneArguments?.startsWith(previousPartialJson)) {
          const delta = doneArguments.slice(previousPartialJson.length);
          if (delta.length > 0) {
            stream.push({
              type: "toolcall_delta",
              contentIndex: toolCall.contentIndex,
              delta,
              partial: output,
            });
          }
        }
      } else if (hasActiveStreamingToolCall()) {
        markActiveToolCallArgumentsUnreliable();
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type !== "message") {
        lastTextBlock = null;
        pendingMessageText = null;
      }

      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
        const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
        currentBlock.thinking = summaryText || contentText || currentBlock.thinking;
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (
        item.type === "message" &&
        (currentBlock?.type === "text" || pendingMessageText !== null)
      ) {
        // Support both OpenAI "output_text" and Azure "text" content types
        const finalText = item.content
          .map((c) => (c.type === "output_text" || c.type === "text" ? c.text : c.refusal))
          .join("");
        const phase = item.phase ?? undefined;
        const collapse =
          pendingMessageText !== null
            ? resolveResponsesMessageSnapshotCollapse({
                prior: lastTextBlock && {
                  text: lastTextBlock.block.text,
                  phase: lastTextBlock.phase,
                },
                nextText: finalText,
                nextPhase: phase,
              })
            : ({ kind: "keep" } as const);
        pendingMessageText = null;
        if (collapse.kind === "extend" && lastTextBlock) {
          // Cumulative snapshot of the prior message item: replace its text
          // instead of appending another copy. The deferred block was never
          // started publicly, and the newest item's signature is kept so
          // replay carries the item that produced this content (#91959).
          lastTextBlock.block.text = collapse.text;
          lastTextBlock.block.textSignature = encodeTextSignatureV1(item.id, phase);
          stream.push({
            type: "text_end",
            contentIndex: lastTextBlock.index,
            content: collapse.text,
            partial: output,
          });
        } else {
          if (currentBlock?.type !== "text") {
            // Deferred distinct message: open its block now, balanced with the
            // text_end below.
            currentBlock = {
              type: "text",
              text: "",
              ...(phase ? { textSignature: encodeTextSignatureV1(item.id, phase) } : {}),
            };
            blocks.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text = finalText;
          currentBlock.textSignature = encodeTextSignatureV1(item.id, phase);
          lastTextBlock = { block: currentBlock, index: blockIndex(), phase };
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: currentBlock.text,
            partial: output,
          });
        }
        currentBlock = null;
      } else if (item.type === "function_call") {
        const streamingToolCall = resolveStreamingToolCall(event, readItemToolCallIdentity(item));
        // Do not turn an unresolved completion into a second public call while
        // an indexed call is still open. Its identity or index must match.
        if (!streamingToolCall && hasActiveStreamingToolCall()) {
          continue;
        }
        const completedName = resolveCompletedToolCallName(streamingToolCall, item.name);
        const streamedArguments = streamingToolCall?.block.partialJson ?? "";
        const completedArguments = typeof item.arguments === "string" ? item.arguments : undefined;
        if (streamingToolCall && !streamingToolCall.argumentStreamReliable && !completedArguments) {
          continue;
        }
        const finalArguments =
          completedArguments !== undefined && (completedArguments.length > 0 || !streamedArguments)
            ? completedArguments
            : streamedArguments || "{}";
        const args = parseStreamingJson(finalArguments);

        let toolCall: ToolCall;
        let contentIndex: number;
        if (streamingToolCall) {
          const block = streamingToolCall.block;
          // The SDK permits the added item to omit its item id, then supplies
          // the canonical id on completion. Upgrade the same public block so
          // replay and its function_call_output retain both identities.
          block.id = resolveResponsesToolCallId(item, block.id);
          block.name = completedName;
          // Finalize in-place and strip the scratch buffer so replay only
          // carries parsed arguments.
          block.arguments = args;
          delete (block as { partialJson?: string }).partialJson;
          toolCall = block;
          contentIndex = streamingToolCall.contentIndex;
        } else {
          toolCall = {
            type: "toolCall",
            id: resolveResponsesToolCallId(item),
            name: completedName,
            arguments: args,
          };
          // Some compatible streams only send the completed item. Preserve
          // the normal balanced lifecycle and persist the call for replay.
          blocks.push(toolCall);
          contentIndex = blockIndex();
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        }

        if (streamingToolCall) {
          forgetStreamingToolCall(streamingToolCall);
        }
        if (currentBlock === toolCall) {
          currentBlock = null;
          currentItem = null;
        }
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall,
          partial: output,
        });
      }
    } else if (event.type === "response.completed") {
      if (hasActiveStreamingToolCall()) {
        throw new Error("Responses stream completed with unresolved tool calls");
      }
      const response = event.response;
      if (response?.id) {
        output.responseId = response.id;
      }
      if (response?.usage) {
        const inputTokenDetails = response.usage.input_tokens_details as
          | ResponsesInputTokensDetails
          | null
          | undefined;
        const cachedTokens = inputTokenDetails?.cached_tokens || 0;
        const cacheWriteTokens = inputTokenDetails?.cache_write_tokens || 0;
        output.usage = {
          // OpenAI includes cache reads and writes in input_tokens, so split both priced buckets.
          input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: cacheWriteTokens,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      calculateCost(model, output.usage);
      if (options?.applyServiceTierPricing) {
        const serviceTier = options.resolveServiceTier
          ? options.resolveServiceTier(response?.service_tier, options.serviceTier)
          : (response?.service_tier ?? options.serviceTier);
        options.applyServiceTierPricing(output.usage, serviceTier);
      }
      // Map status to stop reason
      output.stopReason = mapStopReason(response?.status);
      if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
    } else if (event.type === "error") {
      throw new Error(
        event.message ? `Error Code ${event.code}: ${event.message}` : "Unknown error",
      );
    } else if (event.type === "response.failed") {
      const error = event.response?.error;
      const details = event.response?.incomplete_details;
      const msg = error
        ? `${error.code || "unknown"}: ${error.message || "no message"}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : "Unknown error (no error details in response)";
      throw new Error(msg);
    }
  }
  if (hasActiveStreamingToolCall()) {
    throw new Error("Responses stream ended with unresolved tool calls");
  }
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
  if (!status) {
    return "stop";
  }
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    // These two are wonky ...
    case "in_progress":
    case "queued":
      return "stop";
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled stop reason: ${String(exhaustive)}`);
    }
  }
}
