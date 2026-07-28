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
  AssistantMessageEvent,
  Model,
  TextContent,
  TextSignatureV1,
  ThinkingContent,
  ToolCall,
  Usage,
} from "../types.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import {
  OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY,
  type OpenAIResponsesReasoningReplayMetadata,
} from "./openai-responses-contracts.js";
import { encodeTextSignatureV1 } from "./openai-responses-replay-internal.js";

export type ResponsesEventSink = { push(event: AssistantMessageEvent): void };
export type TextBlockReference = {
  block: TextContent;
  index: number;
  phase: TextSignatureV1["phase"] | undefined;
};
export type ResponsesThinkingBlock = ThinkingContent & {
  [OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY]?: OpenAIResponsesReasoningReplayMetadata;
};

type TerminalOutput = {
  content: Array<TextContent | ThinkingContent | ToolCall>;
  usage: Usage & { reasoningTokens?: number };
  stopReason: string;
  responseId?: string;
  errorMessage?: string;
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

export function resolveCompletedToolCallName(
  toolCall: { block: { name: string } } | undefined,
  value: unknown,
): string {
  const streamedName = toolCall?.block.name.trim() || undefined;
  const completedName = typeof value === "string" ? value.trim() || undefined : undefined;
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
}

export function createResponsesTerminalController(params: {
  output: TerminalOutput;
  stream: ResponsesEventSink;
  model: Model;
  options?: TerminalOptions;
  reasoningBlocksById: Map<string, ResponsesThinkingBlock>;
  getLastTextBlock: () => TextBlockReference | null;
  setLastTextBlock: (block: TextBlockReference | null) => void;
  markFinalized: () => void;
}) {
  const { output, stream, model, options } = params;
  const blocks = output.content;
  const backfillReasoning = (items: ResponseOutputItem[]) => {
    for (const item of items) {
      if (item.type !== "reasoning" || !item.encrypted_content) {
        continue;
      }
      const block = params.reasoningBlocksById.get(item.id);
      if (!block?.thinkingSignature) {
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
        block[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY] = options.reasoningReplayMetadata;
      }
    }
  };
  const appendText = (item: ResponseOutputMessage) => {
    const text = (Array.isArray(item.content) ? item.content : [])
      .map((part) => {
        const content = part as { type: string; text?: string; refusal?: string };
        return content.type === "output_text" || content.type === "text"
          ? (content.text ?? "")
          : (content.refusal ?? "");
      })
      .join("");
    if (!text) {
      return;
    }
    const phase = item.phase ?? undefined;
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
        partial: output as never,
      });
      return;
    }
    const block: TextContent = {
      type: "text",
      text,
      textSignature: encodeTextSignatureV1(item.id, phase),
    };
    blocks.push(block);
    const index = blocks.length - 1;
    params.setLastTextBlock({ block, index, phase });
    stream.push({ type: "text_start", contentIndex: index, partial: output as never });
    stream.push({ type: "text_end", contentIndex: index, content: text, partial: output as never });
  };
  const appendToolCall = (item: Extract<ResponseOutputItem, { type: "function_call" }>) => {
    const toolCall: ToolCall = {
      type: "toolCall",
      id: resolveResponsesToolCallId(item),
      name: resolveCompletedToolCallName(undefined, item.name),
      arguments: parseStreamingJson(item.arguments || "{}"),
    };
    blocks.push(toolCall);
    const contentIndex = blocks.length - 1;
    stream.push({ type: "toolcall_start", contentIndex, partial: output as never });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output as never });
  };
  const recoverTerminalOutput = (items: ResponseOutputItem[], includeToolCalls: boolean) => {
    if (blocks.length > 0) {
      return;
    }
    for (const item of items) {
      if (item.type === "message") {
        appendText(item);
      } else {
        params.setLastTextBlock(null);
        if (includeToolCalls && item.type === "function_call") {
          appendToolCall(item);
        }
      }
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
    output.responseId = response.id || output.responseId;
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
    const terminal = resolveResponsesTerminalStopReason({
      status: response.status,
      terminalEventType,
      incompleteReason: response.incomplete_details?.reason,
      hasToolCall: blocks.some((block) => block.type === "toolCall"),
    });
    output.stopReason = terminal.stopReason;
    output.errorMessage = terminal.errorMessage;
  };
  return { finalizeResponse, recoverTerminalOutput };
}
