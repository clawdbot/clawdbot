/**
 * Handles embedded-agent assistant message events, block replies, reasoning
 * streams, reply directives, and pending tool media attachment handoff.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import {
  parseReplyDirectives,
  type ReplyDirectiveParseResult,
} from "../auto-reply/reply/reply-directives.js";
import { splitTrailingDirective } from "../auto-reply/reply/streaming-directives.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { AssistantMessage } from "../llm/types.js";
import { coerceChatContentText } from "../shared/chat-content.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
  type AssistantPhase,
} from "../shared/chat-message-content.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./embedded-agent-helpers.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import type {
  EmbeddedAgentSubscribeContext,
  EmbeddedAgentSubscribeState,
} from "./embedded-agent-subscribe.handlers.types.js";
import { isPromiseLike } from "./embedded-agent-subscribe.promise.js";
import { appendRawStream } from "./embedded-agent-subscribe.raw-stream.js";
import { warnIfAssistantEmittedSuspiciousText } from "./embedded-agent-subscribe.tool-text-diagnostics.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  extractAssistantCommentaryText,
  extractAssistantVisibleText,
  extractThinkingFromTaggedStream,
  extractThinkingFromTaggedText,
  promoteThinkingTagsToBlocks,
  sanitizeAssistantVisibleStreamText,
} from "./embedded-agent-utils.js";
import type { AgentEvent, AgentMessage } from "./runtime/index.js";
import {
  hasNonzeroUsage,
  makeZeroUsageSnapshot,
  normalizeUsage,
  type NormalizedUsage,
  type UsageLike,
} from "./usage.js";

function shouldSuppressAssistantVisibleOutput(message: AgentMessage | undefined): boolean {
  return resolveAssistantMessagePhase(message) === "commentary";
}

function isTranscriptOnlyOpenClawAssistantMessage(message: AgentMessage | undefined): boolean {
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

function isResponsesApiAssistantMessage(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const api = normalizeOptionalString((message as { api?: unknown }).api) ?? "";
  return RESPONSES_API_IDS.has(api);
}

function isAnthropicAssistantMessage(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const api = normalizeOptionalString((message as { api?: unknown }).api) ?? "";
  return api === "anthropic-messages";
}

function isOpenAiCompletionsAssistantMessage(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const api = normalizeOptionalString((message as { api?: unknown }).api) ?? "";
  return api === "openai-completions" || api === "openclaw-openai-completions-transport";
}

export function preservePendingAssistantUsage(
  message: AssistantMessage,
  pendingUsage: NormalizedUsage | undefined,
): AssistantMessage {
  if (isTranscriptOnlyOpenClawAssistantMessage(message) || !hasNonzeroUsage(pendingUsage)) {
    return message;
  }
  const messageUsage = normalizeUsage((message as { usage?: UsageLike }).usage);
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
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }
  const assistantRecord =
    evt.assistantMessageEvent && typeof evt.assistantMessageEvent === "object"
      ? (evt.assistantMessageEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";
  if (evtType === "text_end" || evtType === "done" || evtType === "error") {
    ctx.recordAssistantUsage(assistantRecord);
  }
}

export function resetPendingAssistantUsage(
  ctx: EmbeddedAgentSubscribeContext,
  message: AgentMessage,
): void {
  if (message?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(message)) {
    return;
  }
  ctx.state.pendingAssistantUsage = undefined;
  ctx.state.assistantUsageCommitted = false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractStandaloneMessageToolText(
  text: string,
  params: { allowCurrentSourceReply?: boolean; allowRoutedReply?: boolean } = {},
): string | undefined {
  try {
    const record = asRecord(JSON.parse(text.trim()) as unknown);
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

function resolveAssistantStreamItemId(params: {
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
  const candidateBlocks = hasIndexedTextBlock ? [indexedBlock] : content.toReversed();
  for (const block of candidateBlocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; textSignature?: unknown };
    if (record.type !== "text") {
      continue;
    }
    const signature = parseAssistantTextSignature(record.textSignature);
    if (signature?.id) {
      return signature.id;
    }
  }
  return undefined;
}

function resolveAssistantStreamContentIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function scopeAssistantMessageToStreamBlock(
  message: AssistantMessage,
  contentIndex: number | undefined,
  itemId: string | undefined,
): AssistantMessage {
  if (!Array.isArray(message.content)) {
    return message;
  }
  const indexedBlock = contentIndex === undefined ? undefined : message.content[contentIndex];
  const block =
    indexedBlock && typeof indexedBlock === "object" && indexedBlock.type === "text"
      ? indexedBlock
      : itemId
        ? message.content.toReversed().find((candidate) => {
            if (!candidate || typeof candidate !== "object" || candidate.type !== "text") {
              return false;
            }
            return parseAssistantTextSignature(candidate.textSignature)?.id === itemId;
          })
        : undefined;
  if (!block) {
    return message;
  }
  // Provider partials are cumulative across content blocks. Once a content
  // index becomes a logical reply boundary, downstream snapshots must be
  // cumulative only within that block or earlier text is replayed.
  return { ...message, content: [block] };
}

function emitReasoningEnd(ctx: EmbeddedAgentSubscribeContext) {
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

function emitAssistantMessageStart(ctx: EmbeddedAgentSubscribeContext) {
  runBestEffortCallback({
    label: "assistant message start",
    log: ctx.log,
    callback: () => ctx.params.onAssistantMessageStart?.(),
  });
}

function openReasoningStream(ctx: EmbeddedAgentSubscribeContext) {
  ctx.state.reasoningStreamOpen = true;
}

function shouldSuppressDeterministicApprovalOutput(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "deterministicApprovalPromptPending" | "deterministicApprovalPromptSent"
  >,
): boolean {
  return state.deterministicApprovalPromptPending || state.deterministicApprovalPromptSent;
}

function hasMessageToolOnlySourceDelivery(ctx: EmbeddedAgentSubscribeContext): boolean {
  return (
    ctx.params.sourceReplyDeliveryMode === "message_tool_only" &&
    (ctx.state.messageToolOnlySourceReplyDelivered ||
      ctx.params.hasDeliveredMessageToolOnlySourceReply?.() === true ||
      (ctx.state.messagingToolSourceReplyPayloads?.length ?? 0) > 0)
  );
}

function appendBlockReplyChunk(ctx: EmbeddedAgentSubscribeContext, chunk: string) {
  if (ctx.blockChunker) {
    ctx.blockChunker.append(chunk);
    return;
  }
  ctx.state.blockBuffer += chunk;
}

function replaceBlockReplyBuffer(ctx: EmbeddedAgentSubscribeContext, text: string) {
  if (ctx.blockChunker) {
    ctx.blockChunker.reset();
    ctx.blockChunker.append(text);
    return;
  }
  ctx.state.blockBuffer = text;
}

function resolveAssistantTextChunk(params: {
  evtType: "text_delta" | "text_start" | "text_end";
  delta: string;
  content: string;
  accumulatedText: string;
}): string {
  const { evtType, delta, content, accumulatedText } = params;
  if (evtType === "text_delta") {
    return delta;
  }
  if (delta) {
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

const REASONING_TAG_RE = /<\s*\/?\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b/i;

function resolveStreamVisibleText(params: {
  previousRawText: string;
  visibleDelta: string;
  finalText?: string;
}): { rawText: string; visibleText: string } {
  if (params.finalText !== undefined) {
    const rawText = params.finalText;
    return { rawText, visibleText: rawText.trim() };
  }
  const rawText = `${params.previousRawText}${params.visibleDelta}`;
  return { rawText, visibleText: rawText.trim() };
}

function resolveTextAppendDelta(previousText: string, nextText: string): string {
  if (!nextText) {
    return "";
  }
  if (!previousText) {
    return nextText;
  }
  if (nextText.startsWith(previousText)) {
    return nextText.slice(previousText.length);
  }
  if (previousText.startsWith(nextText)) {
    return "";
  }
  return nextText;
}

function copyPartialBlockState(
  target: EmbeddedAgentSubscribeState["partialBlockState"],
  source: EmbeddedAgentSubscribeState["partialBlockState"],
) {
  const copyFenceState = (fence?: typeof source.fence) =>
    fence
      ? {
          atLineStart: fence.atLineStart,
          ...(fence.open ? { open: { ...fence.open } } : {}),
        }
      : undefined;
  target.thinking = source.thinking;
  target.final = source.final;
  target.inlineCode = { ...source.inlineCode };
  target.fence = copyFenceState(source.fence);
  target.reasoningInlineCode = source.reasoningInlineCode
    ? { ...source.reasoningInlineCode }
    : undefined;
  target.reasoningFence = copyFenceState(source.reasoningFence);
  target.reasoningPendingFenceFragment = source.reasoningPendingFenceFragment;
  target.finalInlineCode = source.finalInlineCode ? { ...source.finalInlineCode } : undefined;
  target.finalFence = copyFenceState(source.finalFence);
  target.pendingFenceFragment = source.pendingFenceFragment;
  target.pendingTagFragment = source.pendingTagFragment;
}

/** Replaces a silent-reply token with the latest sent messaging-tool text when available. */
function resolveSilentReplyFallbackText(params: {
  text: unknown;
  messagingToolSentTexts: string[];
}): string {
  const text = coerceChatContentText(params.text);
  const trimmed = text.trim();
  if (trimmed !== SILENT_REPLY_TOKEN) {
    return text;
  }
  const fallback = coerceChatContentText(params.messagingToolSentTexts.at(-1)).trim();
  if (!fallback) {
    return text;
  }
  return fallback;
}

function clearPendingToolMedia(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "pendingToolMediaUrls" | "pendingToolAudioAsVoice" | "pendingToolTrustedLocalMedia"
  >,
) {
  state.pendingToolMediaUrls = [];
  state.pendingToolAudioAsVoice = false;
  state.pendingToolTrustedLocalMedia = false;
}

function hasReplyMedia(payload: BlockReplyPayload): boolean {
  return (payload.mediaUrls ?? []).some((url) => url.trim().length > 0);
}

/** Moves queued tool media into a non-reasoning assistant reply payload. */
export function consumePendingToolMediaIntoReply(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "pendingToolMediaUrls" | "pendingToolAudioAsVoice" | "pendingToolTrustedLocalMedia"
  >,
  payload: BlockReplyPayload,
): BlockReplyPayload {
  if (payload.isReasoning) {
    return payload;
  }
  if (
    state.pendingToolMediaUrls.length === 0 &&
    !state.pendingToolAudioAsVoice &&
    !state.pendingToolTrustedLocalMedia
  ) {
    return payload;
  }
  if (hasReplyMedia(payload)) {
    // Pending tool media is a fallback delivery queue; explicit final media is
    // the assistant's user-visible selection, while tool output remains in the transcript.
    clearPendingToolMedia(state);
    return payload;
  }
  const mergedMediaUrls = Array.from(
    new Set([...(payload.mediaUrls ?? []), ...state.pendingToolMediaUrls]),
  );
  const mergedPayload: BlockReplyPayload = {
    ...payload,
    mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
    audioAsVoice: payload.audioAsVoice || state.pendingToolAudioAsVoice || undefined,
    trustedLocalMedia: payload.trustedLocalMedia || state.pendingToolTrustedLocalMedia || undefined,
  };
  clearPendingToolMedia(state);
  return mergedPayload;
}

/** Consumes queued tool media as a standalone reply payload. */
export function consumePendingToolMediaReply(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "pendingToolMediaUrls" | "pendingToolAudioAsVoice" | "pendingToolTrustedLocalMedia"
  >,
): BlockReplyPayload | null {
  const payload = readPendingToolMediaReply(state);
  if (!payload) {
    return null;
  }
  clearPendingToolMedia(state);
  return payload;
}

/** Reads queued tool media without clearing it. */
export function readPendingToolMediaReply(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "pendingToolMediaUrls" | "pendingToolAudioAsVoice" | "pendingToolTrustedLocalMedia"
  >,
): BlockReplyPayload | null {
  if (
    state.pendingToolMediaUrls.length === 0 &&
    !state.pendingToolAudioAsVoice &&
    !state.pendingToolTrustedLocalMedia
  ) {
    return null;
  }
  return {
    mediaUrls: state.pendingToolMediaUrls.length
      ? uniqueStrings(state.pendingToolMediaUrls)
      : undefined,
    audioAsVoice: state.pendingToolAudioAsVoice || undefined,
    trustedLocalMedia: state.pendingToolTrustedLocalMedia || undefined,
  };
}

function hasReplyDirectiveMetadata(parsed: ReplyDirectiveParseResult | null | undefined): boolean {
  return Boolean(
    parsed &&
    ((parsed.mediaUrls?.length ?? 0) > 0 ||
      parsed.audioAsVoice ||
      parsed.replyToId ||
      parsed.replyToTag ||
      parsed.replyToCurrent),
  );
}

function hasReplyDirectiveMetadataResult(
  parsed: ReplyDirectiveParseResult | null | undefined,
): parsed is ReplyDirectiveParseResult {
  return hasReplyDirectiveMetadata(parsed);
}

function mergeReplyDirectiveResults(
  first: ReplyDirectiveParseResult | null | undefined,
  second: ReplyDirectiveParseResult | null | undefined,
): ReplyDirectiveParseResult | null {
  if (!first) {
    return second ?? null;
  }
  if (!second) {
    return first;
  }
  const mediaUrls = uniqueStrings([...(first.mediaUrls ?? []), ...(second.mediaUrls ?? [])]);
  return {
    text: `${first.text ?? ""}${second.text ?? ""}`,
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    replyToId: second.replyToId ?? first.replyToId,
    replyToCurrent: first.replyToCurrent || second.replyToCurrent,
    replyToTag: first.replyToTag || second.replyToTag,
    audioAsVoice: first.audioAsVoice || second.audioAsVoice || undefined,
    isSilent: first.isSilent || second.isSilent,
  };
}

function parseFullStreamingReplyText(text: string): string {
  return parseReplyDirectives(splitTrailingDirective(text).text).text;
}

function containsCompleteMediaDirectiveLine(text: string): boolean {
  return /(?:^|\n)\s*MEDIA:\s*\S[^\n]*(?:\n|$)/i.test(text);
}

function resolveIncrementalStreamingReplyText(params: {
  evtType: "text_delta" | "text_start" | "text_end";
  next: string;
  previousRawText: string;
  previousCleaned: string;
  visibleDelta: string;
  parsedStreamDirectives: ReplyDirectiveParseResult | null;
  shouldUsePhaseAwareBlockReply: boolean;
}): string | undefined {
  if (
    params.evtType === "text_end" ||
    !params.parsedStreamDirectives ||
    params.parsedStreamDirectives.isSilent ||
    hasReplyDirectiveMetadata(params.parsedStreamDirectives) ||
    containsCompleteMediaDirectiveLine(params.visibleDelta) ||
    params.parsedStreamDirectives.text !== params.visibleDelta
  ) {
    return undefined;
  }

  if (
    !params.shouldUsePhaseAwareBlockReply &&
    params.previousCleaned === params.previousRawText.trim()
  ) {
    return params.next;
  }

  const cleanedCandidate = `${params.previousCleaned}${params.parsedStreamDirectives.text}`.trim();
  return cleanedCandidate === params.next ? cleanedCandidate : undefined;
}

function resolveStreamingReplyText(params: {
  evtType: "text_delta" | "text_start" | "text_end";
  next: string;
  previousRawText: string;
  previousCleaned: string;
  visibleDelta: string;
  parsedStreamDirectives: ReplyDirectiveParseResult | null;
  shouldUsePhaseAwareBlockReply: boolean;
}): string {
  if (!params.parsedStreamDirectives) {
    return params.evtType === "text_delta"
      ? params.previousCleaned
      : parseFullStreamingReplyText(params.next);
  }

  return resolveIncrementalStreamingReplyText(params) ?? parseFullStreamingReplyText(params.next);
}

/** Records parsed reply directives until a sendable reply payload is built. */
function recordPendingAssistantReplyDirectives(
  state: Pick<EmbeddedAgentSubscribeState, "pendingAssistantReplyDirectives">,
  parsed: ReplyDirectiveParseResult | null | undefined,
) {
  if (!hasReplyDirectiveMetadataResult(parsed)) {
    return;
  }
  const current = state.pendingAssistantReplyDirectives;
  const mediaUrls = Array.from(
    new Set([...(current?.mediaUrls ?? []), ...(parsed.mediaUrls ?? [])]),
  );
  state.pendingAssistantReplyDirectives = {
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    audioAsVoice: current?.audioAsVoice || parsed?.audioAsVoice || undefined,
    replyToId: parsed?.replyToId ?? current?.replyToId,
    replyToTag: current?.replyToTag || parsed.replyToTag || undefined,
    replyToCurrent: current?.replyToCurrent || parsed.replyToCurrent || undefined,
  };
}

/** Merges pending reply directives into one reply payload and clears them. */
export function consumePendingAssistantReplyDirectivesIntoReply(
  state: Pick<EmbeddedAgentSubscribeState, "pendingAssistantReplyDirectives">,
  payload: BlockReplyPayload,
): BlockReplyPayload {
  if (payload.isReasoning || !state.pendingAssistantReplyDirectives) {
    return payload;
  }
  const pending = state.pendingAssistantReplyDirectives;
  const mediaUrls = Array.from(
    new Set([...(payload.mediaUrls ?? []), ...(pending.mediaUrls ?? [])]),
  );
  state.pendingAssistantReplyDirectives = undefined;
  return {
    ...payload,
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    audioAsVoice: payload.audioAsVoice || pending.audioAsVoice || undefined,
    replyToId: payload.replyToId ?? pending.replyToId,
    replyToTag: Boolean(payload.replyToTag || pending.replyToTag) || undefined,
    replyToCurrent: Boolean(payload.replyToCurrent || pending.replyToCurrent) || undefined,
  };
}

/** True when a reply payload has text, media, or voice content worth sending. */
export function hasAssistantVisibleReply(params: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  audioAsVoice?: boolean;
}): boolean {
  return resolveSendableOutboundReplyParts(params).hasContent || Boolean(params.audioAsVoice);
}

/** Builds normalized stream payload data for assistant visible output. */
function buildAssistantStreamData(params: {
  text?: string;
  delta?: string;
  replace?: boolean;
  mediaUrls?: string[];
  mediaUrl?: string;
  phase?: AssistantPhase;
  itemId?: string;
}): {
  text: string;
  delta: string;
  replace?: true;
  mediaUrls?: string[];
  phase?: AssistantPhase;
  itemId?: string;
} {
  const mediaUrls = resolveSendableOutboundReplyParts(params).mediaUrls;
  return {
    text: params.text ?? "",
    delta: params.delta ?? "",
    replace: params.replace ? true : undefined,
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    phase: params.phase,
    itemId: params.itemId,
  };
}

/** Handles assistant message-start boundaries for streaming state. */
export function handleMessageStart(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
  // ASSUME: `message_start` is the only reliable boundary for “new assistant message begins”.
  // Start-of-message is a safer reset point than message_end: some providers
  // may deliver late text_end updates after message_end, which would otherwise
  // re-trigger block replies.
  ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
  // Use assistant message_start as the earliest "writing" signal for typing.
  emitAssistantMessageStart(ctx);
}

/** Handles assistant message deltas, reasoning, directives, and block replies. */
export function handleMessageUpdate(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage; assistantMessageEvent?: unknown },
) {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  ctx.noteLastAssistant(msg);
  const assistantEvent = evt.assistantMessageEvent;
  const assistantRecord =
    assistantEvent && typeof assistantEvent === "object"
      ? (assistantEvent as Record<string, unknown>)
      : undefined;
  const evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";
  const eventAssistantMessage =
    assistantRecord?.partial && typeof assistantRecord.partial === "object"
      ? (assistantRecord.partial as AssistantMessage)
      : msg;
  const isResponsesTextEvent =
    isResponsesApiAssistantMessage(eventAssistantMessage) &&
    (evtType === "text_start" || evtType === "text_delta" || evtType === "text_end");
  const suppressVisibleAssistantOutput = shouldSuppressAssistantVisibleOutput(msg);
  if (suppressVisibleAssistantOutput && !isResponsesTextEvent) {
    const commentaryText = coerceChatContentText(extractAssistantCommentaryText(msg));
    if (commentaryText) {
      appendRawStream({
        ts: Date.now(),
        event: "assistant_text_stream",
        runId: ctx.params.runId,
        sessionId: (ctx.params.session as { id?: string }).id,
        evtType: "commentary_update",
        delta: "",
        content: commentaryText,
      });
      ctx.emitAssistantStreamData(
        buildAssistantStreamData({ text: commentaryText, replace: true, phase: "commentary" }),
      );
    }
    return;
  }
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);
  const suppressMessageToolOnlySourceReplyOutput = hasMessageToolOnlySourceDelivery(ctx);

  const assistantPhase = resolveAssistantMessagePhase(msg);

  if (evtType === "text_end" || evtType === "done" || evtType === "error") {
    capturePendingAssistantUsage(ctx, evt);
    if (evtType === "done" || evtType === "error") {
      ctx.commitAssistantUsage();
    }
  }

  if (evtType === "thinking_start" || evtType === "thinking_delta" || evtType === "thinking_end") {
    if (
      !suppressMessageToolOnlySourceReplyOutput &&
      (evtType === "thinking_start" || evtType === "thinking_delta")
    ) {
      openReasoningStream(ctx);
    }
    const thinkingDelta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
    const thinkingContent =
      typeof assistantRecord?.content === "string" ? assistantRecord.content : "";
    appendRawStream({
      ts: Date.now(),
      event: "assistant_thinking_stream",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      evtType,
      delta: thinkingDelta,
      content: thinkingContent,
    });
    // Emit-always: emitReasoningStream always reaches the bus/archive; the
    // streamReasoning rendering hook and message_tool_only source suppression
    // are gated downstream (dispatch wrapProgressCallback, #92738), so emission
    // here stays unconditional.
    // Prefer full partial-message thinking when available; fall back to event payloads.
    const partialThinking = extractAssistantThinking(msg);
    ctx.emitReasoningStream(partialThinking || thinkingContent || thinkingDelta);
    if (evtType === "thinking_end" && !suppressMessageToolOnlySourceReplyOutput) {
      // Mirror the open gate above: when message-tool-only delivery has made the
      // reasoning lane private, do not force-open it just to close it — that
      // would fire the lane's end hook (onReasoningEnd) for a lane that never
      // rendered, leaking the boundary signal.
      if (!ctx.state.reasoningStreamOpen) {
        openReasoningStream(ctx);
      }
      emitReasoningEnd(ctx);
    }
    return;
  }

  if (evtType !== "text_delta" && evtType !== "text_start" && evtType !== "text_end") {
    return;
  }

  const delta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";
  const content = typeof assistantRecord?.content === "string" ? assistantRecord.content : "";

  appendRawStream({
    ts: Date.now(),
    event: "assistant_text_stream",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    evtType,
    delta,
    content,
  });

  const chunk = resolveAssistantTextChunk({
    evtType,
    delta,
    content,
    accumulatedText: ctx.state.deltaBuffer,
  });

  const partialAssistant = eventAssistantMessage;
  const streamContentIndex = resolveAssistantStreamContentIndex(assistantRecord?.contentIndex);
  const streamItemId = resolveAssistantStreamItemId({
    contentIndex: streamContentIndex,
    message: partialAssistant,
  });
  const streamAssistant = scopeAssistantMessageToStreamBlock(
    partialAssistant,
    streamContentIndex,
    streamItemId,
  );
  const deliveryPhase = resolveAssistantMessagePhase(streamAssistant);
  const isPhasePendingResponsesTextItem =
    evtType !== "text_end" &&
    !deliveryPhase &&
    Boolean(streamItemId) &&
    isResponsesApiAssistantMessage(partialAssistant);
  // These transports resolve commentary only at the tool boundary. Withhold
  // early unphased deltas from durable block replies until that decision exists.
  const isPhasePendingAnthropicText =
    evtType !== "text_end" && !deliveryPhase && isAnthropicAssistantMessage(partialAssistant);
  const isPhasePendingCompletionsText =
    !deliveryPhase && isOpenAiCompletionsAssistantMessage(partialAssistant);
  const hasResponsesContentIndex =
    streamContentIndex !== undefined && isResponsesApiAssistantMessage(partialAssistant);
  let streamItemChanged = false;
  let deliveryItemId = streamItemId;
  if (
    (deliveryPhase || isPhasePendingResponsesTextItem || hasResponsesContentIndex) &&
    (streamContentIndex !== undefined || streamItemId)
  ) {
    const previousStreamContentIndex = ctx.state.lastAssistantStreamContentIndex;
    const previousStreamItemId = ctx.state.lastAssistantStreamItemId;
    const contentIndexChanged =
      previousStreamContentIndex !== undefined &&
      streamContentIndex !== undefined &&
      previousStreamContentIndex !== streamContentIndex;
    const itemIdChangedWithoutIndexes =
      (previousStreamContentIndex === undefined || streamContentIndex === undefined) &&
      Boolean(previousStreamItemId && streamItemId && previousStreamItemId !== streamItemId);
    if (contentIndexChanged || itemIdChangedWithoutIndexes) {
      streamItemChanged = true;
      void ctx.flushBlockReplyBuffer({ assistantMessageIndex: ctx.state.assistantMessageIndex });
      ctx.resetAssistantMessageState(ctx.state.assistantTexts.length);
      emitAssistantMessageStart(ctx);
    } else if (
      previousStreamContentIndex !== undefined &&
      streamContentIndex === previousStreamContentIndex &&
      previousStreamItemId
    ) {
      // Snapshot-extension items can rotate provider ids while retaining one logical block.
      // Keep the original live key so downstream commentary accumulators do not split it.
      deliveryItemId = previousStreamItemId;
    }
    ctx.state.lastAssistantStreamContentIndex = streamContentIndex;
    ctx.state.lastAssistantStreamItemId = deliveryItemId;
  }
  // Responses text_start snapshots may already contain text replayed by the first delta.
  // Keep starts lifecycle-only so commentary and final-answer lanes consume each byte once.
  if (evtType === "text_start" && isResponsesApiAssistantMessage(partialAssistant)) {
    return;
  }
  if (deliveryPhase === "commentary") {
    const isResponsesCommentary = isResponsesApiAssistantMessage(partialAssistant);
    const hadResponsesCommentaryText = isResponsesCommentary && Boolean(ctx.state.deltaBuffer);
    if (isResponsesCommentary && chunk) {
      // Keep cumulative end events monotonic without feeding commentary into reply buffers.
      ctx.state.deltaBuffer += chunk;
    }
    const commentaryText =
      !chunk && (!isResponsesCommentary || !hadResponsesCommentaryText)
        ? coerceChatContentText(extractAssistantCommentaryText(streamAssistant))
        : undefined;
    const commentaryData = chunk
      ? buildAssistantStreamData({ delta: chunk, phase: "commentary", itemId: deliveryItemId })
      : commentaryText
        ? buildAssistantStreamData({
            text: commentaryText,
            replace: true,
            phase: "commentary",
            itemId: deliveryItemId,
          })
        : undefined;
    if (commentaryData) {
      ctx.emitAssistantStreamData(commentaryData);
    }
    return;
  }
  if (isPhasePendingResponsesTextItem) {
    return;
  }
  // Subagents have no live consumer; their final result is delivered from
  // message_end. Keep accumulating deltaBuffer, but skip per-chunk visible-text
  // parsing so long parallel subagent streams do not monopolize the event loop.
  const skipLiveStream = ctx.params.suppressLiveStreamOutput === true;
  const shouldUsePhaseAwareBlockReply = Boolean(deliveryPhase);

  if (chunk) {
    ctx.state.deltaBuffer += chunk;
    if (!skipLiveStream && !shouldUsePhaseAwareBlockReply) {
      if (!isPhasePendingAnthropicText && !isPhasePendingCompletionsText) {
        appendBlockReplyChunk(ctx, chunk);
      }
    }
  }

  if (skipLiveStream) {
    return;
  }

  // Handle partial <think> tags: stream whatever reasoning is visible so far.
  // Emit-always: emitReasoningStream reaches the bus/archive; rendering +
  // message_tool_only suppression are gated downstream (#92738).
  ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer));
  const wasThinking = ctx.state.partialBlockState.thinking;
  let visibleDelta = "";
  // A text_start partial may already contain text that the following text_delta replays.
  // Use starts only for lifecycle boundaries; consume their text from delta/end events.
  const shouldReadScopedPartialText =
    streamItemChanged || (shouldUsePhaseAwareBlockReply && (evtType === "text_end" || !chunk));
  let next = shouldReadScopedPartialText
    ? coerceChatContentText(extractAssistantVisibleText(streamAssistant)).trim()
    : "";
  let nextRawStreamText = next;
  let shouldPersistRawStreamText = false;
  if (shouldUsePhaseAwareBlockReply && !next && deliveryPhase === "final_answer" && chunk) {
    visibleDelta = ctx.stripBlockTags(chunk, ctx.state.partialBlockState, {
      final: evtType === "text_end",
    });
    const streamVisibleText = resolveStreamVisibleText({
      previousRawText: ctx.state.lastStreamedAssistant ?? "",
      visibleDelta,
    });
    const previousVisibleText = sanitizeAssistantVisibleStreamText(
      ctx.state.lastStreamedAssistant ?? "",
    ).trim();
    next = sanitizeAssistantVisibleStreamText(streamVisibleText.rawText).trim();
    visibleDelta = resolveTextAppendDelta(previousVisibleText, next);
    nextRawStreamText = streamVisibleText.rawText;
    shouldPersistRawStreamText = true;
  } else if (!next && deliveryPhase !== "final_answer") {
    const pendingTagFragment = ctx.state.partialBlockState.pendingTagFragment;
    const shouldRecomputeFullStream = Boolean(pendingTagFragment) || REASONING_TAG_RE.test(chunk);
    if (shouldRecomputeFullStream) {
      const recomputeState: EmbeddedAgentSubscribeState["partialBlockState"] = {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      };
      const recomputedRawText = ctx.stripBlockTags(ctx.state.deltaBuffer, recomputeState, {
        final: evtType === "text_end",
      });
      const previousRawText = ctx.state.lastStreamedAssistant ?? "";
      const isFullStreamReplacement = !recomputedRawText.startsWith(previousRawText);
      next = recomputedRawText.trim();
      visibleDelta = isFullStreamReplacement
        ? recomputedRawText
        : recomputedRawText.slice(previousRawText.length);
      nextRawStreamText = recomputedRawText;
      copyPartialBlockState(ctx.state.partialBlockState, recomputeState);
    } else {
      visibleDelta =
        chunk || evtType === "text_end"
          ? ctx.stripBlockTags(chunk, ctx.state.partialBlockState, {
              final: evtType === "text_end",
            })
          : "";
      if (ctx.state.partialBlockState.pendingTagFragment) {
        visibleDelta = "";
        next = ctx.state.lastStreamedAssistantCleaned ?? "";
        nextRawStreamText = ctx.state.lastStreamedAssistant ?? "";
      } else {
        const streamVisibleText = resolveStreamVisibleText({
          previousRawText: ctx.state.lastStreamedAssistant ?? "",
          visibleDelta,
        });
        next = streamVisibleText.visibleText;
        nextRawStreamText = streamVisibleText.rawText;
      }
    }
  } else if (next && (chunk || evtType === "text_end")) {
    visibleDelta = ctx.stripBlockTags(chunk, ctx.state.partialBlockState, {
      final: evtType === "text_end",
    });
  }
  if (next) {
    if (
      !suppressMessageToolOnlySourceReplyOutput &&
      !wasThinking &&
      ctx.state.partialBlockState.thinking
    ) {
      openReasoningStream(ctx);
    }
    // Detect when thinking block ends (</think> tag processed)
    if (
      !suppressMessageToolOnlySourceReplyOutput &&
      wasThinking &&
      !ctx.state.partialBlockState.thinking
    ) {
      emitReasoningEnd(ctx);
    }
    const parsedDelta = visibleDelta ? ctx.consumePartialReplyDirectives(visibleDelta) : null;
    const finalParsedDelta =
      evtType === "text_end" ? ctx.consumePartialReplyDirectives("", { final: true }) : null;
    const parsedStreamDirectives = mergeReplyDirectiveResults(parsedDelta, finalParsedDelta);
    if (shouldUsePhaseAwareBlockReply) {
      recordPendingAssistantReplyDirectives(ctx.state, parsedStreamDirectives);
    }
    const previousCleaned = ctx.state.lastStreamedAssistantCleaned ?? "";
    const cleanedText = resolveStreamingReplyText({
      evtType,
      next,
      previousRawText: ctx.state.lastStreamedAssistant ?? "",
      previousCleaned,
      visibleDelta,
      parsedStreamDirectives,
      shouldUsePhaseAwareBlockReply,
    });
    const { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedStreamDirectives ?? {});
    const hasAudio = Boolean(parsedStreamDirectives?.audioAsVoice);

    let shouldEmit;
    let deltaText = "";
    let replace = false;
    if (!hasAssistantVisibleReply({ text: cleanedText, mediaUrls, audioAsVoice: hasAudio })) {
      shouldEmit = false;
    } else {
      replace = Boolean(previousCleaned && !cleanedText.startsWith(previousCleaned));
      deltaText = replace ? "" : cleanedText.slice(previousCleaned.length);
      shouldEmit = replace
        ? cleanedText !== previousCleaned || hasMedia || hasAudio
        : Boolean(deltaText || hasMedia || hasAudio);
    }

    if (shouldUsePhaseAwareBlockReply) {
      if (replace) {
        ctx.state.blockBuffer = "";
        ctx.blockChunker?.reset();
      }
      const blockReplyChunk = replace ? cleanedText : deltaText;
      if (blockReplyChunk) {
        appendBlockReplyChunk(ctx, blockReplyChunk);
      }

      if (evtType === "text_end" && !ctx.state.lastBlockReplyText && cleanedText) {
        replaceBlockReplyBuffer(ctx, cleanedText);
      }
    } else if (streamItemChanged && !chunk) {
      // An unphased equal/shrinking Responses item can end without a delta.
      // Rebuild its block buffer from the scoped snapshot after the boundary reset.
      appendBlockReplyChunk(ctx, cleanedText);
    }

    ctx.state.lastStreamedAssistant = nextRawStreamText;
    ctx.state.lastStreamedAssistantCleaned = cleanedText;

    if (
      ctx.params.silentExpected ||
      suppressDeterministicApprovalOutput ||
      suppressMessageToolOnlySourceReplyOutput
    ) {
      shouldEmit = false;
    }

    if (shouldEmit) {
      const data = buildAssistantStreamData({
        text: cleanedText,
        delta: deltaText,
        replace,
        mediaUrls,
        phase: deliveryPhase ?? assistantPhase,
      });
      ctx.emitAssistantStreamData(data, { emitPartialReply: true });
      ctx.state.emittedAssistantUpdate = true;
    }
  } else if (shouldPersistRawStreamText) {
    ctx.state.lastStreamedAssistant = nextRawStreamText;
  }

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    ctx.params.onBlockReply &&
    ctx.blockChunking &&
    ctx.state.blockReplyBreak === "text_end"
  ) {
    ctx.blockChunker?.drain({ force: false, emit: ctx.emitBlockChunk });
  }

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    evtType === "text_end" &&
    ctx.state.blockReplyBreak === "text_end"
  ) {
    const assistantMessageIndex = ctx.state.assistantMessageIndex;
    void Promise.resolve()
      .then(() => ctx.flushBlockReplyBuffer({ assistantMessageIndex, final: true }))
      .catch((err: unknown) => {
        ctx.log.debug(`text_end block reply flush failed: ${String(err)}`);
      });
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedSubscribeMessagesTestApi")
  ] = {
    buildAssistantStreamData,
    recordPendingAssistantReplyDirectives,
    resolveSilentReplyFallbackText,
  };
}

/** Handles assistant message-end finalization, block flush, and usage commit. */
export function handleMessageEnd(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
): void | Promise<void> {
  const msg = evt.message;
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }

  const assistantMessage = preservePendingAssistantUsage(msg, ctx.state.pendingAssistantUsage);
  const assistantPhase = resolveAssistantMessagePhase(assistantMessage);
  const suppressVisibleAssistantOutput = shouldSuppressAssistantVisibleOutput(assistantMessage);
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);
  const suppressMessageToolOnlySourceReplyOutput = hasMessageToolOnlySourceDelivery(ctx);
  ctx.noteLastAssistant(assistantMessage);
  ctx.noteCompletedAssistant(assistantMessage);
  ctx.recordAssistantUsage((assistantMessage as { usage?: unknown }).usage);
  ctx.commitAssistantUsage();
  if (suppressVisibleAssistantOutput) {
    const isResponsesCommentary = isResponsesApiAssistantMessage(assistantMessage);
    const commentaryMessage = isResponsesCommentary
      ? scopeAssistantMessageToStreamBlock(
          assistantMessage as AssistantMessage,
          ctx.state.lastAssistantStreamContentIndex,
          ctx.state.lastAssistantStreamItemId,
        )
      : assistantMessage;
    const commentaryText = coerceChatContentText(extractAssistantCommentaryText(commentaryMessage));
    appendRawStream({
      ts: Date.now(),
      event: "assistant_message_end",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      rawText: coerceChatContentText(extractAssistantText(assistantMessage)),
      rawThinking: extractAssistantThinking(assistantMessage),
    });
    const commentaryAlreadyStreamed =
      isResponsesCommentary &&
      Boolean(ctx.state.deltaBuffer) &&
      ctx.state.deltaBuffer === commentaryText;
    if (commentaryText && !commentaryAlreadyStreamed) {
      ctx.emitAssistantStreamData(
        buildAssistantStreamData({
          text: commentaryText,
          replace: true,
          phase: "commentary",
          itemId: isResponsesCommentary ? ctx.state.lastAssistantStreamItemId : undefined,
        }),
      );
    }
    // Commentary-tagged tool turns can still carry durable reasoning under /reasoning on.
    const suppressedTrimmedReasoning = ctx.state.includeReasoning
      ? extractAssistantThinking(assistantMessage).trim()
      : "";
    if (
      !ctx.params.silentExpected &&
      !suppressDeterministicApprovalOutput &&
      !suppressMessageToolOnlySourceReplyOutput &&
      ctx.state.includeReasoning &&
      suppressedTrimmedReasoning &&
      ctx.params.onBlockReply &&
      suppressedTrimmedReasoning !== ctx.state.lastReasoningSent
    ) {
      ctx.state.lastReasoningSent = suppressedTrimmedReasoning;
      ctx.emitBlockReply({ text: suppressedTrimmedReasoning, isReasoning: true });
    }
    return;
  }
  promoteThinkingTagsToBlocks(assistantMessage);

  const rawText = coerceChatContentText(extractAssistantText(assistantMessage));
  const rawVisibleText = coerceChatContentText(extractAssistantVisibleText(assistantMessage));
  appendRawStream({
    ts: Date.now(),
    event: "assistant_message_end",
    runId: ctx.params.runId,
    sessionId: (ctx.params.session as { id?: string }).id,
    rawText,
    rawThinking: extractAssistantThinking(assistantMessage),
  });
  warnIfAssistantEmittedSuspiciousText(ctx, assistantMessage);
  const visibleText =
    extractStandaloneMessageToolText(rawVisibleText, {
      allowRoutedReply: isOpenAiCompletionsAssistantMessage(assistantMessage),
      allowCurrentSourceReply:
        ctx.params.sourceReplyDeliveryMode === "message_tool_only" &&
        ctx.builtinToolNames?.has("message") === true,
    }) ?? rawVisibleText;
  const finalVisibleText = ctx.params.enforceFinalTag
    ? ctx.stripBlockTags(visibleText, { thinking: false, final: false }, { final: true })
    : visibleText;

  const text = resolveSilentReplyFallbackText({
    text: finalVisibleText,
    messagingToolSentTexts: ctx.state.messagingToolSentTexts,
  });
  const rawThinking =
    ctx.state.includeReasoning || ctx.state.streamReasoning
      ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
      : "";
  const trimmedReasoning = rawThinking ? rawThinking.trim() : "";
  const trimmedText = text.trim();
  const parsedText = trimmedText
    ? parseReplyDirectives(splitTrailingDirective(trimmedText, { final: true }).text)
    : null;
  const cleanedText = parsedText?.text ?? "";
  const { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedText ?? {});

  const finalizeMessageEnd = () => {
    ctx.state.deltaBuffer = "";
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
  };

  const previousStreamedText = ctx.state.lastStreamedAssistantCleaned ?? "";
  const shouldReplaceFinalStream = Boolean(
    previousStreamedText && cleanedText && !cleanedText.startsWith(previousStreamedText),
  );
  const didTextChangeWithinCurrentMessage = Boolean(
    previousStreamedText && cleanedText !== previousStreamedText,
  );
  const finalStreamDelta = shouldReplaceFinalStream
    ? ""
    : cleanedText.slice(previousStreamedText.length);

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    (cleanedText || hasMedia) &&
    (!ctx.state.emittedAssistantUpdate ||
      shouldReplaceFinalStream ||
      didTextChangeWithinCurrentMessage ||
      hasMedia)
  ) {
    const data = buildAssistantStreamData({
      text: cleanedText,
      delta: finalStreamDelta,
      replace: shouldReplaceFinalStream,
      mediaUrls,
      phase: assistantPhase,
    });
    ctx.emitAssistantStreamData(data);
    ctx.state.emittedAssistantUpdate = true;
    ctx.state.lastStreamedAssistantCleaned = cleanedText;
  }

  const silentExpectedWithoutSentinel =
    ctx.params.silentExpected && !isSilentReplyText(trimmedText, SILENT_REPLY_TOKEN);
  const finalAssistantText = silentExpectedWithoutSentinel ? "" : text;
  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
  ctx.finalizeAssistantTexts({
    text: finalAssistantText,
    addedDuringMessage,
    chunkerHasBuffered,
  });

  const onBlockReply = ctx.params.onBlockReply;
  const shouldEmitReasoning = Boolean(
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    ctx.state.includeReasoning &&
    trimmedReasoning &&
    onBlockReply &&
    trimmedReasoning !== ctx.state.lastReasoningSent,
  );
  const shouldEmitReasoningBeforeAnswer =
    shouldEmitReasoning && ctx.state.blockReplyBreak === "message_end" && !addedDuringMessage;
  const maybeEmitReasoning = () => {
    if (!shouldEmitReasoning || !trimmedReasoning) {
      return;
    }
    ctx.state.lastReasoningSent = trimmedReasoning;
    // Lane purity: the payload carries raw thinking only. Tool persistence is
    // the verbose lane's job; interleaving comes from arrival order.
    ctx.emitBlockReply({ text: trimmedReasoning, isReasoning: true });
  };

  if (shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
  }

  const emitSplitResultAsBlockReply = (
    splitResult: ReturnType<typeof ctx.consumeReplyDirectives> | null | undefined,
  ) => {
    if (!splitResult || !onBlockReply) {
      return;
    }
    const {
      text: cleanedTextLocal,
      mediaUrls: mediaUrlsLocal,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = splitResult;
    // Emit if there's content OR audioAsVoice flag (to propagate the flag).
    if (
      hasAssistantVisibleReply({ text: cleanedTextLocal, mediaUrls: mediaUrlsLocal, audioAsVoice })
    ) {
      ctx.emitBlockReply(
        {
          text: cleanedTextLocal,
          mediaUrls: mediaUrlsLocal?.length ? mediaUrlsLocal : undefined,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        },
        { assistantMessageIndex: ctx.state.assistantMessageIndex },
      );
    }
  };

  const hasBufferedBlockReply = ctx.blockChunker
    ? ctx.blockChunker.hasBuffered()
    : ctx.state.blockBuffer.length > 0;

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    text &&
    onBlockReply &&
    (ctx.state.blockReplyBreak === "message_end" ||
      hasBufferedBlockReply ||
      text !== ctx.state.lastBlockReplyText ||
      hasMedia)
  ) {
    if (hasBufferedBlockReply && ctx.blockChunker?.hasBuffered()) {
      const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer({
        assistantMessageIndex: ctx.state.assistantMessageIndex,
        final: true,
      });
      if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
        void flushBlockReplyBufferResult.catch((err: unknown) => {
          ctx.log.debug(`message_end block reply flush failed: ${String(err)}`);
        });
      }
      // Final-flush the streaming directive accumulator so any partial
      // inline reply/audio tag held back by splitTrailingDirective gets
      // emitted on the message_end / blockReplyChunking path.
      emitSplitResultAsBlockReply(
        hasMedia && parsedText
          ? {
              ...parsedText,
              text: "",
            }
          : ctx.consumeReplyDirectives("", { final: true }),
      );
    } else if (text !== ctx.state.lastBlockReplyText || hasMedia) {
      // Guard: for text_end channels, if text_end already delivered content
      // (lastBlockReplyText is set), skip this safety send. The text comparison
      // here uses a different stripping pipeline (stripBlockTags with reset state)
      // than emitBlockChunk (stripBlockTags with running blockState +
      // stripDowngradedToolCallText), which can false-positive. When text_end
      // didn't deliver (e.g. commentary suppressed, provider skipped text_end),
      // lastBlockReplyText is still null and message_end must deliver.
      if (
        ctx.state.blockReplyBreak === "text_end" &&
        ctx.state.lastBlockReplyText != null &&
        !hasMedia
      ) {
        ctx.log.debug(
          `Skipping message_end safety send for text_end channel - content already delivered via text_end`,
        );
      } else {
        // Check for duplicates before emitting (same logic as emitBlockChunk).
        const normalizedText = normalizeTextForComparison(hasMedia ? cleanedText : text);
        if (
          isMessagingToolDuplicateNormalized(
            normalizedText,
            ctx.state.messagingToolSentTextsNormalized,
          )
        ) {
          ctx.log.debug(
            `Skipping message_end block reply - already sent via messaging tool: ${truncateUtf16Safe(text, 50)}...`,
          );
        } else {
          const alreadyDeliveredFinalText = Boolean(
            hasMedia && cleanedText && cleanedText === ctx.state.lastBlockReplyText,
          );
          ctx.state.lastBlockReplyText = hasMedia ? cleanedText || text : text;
          ctx.state.lastDeliveredBlockReplyText = hasMedia ? cleanedText || text : text;
          ctx.state.toolExecutionSinceLastBlockReply = false;
          emitSplitResultAsBlockReply(
            hasMedia && parsedText
              ? {
                  ...parsedText,
                  text: alreadyDeliveredFinalText ? "" : cleanedText,
                }
              : ctx.consumeReplyDirectives(text, { final: true }),
          );
        }
      }
    }
  }

  if (!shouldEmitReasoningBeforeAnswer) {
    maybeEmitReasoning();
  }
  if (!ctx.params.silentExpected && rawThinking) {
    // Emit-always: bus/archive get message-end thinking regardless of the
    // streamReasoning rendering setting (gated inside emitReasoningStream).
    ctx.emitReasoningStream(rawThinking);
  }

  if (
    !ctx.params.silentExpected &&
    !suppressMessageToolOnlySourceReplyOutput &&
    ctx.state.blockReplyBreak === "text_end" &&
    onBlockReply
  ) {
    emitSplitResultAsBlockReply(ctx.consumeReplyDirectives("", { final: true }));
  }

  if (
    !ctx.params.silentExpected &&
    ctx.state.blockReplyBreak === "message_end" &&
    ctx.params.onBlockReplyFlush
  ) {
    const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
    if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
      return flushBlockReplyBufferResult
        .then(() => {
          const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.({
            reason: "message_end",
          });
          if (isPromiseLike<void>(onBlockReplyFlushResult)) {
            return onBlockReplyFlushResult;
          }
          return undefined;
        })
        .finally(() => {
          finalizeMessageEnd();
        });
    }
    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush({ reason: "message_end" });
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult.finally(() => {
        finalizeMessageEnd();
      });
    }
  }

  finalizeMessageEnd();
  return undefined;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
