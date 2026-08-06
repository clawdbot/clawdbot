/**
 * Handles embedded-agent assistant message events, block replies, reasoning
 * streams, reply directives, and pending tool media attachment handoff.
 */
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { CONTINUE_WORK_TOKEN, stripContinuationSignal } from "../auto-reply/continuation/signal.js";
import {
  parseReplyDirectives,
  type ReplyDirectiveParseResult,
} from "../auto-reply/reply/reply-directives.js";
import { splitTrailingDirective } from "../auto-reply/reply/streaming-directives.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { AssistantMessage } from "../llm/types.js";
import { splitMediaFromOutput } from "../media/parse.js";
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
  createThinkingTagStreamState,
  extractThinkingFromTaggedStream,
  extractThinkingFromTaggedText,
  promoteThinkingTagsToBlocks,
  sanitizeAssistantVisibleStreamText,
} from "./embedded-agent-utils.js";
import type { AgentEvent, AgentMessage } from "./runtime/index.js";
import { hasRawToolValidationOutput, summarizeToolValidationError } from "./tool-error-summary.js";
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

function shouldSuppressValidationLoopAssistantOutput(params: {
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
    params.text ?? coerceChatContentText(extractAssistantText(params.message)),
  ]
    .filter(Boolean)
    .join("\n");
  return hasRawToolValidationOutput(candidateText);
}

function resetMessageEndStreamingState(ctx: EmbeddedAgentSubscribeContext): void {
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

function resolveCurrentSourceMessagingToolPartial(
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
  const normalized = normalizeTextForComparison(text);
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

function clearPendingToolMedia(
  state: Pick<
    EmbeddedAgentSubscribeState,
    | "pendingToolMediaUrls"
    | "pendingToolMediaAttachments"
    | "pendingToolMediaTrustByUrl"
    | "pendingToolAudioAsVoice"
  >,
) {
  state.pendingToolMediaUrls = [];
  state.pendingToolMediaAttachments = [];
  state.pendingToolMediaTrustByUrl.clear();
  state.pendingToolAudioAsVoice = false;
}

function hasReplyMedia(payload: BlockReplyPayload): boolean {
  return (payload.mediaUrls ?? []).some((url) => url.trim().length > 0);
}

function readAlignedPendingToolMedia(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "pendingToolMediaUrls" | "pendingToolMediaAttachments" | "pendingToolMediaTrustByUrl"
  >,
) {
  const seen = new Set<string>();
  const mediaUrls: string[] = [];
  const attachments: NonNullable<BlockReplyPayload["attachments"]> = [];
  for (const [index, url] of state.pendingToolMediaUrls.entries()) {
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    mediaUrls.push(url);
    const { trustedLocalMedia: _untrustedInput, ...attachment } =
      state.pendingToolMediaAttachments?.[index] ?? {};
    attachments.push({
      ...attachment,
      ...(state.pendingToolMediaTrustByUrl.get(url) === true ? { trustedLocalMedia: true } : {}),
    });
  }
  return {
    mediaUrls,
    attachments: attachments.some((entry) => Object.keys(entry).length > 0)
      ? attachments
      : undefined,
  };
}

/** Moves queued tool media into a non-reasoning assistant reply payload. */
export function consumePendingToolMediaIntoReply(
  state: Pick<
    EmbeddedAgentSubscribeState,
    | "pendingToolMediaUrls"
    | "pendingToolMediaAttachments"
    | "pendingToolMediaTrustByUrl"
    | "pendingToolAudioAsVoice"
  >,
  payload: BlockReplyPayload,
): BlockReplyPayload {
  if (payload.isReasoning) {
    return payload;
  }
  if (state.pendingToolMediaUrls.length === 0 && !state.pendingToolAudioAsVoice) {
    return payload;
  }
  if (hasReplyMedia(payload)) {
    // Pending tool media is a fallback delivery queue; explicit final media is
    // the assistant's user-visible selection, while tool output remains in the transcript.
    const alignedPendingMedia = readAlignedPendingToolMedia(state);
    const metadataByUrl = new Map(
      alignedPendingMedia.mediaUrls.map((url, index) => [
        url,
        alignedPendingMedia.attachments?.[index] ?? {},
      ]),
    );
    const selectedAttachments = (payload.mediaUrls ?? []).map(
      (url) => metadataByUrl.get(url.trim()) ?? {},
    );
    const allSelectedMediaIsPending =
      (payload.mediaUrls?.length ?? 0) > 0 &&
      (payload.mediaUrls ?? []).every((url) => metadataByUrl.has(url.trim()));
    const payloadWithMetadata =
      payload.attachments?.length ||
      selectedAttachments.every((entry) => Object.keys(entry).length === 0)
        ? payload
        : { ...payload, attachments: selectedAttachments };
    const selectedPayload =
      allSelectedMediaIsPending &&
      (payload.mediaUrls ?? []).every(
        (url) => state.pendingToolMediaTrustByUrl.get(url.trim()) === true,
      )
        ? { ...payloadWithMetadata, trustedLocalMedia: true }
        : payloadWithMetadata;
    clearPendingToolMedia(state);
    return selectedPayload;
  }
  const pendingMedia = readAlignedPendingToolMedia(state);
  const allPendingMediaTrusted =
    pendingMedia.mediaUrls.length > 0 &&
    pendingMedia.mediaUrls.every((url) => state.pendingToolMediaTrustByUrl.get(url) === true);
  const mergedPayload: BlockReplyPayload = {
    ...payload,
    mediaUrls: pendingMedia.mediaUrls.length ? pendingMedia.mediaUrls : undefined,
    attachments: pendingMedia.attachments,
    audioAsVoice: payload.audioAsVoice || state.pendingToolAudioAsVoice || undefined,
    ...(payload.trustedLocalMedia || allPendingMediaTrusted ? { trustedLocalMedia: true } : {}),
  };
  clearPendingToolMedia(state);
  return mergedPayload;
}

/** Consumes queued tool media as a standalone reply payload. */
export function consumePendingToolMediaReply(
  state: Pick<
    EmbeddedAgentSubscribeState,
    | "pendingToolMediaUrls"
    | "pendingToolMediaAttachments"
    | "pendingToolMediaTrustByUrl"
    | "pendingToolAudioAsVoice"
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
    | "pendingToolMediaUrls"
    | "pendingToolMediaAttachments"
    | "pendingToolMediaTrustByUrl"
    | "pendingToolAudioAsVoice"
  >,
): BlockReplyPayload | null {
  if (state.pendingToolMediaUrls.length === 0 && !state.pendingToolAudioAsVoice) {
    return null;
  }
  const pendingMedia = readAlignedPendingToolMedia(state);
  const allPendingMediaTrusted =
    pendingMedia.mediaUrls.length > 0 &&
    pendingMedia.mediaUrls.every((url) => state.pendingToolMediaTrustByUrl.get(url) === true);
  return {
    mediaUrls: pendingMedia.mediaUrls.length ? pendingMedia.mediaUrls : undefined,
    attachments: pendingMedia.attachments,
    audioAsVoice: state.pendingToolAudioAsVoice || undefined,
    ...(allPendingMediaTrusted ? { trustedLocalMedia: true } : {}),
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
  return stripContinuationSignalFromDisplayText(parseReplyDirectives(text).text);
}

function stripContinuationSignalFromDisplayText(text: string): string {
  const stripped = stripContinuationSignal(text);
  return stripped.signal ? stripped.text : text;
}

type PendingContinuationSignal = {
  start: number;
  sensitive: boolean;
};

const CONTINUATION_MARKER_CONFIDENCE_PREFIX = "CONTINUE_";
const CONTINUATION_DELEGATE_MARKER = "CONTINUE_DELEGATE:";

function findPendingBracketContinuationSignal(text: string): PendingContinuationSignal | undefined {
  let pendingSignal: PendingContinuationSignal | undefined;
  for (let bracketStart = text.lastIndexOf("[["); bracketStart >= 0;) {
    const markerText = text.slice(bracketStart + 2).trimStart();
    const sensitive = markerText.startsWith(CONTINUATION_MARKER_CONFIDENCE_PREFIX);
    if (
      !markerText ||
      CONTINUE_WORK_TOKEN.startsWith(markerText) ||
      CONTINUATION_DELEGATE_MARKER.startsWith(markerText)
    ) {
      pendingSignal = { start: bracketStart, sensitive };
    } else if (markerText.startsWith(CONTINUE_WORK_TOKEN)) {
      const tail = markerText.slice(CONTINUE_WORK_TOKEN.length);
      if (/^(?::\d+)?\s*\]\]\s*$/.test(tail)) {
        return undefined;
      }
      if (/^(?::\d*)?\s*\]?\]?\s*$/.test(tail)) {
        pendingSignal = { start: bracketStart, sensitive: true };
      }
    } else if (
      markerText.startsWith(CONTINUATION_DELEGATE_MARKER) &&
      !markerText.slice(CONTINUATION_DELEGATE_MARKER.length).includes("]]")
    ) {
      pendingSignal = { start: bracketStart, sensitive: true };
    }
    if (bracketStart === 0) {
      break;
    }
    bracketStart = text.lastIndexOf("[[", bracketStart - 1);
  }
  if (pendingSignal) {
    return pendingSignal;
  }
  if (text.endsWith("[")) {
    return { start: text.length - 1, sensitive: false };
  }
  return undefined;
}

function findPendingContinuationSignal(text: string): PendingContinuationSignal | undefined {
  const bracketSignal = findPendingBracketContinuationSignal(text);
  if (bracketSignal) {
    return bracketSignal;
  }

  const delayMatch = text.match(/\bCONTINUE_WORK:\d*$/);
  if (delayMatch?.index !== undefined) {
    return { start: delayMatch.index, sensitive: true };
  }
  const maxPrefixLength = Math.min(CONTINUE_WORK_TOKEN.length - 1, text.length);
  for (let length = maxPrefixLength; length > 0; length -= 1) {
    const start = text.length - length;
    const suffix = text.slice(start);
    if (
      CONTINUE_WORK_TOKEN.startsWith(suffix) &&
      (start === 0 || !/[A-Za-z0-9_]/.test(text[start - 1] ?? ""))
    ) {
      return {
        start,
        sensitive: suffix.startsWith(CONTINUATION_MARKER_CONFIDENCE_PREFIX),
      };
    }
  }
  return undefined;
}

function resolveCommentaryDisplayText(text: string, options?: { final?: boolean }): string {
  const pendingSignal = findPendingContinuationSignal(text);
  if (pendingSignal) {
    if (options?.final && !pendingSignal.sensitive) {
      return text;
    }
    return text.slice(0, pendingSignal.start);
  }
  return stripContinuationSignalFromDisplayText(text);
}

function emitCommentaryDisplayTransition(
  ctx: EmbeddedAgentSubscribeContext,
  rawText: string,
  params: {
    final?: boolean;
    itemId?: string;
    preferReplace?: boolean;
  },
): void {
  const previousText = ctx.state.lastStreamedCommentary ?? "";
  const nextText = resolveCommentaryDisplayText(rawText, { final: params.final });
  ctx.state.lastStreamedCommentary = nextText;
  if (nextText === previousText) {
    return;
  }
  const appendDelta = resolveTextAppendDelta(previousText, nextText);
  const useDelta = !params.preferReplace && appendDelta && nextText.startsWith(previousText);
  const data = useDelta
    ? buildAssistantStreamData({
        delta: appendDelta,
        phase: "commentary",
        itemId: params.itemId,
      })
    : buildAssistantStreamData({
        text: nextText,
        replace: true,
        phase: "commentary",
        itemId: params.itemId,
      });
  if (useDelta) {
    ctx.state.commentaryStreamedWithDelta = true;
  }
  ctx.emitAssistantStreamData(data);
}

function emitResolvedCommentaryDisplay(
  ctx: EmbeddedAgentSubscribeContext,
  rawText: string,
  params: {
    final?: boolean;
    itemId?: string;
    preferReplace?: boolean;
  },
): void {
  if (!ctx.state.assistantDisplayPhasePending) {
    emitCommentaryDisplayTransition(ctx, rawText, params);
    return;
  }
  const text = resolveCommentaryDisplayText(rawText, { final: params.final });
  const previousAssistantText = ctx.state.lastStreamedAssistantCleaned ?? "";
  const canAppendToAssistantDisplay =
    ctx.state.emittedAssistantUpdate && text.startsWith(previousAssistantText);
  const delta = canAppendToAssistantDisplay
    ? resolveTextAppendDelta(previousAssistantText, text)
    : "";
  ctx.state.assistantDisplayPhasePending = false;
  ctx.state.lastStreamedCommentary = text;
  ctx.state.commentaryStreamedWithDelta = canAppendToAssistantDisplay;
  if (delta) {
    ctx.emitAssistantStreamData(
      buildAssistantStreamData({
        delta,
        phase: "commentary",
        itemId: params.itemId,
      }),
    );
  }
  ctx.emitAssistantStreamData(
    buildAssistantStreamData({
      text,
      replace: true,
      phase: "commentary",
      itemId: params.itemId,
    }),
  );
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
  if (!params.parsedStreamDirectives && params.evtType === "text_delta") {
    return params.previousCleaned;
  }

  return (
    resolveIncrementalStreamingReplyText(params) ??
    parseFullStreamingReplyText(
      params.evtType === "text_end" ? params.next : splitTrailingDirective(params.next).text,
    )
  );
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

function hasReplyTargetOnlyTerminalEvidence(parsed: ReplyDirectiveParseResult): boolean {
  const hasReplyTarget = Boolean(parsed.replyToId || parsed.replyToTag || parsed.replyToCurrent);
  return (
    hasReplyTarget &&
    parsed.text.trim().length === 0 &&
    !resolveSendableOutboundReplyParts(parsed).hasMedia &&
    !parsed.audioAsVoice &&
    !parsed.reaction
  );
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
  options?: { streamItemBoundaryReplayed?: boolean; deliveryGeneration?: number },
): void | Promise<void> {
  if (
    options?.deliveryGeneration !== undefined &&
    options.deliveryGeneration !== ctx.getBlockReplyDeliveryGeneration()
  ) {
    return;
  }
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
  const isAnthropicTextEvent =
    isAnthropicAssistantMessage(eventAssistantMessage) &&
    (evtType === "text_start" || evtType === "text_delta" || evtType === "text_end");
  const suppressVisibleAssistantOutput = shouldSuppressAssistantVisibleOutput(msg);
  if (suppressVisibleAssistantOutput && !isResponsesTextEvent && !isAnthropicTextEvent) {
    const rawCommentaryText = coerceChatContentText(extractAssistantCommentaryText(msg));
    appendRawStream({
      ts: Date.now(),
      event: "assistant_text_stream",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      evtType: "commentary_update",
      delta: "",
      content: rawCommentaryText,
    });
    emitResolvedCommentaryDisplay(ctx, rawCommentaryText, { preferReplace: true });
    return;
  }
  const suppressDeterministicApprovalOutput = shouldSuppressDeterministicApprovalOutput(ctx.state);
  const suppressMessageToolOnlySourceReplyOutput = hasMessageToolOnlySourceDelivery(ctx);

  const assistantPhase = resolveAssistantMessagePhase(msg);
  const validationErrorSummary = ctx.state.lastToolError
    ? summarizeToolValidationError(ctx.state.lastToolError)
    : undefined;

  if (evtType === "text_end" || evtType === "done" || evtType === "error") {
    capturePendingAssistantUsage(ctx, evt);
    if (evtType === "done" || evtType === "error") {
      ctx.commitAssistantUsage();
    }
  }

  if (
    shouldSuppressValidationLoopAssistantOutput({
      message: msg,
      assistantRecord,
      validationErrorSummary,
    })
  ) {
    return;
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

  let chunk = resolveAssistantTextChunk({
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
  const hasAnthropicContentIndex =
    streamContentIndex !== undefined && isAnthropicAssistantMessage(partialAssistant);
  let streamItemChanged = options?.streamItemBoundaryReplayed === true;
  let deliveryItemId = streamItemId;
  if (
    (deliveryPhase ||
      isPhasePendingResponsesTextItem ||
      hasResponsesContentIndex ||
      hasAnthropicContentIndex) &&
    (streamContentIndex !== undefined || streamItemId)
  ) {
    const previousStreamContentIndex = ctx.state.lastAssistantStreamContentIndex;
    const previousStreamItemId = ctx.state.lastAssistantStreamItemId;
    const isDelayedUnphasedAnthropicTextEnd =
      evtType === "text_end" &&
      isAnthropicAssistantMessage(partialAssistant) &&
      deliveryPhase !== "commentary" &&
      previousStreamContentIndex !== undefined &&
      streamContentIndex !== undefined &&
      streamContentIndex < previousStreamContentIndex;
    if (isDelayedUnphasedAnthropicTextEnd) {
      return;
    }
    const contentIndexChanged =
      previousStreamContentIndex !== undefined &&
      streamContentIndex !== undefined &&
      previousStreamContentIndex !== streamContentIndex;
    const itemIdChangedWithoutIndexes =
      (previousStreamContentIndex === undefined || streamContentIndex === undefined) &&
      Boolean(previousStreamItemId && streamItemId && previousStreamItemId !== streamItemId);
    if (contentIndexChanged || itemIdChangedWithoutIndexes) {
      streamItemChanged = true;
      if (ctx.state.lastStreamedCommentary !== undefined) {
        emitCommentaryDisplayTransition(ctx, ctx.state.deltaBuffer, {
          final: true,
          itemId: previousStreamItemId,
        });
      }
      const finishStreamItemBoundary = () => {
        ctx.resetAssistantMessageState(ctx.state.assistantTexts.length, {
          preserveReplyDirectiveState: true,
        });
        ctx.state.lastAssistantStreamContentIndex = streamContentIndex;
        ctx.state.lastAssistantStreamItemId = deliveryItemId;
        emitAssistantMessageStart(ctx);
      };
      const flushBoundaryResult = ctx.flushBlockReplyBuffer({
        assistantMessageIndex: ctx.state.assistantMessageIndex,
      });
      if (isPromiseLike<void>(flushBoundaryResult)) {
        return Promise.resolve(flushBoundaryResult).then(() => {
          if (
            options?.deliveryGeneration !== undefined &&
            options.deliveryGeneration !== ctx.getBlockReplyDeliveryGeneration()
          ) {
            return;
          }
          finishStreamItemBoundary();
          return handleMessageUpdate(ctx, evt, {
            ...options,
            streamItemBoundaryReplayed: true,
          });
        });
      }
      finishStreamItemBoundary();
      if (evtType === "text_end" && isAnthropicAssistantMessage(partialAssistant)) {
        chunk = coerceChatContentText(extractAssistantText(streamAssistant));
      }
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
  // Responses and Anthropic text_start snapshots may contain text replayed by the first delta.
  // Keep starts lifecycle-only so commentary and final-answer lanes consume each byte once.
  if (
    evtType === "text_start" &&
    (isResponsesApiAssistantMessage(partialAssistant) ||
      isAnthropicAssistantMessage(partialAssistant))
  ) {
    return;
  }
  if (deliveryPhase === "commentary") {
    if (chunk) {
      ctx.state.deltaBuffer += chunk;
    } else if (!ctx.state.deltaBuffer) {
      ctx.state.deltaBuffer = coerceChatContentText(
        extractAssistantCommentaryText(streamAssistant),
      );
    }
    emitResolvedCommentaryDisplay(ctx, ctx.state.deltaBuffer, {
      itemId: deliveryItemId,
      preferReplace: !chunk,
    });
    return;
  }
  if (isPhasePendingResponsesTextItem) {
    return;
  }
  const isAssistantDisplayPhasePending =
    isPhasePendingAnthropicText || isPhasePendingCompletionsText;
  if (isAssistantDisplayPhasePending) {
    ctx.state.assistantDisplayPhasePending = true;
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
  ctx.emitReasoningStream(
    extractThinkingFromTaggedStream(ctx.state.deltaBuffer, ctx.state.thinkingTagStream),
  );
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
    const displayPhaseResolved = Boolean(deliveryPhase) && !isAssistantDisplayPhasePending;
    const displayText =
      isAssistantDisplayPhasePending || ctx.state.assistantDisplayPhasePending
        ? resolveCommentaryDisplayText(cleanedText, {
            final: displayPhaseResolved || evtType === "text_end",
          })
        : cleanedText;
    const { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedStreamDirectives ?? {});
    const hasAudio = Boolean(parsedStreamDirectives?.audioAsVoice);

    let shouldEmit;
    let deltaText = "";
    let replace = false;
    if (!hasAssistantVisibleReply({ text: displayText, mediaUrls, audioAsVoice: hasAudio })) {
      shouldEmit = false;
    } else {
      replace = Boolean(previousCleaned && !displayText.startsWith(previousCleaned));
      deltaText = replace ? "" : displayText.slice(previousCleaned.length);
      shouldEmit = replace
        ? displayText !== previousCleaned || hasMedia || hasAudio
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
    ctx.state.lastStreamedAssistantCleaned = displayText;
    if (displayPhaseResolved) {
      ctx.state.assistantDisplayPhasePending = false;
    }

    if (
      ctx.params.silentExpected ||
      suppressDeterministicApprovalOutput ||
      suppressMessageToolOnlySourceReplyOutput
    ) {
      shouldEmit = false;
    }

    if (shouldEmit) {
      const currentSourcePartial =
        ctx.params.sourceReplyDeliveryMode !== "message_tool_only"
          ? resolveCurrentSourceMessagingToolPartial(ctx.state, {
              evtType,
              text: displayText,
              visibleDelta,
            })
          : { hold: false, text: displayText };
      const releaseHeldSnapshot = currentSourcePartial.text !== displayText;
      const data = buildAssistantStreamData({
        text: currentSourcePartial.text,
        delta: releaseHeldSnapshot ? currentSourcePartial.text : deltaText,
        replace: releaseHeldSnapshot || replace,
        mediaUrls,
        phase: deliveryPhase ?? assistantPhase,
      });
      ctx.emitAssistantStreamData(data, { emitPartialReply: !currentSourcePartial.hold });
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
    try {
      const flushResult = ctx.flushBlockReplyBuffer({ assistantMessageIndex, final: true });
      if (isPromiseLike<void>(flushResult)) {
        return Promise.resolve(flushResult).catch((err: unknown) => {
          ctx.log.debug(`text_end block reply flush failed: ${String(err)}`);
        });
      }
    } catch (err) {
      ctx.log.debug(`text_end block reply flush failed: ${String(err)}`);
    }
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedSubscribeMessagesTestApi")
  ] = {
    buildAssistantStreamData,
    recordPendingAssistantReplyDirectives,
    resolveCurrentSourceMessagingToolPartial,
  };
}

/** Handles assistant message-end finalization, block flush, and usage commit. */
export function handleMessageEnd(
  ctx: EmbeddedAgentSubscribeContext,
  evt: AgentEvent & { message: AgentMessage },
  options?: { deliveryGeneration?: number },
): void | Promise<void> {
  if (
    options?.deliveryGeneration !== undefined &&
    options.deliveryGeneration !== ctx.getBlockReplyDeliveryGeneration()
  ) {
    return;
  }
  const isCurrentDeliveryGeneration = () =>
    options?.deliveryGeneration === undefined ||
    options.deliveryGeneration === ctx.getBlockReplyDeliveryGeneration();
  const msg = evt.message;
  if (msg?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(msg)) {
    return;
  }
  const preflightBlockReplyResult = ctx.settleBlockReplyDeliveries?.({
    retryFailures: true,
  });
  if (isPromiseLike<void>(preflightBlockReplyResult)) {
    return Promise.resolve(preflightBlockReplyResult).then(() =>
      handleMessageEnd(ctx, evt, options),
    );
  }
  const hasTextEndBufferedBlockReply =
    ctx.state.blockReplyBreak === "text_end" &&
    ((ctx.blockChunker?.hasBuffered() ?? false) || ctx.state.blockBuffer.length > 0);
  if (hasTextEndBufferedBlockReply) {
    const flushTextEndBufferResult = ctx.flushBlockReplyBuffer({
      assistantMessageIndex: ctx.state.assistantMessageIndex,
      final: true,
    });
    if (isPromiseLike<void>(flushTextEndBufferResult)) {
      return Promise.resolve(flushTextEndBufferResult).then(() =>
        handleMessageEnd(ctx, evt, options),
      );
    }
  }

  // Transcript-only messages never reach the provider, so this counts exactly
  // the completed model round trips consumers see as `assistantTurns`.
  ctx.state.assistantTurnCount += 1;
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
    const shouldScopeCommentary =
      isResponsesCommentary || isAnthropicAssistantMessage(assistantMessage);
    const commentaryMessage = shouldScopeCommentary
      ? scopeAssistantMessageToStreamBlock(
          assistantMessage as AssistantMessage,
          ctx.state.lastAssistantStreamContentIndex,
          ctx.state.lastAssistantStreamItemId,
        )
      : assistantMessage;
    const rawCommentaryText = coerceChatContentText(
      extractAssistantCommentaryText(commentaryMessage),
    );
    appendRawStream({
      ts: Date.now(),
      event: "assistant_message_end",
      runId: ctx.params.runId,
      sessionId: (ctx.params.session as { id?: string }).id,
      rawText: coerceChatContentText(extractAssistantText(assistantMessage)),
      rawThinking: extractAssistantThinking(assistantMessage),
    });
    emitResolvedCommentaryDisplay(ctx, rawCommentaryText, {
      final: true,
      itemId: ctx.state.lastAssistantStreamItemId,
      preferReplace: !ctx.state.commentaryStreamedWithDelta,
    });
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
  const validationErrorSummary = ctx.state.lastToolError
    ? summarizeToolValidationError(ctx.state.lastToolError)
    : undefined;
  if (
    shouldSuppressValidationLoopAssistantOutput({
      message: assistantMessage,
      validationErrorSummary,
      text: rawText,
    })
  ) {
    resetMessageEndStreamingState(ctx);
    return;
  }
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

  // Exact NO_REPLY stays silent. The legacy rewrite (silentReplyRewrite) was
  // removed by contract; global messaging-tool send evidence is not a
  // user-route reply and must never be mirrored into the final payload.
  const text = finalVisibleText;
  const rawThinking =
    ctx.state.includeReasoning || ctx.state.streamReasoning
      ? extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(rawText)
      : "";
  const trimmedReasoning = rawThinking ? rawThinking.trim() : "";
  const trimmedText = text.trim();
  let replyTargetOnlyTerminalEvidence = false;
  const parsedText = (() => {
    if (!trimmedText) {
      return null;
    }
    const parsed = parseReplyDirectives(trimmedText);
    replyTargetOnlyTerminalEvidence = hasReplyTargetOnlyTerminalEvidence(parsed);
    const displayText = resolveCommentaryDisplayText(parsed.text, { final: true });
    return displayText === parsed.text ? parsed : { ...parsed, text: displayText };
  })();
  const cleanedText = parsedText?.text ?? "";
  const { mediaUrls, hasMedia } = resolveSendableOutboundReplyParts(parsedText ?? {});

  const finalizeMessageEnd = () => {
    resetMessageEndStreamingState(ctx);
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
  const finalAssistantText = silentExpectedWithoutSentinel ? "" : cleanedText;
  const terminalAssistantTextEvidence = replyTargetOnlyTerminalEvidence
    ? trimmedText
    : finalAssistantText;
  const deliveredBlockReplyTexts = ctx.state.deliveredBlockReplyTexts.filter(Boolean);
  const attemptedBlockReplyTexts = (ctx.state.attemptedBlockReplyTexts ?? []).filter(Boolean);
  const effectiveDeliveredBlockReplyTexts =
    attemptedBlockReplyTexts.length > 0
      ? attemptedBlockReplyTexts
      : deliveredBlockReplyTexts.length > 0
        ? deliveredBlockReplyTexts
        : ctx.state.deferredBlockReplyTexts;
  const deliveredCanonicalPrefix = (() => {
    if (!finalAssistantText || effectiveDeliveredBlockReplyTexts.length === 0) {
      return undefined;
    }
    let cursor = 0;
    for (const deliveredText of effectiveDeliveredBlockReplyTexts) {
      const matchIndex = finalAssistantText.indexOf(deliveredText, cursor);
      if (matchIndex < 0 || finalAssistantText.slice(cursor, matchIndex).trim().length > 0) {
        return undefined;
      }
      cursor = matchIndex + deliveredText.length;
    }
    return finalAssistantText.slice(0, cursor);
  })();
  const textEndDeliveredText =
    deliveredCanonicalPrefix ?? (effectiveDeliveredBlockReplyTexts.join("\n") || undefined);
  const textEndDeliveredVisibleText =
    textEndDeliveredText != null
      ? resolveCommentaryDisplayText(textEndDeliveredText, {
          final: true,
        })
      : undefined;
  const finalTextMatchesDelivered =
    textEndDeliveredVisibleText != null &&
    normalizeTextForComparison(finalAssistantText) ===
      normalizeTextForComparison(textEndDeliveredVisibleText);
  const finalTextCorrection = finalTextMatchesDelivered
    ? ""
    : textEndDeliveredVisibleText && finalAssistantText.startsWith(textEndDeliveredVisibleText)
      ? finalAssistantText.slice(textEndDeliveredVisibleText.length)
      : finalAssistantText !== textEndDeliveredVisibleText
        ? finalAssistantText
        : "";
  const resolveUndeliveredFinalDirectives = () => {
    const deliveredReplyDirectives = ctx.state.lastDeliveredAssistantReplyDirectives;
    const deferredReplyDirectives = ctx.state.deferredAssistantReplyDirectives;
    const undeliveredMediaUrls = mediaUrls.filter(
      (url) =>
        !deliveredReplyDirectives?.mediaUrls?.includes(url) &&
        !deferredReplyDirectives?.mediaUrls?.includes(url),
    );
    const undeliveredAudioAsVoice = Boolean(
      parsedText?.audioAsVoice &&
      !deliveredReplyDirectives?.audioAsVoice &&
      !deferredReplyDirectives?.audioAsVoice,
    );
    const hasUndeliveredReplyToId = Boolean(
      parsedText?.replyToId &&
      parsedText.replyToId !== deliveredReplyDirectives?.replyToId &&
      parsedText.replyToId !== deferredReplyDirectives?.replyToId,
    );
    const hasUndeliveredReplyToTag = Boolean(
      parsedText?.replyToTag &&
      !deliveredReplyDirectives?.replyToTag &&
      !deferredReplyDirectives?.replyToTag,
    );
    const hasUndeliveredReplyToCurrent = Boolean(
      parsedText?.replyToCurrent &&
      !deliveredReplyDirectives?.replyToCurrent &&
      !deferredReplyDirectives?.replyToCurrent,
    );
    const hasUndeliveredReplyTarget =
      hasUndeliveredReplyToId || hasUndeliveredReplyToTag || hasUndeliveredReplyToCurrent;
    const hasMetadata =
      undeliveredMediaUrls.length > 0 || undeliveredAudioAsVoice || hasUndeliveredReplyTarget;
    const result = parsedText
      ? {
          ...parsedText,
          mediaUrls: undeliveredMediaUrls.length ? undeliveredMediaUrls : undefined,
          audioAsVoice: undeliveredAudioAsVoice || undefined,
          replyToId: hasUndeliveredReplyToId ? parsedText.replyToId : undefined,
          replyToTag: hasUndeliveredReplyToTag,
          replyToCurrent: hasUndeliveredReplyToCurrent || undefined,
        }
      : null;
    return {
      result,
      mediaUrls: undeliveredMediaUrls,
      audioAsVoice: undeliveredAudioAsVoice,
      hasReplyTarget: hasUndeliveredReplyTarget,
      hasMetadata,
    };
  };
  const finalDirectives = resolveUndeliveredFinalDirectives();
  const hasFinalAssistantReply = hasAssistantVisibleReply({
    text: finalAssistantText,
    mediaUrls,
    audioAsVoice: parsedText?.audioAsVoice,
  });
  const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
  const currentMessageAssistantText = ctx.state.assistantTexts
    .slice(ctx.state.assistantTextBaseline)
    .join("\n");
  const chunkerHasBuffered = ctx.blockChunker?.hasBuffered() ?? false;
  ctx.finalizeAssistantTexts({
    text: terminalAssistantTextEvidence,
    addedDuringMessage,
    chunkerHasBuffered,
    reconcileCurrentMessage:
      ctx.state.blockReplyBreak === "text_end" &&
      addedDuringMessage &&
      !replyTargetOnlyTerminalEvidence &&
      finalAssistantText !== currentMessageAssistantText,
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
    onDelivered?: () => void,
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
    const displayTextLocal = resolveCommentaryDisplayText(cleanedTextLocal, { final: true });
    // Emit if there's content OR audioAsVoice flag (to propagate the flag).
    if (
      hasAssistantVisibleReply({ text: displayTextLocal, mediaUrls: mediaUrlsLocal, audioAsVoice })
    ) {
      ctx.emitBlockReply(
        {
          text: displayTextLocal,
          mediaUrls: mediaUrlsLocal?.length ? mediaUrlsLocal : undefined,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        },
        {
          assistantMessageIndex: ctx.state.assistantMessageIndex,
          onDelivered,
        },
      );
    }
  };

  const finishMessageEndDelivery = (): void | Promise<void> => {
    if (!isCurrentDeliveryGeneration()) {
      return;
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
            if (!isCurrentDeliveryGeneration()) {
              return undefined;
            }
            const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.({
              reason: "message_end",
            });
            if (isPromiseLike<void>(onBlockReplyFlushResult)) {
              return onBlockReplyFlushResult;
            }
            return undefined;
          })
          .finally(() => {
            if (isCurrentDeliveryGeneration()) {
              finalizeMessageEnd();
            }
          });
      }
      const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush({ reason: "message_end" });
      if (isPromiseLike<void>(onBlockReplyFlushResult)) {
        return onBlockReplyFlushResult.finally(() => {
          if (isCurrentDeliveryGeneration()) {
            finalizeMessageEnd();
          }
        });
      }
    }

    finalizeMessageEnd();
    return undefined;
  };

  // The accumulator must always be final-flushed so an incomplete bracket tail held
  // back by splitTrailingDirective is released, while still emitting undelivered
  // continuation metadata (media/audio/reply target) exactly once.
  const composeFinalBlockReply = (
    bufferedResult: ReturnType<typeof ctx.consumeReplyDirectives>,
  ) => {
    const remainingFinalDirectives = resolveUndeliveredFinalDirectives();
    if (!remainingFinalDirectives.hasMetadata || !remainingFinalDirectives.result) {
      return bufferedResult;
    }
    return {
      ...remainingFinalDirectives.result,
      text:
        remainingFinalDirectives.hasReplyTarget &&
        remainingFinalDirectives.mediaUrls.length === 0 &&
        !remainingFinalDirectives.audioAsVoice
          ? finalAssistantText
          : (bufferedResult?.text ?? ""),
    };
  };

  const consumeFinalReplyDirectives = () => {
    const bufferedResult = ctx.consumeReplyDirectives("", { final: true });
    if (!hasMedia || !parsedText) {
      return bufferedResult;
    }
    const bufferedRawText = bufferedResult?.text ?? "";
    const leadingWhitespace = bufferedRawText.match(/^\s+/u)?.[0] ?? "";
    const strippedBufferedText = bufferedRawText ? splitMediaFromOutput(bufferedRawText).text : "";
    const bufferedText =
      leadingWhitespace &&
      strippedBufferedText &&
      !strippedBufferedText.startsWith(leadingWhitespace)
        ? `${leadingWhitespace}${strippedBufferedText}`
        : strippedBufferedText;
    return bufferedResult
      ? {
          ...bufferedResult,
          text: bufferedText,
        }
      : {
          text: bufferedText,
          replyToTag: false,
          isSilent: false,
        };
  };

  const hasBufferedBlockReply = ctx.blockChunker
    ? ctx.blockChunker.hasBuffered()
    : ctx.state.blockBuffer.length > 0;

  if (
    !ctx.params.silentExpected &&
    !suppressDeterministicApprovalOutput &&
    !suppressMessageToolOnlySourceReplyOutput &&
    hasFinalAssistantReply &&
    onBlockReply &&
    (hasBufferedBlockReply ||
      finalAssistantText !== textEndDeliveredVisibleText ||
      finalDirectives.hasMetadata)
  ) {
    if (hasBufferedBlockReply && ctx.blockChunker?.hasBuffered()) {
      const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer({
        assistantMessageIndex: ctx.state.assistantMessageIndex,
        final: true,
      });
      if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
        return Promise.resolve(flushBlockReplyBufferResult).then(
          () => {
            if (!isCurrentDeliveryGeneration()) {
              return undefined;
            }
            emitSplitResultAsBlockReply(composeFinalBlockReply(consumeFinalReplyDirectives()));
            return finishMessageEndDelivery();
          },
          (err: unknown) => {
            ctx.log.debug(`message_end block reply flush failed: ${String(err)}`);
            if (!isCurrentDeliveryGeneration()) {
              return undefined;
            }
            return finishMessageEndDelivery();
          },
        );
      }
      // Final-flush the streaming directive accumulator so any partial
      // inline reply/audio tag held back by splitTrailingDirective gets
      // emitted on the message_end / blockReplyChunking path.
      emitSplitResultAsBlockReply(composeFinalBlockReply(consumeFinalReplyDirectives()));
    } else if (finalAssistantText !== textEndDeliveredVisibleText || finalDirectives.hasMetadata) {
      // Skip only an unchanged text_end delivery. Canonical message_end text
      // can extend or replace the streamed snapshot, and final-only directive
      // metadata can still require a second delivery.
      if (
        ctx.state.blockReplyBreak === "text_end" &&
        ctx.state.lastBlockReplyText != null &&
        !finalTextCorrection &&
        !finalDirectives.hasMetadata
      ) {
        ctx.log.debug(
          `Skipping message_end safety send for text_end channel - content already delivered via text_end`,
        );
      } else {
        // Check for duplicates before emitting (same logic as emitBlockChunk).
        const normalizedText = normalizeTextForComparison(finalTextCorrection || cleanedText);
        if (
          isMessagingToolDuplicateNormalized(
            normalizedText,
            ctx.state.messagingToolSentTextsNormalized,
          )
        ) {
          ctx.log.debug(
            `Skipping message_end block reply - already sent via messaging tool: ${truncateUtf16Safe(finalAssistantText, 50)}...`,
          );
        } else {
          const metadataOnlyText =
            finalDirectives.hasReplyTarget &&
            finalDirectives.mediaUrls.length === 0 &&
            !finalDirectives.audioAsVoice
              ? finalAssistantText
              : "";
          const correctionPayload = hasReplyDirectiveMetadataResult(finalDirectives.result)
            ? {
                ...finalDirectives.result,
                text: finalTextCorrection || metadataOnlyText,
              }
            : textEndDeliveredText != null
              ? {
                  ...parseReplyDirectives(finalAssistantText),
                  text: finalTextCorrection,
                }
              : ctx.consumeReplyDirectives(finalAssistantText, { final: true });
          // A correction is canonical text minus what text_end delivered, so it
          // already carries the tail splitTrailingDirective is still holding.
          // Drain that residue here or finishMessageEndDelivery releases it a
          // second time and the channel sees the tail twice.
          if (finalTextCorrection) {
            ctx.consumeReplyDirectives("", { final: true });
          }
          ctx.state.lastBlockReplyText = finalAssistantText;
          ctx.state.toolExecutionSinceLastBlockReply = false;
          emitSplitResultAsBlockReply(correctionPayload, () => {
            ctx.state.lastDeliveredBlockReplyText = finalAssistantText;
            if (finalAssistantText) {
              ctx.state.deliveredBlockReplyTexts = [finalAssistantText];
              ctx.state.attemptedBlockReplyTexts = [finalAssistantText];
            }
          });
        }
      }
    }
  }

  return finishMessageEndDelivery();
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
