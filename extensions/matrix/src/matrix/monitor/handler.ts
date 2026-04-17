import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import {
  loadSessionStore,
  resolveChannelContextVisibilityMode,
  resolveSessionStoreEntry,
} from "openclaw/plugin-sdk/config-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  CoreConfig,
  MatrixRoomConfig,
  MatrixStreamingMode,
  ReplyToMode,
} from "../../types.js";
import { createMatrixDraftStream } from "../draft-stream.js";
import { formatMatrixErrorMessage } from "../errors.js";
import { isMatrixMediaSizeLimitError } from "../media-errors.js";
import {
  formatMatrixMediaTooLargeText,
  formatMatrixMediaUnavailableText,
  formatMatrixMessageText,
  resolveMatrixMessageAttachment,
  resolveMatrixMessageBody,
} from "../media-text.js";
import { fetchMatrixPollSnapshot, type MatrixPollSnapshot } from "../poll-summary.js";
import {
  formatPollAsText,
  isPollEventType,
  isPollStartType,
  parsePollStartContent,
} from "../poll-types.js";
import type { LocationMessageEventContent, MatrixClient } from "../sdk.js";
import {
  editMessageMatrix,
  reactMatrixMessage,
  sendMessageMatrix,
  sendReadReceiptMatrix,
  sendTypingMatrix,
} from "../send.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import { resolveMatrixStoredSessionMeta } from "../session-store-metadata.js";
import { resolveMatrixMonitorAccessState } from "./access-state.js";
import { resolveMatrixAckReactionConfig } from "./ack-config.js";
import { resolveMatrixAllowListMatch } from "./allowlist.js";
import type { MatrixInboundEventDeduper } from "./inbound-dedupe.js";
import { resolveMatrixLocation, type MatrixLocationPayload } from "./location.js";
import { downloadMatrixMedia } from "./media.js";
import { resolveMentions } from "./mentions.js";
import { handleInboundMatrixReaction } from "./reaction-events.js";
import { deliverMatrixReplies } from "./replies.js";
import { createMatrixReplyContextResolver } from "./reply-context.js";
import { createRoomHistoryTracker } from "./room-history.js";
import type { HistoryEntry } from "./room-history.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixInboundRoute } from "./route.js";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  ensureConfiguredAcpBindingReady,
  formatAllowlistMatchMeta,
  getAgentScopedMediaLocalRoots,
  logInboundDrop,
  logTypingFailure,
  type BlockReplyContext,
  type PluginRuntime,
  type ReplyPayload,
  type RuntimeEnv,
  type RuntimeLogger,
} from "./runtime-api.js";
import { createMatrixThreadContextResolver } from "./thread-context.js";
import {
  resolveMatrixReplyToEventId,
  resolveMatrixThreadRootId,
  resolveMatrixThreadRouting,
} from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { EventType, RelationType } from "./types.js";
import { isMatrixVerificationRoomMessage } from "./verification-utils.js";

const ALLOW_FROM_STORE_CACHE_TTL_MS = 30_000;
const PAIRING_REPLY_COOLDOWN_MS = 5 * 60_000;
const MAX_TRACKED_PAIRING_REPLY_SENDERS = 512;
const MAX_TRACKED_SHARED_DM_CONTEXT_NOTICES = 512;
type MatrixAllowBotsMode = "off" | "mentions" | "all";

export class MatrixRetryableInboundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MatrixRetryableInboundError";
  }
}

async function redactMatrixDraftEvent(
  client: MatrixClient,
  roomId: string,
  draftEventId: string,
): Promise<void> {
  await client.redactEvent(roomId, draftEventId).catch(() => {});
}

function buildMatrixFinalizedPreviewContent(): Record<string, unknown> {
  return { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true };
}

export type MatrixMonitorHandlerParams = {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  accountId: string;
  runtime: RuntimeEnv;
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
  allowFrom: string[];
  groupAllowFrom?: string[];
  roomsConfig?: Record<string, MatrixRoomConfig>;
  accountAllowBots?: boolean | "mentions";
  configuredBotUserIds?: ReadonlySet<string>;
  groupPolicy: "open" | "allowlist" | "disabled";
  replyToMode: ReplyToMode;
  threadReplies: "off" | "inbound" | "always";
  /** DM-specific threadReplies override. Falls back to threadReplies when absent. */
  dmThreadReplies?: "off" | "inbound" | "always";
  /** DM session grouping behavior. */
  dmSessionScope?: "per-user" | "per-room";
  streaming: MatrixStreamingMode;
  blockStreamingEnabled: boolean;
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  textLimit: number;
  mediaMaxBytes: number;
  historyLimit: number;
  startupMs: number;
  startupGraceMs: number;
  dropPreStartupMessages: boolean;
  inboundDeduper?: Pick<MatrixInboundEventDeduper, "claimEvent" | "commitEvent" | "releaseEvent">;
  directTracker: {
    isDirectMessage: (params: {
      roomId: string;
      senderId: string;
      selfUserId: string;
    }) => Promise<boolean>;
  };
  getRoomInfo: (
    roomId: string,
    opts?: { includeAliases?: boolean },
  ) => Promise<{ name?: string; canonicalAlias?: string; altAliases: string[] }>;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  needsRoomAliasesForConfig: boolean;
};

function resolveMatrixMentionPrecheckText(params: {
  eventType: string;
  content: RoomMessageEventContent;
  locationText?: string | null;
}): string {
  if (params.locationText?.trim()) {
    return params.locationText.trim();
  }
  if (typeof params.content.body === "string" && params.content.body.trim()) {
    return params.content.body.trim();
  }
  if (isPollStartType(params.eventType)) {
    const parsed = parsePollStartContent(params.content as never);
    if (parsed) {
      return formatPollAsText(parsed);
    }
  }
  return "";
}

function hasBundledMatrixReplacementRelation(event: MatrixRawEvent) {
  const relations = event.unsigned?.["m.relations"];
  if (!relations || typeof relations !== "object") {
    return false;
  }
  return relations[RelationType.Replace] !== undefined;
}

function resolveMatrixInboundBodyText(params: {
  rawBody: string;
  filename?: string;
  mediaPlaceholder?: string;
  msgtype?: string;
  hadMediaUrl: boolean;
  mediaDownloadFailed: boolean;
  mediaSizeLimitExceeded?: boolean;
}): string {
  if (params.mediaPlaceholder) {
    return params.rawBody || params.mediaPlaceholder;
  }
  if (!params.mediaDownloadFailed || !params.hadMediaUrl) {
    return params.rawBody;
  }
  if (params.mediaSizeLimitExceeded) {
    return formatMatrixMediaTooLargeText({
      body: params.rawBody,
      filename: params.filename,
      msgtype: params.msgtype,
    });
  }
  return formatMatrixMediaUnavailableText({
    body: params.rawBody,
    filename: params.filename,
    msgtype: params.msgtype,
  });
}

function markTrackedRoomIfFirst(set: Set<string>, roomId: string): boolean {
  if (set.has(roomId)) {
    return false;
  }
  set.add(roomId);
  if (set.size > MAX_TRACKED_SHARED_DM_CONTEXT_NOTICES) {
    const oldest = set.keys().next().value;
    if (typeof oldest === "string") {
      set.delete(oldest);
    }
  }
  return true;
}

function resolveMatrixSharedDmContextNotice(params: {
  storePath: string;
  sessionKey: string;
  roomId: string;
  accountId: string;
  dmSessionScope?: "per-user" | "per-room";
  sentRooms: Set<string>;
  logVerboseMessage: (message: string) => void;
}): string | null {
  if ((params.dmSessionScope ?? "per-user") === "per-room") {
    return null;
  }
  if (params.sentRooms.has(params.roomId)) {
    return null;
  }

  try {
    const store = loadSessionStore(params.storePath);
    const currentSession = resolveMatrixStoredSessionMeta(
      resolveSessionStoreEntry({
        store,
        sessionKey: params.sessionKey,
      }).existing,
    );
    if (!currentSession) {
      return null;
    }
    if (currentSession.channel && currentSession.channel !== "matrix") {
      return null;
    }
    if (currentSession.accountId && currentSession.accountId !== params.accountId) {
      return null;
    }
    if (!currentSession.directUserId) {
      return null;
    }
    if (!currentSession.roomId || currentSession.roomId === params.roomId) {
      return null;
    }

    return [
      "This Matrix DM is sharing a session with another Matrix DM room.",
      "Use /focus here for a one-off isolated thread session when thread bindings are enabled, or set",
      "channels.matrix.dm.sessionScope to per-room to isolate each Matrix DM room.",
    ].join(" ");
  } catch (err) {
    params.logVerboseMessage(
      `matrix: failed checking shared DM session notice room=${params.roomId} (${String(err)})`,
    );
    return null;
  }
}

function resolveMatrixPendingHistoryText(params: {
  mentionPrecheckText: string;
  content: RoomMessageEventContent;
  mediaUrl?: string;
}): string {
  if (params.mentionPrecheckText) {
    return params.mentionPrecheckText;
  }
  if (!params.mediaUrl) {
    return "";
  }
  const body = typeof params.content.body === "string" ? params.content.body.trim() : undefined;
  const filename =
    typeof params.content.filename === "string" ? params.content.filename.trim() : undefined;
  const msgtype = typeof params.content.msgtype === "string" ? params.content.msgtype : undefined;
  return (
    formatMatrixMessageText({
      body: resolveMatrixMessageBody({ body, filename, msgtype }),
      attachment: resolveMatrixMessageAttachment({ body, filename, msgtype }),
    }) ?? ""
  );
}

function resolveMatrixAllowBotsMode(value?: boolean | "mentions"): MatrixAllowBotsMode {
  if (value === true) {
    return "all";
  }
  if (value === "mentions") {
    return "mentions";
  }
  return "off";
}

export function createMatrixRoomMessageHandler(params: MatrixMonitorHandlerParams) {
  const {
    client,
    core,
    cfg,
    accountId,
    runtime,
    logger,
    logVerboseMessage,
    allowFrom,
    groupAllowFrom = [],
    roomsConfig,
    accountAllowBots,
    configuredBotUserIds = new Set<string>(),
    groupPolicy,
    replyToMode,
    threadReplies,
    dmThreadReplies,
    dmSessionScope,
    streaming,
    blockStreamingEnabled,
    dmEnabled,
    dmPolicy,
    textLimit,
    mediaMaxBytes,
    historyLimit,
    startupMs,
    startupGraceMs,
    dropPreStartupMessages,
    inboundDeduper,
    directTracker,
    getRoomInfo,
    getMemberDisplayName,
    needsRoomAliasesForConfig,
  } = params;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "matrix",
    accountId,
  });
  let cachedStoreAllowFrom: {
    value: string[];
    expiresAtMs: number;
  } | null = null;
  const pairingReplySentAtMsBySender = new Map<string, number>();
  const resolveThreadContext = createMatrixThreadContextResolver({
    client,
    getMemberDisplayName,
    logVerboseMessage,
  });
  const resolveReplyContext = createMatrixReplyContextResolver({
    client,
    getMemberDisplayName,
    logVerboseMessage,
  });
  const roomHistoryTracker = createRoomHistoryTracker();
  const roomIngressTails = new Map<string, Promise<void>>();
  const sharedDmContextNoticeRooms = new Set<string>();

  const readStoreAllowFrom = async (): Promise<string[]> => {
    const now = Date.now();
    if (cachedStoreAllowFrom && now < cachedStoreAllowFrom.expiresAtMs) {
      return cachedStoreAllowFrom.value;
    }
    const value = await core.channel.pairing
      .readAllowFromStore({
        channel: "matrix",
        env: process.env,
        accountId,
      })
      .catch(() => []);
    cachedStoreAllowFrom = {
      value,
      expiresAtMs: now + ALLOW_FROM_STORE_CACHE_TTL_MS,
    };
    return value;
  };

  const shouldSendPairingReply = (senderId: string, created: boolean): boolean => {
    const now = Date.now();
    if (created) {
      pairingReplySentAtMsBySender.set(senderId, now);
      return true;
    }
    const lastSentAtMs = pairingReplySentAtMsBySender.get(senderId);
    if (typeof lastSentAtMs === "number" && now - lastSentAtMs < PAIRING_REPLY_COOLDOWN_MS) {
      return false;
    }
    pairingReplySentAtMsBySender.set(senderId, now);
    if (pairingReplySentAtMsBySender.size > MAX_TRACKED_PAIRING_REPLY_SENDERS) {
      const oldestSender = pairingReplySentAtMsBySender.keys().next().value;
      if (typeof oldestSender === "string") {
        pairingReplySentAtMsBySender.delete(oldestSender);
      }
    }
    return true;
  };

  const runRoomIngress = async <T>(roomId: string, task: () => Promise<T>): Promise<T> => {
    const previous = roomIngressTails.get(roomId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chain = previous.catch(() => {}).then(() => current);
    roomIngressTails.set(roomId, chain);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      releaseCurrent();
      if (roomIngressTails.get(roomId) === chain) {
        roomIngressTails.delete(roomId);
      }
    }
  };

  return async (roomId: string, event: MatrixRawEvent) => {
    const eventId = typeof event.event_id === "string" ? event.event_id.trim() : "";
    let claimedInboundEvent = false;
    let draftStreamRef: ReturnType<typeof createMatrixDraftStream> | undefined;
    let draftConsumed = false;
    try {
      const eventType = event.type;
      if (eventType === EventType.RoomMessageEncrypted) {
        // Encrypted payloads are emitted separately after decryption.
        return;
      }

      const isPollEvent = isPollEventType(eventType);
      const isReactionEvent = eventType === EventType.Reaction;
      const locationContent = event.content as LocationMessageEventContent;
      const isLocationEvent =
        eventType === EventType.Location ||
        (eventType === EventType.RoomMessage && locationContent.msgtype === EventType.Location);
      if (
        eventType !== EventType.RoomMessage &&
        !isPollEvent &&
        !isLocationEvent &&
        !isReactionEvent
      ) {
        return;
      }
      logVerboseMessage(
        `matrix: inbound event room=${roomId} type=${eventType} id=${event.event_id ?? "unknown"}`,
      );
      if (event.unsigned?.redacted_because) {
        return;
      }
      const senderId = event.sender;
      if (!senderId) {
        return;
      }
      const eventTs = event.origin_server_ts;
      const eventAge = event.unsigned?.age;
      const commitInboundEventIfClaimed = async () => {
        if (!claimedInboundEvent || !inboundDeduper || !eventId) {
          return;
        }
        await inboundDeduper.commitEvent({ roomId, eventId });
        claimedInboundEvent = false;
      };
      const readIngressPrefix = async () => {
        const selfUserId = await client.getUserId();
        if (senderId === selfUserId) {
          return undefined;
        }
        if (dropPreStartupMessages) {
          if (typeof eventTs === "number" && eventTs < startupMs - startupGraceMs) {
            return undefined;
          }
          if (
            typeof eventTs !== "number" &&
            typeof eventAge === "number" &&
            eventAge > startupGraceMs
          ) {
            return undefined;
          }
        }

        let content = event.content as RoomMessageEventContent;

        if (
          eventType === EventType.RoomMessage &&
          isMatrixVerificationRoomMessage({
            msgtype: (content as { msgtype?: unknown }).msgtype,
            body: content.body,
          })
        ) {
          logVerboseMessage(`matrix: skip verification/system room message room=${roomId}`);
          return undefined;
        }

        const locationPayload: MatrixLocationPayload | null = resolveMatrixLocation({
          eventType,
          content: content as LocationMessageEventContent,
        });

        const relates = content["m.relates_to"];
        if (relates && "rel_type" in relates && relates.rel_type === RelationType.Replace) {
          return undefined;
        }
        if (hasBundledMatrixReplacementRelation(event)) {
          return undefined;
        }
        if (eventId && inboundDeduper) {
          claimedInboundEvent = inboundDeduper.claimEvent({ roomId, eventId });
          if (!claimedInboundEvent) {
            logVerboseMessage(`matrix: skip duplicate inbound event room=${roomId} id=${eventId}`);
            return undefined;
          }
        }

        const isDirectMessage = await directTracker.isDirectMessage({
          roomId,
          senderId,
          selfUserId,
        });
        return { content, isDirectMessage, locationPayload, selfUserId };
      };
      const continueIngress = async (params: {
        content: RoomMessageEventContent;
        isDirectMessage: boolean;
        locationPayload: MatrixLocationPayload | null;
        selfUserId: string;
      }) => {
        let content = params.content;
        const isDirectMessage = params.isDirectMessage;
        const isRoom = !isDirectMessage;
        const { locationPayload, selfUserId } = params;
        if (isRoom && groupPolicy === "disabled") {
          await commitInboundEventIfClaimed();
          return undefined;
        }

        const roomInfoForConfig =
          isRoom && needsRoomAliasesForConfig
            ? await getRoomInfo(roomId, { includeAliases: true })
            : undefined;
        const roomAliasesForConfig = roomInfoForConfig
          ? [roomInfoForConfig.canonicalAlias ?? "", ...roomInfoForConfig.altAliases].filter(
              Boolean,
            )
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
          await commitInboundEventIfClaimed();
          return undefined;
        }

        if (isRoom && roomConfig && !roomConfigInfo?.allowed) {
          logVerboseMessage(`matrix: room disabled room=${roomId} (${roomMatchMeta})`);
          await commitInboundEventIfClaimed();
          return undefined;
        }
        if (isRoom && groupPolicy === "allowlist") {
          if (!roomConfigInfo?.allowlistConfigured) {
            logVerboseMessage(`matrix: drop room message (no allowlist, ${roomMatchMeta})`);
            await commitInboundEventIfClaimed();
            return undefined;
          }
          if (!roomConfig) {
            logVerboseMessage(`matrix: drop room message (not in allowlist, ${roomMatchMeta})`);
            await commitInboundEventIfClaimed();
            return undefined;
          }
        }

        let senderNamePromise: Promise<string> | null = null;
        const getSenderName = async (): Promise<string> => {
          senderNamePromise ??= getMemberDisplayName(roomId, senderId).catch(() => senderId);
          return await senderNamePromise;
        };
        const storeAllowFrom = isDirectMessage ? await readStoreAllowFrom() : [];
        const roomUsers = roomConfig?.users ?? [];
        const accessState = resolveMatrixMonitorAccessState({
          allowFrom,
          storeAllowFrom,
          groupAllowFrom,
          roomUsers,
          senderId,
          isRoom,
        });
        const {
          effectiveGroupAllowFrom,
          effectiveRoomUsers,
          groupAllowConfigured,
          directAllowMatch,
          roomUserMatch,
          groupAllowMatch,
          commandAuthorizers,
        } = accessState;

        if (isDirectMessage) {
          if (!dmEnabled || dmPolicy === "disabled") {
            await commitInboundEventIfClaimed();
            return undefined;
          }
          if (dmPolicy !== "open") {
            const allowMatchMeta = formatAllowlistMatchMeta(directAllowMatch);
            if (!directAllowMatch.allowed) {
              if (!isReactionEvent && dmPolicy === "pairing") {
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
                      ? `matrix pairing request sender=${senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`
                      : `matrix pairing reminder sender=${senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`,
                  );
                  try {
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
                    logVerboseMessage(
                      `matrix pairing reply failed for ${senderId}: ${String(err)}`,
                    );
                    return undefined;
                  }
                } else {
                  logVerboseMessage(
                    `matrix pairing reminder suppressed sender=${senderId} (cooldown)`,
                  );
                  await commitInboundEventIfClaimed();
                }
              }
              if (isReactionEvent || dmPolicy !== "pairing") {
                logVerboseMessage(
                  `matrix: blocked ${isReactionEvent ? "reaction" : "dm"} sender ${senderId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
                );
                await commitInboundEventIfClaimed();
              }
              return undefined;
            }
          }
        }

        if (isRoom && roomUserMatch && !roomUserMatch.allowed) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (room users allowlist, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              roomUserMatch,
            )})`,
          );
          await commitInboundEventIfClaimed();
          return undefined;
        }
        if (
          isRoom &&
          groupPolicy === "allowlist" &&
          effectiveRoomUsers.length === 0 &&
          groupAllowConfigured &&
          groupAllowMatch &&
          !groupAllowMatch.allowed
        ) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (groupAllowFrom, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              groupAllowMatch,
            )})`,
          );
          await commitInboundEventIfClaimed();
          return undefined;
        }
        if (isRoom) {
          logVerboseMessage(`matrix: allow room ${roomId} (${roomMatchMeta})`);
        }

        if (isReactionEvent) {
          const senderName = await getSenderName();
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
          await commitInboundEventIfClaimed();
          return undefined;
        }

        let pollSnapshotPromise: Promise<MatrixPollSnapshot | null> | null = null;
        const getPollSnapshot = async (): Promise<MatrixPollSnapshot | null> => {
          if (!isPollEvent) {
            return null;
          }
          pollSnapshotPromise ??= fetchMatrixPollSnapshot(client, roomId, event).catch((err) => {
            logVerboseMessage(
              `matrix: failed resolving poll snapshot room=${roomId} id=${event.event_id ?? "unknown"}: ${String(err)}`,
            );
            return null;
          });
          return await pollSnapshotPromise;
        };

        const mentionPrecheckText = resolveMatrixMentionPrecheckText({
          eventType,
          content,
          locationText: locationPayload?.text,
        });
        const contentUrl =
          "url" in content && typeof content.url === "string" ? content.url : undefined;
        const contentFile =
          "file" in content && content.file && typeof content.file === "object"
            ? content.file
            : undefined;
        const mediaUrl = contentUrl ?? contentFile?.url;
        const pendingHistoryText = resolveMatrixPendingHistoryText({
          mentionPrecheckText,
          content,
          mediaUrl,
        });
        const pendingHistoryPollText =
          !pendingHistoryText && isPollEvent && historyLimit > 0
            ? (await getPollSnapshot())?.text
            : "";
        if (!mentionPrecheckText && !mediaUrl && !isPollEvent) {
          await commitInboundEventIfClaimed();
          return undefined;
        }

        const _messageId = event.event_id ?? "";
        const _threadRootId = resolveMatrixThreadRootId({ event, content });
        const thread = resolveMatrixThreadRouting({
          isDirectMessage,
          threadReplies,
          dmThreadReplies,
          messageId: _messageId,
          threadRootId: _threadRootId,
        });
        const {
          route: _route,
          configuredBinding: _configuredBinding,
          runtimeBindingId: _runtimeBindingId,
        } = resolveMatrixInboundRoute({
          cfg,
          accountId,
          roomId,
          senderId,
          isDirectMessage,
          dmSessionScope,
          threadId: thread.threadId,
          eventTs: eventTs ?? undefined,
          resolveAgentRoute: core.channel.routing.resolveAgentRoute,
        });
        const hasExplicitSessionBinding = _configuredBinding !== null || _runtimeBindingId !== null;
        const agentMentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, _route.agentId);
        const selfDisplayName = content.formatted_body
          ? await getMemberDisplayName(roomId, selfUserId).catch(() => undefined)
          : undefined;
        const { wasMentioned, hasExplicitMention } = resolveMentions({
          content,
          userId: selfUserId,
          displayName: selfDisplayName,
          text: mentionPrecheckText,
          mentionRegexes: agentMentionRegexes,
        });
        if (
          isConfiguredBotSender &&
          allowBotsMode === "mentions" &&
          !isDirectMessage &&
          !wasMentioned
        ) {
          logVerboseMessage(
            `matrix: drop configured bot sender=${senderId} (allowBots=mentions, missing mention, ${roomMatchMeta})`,
          );
          await commitInboundEventIfClaimed();
          return undefined;
        }
        const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
          cfg,
          surface: "matrix",
        });
        const useAccessGroups = cfg.commands?.useAccessGroups !== false;
        const hasControlCommandInMessage = core.channel.text.hasControlCommand(
          mentionPrecheckText,
          cfg,
        );
        const commandGate = resolveControlCommandGate({
          useAccessGroups,
          authorizers: commandAuthorizers,
          allowTextCommands,
          hasControlCommand: hasControlCommandInMessage,
        });
        const commandAuthorized = commandGate.commandAuthorized;
        if (isRoom && commandGate.shouldBlock) {
          logInboundDrop({
            log: logVerboseMessage,
            channel: "matrix",
            reason: "control command (unauthorized)",
            target: senderId,
          });
          await commitInboundEventIfClaimed();
          return undefined;
        }
        const shouldRequireMention = isRoom
          ? roomConfig?.autoReply === true
            ? false
            : roomConfig?.autoReply === false
              ? true
              : typeof roomConfig?.requireMention === "boolean"
                ? roomConfig?.requireMention
                : true
          : false;
        const shouldBypassMention =
          allowTextCommands &&
          isRoom &&
          shouldRequireMention &&
          !wasMentioned &&
          !hasExplicitMention &&
          commandAuthorized &&
          hasControlCommandInMessage;
        const canDetectMention = agentMentionRegexes.length > 0 || hasExplicitMention;
        if (isRoom && shouldRequireMention && !wasMentioned && !shouldBypassMention) {
          const pendingHistoryBody = pendingHistoryText || pendingHistoryPollText;
          if (historyLimit > 0 && pendingHistoryBody) {
            const pendingEntry: HistoryEntry = {
              sender: senderId,
              body: pendingHistoryBody,
              timestamp: eventTs ?? undefined,
              messageId: _messageId,
            };
            roomHistoryTracker.recordPending(roomId, pendingEntry);
          }
          logger.info("skipping room message", { roomId, reason: "no-mention" });
          await commitInboundEventIfClaimed();
          return undefined;
        }

        if (isPollEvent) {
          const pollSnapshot = await getPollSnapshot();
          if (!pollSnapshot) {
            return undefined;
          }
          content = {
            msgtype: "m.text",
            body: pollSnapshot.text,
          } as unknown as RoomMessageEventContent;
        }

        let media: {
          path: string;
          contentType?: string;
          placeholder: string;
        } | null = null;
        let mediaDownloadFailed = false;
        let mediaSizeLimitExceeded = false;
        const finalContentUrl =
          "url" in content && typeof content.url === "string" ? content.url : undefined;
        const finalContentFile =
          "file" in content && content.file && typeof content.file === "object"
            ? content.file
            : undefined;
        const finalMediaUrl = finalContentUrl ?? finalContentFile?.url;
        const contentBody = typeof content.body === "string" ? content.body.trim() : "";
        const contentFilename = typeof content.filename === "string" ? content.filename.trim() : "";
        const originalFilename = contentFilename || contentBody || undefined;
        const contentInfo =
          "info" in content && content.info && typeof content.info === "object"
            ? (content.info as { mimetype?: string; size?: number })
            : undefined;
        const contentType = contentInfo?.mimetype;
        const contentSize = typeof contentInfo?.size === "number" ? contentInfo.size : undefined;
        if (finalMediaUrl?.startsWith("mxc://")) {
          try {
            media = await downloadMatrixMedia({
              client,
              mxcUrl: finalMediaUrl,
              contentType,
              sizeBytes: contentSize,
              maxBytes: mediaMaxBytes,
              file: finalContentFile,
              originalFilename,
            });
          } catch (err) {
            mediaDownloadFailed = true;
            if (isMatrixMediaSizeLimitError(err)) {
              mediaSizeLimitExceeded = true;
            }
            const errorText = formatMatrixErrorMessage(err);
            logVerboseMessage(
              `matrix: media download failed room=${roomId} id=${event.event_id ?? "unknown"} type=${content.msgtype} error=${errorText}`,
            );
            logger.warn("matrix media download failed", {
              roomId,
              eventId: event.event_id,
              msgtype: content.msgtype,
              encrypted: Boolean(finalContentFile),
              error: errorText,
            });
          }
        }

        const rawBody = locationPayload?.text ?? contentBody;
        const bodyText = resolveMatrixInboundBodyText({
          rawBody,
          filename: typeof content.filename === "string" ? content.filename : undefined,
          mediaPlaceholder: media?.placeholder,
          msgtype: content.msgtype,
          hadMediaUrl: Boolean(finalMediaUrl),
          mediaDownloadFailed,
          mediaSizeLimitExceeded,
        });
        if (!bodyText) {
          await commitInboundEventIfClaimed();
          return undefined;
        }
        const senderName = await getSenderName();
        if (_configuredBinding) {
          const ensured = await ensureConfiguredAcpBindingReady({
            cfg,
            configuredBinding: _configuredBinding,
          });
          if (!ensured.ok) {
            logInboundDrop({
              log: logVerboseMessage,
              channel: "matrix",
              reason: "configured ACP binding unavailable",
              target: _configuredBinding.spec.conversationId,
            });
            return undefined;
          }
        }
        if (_runtimeBindingId) {
          getSessionBindingService().touch(_runtimeBindingId, eventTs ?? undefined);
        }
        const preparedTrigger =
          isRoom && historyLimit > 0
            ? roomHistoryTracker.prepareTrigger(_route.agentId, roomId, historyLimit, {
                sender: senderName,
                body: bodyText,
                timestamp: eventTs ?? undefined,
                messageId: _messageId,
              })
            : undefined;
        const inboundHistory = preparedTrigger?.history;
        const triggerSnapshot = preparedTrigger;

        return {
          route: _route,
          hasExplicitSessionBinding,
          roomConfig,
          isDirectMessage,
          isRoom,
          shouldRequireMention,
          wasMentioned,
          shouldBypassMention,
          canDetectMention,
          commandAuthorized,
          inboundHistory,
          senderName,
          bodyText,
          media,
          locationPayload,
          messageId: _messageId,
          triggerSnapshot,
          threadRootId: _threadRootId,
          thread,
          effectiveGroupAllowFrom,
          effectiveRoomUsers,
        };
      };
      const ingressResult =
        historyLimit > 0
          ? await runRoomIngress(roomId, async () => {
              const prefix = await readIngressPrefix();
              if (!prefix) {
                return undefined;
              }
              if (prefix.isDirectMessage) {
                return { deferredPrefix: prefix } as const;
              }
              return { ingressResult: await continueIngress(prefix) } as const;
            })
          : undefined;
      const resolvedIngressResult =
        historyLimit > 0
          ? ingressResult?.deferredPrefix
            ? await continueIngress(ingressResult.deferredPrefix)
            : ingressResult?.ingressResult
          : await (async () => {
              const prefix = await readIngressPrefix();
              if (!prefix) {
                return undefined;
              }
              return await continueIngress(prefix);
            })();
      if (!resolvedIngressResult) {
        return;
      }

      const {
        route: _route,
        hasExplicitSessionBinding,
        roomConfig,
        isDirectMessage,
        isRoom,
        shouldRequireMention,
        wasMentioned,
        shouldBypassMention,
        canDetectMention,
        commandAuthorized,
        inboundHistory,
        senderName,
        bodyText,
        media,
        locationPayload,
        messageId: _messageId,
        triggerSnapshot,
        threadRootId: _threadRootId,
        thread,
        effectiveGroupAllowFrom,
        effectiveRoomUsers,
      } = resolvedIngressResult;

      // Keep the per-room ingress gate focused on ordering-sensitive state updates.
      // Prompt/session enrichment below can run concurrently after the history snapshot is fixed.
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
      let threadContext = _threadRootId
        ? await resolveThreadContext({ roomId, threadRootId: _threadRootId })
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
      if (replyToEventId && replyToEventId === _threadRootId && threadContext?.summary) {
        replyContext = {
          replyToBody: threadContext.summary,
          replyToSender: threadContext.senderLabel,
          replyToSenderId: threadContext.senderId,
        };
      } else if (
        replyToEventId &&
        replyToEventId === _threadRootId &&
        threadContextBlockedByPolicy
      ) {
        replyContext = await resolveReplyContext({ roomId, eventId: replyToEventId });
      } else {
        replyContext = replyToEventId
          ? await resolveReplyContext({ roomId, eventId: replyToEventId })
          : undefined;
      }
      if (
        replyContext?.replyToSenderId &&
        !shouldIncludeRoomContextSender("quote", replyContext.replyToSenderId)
      ) {
        logVerboseMessage(`matrix: drop reply context (mode=${contextVisibilityMode})`);
        replyContext = undefined;
      }
      const roomInfo = isRoom ? await getRoomInfo(roomId) : undefined;
      const roomName = roomInfo?.name;
      const envelopeFrom = isDirectMessage ? senderName : (roomName ?? roomId);
      const textWithId = `${bodyText}\n[matrix event id: ${_messageId} room: ${roomId}]`;
      const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: _route.agentId,
      });
      const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: _route.sessionKey,
      });
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
      const body = core.channel.reply.formatAgentEnvelope({
        channel: "Matrix",
        from: envelopeFrom,
        timestamp: eventTs ?? undefined,
        previousTimestamp,
        envelope: envelopeOptions,
        body: textWithId,
      });
      const groupSystemPrompt = normalizeOptionalString(roomConfig?.systemPrompt);
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: bodyText,
        CommandBody: bodyText,
        InboundHistory: inboundHistory && inboundHistory.length > 0 ? inboundHistory : undefined,
        From: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
        To: `room:${roomId}`,
        SessionKey: _route.sessionKey,
        AccountId: _route.accountId,
        ChatType: isDirectMessage ? "direct" : "channel",
        ConversationLabel: envelopeFrom,
        SenderName: senderName,
        SenderId: senderId,
        SenderUsername: senderId.split(":")[0]?.replace(/^@/, ""),
        GroupSubject: isRoom ? (roomName ?? roomId) : undefined,
        GroupId: isRoom ? roomId : undefined,
        GroupSystemPrompt: isRoom ? groupSystemPrompt : undefined,
        Provider: "matrix" as const,
        Surface: "matrix" as const,
        WasMentioned: isRoom ? wasMentioned : undefined,
        MessageSid: _messageId,
        ReplyToId: threadTarget ? undefined : (replyToEventId ?? undefined),
        ReplyToBody: replyContext?.replyToBody,
        ReplyToSender: replyContext?.replyToSender,
        MessageThreadId: threadTarget,
        ThreadStarterBody: threadContext?.threadStarterBody,
        Timestamp: eventTs ?? undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        ...locationPayload?.context,
        CommandAuthorized: commandAuthorized,
        CommandSource: "text" as const,
        NativeChannelId: roomId,
        NativeDirectUserId: isDirectMessage ? senderId : undefined,
        OriginatingChannel: "matrix" as const,
        OriginatingTo: `room:${roomId}`,
      });

      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? _route.sessionKey,
        ctx: ctxPayload,
        updateLastRoute: isDirectMessage
          ? {
              sessionKey: _route.mainSessionKey,
              channel: "matrix",
              to: `room:${roomId}`,
              accountId: _route.accountId,
            }
          : undefined,
        onRecordError: (err) => {
          logger.warn("failed updating session meta", {
            error: String(err),
            storePath,
            sessionKey: ctxPayload.SessionKey ?? _route.sessionKey,
          });
        },
      });

      if (sharedDmContextNotice && markTrackedRoomIfFirst(sharedDmContextNoticeRooms, roomId)) {
        client
          .sendMessage(roomId, {
            msgtype: "m.notice",
            body: sharedDmContextNotice,
          })
          .catch((err) => {
            logVerboseMessage(
              `matrix: failed sending shared DM session notice room=${roomId}: ${String(err)}`,
            );
          });
      }

      const preview = bodyText.slice(0, 200).replace(/\n/g, "\\n");
      logVerboseMessage(`matrix inbound: room=${roomId} from=${senderId} preview="${preview}"`);

      const replyTarget = ctxPayload.To;
      if (!replyTarget) {
        runtime.error?.("matrix: missing reply target");
        return;
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
            effectiveWasMentioned: wasMentioned || shouldBypassMention,
            shouldBypassMention,
          }),
        );
      if (shouldAckReaction() && _messageId) {
        reactMatrixMessage(roomId, _messageId, ackReaction, client).catch((err) => {
          logVerboseMessage(`matrix react failed for room ${roomId}: ${String(err)}`);
        });
      }

      if (_messageId) {
        sendReadReceiptMatrix(roomId, _messageId, client).catch((err) => {
          logVerboseMessage(
            `matrix: read receipt failed room=${roomId} id=${_messageId}: ${String(err)}`,
          );
        });
      }

      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "matrix",
        accountId: _route.accountId,
      });
      const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, _route.agentId);
      let finalReplyDeliveryFailed = false;
      let nonFinalReplyDeliveryFailed = false;
      let retryableReplyDeliveryFailed = false;
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: _route.agentId,
        channel: "matrix",
        accountId: _route.accountId,
      });
      const typingCallbacks = createTypingCallbacks({
        start: () => sendTypingMatrix(roomId, true, undefined, client),
        stop: () => sendTypingMatrix(roomId, false, undefined, client),
        onStartError: (err) => {
          logTypingFailure({
            log: logVerboseMessage,
            channel: "matrix",
            action: "start",
            target: roomId,
            error: err,
          });
        },
        onStopError: (err) => {
          logTypingFailure({
            log: logVerboseMessage,
            channel: "matrix",
            action: "stop",
            target: roomId,
            error: err,
          });
        },
      });
      const draftStreamingEnabled = streaming !== "off";
      const quietDraftStreaming = streaming === "quiet";
      const draftReplyToId = replyToMode !== "off" && !threadTarget ? _messageId : undefined;
      const draftStream = draftStreamingEnabled
        ? createMatrixDraftStream({
            roomId,
            client,
            cfg,
            mode: quietDraftStreaming ? "quiet" : "partial",
            threadId: threadTarget,
            replyToId: draftReplyToId,
            preserveReplyId: replyToMode === "all",
            accountId: _route.accountId,
            log: logVerboseMessage,
          })
        : undefined;
      draftStreamRef = draftStream;
      type PendingDraftBoundary = {
        messageGeneration: number;
        endOffset: number;
      };
      // Track the current draft block start plus any queued block-end offsets
      // inside the model's cumulative partial text so multiple block
      // boundaries can drain in order even when Matrix delivery lags behind.
      let currentDraftMessageGeneration = 0;
      let currentDraftBlockOffset = 0;
      let latestDraftFullText = "";
      const pendingDraftBoundaries: PendingDraftBoundary[] = [];
      const latestQueuedDraftBoundaryOffsets = new Map<number, number>();
      let currentDraftReplyToId = draftReplyToId;
      // Set after the first final payload consumes or discards the draft event
      // so subsequent finals go through normal delivery.

      const getDisplayableDraftText = () => {
        const nextDraftBoundaryOffset = pendingDraftBoundaries.find(
          (boundary) => boundary.messageGeneration === currentDraftMessageGeneration,
        )?.endOffset;
        if (nextDraftBoundaryOffset === undefined) {
          return latestDraftFullText.slice(currentDraftBlockOffset);
        }
        return latestDraftFullText.slice(currentDraftBlockOffset, nextDraftBoundaryOffset);
      };

      const updateDraftFromLatestFullText = () => {
        const blockText = getDisplayableDraftText();
        if (blockText) {
          draftStream?.update(blockText);
        }
      };

      const queueDraftBlockBoundary = (payload: ReplyPayload, context?: BlockReplyContext) => {
        const payloadTextLength = payload.text?.length ?? 0;
        const messageGeneration = context?.assistantMessageIndex ?? currentDraftMessageGeneration;
        const lastQueuedDraftBoundaryOffset =
          latestQueuedDraftBoundaryOffsets.get(messageGeneration) ?? 0;
        // Logical block boundaries must follow emitted block text, not whichever
        // later partial preview has already arrived by the time the async
        // boundary callback drains.
        const nextDraftBoundaryOffset = lastQueuedDraftBoundaryOffset + payloadTextLength;
        latestQueuedDraftBoundaryOffsets.set(messageGeneration, nextDraftBoundaryOffset);
        pendingDraftBoundaries.push({
          messageGeneration,
          endOffset: nextDraftBoundaryOffset,
        });
      };

      const advanceDraftBlockBoundary = (options?: { fallbackToLatestEnd?: boolean }) => {
        const completedBoundary = pendingDraftBoundaries.shift();
        if (completedBoundary) {
          if (
            !pendingDraftBoundaries.some(
              (entry) => entry.messageGeneration === completedBoundary.messageGeneration,
            )
          ) {
            latestQueuedDraftBoundaryOffsets.delete(completedBoundary.messageGeneration);
          }
          if (completedBoundary.messageGeneration === currentDraftMessageGeneration) {
            currentDraftBlockOffset = completedBoundary.endOffset;
          }
          return;
        }
        if (options?.fallbackToLatestEnd) {
          currentDraftBlockOffset = latestDraftFullText.length;
        }
      };

      const resetDraftBlockOffsets = () => {
        currentDraftMessageGeneration += 1;
        currentDraftBlockOffset = 0;
        latestDraftFullText = "";
      };

      const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
        core.channel.reply.createReplyDispatcherWithTyping({
          ...prefixOptions,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, _route.agentId),
          deliver: async (payload: ReplyPayload, info: { kind: string }) => {
            if (draftStream && info.kind !== "tool" && !payload.isCompactionNotice) {
              const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;

              await draftStream.stop();
              const draftEventId = draftStream.eventId();

              if (draftConsumed) {
                await deliverMatrixReplies({
                  cfg,
                  replies: [payload],
                  roomId,
                  client,
                  runtime,
                  textLimit,
                  replyToMode,
                  threadId: threadTarget,
                  accountId: _route.accountId,
                  mediaLocalRoots,
                  tableMode,
                });
                return;
              }

              const payloadReplyToId = normalizeOptionalString(payload.replyToId);
              const payloadReplyMismatch =
                replyToMode !== "off" &&
                !threadTarget &&
                payloadReplyToId !== currentDraftReplyToId;
              const mustDeliverFinalNormally = draftStream.mustDeliverFinalNormally();

              if (
                draftEventId &&
                payload.text &&
                !hasMedia &&
                !payloadReplyMismatch &&
                !mustDeliverFinalNormally
              ) {
                try {
                  const requiresFinalEdit =
                    quietDraftStreaming || !draftStream.matchesPreparedText(payload.text);
                  if (requiresFinalEdit) {
                    await editMessageMatrix(roomId, draftEventId, payload.text, {
                      client,
                      cfg,
                      threadId: threadTarget,
                      accountId: _route.accountId,
                      extraContent: quietDraftStreaming
                        ? buildMatrixFinalizedPreviewContent()
                        : undefined,
                    });
                  } else if (!(await draftStream.finalizeLive())) {
                    throw new Error("Matrix draft live finalize failed");
                  }
                } catch {
                  await redactMatrixDraftEvent(client, roomId, draftEventId);
                  await deliverMatrixReplies({
                    cfg,
                    replies: [payload],
                    roomId,
                    client,
                    runtime,
                    textLimit,
                    replyToMode,
                    threadId: threadTarget,
                    accountId: _route.accountId,
                    mediaLocalRoots,
                    tableMode,
                  });
                }
                draftConsumed = true;
              } else if (draftEventId && hasMedia && !payloadReplyMismatch) {
                let textEditOk = !mustDeliverFinalNormally;
                const payloadText = payload.text;
                const payloadTextMatchesDraft =
                  typeof payloadText === "string" && draftStream.matchesPreparedText(payloadText);
                const reusesDraftTextUnchanged =
                  typeof payloadText === "string" &&
                  Boolean(payloadText.trim()) &&
                  payloadTextMatchesDraft;
                const requiresFinalTextEdit =
                  quietDraftStreaming ||
                  (typeof payloadText === "string" && !payloadTextMatchesDraft);
                if (textEditOk && payloadText && requiresFinalTextEdit) {
                  textEditOk = await editMessageMatrix(roomId, draftEventId, payloadText, {
                    client,
                    cfg,
                    threadId: threadTarget,
                    accountId: _route.accountId,
                    extraContent: quietDraftStreaming
                      ? buildMatrixFinalizedPreviewContent()
                      : undefined,
                  }).then(
                    () => true,
                    () => false,
                  );
                } else if (textEditOk && reusesDraftTextUnchanged) {
                  textEditOk = await draftStream.finalizeLive();
                }
                const reusesDraftAsFinalText = Boolean(payload.text?.trim()) && textEditOk;
                if (!reusesDraftAsFinalText) {
                  await redactMatrixDraftEvent(client, roomId, draftEventId);
                }
                await deliverMatrixReplies({
                  cfg,
                  replies: [
                    { ...payload, text: reusesDraftAsFinalText ? undefined : payload.text },
                  ],
                  roomId,
                  client,
                  runtime,
                  textLimit,
                  replyToMode,
                  threadId: threadTarget,
                  accountId: _route.accountId,
                  mediaLocalRoots,
                  tableMode,
                });
                draftConsumed = true;
              } else {
                const draftRedacted =
                  Boolean(draftEventId) && (payloadReplyMismatch || mustDeliverFinalNormally);
                if (draftRedacted && draftEventId) {
                  await redactMatrixDraftEvent(client, roomId, draftEventId);
                }
                const deliveredFallback = await deliverMatrixReplies({
                  cfg,
                  replies: [payload],
                  roomId,
                  client,
                  runtime,
                  textLimit,
                  replyToMode,
                  threadId: threadTarget,
                  accountId: _route.accountId,
                  mediaLocalRoots,
                  tableMode,
                });
                if (draftRedacted || deliveredFallback) {
                  draftConsumed = true;
                }
              }

              if (info.kind === "block") {
                draftConsumed = false;
                advanceDraftBlockBoundary({ fallbackToLatestEnd: true });
                draftStream.reset();
                currentDraftReplyToId = replyToMode === "all" ? draftReplyToId : undefined;
                updateDraftFromLatestFullText();

                // Re-assert typing so the user still sees the indicator while
                // the next block generates.
                await sendTypingMatrix(roomId, true, undefined, client).catch(() => {});
              }
            } else {
              await deliverMatrixReplies({
                cfg,
                replies: [payload],
                roomId,
                client,
                runtime,
                textLimit,
                replyToMode,
                threadId: threadTarget,
                accountId: _route.accountId,
                mediaLocalRoots,
                tableMode,
              });
            }
          },
          onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
            if (err instanceof MatrixRetryableInboundError) {
              retryableReplyDeliveryFailed = true;
            }
            if (info.kind === "final") {
              finalReplyDeliveryFailed = true;
            } else {
              nonFinalReplyDeliveryFailed = true;
            }
            if (info.kind === "block") {
              advanceDraftBlockBoundary({ fallbackToLatestEnd: true });
            }
            runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
          },
          onReplyStart: typingCallbacks.onReplyStart,
          onIdle: typingCallbacks.onIdle,
        });

      const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
        dispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        run: async () => {
          try {
            return await core.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyOptions: {
                ...replyOptions,
                skillFilter: roomConfig?.skills,
                // Keep block streaming enabled when explicitly requested, even
                // with draft previews on. The draft remains the live preview
                // for the current assistant block, while block deliveries
                // finalize completed blocks into their own preserved events.
                disableBlockStreaming: !blockStreamingEnabled,
                onPartialReply: draftStream
                  ? (payload) => {
                      latestDraftFullText = payload.text ?? "";
                      updateDraftFromLatestFullText();
                    }
                  : undefined,
                onBlockReplyQueued: draftStream
                  ? (payload, context) => {
                      if (payload.isCompactionNotice === true) {
                        return;
                      }
                      queueDraftBlockBoundary(payload, context);
                    }
                  : undefined,
                // Reset draft boundary bookkeeping on assistant message
                // boundaries so post-tool blocks stream from a fresh
                // cumulative payload (payload.text resets upstream).
                onAssistantMessageStart: draftStream
                  ? () => {
                      resetDraftBlockOffsets();
                    }
                  : undefined,
                onModelSelected,
              },
            });
          } finally {
            markRunComplete();
          }
        },
      });
      if (finalReplyDeliveryFailed) {
        if (retryableReplyDeliveryFailed) {
          logVerboseMessage(
            `matrix: final reply delivery failed room=${roomId} id=${_messageId}; leaving event uncommitted`,
          );
          // Explicit retryable failures reopen replay so the same history can be retried.
          return;
        }
        logVerboseMessage(
          `matrix: final reply delivery failed room=${roomId} id=${_messageId}; keeping replay committed`,
        );
        await commitInboundEventIfClaimed();
        return;
      }
      if (!queuedFinal && nonFinalReplyDeliveryFailed) {
        if (retryableReplyDeliveryFailed) {
          logVerboseMessage(
            `matrix: non-final reply delivery failed room=${roomId} id=${_messageId}; leaving event uncommitted`,
          );
          // Explicit retryable failures reopen replay.
          return;
        }
        logVerboseMessage(
          `matrix: non-final reply delivery failed room=${roomId} id=${_messageId}; keeping replay committed`,
        );
        await commitInboundEventIfClaimed();
        return;
      }
      // Advance the per-agent watermark now that the reply succeeded (or no reply was needed).
      // Only advance to the snapshot position — messages added during async processing remain
      // visible for the next trigger.
      if (isRoom && triggerSnapshot) {
        roomHistoryTracker.consumeHistory(_route.agentId, roomId, triggerSnapshot, _messageId);
      }
      if (!queuedFinal) {
        await commitInboundEventIfClaimed();
        return;
      }
      const finalCount = counts.final;
      logVerboseMessage(
        `matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
      await commitInboundEventIfClaimed();
    } catch (err) {
      runtime.error?.(`matrix handler failed: ${String(err)}`);
    } finally {
      // Stop the draft stream timer so partial drafts don't leak if the
      // model run throws or times out mid-stream.
      if (draftStreamRef) {
        const draftEventId = await draftStreamRef.stop().catch(() => undefined);
        if (draftEventId && !draftConsumed) {
          await redactMatrixDraftEvent(client, roomId, draftEventId);
        }
      }
      if (claimedInboundEvent && inboundDeduper && eventId) {
        inboundDeduper.releaseEvent({ roomId, eventId });
      }
    }
  };
}
