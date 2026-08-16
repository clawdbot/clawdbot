import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import type { AssistantMessage } from "../llm/types.js";
import { coerceChatContentText } from "../shared/chat-content.js";
import { isSubscribeTranscriptOnlyOpenClawAssistantMessage } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import {
  createThinkingTagStreamState,
  extractEmbeddedAssistantText,
} from "./embedded-agent-utils.js";
import type { AgentEvent, AgentMessage } from "./runtime/index.js";
import { hasRawToolValidationOutput } from "./tool-error-summary.js";
import {
  hasNonzeroUsage,
  makeZeroUsageSnapshot,
  normalizeUsage,
  type NormalizedUsage,
} from "./usage.js";

export function preservePendingAssistantUsage(
  message: AssistantMessage,
  pendingUsage: NormalizedUsage | undefined,
): AssistantMessage {
  if (
    isSubscribeTranscriptOnlyOpenClawAssistantMessage(message) ||
    !hasNonzeroUsage(pendingUsage)
  ) {
    return message;
  }
  const messageUsage = normalizeUsage(message.usage);
  if (hasNonzeroUsage(messageUsage)) {
    return message;
  }

  // Pending usage resets at each assistant-message boundary, so it belongs to
  // this final snapshot. Only replace missing/zero usage; provider totals win.
  const input = pendingUsage.input ?? 0;
  const output = pendingUsage.output ?? 0;
  const cacheRead = pendingUsage.cacheRead ?? 0;
  const cacheWrite = pendingUsage.cacheWrite ?? 0;
  message.usage = {
    ...makeZeroUsageSnapshot(),
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(pendingUsage.contextUsage ? { contextUsage: { ...pendingUsage.contextUsage } } : {}),
    totalTokens: pendingUsage.total ?? input + output + cacheRead + cacheWrite,
    ...(pendingUsage.reasoningTokens !== undefined
      ? { reasoningTokens: pendingUsage.reasoningTokens }
      : {}),
  };
  return message;
}

export function capturePendingAssistantUsage(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
): void {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }
  const assistantRecord = asOptionalRecord(evt.assistantMessageEvent);
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";
  if (evtType === "text_end" || evtType === "done" || evtType === "error") {
    ctx.recordAssistantUsage(assistantRecord);
  }
}

export function resetPendingAssistantUsage(
  ctx: EmbeddedAgentSubscribeContext,
  message: AgentMessage,
): void {
  if (message?.role !== "assistant" || isSubscribeTranscriptOnlyOpenClawAssistantMessage(message)) {
    return;
  }
  ctx.state.pendingAssistantUsage = undefined;
  ctx.state.assistantUsageCommitted = false;
}

/**
 * A tool-validation loop can echo the raw validation error back as assistant text.
 * Suppressing it keeps the retry invisible instead of publishing provider noise.
 */
export function shouldSuppressValidationLoopAssistantOutput(params: {
  message: AssistantMessage;
  assistantRecord?: Record<string, unknown>;
  validationErrorSummary?: string;
  text?: string;
}): boolean {
  if (!params.validationErrorSummary) {
    return false;
  }

  if (params.message.stopReason === "error") {
    return true;
  }

  const candidateText = [
    typeof params.assistantRecord?.delta === "string" ? params.assistantRecord.delta : "",
    typeof params.assistantRecord?.content === "string" ? params.assistantRecord.content : "",
    params.text ?? coerceChatContentText(extractEmbeddedAssistantText(params.message)),
  ]
    .filter(Boolean)
    .join("\n");
  return hasRawToolValidationOutput(candidateText);
}

export function resetMessageEndStreamingState(ctx: EmbeddedAgentSubscribeContext): void {
  ctx.state.deltaBuffer = "";
  ctx.state.thinkingTagStream = createThinkingTagStreamState();
  ctx.state.blockBuffer = "";
  ctx.blockChunker?.reset();
  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();
  ctx.state.blockState.fence = undefined;
  ctx.state.blockState.reasoningInlineCode = undefined;
  ctx.state.blockState.reasoningFence = undefined;
  ctx.state.blockState.reasoningPendingFenceFragment = undefined;
  ctx.state.blockState.finalInlineCode = undefined;
  ctx.state.blockState.finalFence = undefined;
  ctx.state.blockState.pendingFenceFragment = undefined;
  ctx.state.blockState.pendingTagFragment = undefined;
  ctx.state.partialBlockState.fence = undefined;
  ctx.state.partialBlockState.reasoningInlineCode = undefined;
  ctx.state.partialBlockState.reasoningFence = undefined;
  ctx.state.partialBlockState.reasoningPendingFenceFragment = undefined;
  ctx.state.partialBlockState.finalInlineCode = undefined;
  ctx.state.partialBlockState.finalFence = undefined;
  ctx.state.partialBlockState.pendingFenceFragment = undefined;
  ctx.state.partialBlockState.pendingTagFragment = undefined;
  ctx.state.lastStreamedAssistant = undefined;
  ctx.state.lastStreamedAssistantCleaned = undefined;
  ctx.state.reasoningStreamOpen = false;
}
