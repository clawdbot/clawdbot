import { randomUUID } from "node:crypto";
import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import {
  createResponsesToolCallTracker,
  isResponsesTextContentPartType,
  isResponsesTextDeltaEventType,
  readResponsesToolCallItemIdentity,
  resolveResponsesMessageSnapshotCollapse,
  type ResponsesToolCallState,
} from "../internal/openai.js";
import { withFirstStreamEventTimeout, parseStreamingJson } from "../internal/runtime.js";
import { emitModelTransportDebug, resolveModelSseDebugMode } from "./model-transport-debug.js";
import { OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY } from "./openai-responses-contracts.js";
import {
  logResponsesFailedNoDetails,
  normalizeResponsesFailedEvent,
  stringifyRedactedEvent,
  stringifyUnknown,
  stringifyJsonLike,
} from "./openai-responses-debug.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  encodeTextSignatureV1,
} from "./openai-responses-replay-internal.js";
import { recordResponsesTerminalOutcome } from "./openai-responses-terminal-outcome.js";
import {
  createModelStreamCooperativeScheduler,
  log,
  throwIfModelStreamAborted,
  type MutableAssistantOutput,
} from "./openai-transport-shared.js";

export async function processResponsesStream(
  openaiStream: AsyncIterable<unknown>,
  output: MutableAssistantOutput,
  stream: { push(event: unknown): void },
  model: Model,
  options?: {
    serviceTier?: ResponseCreateParamsStreaming["service_tier"];
    applyServiceTierPricing?: (
      usage: MutableAssistantOutput["usage"],
      serviceTier?: ResponseCreateParamsStreaming["service_tier"],
    ) => void;
    firstEventTimeoutMs?: number;
    abortFirstEventStream?: (reason: Error) => void;
    onFirstEventTimeout?: (reason: Error) => void;
    signal?: AbortSignal;
    sessionId?: string;
    authProfileId?: string;
  },
) {
  const resolveToolCallId = (item: Record<string, unknown>, fallbackId?: string): string => {
    const callId = stringifyUnknown(item.call_id).trim();
    const itemId = stringifyUnknown(item.id).trim();
    const [fallbackCallId = "", fallbackItemId = ""] = (fallbackId ?? "").split("|");
    const resolvedCallId = callId || fallbackCallId;
    const resolvedItemId = itemId || fallbackItemId;
    if (resolvedCallId) {
      return resolvedItemId ? `${resolvedCallId}|${resolvedItemId}` : resolvedCallId;
    }
    const generatedCallId = `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    return resolvedItemId ? `${generatedCallId}|${resolvedItemId}` : generatedCallId;
  };
  let currentItem: Record<string, unknown> | null = null;
  let currentBlock: Record<string, unknown> | null = null;
  type StreamingToolCallState = ResponsesToolCallState & {
    block: Record<string, unknown>;
    contentIndex: number;
  };
  const streamingToolCalls = createResponsesToolCallTracker<StreamingToolCallState>();
  let lastTextBlock: {
    block: Record<string, unknown>;
    index: number;
    phase: "commentary" | "final_answer" | undefined;
  } | null = null;
  // While a message item may still be a cumulative snapshot of lastTextBlock,
  // its public block is deferred so a collapsed item never leaves an
  // unbalanced text_start behind (#91959). null = no deferral in progress.
  let pendingMessageText: string | null = null;
  const streamStartedAt = Date.now();
  let eventCount = 0;
  const eventTypes = new Map<string, number>();
  const sseDebugMode = resolveModelSseDebugMode();
  const blockIndex = () => output.content.length - 1;
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
  const appendPendingMessageDelta = (delta: string) => {
    pendingMessageText = `${pendingMessageText ?? ""}${delta}`;
    const priorText = stringifyUnknown(lastTextBlock?.block.text);
    if (priorText.startsWith(pendingMessageText) || pendingMessageText.startsWith(priorText)) {
      return;
    }
    // Diverged from the prior text: this is a distinct message, so open its
    // block now and replay the withheld text as one delta.
    const phase =
      currentItem?.type === "message"
        ? ((currentItem.phase as "commentary" | "final_answer" | undefined) ?? undefined)
        : undefined;
    currentBlock = {
      type: "text",
      text: pendingMessageText,
      ...(currentItem?.type === "message" && phase
        ? {
            textSignature: encodeTextSignatureV1(stringifyUnknown(currentItem.id), phase),
          }
        : {}),
    };
    output.content.push(currentBlock);
    stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
    stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: pendingMessageText });
    pendingMessageText = null;
  };
  const appendTerminalResponseTextItem = (item: Record<string, unknown>) => {
    const text = readResponsesOutputMessageText(item);
    if (!text) {
      return;
    }
    const phase = (item.phase as "commentary" | "final_answer" | undefined) ?? undefined;
    const collapse = resolveResponsesMessageSnapshotCollapse({
      prior: lastTextBlock && {
        text: stringifyUnknown(lastTextBlock.block.text),
        phase: lastTextBlock.phase,
      },
      nextText: text,
      nextPhase: phase,
    });
    if (collapse.kind === "extend" && lastTextBlock) {
      // Cumulative snapshot of the prior message item: replace, don't append;
      // the newest item's signature carries the content for replay (#91959).
      lastTextBlock.block.text = collapse.text;
      lastTextBlock.block.textSignature = encodeTextSignatureV1(stringifyUnknown(item.id), phase);
      stream.push({
        type: "text_end",
        contentIndex: lastTextBlock.index,
        content: collapse.text,
        partial: output,
      });
      return;
    }
    const block: Record<string, unknown> = {
      type: "text",
      text,
      textSignature: encodeTextSignatureV1(stringifyUnknown(item.id), phase),
    };
    output.content.push(block);
    lastTextBlock = { block, index: blockIndex(), phase };
    stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
    stream.push({
      type: "text_end",
      contentIndex: blockIndex(),
      content: text,
      partial: output,
    });
  };
  const appendCompletedResponseToolCallItem = (item: Record<string, unknown>) => {
    const args = parseStreamingJson(stringifyJsonLike(item.arguments, "{}"));
    const name = resolveCompletedToolCallName(undefined, item.name);
    const block = {
      type: "toolCall",
      id: resolveToolCallId(item),
      name,
      arguments: args,
      partialJson: stringifyJsonLike(item.arguments, "{}"),
    };
    output.content.push(block);
    stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
    stream.push({
      type: "toolcall_end",
      contentIndex: blockIndex(),
      toolCall: {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: args,
      },
      partial: output,
    });
  };
  const backfillTerminalResponseOutput = (
    response: Record<string, unknown> | undefined,
    backfillOptions: { includeToolCalls: boolean },
  ) => {
    if (output.content.length > 0 || !Array.isArray(response?.output)) {
      return;
    }
    for (const rawItem of response.output) {
      if (!isRecord(rawItem)) {
        continue;
      }
      if (rawItem.type === "message") {
        appendTerminalResponseTextItem(rawItem);
        continue;
      }
      // Any non-message item (reasoning, tool call) is a real boundary; a later
      // message must not collapse across it, mirroring the streaming path.
      lastTextBlock = null;
      if (backfillOptions.includeToolCalls && rawItem.type === "function_call") {
        appendCompletedResponseToolCallItem(rawItem);
      }
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
  const cooperativeScheduler = createModelStreamCooperativeScheduler(options?.signal);
  for await (const rawEvent of guardedStream) {
    throwIfModelStreamAborted(options?.signal);
    const event = rawEvent as Record<string, unknown>;
    const type = stringifyUnknown(event.type);
    eventCount += 1;
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
    if (eventCount === 1) {
      emitModelTransportDebug(
        log,
        `[responses] first_event provider=${model.provider} api=${model.api} model=${model.id} ` +
          `elapsedMs=${Date.now() - streamStartedAt} type=${type}`,
      );
    }
    if (sseDebugMode === "peek" && eventCount <= 5) {
      emitModelTransportDebug(
        log,
        `[responses] event_peek provider=${model.provider} api=${model.api} model=${model.id} ` +
          `index=${eventCount} type=${type} event=${stringifyRedactedEvent(event)}`,
      );
    }
    if (type === "response.created") {
      output.responseId = stringifyUnknown((event.response as { id?: string } | undefined)?.id);
    } else if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
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
          const phase = (item.phase as "commentary" | "final_answer" | undefined) ?? undefined;
          currentBlock = {
            type: "text",
            text: "",
            ...(phase
              ? { textSignature: encodeTextSignatureV1(stringifyUnknown(item.id), phase) }
              : {}),
          };
          output.content.push(currentBlock);
          stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
        }
      } else if (item.type === "function_call") {
        const toolCallBlock: Record<string, unknown> = {
          type: "toolCall",
          id: resolveToolCallId(item),
          name: readIdentityValue(item.name) ?? "",
          arguments: {},
          partialJson: stringifyJsonLike(item.arguments),
        };
        const contentIndex = output.content.length;
        const toolCallState: StreamingToolCallState = {
          block: toolCallBlock,
          contentIndex,
          argumentStreamReliable: true,
          ...readResponsesToolCallItemIdentity(item),
        };
        streamingToolCalls.register(event, toolCallState);
        currentItem = item;
        currentBlock = toolCallBlock;
        output.content.push(toolCallBlock);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
      }
    } else if (type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = `${stringifyUnknown(currentBlock.thinking)}${stringifyUnknown(event.delta)}`;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
          partial: output,
        });
      }
    } else if (isResponsesTextDeltaEventType(type) || type === "response.refusal.delta") {
      if (currentItem?.type === "message") {
        if (pendingMessageText !== null) {
          appendPendingMessageDelta(stringifyUnknown(event.delta));
        } else if (currentBlock?.type === "text") {
          currentBlock.text = `${stringifyUnknown(currentBlock.text)}${stringifyUnknown(event.delta)}`;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: stringifyUnknown(event.delta),
          });
        }
      }
    } else if (type === "response.function_call_arguments.delta") {
      const toolCall = streamingToolCalls.resolve(event);
      if (toolCall) {
        toolCall.block.partialJson = `${stringifyJsonLike(toolCall.block.partialJson)}${stringifyJsonLike(event.delta)}`;
        toolCall.block.arguments = parseStreamingJson(
          stringifyJsonLike(toolCall.block.partialJson),
        );
        stream.push({
          type: "toolcall_delta",
          contentIndex: toolCall.contentIndex,
          delta: stringifyJsonLike(event.delta),
          partial: output,
        });
      } else if (streamingToolCalls.hasActive()) {
        streamingToolCalls.markArgumentsUnreliable();
      }
    } else if (type === "response.function_call_arguments.done") {
      const toolCall = streamingToolCalls.resolve(event);
      if (toolCall) {
        const previousPartialJson = stringifyJsonLike(toolCall.block.partialJson);
        const doneArguments = typeof event.arguments === "string" ? event.arguments : undefined;
        if (
          doneArguments !== undefined &&
          (doneArguments.length > 0 || previousPartialJson === "")
        ) {
          toolCall.block.partialJson = doneArguments;
          toolCall.block.arguments = parseStreamingJson(doneArguments);
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
    } else if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown>;
      if (item.type !== "message") {
        lastTextBlock = null;
        pendingMessageText = null;
      }
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        const summary = Array.isArray(item.summary)
          ? item.summary
              .map((part) => {
                const summaryPart = part as { text?: string };
                return summaryPart.text ?? "";
              })
              .join("\n\n")
          : "";
        currentBlock.thinking = summary;
        currentBlock.thinkingSignature = JSON.stringify(item);
        if ("encrypted_content" in item) {
          currentBlock[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY] =
            buildOpenAIResponsesReasoningReplayMetadata(model, {
              authProfileId: options?.authProfileId,
              sessionId: options?.sessionId,
            });
        }
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: stringifyUnknown(currentBlock.thinking),
          partial: output,
        });
        currentBlock = null;
      } else if (
        item.type === "message" &&
        (currentBlock?.type === "text" || pendingMessageText !== null)
      ) {
        const content = Array.isArray(item.content) ? item.content : [];
        const finalText = content
          .map((part) => {
            const contentPart = part as { type?: string; text?: string; refusal?: string };
            return isResponsesTextContentPartType(contentPart.type)
              ? (contentPart.text ?? "")
              : (contentPart.refusal ?? "");
          })
          .join("");
        const phase = (item.phase as "commentary" | "final_answer" | undefined) ?? undefined;
        const collapse =
          pendingMessageText !== null
            ? resolveResponsesMessageSnapshotCollapse({
                prior: lastTextBlock && {
                  text: stringifyUnknown(lastTextBlock.block.text),
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
          lastTextBlock.block.textSignature = encodeTextSignatureV1(
            stringifyUnknown(item.id),
            phase,
          );
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
              ...(phase
                ? { textSignature: encodeTextSignatureV1(stringifyUnknown(item.id), phase) }
                : {}),
            };
            output.content.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text = finalText;
          currentBlock.textSignature = encodeTextSignatureV1(stringifyUnknown(item.id), phase);
          lastTextBlock = { block: currentBlock, index: blockIndex(), phase };
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: stringifyUnknown(currentBlock.text),
            partial: output,
          });
        }
        currentBlock = null;
      } else if (item.type === "function_call") {
        const streamingToolCall = streamingToolCalls.resolve(
          event,
          readResponsesToolCallItemIdentity(item),
        );
        // Do not turn an unresolved completion into a second public call while
        // an indexed call is still open. Its identity or index must match.
        if (!streamingToolCall && streamingToolCalls.hasActive()) {
          await cooperativeScheduler.afterEvent();
          continue;
        }
        const completedName = resolveCompletedToolCallName(streamingToolCall, item.name);
        const streamedPartialJson = streamingToolCall
          ? stringifyJsonLike(streamingToolCall.block.partialJson)
          : "";
        const completedArguments = typeof item.arguments === "string" ? item.arguments : undefined;
        if (streamingToolCall && !streamingToolCall.argumentStreamReliable && !completedArguments) {
          await cooperativeScheduler.afterEvent();
          continue;
        }
        const finalPartialJson =
          completedArguments !== undefined &&
          (completedArguments.length > 0 || !streamedPartialJson)
            ? completedArguments
            : streamedPartialJson || "{}";
        const args = parseStreamingJson(finalPartialJson);
        let toolCallBlock: Record<string, unknown>;
        let contentIndex: number;
        if (streamingToolCall) {
          toolCallBlock = streamingToolCall.block;
          contentIndex = streamingToolCall.contentIndex;
        } else {
          toolCallBlock = {
            type: "toolCall",
            id: resolveToolCallId(item),
            name: completedName,
            arguments: args,
            partialJson: finalPartialJson,
          };
          output.content.push(toolCallBlock);
          contentIndex = blockIndex();
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        }
        const provisionalId = typeof toolCallBlock.id === "string" ? toolCallBlock.id : undefined;
        const currentToolCallId = resolveToolCallId(item, provisionalId);
        toolCallBlock.id = currentToolCallId;
        toolCallBlock.name = completedName;
        toolCallBlock.arguments = args;
        toolCallBlock.partialJson = finalPartialJson;
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: {
            type: "toolCall",
            id: currentToolCallId,
            name: completedName,
            arguments: args,
          },
          partial: output,
        });
        if (streamingToolCall) {
          streamingToolCalls.forget(streamingToolCall);
        }
        if (currentBlock === toolCallBlock) {
          currentBlock = null;
          currentItem = null;
        }
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      if (streamingToolCalls.hasActive()) {
        throw new Error("Responses stream completed with unresolved tool calls");
      }
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") {
        output.responseId = response.id;
      }
      if (type === "response.completed") {
        backfillTerminalResponseOutput(response, { includeToolCalls: true });
      }
      recordResponsesTerminalOutcome({
        response,
        output,
        model,
        serviceTier: options?.serviceTier,
        applyServiceTierPricing: options?.applyServiceTierPricing,
      });
      if (type === "response.incomplete" && output.stopReason === "length") {
        // Some compatible endpoints carry generated text only on the terminal event. Preserve
        // that partial answer, but never materialize an incomplete function call for execution.
        backfillTerminalResponseOutput(response, { includeToolCalls: false });
      }
    } else if (type === "error") {
      throw new Error(
        `Error Code ${stringifyUnknown(event.code, "unknown")}: ${stringifyUnknown(event.message, "Unknown error")}`,
      );
    } else if (type === "response.failed") {
      const failure = normalizeResponsesFailedEvent(event, model);
      if (failure.responseId) {
        output.responseId = failure.responseId;
      }
      if (failure.observation) {
        logResponsesFailedNoDetails(failure.observation);
      }
      throw new Error(failure.message);
    }
    await cooperativeScheduler.afterEvent();
  }
  if (streamingToolCalls.hasActive()) {
    throw new Error("Responses stream ended with unresolved tool calls");
  }
  const eventTypeSummary = [...eventTypes.entries()]
    .slice(0, 12)
    .map(([eventType, count]) => `${eventType}:${count}`)
    .join(",");
  emitModelTransportDebug(
    log,
    `[responses] stream_done provider=${model.provider} api=${model.api} model=${model.id} ` +
      `elapsedMs=${Date.now() - streamStartedAt} events=${eventCount} types=${eventTypeSummary} ` +
      `stopReason=${output.stopReason ?? "unset"} contentBlocks=${output.content.length}`,
  );
}

function readResponsesOutputMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (part.type === "output_text" || part.type === "text") {
        return stringifyUnknown(part.text);
      }
      if (part.type === "refusal") {
        return stringifyUnknown(part.refusal);
      }
      return "";
    })
    .join("");
}
