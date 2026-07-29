// Telegram plugin module recovers dispatch routing and group-history context.
import { CURRENT_MESSAGE_MARKER } from "openclaw/plugin-sdk/channel-mention-gating";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import {
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  buildTelegramInboundOriginTarget,
  buildTypingThreadParams,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import {
  isTelegramHistoryEntryAfterAmbientWatermark,
  mergeTelegramGroupHistoryPromptContext,
  retainTelegramGroupHistoryPromptContext,
  selectTelegramGroupHistoryAfterLastSelf,
} from "./group-history-window.js";

const TELEGRAM_GENERAL_TOPIC_ID = 1;

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
  createChannelHistoryWindow({ historyMap: params.context.groupHistories }).record({
    historyKey: recoveredHistoryKey,
    limit: params.context.historyLimit,
    entry,
  });
}

export function resolveDispatchTelegramContext(params: {
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
    promptContext: params.context.ctxPayload.ChannelStructuredContext ?? [],
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
  migrateRecoveredTelegramGroupHistory({ context: params.context, recoveredHistoryKey });
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
            ChannelStructuredContext: recoveredPromptContext,
          },
  };
}
