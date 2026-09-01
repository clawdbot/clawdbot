import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { measureUtf8AppendBytes } from "../transports/openai-transport-shared.js";
import { finalizeTerminalToolCallArguments } from "../transports/transport-stream-shared.js";
import type { ToolCall } from "../types.js";

type ChatCompletionToolCallDelta = ChatCompletionChunk.Choice.Delta.ToolCall;
const MAX_BUFFERED_TOOL_CALL_ARGUMENT_BYTES = 256_000;
const MAX_BUFFERED_LEGACY_FOLLOWING_DELTA_BYTES = 256_000;
const MAX_BUFFERED_LEGACY_FOLLOWING_DELTAS = 1_024;

type NormalizedOpenAICompletionsDelta = {
  delta: ChatCompletionChunk.Choice.Delta;
  toolCalls: ChatCompletionToolCallDelta[];
};

type OpenAICompletionsToolCallFinalizationOptions<TBlock extends object> = {
  allowSilentToolCallPromotion?: boolean;
  onConfirmedToolCall?: (block: TBlock, contentIndex: number) => void;
};

/** Keep encrypted provider reasoning attached to the first matching tool call. */
export function createOpenAIEncryptedToolCallReasoningTracker() {
  const firstBlocks = new Map<string, ToolCall>();
  const pendingDetails = new Map<string, string>();
  return {
    rememberToolCall(id: string, block: ToolCall) {
      if (!id || firstBlocks.has(id)) {
        return;
      }
      firstBlocks.set(id, block);
      const pendingDetail = pendingDetails.get(id);
      if (pendingDetail) {
        block.thoughtSignature = pendingDetail;
        pendingDetails.delete(id);
      }
    },
    consumeDetails(details: unknown) {
      if (!Array.isArray(details)) {
        return;
      }
      for (const detail of details) {
        if (
          !isRecord(detail) ||
          detail.type !== "reasoning.encrypted" ||
          typeof detail.id !== "string" ||
          detail.id.length === 0 ||
          typeof detail.data !== "string" ||
          detail.data.length === 0
        ) {
          continue;
        }
        const serializedDetail = JSON.stringify(detail);
        const matchingBlock = firstBlocks.get(detail.id);
        if (matchingBlock) {
          matchingBlock.thoughtSignature = serializedDetail;
        } else {
          pendingDetails.set(detail.id, serializedDetail);
        }
      }
    },
  };
}

/** Normalize the SDK's legacy single-function lane into its modern tool-call shape. */
export function createOpenAICompletionsToolCallDeltaNormalizer(): (
  delta: ChatCompletionChunk.Choice.Delta,
  finishReason: ChatCompletionChunk.Choice["finish_reason"],
) => NormalizedOpenAICompletionsDelta[] {
  let sawModernToolCall = false;
  let pendingLegacyArgumentBytes = 0;
  let pendingFollowingDeltaBytes = 0;
  let pendingLegacyToolCall: ChatCompletionToolCallDelta | undefined;
  type ModernArgumentState = { bytes: number; pendingHighSurrogate: boolean };
  const modernArguments = new Map<number | string, ModernArgumentState>();
  const pendingFollowingDeltas: ChatCompletionChunk.Choice.Delta[] = [];

  const takePendingFollowingDeltas = (): NormalizedOpenAICompletionsDelta[] => {
    pendingFollowingDeltaBytes = 0;
    return pendingFollowingDeltas.splice(0).map((delta) => ({ delta, toolCalls: [] }));
  };

  const bufferFollowingDelta = (delta: ChatCompletionChunk.Choice.Delta): void => {
    const nextDeltaBytes = Buffer.byteLength(JSON.stringify(delta), "utf8");
    if (
      pendingFollowingDeltaBytes + nextDeltaBytes > MAX_BUFFERED_LEGACY_FOLLOWING_DELTA_BYTES ||
      pendingFollowingDeltas.length >= MAX_BUFFERED_LEGACY_FOLLOWING_DELTAS
    ) {
      throw new Error("Exceeded legacy tool-call content buffer limit");
    }
    pendingFollowingDeltaBytes += nextDeltaBytes;
    pendingFollowingDeltas.push(delta);
  };

  const withoutToolCalls = (
    delta: ChatCompletionChunk.Choice.Delta,
  ): ChatCompletionChunk.Choice.Delta => {
    const ordinaryDelta = { ...delta };
    delete ordinaryDelta.function_call;
    delete ordinaryDelta.tool_calls;
    return ordinaryDelta;
  };

  const hasObservableContent = (value: unknown): boolean => {
    if (typeof value === "string") {
      return value.length > 0;
    }
    if (Array.isArray(value)) {
      return value.some(hasObservableContent);
    }
    if (isRecord(value)) {
      return Object.entries(value).some(
        ([field, nestedValue]) =>
          field !== "type" &&
          field !== "id" &&
          field !== "index" &&
          hasObservableContent(nestedValue),
      );
    }
    return false;
  };

  const hasOrdinaryContent = (delta: ChatCompletionChunk.Choice.Delta): boolean =>
    Object.entries(delta).some(([field, value]) => field !== "role" && hasObservableContent(value));

  return (delta, finishReason) => {
    const ordinaryDelta = withoutToolCalls(delta);
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const toolCall of delta.tool_calls) {
        const index = typeof toolCall.index === "number" ? toolCall.index : undefined;
        // Both consumers resolve index first, then id; bind every supplied alias
        // to one byte state so compatible id-only continuations cannot reset the cap.
        const state = (index === undefined ? undefined : modernArguments.get(index)) ??
          (toolCall.id ? modernArguments.get(toolCall.id) : undefined) ?? {
            bytes: 0,
            pendingHighSurrogate: false,
          };
        if (index !== undefined) {
          modernArguments.set(index, state);
        }
        if (toolCall.id) {
          modernArguments.set(toolCall.id, state);
        }
        const argumentDelta = toolCall.function?.arguments ?? "";
        const append = measureUtf8AppendBytes(state.pendingHighSurrogate, argumentDelta);
        state.bytes += append.bytes;
        if (state.bytes > MAX_BUFFERED_TOOL_CALL_ARGUMENT_BYTES) {
          throw new Error("Exceeded tool-call argument buffer limit");
        }
        state.pendingHighSurrogate = append.endsWithHighSurrogate;
      }
      const precedingDeltas = takePendingFollowingDeltas();
      sawModernToolCall = true;
      pendingLegacyArgumentBytes = 0;
      pendingLegacyToolCall = undefined;
      return [...precedingDeltas, { delta: ordinaryDelta, toolCalls: delta.tool_calls }];
    }

    const functionCall = delta.function_call;
    if (sawModernToolCall) {
      return [{ delta: ordinaryDelta, toolCalls: [] }];
    }

    const hadPendingLegacyCall = pendingLegacyToolCall !== undefined;
    const leadingDeltas: NormalizedOpenAICompletionsDelta[] = [];
    if (hasOrdinaryContent(ordinaryDelta)) {
      if (hadPendingLegacyCall) {
        // Keep every lane behind its provisional call; publishing text early
        // permanently reverses the assistant's original tool/content order.
        bufferFollowingDelta(ordinaryDelta);
      } else {
        leadingDeltas.push({ delta: ordinaryDelta, toolCalls: [] });
      }
    }

    if (functionCall && (functionCall.name || functionCall.arguments)) {
      // Legacy events are provisional until their terminal reason confirms no
      // modern call superseded them. Coalesce fragments so hostile empty/name
      // frames cannot create an unbounded queue or quadratic terminal parsing.
      const nextFunctionName = pendingLegacyToolCall?.function?.name
        ? undefined
        : functionCall.name;
      const nextArgumentBytes =
        Buffer.byteLength(functionCall.arguments ?? "", "utf8") +
        Buffer.byteLength(nextFunctionName ?? "", "utf8");
      if (pendingLegacyArgumentBytes + nextArgumentBytes > MAX_BUFFERED_TOOL_CALL_ARGUMENT_BYTES) {
        throw new Error("Exceeded tool-call argument buffer limit");
      }
      pendingLegacyArgumentBytes += nextArgumentBytes;
      pendingLegacyToolCall ??= {
        index: 0,
        id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        type: "function",
        function: {},
      };
      const pendingFunction = (pendingLegacyToolCall.function ??= {});
      if (nextFunctionName) {
        pendingFunction.name = nextFunctionName;
      }
      if (functionCall.arguments) {
        pendingFunction.arguments = (pendingFunction.arguments ?? "") + functionCall.arguments;
      }
    }

    if (!pendingLegacyToolCall) {
      return leadingDeltas.length > 0 ? leadingDeltas : [{ delta: ordinaryDelta, toolCalls: [] }];
    }

    if (finishReason === "function_call") {
      const confirmedLegacyToolCall = pendingLegacyToolCall;
      pendingLegacyToolCall = undefined;
      pendingLegacyArgumentBytes = 0;
      return [
        ...leadingDeltas,
        { delta: {}, toolCalls: [confirmedLegacyToolCall] },
        ...takePendingFollowingDeltas(),
      ];
    }

    if (finishReason) {
      pendingLegacyArgumentBytes = 0;
      pendingLegacyToolCall = undefined;
      return [...leadingDeltas, ...takePendingFollowingDeltas()];
    }

    return leadingDeltas;
  };
}

/** Publish only executable calls; streaming scratch state never belongs in replay. */
export function finalizeOpenAICompletionsToolCalls<TBlock extends object>(
  output: { content: TBlock[]; stopReason: string; errorMessage?: string },
  options: OpenAICompletionsToolCallFinalizationOptions<TBlock> = {},
): void {
  const isToolCall = (block: TBlock) => (block as { type?: unknown }).type === "toolCall";
  const hasToolCalls = output.content.some(isToolCall);

  if (output.stopReason === "toolUse" && !hasToolCalls) {
    output.stopReason = "stop";
  }

  if (
    output.stopReason === "stop" &&
    hasToolCalls &&
    options.allowSilentToolCallPromotion !== false &&
    !output.content.some((block) => {
      const candidate = block as { type?: unknown; text?: unknown };
      return (
        candidate.type === "text" &&
        typeof candidate.text === "string" &&
        candidate.text.trim().length > 0
      );
    })
  ) {
    output.stopReason = "toolUse";
  }

  if (output.stopReason !== "toolUse") {
    if (hasToolCalls) {
      output.content = output.content.filter((block) => !isToolCall(block));
    }
    return;
  }

  type FinalToolCall = TBlock & {
    name?: unknown;
    arguments: Record<string, unknown>;
    partialArgs?: unknown;
  };
  const toolCalls = output.content.filter(isToolCall) as FinalToolCall[];
  const rejectToolCalls = () => {
    output.stopReason = "error";
    output.errorMessage = "Provider returned an incomplete or malformed tool call";
    output.content = output.content.filter((candidate) => !isToolCall(candidate));
  };
  if (
    toolCalls.some(
      (call) =>
        typeof call.name !== "string" ||
        call.name.trim().length === 0 ||
        typeof call.partialArgs !== "string" ||
        call.partialArgs.trim().length === 0,
    )
  ) {
    rejectToolCalls();
    return;
  }
  try {
    finalizeTerminalToolCallArguments(toolCalls, (call) => call.partialArgs);
  } catch {
    rejectToolCalls();
    return;
  }

  for (let contentIndex = 0; contentIndex < output.content.length; contentIndex += 1) {
    const block = output.content[contentIndex];
    if (!block || !isToolCall(block)) {
      continue;
    }
    delete (block as { partialArgs?: string }).partialArgs;
    delete (block as { streamIndex?: number }).streamIndex;
    options.onConfirmedToolCall?.(block, contentIndex);
  }
}
