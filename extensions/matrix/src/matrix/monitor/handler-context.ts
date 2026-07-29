import {
  buildChannelInboundEventContext,
  createChannelInboundEnvelopeBuilder,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  evaluateSupplementalContextVisibility,
  resolveChannelContextVisibilityMode,
} from "openclaw/plugin-sdk/context-visibility-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CoreConfig, MatrixRoomConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { resolveMatrixAckReactionConfig } from "./ack-config.js";
import { resolveMatrixAllowListMatch } from "./allowlist.js";
import { resolveMatrixSharedDmContextNotice } from "./handler-helpers.js";
import { loadMatrixSendModule } from "./handler-runtime.js";
import type { MatrixLocationPayload } from "./location.js";
import { createMatrixReplyContextResolver } from "./reply-context.js";
import type { HistoryEntry } from "./room-history.js";
import type { resolveMatrixInboundRoute } from "./route.js";
import type { PluginRuntime, RuntimeEnv } from "./runtime-api.js";
import { createMatrixThreadContextResolver } from "./thread-context.js";
import { resolveMatrixReplyToEventId, resolveMatrixThreadRouting } from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";

type MatrixInboundRoute = ReturnType<typeof resolveMatrixInboundRoute>["route"];

export async function resolveMatrixInboundContext(config: {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  accountId: string;
  runtime: RuntimeEnv;
  logVerboseMessage: (message: string) => void;
  roomId: string;
  event: MatrixRawEvent;
  eventTs?: number;
  route: MatrixInboundRoute;
  isDirectMessage: boolean;
  isRoom: boolean;
  effectiveRoomUsers: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  effectiveGroupAllowFrom: string[];
  contextVisibilityMode: ReturnType<typeof resolveChannelContextVisibilityMode>;
  resolveThreadContext: ReturnType<typeof createMatrixThreadContextResolver>;
  resolveReplyContext: ReturnType<typeof createMatrixReplyContextResolver>;
  threadRootId?: string;
  thread: ReturnType<typeof resolveMatrixThreadRouting>;
  getRoomInfo: (
    roomId: string,
    opts?: { includeAliases?: boolean },
  ) => Promise<{ name?: string; canonicalAlias?: string; altAliases: string[] }>;
  senderId: string;
  senderName: string;
  bodyText: string;
  commandBodyText: string;
  roomConfig?: MatrixRoomConfig;
  messageId: string;
  inboundHistory?: HistoryEntry[];
  wasMentioned: boolean;
  effectiveWasMentioned: boolean;
  shouldBypassMention: boolean;
  canDetectMention: boolean;
  shouldRequireMention: boolean;
  commandAuthorized: boolean;
  locationPayload: MatrixLocationPayload | null;
  media: { path: string; contentType?: string; placeholder: string } | null;
  preflightAudioTranscript?: string;
  historyLimit: number;
  hasExplicitSessionBinding: boolean;
  dmSessionScope?: "per-user" | "per-room";
  sharedDmContextNoticeRooms: Set<string>;
  resolveStorePath: typeof resolveStorePath;
  createChannelInboundEnvelopeBuilder: typeof createChannelInboundEnvelopeBuilder;
  finalizeInboundContext?: (ctx: Record<string, unknown>) => unknown;
}) {
  const {
    client,
    core,
    cfg,
    accountId,
    runtime,
    logVerboseMessage,
    roomId,
    event,
    eventTs,
    route: _route,
    isDirectMessage,
    isRoom,
    effectiveRoomUsers,
    groupPolicy,
    effectiveGroupAllowFrom,
    contextVisibilityMode,
    resolveThreadContext,
    resolveReplyContext,
    threadRootId,
    thread,
    getRoomInfo,
    senderId,
    senderName,
    bodyText,
    commandBodyText,
    roomConfig,
    messageId,
    inboundHistory,
    wasMentioned,
    effectiveWasMentioned,
    shouldBypassMention,
    canDetectMention,
    shouldRequireMention,
    commandAuthorized,
    locationPayload,
    media,
    preflightAudioTranscript,
    historyLimit,
    hasExplicitSessionBinding,
    dmSessionScope,
    sharedDmContextNoticeRooms,
    resolveStorePath: resolveStorePathImpl,
    createChannelInboundEnvelopeBuilder: createChannelInboundEnvelopeBuilderImpl,
    finalizeInboundContext,
  } = config;

  const replyToEventId = resolveMatrixReplyToEventId(event.content as RoomMessageEventContent);
  const threadTarget = thread.threadId;
  const isRoomContextSenderAllowed = (contextSenderId?: string): boolean => {
    if (!isRoom || !contextSenderId) {
      return true;
    }
    if (effectiveRoomUsers.length > 0) {
      return resolveMatrixAllowListMatch({
        allowList: effectiveRoomUsers,
        userId: contextSenderId,
      }).allowed;
    }
    if (groupPolicy === "allowlist" && effectiveGroupAllowFrom.length > 0) {
      return resolveMatrixAllowListMatch({
        allowList: effectiveGroupAllowFrom,
        userId: contextSenderId,
      }).allowed;
    }
    return true;
  };
  const shouldIncludeRoomContextSender = (
    kind: "thread" | "quote" | "history",
    contextSenderId?: string,
  ): boolean =>
    evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind,
      senderAllowed: isRoomContextSenderAllowed(contextSenderId),
    }).include;
  let threadContext = threadRootId
    ? await resolveThreadContext({ roomId, threadRootId })
    : undefined;
  let threadContextBlockedByPolicy = false;
  if (
    threadContext?.senderId &&
    !shouldIncludeRoomContextSender("thread", threadContext.senderId)
  ) {
    logVerboseMessage(`matrix: drop thread root context (mode=${contextVisibilityMode})`);
    threadContextBlockedByPolicy = true;
    threadContext = undefined;
  }
  let replyContext: Awaited<ReturnType<typeof resolveReplyContext>> | undefined;
  if (replyToEventId && replyToEventId === threadRootId && threadContext?.summary) {
    replyContext = {
      replyToBody: threadContext.summary,
      replyToSender: threadContext.senderLabel,
      replyToSenderId: threadContext.senderId,
    };
  } else if (replyToEventId && replyToEventId === threadRootId && threadContextBlockedByPolicy) {
    replyContext = await resolveReplyContext({ roomId, eventId: replyToEventId });
  } else {
    replyContext = replyToEventId
      ? await resolveReplyContext({ roomId, eventId: replyToEventId })
      : undefined;
  }
  const replySenderAllowed =
    !replyContext?.replyToSenderId || isRoomContextSenderAllowed(replyContext.replyToSenderId);
  const roomInfo = isRoom ? await getRoomInfo(roomId) : undefined;
  const roomName = roomInfo?.name;
  const envelopeFrom = isDirectMessage ? senderName : (roomName ?? roomId);
  const textWithId = `${bodyText}\n[matrix event id: ${messageId} room: ${roomId}]`;
  const storePath = resolveStorePathImpl(cfg.session?.store, {
    agentId: _route.agentId,
  });
  const buildEnvelope = createChannelInboundEnvelopeBuilderImpl({ cfg, route: _route });
  const sharedDmNoticeSessionKey = threadTarget
    ? _route.mainSessionKey || _route.sessionKey
    : _route.sessionKey;
  const sharedDmContextNotice = isDirectMessage
    ? hasExplicitSessionBinding
      ? null
      : resolveMatrixSharedDmContextNotice({
          storePath,
          sessionKey: sharedDmNoticeSessionKey,
          roomId,
          accountId: _route.accountId,
          dmSessionScope,
          sentRooms: sharedDmContextNoticeRooms,
          logVerboseMessage,
        })
    : null;
  const body = buildEnvelope({
    channel: "Matrix",
    from: envelopeFrom,
    timestamp: eventTs ?? undefined,
    body: textWithId,
  });
  const groupSystemPrompt = normalizeOptionalString(roomConfig?.systemPrompt);
  const quoteHidden = Boolean(
    replyContext &&
    !evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind: "quote",
      senderAllowed: replySenderAllowed,
    }).include,
  );
  const ctxPayload = buildChannelInboundEventContext({
    channel: "matrix",
    contextVisibility: contextVisibilityMode,
    finalize: finalizeInboundContext,
    supplemental: {
      quote: replyContext
        ? {
            id: threadTarget ? undefined : (replyToEventId ?? undefined),
            body: replyContext.replyToBody,
            sender: replyContext.replyToSender,
            senderAllowed: replySenderAllowed,
          }
        : undefined,
      thread: {
        starterBody: threadContext?.threadStarterBody,
        senderAllowed: threadContext ? true : undefined,
      },
      groupSystemPrompt: isRoom ? groupSystemPrompt : undefined,
    },
    media: toInboundMediaFacts(
      media
        ? [
            {
              path: media.path,
              url: media.path,
              contentType: media.contentType,
              transcribed: preflightAudioTranscript !== undefined,
            },
          ]
        : undefined,
    ),
    messageId,
    timestamp: eventTs ?? undefined,
    from: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
    sender: {
      id: senderId,
      name: senderName,
      username: senderId.split(":")[0]?.replace(/^@/, ""),
    },
    conversation: {
      kind: isDirectMessage ? "direct" : "channel",
      id: roomId,
      label: envelopeFrom,
      nativeChannelId: roomId,
      threadId: threadTarget,
    },
    route: {
      agentId: _route.agentId,
      dmScope: _route.dmScope,
      accountId: _route.accountId,
      routeSessionKey: _route.sessionKey,
    },
    reply: {
      to: `room:${roomId}`,
      replyToId: threadTarget ? undefined : (replyToEventId ?? undefined),
      messageThreadId: threadTarget,
      nativeChannelId: roomId,
    },
    message: {
      body,
      rawBody: bodyText,
      commandBody: commandBodyText,
      bodyForAgent: bodyText,
      inboundHistory: inboundHistory && inboundHistory.length > 0 ? inboundHistory : undefined,
    },
    sessionTranscript: { historyLimit: isRoom ? historyLimit : 0 },
    access: {
      ...(isRoom
        ? {
            mentions: {
              canDetectMention: true,
              wasMentioned,
              requireMention: shouldRequireMention,
            },
          }
        : {}),
      commands: {
        authorized: commandAuthorized,
      },
    },
    extra: {
      GroupSubject: isRoom ? (roomName ?? roomId) : undefined,
      GroupId: isRoom ? roomId : undefined,
      GroupChannel: isRoom ? roomId : undefined,
      ...locationPayload?.context,
      CommandSource: "text" as const,
      NativeDirectUserId: isDirectMessage ? senderId : undefined,
    },
  });
  if (quoteHidden) {
    logVerboseMessage(`matrix: drop reply context (mode=${contextVisibilityMode})`);
  }

  const preview = truncateUtf16Safe(bodyText, 200).replace(/\n/g, "\\n");
  logVerboseMessage(`matrix inbound: room=${roomId} from=${senderId} preview="${preview}"`);

  const replyTarget = ctxPayload.To;
  if (!replyTarget) {
    runtime.error?.("matrix: missing reply target");
    return null;
  }

  const { ackReaction, ackReactionScope: ackScope } = resolveMatrixAckReactionConfig({
    cfg,
    agentId: _route.agentId,
    accountId,
  });
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      core.channel.reactions.shouldAckReaction({
        scope: ackScope,
        isDirect: isDirectMessage,
        isGroup: isRoom,
        isMentionableGroup: isRoom,
        requireMention: shouldRequireMention,
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
  if (shouldAckReaction() && messageId) {
    loadMatrixSendModule()
      .then(({ reactMatrixMessage }) => reactMatrixMessage(roomId, messageId, ackReaction, client))
      .catch((err: unknown) => {
        logVerboseMessage(`matrix react failed for room ${roomId}: ${String(err)}`);
      });
  }

  if (messageId) {
    loadMatrixSendModule()
      .then(({ sendReadReceiptMatrix }) => sendReadReceiptMatrix(roomId, messageId, client))
      .catch((err: unknown) => {
        logVerboseMessage(
          `matrix: read receipt failed room=${roomId} id=${messageId}: ${String(err)}`,
        );
      });
  }

  return {
    replyToEventId,
    threadTarget,
    storePath,
    ctxPayload,
    replyTarget,
    sharedDmContextNotice,
  };
}
