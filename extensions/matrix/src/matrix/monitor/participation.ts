import {
  createChannelParticipationCoordinator,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveMatrixMonitorAccessState } from "./access-state.js";
import { shouldDropMatrixPreStartupEvent } from "./handler-helpers.js";
import type { MatrixHandlerRuntimeConfig } from "./handler-types.js";
import { resolveMentions, stripMatrixMentionPrefix } from "./mentions.js";
import {
  isMatrixRoomEnabled,
  resolveMatrixRequireMention,
  resolveMatrixRoomConfigWithAliases,
} from "./rooms.js";
import { resolveMatrixInboundRoute } from "./route.js";
import { resolveMatrixThreadRouting } from "./threads.js";
import type { RoomMessageEventContent } from "./types.js";

type MatrixParticipationSource = {
  homeserver: string;
  roomId: string;
  eventId: string;
  senderId: string;
  eventTs?: number;
  eventAge?: number;
  threadRootId?: string;
  content: RoomMessageEventContent;
  message: string;
};

const coordinator = createChannelParticipationCoordinator<MatrixParticipationSource>({
  channel: "matrix",
});

export function registerMatrixParticipation(params: {
  handler: MatrixHandlerRuntimeConfig;
  resolveLiveAccountAllowlists: () => Promise<{
    liveDmAllowFrom: string[];
    liveGroupAllowFrom: string[];
  }>;
}): void {
  const { handler } = params;
  const participation = handler.participation;
  if (!participation) {
    return;
  }
  coordinator.register({
    accountId: handler.accountId,
    abortSignal: participation.abortSignal,
    prepare: async (source) => {
      const { roomId, senderId, content } = source;
      if (source.homeserver !== participation.homeserver) {
        return undefined;
      }
      const selfUserId = await handler.client.getUserId();
      // Targeting vetoes selection even when this account cannot otherwise answer.
      const thread = resolveMatrixThreadRouting({
        isDirectMessage: false,
        threadReplies: handler.threadReplies,
        messageId: source.eventId,
        threadRootId: source.threadRootId,
      });
      const { route, configuredBinding, runtimeBindingId } = resolveMatrixInboundRoute({
        cfg: handler.cfg,
        accountId: handler.accountId,
        roomId,
        senderId,
        isDirectMessage: false,
        threadId: thread.threadId,
        eventTs: source.eventTs,
        resolveAgentRoute: handler.core.channel.routing.resolveAgentRoute,
      });
      const mentionRegexes = handler.core.channel.mentions.buildMentionRegexes(
        handler.cfg,
        route.agentId,
        {
          provider: "matrix",
          conversationId: roomId,
          providerPolicy: handler.accountConfig?.mentionPatterns,
        },
      );
      const displayName = content.formatted_body
        ? await handler.getMemberDisplayName(roomId, selfUserId)
        : undefined;
      const mentions = resolveMentions({
        content,
        userId: selfUserId,
        displayName,
        text: source.message,
        mentionRegexes,
      });
      const commandText = stripMatrixMentionPrefix({
        text: source.message,
        userId: selfUserId,
        displayName,
        mentionRegexes,
      });
      if (
        mentions.wasMentioned ||
        handler.core.channel.text.hasControlCommand(commandText, handler.cfg)
      ) {
        return "bypass";
      }
      if (
        shouldDropMatrixPreStartupEvent({
          dropPreStartupMessages: handler.dropPreStartupMessages,
          eventTs: source.eventTs,
          eventAge: source.eventAge,
          startupMs: handler.startupMs,
          startupGraceMs: handler.startupGraceMs,
        }) ||
        handler.groupPolicy === "disabled" ||
        handler.configuredBotUserIds.has(senderId) ||
        !(await handler.client.isSyncedUnencryptedRoom(roomId))
      ) {
        return undefined;
      }
      if (
        senderId === selfUserId ||
        !handler.client.hasSyncedJoinedRoomMember(roomId, selfUserId) ||
        !handler.client.hasSyncedJoinedRoomMember(roomId, senderId)
      ) {
        return undefined;
      }
      const direct = await participation.observeDirectMessage({
        roomId,
        senderId,
        selfUserId,
      });
      if (direct === undefined) {
        return "bypass";
      }
      if (direct) {
        return undefined;
      }
      const roomConfig = await resolveMatrixRoomConfigWithAliases({
        rooms: handler.roomsConfig,
        roomId,
        needsAliases: handler.needsRoomAliasesForConfig,
        getRoomInfo: handler.getRoomInfo,
      });
      if (!isMatrixRoomEnabled({ groupPolicy: handler.groupPolicy, roomConfig })) {
        return undefined;
      }
      const { liveDmAllowFrom, liveGroupAllowFrom } = await params.resolveLiveAccountAllowlists();
      const access = await resolveMatrixMonitorAccessState({
        allowFrom: liveDmAllowFrom,
        storeAllowFrom: [],
        groupPolicy: handler.groupPolicy,
        groupAllowFrom: liveGroupAllowFrom,
        roomUsers: roomConfig.config?.users ?? [],
        senderId,
        isRoom: true,
        accountId: handler.accountId,
        conversationId: roomId,
      });
      if (access.messageIngress.ingress.decision !== "allow") {
        return undefined;
      }
      if (configuredBinding || runtimeBindingId) {
        return undefined;
      }
      const activation = resolveInboundMentionDecision({
        facts: {
          canDetectMention: true,
          wasMentioned: mentions.wasMentioned,
          hasAnyMention: mentions.hasExplicitMention,
        },
        policy: {
          isGroup: true,
          requireMention: resolveMatrixRequireMention(roomConfig.config),
          allowTextCommands: false,
          hasControlCommand: false,
          commandAuthorized: false,
        },
      });
      return activation.shouldSkip
        ? undefined
        : {
            accountId: handler.accountId,
            agentId: route.agentId,
            participantId: selfUserId,
            name: handler.accountConfig?.name,
            alreadyHandled: await participation.hasRecent({ roomId, eventId: source.eventId }),
          };
    },
  });
}

export async function shouldSuppressMatrixParticipation(
  accountId: string,
  source: MatrixParticipationSource,
): Promise<boolean> {
  return (
    (await coordinator.decide({
      accountId,
      eventKey: JSON.stringify([
        source.homeserver,
        source.roomId,
        source.threadRootId ?? null,
        source.eventId,
      ]),
      source,
      message: source.message,
      conversationId: source.roomId,
    })) === "suppress"
  );
}
