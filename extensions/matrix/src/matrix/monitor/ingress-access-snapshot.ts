import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { createMatrixContextVisibility, resolveMatrixMonitorAccessState } from "./access-state.js";
import { resolveMatrixAllowBotsMode } from "./handler-helpers.js";
import type { MatrixHandlerRuntimeConfig } from "./handler-types.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixInboundRoute } from "./route.js";
import { resolveMatrixThreadRouting } from "./threads.js";
import type { MatrixReceiverAccessInput } from "./turn-taking-coordinator-types.js";

export async function prepareMatrixIngressAccessSnapshot(input: {
  handler: MatrixHandlerRuntimeConfig;
  roomId: string;
  senderId: string;
  isDirectMessage: boolean;
  trustedEnhancedFinal: boolean;
  isReactionEvent?: boolean;
  readStoreAllowFrom: () => Promise<string[]>;
  resolveLiveAccountAllowlists: () => Promise<{
    liveDmAllowFrom: string[];
    liveGroupAllowFrom: string[];
  }>;
}) {
  const { handler, roomId, senderId, isDirectMessage, trustedEnhancedFinal } = input;
  const { groupPolicy, dmPolicy } = handler;
  const isRoom = !isDirectMessage;
  const roomInfo =
    (isRoom && handler.needsRoomAliasesForConfig) || handler.needsRoomAliasesForTurnTakingConfig
      ? await handler.getRoomInfo(roomId, { includeAliases: true })
      : undefined;
  const aliases = roomInfo
    ? [roomInfo.canonicalAlias ?? "", ...roomInfo.altAliases].filter(Boolean)
    : [];
  const roomConfigInfo = isRoom
    ? resolveMatrixRoomConfig({ rooms: handler.roomsConfig, roomId, aliases })
    : undefined;
  const roomConfig = roomConfigInfo?.config;
  const turnTakingDisabled =
    resolveMatrixRoomConfig({ rooms: handler.turnTakingRoomsConfig, roomId, aliases }).config
      ?.turnTaking === false;
  const allowBotsMode = resolveMatrixAllowBotsMode(
    roomConfig?.allowBots ?? handler.accountAllowBots,
  );
  const isConfiguredBotSender = handler.configuredBotUserIds.has(senderId) || trustedEnhancedFinal;
  const botBlocked = isConfiguredBotSender && allowBotsMode === "off" && !trustedEnhancedFinal;
  const roomMatchMeta = roomConfigInfo
    ? `matchKey=${roomConfigInfo.matchKey ?? "none"} matchSource=${roomConfigInfo.matchSource ?? "none"}`
    : "matchKey=none matchSource=none";
  const roomBlock = isDirectMessage
    ? !handler.dmEnabled || dmPolicy === "disabled"
      ? "dm-disabled"
      : undefined
    : groupPolicy === "disabled"
      ? "group-disabled"
      : roomConfig && !roomConfigInfo?.allowed
        ? "room-disabled"
        : groupPolicy === "allowlist" && !roomConfigInfo?.allowlistConfigured
          ? "no-allowlist"
          : groupPolicy === "allowlist" && !roomConfig
            ? "not-in-allowlist"
            : undefined;
  const storeAllowFrom =
    isDirectMessage && dmPolicy !== "allowlist" && dmPolicy !== "open"
      ? await input.readStoreAllowFrom()
      : [];
  const { liveDmAllowFrom, liveGroupAllowFrom } = await input.resolveLiveAccountAllowlists();
  const accessState = await resolveMatrixMonitorAccessState({
    allowFrom: liveDmAllowFrom,
    storeAllowFrom,
    dmPolicy,
    groupPolicy,
    groupAllowFrom: liveGroupAllowFrom,
    roomUsers: roomConfig?.users ?? [],
    senderId,
    isRoom,
    conversationId: roomId,
    accountId: handler.accountId,
    eventKind: input.isReactionEvent ? "reaction" : "message",
  });
  const contextVisibility = createMatrixContextVisibility({
    isRoom,
    groupPolicy,
    effectiveGroupAllowFrom: accessState.effectiveGroupAllowFrom,
    effectiveRoomUsers: accessState.effectiveRoomUsers,
    mode: resolveChannelContextVisibilityMode({
      cfg: handler.cfg,
      channel: "matrix",
      accountId: handler.accountId,
    }),
  });
  return {
    accessState,
    roomConfig,
    roomBlock,
    roomMatchMeta,
    turnTakingDisabled,
    allowBotsMode,
    isConfiguredBotSender,
    botBlocked,
    canParticipate:
      !roomBlock && !botBlocked && accessState.messageIngress.ingress.decision === "allow",
    includesContext: (contextSenderId: string) =>
      !roomBlock && !turnTakingDisabled && contextVisibility.include("history", contextSenderId),
  };
}

export function createMatrixReceiverAccessPreparer(
  handler: MatrixHandlerRuntimeConfig,
  readers: Pick<
    Parameters<typeof prepareMatrixIngressAccessSnapshot>[0],
    "readStoreAllowFrom" | "resolveLiveAccountAllowlists"
  >,
) {
  return async (input: MatrixReceiverAccessInput) => {
    const selfUserId = await handler.client.getUserId();
    const isDirectMessage = await handler.directTracker.isDirectMessage({
      roomId: input.roomId,
      senderId: input.senderId,
      selfUserId,
    });
    const snapshot = await prepareMatrixIngressAccessSnapshot({
      handler,
      roomId: input.roomId,
      senderId: input.senderId,
      isDirectMessage,
      trustedEnhancedFinal: input.trustedEnhancedFinal === true,
      readStoreAllowFrom: readers.readStoreAllowFrom,
      resolveLiveAccountAllowlists: readers.resolveLiveAccountAllowlists,
    });
    const thread = resolveMatrixThreadRouting({
      isDirectMessage,
      threadReplies: handler.threadReplies,
      dmThreadReplies: handler.dmThreadReplies,
      messageId: input.eventId ?? "",
      threadRootId: input.threadId,
    });
    const { route } = resolveMatrixInboundRoute({
      cfg: handler.cfg,
      accountId: handler.accountId,
      roomId: input.roomId,
      senderId: input.senderId,
      isDirectMessage,
      dmSessionScope: handler.dmSessionScope,
      threadId: thread.threadId,
      eventTs: input.eventTs,
      resolveAgentRoute: handler.core.channel.routing.resolveAgentRoute,
    });
    return {
      agentId: route.agentId,
      canParticipate:
        snapshot.canParticipate && !snapshot.turnTakingDisabled && input.senderId !== selfUserId,
      includesContext: snapshot.includesContext,
    };
  };
}
