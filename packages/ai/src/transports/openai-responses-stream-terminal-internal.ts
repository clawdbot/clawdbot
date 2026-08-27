import { randomUUID } from "node:crypto";
import type {
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../model-utils.js";
import { resolveResponsesMessageSnapshotCollapse } from "../providers/openai-responses-stream-compat.js";
import {
  mapResponsesTerminalUsage,
  readResponsesReasoningTokens,
  resolveResponsesTerminalStopReason,
} from "../providers/openai-responses-terminal-usage.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  TextContent,
  TextSignatureV1,
  ThinkingContent,
  ToolCall,
  Usage,
} from "../types.js";
import { captureOpenAIResponsesCompaction } from "./openai-responses-compaction-replay.js";
import {
  OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE,
  OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY,
  type OpenAIResponsesReasoningReplayMetadata,
} from "./openai-responses-contracts.js";
import { encodeTextSignatureV1 } from "./openai-responses-replay-internal.js";
import type { ResponsesOutputTracker } from "./openai-responses-stream-slots-internal.js";
import { parseTerminalToolCallArguments } from "./transport-stream-shared.js";

export type ResponsesEventSink = { push(event: AssistantMessageEvent): void };
export type TextBlockReference = {
  block: TextContent;
  index: number;
  phase: TextSignatureV1["phase"] | undefined;
};
export type ResponsesThinkingBlock = ThinkingContent & {
  [OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY]?: OpenAIResponsesReasoningReplayMetadata;
};

type TerminalOutput = AssistantMessage & {
  usage: Usage & { reasoningTokens?: number };
};
type TerminalOptions = {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  resolveServiceTier?: (
    responseTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    requestTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => ResponseCreateParamsStreaming["service_tier"] | undefined;
  applyServiceTierPricing?: (
    usage: Usage,
    tier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
  reasoningReplayMetadata?: OpenAIResponsesReasoningReplayMetadata;
};

function splitToolCallId(id: string): [string, string | undefined] {
  const separator = id.indexOf("|");
  return separator === -1 ? [id, undefined] : [id.slice(0, separator), id.slice(separator + 1)];
}

export function resolveResponsesToolCallId(
  item: { call_id?: unknown; id?: unknown },
  fallbackId?: string,
): string {
  const callId = typeof item.call_id === "string" ? item.call_id.trim() : "";
  const itemId = typeof item.id === "string" ? item.id.trim() : "";
  const [fallbackCallId, fallbackItemId = ""] = splitToolCallId(fallbackId ?? "");
  const resolvedCallId = callId || fallbackCallId;
  const resolvedItemId = itemId || fallbackItemId;
  if (resolvedCallId) {
    return resolvedItemId ? `${resolvedCallId}|${resolvedItemId}` : resolvedCallId;
  }
  const generated = `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  return resolvedItemId ? `${generated}|${resolvedItemId}` : generated;
}

export function resolveCompletedResponsesToolCall(
  item: Extract<ResponseOutputItem, { type: "function_call" }>,
  streamed?: { name?: string; arguments?: string },
): Pick<ToolCall, "name" | "arguments"> {
  if (item.status && item.status !== "completed") {
    throw new Error("Responses stream completed with an incomplete terminal tool call");
  }
  const streamedName = streamed?.name?.trim() || undefined;
  const completedName = typeof item.name === "string" ? item.name.trim() || undefined : undefined;
  if (streamedName && completedName && streamedName !== completedName) {
    throw new Error(
      `Responses stream changed tool-call function name from ${streamedName} to ${completedName}`,
    );
  }
  const name = completedName ?? streamedName;
  if (!name) {
    throw new Error("Responses stream completed tool call without a function name");
  }
  const argumentsValue = parseTerminalToolCallArguments(
    streamed?.arguments ?? item.arguments,
    "Responses stream completed tool call with invalid JSON arguments",
  );
  return { name, arguments: argumentsValue };
}

export function createResponsesTerminalController(params: {
  output: TerminalOutput;
  stream: ResponsesEventSink;
  model: Model;
  options?: TerminalOptions;
  outputs: ResponsesOutputTracker;
  getLastTextBlock: () => TextBlockReference | null;
  setLastTextBlock: (block: TextBlockReference | null) => void;
  markFinalized: () => void;
}) {
  const { output, stream, model, options } = params;
  const blocks = output.content;
  const backfillReasoning = (items: ResponseOutputItem[]) => {
    for (const [outputIndex, item] of items.entries()) {
      if (item.type !== "reasoning" || !item.encrypted_content) {
        continue;
      }
      const tracked = params.outputs.get(item, outputIndex);
      const block = tracked && blocks[tracked.contentIndex];
      if (block?.type !== "thinking" || !block.thinkingSignature) {
        continue;
      }
      const stored = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
      if (!stored.encrypted_content) {
        block.thinkingSignature = JSON.stringify({
          ...stored,
          encrypted_content: item.encrypted_content,
        });
      }
      if (options?.reasoningReplayMetadata) {
        Object.assign(block, {
          [OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY]: options.reasoningReplayMetadata,
        });
      }
    }
  };
  const appendText = (item: ResponseOutputMessage, contentIndex?: number): number | undefined => {
    const text = (Array.isArray(item.content) ? item.content : [])
      .map((part) => {
        const content = part as { type: string; text?: string; refusal?: string };
        return content.type === "output_text" || content.type === "text"
          ? (content.text ?? "")
          : (content.refusal ?? "");
      })
      .join("");
    const block = contentIndex === undefined ? undefined : blocks[contentIndex];
    const started = block?.type === "text" ? block : undefined;
    if (!text && !started) {
      return undefined;
    }
    const phase = item.phase ?? undefined;
    if (started && contentIndex !== undefined) {
      const previousText = started.text;
      started.text = text;
      started.textSignature = encodeTextSignatureV1(item.id, phase);
      params.setLastTextBlock({ block: started, index: contentIndex, phase });
      if (text.startsWith(previousText)) {
        const delta = text.slice(previousText.length);
        if (delta) {
          stream.push({ type: "text_delta", contentIndex, delta });
        }
      }
      stream.push({
        type: "text_end",
        contentIndex,
        content: text,
        partial: output,
      });
      return contentIndex;
    }
    const previous = params.getLastTextBlock();
    const collapse = resolveResponsesMessageSnapshotCollapse({
      prior: previous && { text: previous.block.text, phase: previous.phase },
      nextText: text,
      nextPhase: phase,
    });
    if (collapse.kind === "extend" && previous) {
      previous.block.text = collapse.text;
      previous.block.textSignature = encodeTextSignatureV1(item.id, phase);
      stream.push({
        type: "text_end",
        contentIndex: previous.index,
        content: collapse.text,
        partial: output,
      });
      return previous.index;
    }
    const newBlock: TextContent = {
      type: "text",
      text,
      textSignature: encodeTextSignatureV1(item.id, phase),
    };
    blocks.push(newBlock);
    const index = blocks.length - 1;
    params.setLastTextBlock({ block: newBlock, index, phase });
    stream.push({ type: "text_start", contentIndex: index, partial: output });
    stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
    return index;
  };
  const appendToolCall = (item: Extract<ResponseOutputItem, { type: "function_call" }>): number => {
    const validated = resolveCompletedResponsesToolCall(item);
    const toolCall: ToolCall = {
      type: "toolCall",
      id: resolveResponsesToolCallId(item),
      name: validated.name,
      arguments: validated.arguments,
    };
    blocks.push(toolCall);
    const contentIndex = blocks.length - 1;
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
    return contentIndex;
  };
  const recoverTerminalOutput = (items: ResponseOutputItem[], includeToolCalls: boolean) => {
    let hasCompletedLaterOutput = false;
    for (const [outputIndex, item] of [...items.entries()].toReversed()) {
      const tracked = params.outputs.get(item, outputIndex);
      if (item.type === "reasoning") {
        // Terminal snapshots only backfill streamed reasoning; missing reasoning is never emitted.
        hasCompletedLaterOutput ||= tracked !== undefined;
        continue;
      }
      if (item.type !== "message" && item.type !== "function_call") {
        continue;
      }
      if (tracked) {
        hasCompletedLaterOutput = true;
        continue;
      }
      if (item.type === "function_call" && !includeToolCalls) {
        continue;
      }
      // Previously emitted content indexes cannot be reordered after a missing earlier item.
      if (hasCompletedLaterOutput) {
        throw new Error("Responses stream omitted an output item before completed output");
      }
      if (item.type === "function_call") {
        resolveCompletedResponsesToolCall(item);
      }
    }
    for (const [terminalIndex, item] of items.entries()) {
      if (item.type === "message") {
        const tracked = params.outputs.get(item, terminalIndex);
        if (tracked?.completed) {
          continue;
        }
        const appendedIndex = appendText(item, tracked?.contentIndex);
        if (appendedIndex !== undefined) {
          params.outputs.set(item, appendedIndex, terminalIndex, true);
        }
      } else {
        params.setLastTextBlock(null);
        const alreadyCapturedCompaction =
          item.type === "compaction" &&
          output.providerReplay?.type === OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE &&
          output.providerReplay.id === item.id &&
          output.providerReplay.data === item.encrypted_content;
        if (item.type === "compaction" && !alreadyCapturedCompaction) {
          let replayIndex = blocks.length;
          for (const [laterIndex, laterItem] of items.entries()) {
            if (laterIndex <= terminalIndex) {
              continue;
            }
            const laterContentIndex = params.outputs.get(laterItem, laterIndex)?.contentIndex;
            if (laterContentIndex !== undefined) {
              replayIndex = laterContentIndex;
              break;
            }
          }
          captureOpenAIResponsesCompaction(
            output,
            item,
            replayIndex,
            model,
            options?.reasoningReplayMetadata,
          );
        } else if (includeToolCalls && item.type === "function_call") {
          if (params.outputs.get(item, terminalIndex)) {
            continue;
          }
          params.outputs.set(item, appendToolCall(item), terminalIndex, true);
        }
      }
    }
  };
  const finalizeTerminalFacts = (
    response: Extract<
      ResponseStreamEvent,
      { type: "response.completed" | "response.incomplete" | "response.failed" }
    >["response"],
    responseId = response.id,
  ) => {
    output.responseId = responseId || output.responseId;
    output.responseModel = response.model?.trim() || undefined;
    const usage = mapResponsesTerminalUsage(response.usage);
    const reasoningTokens = readResponsesReasoningTokens(response.usage);
    if (usage) {
      output.usage = {
        ...usage,
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }
    calculateCost(model, output.usage);
    if (options?.applyServiceTierPricing) {
      const tier = options.resolveServiceTier
        ? options.resolveServiceTier(response.service_tier, options.serviceTier)
        : (response.service_tier ?? options.serviceTier);
      options.applyServiceTierPricing(output.usage, tier);
    }
  };
  const finalizeResponse = (
    response: Extract<
      ResponseStreamEvent,
      { type: "response.completed" | "response.incomplete" }
    >["response"],
    terminalEventType: "response.completed" | "response.incomplete",
  ) => {
    params.markFinalized();
    backfillReasoning(response.output ?? []);
    finalizeTerminalFacts(response);
    const terminal = resolveResponsesTerminalStopReason({
      status: response.status,
      terminalEventType,
      incompleteReason: response.incomplete_details?.reason,
      hasToolCall: blocks.some((block) => block.type === "toolCall"),
    });
    output.stopReason = terminal.stopReason;
    output.errorMessage = terminal.errorMessage;
  };
  return { finalizeResponse, finalizeFailedResponse: finalizeTerminalFacts, recoverTerminalOutput };
}
