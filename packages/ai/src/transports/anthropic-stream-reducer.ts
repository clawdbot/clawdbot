import type { AssistantMessage, AssistantMessageEvent, Model } from "@openclaw/llm-core";
import { appendAssistantThinking } from "@openclaw/llm-core/event-stream";
import {
  asRecord,
  asOptionalObjectRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { calculateCost } from "../model-utils.js";
import type { AnthropicOptions } from "../provider-options.js";
import { mapAnthropicStopReason } from "../providers/anthropic-model-contract.js";
import { applyAnthropicRefusal } from "../providers/anthropic-refusal.js";
import {
  applyAnthropicFallbackBoundary,
  readAnthropicFallbackBoundary,
  resolveAnthropicFallbackServingModelCost,
} from "../providers/anthropic-server-fallback.js";
import {
  logAnthropicThinkingDrops,
  readAnthropicInputTransformations,
} from "../providers/anthropic-thinking-replay.js";
import {
  resolveOriginalAnthropicToolName,
  type AnthropicToolProjection,
} from "../providers/anthropic-tool-projection.js";
import {
  applyAnthropicMessageDeltaUsage,
  applyAnthropicMessageStartUsage,
  type AnthropicPromptUsageSnapshot,
} from "../providers/anthropic-usage.js";
import { tagPendingCommentaryText } from "../utils/assistant-text-phase.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import {
  createToolArgumentPreviewSchedule,
  parseStreamingJson,
  type ToolArgumentPreviewSchedule,
} from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import { createCompactionCapture } from "./anthropic-compaction-replay.js";
import { isDirectAnthropicModel, logAnthropicContextEdits } from "./anthropic-payload-policy.js";
import { resolveProviderEndpoint } from "./host-policy.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./json-unsafe-integers.js";
import {
  coerceTransportToolCallArguments,
  finalizeTerminalToolCallArguments,
  sanitizeTransportPayloadText,
  transportAbortError,
  type WritableTransportStream,
} from "./transport-stream-shared.js";

export type AnthropicStreamBlock = AssistantMessage["content"][number] & {
  index?: number;
  partialJson?: string;
};

/** One Messages protocol reducer; entry points retain their established preview/replay contracts. */
export async function consumeAnthropicStream(params: {
  events: AsyncIterable<object> | Iterable<object>;
  model: Model<"anthropic-messages">;
  options: AnthropicOptions & { authProfileId?: string };
  output: AssistantMessage;
  stream: WritableTransportStream;
  refusalBuffer?: ReturnType<typeof createDeferredEventBuffer<AssistantMessageEvent>>;
  isOAuthToken: boolean;
  toolProjection?: AnthropicToolProjection;
  profile: "provider" | "transport";
}): Promise<void> {
  const { model, options, output, stream, refusalBuffer, isOAuthToken, toolProjection } = params;
  const managed = params.profile === "transport";
  const eventSink = refusalBuffer ?? stream;
  let costModel = model;
  let messageStartPromptUsage: AnthropicPromptUsageSnapshot | undefined;
  let inputTransformations: unknown[] | undefined;
  const anthropicStream = params.events;
  try {
    const blocks: AnthropicStreamBlock[] = output.content;
    const blockIndexes = new Map<number, number>();
    // Preview schedules are per active tool call; WeakMap keys die with the block.
    const toolArgumentPreviewSchedules = new WeakMap<
      Extract<AnthropicStreamBlock, { type: "toolCall" }>,
      ToolArgumentPreviewSchedule
    >();
    const seededToolArguments = new WeakMap<AnthropicStreamBlock, unknown>();
    const sealedToolCalls: Array<{
      block: Extract<AnthropicStreamBlock, { type: "toolCall" }>;
      contentIndex: number;
    }> = [];
    const compactionCapture = createCompactionCapture(output, model, options);
    // Signature deltas are opaque and only complete at content_block_stop.
    // Keep partial bytes out of output so interrupted streams cannot poison replay.
    const pendingThinkingSignatures = new Map<number, string>();
    const allowReasoningContentReplay =
      managed && resolveProviderEndpoint(model).endpointClass === "xiaomi-native";
    const reasoningContentThinkingBlocks = new Map<number, number>();
    const reasoningContentTextBlocks = new Map<number, number>();
    let sawMessageStop = false;
    const pendingTextEnds: Array<Extract<AssistantMessageEvent, { type: "text_end" }>> = [];
    // Hold text_end until tool-boundary classification is known.
    const flushPendingTextEnds = () => {
      for (const event of pendingTextEnds) {
        eventSink.push(event);
      }
      pendingTextEnds.length = 0;
    };
    const emitTextEnd = (event: Extract<AssistantMessageEvent, { type: "text_end" }>) => {
      if (managed) {
        pendingTextEnds.push(event);
      } else {
        eventSink.push(event);
      }
    };
    const eventIndexKey = (eventIndex: unknown) =>
      typeof eventIndex === "number" ? eventIndex : -1;
    const appendReasoningContentThinkingDelta = (
      eventIndex: unknown,
      rawText: unknown,
    ): boolean => {
      if (typeof rawText !== "string") {
        return false;
      }
      const text = sanitizeTransportPayloadText(rawText);
      if (text.length === 0) {
        return false;
      }
      const key = eventIndexKey(eventIndex);
      let contentIndex = reasoningContentThinkingBlocks.get(key);
      let block = contentIndex === undefined ? undefined : blocks[contentIndex];
      if (!block || block.type !== "thinking") {
        block = { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" };
        output.content.push(block);
        contentIndex = output.content.length - 1;
        reasoningContentThinkingBlocks.set(key, contentIndex);
        eventSink.push({
          type: "thinking_start",
          contentIndex,
          partial: output,
        });
      }
      if (contentIndex === undefined) {
        return false;
      }
      appendAssistantThinking(block, text);
      block.thinkingSignature = "reasoning_content";
      eventSink.push({
        type: "thinking_delta",
        contentIndex,
        delta: text,
        partial: output,
      });
      return true;
    };
    const appendReasoningContentTextDelta = (eventIndex: unknown, rawText: unknown): boolean => {
      if (typeof rawText !== "string") {
        return false;
      }
      const text = sanitizeTransportPayloadText(rawText);
      if (text.length === 0) {
        return false;
      }
      const key = eventIndexKey(eventIndex);
      let contentIndex = reasoningContentTextBlocks.get(key);
      let block = contentIndex === undefined ? undefined : blocks[contentIndex];
      if (!block || block.type !== "text") {
        block = { type: "text", text: "" };
        output.content.push(block);
        contentIndex = output.content.length - 1;
        reasoningContentTextBlocks.set(key, contentIndex);
        eventSink.push({
          type: "text_start",
          contentIndex,
          partial: output,
        });
      }
      if (contentIndex === undefined) {
        return false;
      }
      block.text += text;
      eventSink.push({
        type: "text_delta",
        contentIndex,
        delta: text,
        partial: output,
      });
      return true;
    };
    const finishReasoningContentSidecars = (eventIndex: unknown) => {
      const key = eventIndexKey(eventIndex);
      const thinkingContentIndex = reasoningContentThinkingBlocks.get(key);
      if (thinkingContentIndex !== undefined) {
        reasoningContentThinkingBlocks.delete(key);
        const block = output.content[thinkingContentIndex];
        if (block?.type === "thinking") {
          eventSink.push({
            type: "thinking_end",
            contentIndex: thinkingContentIndex,
            content: block.thinking,
            partial: output,
          });
        }
      }
      const textContentIndex = reasoningContentTextBlocks.get(key);
      if (textContentIndex === undefined) {
        return;
      }
      reasoningContentTextBlocks.delete(key);
      const block = output.content[textContentIndex];
      if (block?.type === "text") {
        eventSink.push({
          type: "text_end",
          contentIndex: textContentIndex,
          content: block.text,
          partial: output,
        });
      }
    };
    for await (const rawEvent of anthropicStream) {
      const event = asRecord(rawEvent);
      // A serving-model fallback replaces the initial snapshot; report only once at completion.
      inputTransformations = readAnthropicInputTransformations(event) ?? inputTransformations;
      if (managed) {
        notifyLlmRequestActivity(options.signal);
      }
      if (event.type === "error") {
        const error = asOptionalObjectRecord(event.error);
        throw new Error(readStringField(error, "message") || "Anthropic Messages stream failed");
      }
      if (event.type === "message_start") {
        const message = asOptionalObjectRecord(event.message);
        const usage = asRecord(message?.usage);
        output.responseId = typeof message?.id === "string" ? message.id : undefined;
        output.responseModel = typeof message?.model === "string" ? message.model : undefined;
        messageStartPromptUsage = applyAnthropicMessageStartUsage(output.usage, usage);
        calculateCost(costModel, output.usage);
        // Defer start until after message_start so that pre-stream SSE errors
        // (e.g. invalid thinking signatures) arrive before any non-error event
        // is yielded, keeping yieldedOutput=false in pumpStreamWithRecovery
        // and allowing the thinking-block recovery retry to fire.
        eventSink.push({ type: "start", partial: output });
        continue;
      }
      if (event.type === "message_stop") {
        sawMessageStop = true;
        continue;
      }
      if (event.type === "content_block_start") {
        const contentBlock = asOptionalObjectRecord(event.content_block);
        const index = typeof event.index === "number" ? event.index : -1;
        if (
          options.anthropicServerCompaction === true &&
          compactionCapture.begin(index, contentBlock, output.content.length)
        ) {
          continue;
        }
        const fallbackBoundary = refusalBuffer ? readAnthropicFallbackBoundary(contentBlock) : null;
        if (fallbackBoundary) {
          // Server-side fallback boundary: pre-boundary thinking/tool
          // blocks must not replay or execute, and the buffered preview
          // events reference them, so rebuild the deferred timeline from
          // the surviving text prefix the fallback model continued from.
          refusalBuffer?.discard();
          sealedToolCalls.length = 0;
          pendingTextEnds.length = 0;
          blockIndexes.clear();
          pendingThinkingSignatures.clear();
          applyAnthropicFallbackBoundary({
            output,
            boundary: fallbackBoundary,
            provider: model.provider,
          });
          // Fallback-only iteration partials stay outside the serving-model
          // estimate. Compaction responses are the exception: usage policy
          // aggregates their complete billed iteration list.
          costModel = {
            ...model,
            cost: resolveAnthropicFallbackServingModelCost({
              requestedModelId: model.id,
              servingModelId: fallbackBoundary.toModel,
              requestedCost: model.cost,
            }),
          };
          calculateCost(costModel, output.usage);
          eventSink.push({ type: "start", partial: output });
          for (const [i, block] of blocks.entries()) {
            if (block.type !== "text") {
              continue;
            }
            delete block.index;
            eventSink.push({
              type: "text_start",
              contentIndex: i,
              partial: output,
            });
            if (block.text) {
              eventSink.push({
                type: "text_delta",
                contentIndex: i,
                delta: block.text,
                partial: output,
              });
            }
            emitTextEnd({
              type: "text_end",
              contentIndex: i,
              content: block.text,
              partial: output,
            });
          }
          continue;
        }
        pendingThinkingSignatures.delete(index);
        if (contentBlock?.type === "text") {
          const text =
            typeof contentBlock.text === "string"
              ? sanitizeTransportPayloadText(contentBlock.text)
              : "";
          const block: AnthropicStreamBlock = { type: "text", text, index };
          output.content.push(block);
          const contentIndex = output.content.length - 1;
          blockIndexes.set(index, contentIndex);
          eventSink.push({
            type: "text_start",
            contentIndex,
            partial: output,
          });
          if (text.length > 0) {
            eventSink.push({
              type: "text_delta",
              contentIndex,
              delta: text,
              partial: output,
            });
          }
          continue;
        }
        if (contentBlock?.type === "thinking") {
          const thinking = typeof contentBlock.thinking === "string" ? contentBlock.thinking : "";
          const block: AnthropicStreamBlock = {
            type: "thinking",
            thinking,
            thinkingSignature:
              typeof contentBlock.signature === "string" ? contentBlock.signature : "",
            index,
          };
          output.content.push(block);
          const contentIndex = output.content.length - 1;
          blockIndexes.set(index, contentIndex);
          eventSink.push({
            type: "thinking_start",
            contentIndex,
            partial: output,
          });
          if (thinking.length > 0) {
            eventSink.push({
              type: "thinking_delta",
              contentIndex,
              delta: thinking,
              partial: output,
            });
          }
          continue;
        }
        if (contentBlock?.type === "redacted_thinking") {
          const block: AnthropicStreamBlock = {
            type: "thinking",
            thinking: "[Reasoning redacted]",
            thinkingSignature: typeof contentBlock.data === "string" ? contentBlock.data : "",
            redacted: true,
            index,
          };
          output.content.push(block);
          blockIndexes.set(index, output.content.length - 1);
          eventSink.push({
            type: "thinking_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
          continue;
        }
        if (contentBlock?.type === "tool_use") {
          if (managed) {
            tagPendingCommentaryText(output.content);
          }
          flushPendingTextEnds();
          const block: AnthropicStreamBlock = {
            type: "toolCall",
            id: typeof contentBlock.id === "string" ? contentBlock.id : "",
            name:
              typeof contentBlock.name === "string"
                ? isOAuthToken
                  ? resolveOriginalAnthropicToolName(contentBlock.name, toolProjection)
                  : contentBlock.name
                : "",
            arguments: asRecord(contentBlock.input),
            partialJson: "",
            index,
          };
          output.content.push(block);
          blockIndexes.set(index, output.content.length - 1);
          // Standalone callers may supply encoded input; terminal validation owns its shape.
          seededToolArguments.set(block, managed ? block.arguments : (contentBlock.input ?? {}));
          toolArgumentPreviewSchedules.set(block, createToolArgumentPreviewSchedule());
          eventSink.push({
            type: "toolcall_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        }
        continue;
      }
      if (event.type === "content_block_delta") {
        const delta = asOptionalObjectRecord(event.delta);
        const eventIndex = typeof event.index === "number" ? event.index : undefined;
        if (eventIndex !== undefined && compactionCapture.delta(eventIndex, delta)) {
          continue;
        }
        let index = eventIndex === undefined ? undefined : blockIndexes.get(eventIndex);
        let block = index === undefined ? undefined : blocks[index];
        if (allowReasoningContentReplay) {
          const appendedThinking = appendReasoningContentThinkingDelta(
            event.index,
            delta?.reasoning_content,
          );
          const hasNativeAnthropicDelta =
            (delta?.type === "text_delta" && typeof delta.text === "string") ||
            (delta?.type === "thinking_delta" && typeof delta.thinking === "string") ||
            (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") ||
            (delta?.type === "signature_delta" && typeof delta.signature === "string");
          let appendedContent = false;
          if (
            !hasNativeAnthropicDelta &&
            typeof delta?.content === "string" &&
            delta.content.length > 0
          ) {
            const text = sanitizeTransportPayloadText(delta.content);
            if (text.length > 0) {
              if (block?.type === "text" && index !== undefined) {
                block.text += text;
                eventSink.push({
                  type: "text_delta",
                  contentIndex: index,
                  delta: text,
                  partial: output,
                });
                appendedContent = true;
              } else {
                appendedContent = appendReasoningContentTextDelta(event.index, text);
              }
            }
          }
          if ((appendedThinking || appendedContent) && !hasNativeAnthropicDelta) {
            continue;
          }
        }
        if (managed && !block && delta?.type === "text_delta" && typeof delta.text === "string") {
          const recoveredIndex = typeof event.index === "number" ? event.index : blocks.length;
          block = { type: "text", text: "", index: recoveredIndex };
          output.content.push(block);
          index = output.content.length - 1;
          if (typeof event.index === "number") {
            blockIndexes.set(event.index, index);
          }
          eventSink.push({
            type: "text_start",
            contentIndex: index,
            partial: output,
          });
        }
        if (index === undefined) {
          continue;
        }
        if (
          block?.type === "text" &&
          delta?.type === "text_delta" &&
          typeof delta.text === "string"
        ) {
          block.text += delta.text;
          eventSink.push({
            type: "text_delta",
            contentIndex: index,
            delta: delta.text,
            partial: output,
          });
          continue;
        }
        if (
          block?.type === "thinking" &&
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          appendAssistantThinking(block, delta.thinking);
          eventSink.push({
            type: "thinking_delta",
            contentIndex: index,
            delta: delta.thinking,
            partial: output,
          });
          continue;
        }
        if (
          block?.type === "toolCall" &&
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const partialJson = `${block.partialJson ?? ""}${delta.partial_json}`;
          block.partialJson = partialJson;
          // Preview refresh is scheduled geometrically; content_block_stop
          // re-parses the full buffer authoritatively either way.
          if (toolArgumentPreviewSchedules.get(block)?.(partialJson.length)) {
            block.arguments = managed
              ? coerceTransportToolCallArguments(
                  parseJsonObjectPreservingUnsafeIntegers(partialJson) ??
                    parseStreamingJson(partialJson),
                )
              : parseStreamingJson(partialJson);
          }
          eventSink.push({
            type: "toolcall_delta",
            contentIndex: index,
            delta: delta.partial_json,
            partial: output,
          });
          continue;
        }
        if (
          block?.type === "thinking" &&
          delta?.type === "signature_delta" &&
          typeof delta.signature === "string"
        ) {
          const signatureIndex = eventIndexKey(event.index);
          const pendingSignature = pendingThinkingSignatures.get(signatureIndex);
          if (pendingSignature === undefined) {
            // The streamed signature replaces any seed from content_block_start.
            block.thinkingSignature = "";
            pendingThinkingSignatures.set(signatureIndex, delta.signature);
          } else {
            pendingThinkingSignatures.set(signatureIndex, pendingSignature + delta.signature);
          }
        }
        continue;
      }
      if (event.type === "content_block_stop") {
        const eventIndex = typeof event.index === "number" ? event.index : undefined;
        if (eventIndex !== undefined && compactionCapture.complete(eventIndex)) {
          continue;
        }
        const pendingSignature =
          eventIndex === undefined ? undefined : pendingThinkingSignatures.get(eventIndex);
        if (eventIndex !== undefined) {
          pendingThinkingSignatures.delete(eventIndex);
        }
        const index = eventIndex === undefined ? undefined : blockIndexes.get(eventIndex);
        const block = index === undefined ? undefined : blocks[index];
        if (eventIndex === undefined || index === undefined || !block) {
          finishReasoningContentSidecars(event.index);
          continue;
        }
        blockIndexes.delete(eventIndex);
        delete block.index;
        if (block.type === "text") {
          emitTextEnd({
            type: "text_end",
            contentIndex: index,
            content: block.text,
            partial: output,
          });
          finishReasoningContentSidecars(event.index);
          continue;
        }
        if (block.type === "thinking") {
          if (pendingSignature !== undefined) {
            block.thinkingSignature = pendingSignature;
          }
          eventSink.push({
            type: "thinking_end",
            contentIndex: index,
            content: block.thinking,
            partial: output,
          });
          finishReasoningContentSidecars(event.index);
          continue;
        }
        if (block.type === "toolCall") {
          sealedToolCalls.push({ block, contentIndex: index });
          finishReasoningContentSidecars(event.index);
        }
        continue;
      }
      if (event.type === "message_delta") {
        logAnthropicContextEdits(event);
        const delta = asOptionalObjectRecord(event.delta);
        const usage = asOptionalObjectRecord(event.usage);
        if (typeof delta?.stop_reason === "string" && delta.stop_reason) {
          if (delta.stop_reason === "refusal") {
            applyAnthropicRefusal(output, delta.stop_details, model.provider);
          } else {
            output.stopReason = mapAnthropicStopReason(delta.stop_reason);
          }
        }
        applyAnthropicMessageDeltaUsage(output.usage, usage, messageStartPromptUsage);
        calculateCost(costModel, output.usage);
        // Gate on the turn CONTAINING a tool call, not the provider's stop_reason
        // label: Bedrock/Vertex-proxied routes (e.g. pioneer) report "end_turn" on
        // tool-using turns. No-op for direct Anthropic (already "toolUse" here).
        if (
          managed &&
          (output.stopReason === "toolUse" ||
            output.content.some((block) => block.type === "toolCall"))
        ) {
          tagPendingCommentaryText(output.content);
        }
        flushPendingTextEnds();
      }
    }
    // Anthropic completes every SSE response with message_stop. Compatible
    // proxy providers are not held to that first-party transport contract.
    if ((isDirectAnthropicModel(model) || (!managed && refusalBuffer)) && !sawMessageStop) {
      throw new Error("Anthropic stream ended before message_stop");
    }
    if (options.signal?.aborted) {
      throw transportAbortError(options.signal);
    }
    if (output.stopReason === "aborted" || output.stopReason === "error") {
      throw new Error(output.errorMessage ?? "An unknown error occurred");
    }
    if ([...blockIndexes.values()].some((index) => blocks[index]?.type === "toolCall")) {
      throw new Error("Provider completed stream with an incomplete tool call");
    }
    // Fine-grained tool streaming delivers tool input without server-side JSON
    // validation, so repair invalid string literals before rejecting the turn.
    finalizeTerminalToolCallArguments(
      sealedToolCalls.map(({ block }) => block),
      (block) =>
        block.partialJson && block.partialJson.length > 0
          ? block.partialJson
          : seededToolArguments.get(block),
      undefined,
      { repairStringLiterals: true },
    );
    for (const sealed of sealedToolCalls) {
      delete sealed.block.partialJson;
      eventSink.push({
        type: "toolcall_end",
        contentIndex: sealed.contentIndex,
        toolCall: sealed.block,
        partial: output,
      });
    }
    refusalBuffer?.flush();
    // Backstop: streaming tags commentary at the tool-boundary above, but
    // replay/non-streaming assembly may reach here with tool calls untagged.
    // Idempotent, so it never double-tags the streaming path. Gate on the turn
    // containing a tool call (not stop_reason) so proxied Bedrock/Vertex routes
    // that mislabel tool turns as "end_turn" still tag their narration.
    if (
      managed &&
      (output.stopReason === "toolUse" || output.content.some((block) => block.type === "toolCall"))
    ) {
      tagPendingCommentaryText(output.content);
    }
    flushPendingTextEnds();
  } finally {
    logAnthropicThinkingDrops(inputTransformations);
  }
}
