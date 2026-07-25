// OpenAI Responses shared helpers map runtime messages, tools, and stream events.
import { randomUUID } from "node:crypto";
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputItem,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputText,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost, clampThinkingLevel } from "../model-utils.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
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
import {
  mapResponsesTerminalUsage,
  resolveResponsesTerminalStopReason,
} from "./openai-responses-terminal-usage.js";
import {
  createResponsesToolCallTracker,
  readResponsesToolCallItemIdentity,
  type ResponsesToolCallState,
} from "./openai-responses-tool-call-tracker.js";
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

function resolveResponsesToolCallId(
  item: { call_id?: unknown; id?: unknown },
  fallbackId?: string,
): string {
  const callId = typeof item.call_id === "string" ? item.call_id.trim() : "";
  const itemId = typeof item.id === "string" ? item.id.trim() : "";
  const [fallbackCallId, fallbackItemId = ""] = splitResponsesToolCallId(fallbackId ?? "");
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
type AzureResponsesContentPartAddedEvent = Omit<ResponsesContentPartAddedEvent, "part"> & {
  part: AzureResponsesTextContentPart;
};
type AzureResponsesOutputItemDoneEvent = Omit<ResponsesOutputItemDoneEvent, "item"> & {
  item: ResponsesStreamOutputMessage;
};

type OpenAIResponsesStreamEvent =
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
          }
        : undefined;
    await processResponsesStream(openaiStream, output, stream, model, processStreamOptions);

    if (options?.signal?.aborted) {
      throw new Error("Request was aborted");
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
  type StreamingToolCallBlock = ToolCall & { partialJson: string };
  type StreamingToolCallState = ResponsesToolCallState & {
    block: StreamingToolCallBlock;
    contentIndex: number;
  };
  type TextBlockReference = {
    block: TextContent;
    index: number;
    phase: TextSignatureV1["phase"] | undefined;
  };
  type ResponsesOutputSlot =
    | {
        type: "thinking";
        item: ResponseReasoningItem;
        block: ThinkingContent;
        contentIndex: number;
      }
    | {
        type: "text";
        item: ResponsesStreamOutputMessage;
        block: TextContent | null;
        contentIndex: number | undefined;
        pendingText: string | null;
        collapseCandidate: TextBlockReference | null;
      }
    | { type: "toolCall"; toolCall: StreamingToolCallState };
  const streamingToolCalls = createResponsesToolCallTracker<StreamingToolCallState>();
  const outputSlots = new Map<number, ResponsesOutputSlot>();
  const reasoningBlocksById = new Map<string, ThinkingContent>();
  let unindexedOutputSlot: ResponsesOutputSlot | undefined;
  let terminalResponseEvent: "finalized" | "failed" | undefined;
  let lastTextBlock: TextBlockReference | null = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;
  const readOutputIndex = (event: object): number | undefined => {
    const outputIndex = (event as { output_index?: unknown }).output_index;
    return typeof outputIndex === "number" && Number.isInteger(outputIndex) && outputIndex >= 0
      ? outputIndex
      : undefined;
  };
  const registerOutputSlot = (event: object, slot: ResponsesOutputSlot): void => {
    const outputIndex = readOutputIndex(event);
    if (outputIndex === undefined) {
      if (unindexedOutputSlot) {
        throw new Error("Responses stream added overlapping unindexed output items");
      }
      unindexedOutputSlot = slot;
      return;
    }
    if (outputSlots.has(outputIndex)) {
      throw new Error(`Responses stream reused active output index ${outputIndex}`);
    }
    outputSlots.set(outputIndex, slot);
  };
  const resolveOutputSlot = <TType extends ResponsesOutputSlot["type"]>(
    event: object,
    type: TType,
  ): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
    const outputIndex = readOutputIndex(event);
    let slot = outputIndex === undefined ? unindexedOutputSlot : outputSlots.get(outputIndex);
    if (outputIndex === undefined && !slot) {
      const matchingSlots = [...outputSlots.values()].filter(
        (candidate) => candidate.type === type,
      );
      slot = matchingSlots.length === 1 ? matchingSlots[0] : undefined;
    }
    return slot?.type === type
      ? (slot as Extract<ResponsesOutputSlot, { type: TType }>)
      : undefined;
  };
  const forgetOutputSlot = (event: object, slot: ResponsesOutputSlot): void => {
    const outputIndex = readOutputIndex(event);
    if (outputIndex === undefined) {
      if (unindexedOutputSlot === slot) {
        unindexedOutputSlot = undefined;
      } else {
        for (const [indexedOutput, indexedSlot] of outputSlots) {
          if (indexedSlot === slot) {
            outputSlots.delete(indexedOutput);
          }
        }
      }
      return;
    }
    if (outputSlots.get(outputIndex) === slot) {
      outputSlots.delete(outputIndex);
    }
  };
  const forgetToolCallOutputSlot = (toolCall: StreamingToolCallState): void => {
    for (const [outputIndex, slot] of outputSlots) {
      if (slot.type === "toolCall" && slot.toolCall === toolCall) {
        outputSlots.delete(outputIndex);
      }
    }
  };
  const readIdentityValue = (value: unknown): string | undefined => {
    const identity = typeof value === "string" ? value.trim() : "";
    return identity || undefined;
  };
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
  const createOutputSlot = (
    event: object,
    item: ResponseOutputItem | ResponsesStreamOutputMessage,
  ): ResponsesOutputSlot | undefined => {
    if (item.type === "reasoning") {
      const block: ThinkingContent = { type: "thinking", thinking: "" };
      const slot = {
        type: "thinking",
        item,
        block,
        contentIndex: blocks.length,
      } satisfies ResponsesOutputSlot;
      blocks.push(block);
      registerOutputSlot(event, slot);
      stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item.type === "message") {
      const messageItem = item as ResponsesStreamOutputMessage;
      const collapseCandidate = lastTextBlock;
      const block: TextContent | null = collapseCandidate
        ? null
        : {
            type: "text",
            text: "",
            ...(messageItem.phase
              ? { textSignature: encodeTextSignatureV1(messageItem.id, messageItem.phase) }
              : {}),
          };
      const slot = {
        type: "text",
        item: messageItem,
        block,
        contentIndex: block ? blocks.length : undefined,
        pendingText: collapseCandidate ? "" : null,
        collapseCandidate,
      } satisfies ResponsesOutputSlot;
      if (block) {
        blocks.push(block);
      }
      registerOutputSlot(event, slot);
      if (slot.contentIndex !== undefined) {
        stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
      }
      return slot;
    }
    return undefined;
  };
  const resolveOutputItemSlot = (
    event: object,
    item: ResponseOutputItem | ResponsesStreamOutputMessage,
  ): ResponsesOutputSlot | undefined => {
    if (item.type === "reasoning") {
      return resolveOutputSlot(event, "thinking");
    }
    if (item.type === "message") {
      return resolveOutputSlot(event, "text");
    }
    const outputIndex = readOutputIndex(event);
    return outputIndex === undefined ? undefined : outputSlots.get(outputIndex);
  };
  const getOrCreateOutputSlot = (
    event: object,
    item: ResponseOutputItem | ResponsesStreamOutputMessage,
  ): ResponsesOutputSlot | undefined => {
    return resolveOutputItemSlot(event, item) ?? createOutputSlot(event, item);
  };
  const materializeDeferredTextSlot = (
    slot: Extract<ResponsesOutputSlot, { type: "text" }>,
  ): void => {
    if (slot.block || slot.pendingText === null) {
      return;
    }
    const text = slot.pendingText;
    slot.block = {
      type: "text",
      text,
      ...(slot.item.phase
        ? { textSignature: encodeTextSignatureV1(slot.item.id, slot.item.phase) }
        : {}),
    };
    blocks.push(slot.block);
    slot.contentIndex = blockIndex();
    stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
    if (text) {
      stream.push({
        type: "text_delta",
        contentIndex: slot.contentIndex,
        delta: text,
        partial: output,
      });
    }
    if (lastTextBlock === slot.collapseCandidate) {
      lastTextBlock = null;
    }
    slot.pendingText = null;
    slot.collapseCandidate = null;
  };
  const materializeDeferredTextSlots = (except?: ResponsesOutputSlot): void => {
    for (const slot of outputSlots.values()) {
      if (slot !== except && slot.type === "text") {
        materializeDeferredTextSlot(slot);
      }
    }
    if (unindexedOutputSlot !== except && unindexedOutputSlot?.type === "text") {
      materializeDeferredTextSlot(unindexedOutputSlot);
    }
  };
  const appendPendingMessageDelta = (
    slot: Extract<ResponsesOutputSlot, { type: "text" }>,
    delta: string,
  ) => {
    slot.pendingText = `${slot.pendingText ?? ""}${delta}`;
    const priorText = slot.collapseCandidate?.block.text ?? "";
    if (priorText.startsWith(slot.pendingText) || slot.pendingText.startsWith(priorText)) {
      return;
    }
    // Diverged from the prior text: this is a distinct message, so open its
    // block now and replay the withheld text as one delta.
    materializeDeferredTextSlot(slot);
  };
  const backfillReasoningSignatures = (responseOutput: ResponseOutputItem[]): void => {
    for (const item of responseOutput) {
      if (item.type !== "reasoning" || !item.encrypted_content) {
        continue;
      }
      const block = reasoningBlocksById.get(item.id);
      if (!block?.thinkingSignature) {
        continue;
      }

      const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
      if (storedItem.encrypted_content) {
        continue;
      }
      block.thinkingSignature = JSON.stringify({
        ...storedItem,
        encrypted_content: item.encrypted_content,
      });
    }
  };
  const finalizeResponse = (
    response: Extract<
      ResponseStreamEvent,
      { type: "response.completed" | "response.incomplete" }
    >["response"],
  ): void => {
    terminalResponseEvent = "finalized";
    backfillReasoningSignatures(response.output ?? []);
    if (response.id) {
      output.responseId = response.id;
    }
    const mappedUsage = mapResponsesTerminalUsage(response.usage);
    if (mappedUsage) {
      output.usage = {
        ...mappedUsage,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }
    calculateCost(model, output.usage);
    if (options?.applyServiceTierPricing) {
      const serviceTier = options.resolveServiceTier
        ? options.resolveServiceTier(response.service_tier, options.serviceTier)
        : (response.service_tier ?? options.serviceTier);
      options.applyServiceTierPricing(output.usage, serviceTier);
    }
    const terminal = resolveResponsesTerminalStopReason({
      status: response.status,
      incompleteReason: response.incomplete_details?.reason,
      hasToolCall: output.content.some((block) => block.type === "toolCall"),
    });
    output.stopReason = terminal.stopReason;
    if (terminal.errorMessage) {
      output.errorMessage = terminal.errorMessage;
    }
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
      materializeDeferredTextSlots();
      const item = event.item;
      if (item.type !== "message") {
        // Snapshot collapse only applies to back-to-back message items; any
        // other item is a real boundary (see resolveResponsesMessageSnapshotCollapse).
        lastTextBlock = null;
      }
      if (item.type === "reasoning" || item.type === "message") {
        createOutputSlot(event, item);
      } else if (item.type === "function_call") {
        const toolCallBlock: StreamingToolCallBlock = {
          type: "toolCall",
          id: resolveResponsesToolCallId(item),
          name: readIdentityValue(item.name) ?? "",
          arguments: {},
          partialJson: item.arguments || "",
        };
        const contentIndex = output.content.length;
        const toolCallState: StreamingToolCallState = {
          block: toolCallBlock,
          contentIndex,
          argumentStreamReliable: true,
          ...readResponsesToolCallItemIdentity(item),
        };
        streamingToolCalls.register(event, toolCallState);
        if (readOutputIndex(event) !== undefined) {
          registerOutputSlot(event, { type: "toolCall", toolCall: toolCallState });
        }
        output.content.push(toolCallBlock);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      const slot = resolveOutputSlot(event, "thinking");
      if (!slot) {
        continue;
      }
      slot.item.summary = slot.item.summary || [];
      slot.item.summary.push(event.part);
    } else if (event.type === "response.reasoning_summary_text.delta") {
      const slot = resolveOutputSlot(event, "thinking");
      if (!slot) {
        continue;
      }
      slot.item.summary = slot.item.summary || [];
      const lastPart = slot.item.summary[slot.item.summary.length - 1];
      if (!lastPart) {
        continue;
      }
      slot.block.thinking += event.delta;
      lastPart.text += event.delta;
      stream.push({
        type: "thinking_delta",
        contentIndex: slot.contentIndex,
        delta: event.delta,
        partial: output,
      });
    } else if (event.type === "response.reasoning_summary_part.done") {
      const slot = resolveOutputSlot(event, "thinking");
      if (!slot) {
        continue;
      }
      slot.item.summary = slot.item.summary || [];
      const lastPart = slot.item.summary[slot.item.summary.length - 1];
      if (!lastPart) {
        continue;
      }
      slot.block.thinking += "\n\n";
      lastPart.text += "\n\n";
      stream.push({
        type: "thinking_delta",
        contentIndex: slot.contentIndex,
        delta: "\n\n",
        partial: output,
      });
    } else if (event.type === "response.reasoning_text.delta") {
      const slot = resolveOutputSlot(event, "thinking");
      if (!slot) {
        continue;
      }
      slot.block.thinking += event.delta;
      stream.push({
        type: "thinking_delta",
        contentIndex: slot.contentIndex,
        delta: event.delta,
        partial: output,
      });
    } else if (event.type === "response.content_part.added") {
      const slot = resolveOutputSlot(event, "text");
      if (!slot) {
        continue;
      }
      slot.item.content = slot.item.content || [];
      if (
        event.part.type === OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE ||
        event.part.type === AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE ||
        event.part.type === "refusal"
      ) {
        slot.item.content.push(event.part);
      }
    } else if (event.type === "response.output_text.delta") {
      const slot = resolveOutputSlot(event, "text");
      if (!slot?.item.content || slot.item.content.length === 0) {
        continue;
      }
      const lastPart = slot.item.content[slot.item.content.length - 1];
      if (!isResponsesTextContentPartType(lastPart?.type)) {
        continue;
      }
      lastPart.text += event.delta;
      if (slot.pendingText !== null) {
        appendPendingMessageDelta(slot, event.delta);
      } else if (slot.block && slot.contentIndex !== undefined) {
        slot.block.text += event.delta;
        stream.push({
          type: "text_delta",
          contentIndex: slot.contentIndex,
          delta: event.delta,
          partial: output,
        });
      }
    } else if (isAzureResponsesTextDeltaEvent(event)) {
      const slot = resolveOutputSlot(event, "text");
      if (!slot) {
        continue;
      }
      slot.item.content = slot.item.content || [];
      let lastPart = slot.item.content[slot.item.content.length - 1];
      if (lastPart?.type !== "text") {
        lastPart = { type: "text", text: "" };
        slot.item.content.push(lastPart);
      }
      lastPart.text += event.delta;
      if (slot.pendingText !== null) {
        appendPendingMessageDelta(slot, event.delta);
      } else if (slot.block && slot.contentIndex !== undefined) {
        slot.block.text += event.delta;
        stream.push({
          type: "text_delta",
          contentIndex: slot.contentIndex,
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.refusal.delta") {
      const slot = resolveOutputSlot(event, "text");
      if (!slot?.item.content || slot.item.content.length === 0) {
        continue;
      }
      const lastPart = slot.item.content[slot.item.content.length - 1];
      if (lastPart?.type !== "refusal") {
        continue;
      }
      lastPart.refusal += event.delta;
      if (slot.pendingText !== null) {
        appendPendingMessageDelta(slot, event.delta);
      } else if (slot.block && slot.contentIndex !== undefined) {
        slot.block.text += event.delta;
        stream.push({
          type: "text_delta",
          contentIndex: slot.contentIndex,
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      const toolCall = streamingToolCalls.resolve(event);
      if (toolCall) {
        toolCall.block.partialJson += event.delta;
        toolCall.block.arguments = parseStreamingJson(toolCall.block.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: toolCall.contentIndex,
          delta: event.delta,
          partial: output,
        });
      } else if (streamingToolCalls.hasActive()) {
        streamingToolCalls.markArgumentsUnreliable();
      }
    } else if (event.type === "response.function_call_arguments.done") {
      const toolCall = streamingToolCalls.resolve(event);
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
      } else if (streamingToolCalls.hasActive()) {
        streamingToolCalls.markArgumentsUnreliable();
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type !== "message") {
        lastTextBlock = null;
      }

      const existingOutputSlot = resolveOutputItemSlot(event, item);
      materializeDeferredTextSlots(existingOutputSlot);
      const outputSlot = existingOutputSlot ?? getOrCreateOutputSlot(event, item);
      if (item.type === "reasoning" && outputSlot?.type === "thinking") {
        const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
        const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
        outputSlot.block.thinking = summaryText || contentText || outputSlot.block.thinking;
        outputSlot.block.thinkingSignature = JSON.stringify(item);
        if (typeof item.id === "string") {
          reasoningBlocksById.set(item.id, outputSlot.block);
        }
        stream.push({
          type: "thinking_end",
          contentIndex: outputSlot.contentIndex,
          content: outputSlot.block.thinking,
          partial: output,
        });
        forgetOutputSlot(event, outputSlot);
      } else if (
        item.type === "message" &&
        outputSlot?.type === "text" &&
        (outputSlot.block || outputSlot.pendingText !== null)
      ) {
        // Support both OpenAI "output_text" and Azure "text" content types
        const streamedText = outputSlot.pendingText ?? outputSlot.block?.text ?? "";
        const finalText =
          item.content == null
            ? streamedText
            : item.content
                .map((c) => (c.type === "output_text" || c.type === "text" ? c.text : c.refusal))
                .join("");
        const phase = item.phase ?? undefined;
        const collapse =
          outputSlot.pendingText !== null
            ? resolveResponsesMessageSnapshotCollapse({
                prior: outputSlot.collapseCandidate && {
                  text: outputSlot.collapseCandidate.block.text,
                  phase: outputSlot.collapseCandidate.phase,
                },
                nextText: finalText,
                nextPhase: phase,
              })
            : ({ kind: "keep" } as const);
        outputSlot.pendingText = null;
        if (collapse.kind === "extend" && outputSlot.collapseCandidate) {
          // Cumulative snapshot of the prior message item: replace its text
          // instead of appending another copy. The deferred block was never
          // started publicly, and the newest item's signature is kept so
          // replay carries the item that produced this content (#91959).
          outputSlot.collapseCandidate.block.text = collapse.text;
          outputSlot.collapseCandidate.block.textSignature = encodeTextSignatureV1(item.id, phase);
          stream.push({
            type: "text_end",
            contentIndex: outputSlot.collapseCandidate.index,
            content: collapse.text,
            partial: output,
          });
          lastTextBlock = outputSlot.collapseCandidate;
        } else {
          if (!outputSlot.block) {
            // Deferred distinct message: open its block now, balanced with the
            // text_end below.
            outputSlot.block = {
              type: "text",
              text: "",
              ...(phase ? { textSignature: encodeTextSignatureV1(item.id, phase) } : {}),
            };
            blocks.push(outputSlot.block);
            outputSlot.contentIndex = blockIndex();
            stream.push({
              type: "text_start",
              contentIndex: outputSlot.contentIndex,
              partial: output,
            });
          }
          outputSlot.block.text = finalText;
          outputSlot.block.textSignature = encodeTextSignatureV1(item.id, phase);
          const contentIndex = outputSlot.contentIndex;
          if (contentIndex === undefined) {
            throw new Error("Responses stream finalized text without a content index");
          }
          lastTextBlock = { block: outputSlot.block, index: contentIndex, phase };
          stream.push({
            type: "text_end",
            contentIndex,
            content: outputSlot.block.text,
            partial: output,
          });
        }
        forgetOutputSlot(event, outputSlot);
      } else if (item.type === "function_call") {
        const streamingToolCall = streamingToolCalls.resolve(
          event,
          readResponsesToolCallItemIdentity(item),
        );
        // Do not turn an unresolved completion into a second public call while
        // an indexed call is still open. Its identity or index must match.
        if (!streamingToolCall && streamingToolCalls.hasActive()) {
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
          streamingToolCalls.forget(streamingToolCall);
          forgetToolCallOutputSlot(streamingToolCall);
        }
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall,
          partial: output,
        });
      }
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      if (streamingToolCalls.hasActive()) {
        throw new Error("Responses stream completed with unresolved tool calls");
      }
      finalizeResponse(event.response);
    } else if (event.type === "error") {
      throw new Error(
        event.message ? `Error Code ${event.code}: ${event.message}` : "Unknown error",
      );
    } else if (event.type === "response.failed") {
      const error = event.response?.error;
      const details = event.response?.incomplete_details;
      output.responseId = event.response.id;
      output.stopReason = "error";
      output.errorMessage = error
        ? `${error.code || "unknown"}: ${error.message || "no message"}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : "Unknown error (no error details in response)";
      terminalResponseEvent = "failed";
      break;
    }
  }
  if (terminalResponseEvent === "failed") {
    return;
  }
  if (streamingToolCalls.hasActive()) {
    throw new Error("Responses stream ended with unresolved tool calls");
  }
  if (!terminalResponseEvent) {
    throw new Error("OpenAI Responses stream ended before a terminal response event");
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
