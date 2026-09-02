/**
 * Projects provider assistant messages into ordered visible stream state.
 */
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import {
  parseReplyDirectives,
  type ReplyDirectiveParseResult,
} from "../auto-reply/reply/reply-directives.js";
import { splitTrailingDirective } from "../auto-reply/reply/streaming-directives.js";
import type { AssistantMessage } from "../llm/types.js";
import { parseAssistantTextSignature } from "../shared/chat-message-content.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import { hasReplyDirectiveMetadata } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import type {
  AssistantStreamData,
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
} from "./embedded-agent-subscribe.handlers.types.js";
import {
  extractAssistantCommentaryText,
  extractAssistantVisibleText,
} from "./embedded-agent-utils.js";
import type { AgentMessage } from "./runtime/index.js";

export function extractAssistantStreamSnapshot(
  ctx: EmbeddedAgentSubscribeContext,
  message: AssistantMessage,
) {
  const state: EmbeddedAgentSubscribeState["partialBlockState"] = {
    thinking: false,
    final: false,
    inlineCode: createInlineCodeState(),
  };
  let rawText = "";
  const parts: { text: string; separator: string; offset: number; index?: number }[] = [];
  const text = extractAssistantVisibleText(message, (part, final, phase, index) => {
    // Native blocks can divide a tag or fence; only complete visible parts get a separator.
    const separator =
      rawText && !state.pendingTagFragment && !state.pendingFenceFragment ? "\n" : "";
    parts.push({ text: part, separator, offset: rawText.length + separator.length, index });
    rawText += `${separator}${part}`;
    // Final prose preserves inline tag examples; generic streams still hide reasoning.
    return phase === "final_answer" && !ctx.params.enforceFinalTag
      ? part
      : ctx.stripBlockTags(`${separator}${part}`, state, { final });
  });
  return { text, rawText, state, parts };
}

export function isSubscribeTranscriptOnlyOpenClawAssistantMessage(
  message: AgentMessage | undefined,
): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const provider = normalizeOptionalString(message.provider) ?? "";
  const model = normalizeOptionalString(message.model) ?? "";
  return provider === "openclaw" && (model === "delivery-mirror" || model === "gateway-injected");
}

const RESPONSES_API_IDS = new Set([
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
  "openclaw-openai-responses-transport",
  "openclaw-openai-chatgpt-responses-transport",
  "openclaw-azure-openai-responses-transport",
]);

export function isResponsesApiAssistantMessage(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const api = normalizeOptionalString((message as { api?: unknown }).api) ?? "";
  return RESPONSES_API_IDS.has(api);
}

export function isAnthropicAssistantMessage(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const api = normalizeOptionalString((message as { api?: unknown }).api) ?? "";
  return api === "anthropic-messages";
}

export function isOpenAiCompletionsAssistantMessage(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const api = normalizeOptionalString((message as { api?: unknown }).api) ?? "";
  return api === "openai-completions" || api === "openclaw-openai-completions-transport";
}

export function extractStandaloneMessageToolText(
  text: string,
  params: { allowCurrentSourceReply?: boolean; allowRoutedReply?: boolean } = {},
): string | undefined {
  try {
    if (!params.allowCurrentSourceReply && !params.allowRoutedReply) {
      return undefined;
    }
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) {
      return undefined;
    }
    const record = asRecord(JSON.parse(trimmed) as unknown);
    const args = asRecord(record?.arguments);
    const hasRoute = Boolean(
      normalizeOptionalString(args?.target) ||
      normalizeOptionalString(args?.to) ||
      normalizeOptionalString(args?.channel) ||
      normalizeOptionalString(args?.accountId) ||
      Array.isArray(args?.targets),
    );
    if (
      normalizeOptionalString(record?.name) !== "message" ||
      normalizeOptionalString(args?.action) !== "send" ||
      (hasRoute ? !params.allowRoutedReply : !params.allowCurrentSourceReply)
    ) {
      return undefined;
    }
    return normalizeOptionalString(args?.message);
  } catch {
    return undefined;
  }
}

export function resolveAssistantStreamItemId(params: {
  contentIndex?: unknown;
  message: AgentMessage | undefined;
}): string | undefined {
  const content = (params.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const contentIndex =
    typeof params.contentIndex === "number" &&
    Number.isInteger(params.contentIndex) &&
    params.contentIndex >= 0
      ? params.contentIndex
      : undefined;
  const indexedBlock = contentIndex !== undefined ? content[contentIndex] : undefined;
  const indexedRecord =
    indexedBlock && typeof indexedBlock === "object"
      ? (indexedBlock as { type?: unknown })
      : undefined;
  const hasIndexedTextBlock = indexedRecord?.type === "text";
  const candidateStart =
    hasIndexedTextBlock && contentIndex !== undefined ? contentIndex : content.length - 1;
  const candidateEnd = hasIndexedTextBlock ? candidateStart : 0;
  for (let index = candidateStart; index >= candidateEnd; index -= 1) {
    const block = content[index];
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; textSignature?: unknown };
    if (record.type !== "text") {
      continue;
    }
    const signature = parseAssistantTextSignature(record);
    if (signature?.id) {
      return signature.id;
    }
  }
  return undefined;
}

export function resolveAssistantStreamContentIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function scopeAssistantMessageToStreamBlock(
  message: AssistantMessage,
  contentIndex: number | undefined,
  itemId: string | undefined,
): AssistantMessage {
  if (!Array.isArray(message.content)) {
    return message;
  }
  const indexedBlock = contentIndex === undefined ? undefined : message.content[contentIndex];
  let block =
    indexedBlock && typeof indexedBlock === "object" && indexedBlock.type === "text"
      ? indexedBlock
      : undefined;
  if (!block && itemId) {
    for (let index = message.content.length - 1; index >= 0; index -= 1) {
      const candidate = message.content[index];
      if (
        candidate &&
        typeof candidate === "object" &&
        candidate.type === "text" &&
        parseAssistantTextSignature(candidate)?.id === itemId
      ) {
        block = candidate;
        break;
      }
    }
  }
  if (!block) {
    return message;
  }
  // Provider partials are cumulative across content blocks. Once a content
  // index becomes a logical reply boundary, downstream snapshots must be
  // cumulative only within that block or earlier text is replayed.
  return { ...message, content: [block] };
}

export function emitAssistantCommentaryStreamData(
  ctx: EmbeddedAgentSubscribeContext,
  message: AssistantMessage,
  finalMessage = false,
) {
  const isResponsesCommentary = isResponsesApiAssistantMessage(message);
  const { lastAssistantStreamContentIndex: index, lastAssistantStreamItemId: itemId } = ctx.state;
  // Non-text updates carry prior Responses items too; publish only the active item.
  const commentaryMessage = isResponsesCommentary
    ? scopeAssistantMessageToStreamBlock(message, index, itemId)
    : message;
  const text = extractAssistantCommentaryText(commentaryMessage);
  if (text && (finalMessage || !isResponsesCommentary || ctx.state.deltaBuffer !== text)) {
    // Generic commentary must carry the identity the phase tagger generated so
    // the Control UI can key the live row to the persisted fallback row; without
    // it every generic segment is unkeyed and survives as a duplicate.
    const commentaryItemId = isResponsesCommentary
      ? itemId
      : resolveAssistantStreamItemId({ message });
    ctx.emitAssistantStreamData(
      buildAssistantStreamData({
        text,
        replace: true,
        phase: "commentary",
        itemId: commentaryItemId,
      }),
      { finalMessage },
    );
  }
}

export function emitReasoningEnd(ctx: EmbeddedAgentSubscribeContext) {
  if (!ctx.state.reasoningStreamOpen) {
    return;
  }
  ctx.state.reasoningStreamOpen = false;
  runBestEffortCallback({
    label: "reasoning end",
    log: ctx.log,
    callback: () => ctx.params.onReasoningEnd?.(),
  });
}

export function emitAssistantMessageStart(ctx: EmbeddedAgentSubscribeContext) {
  runBestEffortCallback({
    label: "assistant message start",
    log: ctx.log,
    callback: () => ctx.params.onAssistantMessageStart?.(),
  });
}

export function openReasoningStream(ctx: EmbeddedAgentSubscribeContext) {
  ctx.state.reasoningStreamOpen = true;
}

export function shouldSuppressDeterministicApprovalOutput(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "deterministicApprovalPromptPending" | "deterministicApprovalPromptSent"
  >,
): boolean {
  return state.deterministicApprovalPromptPending || state.deterministicApprovalPromptSent;
}

export function hasMessageToolOnlySourceDelivery(ctx: EmbeddedAgentSubscribeContext): boolean {
  return (
    ctx.params.sourceReplyDeliveryMode === "message_tool_only" &&
    (ctx.state.messageToolOnlySourceReplyDelivered ||
      ctx.params.hasDeliveredMessageToolOnlySourceReply?.() === true ||
      (ctx.state.messagingToolSourceReplyPayloads?.length ?? 0) > 0)
  );
}

export function resolveCurrentSourceMessagingToolPartial(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "currentSourceMessagingToolHeldPartial" | "currentSourceMessagingToolSentTextsNormalized"
  >,
  params: {
    evtType: "text_delta" | "text_start" | "text_end";
    text: string;
    visibleDelta: string;
  },
): { hold: boolean; text: string } {
  const held = state.currentSourceMessagingToolHeldPartial;
  const text =
    held && params.evtType === "text_delta" && !params.text.startsWith(held)
      ? `${held}${params.visibleDelta || params.text}`
      : params.text;
  const normalized = state.currentSourceMessagingToolSentTextsNormalized.length
    ? normalizeTextForComparison(text)
    : "";
  if (!normalized) {
    state.currentSourceMessagingToolHeldPartial = undefined;
    return { hold: false, text };
  }
  // A confirmed current-source tool send already made this prefix visible.
  // Hold it until the assistant either repeats the sent text or diverges with new content.
  const hold = state.currentSourceMessagingToolSentTextsNormalized.some(
    (sentText) => sentText === normalized || sentText.startsWith(normalized),
  );
  state.currentSourceMessagingToolHeldPartial = hold ? text : undefined;
  return { hold, text };
}

export function replaceBlockReplyBuffer(
  ctx: EmbeddedAgentSubscribeContext,
  text: string,
  sourceOffset = 0,
) {
  if (ctx.blockChunker.consumedLength === 0) {
    ctx.resetBlockReplyDirectives();
  }
  ctx.blockChunker.replace(text, sourceOffset);
}

export function resolveAssistantTextChunk(params: {
  evtType: "text_delta" | "text_start" | "text_end";
  delta: string;
  content: string;
  accumulatedText: string;
}): string {
  const { evtType, delta, content, accumulatedText } = params;
  if (evtType === "text_delta" || delta) {
    return delta;
  }
  if (!content) {
    return "";
  }
  // KNOWN: Some providers resend full content on `text_end`.
  // We only append a suffix (or nothing) to keep output monotonic.
  if (content.startsWith(accumulatedText)) {
    return content.slice(accumulatedText.length);
  }
  if (accumulatedText.startsWith(content)) {
    return "";
  }
  if (!accumulatedText.includes(content)) {
    return content;
  }
  return "";
}

export function resolveStreamingReply(params: {
  evtType: "text_delta" | "text_start" | "text_end";
  next: string;
  previousText: string;
  previousCleaned: string;
  visibleDelta: string;
  appendDelta: string | null;
  parsedStreamDirectives: ReplyDirectiveParseResult | null;
}): { text: string; delta: string; replace: boolean; hasText: boolean } {
  if (!params.parsedStreamDirectives && params.evtType === "text_delta") {
    const text = params.previousCleaned;
    return { text, delta: "", replace: false, hasText: Boolean(text.trim()) };
  }

  let text: string | undefined;
  let delta: string | undefined;
  let isAppend = false;
  if (
    params.evtType !== "text_end" &&
    params.parsedStreamDirectives &&
    !params.parsedStreamDirectives.isSilent &&
    !hasReplyDirectiveMetadata(params.parsedStreamDirectives) &&
    !/(?:^|\n)\s*MEDIA:\s*\S[^\n]*(?:\n|$)/i.test(params.visibleDelta) &&
    params.parsedStreamDirectives.text === params.visibleDelta &&
    params.appendDelta !== null &&
    params.previousText === params.previousCleaned
  ) {
    // Visibility and trim owners already prepared this exact append.
    text = params.next;
    delta = params.appendDelta;
    isAppend = true;
  }

  text ??= parseReplyDirectives(
    params.evtType === "text_end" ? params.next : splitTrailingDirective(params.next).text,
  ).text;
  const replace = Boolean(
    !isAppend && params.previousCleaned && !text.startsWith(params.previousCleaned),
  );
  return {
    text,
    delta: replace ? "" : (delta ?? text.slice(params.previousCleaned.length)),
    replace,
    hasText: Boolean(isAppend ? text : text.trim()),
  };
}

export function buildAssistantStreamData(
  params: Partial<Omit<AssistantStreamData, "replace">> & { replace?: boolean; mediaUrl?: string },
): AssistantStreamData {
  const mediaUrls = resolveSendableOutboundReplyParts(params, { text: "" }).mediaUrls;
  return {
    text: params.text ?? "",
    delta: params.delta ?? "",
    replace: params.replace ? true : undefined,
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    managedMediaUrls: params.managedMediaUrls?.length ? params.managedMediaUrls : undefined,
    phase: params.phase,
    itemId: params.itemId,
  };
}
