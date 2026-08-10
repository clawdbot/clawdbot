import type { ChannelBotLoopProtectionFacts } from "openclaw/plugin-sdk/channel-inbound";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { resolveMatrixMonitorAccessState } from "./access-state.js";
import { resolveMatrixAllowBotsMode } from "./handler-helpers.js";
import { loadMatrixReactionEvents, loadMatrixSendModule } from "./handler-runtime.js";
import type { MatrixHandlerRuntimeConfig } from "./handler-types.js";
import type { MatrixLocationPayload } from "./location.js";
import type { ReservedHistorySlot } from "./room-history.js";
import { createRoomHistoryTracker } from "./room-history.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadRouting } from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";

export type MatrixIngressAccessParams = {
  audioPreflightMode?: "defer" | "run";
  content: RoomMessageEventContent;
  isDirectMessage: boolean;
  locationPayload: MatrixLocationPayload | null;
  selfUserId: string;
  reservedHistorySlot?: ReservedHistorySlot;
};

export async function resolveMatrixIngressAccess(config: {
  handler: MatrixHandlerRuntimeConfig;
  params: MatrixIngressAccessParams;
  roomId: string;
  event: MatrixRawEvent;
  eventTs?: number;
  senderId: string;
  isReactionEvent: boolean;
  readStoreAllowFrom: () => Promise<string[]>;
  shouldSendPairingReply: (senderId: string, created: boolean) => boolean;
  resolveLiveAccountAllowlists: () => Promise<{
    liveDmAllowFrom: string[];
    liveGroupAllowFrom: string[];
  }>;
  roomHistoryTracker: ReturnType<typeof createRoomHistoryTracker>;
  commitInboundEventIfClaimed: () => Promise<void>;
}) {
  const {
    handler,
    params: paramsLocal,
    roomId,
    event,
    eventTs,
    senderId,
    isReactionEvent,
    readStoreAllowFrom,
    shouldSendPairingReply,
    resolveLiveAccountAllowlists,
    roomHistoryTracker,
    commitInboundEventIfClaimed,
  } = config;
  const {
    core,
    cfg,
    accountId,
    accountConfig,
    client,
    logVerboseMessage,
    groupPolicy,
    dmEnabled,
    dmPolicy,
    dmThreadReplies,
    threadReplies,
    roomsConfig,
    accountAllowBots,
    configuredBotUserIds,
    needsRoomAliasesForConfig,
    getRoomInfo,
    getMemberDisplayName,
  } = handler;

  const content = paramsLocal.content;
  const isDirectMessage = paramsLocal.isDirectMessage;
  const isRoom = !isDirectMessage;
  const { audioPreflightMode, locationPayload, reservedHistorySlot, selfUserId } = paramsLocal;
  const messageId = event.event_id ?? "";
  const threadRootId = resolveMatrixThreadRootId({ event, content });
  const thread = resolveMatrixThreadRouting({
    isDirectMessage,
    threadReplies,
    dmThreadReplies,
    messageId,
    threadRootId,
  });
  const historyThreadId = threadRootId ? thread.threadId : undefined;
  let reservedHistorySlotConsumed = false;
  const discardReservedHistorySlot = () => {
    if (reservedHistorySlot && !reservedHistorySlotConsumed) {
      roomHistoryTracker.discardPending(roomId, reservedHistorySlot, historyThreadId);
      reservedHistorySlotConsumed = true;
    }
  };
  const markReservedHistorySlotConsumed = () => {
    reservedHistorySlotConsumed = true;
  };
  const commitInboundEventIfClaimedAndDiscardReserved = async () => {
    discardReservedHistorySlot();
    await commitInboundEventIfClaimed();
  };
  if (isRoom && groupPolicy === "disabled") {
    await commitInboundEventIfClaimedAndDiscardReserved();
    return undefined;
  }

  const roomInfoForConfig =
    isRoom && needsRoomAliasesForConfig
      ? await getRoomInfo(roomId, { includeAliases: true })
      : undefined;
  const roomAliasesForConfig = roomInfoForConfig
    ? [roomInfoForConfig.canonicalAlias ?? "", ...roomInfoForConfig.altAliases].filter(Boolean)
    : [];
  const roomConfigInfo = isRoom
    ? resolveMatrixRoomConfig({
        rooms: roomsConfig,
        roomId,
        aliases: roomAliasesForConfig,
      })
    : undefined;
  const roomConfig = roomConfigInfo?.config;
  const allowBotsMode = resolveMatrixAllowBotsMode(roomConfig?.allowBots ?? accountAllowBots);
  const isConfiguredBotSender = configuredBotUserIds.has(senderId);
  const roomMatchMeta = roomConfigInfo
    ? `matchKey=${roomConfigInfo.matchKey ?? "none"} matchSource=${
        roomConfigInfo.matchSource ?? "none"
      }`
    : "matchKey=none matchSource=none";

  if (isConfiguredBotSender && allowBotsMode === "off") {
    logVerboseMessage(
      `matrix: drop configured bot sender=${senderId} (allowBots=false${isDirectMessage ? "" : `, ${roomMatchMeta}`})`,
    );
    await commitInboundEventIfClaimedAndDiscardReserved();
    return undefined;
  }
  const botLoopProtection: ChannelBotLoopProtectionFacts | undefined =
    isConfiguredBotSender && senderId !== selfUserId
      ? {
          scopeId: accountId,
          conversationId: roomId,
          senderId,
          receiverId: selfUserId,
          config: mergePairLoopGuardConfig(
            accountConfig?.botLoopProtection,
            roomConfig?.botLoopProtection,
          ),
          defaultsConfig: cfg.channels?.defaults?.botLoopProtection,
          defaultEnabled: true,
          nowMs: eventTs ?? undefined,
        }
      : undefined;

  if (isRoom && roomConfig && !roomConfigInfo?.allowed) {
    logVerboseMessage(`matrix: room disabled room=${roomId} (${roomMatchMeta})`);
    await commitInboundEventIfClaimedAndDiscardReserved();
    return undefined;
  }
  if (isRoom && groupPolicy === "allowlist") {
    if (!roomConfigInfo?.allowlistConfigured) {
      logVerboseMessage(`matrix: drop room message (no allowlist, ${roomMatchMeta})`);
      await commitInboundEventIfClaimedAndDiscardReserved();
      return undefined;
    }
    if (!roomConfig) {
      logVerboseMessage(`matrix: drop room message (not in allowlist, ${roomMatchMeta})`);
      await commitInboundEventIfClaimedAndDiscardReserved();
      return undefined;
    }
  }

  let senderNamePromise: Promise<string> | null = null;
  const getSenderName = async (): Promise<string> => {
    senderNamePromise ??= getMemberDisplayName(roomId, senderId).catch(() => senderId);
    return await senderNamePromise;
  };
  const storeAllowFrom =
    isDirectMessage && dmPolicy !== "allowlist" && dmPolicy !== "open"
      ? await readStoreAllowFrom()
      : [];
  const roomUsers = roomConfig?.users ?? [];
  const { liveDmAllowFrom, liveGroupAllowFrom } = await resolveLiveAccountAllowlists();
  const accessState = await resolveMatrixMonitorAccessState({
    allowFrom: liveDmAllowFrom,
    storeAllowFrom,
    dmPolicy,
    groupPolicy,
    groupAllowFrom: liveGroupAllowFrom,
    roomUsers,
    senderId,
    isRoom,
    accountId,
    eventKind: isReactionEvent ? "reaction" : "message",
  });
  const { effectiveGroupAllowFrom, effectiveRoomUsers, messageIngress } = accessState;
  const ingressDecision = messageIngress.ingress;

  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      await commitInboundEventIfClaimedAndDiscardReserved();
      return undefined;
    }
    const senderReason = messageIngress.senderAccess.reasonCode;
    if (ingressDecision.decision !== "allow") {
      if (ingressDecision.admission === "pairing-required") {
        const senderName = await getSenderName();
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "matrix",
          id: senderId,
          accountId,
          meta: { name: senderName },
        });
        if (shouldSendPairingReply(senderId, created)) {
          const pairingReply = core.channel.pairing.buildPairingReply({
            channel: "matrix",
            idLine: `Your Matrix user id: ${senderId}`,
            code,
          });
          logVerboseMessage(
            created
              ? `matrix pairing request sender=${senderId} name=${senderName ?? "unknown"} (reason=${senderReason})`
              : `matrix pairing reminder sender=${senderId} name=${senderName ?? "unknown"} (reason=${senderReason})`,
          );
          try {
            const { sendMessageMatrix } = await loadMatrixSendModule();
            await sendMessageMatrix(
              `room:${roomId}`,
              created
                ? pairingReply
                : `${pairingReply}\n\nPairing request is still pending approval. Reusing existing code.`,
              {
                client,
                cfg,
                accountId,
              },
            );
            await commitInboundEventIfClaimed();
          } catch (err) {
            logVerboseMessage(`matrix pairing reply failed for ${senderId}: ${String(err)}`);
            discardReservedHistorySlot();
            return undefined;
          }
        } else {
          logVerboseMessage(`matrix pairing reminder suppressed sender=${senderId} (cooldown)`);
          await commitInboundEventIfClaimedAndDiscardReserved();
        }
      }
      if (isReactionEvent || dmPolicy !== "pairing") {
        logVerboseMessage(
          `matrix: blocked ${isReactionEvent ? "reaction" : "dm"} sender ${senderId} (dmPolicy=${dmPolicy}, reason=${senderReason})`,
        );
        await commitInboundEventIfClaimedAndDiscardReserved();
      }
      return undefined;
    }
  }

  if (isRoom && ingressDecision.decision !== "allow") {
    logVerboseMessage(
      `matrix: blocked sender ${senderId} (ingress=${ingressDecision.reasonCode}, ${roomMatchMeta})`,
    );
    await commitInboundEventIfClaimedAndDiscardReserved();
    return undefined;
  }
  if (isRoom) {
    logVerboseMessage(`matrix: allow room ${roomId} (${roomMatchMeta})`);
  }

  if (isReactionEvent) {
    const senderName = await getSenderName();
    const { handleInboundMatrixReaction } = await loadMatrixReactionEvents();
    await handleInboundMatrixReaction({
      client,
      core,
      cfg,
      accountId,
      roomId,
      event,
      senderId,
      senderLabel: senderName,
      selfUserId,
      isDirectMessage,
      logVerboseMessage,
    });
    await commitInboundEventIfClaimedAndDiscardReserved();
    return undefined;
  }

  return {
    content,
    messageId,
    audioPreflightMode,
    isDirectMessage,
    isRoom,
    locationPayload,
    reservedHistorySlot,
    threadRootId,
    thread,
    historyThreadId,
    discardReservedHistorySlot,
    markReservedHistorySlotConsumed,
    commitInboundEventIfClaimedAndDiscardReserved,
    roomConfig,
    allowBotsMode,
    isConfiguredBotSender,
    selfUserId,
    botLoopProtection,
    roomMatchMeta,
    getSenderName,
    accessState,
    effectiveGroupAllowFrom,
    effectiveRoomUsers,
  };
}

export type MatrixIngressAccessResult = NonNullable<
  Awaited<ReturnType<typeof resolveMatrixIngressAccess>>
>;
