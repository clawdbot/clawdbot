// OpenAI Responses shared helpers map runtime messages, tools, and stream events.
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
import {
  resolveOpenAIReasoningEffortForModel,
  supportsOpenAIReasoningEffort,
} from "../../agents/openai-reasoning-effort.js";
import { stripSystemPromptCacheBoundary } from "../../agents/system-prompt-cache-boundary.js";
import {
  AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE,
  OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE,
  type AzureResponsesTextContentPart,
  type AzureResponsesTextDeltaEvent,
  isAzureResponsesTextDeltaEvent,
  isResponsesTextContentPartType,
  resolveResponsesMessageSnapshotCollapse,
} from "../../shared/openai-responses-stream-compat.js";
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
import { convertResponsesToolPayload, convertResponsesTools } from "./openai-responses-tools.js";
import { transformMessages } from "./transform-messages.js";

// =============================================================================
// Utilities
// =============================================================================

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

export interface OpenAIResponsesStreamOptions {
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

export interface ConvertResponsesMessagesOptions {
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
>;

export type ResponsesReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
export type ResponsesReasoningSummary = "auto" | "detailed" | "concise" | null;

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
      const textResult = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
      const hasText = textResult.length > 0;
      const [callId] = msg.toolCallId.split("|");

      let output: string | ResponseFunctionCallOutputItemList;
      if (hasImages && model.input.includes("image")) {
        const contentParts: ResponseFunctionCallOutputItemList = [];

        if (hasText) {
          contentParts.push({
            type: "input_text",
            text: sanitizeSurrogates(textResult),
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
        output = sanitizeSurrogates(hasText ? textResult : "(see attached image)");
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

  if (options?.temperature !== undefined) {
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
  processStreamOptions?: OpenAIResponsesStreamOptions;
  formatError: (error: unknown) => string;
}): Promise<void> {
  const { stream, model, output, options } = params;

  try {
    const client = params.createClient();
    let requestParams = params.buildParams();
    const nextParams = await options?.onPayload?.(requestParams, model);
    if (nextParams !== undefined) {
      requestParams = nextParams as ResponseCreateParamsStreaming;
    }

    const { data: openaiStream, response } = await client.responses
      .create(requestParams, buildResponsesRequestOptions(options))
      .withResponse();
    await options?.onResponse?.(
      { status: response.status, headers: headersToRecord(response.headers) },
      model,
    );
    stream.push({ type: "start", partial: output });

    await processResponsesStream(openaiStream, output, stream, model, params.processStreamOptions);

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
  options?: OpenAIResponsesStreamOptions,
): Promise<void> {
  let currentItem:
    | ResponseReasoningItem
    | ResponsesStreamOutputMessage
    | ResponseFunctionToolCall
    | null = null;
  let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null =
    null;
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
  const appendPendingMessageDelta = (delta: string) => {
    pendingMessageText = `${pendingMessageText ?? ""}${delta}`;
    const priorText = lastTextBlock?.block.text ?? "";
    if (priorText.startsWith(pendingMessageText) || pendingMessageText.startsWith(priorText)) {
      return;
    }
    // Diverged from the prior text: this is a distinct message, so open its
    // block now and replay the withheld text as one delta.
    currentBlock = { type: "text", text: pendingMessageText };
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

  for await (const event of openaiStream) {
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
          currentBlock = { type: "text", text: "" };
          output.content.push(currentBlock);
          stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
        }
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: {},
          partialJson: item.arguments || "",
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
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
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson += event.delta;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        const previousPartialJson = currentBlock.partialJson;
        const doneArguments = typeof event.arguments === "string" ? event.arguments : undefined;

        if (
          doneArguments !== undefined &&
          (doneArguments.length > 0 || previousPartialJson === "")
        ) {
          currentBlock.partialJson = doneArguments;
          currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
        }

        if (doneArguments?.startsWith(previousPartialJson)) {
          const delta = doneArguments.slice(previousPartialJson.length);
          if (delta.length > 0) {
            stream.push({
              type: "toolcall_delta",
              contentIndex: blockIndex(),
              delta,
              partial: output,
            });
          }
        }
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
            currentBlock = { type: "text", text: "" };
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
        const args =
          currentBlock?.type === "toolCall" && currentBlock.partialJson
            ? parseStreamingJson(currentBlock.partialJson)
            : parseStreamingJson(item.arguments || "{}");

        let toolCall: ToolCall;
        if (currentBlock?.type === "toolCall") {
          // Finalize in-place and strip the scratch buffer so replay only
          // carries parsed arguments.
          currentBlock.arguments = args;
          delete (currentBlock as { partialJson?: string }).partialJson;
          toolCall = currentBlock;
        } else {
          toolCall = {
            type: "toolCall",
            id: `${item.call_id}|${item.id}`,
            name: item.name,
            arguments: args,
          };
        }

        currentBlock = null;
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall,
          partial: output,
        });
      }
    } else if (event.type === "response.completed") {
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
