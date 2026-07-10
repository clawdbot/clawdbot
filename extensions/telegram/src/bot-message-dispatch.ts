// Telegram plugin module implements bot message dispatch behavior.
import path from "node:path";
import type { Bot } from "grammy";
import {
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import { runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import { CURRENT_MESSAGE_MARKER } from "openclaw/plugin-sdk/channel-mention-gating";
import {
  createChannelMessageReplyPipeline,
  createPreviewMessageReceipt,
  createOutboundPayloadPlan,
  deriveDurableFinalDeliveryRequirements,
  projectOutboundPayloadPlanForDelivery,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftLine,
  type ChannelProgressDraftCompositorLine,
  createChannelProgressDraftCompositor,
  isChannelProgressDraftWorkToolName,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingPreviewToolProgress,
  resolveTranscriptBackedChannelFinalText,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import {
  isFastModeAutoProgressPayload,
  isReplyPayloadNonTerminalToolErrorWarning,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { BlockReplyContext } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import {
  appendAssistantMirrorMessageByIdentity,
  readLatestAssistantTextByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveTelegramConfigReasoningDefault } from "./agent-config.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
  resolveAgentDir,
  resolveDefaultModelForAgent,
} from "./bot-message-dispatch.agent.runtime.js";
import { deduplicateBlockSentMedia } from "./bot-message-dispatch.media-dedup.js";
import {
  generateTopicLabel,
  getAgentScopedMediaLocalRoots,
  getSessionEntry,
  resolveAutoTopicLabelConfig,
  resolveChunkMode,
  resolveMarkdownTableMode,
  type SessionEntry,
} from "./bot-message-dispatch.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { deliverReplies, emitInternalMessageSentHook } from "./bot/delivery.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramGroupFrom,
  buildTelegramInboundOriginTarget,
  buildTypingThreadParams,
  getTelegramTextParts,
  resolveTelegramReplyId,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import {
  addTelegramNativeQuoteCandidate,
  buildTelegramNativeQuoteCandidate,
  type TelegramNativeQuoteCandidateByMessageId,
} from "./bot/native-quote.js";
import type { TelegramStreamMode } from "./bot/types.js";
import { resolveTelegramInlineButtons, type TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream, type TelegramDraftPreview } from "./draft-stream.js";
import {
  buildTelegramErrorScopeKey,
  isSilentErrorPolicy,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  isTelegramHistoryEntryAfterAmbientWatermark,
  mergeTelegramGroupHistoryPromptContext,
  retainTelegramGroupHistoryPromptContext,
  selectTelegramGroupHistoryAfterLastSelf,
} from "./group-history-window.js";
import { beginTelegramInboundEventDeliveryCorrelation } from "./inbound-event-delivery.js";
import { materializeTelegramChartFallback } from "./interactive-fallback.js";
import {
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
} from "./lane-delivery.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import {
  recordOutboundMessageForPromptContext,
  withTelegramPromptContextTimestampMs,
} from "./outbound-message-context.js";
import {
  createTelegramProgressSummaryTracker,
  formatTelegramProgressSummaryLine,
} from "./progress-summary.js";
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText,
} from "./reasoning-lane-coordinator.js";
import {
  buildTelegramRichHtml,
  buildTelegramRichMarkdown,
  splitTelegramRichMarkdownChunks,
  TELEGRAM_RICH_TEXT_LIMIT,
} from "./rich-message.js";
import { editMessageTelegram } from "./send.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";
import {
  beginTelegramReplyFence,
  buildTelegramNonInterruptingReplyFenceKey,
  buildTelegramReplyFenceLaneKey,
  endTelegramReplyFence,
  isTelegramReplyFenceSuperseded,
  releaseTelegramReplyFenceAbortController,
  resetTelegramReplyFenceForTests,
  resolveTelegramReplyFenceKey,
  shouldSupersedeTelegramReplyFence,
  supersedeTelegramReplyFence,
} from "./telegram-reply-fence.js";
import { clipTelegramProgressText } from "./truncate.js";

export { resetTelegramReplyFenceForTests };

// Telegram sendChatAction can fail transiently; keep the tolerance scoped to this transport.
const TELEGRAM_MAX_CONSECUTIVE_TYPING_FAILURES = 5;
const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const silentReplyDispatchLogger = createSubsystemLogger("telegram/silent-reply-dispatch");

/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;

type DraftPartialTextUpdate = {
  text: string;
  delta?: string;
  replace?: true;
  isReasoningSnapshot?: boolean;
};

function resolveDraftPartialText(
  previous: string,
  update: DraftPartialTextUpdate,
): string | undefined {
  const nextText =
    update.replace || update.isReasoningSnapshot || update.delta === undefined
      ? update.text
      : `${previous}${update.delta}`;
  if (nextText === previous) {
    return undefined;
  }
  return nextText;
}

function resolvePayloadTelegramInlineButtons(
  payload: ReplyPayload,
): TelegramInlineButtons | undefined {
  const telegramData = payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons }
    | undefined;
  const presentation = normalizeMessagePresentation(payload.presentation);
  return resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation,
    interactive: payload.interactive,
  });
}

function hasExecApprovalPayload(payload: ReplyPayload): boolean {
  return payload.channelData?.execApproval !== undefined;
}

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

function includeStickerDescription(body: string | undefined, formattedDescription: string): string {
  if (!body) {
    return formattedDescription;
  }
  const current = body.trim();
  if (!current || current === "<media:image>") {
    return formattedDescription;
  }
  // Cached descriptions can already be present from inbound context construction.
  // Keep that body intact so captions, forwarded text, and supplemental context survive.
  if (body.includes(formattedDescription)) {
    return body;
  }
  return `${formattedDescription}\n${body}`;
}

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  telegramDeps?: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token" | "mediaMaxMb">;
  retryDispatchErrors?: boolean;
  suppressFailureFallback?: boolean;
  /** Fires after recovery-relevant session/run state is durably persisted. */
  onTurnAdopted?: () => void | Promise<void>;
  /** Marks a queued follow-up whose adoption will happen at reply-lane admission. */
  onTurnDeferred?: () => void;
  /** Releases a deferred turn that completed without ever owning the reply lane. */
  onTurnAbandoned?: () => void;
  /** Cancels queued/model work when ingress ownership fails before adoption. */
  turnAbortSignal?: AbortSignal;
};

type TelegramDispatchResult = { kind: "completed" } | { kind: "failed-retryable"; error: unknown };

type TelegramReasoningLevel = "off" | "on" | "stream";

type TelegramTranscriptMirrorPayload = { text?: string; mediaUrls?: string[] };
type CurrentTurnTranscriptFinal = { text: string; timestamp: number };
type TelegramScopedTranscriptSession = { sessionId: string; storePath: string };
type FreshTelegramSessionEntryLoader = ((
  agentId: string,
  sessionKey: string,
) => {
  storePath: string;
  entry?: SessionEntry;
}) & {
  clear: () => void;
};

function createFreshTelegramSessionEntryLoader(params: {
  cfg: OpenClawConfig;
  telegramDeps: TelegramBotDeps;
}): FreshTelegramSessionEntryLoader {
  const entriesByPathAndKey = new Map<string, SessionEntry | undefined>();
  const load = ((agentId: string, sessionKey: string) => {
    const storePath = params.telegramDeps.resolveStorePath(params.cfg.session?.store, { agentId });
    const cacheKey = `${storePath}\0${sessionKey}`;
    if (entriesByPathAndKey.has(cacheKey)) {
      return { storePath, entry: entriesByPathAndKey.get(cacheKey) };
    }
    const entry = (params.telegramDeps.getSessionEntry ?? getSessionEntry)({
      storePath,
      sessionKey,
      readConsistency: "latest",
    });
    entriesByPathAndKey.set(cacheKey, entry);
    return { storePath, entry };
  }) as FreshTelegramSessionEntryLoader;
  load.clear = () => entriesByPathAndKey.clear();
  return load;
}

function resolveTelegramReasoningLevel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
}): TelegramReasoningLevel {
  const { cfg, sessionKey, agentId } = params;
  const configDefault = resolveTelegramConfigReasoningDefault(cfg, agentId);
  if (!sessionKey) {
    return configDefault;
  }
  try {
    const { entry } = params.loadFreshSessionEntry(agentId, sessionKey);
    const level = entry?.reasoningLevel;
    if (level === "on" || level === "stream" || level === "off") {
      return level;
    }
  } catch {
    return "off";
  }
  return configDefault;
}

function resolveTelegramMirroredTranscriptText(
  payload: TelegramTranscriptMirrorPayload,
): string | null {
  const mediaUrls = payload.mediaUrls?.filter((url) => url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    return mediaUrls
      .map((url) => {
        const pathname = url.split("#")[0]?.split("?")[0] ?? url;
        const base = path.basename(pathname);
        return base && base !== "." && base !== "/" ? base : "media";
      })
      .join(", ");
  }

  const text = payload.text?.trim();
  return text ? text : null;
}

function resolveTelegramScopedTranscriptSession(params: {
  agentId: string;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
  sessionKey: string;
}): TelegramScopedTranscriptSession | undefined {
  const { entry, storePath } = params.loadFreshSessionEntry(params.agentId, params.sessionKey);
  const sessionId = entry?.sessionId?.trim();
  return sessionId ? { sessionId, storePath } : undefined;
}

async function mirrorTelegramAssistantReplyToTranscript(params: {
  cfg: OpenClawConfig;
  idempotencyKey: string;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
  route: TelegramMessageContext["route"];
  sessionKey: string;
  payload: TelegramTranscriptMirrorPayload;
}) {
  const text = resolveTelegramMirroredTranscriptText(params.payload);
  if (!text) {
    return;
  }
  const session = resolveTelegramScopedTranscriptSession({
    agentId: params.route.agentId,
    loadFreshSessionEntry: params.loadFreshSessionEntry,
    sessionKey: params.sessionKey,
  });
  if (!session) {
    return;
  }
  const appended = await appendAssistantMirrorMessageByIdentity({
    agentId: params.route.agentId,
    config: params.cfg,
    idempotencyKey: params.idempotencyKey,
    deliveryMirror: {
      kind: "channel-final",
      sourceMessageId: params.idempotencyKey,
    },
    sessionId: session.sessionId,
    sessionKey: params.sessionKey,
    storePath: session.storePath,
    text,
  });
  if (!appended.ok && appended.code !== "session-rebound") {
    logVerbose(`telegram transcript mirror append failed: ${appended.reason}`);
  }
}

const TELEGRAM_GENERAL_TOPIC_ID = 1;

function sanitizeProgressMarkdownText(text: string): string {
  return text.replaceAll("`", "'");
}

function formatProgressAsMarkdownCode(text: string): string {
  const clipped = clipTelegramProgressText(text);
  return `\`${sanitizeProgressMarkdownText(clipped)}\``;
}

function formatTelegramProgressLine(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("_") && trimmed.endsWith("_")
    ? trimmed
    : formatProgressAsMarkdownCode(text);
}

function buildTelegramThinkingProgressLine(progressTokens: number): ChannelProgressDraftLine {
  const label = `Thinking… (~${Math.round(progressTokens)} tokens)`;
  const text = `🧠 ${label}`;
  return {
    id: "reasoning:token-progress",
    kind: "item",
    icon: "🧠",
    label,
    text,
    prefix: false,
  };
}

function escapeTelegramProgressHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTelegramProgressStringLine(text: string): string {
  // Reasoning/commentary lanes carry model-authored markdown (e.g. `**bold**`,
  // inline `` `code` ``, `_italic_` reasoning behind a 🧠/💬 marker). Render it
  // through renderTelegramHtmlText — the parse_mode=HTML-safe converter — NOT
  // markdownToTelegramRichHtml, whose rich-only block output (<h2> from a
  // setext heading, <hr>, lists) makes Telegram reject the edit and drops the
  // whole preview to unformatted plain text. Callers convert ONE line at a
  // time, which also keeps block markdown from forming (`---` under a
  // paragraph is a setext heading only when they share a document).
  const trimmed = text.trim();
  // Clip INSIDE a whole-line `_…_` wrapper (the reasoning-lane contract, marker
  // optional): clipping the assembled line chops the closing underscore, which
  // silently degrades every long reasoning line from italic to plain text.
  const italic = trimmed.match(/^(\S+ )?_(.*)_$/u);
  const clipped = italic
    ? `${italic[1] ?? ""}_${clipTelegramProgressText(italic[2] ?? "")}_`
    : clipTelegramProgressText(trimmed);
  return renderTelegramHtmlText(clipped);
}

function renderTelegramProgressLine(line: ChannelProgressDraftCompositorLine): string {
  if (typeof line === "string") {
    return line.split(/\r?\n/u).map(renderTelegramProgressStringLine).filter(Boolean).join("<br>");
  }
  if (!line.icon && line.label === "Commentary") {
    // Commentary is model prose behind a 💬 marker: render its markdown (plain
    // unless the model emphasized) via the shared converter — distinct from the
    // 🧠 italic reasoning lane, mirroring Discord. Multi-line notes keep their
    // line structure (Discord parity); converting per line also prevents block
    // markdown (setext headings) from forming across lines.
    return line.text
      .split(/\r?\n/u)
      .map(renderTelegramProgressStringLine)
      .filter(Boolean)
      .join("<br>");
  }
  const label = [line.icon, line.label].filter(Boolean).join(" ");
  const parts = [`<b>${escapeTelegramProgressHtml(label)}</b>`];
  const detail = line.detail && line.detail !== line.label ? line.detail : undefined;
  if (detail) {
    parts.push(`<code>${escapeTelegramProgressHtml(clipTelegramProgressText(detail))}</code>`);
  } else {
    const text = line.text.trim();
    if (text && text !== label) {
      // Generic item payload (e.g. an "Update" line) keeps the monospace payload
      // styling shared with tool details; only the reasoning/commentary lanes
      // carry model markdown that needs converting.
      parts.push(`<code>${escapeTelegramProgressHtml(clipTelegramProgressText(text))}</code>`);
    }
  }
  if (line.status && line.status !== "completed" && line.status !== line.detail) {
    parts.push(`<i>${escapeTelegramProgressHtml(line.status)}</i>`);
  }
  return parts.join(" ");
}

function renderTelegramProgressDraftPreview(
  text: string,
  lines: readonly ChannelProgressDraftCompositorLine[],
  richMessages: boolean,
): TelegramDraftPreview {
  const trimmed = text.trimEnd();
  const renderedLines = lines.map(renderTelegramProgressLine).filter(Boolean);
  const textLines = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = textLines.length > renderedLines.length ? textLines[0] : undefined;
  const htmlParts = heading
    ? [`<b>${escapeTelegramProgressHtml(heading)}</b>`, ...renderedLines]
    : renderedLines;
  const html = htmlParts.join("<br>");
  if (!richMessages) {
    return { text: html, parseMode: "HTML" };
  }
  return {
    text: trimmed,
    richMessage: buildTelegramRichHtml(html, { skipEntityDetection: true }),
  };
}

function normalizeTelegramThreadId(value: unknown): number | undefined {
  return parseStrictPositiveInteger(value);
}

function resolveTelegramForumThreadScopeFromSessionKey(
  sessionKey: unknown,
): { chatId: string; threadId: number } | undefined {
  if (typeof sessionKey !== "string") {
    return undefined;
  }
  const match = /:telegram:group:(-?\d+):topic:(\d+)(?::|$)/.exec(sessionKey);
  const threadId = normalizeTelegramThreadId(match?.[2]);
  if (!match?.[1] || threadId == null) {
    return undefined;
  }
  return { chatId: match[1], threadId };
}

function resolveDispatchTelegramThreadSpec(params: {
  chatId: TelegramMessageContext["chatId"];
  ctxPayload: TelegramMessageContext["ctxPayload"];
  threadSpec: TelegramThreadSpec;
}): TelegramThreadSpec {
  if (
    params.threadSpec.scope !== "forum" ||
    (params.threadSpec.id != null && params.threadSpec.id !== TELEGRAM_GENERAL_TOPIC_ID)
  ) {
    return params.threadSpec;
  }
  const scopedThread = resolveTelegramForumThreadScopeFromSessionKey(params.ctxPayload.SessionKey);
  const scopedThreadId =
    scopedThread?.chatId === String(params.chatId) ? scopedThread.threadId : undefined;
  const payloadThreadId =
    normalizeTelegramThreadId(params.ctxPayload.MessageThreadId) ??
    normalizeTelegramThreadId(params.ctxPayload.TransportThreadId);
  // Missing forum IDs are normalized to General; topic-scoped turn facts are more specific.
  const recoveredThreadId = scopedThreadId ?? payloadThreadId;
  return recoveredThreadId == null || recoveredThreadId === params.threadSpec.id
    ? params.threadSpec
    : { ...params.threadSpec, id: recoveredThreadId };
}

function normalizeDispatchTelegramThreadPayload(params: {
  context: TelegramMessageContext;
  threadSpec: TelegramThreadSpec;
}): TelegramMessageContext {
  if (params.threadSpec.scope !== "forum" || params.threadSpec.id == null) {
    return params.context;
  }
  const messageThreadId = normalizeTelegramThreadId(params.context.ctxPayload.MessageThreadId);
  const transportThreadId = normalizeTelegramThreadId(params.context.ctxPayload.TransportThreadId);
  if (messageThreadId === params.threadSpec.id && transportThreadId === params.threadSpec.id) {
    return params.context;
  }
  return {
    ...params.context,
    ctxPayload: {
      ...params.context.ctxPayload,
      MessageThreadId: params.threadSpec.id,
      TransportThreadId: params.threadSpec.id,
    },
  };
}

function extractCurrentTelegramBody(body: string | undefined): string {
  if (!body) {
    return "";
  }
  const markerIndex = body.lastIndexOf(CURRENT_MESSAGE_MARKER);
  if (markerIndex === -1) {
    return body;
  }
  return body.slice(markerIndex + CURRENT_MESSAGE_MARKER.length).trimStart();
}

function buildRecoveredTelegramChatActionSender(params: {
  context: TelegramMessageContext;
  threadId?: number;
  action: "typing" | "record_voice";
}): () => Promise<void> {
  return async () => {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendChatAction",
        fn: () =>
          params.context.sendChatActionHandler.sendChatAction(
            params.context.chatId,
            params.action,
            buildTypingThreadParams(params.threadId),
          ),
      });
    } catch (err) {
      if (params.action !== "record_voice") {
        throw err;
      }
      logVerbose(
        `telegram record_voice cue failed for chat ${params.context.chatId}: ${String(err)}`,
      );
    }
  };
}

function migrateRecoveredTelegramGroupHistory(params: {
  context: TelegramMessageContext;
  recoveredHistoryKey?: string;
}) {
  const originalHistoryKey = params.context.historyKey;
  const recoveredHistoryKey = params.recoveredHistoryKey;
  if (
    !params.context.isGroup ||
    !originalHistoryKey ||
    !recoveredHistoryKey ||
    originalHistoryKey === recoveredHistoryKey ||
    params.context.historyLimit <= 0
  ) {
    return;
  }
  // Topic recovery mutates the raw in-memory buffer before any prompt is built;
  // prompt readers apply the ambient transcript watermark after recovery.
  const originalEntries = params.context.groupHistories.get(originalHistoryKey);
  if (!originalEntries?.length) {
    return;
  }
  const messageId = params.context.ctxPayload.MessageSid;
  const rawBody = params.context.ctxPayload.RawBody;
  const entryIndex = originalEntries.findLastIndex((entry) => {
    if (messageId && entry.messageId === messageId) {
      return true;
    }
    return !messageId && typeof rawBody === "string" && entry.body === rawBody;
  });
  if (entryIndex === -1) {
    return;
  }
  const [entry] = originalEntries.splice(entryIndex, 1);
  if (!entry) {
    return;
  }
  createChannelHistoryWindow({
    historyMap: params.context.groupHistories,
  }).record({
    historyKey: recoveredHistoryKey,
    limit: params.context.historyLimit,
    entry,
  });
}

function resolveDispatchTelegramContext(params: {
  context: TelegramMessageContext;
}): TelegramMessageContext {
  const threadSpec = resolveDispatchTelegramThreadSpec({
    chatId: params.context.chatId,
    ctxPayload: params.context.ctxPayload,
    threadSpec: params.context.threadSpec,
  });
  if (threadSpec === params.context.threadSpec || threadSpec.scope !== "forum") {
    return normalizeDispatchTelegramThreadPayload({ context: params.context, threadSpec });
  }
  const recoveredRoutingTarget = buildTelegramInboundOriginTarget(
    params.context.chatId,
    threadSpec,
  );
  const recoveredFrom = params.context.isGroup
    ? buildTelegramGroupFrom(params.context.chatId, threadSpec.id)
    : params.context.ctxPayload.From;
  const recoveredUpdateLastRoute =
    params.context.turn.record.updateLastRoute && threadSpec.id != null
      ? {
          ...params.context.turn.record.updateLastRoute,
          to: `telegram:${params.context.chatId}:topic:${threadSpec.id}`,
          threadId: String(threadSpec.id),
        }
      : params.context.turn.record.updateLastRoute;
  const recoveredHistoryKey = params.context.isGroup
    ? buildTelegramGroupPeerId(params.context.chatId, threadSpec.id)
    : params.context.historyKey;
  const recoveredHistoryEntries =
    recoveredHistoryKey && params.context.historyLimit > 0
      ? (params.context.groupHistories.get(recoveredHistoryKey) ?? [])
          .filter((entry) =>
            isTelegramHistoryEntryAfterAmbientWatermark(
              entry,
              params.context.ctxPayload.AmbientTranscriptPreviousMessageId
                ? {
                    messageId: params.context.ctxPayload.AmbientTranscriptPreviousMessageId,
                    ...(params.context.ctxPayload.AmbientTranscriptPreviousTimestampMs !== undefined
                      ? {
                          timestampMs:
                            params.context.ctxPayload.AmbientTranscriptPreviousTimestampMs,
                        }
                      : {}),
                  }
                : undefined,
            ),
          )
          .slice(-params.context.historyLimit)
      : [];
  const recoveredWatermarkedHistoryEntries = selectTelegramGroupHistoryAfterLastSelf(
    recoveredHistoryEntries,
  ).slice(-params.context.historyLimit);
  const recoveredPromptHistoryEntries =
    params.context.isGroup && recoveredHistoryKey && params.context.historyLimit > 0
      ? params.context.ctxPayload.InboundEventKind === "room_event"
        ? recoveredHistoryEntries
        : recoveredWatermarkedHistoryEntries
      : [];
  const recoveredInboundHistory =
    params.context.isGroup && recoveredHistoryKey && params.context.historyLimit > 0
      ? recoveredPromptHistoryEntries.length > 0
        ? recoveredPromptHistoryEntries
        : undefined
      : params.context.ctxPayload.InboundHistory;
  const recoveredBodyForAgent = extractCurrentTelegramBody(
    params.context.ctxPayload.BodyForAgent ?? params.context.ctxPayload.Body,
  );
  const recoveredPromptContextBase = retainTelegramGroupHistoryPromptContext({
    promptContext: params.context.ctxPayload.UntrustedStructuredContext ?? [],
    entries: recoveredPromptHistoryEntries,
  });
  const recoveredPromptContext =
    recoveredPromptHistoryEntries.length > 0
      ? mergeTelegramGroupHistoryPromptContext({
          promptContext: recoveredPromptContextBase ?? [],
          entries: recoveredPromptHistoryEntries,
        })
      : recoveredPromptContextBase?.length
        ? recoveredPromptContextBase
        : undefined;
  const recoveredSendTyping = buildRecoveredTelegramChatActionSender({
    context: params.context,
    threadId: threadSpec.id,
    action: "typing",
  });
  const recoveredSendRecordVoice = buildRecoveredTelegramChatActionSender({
    context: params.context,
    threadId: threadSpec.id,
    action: "record_voice",
  });
  migrateRecoveredTelegramGroupHistory({
    context: params.context,
    recoveredHistoryKey,
  });
  return {
    ...params.context,
    historyKey: recoveredHistoryKey,
    threadSpec,
    resolvedThreadId: threadSpec.id,
    replyThreadId: threadSpec.id,
    sendTyping: recoveredSendTyping,
    sendRecordVoice: recoveredSendRecordVoice,
    turn: {
      ...params.context.turn,
      record: {
        ...params.context.turn.record,
        updateLastRoute: recoveredUpdateLastRoute,
      },
    },
    ctxPayload:
      threadSpec.id == null
        ? params.context.ctxPayload
        : {
            ...params.context.ctxPayload,
            Body: recoveredBodyForAgent,
            BodyForAgent: recoveredBodyForAgent,
            From: recoveredFrom,
            InboundHistory: recoveredInboundHistory,
            MessageThreadId: threadSpec.id,
            OriginatingTo: recoveredRoutingTarget,
            To: recoveredRoutingTarget,
            TransportThreadId: threadSpec.id,
            UntrustedStructuredContext: recoveredPromptContext,
          },
  };
}

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  telegramDeps: injectedTelegramDeps,
  opts,
  retryDispatchErrors = false,
  suppressFailureFallback = false,
  onTurnAdopted,
  onTurnDeferred,
  onTurnAbandoned,
  turnAbortSignal,
}: DispatchTelegramMessageParams): Promise<TelegramDispatchResult> => {
  const dispatchStartedAt = Date.now();
  const dispatchContext = resolveDispatchTelegramContext({ context });
  const telegramDeps =
    injectedTelegramDeps ?? (await import("./bot-deps.js")).defaultTelegramBotDeps;
  const loadFreshSessionEntry = createFreshTelegramSessionEntryLoader({ cfg, telegramDeps });
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    groupConfig,
    topicConfig,
    threadSpec,
    historyKey,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController: rawStatusReactionController,
  } = dispatchContext;
  const isRoomEvent = ctxPayload.InboundEventKind === "room_event";
  const statusReactionController = isRoomEvent ? null : rawStatusReactionController;
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...cfg.messages?.statusReactions?.timing,
  };
  const clearTelegramStatusReaction = async () => {
    if (!msg.message_id || !reactionApi) {
      return;
    }
    await reactionApi(chatId, msg.message_id, []);
  };
  const finalizeTelegramStatusReaction = async (params: {
    outcome: "done" | "error";
    hasFinalResponse: boolean;
  }) => {
    if (!statusReactionController) {
      return;
    }
    if (params.outcome === "done") {
      await statusReactionController.setDone();
      if (removeAckAfterReply) {
        await sleepWithAbort(statusReactionTiming.doneHoldMs);
        await clearTelegramStatusReaction();
      } else {
        await statusReactionController.restoreInitial();
      }
      return;
    }
    await statusReactionController.setError();
    if (params.hasFinalResponse) {
      if (removeAckAfterReply) {
        await sleepWithAbort(statusReactionTiming.errorHoldMs);
        await clearTelegramStatusReaction();
      } else {
        await statusReactionController.restoreInitial();
      }
      return;
    }
    if (removeAckAfterReply) {
      await sleepWithAbort(statusReactionTiming.errorHoldMs);
    }
    await statusReactionController.restoreInitial();
  };
  const replyFenceKey = resolveTelegramReplyFenceKey({
    ctxPayload,
    chatId,
    threadSpec,
  });
  const replyFenceLaneKey = getTelegramSequentialKey({
    message: msg,
    ...(context.primaryCtx.me ? { me: context.primaryCtx.me } : {}),
  });
  const scopedReplyFenceLaneKey = buildTelegramReplyFenceLaneKey({
    accountId: route.accountId,
    sequentialKey: replyFenceLaneKey,
  });
  let activeReplyFenceKey = replyFenceKey.activeKey;
  let replyFenceGeneration: number | undefined;
  const replyAbortController = new AbortController();
  const replyAbortSignal = turnAbortSignal
    ? AbortSignal.any([replyAbortController.signal, turnAbortSignal])
    : replyAbortController.signal;
  let replyAbortControllerQueued = false;
  let queuedTurnAdmitted = false;
  let dispatchWasSuperseded;
  // Queued source dispatches release their generation before admission but retain this controller.
  // Its aborted bit preserves supersession across the later async adoption handoff.
  const isDispatchSuperseded = () =>
    replyAbortController.signal.aborted ||
    (replyFenceGeneration !== undefined &&
      isTelegramReplyFenceSuperseded({
        key: activeReplyFenceKey,
        generation: replyFenceGeneration,
      }));
  const releaseReplyFence = () => {
    if (replyFenceGeneration === undefined) {
      return;
    }
    endTelegramReplyFence(
      activeReplyFenceKey,
      replyAbortControllerQueued ? undefined : replyAbortController,
    );
    replyFenceGeneration = undefined;
  };
  const adoptReplyTurn = async () => {
    await onTurnAdopted?.();
    // Fence abort and supersession authority end after durable adoption.
    // Core then owns all interruption of the adopted run.
    releaseReplyFence();
    releaseTelegramReplyFenceAbortController(activeReplyFenceKey, replyAbortController);
  };
  // Block mode sizes preview rotation steps from streaming.preview.chunk (same
  // contract as Discord's block chunker). Other modes keep one growing rich
  // preview. The stream has no min-flush concept, so minChars/breakPreference
  // do not apply here.
  const draftMaxChars =
    streamMode === "block"
      ? Math.min(resolveTelegramDraftStreamingChunking(cfg, route.accountId).maxChars, textLimit)
      : Math.min(
          textLimit,
          telegramCfg.richMessages === true ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_TEXT_CHUNK_LIMIT,
        );
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
    supportsBlockTables: telegramCfg.richMessages === true,
  });
  const renderStreamText = (text: string): TelegramDraftPreview =>
    telegramCfg.richMessages === true
      ? {
          text,
          richMessage: buildTelegramRichMarkdown(text, {
            tableMode,
            skipEntityDetection: telegramCfg.linkPreview === false,
          }),
        }
      : {
          text: renderTelegramHtmlText(text, { tableMode }),
          parseMode: "HTML",
        };
  const accountBlockStreamingEnabled =
    resolveChannelStreamingBlockEnabled(telegramCfg) ??
    cfg.agents?.defaults?.blockStreamingDefault === "on";
  const resolvedReasoningLevel = resolveTelegramReasoningLevel({
    cfg,
    sessionKey: ctxPayload.SessionKey,
    agentId: route.agentId,
    loadFreshSessionEntry,
  });
  // Progress mode's ephemeral working-lane window IS the streaming mechanism and
  // is independent of reasoning persistence (Discord keeps its window alive
  // regardless of /reasoning). Only non-progress modes upgrade reasoning-on to
  // block streaming. Forcing block streaming in progress mode killed the whole
  // window (no commentary/tool lanes, no collapse bar) and suppressed all
  // streamed output for message_tool_only providers.
  const forceBlockStreamingForReasoning =
    resolvedReasoningLevel === "on" && streamMode !== "progress";
  const streamReasoningDraft = resolvedReasoningLevel === "stream";
  const streamDeliveryEnabled = !isRoomEvent && streamMode !== "off";
  const rawReplyQuoteText =
    ctxPayload.ReplyToIsQuote && typeof ctxPayload.ReplyToQuoteText === "string"
      ? ctxPayload.ReplyToQuoteText
      : undefined;
  const replyQuoteText = ctxPayload.ReplyToIsQuote
    ? rawReplyQuoteText?.trim()
      ? rawReplyQuoteText
      : ctxPayload.ReplyToBody?.trim() || undefined
    : undefined;
  const replyQuoteMessageId =
    replyQuoteText && !ctxPayload.ReplyToIsExternal
      ? resolveTelegramReplyId(ctxPayload.ReplyToId)
      : undefined;
  const replyQuoteTargetsBotMessage = msg.reply_to_message?.from?.is_bot === true;
  const replyQuoteByMessageId: TelegramNativeQuoteCandidateByMessageId = {};
  if (replyToMode !== "off") {
    if (replyQuoteText && replyQuoteMessageId != null) {
      addTelegramNativeQuoteCandidate(replyQuoteByMessageId, replyQuoteMessageId, {
        text: replyQuoteText,
        ...(typeof ctxPayload.ReplyToQuotePosition === "number"
          ? { position: ctxPayload.ReplyToQuotePosition }
          : {}),
        ...(Array.isArray(ctxPayload.ReplyToQuoteEntities)
          ? { entities: ctxPayload.ReplyToQuoteEntities }
          : {}),
      });
    }

    addTelegramNativeQuoteCandidate(
      replyQuoteByMessageId,
      ctxPayload.MessageSid ?? msg.message_id,
      buildTelegramNativeQuoteCandidate(getTelegramTextParts(msg)),
    );

    if (!ctxPayload.ReplyToIsExternal && typeof ctxPayload.ReplyToQuoteSourceText === "string") {
      addTelegramNativeQuoteCandidate(
        replyQuoteByMessageId,
        ctxPayload.ReplyToId,
        buildTelegramNativeQuoteCandidate({
          text: ctxPayload.ReplyToQuoteSourceText,
          entities: Array.isArray(ctxPayload.ReplyToQuoteSourceEntities)
            ? ctxPayload.ReplyToQuoteSourceEntities
            : undefined,
        }),
      );
    }
  }
  const hasTelegramQuoteReply = replyToMode !== "off" && replyQuoteText != null;
  const canStreamAnswerDraft =
    streamDeliveryEnabled &&
    !hasTelegramQuoteReply &&
    !accountBlockStreamingEnabled &&
    !forceBlockStreamingForReasoning;
  const streamReasoningInProgressDraft =
    streamReasoningDraft && streamMode === "progress" && canStreamAnswerDraft;
  const canStreamReasoningDraft =
    !isRoomEvent && streamReasoningDraft && !streamReasoningInProgressDraft;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number"
      ? replyQuoteTargetsBotMessage
        ? msg.message_id
        : (replyQuoteMessageId ?? msg.message_id)
      : undefined;
  const draftMinInitialChars = streamMode === "progress" ? 0 : DRAFT_MIN_INITIAL_CHARS;
  const progressSeed = `${route.accountId}:${chatId}:${threadSpec.id ?? ""}`;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const createDraftLane = (laneName: LaneName, enabled: boolean): DraftLaneState => {
    const stream = enabled
      ? (telegramDeps.createTelegramDraftStream ?? createTelegramDraftStream)({
          api: bot.api,
          chatId,
          maxChars: draftMaxChars,
          thread: threadSpec,
          replyToMessageId: draftReplyToMessageId,
          richMessages: telegramCfg.richMessages,
          minInitialChars: draftMinInitialChars,
          renderText: renderStreamText,
          onSupersededPreview: (superseded) => {
            if (superseded.retain) {
              lanes[laneName].activeChunkIndex += 1;
              return;
            }
            void bot.api.deleteMessage(chatId, superseded.messageId).catch((err: unknown) => {
              logVerbose(
                `telegram: superseded ${laneName} stream cleanup failed (${superseded.messageId}): ${String(err)}`,
              );
            });
          },
          log: logVerbose,
          warn: logVerbose,
        })
      : undefined;
    return {
      stream,
      lastPartialText: "",
      hasStreamedMessage: false,
      finalized: false,
      activeChunkIndex: 0,
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane("answer", canStreamAnswerDraft),
    reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  const durableReasoningPayloadsEnabled =
    resolvedReasoningLevel === "on" || Boolean(reasoningLane.stream);
  const streamToolProgressEnabled = resolveChannelStreamingPreviewToolProgress(telegramCfg);
  let lastAnswerPartialText = "";
  let activeAnswerDraftIsToolProgressOnly = false;
  let activeAnswerBlockAssistantMessageIndex: number | undefined;
  let lastAnswerBlockPayload: ReplyPayload | undefined;
  let lastAnswerBlockText: string | undefined;
  let lastAnswerBlockButtons: TelegramInlineButtons | undefined;
  let materializeAnswerLaneBeforeRotation: (() => Promise<boolean>) | undefined;
  type QueuedAnswerBlockRotation = {
    assistantMessageIndex?: number;
    text?: string;
    shouldRotateBeforeDelivery: boolean;
  };
  const queuedAnswerBlockRotations: QueuedAnswerBlockRotation[] = [];
  let queuedAnswerBlockAssistantMessageIndex: number | undefined;
  let pendingAnswerBlockAssistantMessageIndex: number | undefined;
  let rotateAnswerLaneWhenQueuedBlocksSettle = false;
  function resetAnswerToolProgressDraft() {
    activeAnswerDraftIsToolProgressOnly = false;
  }
  async function prepareAnswerLaneForToolProgress() {
    if (answerLane.finalized) {
      answerLane.stream?.forceNewMessage();
      resetDraftLaneState(answerLane);
    }
    if (activeAnswerDraftIsToolProgressOnly) {
      return;
    }
    // Progress mode keeps ONE stationary window: interim answer text never
    // streams into it (updateDraftFromPartial returns early), so hasStreamedMessage
    // is only ever set by tool progress on this same message — never rotate here.
    // The rotate exists for block/partial, where answer text streams first and a
    // following tool run needs its own message.
    if (streamMode !== "progress" && answerLane.hasStreamedMessage) {
      await rotateAnswerLaneForNewMessage();
    }
    activeAnswerDraftIsToolProgressOnly = true;
  }
  // Tracks whether the ephemeral progress window ever actually rendered this
  // turn (rv mode delivers everything durably and the window stays empty). The
  // collapse summary must reflect what ACTUALLY streamed, so it is gated on
  // this flag, not on the compositor gate having started (Bug 6).
  let progressDraftEverRendered = false;
  // Turn-activity tally for the post-turn collapse summary (Discord parity).
  // Counters feed a one-line digest posted when the progress window collapses.
  const progressSummaryStartedAt = Date.now();
  const progressSummary = createTelegramProgressSummaryTracker();
  let progressSummaryDelivered = false;
  const progressDraft = createChannelProgressDraftCompositor({
    entry: telegramCfg,
    mode: streamMode,
    active: Boolean(answerLane.stream),
    seed: progressSeed,
    formatLine: formatTelegramProgressLine,
    reasoningGate: streamReasoningInProgressDraft,
    // Distinguish the streamed lanes in the window the way Discord does: 🧠
    // reasoning (italic, default) vs 💬 commentary (plain). Without these the
    // two lanes render identically and are indistinguishable.
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    commentaryItalics: false,
    update: async (streamText, options) => {
      progressDraftEverRendered = true;
      await prepareAnswerLaneForToolProgress();
      answerLane.lastPartialText = streamText;
      answerLane.hasStreamedMessage = true;
      answerLane.finalized = false;
      answerLane.stream?.updatePreview(
        renderTelegramProgressDraftPreview(
          streamText,
          options?.lines ?? [],
          telegramCfg.richMessages === true,
        ),
      );
      if (options?.flush) {
        await answerLane.stream?.flush();
      }
    },
  });
  let finalAnswerDeliveryStarted = false;
  let finalAnswerDelivered = false;
  // While the durable verbose lane is active it owns EVERY progress surface
  // (commentary, tool, plan, command output, patch summaries), posting each as
  // its own persistent message. The ephemeral window must therefore render none
  // of them, or each renders twice (invariant: persistent message XOR window).
  let verboseProgressActive: () => boolean = () => false;
  const canPushStreamToolProgress = () =>
    Boolean(
      answerLane.stream &&
      !verboseProgressActive() &&
      !answerLane.finalized &&
      !finalAnswerDeliveryStarted &&
      !finalAnswerDelivered,
    );
  const pushStreamToolProgress = async (
    line?: string | ChannelProgressDraftLine,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => {
    if (!canPushStreamToolProgress()) {
      return false;
    }
    return await progressDraft.pushToolProgress(line, options);
  };
  const pushStreamReasoningProgress = async (payload: {
    text?: string;
    isReasoningSnapshot?: boolean;
  }) => {
    // Opens (or keeps open) the current window reasoning burst for the collapse
    // summary whenever window-destined reasoning text arrives — independent of
    // whether this particular push renders, so a short burst between renders is
    // still counted at the summary flush (mirrors Discord's windowReasoningOpen).
    // Gated on the window lane: durable reasoning (/reasoning on) must not feed
    // the bar (Bug 6: the bar counts only what streamed to the window).
    if (streamReasoningInProgressDraft && payload.text) {
      progressSummary.noteReasoningActivity();
    }
    return await progressDraft.pushReasoningProgress(payload.text, {
      snapshot: payload.isReasoningSnapshot === true,
    });
  };
  const pushStreamThinkingTokenProgress = async (progressTokens: number) => {
    const rendered = await pushStreamToolProgress(
      buildTelegramThinkingProgressLine(progressTokens),
      { startImmediately: true },
    );
    if (rendered) {
      progressSummary.noteReasoningActivity();
    }
    return rendered;
  };
  const markProgressFinalStarted = () => {
    finalAnswerDeliveryStarted = true;
    progressDraft.markFinalReplyStarted();
  };
  const markProgressFinalDelivered = () => {
    finalAnswerDelivered = true;
    sawProgressFinal = true;
    progressDraft.markFinalReplyDelivered();
  };
  const resetProgressDraftState = () => {
    progressDraft.reset();
  };
  const suppressProgressDraftState = () => {
    progressDraft.suppress();
  };
  let splitReasoningOnNextStream = false;
  let draftLaneEventQueue = Promise.resolve();
  const reasoningStepState = createTelegramReasoningStepState();
  const enqueueDraftLaneEvent = (task: () => Promise<void>): Promise<void> => {
    const next = draftLaneEventQueue.then(async () => {
      if (isDispatchSuperseded()) {
        return;
      }
      await task();
    });
    draftLaneEventQueue = next.catch((err: unknown) => {
      logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
    });
    return draftLaneEventQueue;
  };
  type SplitLaneSegment = { lane: LaneName; update: DraftPartialTextUpdate };
  type SplitLaneSegmentsResult = {
    segments: SplitLaneSegment[];
    suppressedReasoningOnly: boolean;
  };
  const splitTextIntoLaneSegments = (
    update: { text?: string; delta?: string; replace?: true; isReasoningSnapshot?: boolean },
    isReasoning?: boolean,
  ): SplitLaneSegmentsResult => {
    const split = splitTelegramReasoningText(update.text, isReasoning);
    const splitSegments: Array<{ lane: LaneName; text: string }> = [];
    const useDelta =
      !update.replace && update.isReasoningSnapshot !== true && update.delta !== undefined;
    const segments: SplitLaneSegment[] = [];
    const suppressReasoning = resolvedReasoningLevel === "off";
    if (split.reasoningText && !suppressReasoning) {
      splitSegments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      splitSegments.push({ lane: "answer", text: split.answerText });
    }
    for (const segment of splitSegments) {
      const canApplyDelta = useDelta && splitSegments.length === 1;
      segments.push({
        lane: segment.lane,
        update: {
          text: segment.text,
          ...(canApplyDelta ? { delta: update.delta } : {}),
          ...(update.replace ? { replace: true } : {}),
          ...(update.isReasoningSnapshot ? { isReasoningSnapshot: true } : {}),
        },
      });
    }
    return {
      segments,
      suppressedReasoningOnly:
        Boolean(split.reasoningText) && suppressReasoning && !split.answerText,
    };
  };
  const resetDraftLaneState = (lane: DraftLaneState) => {
    lane.lastPartialText = "";
    if (lane === answerLane) {
      lastAnswerPartialText = "";
    }
    lane.hasStreamedMessage = false;
    lane.finalized = false;
    lane.activeChunkIndex = 0;
    if (lane === answerLane) {
      resetAnswerToolProgressDraft();
      pendingAnswerBlockAssistantMessageIndex = undefined;
      lastAnswerBlockPayload = undefined;
      lastAnswerBlockText = undefined;
      lastAnswerBlockButtons = undefined;
    }
  };
  const rotateLaneForNewMessage = async (lane: DraftLaneState) => {
    if (!lane.hasStreamedMessage && typeof lane.stream?.messageId() !== "number") {
      resetDraftLaneState(lane);
      return;
    }
    await lane.stream?.stop();
    lane.stream?.forceNewMessage();
    resetDraftLaneState(lane);
  };
  const rotateAnswerLaneForNewMessage = async () => {
    if (materializeAnswerLaneBeforeRotation) {
      await materializeAnswerLaneBeforeRotation();
    }
    await rotateLaneForNewMessage(answerLane);
  };
  const rotateAnswerLaneAfterToolProgress = async () => {
    if (!activeAnswerDraftIsToolProgressOnly) {
      return false;
    }
    // Reposition, don't delete-then-repost: rewind so the replacement message
    // sends below, and defer the tool-progress window's delete until after it
    // lands. Deleting first (clear) scroll-jumps the client when a durable 🧠
    // was posted between the window and the replacement (the on-off jump).
    if (answerLane.stream?.rotateToNewMessageDeferringDelete) {
      answerLane.stream.rotateToNewMessageDeferringDelete();
    } else {
      answerLane.stream?.forceNewMessage();
    }
    resetDraftLaneState(answerLane);
    suppressProgressDraftState();
    rotateAnswerLaneWhenQueuedBlocksSettle = false;
    return true;
  };
  const rotateAnswerLaneAfterQueuedBlocksSettle = async () => {
    if (!rotateAnswerLaneWhenQueuedBlocksSettle || queuedAnswerBlockRotations.length > 0) {
      return false;
    }
    rotateAnswerLaneWhenQueuedBlocksSettle = false;
    if (!answerLane.hasStreamedMessage || activeAnswerDraftIsToolProgressOnly) {
      return false;
    }
    await rotateAnswerLaneForNewMessage();
    return true;
  };
  const prepareAnswerLaneForText = async (): Promise<boolean> => {
    // Single stationary window in progress mode: interim answer text never
    // renders into the window (updateDraftFromPartial returns early for the
    // answer lane), so it must NOT rotate/reposition the tool-progress window
    // either. The one window message stays put through every lane handover and
    // is edited into the summary bar at collapse (deliverProgressModeFinalAnswer);
    // rotating here spawned a fresh bubble per interim answer chunk (churn).
    if (streamMode === "progress") {
      return false;
    }
    if (await rotateAnswerLaneAfterToolProgress()) {
      return true;
    }
    if (await rotateAnswerLaneAfterQueuedBlocksSettle()) {
      return true;
    }
    if (!answerLane.finalized) {
      return false;
    }
    answerLane.stream?.forceNewMessage();
    resetDraftLaneState(answerLane);
    rotateAnswerLaneWhenQueuedBlocksSettle = false;
    return true;
  };
  const prepareQueuedAnswerBlock = async (
    payload: ReplyPayload,
    blockContext?: BlockReplyContext,
  ) => {
    const hasAnswerText = splitTextIntoLaneSegments(
      { text: payload.text },
      payload.isReasoning,
    ).segments.some((segment) => segment.lane === "answer");
    if (!hasAnswerText) {
      return;
    }
    resetProgressDraftState();
    const assistantMessageIndex = blockContext?.assistantMessageIndex;
    if (assistantMessageIndex === undefined) {
      queuedAnswerBlockRotations.push({
        text: payload.text,
        shouldRotateBeforeDelivery: false,
      });
      return;
    }
    const previousAssistantMessageIndex =
      queuedAnswerBlockAssistantMessageIndex ??
      activeAnswerBlockAssistantMessageIndex ??
      pendingAnswerBlockAssistantMessageIndex;
    const shouldRotateBeforeDelivery =
      previousAssistantMessageIndex !== undefined &&
      assistantMessageIndex !== previousAssistantMessageIndex;
    queuedAnswerBlockRotations.push({
      assistantMessageIndex,
      text: payload.text,
      shouldRotateBeforeDelivery,
    });
    queuedAnswerBlockAssistantMessageIndex = assistantMessageIndex;
  };
  const recomputeQueuedAnswerBlockRotations = () => {
    let previousAssistantMessageIndex =
      activeAnswerBlockAssistantMessageIndex ?? pendingAnswerBlockAssistantMessageIndex;
    queuedAnswerBlockAssistantMessageIndex = undefined;
    for (const entry of queuedAnswerBlockRotations) {
      if (entry.assistantMessageIndex === undefined) {
        continue;
      }
      entry.shouldRotateBeforeDelivery =
        previousAssistantMessageIndex !== undefined &&
        entry.assistantMessageIndex !== previousAssistantMessageIndex;
      previousAssistantMessageIndex = entry.assistantMessageIndex;
      queuedAnswerBlockAssistantMessageIndex = entry.assistantMessageIndex;
    }
  };
  const queuedAnswerBlockRotationTextMatchesPayload = (
    entry: QueuedAnswerBlockRotation,
    payload: ReplyPayload,
  ) => {
    return entry.text !== undefined && payload.text !== undefined && entry.text === payload.text;
  };
  const queuedAnswerBlockRotationMatchesDelivery = (
    entry: QueuedAnswerBlockRotation,
    payload: ReplyPayload,
    assistantMessageIndex?: number,
  ) => {
    if (assistantMessageIndex !== undefined && entry.assistantMessageIndex !== undefined) {
      return assistantMessageIndex === entry.assistantMessageIndex;
    }
    return queuedAnswerBlockRotationTextMatchesPayload(entry, payload);
  };
  const takeQueuedAnswerBlockRotation = (
    payload: ReplyPayload,
    assistantMessageIndex?: number,
  ): boolean => {
    if (queuedAnswerBlockRotations.length === 0) {
      return false;
    }
    const matchIndex = queuedAnswerBlockRotations.findIndex((entry) =>
      queuedAnswerBlockRotationMatchesDelivery(entry, payload, assistantMessageIndex),
    );
    const consumeIndex = Math.max(matchIndex, 0);
    const matchedEntries = queuedAnswerBlockRotations.splice(0, consumeIndex + 1);
    const matchedEntry = matchedEntries.at(-1);
    const shouldRotateBeforeDelivery = matchedEntry?.shouldRotateBeforeDelivery ?? false;
    if (matchedEntry?.assistantMessageIndex !== undefined) {
      activeAnswerBlockAssistantMessageIndex = matchedEntry.assistantMessageIndex;
      pendingAnswerBlockAssistantMessageIndex = undefined;
    }
    recomputeQueuedAnswerBlockRotations();
    return shouldRotateBeforeDelivery;
  };
  const dropQueuedAnswerBlockRotation = (payload: ReplyPayload, assistantMessageIndex?: number) => {
    let matchIndex = queuedAnswerBlockRotations.findIndex((entry) =>
      queuedAnswerBlockRotationMatchesDelivery(entry, payload, assistantMessageIndex),
    );
    if (matchIndex < 0 && assistantMessageIndex === undefined) {
      matchIndex = queuedAnswerBlockRotations.findIndex(
        (entry) => entry.assistantMessageIndex === undefined,
      );
    }
    if (matchIndex >= 0) {
      const matchedEntry = queuedAnswerBlockRotations[matchIndex];
      queuedAnswerBlockRotations.splice(matchIndex, 1);
      if (
        matchIndex === 0 &&
        matchedEntry?.assistantMessageIndex !== undefined &&
        rotateAnswerLaneWhenQueuedBlocksSettle &&
        activeAnswerBlockAssistantMessageIndex === undefined &&
        answerLane.hasStreamedMessage
      ) {
        pendingAnswerBlockAssistantMessageIndex = matchedEntry.assistantMessageIndex;
      }
      recomputeQueuedAnswerBlockRotations();
    }
  };
  const updateDraftFromPartial = (lane: DraftLaneState, update: DraftPartialTextUpdate) => {
    const laneStream = lane.stream;
    if (!laneStream || !update.text) {
      return;
    }
    const previousText = lane === answerLane ? lastAnswerPartialText : lane.lastPartialText;
    const nextText = resolveDraftPartialText(previousText, update);
    if (!nextText) {
      return;
    }
    if (lane === answerLane) {
      if (streamMode === "progress") {
        return;
      }
      resetAnswerToolProgressDraft();
      suppressProgressDraftState();
    }
    lane.hasStreamedMessage = true;
    lane.finalized = false;
    if (lane === answerLane) {
      lastAnswerPartialText = nextText;
    }
    lane.lastPartialText = nextText;
    laneStream.update(nextText);
  };
  const ingestDraftLaneSegments = async (
    update: { text?: string; delta?: string; replace?: true; isReasoningSnapshot?: boolean },
    isReasoning?: boolean,
  ) => {
    const split = splitTextIntoLaneSegments(update, isReasoning);
    for (const segment of split.segments) {
      if (segment.lane === "answer") {
        await prepareAnswerLaneForText();
      }
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
        reasoningStepState.noteReasoningDelivered();
      }
      updateDraftFromPartial(lanes[segment.lane], segment.update);
    }
  };
  const flushDraftLane = async (lane: DraftLaneState) => {
    if (!lane.stream) {
      return;
    }
    await lane.stream.flush();
  };

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
  const disableBlockStreaming = !streamDeliveryEnabled
    ? true
    : forceBlockStreamingForReasoning
      ? false
      : typeof resolvedBlockStreamingEnabled === "boolean"
        ? !resolvedBlockStreamingEnabled
        : canStreamAnswerDraft
          ? true
          : undefined;

  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  const supersedeReplyFence = shouldSupersedeTelegramReplyFence(ctxPayload);
  activeReplyFenceKey = supersedeReplyFence
    ? replyFenceKey.activeKey
    : buildTelegramNonInterruptingReplyFenceKey({
        activeKey: replyFenceKey.activeKey,
        laneKey: scopedReplyFenceLaneKey,
      });
  // Ambient room-event work uses a separate fence key. Any non-room-event
  // inbound may cancel it without owning abort authority over adopted user turns.
  if (!isRoomEvent) {
    supersedeTelegramReplyFence(replyFenceKey.roomEventKey);
  }
  replyFenceGeneration = beginTelegramReplyFence({
    key: activeReplyFenceKey,
    supersede: supersedeReplyFence,
    abortController: replyAbortController,
    laneKey: scopedReplyFenceLaneKey,
  });

  const implicitQuoteReplyTargetId =
    !replyQuoteTargetsBotMessage && replyQuoteMessageId != null
      ? String(replyQuoteMessageId)
      : undefined;
  const currentMessageIdForQuoteReply =
    implicitQuoteReplyTargetId && ctxPayload.MessageSid ? ctxPayload.MessageSid : undefined;
  const replyQuotePosition =
    typeof ctxPayload.ReplyToQuotePosition === "number"
      ? ctxPayload.ReplyToQuotePosition
      : undefined;
  const replyQuoteEntities = Array.isArray(ctxPayload.ReplyToQuoteEntities)
    ? ctxPayload.ReplyToQuoteEntities
    : undefined;
  const deliveryState = createLaneDeliveryStateTracker();
  const beginDeliveryCorrelation = () =>
    beginTelegramInboundEventDeliveryCorrelation(
      ctxPayload.SessionKey,
      {
        outboundTo: historyKey || String(chatId),
        outboundAccountId: route.accountId,
        markInboundEventDelivered: () => {
          deliveryState.markDelivered();
        },
      },
      { inboundEventKind: ctxPayload.InboundEventKind },
    );
  const endTelegramInboundEventDeliveryCorrelation = beginDeliveryCorrelation();
  const sessionKey = ctxPayload.SessionKey;
  let transcriptMirrorSequence = 0;
  const transcriptMirrorTurnId = `${chatId}:${ctxPayload.MessageSid ?? msg.message_id ?? dispatchStartedAt}`;
  let currentTurnTranscriptFinal: CurrentTurnTranscriptFinal | undefined;
  const resolveCurrentTurnTranscriptFinal = async (): Promise<
    CurrentTurnTranscriptFinal | undefined
  > => {
    if (!sessionKey) {
      return undefined;
    }
    if (currentTurnTranscriptFinal) {
      return currentTurnTranscriptFinal;
    }
    try {
      const { entry: sessionEntry, storePath } = loadFreshSessionEntry(route.agentId, sessionKey);
      if (!sessionEntry?.sessionId) {
        return undefined;
      }
      const latest = await readLatestAssistantTextByIdentity({
        agentId: route.agentId,
        sessionId: sessionEntry.sessionId,
        sessionKey,
        storePath,
      });
      if (!latest?.timestamp || latest.timestamp < dispatchStartedAt) {
        return undefined;
      }
      currentTurnTranscriptFinal = {
        text: latest.text,
        timestamp: latest.timestamp,
      };
      return currentTurnTranscriptFinal;
    } catch (err) {
      logVerbose(`telegram transcript final candidate lookup failed: ${formatErrorMessage(err)}`);
      return undefined;
    }
  };
  const resolveCurrentTurnTranscriptFinalText = async (): Promise<string | undefined> =>
    (await resolveCurrentTurnTranscriptFinal())?.text;
  const normalizePromptContextTimestampText = (text: string): string =>
    stripInlineDirectiveTagsForDelivery(text).text.trim();
  const resolvePromptContextTimestampMs = async (text: string): Promise<number | undefined> => {
    const final = await resolveCurrentTurnTranscriptFinal();
    if (
      !final ||
      normalizePromptContextTimestampText(final.text) !== normalizePromptContextTimestampText(text)
    ) {
      return undefined;
    }
    return final.timestamp;
  };
  const deliveryBaseOptions = {
    chatId: String(chatId),
    accountId: route.accountId,
    sessionKeyForInternalHooks: ctxPayload.SessionKey,
    mirrorIsGroup: isGroup,
    mirrorGroupId: isGroup ? String(chatId) : undefined,
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots,
    mediaMaxBytes: (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024,
    replyToMode,
    textLimit,
    thread: threadSpec,
    tableMode,
    chunkMode,
    richMessages: telegramCfg.richMessages,
    linkPreview: telegramCfg.linkPreview,
    replyQuoteMessageId,
    replyQuoteText,
    replyQuotePosition,
    replyQuoteEntities,
    replyQuoteByMessageId,
    transcriptMirror: sessionKey
      ? async (payload: TelegramTranscriptMirrorPayload) => {
          const idempotencyKey = `telegram-final:${sessionKey}:${transcriptMirrorTurnId}:${transcriptMirrorSequence++}`;
          await mirrorTelegramAssistantReplyToTranscript({
            cfg,
            idempotencyKey,
            loadFreshSessionEntry,
            route,
            sessionKey,
            payload,
          });
        }
      : undefined,
  };
  const silentErrorReplies = telegramCfg.silentErrorReplies === true;
  const isDmTopic = !isGroup && threadSpec.scope === "dm" && threadSpec.id != null;
  let queuedFinal = false;
  // A final answer was produced this turn (in-band or out-of-band). Out-of-band
  // finals (message_tool_only / codex) never flow through
  // deliverProgressModeFinalAnswer, so the collapse bar must be posted from the
  // cleanup fallback instead — see the finally block.
  let sawProgressFinal = false;
  let skippedDuplicateAnswerBlockDraftDelivery = false;
  let suppressSilentReplyFallback = false;
  let hadErrorReplyFailureOrSkip = false;
  let isFirstTurnInSession = false;
  let dispatchError: unknown;

  try {
    const sticker = ctxPayload.Sticker;
    if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
      const agentDir = resolveAgentDir(cfg, route.agentId);
      const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
      let description = sticker.cachedDescription ?? null;
      if (!description) {
        description = await describeStickerImage({
          imagePath: ctxPayload.MediaPath,
          cfg,
          agentDir,
          agentId: route.agentId,
        });
      }
      if (description) {
        const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
          .filter(Boolean)
          .join(" ");
        const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

        sticker.cachedDescription = description;
        if (!stickerSupportsVision) {
          ctxPayload.Body = includeStickerDescription(ctxPayload.Body, formattedDesc);
          ctxPayload.BodyForAgent = includeStickerDescription(
            ctxPayload.BodyForAgent,
            formattedDesc,
          );
          ctxPayload.SkipStickerMediaUnderstanding = true;
        }
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: ctxPayload.From,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      }
    }

    const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
      if (payload.text === text) {
        return payload;
      }
      return { ...payload, text };
    };
    const applyTextToFollowUpPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
      const next = applyTextToPayload(payload, text);
      const {
        replyToId: _replyToId,
        replyToCurrent: _replyToCurrent,
        replyToTag: _replyToTag,
        ...followUp
      } = next;
      return followUp;
    };
    const splitFinalTextForStream = (text: string): string[] => {
      return splitTelegramRichMarkdownChunks(text, draftMaxChars, chunkMode);
    };
    const applyQuoteReplyTarget = (payload: ReplyPayload): ReplyPayload => {
      if (
        !implicitQuoteReplyTargetId ||
        !currentMessageIdForQuoteReply ||
        payload.replyToId !== currentMessageIdForQuoteReply ||
        payload.replyToTag ||
        payload.replyToCurrent
      ) {
        return payload;
      }
      return { ...payload, replyToId: implicitQuoteReplyTargetId };
    };
    const normalizeDeliveryPayload = (payload: ReplyPayload): ReplyPayload | undefined => {
      const keepReasoningLane = payload.isReasoning === true && durableReasoningPayloadsEnabled;
      const payloadForPlan = keepReasoningLane ? { ...payload } : payload;
      if (keepReasoningLane) {
        delete payloadForPlan.isReasoning;
      }
      const normalized = projectOutboundPayloadPlanForDelivery(
        createOutboundPayloadPlan([payloadForPlan], {
          cfg,
          sessionKey: ctxPayload.SessionKey,
          surface: "telegram",
        }),
      )[0];
      return normalized ? materializeTelegramChartFallback(normalized) : undefined;
    };
    const usesNativeTelegramQuote = (payload: ReplyPayload): boolean => {
      if (replyQuoteText != null) {
        return true;
      }
      return payload.replyToId != null && replyQuoteByMessageId[payload.replyToId] != null;
    };
    const sendPayload = async (
      payload: ReplyPayload,
      options?: { durable?: boolean; silent?: boolean; mirrorTranscript?: boolean },
    ) => {
      if (isDispatchSuperseded()) {
        return false;
      }
      const deliverablePayload = applyQuoteReplyTarget(payload);
      const promptContextTimestampMs =
        options?.durable && deliverablePayload.text
          ? await resolvePromptContextTimestampMs(deliverablePayload.text)
          : undefined;
      const effectivePayload = withTelegramPromptContextTimestampMs(
        deliverablePayload,
        promptContextTimestampMs,
      );
      const silent = options?.silent ?? (silentErrorReplies && payload.isError === true);
      const durableDelivery = telegramDeps.deliverInboundReplyWithMessageSendContext;
      if (options?.durable && durableDelivery) {
        const durable = await durableDelivery({
          cfg,
          channel: "telegram",
          to: String(chatId),
          accountId: route.accountId,
          agentId: route.agentId,
          ctxPayload,
          payload: effectivePayload,
          info: { kind: "final" },
          replyToMode,
          threadId: threadSpec.id,
          formatting: {
            textLimit,
            tableMode,
            chunkMode,
          },
          silent,
          requiredCapabilities: deriveDurableFinalDeliveryRequirements({
            payload: effectivePayload,
            replyToId: effectivePayload.replyToId,
            threadId: threadSpec.id,
            silent,
            payloadTransport: true,
            extraCapabilities: {
              nativeQuote: usesNativeTelegramQuote(effectivePayload),
            },
          }),
        });
        if (durable.status === "failed") {
          throw durable.error;
        }
        if (durable.status === "handled_visible") {
          deliveryState.markDelivered();
          return true;
        }
        if (durable.status === "handled_no_send") {
          return false;
        }
      }
      const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
        ...deliveryBaseOptions,
        // The collapse bar is a cosmetic activity digest, not an assistant
        // message: pass mirrorTranscript:false so it never enters the session
        // transcript (the model must not read it back as its own prior turn).
        // Discord parity: its summary bar (reply-delivery.ts deliverDiscordReply)
        // has no transcript-mirror seam either. Real finals keep the default.
        transcriptMirror:
          options?.durable && options?.mirrorTranscript !== false
            ? deliveryBaseOptions.transcriptMirror
            : undefined,
        replies: [effectivePayload],
        onVoiceRecording: sendRecordVoice,
        silent,
        mediaLoader: telegramDeps.loadWebMedia,
      });
      if (result.delivered) {
        deliveryState.markDelivered();
      }
      return result.delivered;
    };
    const emitPreviewFinalizedHook = async (result: LaneDeliveryResult) => {
      if (isDispatchSuperseded() || result.kind !== "preview-finalized") {
        return;
      }
      (telegramDeps.emitInternalMessageSentHook ?? emitInternalMessageSentHook)({
        sessionKeyForInternalHooks: deliveryBaseOptions.sessionKeyForInternalHooks,
        chatId: deliveryBaseOptions.chatId,
        accountId: deliveryBaseOptions.accountId,
        content: result.delivery.content,
        success: true,
        messageId: result.delivery.messageId,
        isGroup: deliveryBaseOptions.mirrorIsGroup,
        groupId: deliveryBaseOptions.mirrorGroupId,
      });
      try {
        const promptContextContent =
          result.delivery.promptContextContent ?? result.delivery.content;
        const promptContextTimestampMs =
          await resolvePromptContextTimestampMs(promptContextContent);
        await (
          telegramDeps.recordOutboundMessageForPromptContext ??
          recordOutboundMessageForPromptContext
        )({
          cfg,
          account: {
            accountId: route.accountId,
            ...(telegramCfg.name !== undefined ? { name: telegramCfg.name } : {}),
            ...(context.primaryCtx.me ? { bot: context.primaryCtx.me } : {}),
          },
          chatId: deliveryBaseOptions.chatId,
          message: { message_id: result.delivery.messageId },
          messageId: result.delivery.messageId,
          text: promptContextContent,
          ...(promptContextTimestampMs !== undefined ? { promptContextTimestampMs } : {}),
          ...(threadSpec.id !== undefined ? { messageThreadId: threadSpec.id } : {}),
        });
      } catch (error) {
        logVerbose(
          `telegram: failed to record streamed reply for prompt context: ${formatErrorMessage(
            error,
          )}`,
        );
      }
      if (deliveryBaseOptions.transcriptMirror && result.delivery.content) {
        void deliveryBaseOptions
          .transcriptMirror({ text: result.delivery.content })
          .catch((err: unknown) => {
            logVerbose(
              `telegram preview-finalized transcriptMirror failed: ${formatErrorMessage(err)}`,
            );
          });
      }
    };
    const finalizeSkippedDuplicateAnswerBlockDraft = async () => {
      if (
        !skippedDuplicateAnswerBlockDraftDelivery ||
        queuedFinal ||
        dispatchError ||
        isDispatchSuperseded() ||
        answerLane.finalized
      ) {
        return;
      }
      const stream = answerLane.stream;
      const content = answerLane.lastPartialText;
      if (!stream || !content) {
        return;
      }
      await stream.stop();
      const messageId = stream.messageId();
      if (typeof messageId !== "number") {
        if (stream.sendMayHaveLanded?.()) {
          answerLane.finalized = true;
          deliveryState.markDelivered();
        }
        return;
      }
      answerLane.finalized = true;
      deliveryState.markDelivered();
      await emitPreviewFinalizedHook({
        kind: "preview-finalized",
        delivery: {
          content,
          promptContextContent: content,
          messageId,
          buttonsAttached: false,
          receipt: createPreviewMessageReceipt({ id: messageId }),
        },
      });
    };
    const deliverLaneText = createLaneTextDeliverer({
      lanes,
      draftMaxChars,
      applyTextToPayload,
      applyTextToFollowUpPayload,
      splitFinalTextForStream,
      sendPayload,
      flushDraftLane,
      stopDraftLane: async (lane) => {
        await lane.stream?.stop();
      },
      clearDraftLane: async (lane) => {
        await lane.stream?.clear();
      },
      editStreamMessage: async ({ messageId, text, buttons }) => {
        if (isDispatchSuperseded()) {
          return;
        }
        await (telegramDeps.editMessageTelegram ?? editMessageTelegram)(chatId, messageId, text, {
          api: bot.api,
          cfg,
          accountId: route.accountId,
          linkPreview: telegramCfg.linkPreview,
          buttons,
        });
      },
      resolveFinalTextCandidate: () => resolveCurrentTurnTranscriptFinalText(),
      log: logVerbose,
      markDelivered: () => {
        deliveryState.markDelivered();
      },
    });
    materializeAnswerLaneBeforeRotation = async () => {
      if (
        !lastAnswerBlockPayload ||
        !answerLane.stream ||
        !answerLane.hasStreamedMessage ||
        answerLane.finalized ||
        activeAnswerDraftIsToolProgressOnly
      ) {
        return false;
      }
      const text = answerLane.lastPartialText || lastAnswerPartialText || lastAnswerBlockText;
      if (!text?.trim()) {
        return false;
      }
      // Skipped duplicate blocks must materialize before the next draft takes over.
      const wasSkippedDuplicate = skippedDuplicateAnswerBlockDraftDelivery;
      skippedDuplicateAnswerBlockDraftDelivery = false;
      const deliveredText = answerLane.stream.lastDeliveredText?.();
      const messageId = answerLane.stream.messageId();
      if (
        !lastAnswerBlockButtons &&
        !wasSkippedDuplicate &&
        deliveredText === text.trimEnd() &&
        typeof messageId === "number"
      ) {
        await answerLane.stream.stop();
        answerLane.finalized = true;
        deliveryState.markDelivered();
        await emitPreviewFinalizedHook({
          kind: "preview-finalized",
          delivery: {
            content: text,
            promptContextContent: deliveredText,
            messageId,
            receipt: createPreviewMessageReceipt({ id: messageId }),
          },
        });
        return true;
      }
      const result = await deliverLaneText({
        laneName: "answer",
        text,
        payload: lastAnswerBlockPayload,
        infoKind: "block",
        buttons: lastAnswerBlockButtons,
        finalizePreview: true,
        durable: false,
      });
      await emitPreviewFinalizedHook(result);
      return result.kind !== "skipped";
    };
    // The one-line activity digest for the collapse bar, or undefined when the
    // window never rendered (rv mode delivers everything durably — no bar) or
    // the summary was already emitted this turn.
    const resolveProgressCollapseSummaryLine = (): string | undefined => {
      if (progressSummaryDelivered) {
        return undefined;
      }
      progressSummaryDelivered = true;
      if (!progressDraftEverRendered) {
        return undefined;
      }
      const line = formatTelegramProgressSummaryLine(
        progressSummary.counts(),
        Date.now() - progressSummaryStartedAt,
      );
      return line || undefined;
    };
    // The collapse summary bar is cosmetic and always reaches the user AFTER the
    // real final answer (edited in place, or posted below it). A flood-wait /
    // network throw from its durable send must never fail an otherwise-complete
    // turn. Shared by BOTH bar-post fallbacks (the cleanup path and the
    // finalizeToPreview-miss path) so neither can propagate a cosmetic failure
    // into turn delivery; sendPayload throws durable.error on delivery failure.
    const postCosmeticSummaryBar = async (line: string) => {
      try {
        await sendPayload({ text: line }, { durable: true, mirrorTranscript: false });
      } catch (err) {
        logVerbose(`telegram: collapse summary bar send failed: ${formatErrorMessage(err)}`);
      }
    };
    // Post-turn collapse summary (Discord parity) as a durable standalone
    // message. Used when there is no live window to collapse in place — the
    // final answer posts below so the timeline reads thoughts/tools → summary →
    // answer. Emitted at most once per turn.
    const deliverProgressCollapseSummary = async () => {
      const line = resolveProgressCollapseSummaryLine();
      if (!line) {
        return;
      }
      // Cleanup fallback bar (message_tool_only/codex turns): the once-guard
      // already fired in resolveProgressCollapseSummaryLine, so no retry storm.
      await postCosmeticSummaryBar(line);
    };
    // Apply a pre-resolved bar line to the window: edit the live window message
    // IN PLACE into the bar (no delete — deleting scroll-jumps the client), or
    // post it durably when there is no live window message to edit. NOTHING is
    // deleted. Returns "edited" | "posted". The line is snapshotted by the
    // caller BEFORE the final answer is sent, so the final's own delivery cannot
    // perturb the counts; the EDIT itself runs AFTER the final so shrinking the
    // tall window bubble down to one line happens above the anchored viewport
    // (the final already sits at the bottom) and never drops the final off
    // screen (the edit-shrink anchor loss). finalizeToPreview settles pending
    // previews so a still-pending tool-progress window is materialized and
    // edited rather than missed.
    const applyProgressCollapseSummary = async (line: string): Promise<"edited" | "posted"> => {
      const messageId = await answerLane.stream?.finalizeToPreview(renderStreamText(line));
      if (typeof messageId === "number") {
        return "edited";
      }
      // finalizeToPreview could not edit in place (no live window id, or a
      // flood-wait/terminal edit): post the bar durably instead. This send is
      // cosmetic and runs after the final answer, so a throw must not fail the
      // turn — the shared guarded helper swallows and logs.
      await postCosmeticSummaryBar(line);
      return "posted";
    };
    // Reset answer-lane bookkeeping after a bar was edited/posted in place,
    // WITHOUT clear() — the window message stays (as the bar) and must not be
    // deleted (no focus-jump). forceNewMessage only rewinds the stream so the
    // next send starts a new message.
    const resetAnswerLaneAfterCollapse = () => {
      if (activeAnswerDraftIsToolProgressOnly) {
        resetAnswerToolProgressDraft();
        suppressProgressDraftState();
        rotateAnswerLaneWhenQueuedBlocksSettle = false;
      }
      answerLane.stream?.forceNewMessage();
      resetDraftLaneState(answerLane);
    };
    // Tear the window down (delete) — only when there is NO bar to keep it on
    // screen for (error final, or a turn with nothing to summarize). A bar
    // collapse never reaches here, so clear()/delete never runs when a bar
    // exists (the on-off focus-jump).
    const teardownProgressWindow = async () => {
      if (activeAnswerDraftIsToolProgressOnly) {
        await rotateAnswerLaneAfterToolProgress();
      } else {
        await answerLane.stream?.clear();
        resetDraftLaneState(answerLane);
      }
    };
    const deliverProgressModeFinalAnswer = async (
      payload: ReplyPayload,
      text: string,
    ): Promise<LaneDeliveryResult> => {
      if (payload.isError === true) {
        // Error finals get no collapse summary (Discord parity); tear down, then
        // deliver the error below.
        progressSummaryDelivered = true;
        await teardownProgressWindow();
        const delivered = await sendPayload(applyTextToPayload(payload, text), { durable: true });
        if (!delivered) {
          return { kind: "skipped" };
        }
        answerLane.finalized = true;
        markProgressFinalDelivered();
        return { kind: "sent" };
      }
      // Snapshot the bar line BEFORE the final send so the final's own delivery
      // cannot perturb the counts/timer (and the once-guard fires exactly once).
      const barLine = resolveProgressCollapseSummaryLine();
      // Send the final FIRST so it lands at the bottom of the anchored viewport;
      // THEN collapse the window above it. Editing the tall window down to a
      // one-line bar after the final is delivered keeps the shrink above the
      // anchor, so the final never scrolls off screen (edit-shrink anchor loss).
      const delivered = await sendPayload(applyTextToPayload(payload, text), { durable: true });
      // Collapse AFTER the final either way — don't leave a stale window even
      // when the final skipped/failed. resetAnswerLaneAfterCollapse resets lane
      // state (clearing `finalized`), so mark the final delivered LAST.
      if (barLine) {
        await applyProgressCollapseSummary(barLine);
        resetAnswerLaneAfterCollapse();
      } else {
        // Nothing to summarize (window never rendered / empty counts): tear the
        // stale window down rather than leaving it above the final.
        await teardownProgressWindow();
      }
      if (!delivered) {
        return { kind: "skipped" };
      }
      answerLane.finalized = true;
      markProgressFinalDelivered();
      return { kind: "sent" };
    };
    const resolveTranscriptBackedFinalText = async (text: string): Promise<string> => {
      const candidate = await resolveCurrentTurnTranscriptFinal();
      return await resolveTranscriptBackedChannelFinalText({
        finalText: text,
        resolveCandidateText: async () => candidate?.text,
      });
    };

    if (isDmTopic) {
      try {
        const sessionKeyLocal = ctxPayload.SessionKey;
        if (sessionKeyLocal) {
          const { entry } = loadFreshSessionEntry(route.agentId, sessionKeyLocal);
          isFirstTurnInSession = !entry?.systemSent;
        } else {
          logVerbose("auto-topic-label: SessionKey is absent, skipping first-turn detection");
        }
      } catch (err) {
        logVerbose(`auto-topic-label: session store error: ${formatErrorMessage(err)}`);
      }
    }
    loadFreshSessionEntry.clear();

    if (statusReactionController && !isRoomEvent) {
      void statusReactionController.setThinking();
    }

    const { onModelSelected, ...replyPipeline } = (
      telegramDeps.createChannelMessageReplyPipeline ?? createChannelMessageReplyPipeline
    )({
      cfg,
      agentId: route.agentId,
      channel: "telegram",
      accountId: route.accountId,
      typing: {
        start: sendTyping,
        maxConsecutiveFailures: TELEGRAM_MAX_CONSECUTIVE_TYPING_FAILURES,
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "telegram",
            target: String(chatId),
            error: err,
          });
        },
      },
    });

    try {
      const turnResult = await runChannelInboundEvent({
        channel: "telegram",
        accountId: route.accountId,
        raw: dispatchContext,
        adapter: {
          ingest: () => ({
            id: ctxPayload.MessageSid ?? `${chatId}:${Date.now()}`,
            timestamp: typeof ctxPayload.Timestamp === "number" ? ctxPayload.Timestamp : undefined,
            rawText: ctxPayload.RawBody ?? "",
            textForAgent: ctxPayload.BodyForAgent,
            textForCommands: ctxPayload.CommandBody,
            raw: dispatchContext,
          }),
          resolveTurn: () => ({
            channel: "telegram",
            accountId: route.accountId,
            routeSessionKey: route.sessionKey,
            storePath: dispatchContext.turn.storePath,
            ctxPayload,
            recordInboundSession: dispatchContext.turn.recordInboundSession,
            record: dispatchContext.turn.record,
            runDispatch: () => {
              const sentBlockMediaUrls = new Set<string>();

              return telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
                ctx: ctxPayload,
                cfg,
                dispatcherOptions: {
                  ...replyPipeline,
                  beforeDeliver: async (payload) => payload,
                  onBeforeDeliverCancelled: (payload, info) => {
                    if (info.kind === "block") {
                      return enqueueDraftLaneEvent(async () => {
                        dropQueuedAnswerBlockRotation(payload, info.assistantMessageIndex);
                      });
                    }
                    return undefined;
                  },
                  deliver: async (payload, info) => {
                    if (isDispatchSuperseded()) {
                      return;
                    }

                    const normalizedPayload = normalizeDeliveryPayload(payload);
                    if (!normalizedPayload) {
                      return;
                    }
                    const deduped =
                      info.kind === "final"
                        ? deduplicateBlockSentMedia(normalizedPayload, sentBlockMediaUrls)
                        : normalizedPayload;
                    if (deduped === undefined) {
                      return;
                    }
                    const effectivePayload = deduped;

                    if (
                      shouldSuppressLocalTelegramExecApprovalPrompt({
                        cfg,
                        accountId: route.accountId,
                        payload: effectivePayload,
                      })
                    ) {
                      queuedFinal = true;
                      return;
                    }
                    const telegramButtons = resolvePayloadTelegramInlineButtons(effectivePayload);
                    const lanePayload =
                      info.kind === "block" &&
                      typeof payload.text === "string" &&
                      typeof effectivePayload.text === "string" &&
                      payload.text !== effectivePayload.text &&
                      payload.text.trimEnd() === effectivePayload.text &&
                      !effectivePayload.mediaUrl &&
                      !effectivePayload.mediaUrls?.length
                        ? { ...effectivePayload, text: payload.text }
                        : effectivePayload;
                    const split = splitTextIntoLaneSegments(
                      { text: lanePayload.text },
                      payload.isReasoning,
                    );
                    const segments = split.segments;
                    const reply = resolveSendableOutboundReplyParts(effectivePayload);
                    if (info.kind === "final" && (reply.text.length > 0 || reply.hasMedia)) {
                      markProgressFinalStarted();
                    }
                    if (info.kind === "final") {
                      await enqueueDraftLaneEvent(async () => {});
                    }
                    // Hide handled post-answer probe failures while preserving final warnings.
                    // Agents may intentionally run searches/commands with no result, recover,
                    // and send a final answer; late text-only failures are non-actionable noise.
                    const isToolPayloadAfterFinal =
                      info.kind === "tool" && (finalAnswerDeliveryStarted || finalAnswerDelivered);
                    const isNonTerminalWarningAfterDeliveredFinal =
                      isReplyPayloadNonTerminalToolErrorWarning(payload) && finalAnswerDelivered;
                    if (
                      (isToolPayloadAfterFinal || isNonTerminalWarningAfterDeliveredFinal) &&
                      !reply.hasMedia &&
                      !hasExecApprovalPayload(effectivePayload)
                    ) {
                      return;
                    }
                    if (payload.isError === true) {
                      hadErrorReplyFailureOrSkip = true;
                    }

                    const deliverFinalAnswerText = async (
                      answerPayload: ReplyPayload,
                      text: string,
                      buttons?: TelegramInlineButtons,
                    ) => {
                      const finalText = await resolveTranscriptBackedFinalText(text);
                      const deliverPostFinalFollowUpText = async () => {
                        await prepareAnswerLaneForText();
                        return deliverLaneText({
                          laneName: "answer",
                          text: finalText,
                          payload: answerPayload,
                          infoKind: "final",
                          buttons,
                        });
                      };
                      if (finalAnswerDelivered) {
                        return deliverPostFinalFollowUpText();
                      }
                      if (streamMode === "progress") {
                        return deliverProgressModeFinalAnswer(answerPayload, finalText);
                      }
                      if (!(await rotateAnswerLaneAfterToolProgress())) {
                        await rotateAnswerLaneAfterQueuedBlocksSettle();
                      }
                      const result = await deliverLaneText({
                        laneName: "answer",
                        text: finalText,
                        payload: answerPayload,
                        infoKind: "final",
                        buttons,
                      });
                      if (result.kind !== "skipped") {
                        markProgressFinalDelivered();
                      }
                      return result;
                    };

                    const flushBufferedFinalAnswer = async () => {
                      const buffered =
                        reasoningStepState.takeBufferedFinalAnswer(replyFenceGeneration);
                      if (!buffered) {
                        return;
                      }
                      const bufferedButtons = resolvePayloadTelegramInlineButtons(buffered.payload);
                      await deliverFinalAnswerText(
                        buffered.payload,
                        buffered.text,
                        bufferedButtons,
                      );
                      reasoningStepState.resetForNextStep();
                    };

                    let blockDelivered = false;
                    const hasAnswerSegment = segments.some((segment) => segment.lane === "answer");
                    if (info.kind === "block" && !hasAnswerSegment) {
                      dropQueuedAnswerBlockRotation(effectivePayload, info.assistantMessageIndex);
                    }
                    for (const segment of segments) {
                      if (
                        segment.lane === "answer" &&
                        info.kind === "final" &&
                        reasoningStepState.shouldBufferFinalAnswer()
                      ) {
                        reasoningStepState.bufferFinalAnswer({
                          payload: effectivePayload,
                          text: segment.update.text,
                          bufferedGeneration: replyFenceGeneration,
                        });
                        continue;
                      }
                      if (segment.lane === "reasoning") {
                        reasoningStepState.noteReasoningHint();
                      }
                      if (segment.lane === "answer" && info.kind === "tool") {
                        if (verboseProgressActive()) {
                          // Durable lane owns tool payloads: send standalone instead
                          // of diverting into the draft, which is discarded at final.
                          if (
                            await sendPayload(
                              applyTextToPayload(effectivePayload, segment.update.text),
                            )
                          ) {
                            blockDelivered = true;
                          }
                          continue;
                        }
                        const canRepresentAsTransientProgress =
                          !reply.hasMedia &&
                          telegramButtons === undefined &&
                          !hasExecApprovalPayload(effectivePayload);
                        const isFastModeProgressPayload =
                          isFastModeAutoProgressPayload(effectivePayload);
                        if (streamMode === "progress") {
                          if (
                            canRepresentAsTransientProgress &&
                            answerLane.stream &&
                            !isFastModeProgressPayload
                          ) {
                            // Progress-mode streams render tool status in the
                            // live draft. Do not also emit text-only tool output
                            // as answer text, or simple commands duplicate and
                            // restart the progress draft.
                            continue;
                          }
                          if (
                            (canRepresentAsTransientProgress || isFastModeProgressPayload) &&
                            (await pushStreamToolProgress(segment.update.text, {
                              startImmediately: true,
                            }))
                          ) {
                            blockDelivered = true;
                            continue;
                          }
                        }
                        await prepareAnswerLaneForToolProgress();
                      }

                      const ownedByQueuedAnswerBlockRotation = queuedAnswerBlockRotations.some(
                        (entry) =>
                          queuedAnswerBlockRotationMatchesDelivery(
                            entry,
                            lanePayload,
                            info.assistantMessageIndex,
                          ),
                      );

                      const skipTextOnlyBlock =
                        streamMode === "partial" &&
                        info.kind === "block" &&
                        segment.lane === "answer" &&
                        !reply.hasMedia &&
                        !hasExecApprovalPayload(effectivePayload) &&
                        telegramButtons === undefined &&
                        answerLane.hasStreamedMessage &&
                        !activeAnswerDraftIsToolProgressOnly &&
                        !ownedByQueuedAnswerBlockRotation &&
                        segment.update.text.trimEnd() === answerLane.lastPartialText.trimEnd();

                      // Progress mode: the window is a pure activity log — interim
                      // answer blocks (intermediate assistant messages before the
                      // final) never render into it (Discord parity). Buffer the
                      // block so it still feeds the final/collapse, and skip the
                      // draft stream. Media/approval/button blocks fall through to
                      // normal delivery (they are not plain interim prose).
                      const suppressProgressAnswerBlock =
                        streamMode === "progress" &&
                        info.kind === "block" &&
                        segment.lane === "answer" &&
                        !reply.hasMedia &&
                        !hasExecApprovalPayload(effectivePayload) &&
                        telegramButtons === undefined;

                      if (skipTextOnlyBlock || suppressProgressAnswerBlock) {
                        // Keep duplicate blocks available for later rotation/finalization.
                        skippedDuplicateAnswerBlockDraftDelivery = true;
                        lastAnswerBlockPayload = effectivePayload;
                        lastAnswerBlockText = segment.update.text;
                        lastAnswerBlockButtons = telegramButtons;
                        resetAnswerToolProgressDraft();
                        resetProgressDraftState();
                        blockDelivered = true;
                        continue;
                      }

                      if (segment.lane === "answer" && info.kind === "block") {
                        const preparedAnswerLane = await prepareAnswerLaneForText();
                        const shouldRotateQueuedBlock = takeQueuedAnswerBlockRotation(
                          lanePayload,
                          info.assistantMessageIndex,
                        );
                        // Single stationary window in progress mode: plain interim
                        // answer blocks are already suppressed above, so only
                        // media/approval/button blocks reach here in progress — they
                        // still must not rotate the window to a fresh bubble.
                        if (
                          streamMode !== "progress" &&
                          shouldRotateQueuedBlock &&
                          !preparedAnswerLane
                        ) {
                          await rotateAnswerLaneForNewMessage();
                          rotateAnswerLaneWhenQueuedBlocksSettle = false;
                        }
                        resetAnswerToolProgressDraft();
                        resetProgressDraftState();
                      }
                      const result =
                        segment.lane === "answer" && info.kind === "final"
                          ? await deliverFinalAnswerText(
                              effectivePayload,
                              segment.update.text,
                              telegramButtons,
                            )
                          : await deliverLaneText({
                              laneName: segment.lane,
                              text: segment.update.text,
                              payload: lanePayload,
                              infoKind: info.kind,
                              buttons: telegramButtons,
                            });
                      if (segment.lane === "answer" && result.kind === "preview-finalized") {
                        await emitPreviewFinalizedHook(result);
                      }
                      if (
                        segment.lane === "answer" &&
                        info.kind === "block" &&
                        (result.kind === "preview-updated" ||
                          result.kind === "preview-finalized" ||
                          result.kind === "preview-retained")
                      ) {
                        lastAnswerBlockPayload = lanePayload;
                        lastAnswerBlockText = segment.update.text;
                        lastAnswerBlockButtons = telegramButtons;
                      }
                      blockDelivered = blockDelivered || result.kind !== "skipped";
                      if (segment.lane === "reasoning") {
                        if (result.kind !== "skipped") {
                          reasoningStepState.noteReasoningDelivered();
                          await flushBufferedFinalAnswer();
                        }
                        continue;
                      }
                      if (info.kind === "final") {
                        reasoningStepState.resetForNextStep();
                      }
                    }
                    const trackBlockMedia = (delivered: boolean) => {
                      if (
                        delivered &&
                        info.kind === "block" &&
                        effectivePayload.mediaUrls?.length
                      ) {
                        for (const url of effectivePayload.mediaUrls) {
                          sentBlockMediaUrls.add(url);
                        }
                      }
                    };

                    if (segments.length > 0) {
                      trackBlockMedia(blockDelivered);
                      return;
                    }
                    if (split.suppressedReasoningOnly) {
                      let delivered = false;
                      if (reply.hasMedia) {
                        if (info.kind === "final") {
                          await rotateAnswerLaneAfterToolProgress();
                          await answerLane.stream?.stop();
                          await reasoningLane.stream?.stop();
                          reasoningStepState.resetForNextStep();
                        }
                        const payloadWithoutSuppressedReasoning =
                          typeof effectivePayload.text === "string"
                            ? { ...effectivePayload, text: "" }
                            : effectivePayload;
                        delivered = await sendPayload(payloadWithoutSuppressedReasoning, {
                          durable: info.kind === "final",
                        });
                      }
                      if (info.kind === "final" && delivered) {
                        markProgressFinalDelivered();
                      }
                      if (info.kind === "final") {
                        await flushBufferedFinalAnswer();
                      }
                      trackBlockMedia(delivered);
                      return;
                    }

                    if (info.kind === "final") {
                      await rotateAnswerLaneAfterToolProgress();
                      await answerLane.stream?.stop();
                      await reasoningLane.stream?.stop();
                      reasoningStepState.resetForNextStep();
                    }
                    const canSendAsIs = reply.hasMedia || reply.text.length > 0;
                    if (!canSendAsIs) {
                      if (info.kind === "final") {
                        await flushBufferedFinalAnswer();
                      }
                      return;
                    }
                    const delivered = await sendPayload(effectivePayload, {
                      durable: info.kind === "final",
                    });
                    if (info.kind === "final" && delivered) {
                      markProgressFinalDelivered();
                    }
                    if (info.kind === "final") {
                      await flushBufferedFinalAnswer();
                    }
                    trackBlockMedia(delivered);
                  },
                  onSkip: (payload, info) => {
                    if (info.kind === "block") {
                      void enqueueDraftLaneEvent(async () => {
                        dropQueuedAnswerBlockRotation(payload, info.assistantMessageIndex);
                      });
                    }
                    if (payload.isError === true) {
                      hadErrorReplyFailureOrSkip = true;
                    }
                    if (info.reason !== "silent") {
                      deliveryState.markNonSilentSkip();
                    }
                  },
                  onError: (err, info) => {
                    const errorPolicy = resolveTelegramErrorPolicy({
                      accountConfig: telegramCfg,
                      groupConfig,
                      topicConfig,
                    });
                    if (isSilentErrorPolicy(errorPolicy.policy)) {
                      return;
                    }
                    if (
                      errorPolicy.policy === "once" &&
                      shouldSuppressTelegramError({
                        scopeKey: buildTelegramErrorScopeKey({
                          accountId: route.accountId,
                          chatId,
                          threadId: threadSpec.id,
                        }),
                        cooldownMs: errorPolicy.cooldownMs,
                        errorMessage: String(err),
                      })
                    ) {
                      return;
                    }
                    deliveryState.markNonSilentFailure();
                    runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
                  },
                },
                replyOptions: {
                  skillFilter,
                  disableBlockStreaming,
                  abortSignal: replyAbortSignal,
                  onTurnAdopted: adoptReplyTurn,
                  sourceReplyDeliveryMode: isRoomEvent ? "message_tool_only" : undefined,
                  queuedDeliveryCorrelations: isRoomEvent
                    ? [{ begin: beginDeliveryCorrelation }]
                    : undefined,
                  queuedFollowupLifecycle:
                    isRoomEvent || onTurnAdopted || onTurnDeferred || onTurnAbandoned
                      ? {
                          onEnqueued: () => {
                            replyAbortControllerQueued = true;
                            onTurnDeferred?.();
                          },
                          onAdmitted: async () => {
                            await adoptReplyTurn();
                            queuedTurnAdmitted = true;
                          },
                          onComplete: () => {
                            replyAbortControllerQueued = false;
                            releaseTelegramReplyFenceAbortController(
                              activeReplyFenceKey,
                              replyAbortController,
                            );
                            if (!queuedTurnAdmitted) {
                              onTurnAbandoned?.();
                            }
                          },
                        }
                      : undefined,
                  suppressTyping: isRoomEvent,
                  onPartialReply:
                    answerLane.stream || reasoningLane.stream
                      ? (payload) =>
                          enqueueDraftLaneEvent(async () => {
                            await ingestDraftLaneSegments(payload);
                          })
                      : undefined,
                  onBlockReplyQueued: answerLane.stream
                    ? (payload, blockContext) =>
                        enqueueDraftLaneEvent(async () => {
                          await prepareQueuedAnswerBlock(payload, blockContext);
                        })
                    : undefined,
                  onReasoningStream: reasoningLane.stream
                    ? (payload) =>
                        enqueueDraftLaneEvent(async () => {
                          if (splitReasoningOnNextStream) {
                            reasoningLane.stream?.forceNewMessage();
                            resetDraftLaneState(reasoningLane);
                            splitReasoningOnNextStream = false;
                          }
                          await ingestDraftLaneSegments(payload, true);
                        })
                    : streamReasoningInProgressDraft
                      ? (payload) =>
                          enqueueDraftLaneEvent(async () => {
                            await pushStreamReasoningProgress(payload);
                          })
                      : undefined,
                  onReasoningProgress: answerLane.stream
                    ? (payload) =>
                        enqueueDraftLaneEvent(async () => {
                          await pushStreamThinkingTokenProgress(payload.progressTokens);
                        })
                    : undefined,
                  onAssistantMessageStart: answerLane.stream
                    ? () =>
                        enqueueDraftLaneEvent(async () => {
                          reasoningStepState.resetForNextStep();
                          finalAnswerDelivered = false;
                          if (streamMode !== "progress") {
                            resetProgressDraftState();
                          }
                          if (answerLane.finalized) {
                            await rotateLaneForNewMessage(answerLane);
                            rotateAnswerLaneWhenQueuedBlocksSettle = false;
                          } else if (
                            answerLane.hasStreamedMessage &&
                            !activeAnswerDraftIsToolProgressOnly
                          ) {
                            rotateAnswerLaneWhenQueuedBlocksSettle = true;
                          }
                        })
                    : undefined,
                  onReasoningEnd: reasoningLane.stream
                    ? () =>
                        enqueueDraftLaneEvent(async () => {
                          progressSummary.closeReasoningBurst();
                          splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
                          resetProgressDraftState();
                        })
                    : () => {
                        // Window-reasoning turns have no separate reasoning lane;
                        // reasoning-end is still a burst boundary for the collapse
                        // summary (some models never fire it — the tracker also
                        // closes at the next tool call or the summary flush).
                        progressSummary.closeReasoningBurst();
                      },
                  suppressDefaultToolProgressMessages:
                    !streamDeliveryEnabled || Boolean(answerLane.stream),
                  forceToolResultProgress: streamMode === "progress" && streamToolProgressEnabled,
                  allowProgressCallbacksWhenSourceDeliverySuppressed:
                    !isRoomEvent && Boolean(answerLane.stream),
                  onVerboseProgressVisibility: (isActive) => {
                    verboseProgressActive = isActive;
                  },
                  commentaryProgressEnabled:
                    streamMode === "progress" ? progressDraft.commentaryProgressEnabled : undefined,
                  reasoningPayloadsEnabled: durableReasoningPayloadsEnabled,
                  onToolStart: async (payload) => {
                    const toolName = payload.name?.trim();
                    // Only the "start" phase is a boundary (later phases of the same
                    // call must not inflate the tally). The tool closes the preceding
                    // reasoning AND commentary bursts, counting each per-burst — so a
                    // turn's notes sharing the turn-local id "commentary-0" tally as
                    // N, not 1 (D3). The tool itself is counted only when it renders
                    // to the window: under verbose, tool summaries persist as their
                    // own durable messages and must NOT also feed the bar (invariant:
                    // persistent message XOR bar count — D2).
                    if (payload.phase === "start") {
                      // Count a tool only when the WINDOW actually renders it, so the
                      // bar's 🛠️ tally matches what streamed. The compositor renders
                      // a tool line only for work tools (isChannelProgressDraftWorkToolName
                      // rejects message/reply/react/typing/etc.) and only when
                      // toolProgress is on; a start-phase message tool (codex/
                      // message_tool_only) otherwise inflated the count with no tool
                      // line. canPushStreamToolProgress() is false under verbose (the
                      // durable lane owns the tool message: persistent XOR window). In
                      // every non-counting case the tool start is still a burst
                      // boundary, so close reasoning/commentary without counting it.
                      const windowRendersTool =
                        canPushStreamToolProgress() &&
                        streamToolProgressEnabled &&
                        isChannelProgressDraftWorkToolName(toolName);
                      if (windowRendersTool) {
                        progressSummary.noteToolCall();
                      } else {
                        progressSummary.closeReasoningBurst();
                        progressSummary.closeCommentaryBurst();
                      }
                    }
                    const progressPromise = pushStreamToolProgress(
                      buildChannelProgressDraftLineForEntry(
                        telegramCfg,
                        {
                          event: "tool",
                          itemId: payload.itemId,
                          toolCallId: payload.toolCallId,
                          name: toolName,
                          phase: payload.phase,
                          args: payload.args,
                        },
                        payload.detailMode ? { detailMode: payload.detailMode } : undefined,
                      ),
                      { toolName, startImmediately: true },
                    );
                    if (statusReactionController && toolName) {
                      await statusReactionController.setTool(toolName);
                    }
                    await progressPromise;
                  },
                  onItemEvent: async (payload) => {
                    if (payload.kind === "preamble") {
                      if (verboseProgressActive()) {
                        // Durable verbose lane owns commentary; not counted toward
                        // the collapse summary — it did not stream to the window.
                        return;
                      }
                      // Window path: the note renders to the progress window, so
                      // tally it for the collapse bar (counted per-burst, D3).
                      progressSummary.noteCommentary(payload.itemId, payload.progressText);
                      await progressDraft.pushCommentaryProgress(payload.progressText, {
                        itemId: payload.itemId,
                      });
                      return;
                    }
                    await pushStreamToolProgress(
                      buildChannelProgressDraftLineForEntry(telegramCfg, {
                        event: "item",
                        itemId: payload.itemId,
                        toolCallId: payload.toolCallId,
                        itemKind: payload.kind,
                        title: payload.title,
                        name: payload.name,
                        phase: payload.phase,
                        status: payload.status,
                        summary: payload.summary,
                        progressText: payload.progressText,
                        meta: payload.meta,
                      }),
                    );
                  },
                  onPlanUpdate: async (payload) => {
                    if (payload.phase !== "update") {
                      return;
                    }
                    await pushStreamToolProgress(
                      buildChannelProgressDraftLine({
                        event: "plan",
                        phase: payload.phase,
                        title: payload.title,
                        explanation: payload.explanation,
                        steps: payload.steps,
                      }),
                    );
                  },
                  onApprovalEvent: async (payload) => {
                    if (payload.phase !== "requested") {
                      return;
                    }
                    await pushStreamToolProgress(
                      buildChannelProgressDraftLine({
                        event: "approval",
                        phase: payload.phase,
                        title: payload.title,
                        command: payload.command,
                        reason: payload.reason,
                        message: payload.message,
                      }),
                    );
                  },
                  onToolResult: async (payload) => {
                    const text = payload.text?.trim();
                    if (!text) {
                      return;
                    }
                    const updatedDraft = await pushStreamToolProgress(text, {
                      startImmediately: true,
                    });
                    if (
                      !updatedDraft &&
                      isFastModeAutoProgressPayload(payload) &&
                      !canPushStreamToolProgress()
                    ) {
                      await sendPayload(payload);
                    }
                  },
                  onCommandOutput: async (payload) => {
                    if (payload.phase !== "end") {
                      return;
                    }
                    await pushStreamToolProgress(
                      buildChannelProgressDraftLineForEntry(telegramCfg, {
                        event: "command-output",
                        itemId: payload.itemId,
                        toolCallId: payload.toolCallId,
                        phase: payload.phase,
                        title: payload.title,
                        name: payload.name,
                        status: payload.status,
                        exitCode: payload.exitCode,
                      }),
                    );
                  },
                  onPatchSummary: async (payload) => {
                    if (payload.phase !== "end") {
                      return;
                    }
                    await pushStreamToolProgress(
                      buildChannelProgressDraftLine({
                        event: "patch",
                        itemId: payload.itemId,
                        toolCallId: payload.toolCallId,
                        phase: payload.phase,
                        title: payload.title,
                        name: payload.name,
                        added: payload.added,
                        modified: payload.modified,
                        deleted: payload.deleted,
                        summary: payload.summary,
                      }),
                    );
                  },
                  onCompactionStart: statusReactionController
                    ? async () => {
                        await statusReactionController.setCompacting();
                      }
                    : undefined,
                  onCompactionEnd: statusReactionController
                    ? async () => {
                        statusReactionController.cancelPending();
                        await statusReactionController.setThinking();
                      }
                    : undefined,
                  onModelSelected,
                },
              });
            },
          }),
        },
      });
      if (!turnResult.dispatched) {
        return { kind: "completed" };
      }
      ({ queuedFinal } = turnResult.dispatchResult);
      // Out-of-band finals (message_tool_only) never run the in-band final-delivery
      // path, so record the final from the dispatch counts for the cleanup-time
      // collapse-bar fallback.
      if ((turnResult.dispatchResult.counts?.final ?? 0) > 0) {
        sawProgressFinal = true;
      }
      suppressSilentReplyFallback =
        turnResult.dispatchResult.sourceReplyDeliveryMode === "message_tool_only";
    } catch (err) {
      dispatchError = err;
      runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
    } finally {
      progressDraft.cancel();
      await draftLaneEventQueue;
      await finalizeSkippedDuplicateAnswerBlockDraft();
      const lanesToCleanup: Array<{ laneName: LaneName; lane: DraftLaneState }> = [
        { laneName: "answer", lane: answerLane },
        { laneName: "reasoning", lane: reasoningLane },
      ];
      for (const { lane } of lanesToCleanup) {
        const stream = lane.stream;
        if (!stream) {
          continue;
        }
        if (isDispatchSuperseded()) {
          await (typeof stream.discard === "function" ? stream.discard() : stream.stop());
          continue;
        }
        if (lane.finalized) {
          await stream.stop();
        } else {
          await stream.clear();
        }
      }
      // Fallback collapse summary (Discord parity): finals that bypass
      // deliverProgressModeFinalAnswer — notably message_tool_only/codex turns
      // whose final is delivered out-of-band — still collapse here. The internal
      // once-guard and progressDraftEverRendered check keep this from
      // double-posting or firing when the window never rendered.
      if (
        streamMode === "progress" &&
        sawProgressFinal &&
        !dispatchError &&
        !hadErrorReplyFailureOrSkip &&
        !isDispatchSuperseded()
      ) {
        await deliverProgressCollapseSummary();
      }
    }
  } finally {
    dispatchWasSuperseded = isDispatchSuperseded();
    releaseReplyFence();
    endTelegramInboundEventDeliveryCorrelation();
  }
  if (dispatchWasSuperseded) {
    if (statusReactionController) {
      void finalizeTelegramStatusReaction({ outcome: "done", hasFinalResponse: true }).catch(
        (err: unknown) => {
          logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
        },
      );
    } else {
      removeAckReactionAfterReply({
        removeAfterReply: removeAckAfterReply,
        ackReactionPromise,
        ackReactionValue: ackReactionPromise ? "ack" : null,
        remove: () =>
          (reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve()).then(() => {}),
        onError: (err) => {
          if (!msg.message_id) {
            return;
          }
          logAckFailure({
            log: logVerbose,
            channel: "telegram",
            target: `${chatId}/${msg.message_id}`,
            error: err,
          });
        },
      });
    }
    return { kind: "completed" };
  }
  let sentFallback = false;
  const deliverySummary = deliveryState.snapshot();
  const shouldSendFailureFallback =
    !isRoomEvent &&
    !suppressFailureFallback &&
    !finalAnswerDelivered &&
    (dispatchError || deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0);
  if (shouldSendFailureFallback) {
    const fallbackText = dispatchError
      ? "Something went wrong while processing your request. Please try again."
      : EMPTY_RESPONSE_FALLBACK;
    const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
      replies: [{ text: fallbackText }],
      ...deliveryBaseOptions,
      silent: silentErrorReplies && (dispatchError != null || hadErrorReplyFailureOrSkip),
      mediaLoader: telegramDeps.loadWebMedia,
    });
    sentFallback = result.delivered;
  }

  if (
    !sentFallback &&
    !dispatchError &&
    !deliverySummary.delivered &&
    !suppressSilentReplyFallback &&
    !queuedFinal &&
    isGroup
  ) {
    const policySessionKey =
      ctxPayload.CommandSource === "native"
        ? (ctxPayload.CommandTargetSessionKey ?? ctxPayload.SessionKey)
        : ctxPayload.SessionKey;
    const silentReplyFallback = projectOutboundPayloadPlanForDelivery(
      createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
        cfg,
        sessionKey: policySessionKey,
        surface: "telegram",
      }),
    );
    if (silentReplyFallback.length > 0) {
      const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
        replies: silentReplyFallback,
        ...deliveryBaseOptions,
        silent: false,
        mediaLoader: telegramDeps.loadWebMedia,
      });
      sentFallback = result.delivered;
    }
    silentReplyDispatchLogger.debug("telegram turn ended without visible final response", {
      hasSessionKey: Boolean(policySessionKey),
      hasChatId: chatId != null,
      queuedFinal,
      sentFallback,
    });
  }

  const hasFinalResponse =
    finalAnswerDelivered || sentFallback || suppressSilentReplyFallback || queuedFinal;
  const hasVisibleResponse =
    deliverySummary.delivered || sentFallback || suppressSilentReplyFallback || queuedFinal;
  const deliveryFailureWithoutFinalResponse =
    !finalAnswerDelivered &&
    (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0);
  const retryableDispatchFailure =
    dispatchError ??
    (deliveryFailureWithoutFinalResponse
      ? new Error(
          `Telegram reply delivery failed without a final response (failed=${deliverySummary.failedNonSilent}, skipped=${deliverySummary.skippedNonSilent})`,
        )
      : null);

  if (statusReactionController && !hasVisibleResponse) {
    void finalizeTelegramStatusReaction({ outcome: "error", hasFinalResponse: false }).catch(
      (err: unknown) => {
        logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
      },
    );
  }

  const shouldReturnRetryableDispatchFailure =
    retryDispatchErrors &&
    ((dispatchError != null && !hasFinalResponse) ||
      (dispatchError == null && deliveryFailureWithoutFinalResponse && !hasVisibleResponse));

  if (retryableDispatchFailure && shouldReturnRetryableDispatchFailure) {
    return { kind: "failed-retryable", error: retryableDispatchFailure };
  }

  if (!hasVisibleResponse) {
    return { kind: "completed" };
  }

  // Fire-and-forget: auto-rename DM topic on first message.
  if (isDmTopic && isFirstTurnInSession) {
    const userMessage = truncateUtf16Safe(ctxPayload.RawBody ?? ctxPayload.Body ?? "", 500);
    if (userMessage.trim()) {
      const agentDir = resolveAgentDir(cfg, route.agentId);
      const directAutoTopicLabel =
        !isGroup && groupConfig && "autoTopicLabel" in groupConfig
          ? groupConfig.autoTopicLabel
          : undefined;
      const accountAutoTopicLabel = telegramCfg?.autoTopicLabel;
      const autoTopicConfig = resolveAutoTopicLabelConfig(
        directAutoTopicLabel,
        accountAutoTopicLabel,
      );
      if (autoTopicConfig) {
        const topicThreadId = threadSpec.id!;
        void (async () => {
          try {
            const label = await generateTopicLabel({
              userMessage,
              prompt: autoTopicConfig.prompt,
              cfg,
              agentId: route.agentId,
              agentDir,
            });
            if (!label) {
              logVerbose("auto-topic-label: LLM returned empty label");
              return;
            }
            logVerbose(`auto-topic-label: generated label (len=${label.length})`);
            await bot.api.editForumTopic(chatId, topicThreadId, { name: label });
            logVerbose(`auto-topic-label: renamed topic ${chatId}/${topicThreadId}`);
          } catch (err) {
            logVerbose(`auto-topic-label: failed: ${formatErrorMessage(err)}`);
          }
        })();
      }
    }
  }

  if (statusReactionController) {
    const statusReactionOutcome =
      !finalAnswerDelivered && (dispatchError != null || sentFallback) ? "error" : "done";
    void finalizeTelegramStatusReaction({
      outcome: statusReactionOutcome,
      hasFinalResponse: true,
    }).catch((err: unknown) => {
      logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
    });
  } else {
    removeAckReactionAfterReply({
      removeAfterReply: removeAckAfterReply,
      ackReactionPromise,
      ackReactionValue: ackReactionPromise ? "ack" : null,
      remove: () =>
        (reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve()).then(() => {}),
      onError: (err) => {
        if (!msg.message_id) {
          return;
        }
        logAckFailure({
          log: logVerbose,
          channel: "telegram",
          target: `${chatId}/${msg.message_id}`,
          error: err,
        });
      },
    });
  }
  return { kind: "completed" };
};
