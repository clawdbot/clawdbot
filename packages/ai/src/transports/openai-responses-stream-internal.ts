import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseOutputItem } from "openai/resources/responses/responses.js";
import {
  AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE,
  OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE,
  isAzureResponsesTextDeltaEvent,
  isResponsesTextContentPartType,
  resolveResponsesMessageSnapshotCollapse,
} from "../providers/openai-responses-stream-compat.js";
import {
  createResponsesToolCallTracker,
  readResponsesToolCallItemIdentity,
  type ResponsesToolCallState,
} from "../providers/openai-responses-tool-call-tracker.js";
import type { Api, AssistantMessage, Model, TextContent, ToolCall } from "../types.js";
import {
  createToolArgumentPreviewSchedule,
  parseStreamingJson,
  type ToolArgumentPreviewSchedule,
} from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import { withFirstStreamEventTimeout } from "../utils/stream-first-event-timeout.js";
import { createCompactionTracker } from "./openai-responses-compaction-replay.js";
import { OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY } from "./openai-responses-contracts.js";
import { normalizeResponsesFailedEvent, ResponsesStreamFailure } from "./openai-responses-debug.js";
import { encodeTextSignatureV1 } from "./openai-responses-replay-internal.js";
import { adaptResponsesStream } from "./openai-responses-stream-observer-internal.js";
import {
  appendResponsesPendingTextDelta,
  createResponsesOutputTracker,
  createResponsesOutputSlotTracker,
  readResponsesOutputIndex,
  type ResponsesStreamOutputSlot,
} from "./openai-responses-stream-slots-internal.js";
import {
  createResponsesTerminalController,
  resolveCompletedResponsesToolCall,
  resolveResponsesToolCallId,
  type ResponsesEventSink,
  type ResponsesThinkingBlock,
  type TextBlockReference,
} from "./openai-responses-stream-terminal-internal.js";
import type {
  CompletedResponse,
  ResponsesStreamOptions,
  ResponsesStreamOutputMessage,
} from "./openai-responses-stream-types-internal.js";
import { transportAbortError } from "./transport-stream-shared.js";

export type { OpenAIResponsesStreamEvent } from "./openai-responses-stream-types-internal.js";

export async function processResponsesStream<TApi extends Api>(
  openaiStream: AsyncIterable<unknown>,
  output: AssistantMessage,
  stream: ResponsesEventSink,
  model: Model<TApi>,
  options?: ResponsesStreamOptions,
) {
  type CompletedToolCall = Extract<ResponseOutputItem, { type: "function_call" }>;
  type StreamingToolCallBlock = ToolCall & { partialJson: string };
  type StreamingToolCallState = ResponsesToolCallState & {
    block: StreamingToolCallBlock;
    contentIndex: number;
    // Preview refresh schedule for streamed arguments; done/terminal parses stay authoritative.
    previewSchedule: ToolArgumentPreviewSchedule;
  };
  type ResponsesOutputSlot = ResponsesStreamOutputSlot<
    ResponsesStreamOutputMessage,
    StreamingToolCallState
  >;
  const streamingToolCalls = createResponsesToolCallTracker<StreamingToolCallState>();
  const outputSlots = createResponsesOutputSlotTracker<ResponsesOutputSlot>();
  const outputs = createResponsesOutputTracker();
  let terminalResponse: CompletedResponse | null | undefined;
  let lastTextBlock: TextBlockReference | null = null;
  const blocks = output.content;
  const compactionTracker = createCompactionTracker(output, model, options);
  const createOutputSlot = (
    event: object,
    item: ResponseOutputItem | ResponsesStreamOutputMessage,
  ): ResponsesOutputSlot | undefined => {
    if (item.type === "reasoning") {
      const block: ResponsesThinkingBlock = { type: "thinking", thinking: "" };
      const slot = {
        type: "thinking",
        item,
        block,
        contentIndex: blocks.length,
        outputIndex: readResponsesOutputIndex(event),
      } satisfies ResponsesOutputSlot;
      blocks.push(block);
      outputs.set(item, slot.contentIndex, slot.outputIndex);
      outputSlots.register(event, slot);
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
        outputIndex: readResponsesOutputIndex(event),
        pendingText: collapseCandidate ? "" : null,
        collapseCandidate,
      } satisfies ResponsesOutputSlot;
      if (block) {
        blocks.push(block);
        outputs.set(messageItem, slot.contentIndex ?? blocks.length - 1, slot.outputIndex);
      }
      outputSlots.register(event, slot);
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
      return outputSlots.resolve(event, "thinking");
    }
    if (item.type === "message") {
      return outputSlots.resolve(event, "text");
    }
    return readResponsesOutputIndex(event) === undefined ? undefined : outputSlots.get(event);
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
    slot.contentIndex = blocks.length - 1;
    outputs.set(slot.item, slot.contentIndex, slot.outputIndex);
    stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
    if (text) {
      stream.push({
        type: "text_delta",
        contentIndex: slot.contentIndex,
        delta: text,
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
  };
  const terminal = createResponsesTerminalController({
    output,
    stream,
    model,
    options,
    outputs,
    getLastTextBlock: () => lastTextBlock,
    setLastTextBlock: (block) => {
      lastTextBlock = block;
    },
  });

  const finalizeToolCall = (
    item: CompletedToolCall,
    outputIndex: number | undefined,
    streamingToolCall: StreamingToolCallState | undefined,
    validated: Pick<ToolCall, "name" | "arguments">,
  ): void => {
    const identity = {
      type: item.type,
      id: item.id || streamingToolCall?.itemId,
      call_id: item.call_id || streamingToolCall?.callId,
    };
    const finalOutputIndex = outputIndex ?? streamingToolCall?.outputIndex;
    // A wholly anonymous, unindexed done event cannot be deduplicated. Keep
    // its active owner until the terminal snapshot supplies an output position.
    if (finalOutputIndex === undefined && !identity.id && !identity.call_id) {
      if (!streamingToolCall) {
        throw new Error("Responses stream completed tool call without an output identity");
      }
      return;
    }
    if (streamingToolCall) {
      streamingToolCalls.forget(streamingToolCall);
      for (const slot of outputSlots.values()) {
        if (slot.type === "toolCall" && slot.toolCall === streamingToolCall) {
          outputSlots.forget(slot);
        }
      }
    }
    terminal.emitToolCallCompletion(identity, finalOutputIndex, streamingToolCall, validated);
  };
  const prepareTerminalToolCalls = (items: ResponseOutputItem[]) => {
    const prepared = new Map<number, () => void>();
    const recovered: StreamingToolCallState[] = [];
    const callIds = new Set<string>();
    const allowUnmatchedIdentity =
      items.filter(
        (item, index) => item.type === "function_call" && !outputs.get(item, index)?.completed,
      ).length === 1;
    for (const [outputIndex, item] of items.entries()) {
      const tracked = outputs.get(item, outputIndex);
      if (item.type !== "function_call") {
        continue;
      }
      if (item.call_id && callIds.has(item.call_id)) {
        throw new Error("Responses stream repeated a terminal tool-call identity");
      }
      if (item.call_id) {
        callIds.add(item.call_id);
      }
      // Completed positions must be skipped before resolve can adopt an
      // unindexed active call. The positional tracker still checks identity.
      if (tracked?.completed) {
        continue;
      }
      const state = streamingToolCalls.resolve(
        { output_index: outputIndex },
        readResponsesToolCallItemIdentity(item),
        allowUnmatchedIdentity,
      );
      if (tracked && !state) {
        throw new Error("Responses stream completed with unresolved tool calls");
      }
      const validated = resolveCompletedResponsesToolCall(item, { name: state?.block.name });
      if (state) {
        recovered.push(state);
      }
      prepared.set(outputIndex, () => finalizeToolCall(item, outputIndex, state, validated));
    }
    if (!streamingToolCalls.hasExactlyActive(recovered)) {
      throw new Error("Responses stream completed with unresolved tool calls");
    }
    // All terminal calls and active-call coverage are validated before any
    // toolcall_end can authorize execution; terminal ordering is checked next.
    return (outputIndex: number) => {
      const complete = prepared.get(outputIndex);
      if (!complete) {
        throw new Error("Responses stream completed with unresolved tool calls");
      }
      complete();
    };
  };

  const guardedStream = adaptResponsesStream(
    withFirstStreamEventTimeout(openaiStream, {
      provider: model.provider,
      api: model.api,
      model: model.id,
      timeoutMs: options?.firstEventTimeoutMs ?? 0,
      stage: "responses",
      abort: options?.abortFirstEventStream,
      onTimeout: options?.onFirstEventTimeout,
      hint: "The provider may be stalled while parsing the tool payload; retry with a smaller tool surface or enable OPENCLAW_DEBUG_MODEL_PAYLOAD=tools to inspect exposed tools.",
    }),
    options?.signal,
  );
  try {
    for await (const event of guardedStream) {
      // Bookkeeping-only SSE events (in_progress, *.done echoes) are still
      // provider progress; keep the idle watchdog alive without exposing them,
      // matching the completions and anthropic transports.
      notifyLlmRequestActivity(options?.signal);
      if (event.type === "response.created") {
        output.responseId = event.response.id;
      } else if (event.type === "response.output_item.added") {
        materializeDeferredTextSlots();
        const item = event.item;
        compactionTracker.added(item, blocks.length);
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
            name: typeof item.name === "string" ? item.name.trim() : "",
            arguments: {},
            partialJson: item.arguments || "",
          };
          const contentIndex = output.content.length;
          const toolCallState: StreamingToolCallState = {
            block: toolCallBlock,
            contentIndex,
            argumentStreamReliable: true,
            previewSchedule: createToolArgumentPreviewSchedule(),
            ...readResponsesToolCallItemIdentity(item),
          };
          streamingToolCalls.register(event, toolCallState);
          if (readResponsesOutputIndex(event) !== undefined) {
            outputSlots.register(event, { type: "toolCall", toolCall: toolCallState });
          }
          output.content.push(toolCallBlock);
          outputs.set(item, contentIndex, readResponsesOutputIndex(event));
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        }
      } else if (event.type === "response.reasoning_summary_part.added") {
        const slot = outputSlots.resolve(event, "thinking");
        if (!slot) {
          continue;
        }
        slot.item.summary = slot.item.summary || [];
        slot.item.summary.push(event.part);
      } else if (event.type === "response.reasoning_summary_text.delta") {
        const slot = outputSlots.resolve(event, "thinking");
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
        const slot = outputSlots.resolve(event, "thinking");
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
        const slot = outputSlots.resolve(event, "thinking");
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
        const slot = outputSlots.resolve(event, "text");
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
        const slot = outputSlots.resolve(event, "text");
        if (!slot) {
          continue;
        }
        slot.item.content ||= [];
        let lastPart = slot.item.content[slot.item.content.length - 1];
        if (!isResponsesTextContentPartType(lastPart?.type)) {
          lastPart = { type: "output_text", text: "", annotations: [] };
          slot.item.content.push(lastPart);
        }
        lastPart.text += event.delta;
        if (slot.pendingText !== null) {
          appendResponsesPendingTextDelta(slot, event.delta, materializeDeferredTextSlot);
        } else if (slot.block && slot.contentIndex !== undefined) {
          slot.block.text += event.delta;
          // llm-core deliberately makes text_delta.partial optional to avoid a full snapshot per token.
          stream.push({
            type: "text_delta",
            contentIndex: slot.contentIndex,
            delta: event.delta,
          });
        }
      } else if (isAzureResponsesTextDeltaEvent(event)) {
        const slot = outputSlots.resolve(event, "text");
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
          appendResponsesPendingTextDelta(slot, event.delta, materializeDeferredTextSlot);
        } else if (slot.block && slot.contentIndex !== undefined) {
          slot.block.text += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: slot.contentIndex,
            delta: event.delta,
          });
        }
      } else if (event.type === "response.refusal.delta") {
        const slot = outputSlots.resolve(event, "text");
        if (!slot) {
          continue;
        }
        slot.item.content ||= [];
        let lastPart = slot.item.content[slot.item.content.length - 1];
        if (lastPart?.type !== "refusal") {
          lastPart = { type: "refusal", refusal: "" };
          slot.item.content.push(lastPart);
        }
        lastPart.refusal += event.delta;
        if (slot.pendingText !== null) {
          appendResponsesPendingTextDelta(slot, event.delta, materializeDeferredTextSlot);
        } else if (slot.block && slot.contentIndex !== undefined) {
          slot.block.text += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: slot.contentIndex,
            delta: event.delta,
          });
        }
      } else if (event.type === "response.function_call_arguments.delta") {
        const toolCall = streamingToolCalls.resolve(event);
        if (toolCall) {
          toolCall.block.partialJson += event.delta;
          // Preview refresh is geometric; the done event and terminal finalize
          // re-parse the full buffer authoritatively either way.
          if (toolCall.previewSchedule(toolCall.block.partialJson.length)) {
            toolCall.block.arguments = parseStreamingJson(toolCall.block.partialJson);
          }
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
        const outputSlot = existingOutputSlot ?? createOutputSlot(event, item);
        compactionTracker.completed(item, blocks.length);
        if (item.type === "reasoning" && outputSlot?.type === "thinking") {
          const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
          const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
          outputSlot.block.thinking = summaryText || contentText || outputSlot.block.thinking;
          outputSlot.block.thinkingSignature = JSON.stringify(item);
          outputs.set(
            item,
            outputSlot.contentIndex,
            readResponsesOutputIndex(event) ?? outputSlot.outputIndex,
            true,
          );
          if (item.encrypted_content && options?.reasoningReplayMetadata) {
            outputSlot.block[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY] =
              options.reasoningReplayMetadata;
          }
          stream.push({
            type: "thinking_end",
            contentIndex: outputSlot.contentIndex,
            content: outputSlot.block.thinking,
            partial: output,
          });
          outputSlots.forget(outputSlot);
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
            outputSlot.collapseCandidate.block.textSignature = encodeTextSignatureV1(
              item.id,
              phase,
            );
            stream.push({
              type: "text_end",
              contentIndex: outputSlot.collapseCandidate.index,
              content: collapse.text,
              partial: output,
            });
            lastTextBlock = outputSlot.collapseCandidate;
            outputs.set(
              item,
              outputSlot.collapseCandidate.index,
              readResponsesOutputIndex(event) ?? outputSlot.outputIndex,
              true,
            );
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
              outputSlot.contentIndex = blocks.length - 1;
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
            outputs.set(
              item,
              contentIndex,
              readResponsesOutputIndex(event) ?? outputSlot.outputIndex,
              true,
            );
            stream.push({
              type: "text_end",
              contentIndex,
              content: outputSlot.block.text,
              partial: output,
            });
          }
          outputSlots.forget(outputSlot);
        } else if (item.type === "function_call") {
          if (outputs.get(item, readResponsesOutputIndex(event))?.completed) {
            continue;
          }
          const streamingToolCall = streamingToolCalls.resolve(
            event,
            readResponsesToolCallItemIdentity(item),
          );
          // Do not turn an unresolved completion into a second public call while
          // an indexed call is still open. Its identity or index must match.
          if (!streamingToolCall && streamingToolCalls.hasActive()) {
            continue;
          }
          const completedArguments =
            typeof item.arguments === "string" ? item.arguments : undefined;
          if (
            streamingToolCall &&
            !streamingToolCall.argumentStreamReliable &&
            !completedArguments
          ) {
            continue;
          }
          const validated = resolveCompletedResponsesToolCall(item, {
            name: streamingToolCall?.block.name,
            arguments: completedArguments || streamingToolCall?.block.partialJson || "",
          });

          finalizeToolCall(item, readResponsesOutputIndex(event), streamingToolCall, validated);
        }
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        if (event.type === "response.incomplete" && streamingToolCalls.hasActive()) {
          throw new Error("Responses stream completed with unresolved tool calls");
        }
        terminal.finalizeResponse(event.response, event.type);
        if (event.type === "response.completed" || output.stopReason === "length") {
          const items = event.response.output ?? [];
          const completeToolCall =
            event.type === "response.completed" ? prepareTerminalToolCalls(items) : undefined;
          terminal.recoverTerminalOutput(items, completeToolCall);
        }
        terminalResponse = event.type === "response.completed" ? event.response : null;
        if (
          output.stopReason === "stop" &&
          output.content.some((block) => block.type === "toolCall")
        ) {
          output.stopReason = "toolUse";
        }
        break;
      } else if (event.type === "error") {
        throw new Error(
          event.message ? `Error Code ${event.code}: ${event.message}` : "Unknown error",
        );
      } else if (event.type === "response.failed") {
        const failure = normalizeResponsesFailedEvent(isRecord(event) ? event : {}, model);
        terminal.finalizeFailedResponse(event.response, failure.responseId);
        throw new ResponsesStreamFailure(failure, event.response);
      }
    }
    // openai-node turns an aborted SSE iterator into normal completion; preserve
    // the caller's authoritative reason before classifying terminal stream state.
    if (options?.signal?.aborted) {
      throw transportAbortError(options.signal);
    }
    if (streamingToolCalls.hasActive()) {
      throw new Error("Responses stream ended with unresolved tool calls");
    }
    if (terminalResponse === undefined) {
      throw new Error("OpenAI Responses stream ended before a terminal response event");
    }
    return terminalResponse ?? undefined;
  } finally {
    for (const block of output.content) {
      delete (block as { partialJson?: string }).partialJson;
    }
  }
}
