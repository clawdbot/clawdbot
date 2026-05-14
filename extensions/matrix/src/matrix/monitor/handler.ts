import {
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-message";
import {
  createChannelProgressDraftGate,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  resolveChannelProgressDraftMaxLines,
} from "openclaw/plugin-sdk/channel-streaming";
import {
  evaluateSupplementalContextVisibility,
  resolveChannelContextVisibilityMode,
} from "openclaw/plugin-sdk/context-visibility-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { hasFinalInboundReplyDispatch } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { ChannelBotLoopProtectionFacts } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  CoreConfig,
  MatrixConfig,
  MatrixRoomConfig,
  MatrixStreamingMode,
  ReplyToMode,
} from "../../types.js";
import {
  resolveMatrixAccountAllowlistConfig,
  resolveMatrixAccountConfig,
} from "../account-config.js";
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
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import { resolveMatrixStoredSessionMeta } from "../session-store-metadata.js";
import {
  resolveMatrixMonitorAccessState,
  resolveMatrixMonitorCommandAccess,
} from "./access-state.js";
import { resolveMatrixAckReactionConfig } from "./ack-config.js";
import { normalizeMatrixUserId, resolveMatrixAllowListMatch } from "./allowlist.js";
import {
  resolveMatrixMonitorLiveUserAllowlist,
  type MatrixResolvedAllowlistEntry,
} from "./config.js";
import type { MatrixInboundEventDeduper } from "./inbound-dedupe.js";
import { resolveMatrixLocation, type MatrixLocationPayload } from "./location.js";
import { downloadMatrixMedia } from "./media.js";
import { resolveMentions, stripMatrixMentionPrefix } from "./mentions.js";
import { deliverMatrixReplies } from "./replies.js";
import { createMatrixReplyContextResolver } from "./reply-context.js";
import { createRoomHistoryTracker } from "./room-history.js";
import type { HistoryEntry } from "./room-history.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixInboundRoute } from "./route.js";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
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
const MATRIX_TOOL_PROGRESS_MAX_CHARS = 300;
let matrixSendModulePromise: Promise<typeof import("../send.js")> | undefined;
let acpBindingRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/acp-binding-runtime")>
  | undefined;
let sessionBindingRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/session-binding-runtime")>
  | undefined;
let matrixReactionEventsPromise: Promise<typeof import("./reaction-events.js")> | undefined;
let matrixDraftStreamPromise: Promise<typeof import("../draft-stream.js")> | undefined;

function loadMatrixSendModule(): Promise<typeof import("../send.js")> {
  matrixSendModulePromise ??= import("../send.js");
  return matrixSendModulePromise;
}

function loadAcpBindingRuntime(): Promise<
  typeof import("openclaw/plugin-sdk/acp-binding-runtime")
> {
  acpBindingRuntimePromise ??= import("openclaw/plugin-sdk/acp-binding-runtime");
  return acpBindingRuntimePromise;
}

function loadSessionBindingRuntime(): Promise<
  typeof import("openclaw/plugin-sdk/session-binding-runtime")
> {
  sessionBindingRuntimePromise ??= import("openclaw/plugin-sdk/session-binding-runtime");
  return sessionBindingRuntimePromise;
}

function loadMatrixReactionEvents(): Promise<typeof import("./reaction-events.js")> {
  matrixReactionEventsPromise ??= import("./reaction-events.js");
  return matrixReactionEventsPromise;
}

function loadMatrixDraftStream(): Promise<typeof import("../draft-stream.js")> {
  matrixDraftStreamPromise ??= import("../draft-stream.js");
  return matrixDraftStreamPromise;
}

const MAX_TRACKED_PAIRING_REPLY_SENDERS = 512;
const MAX_TRACKED_SHARED_DM_CONTEXT_NOTICES = 512;
type MatrixAllowBotsMode = "off" | "mentions" | "all";
type MatrixDraftStreamHandle = {
  update: (text: string) => void;
  stop: () => Promise<string | undefined>;
  discardPending: () => Promise<void>;
  eventId: () => string | undefined;
  mustDeliverFinalNormally: () => boolean;
  matchesPreparedText: (text: string) => boolean;
  finalizeLive: () => Promise<boolean>;
  reset: () => void;
};

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
  accountConfig?: MatrixConfig;
  runtime: RuntimeEnv;
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
  allowFrom: string[];
  allowFromResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
  groupAllowFrom?: string[];
  groupAllowFromResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
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
  previewToolProgressEnabled: boolean;
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
  resolveLiveUserAllowlist?: typeof resolveMatrixMonitorLiveUserAllowlist;
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

function formatMatrixToolProgressMarkdownCode(text: string): string {
  const clipped =
    text.length <= MATRIX_TOOL_PROGRESS_MAX_CHARS
      ? text
      : `${text.slice(0, MATRIX_TOOL_PROGRESS_MAX_CHARS - 1).trimEnd()}...`;
  const safe = clipped.replaceAll("`", "'");
  return `\`${safe}\``;
}

export function createMatrixRoomMessageHandler(params: MatrixMonitorHandlerParams) {
  const {
    client,
    core,
    cfg,
    accountId,
    accountConfig,
    runtime,
    logger,
    logVerboseMessage,
    allowFromResolvedEntries = [],
    groupAllowFromResolvedEntries = [],
    roomsConfig,
    accountAllowBots,
    configuredBotUserIds = new Set<string>(),
    groupPolicy,
    replyToMode,
    threadReplies,
    dmThreadReplies,
    dmSessionScope,
    streaming,
    previewToolProgressEnabled,
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
    resolveLiveUserAllowlist = resolveMatrixMonitorLiveUserAllowlist,
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
  type LiveAllowlistCacheEntry = { signature: string; entries: string[] };
  let liveDmAllowlistCache: LiveAllowlistCacheEntry | null = null;
  let liveGroupAllowlistCache: LiveAllowlistCacheEntry | null = null;
  const resolveCachedLiveAllowlist = async (params: {
    cfg: CoreConfig;
    entries?: ReadonlyArray<string | number>;
    failClosedOnUnresolved?: boolean;
    startupResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
    cache: LiveAllowlistCacheEntry | null;
    updateCache: (next: LiveAllowlistCacheEntry) => void;
  }): Promise<string[]> => {
    const accountConfig = resolveMatrixAccountConfig({ cfg: params.cfg, accountId });
    const signature = JSON.stringify({
      entries: (params.entries ?? []).map((entry) => String(entry).trim()),
      failClosedOnUnresolved: params.failClosedOnUnresolved === true,
      dangerouslyAllowNameMatching: isDangerousNameMatchingEnabled(accountConfig),
    });
    if (params.cache?.signature === signature) {
      return params.cache.entries;
    }
    const entries = await resolveLiveUserAllowlist({
      cfg: params.cfg,
      accountId,
      entries: params.entries,
      failClosedOnUnresolved: params.failClosedOnUnresolved,
      startupResolvedEntries: params.startupResolvedEntries,
      runtime,
    });
    const next = { signature, entries };
    params.updateCache(next);
    return entries;
  };
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
    let draftStreamRef: MatrixDraftStreamHandle | undefined;
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
        const storeAllowFrom =
          isDirectMessage && dmPolicy !== "allowlist" && dmPolicy !== "open"
            ? await readStoreAllowFrom()
            : [];
        const roomUsers = roomConfig?.users ?? [];
        const liveCfg = core.config.current() as CoreConfig;
        const liveAccountAllowlists = resolveMatrixAccountAllowlistConfig({
          cfg: liveCfg,
          accountId,
        });
        const liveDmAllowFrom = await resolveCachedLiveAllowlist({
          cfg: liveCfg,
          entries: liveAccountAllowlists.dmAllowFrom,
          startupResolvedEntries: allowFromResolvedEntries,
          cache: liveDmAllowlistCache,
          updateCache: (next) => {
            liveDmAllowlistCache = next;
          },
        });
        const liveGroupAllowFrom = await resolveCachedLiveAllowlist({
          cfg: liveCfg,
          entries: liveAccountAllowlists.groupAllowFrom,
          failClosedOnUnresolved: true,
          startupResolvedEntries: groupAllowFromResolvedEntries,
          cache: liveGroupAllowlistCache,
          updateCache: (next) => {
            liveGroupAllowlistCache = next;
          },
        });
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
            await commitInboundEventIfClaimed();
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
                `matrix: blocked ${isReactionEvent ? "reaction" : "dm"} sender ${senderId} (dmPolicy=${dmPolicy}, reason=${senderReason})`,
              );
              await commitInboundEventIfClaimed();
            }
            return undefined;
          }
        }

        if (isRoom && ingressDecision.decision !== "allow") {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (ingress=${ingressDecision.reasonCode}, ${roomMatchMeta})`,
          );
          await commitInboundEventIfClaimed();
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

        const messageId = event.event_id ?? "";
        const threadRootId = resolveMatrixThreadRootId({ event, content });
        const thread = resolveMatrixThreadRouting({
          isDirectMessage,
          threadReplies,
          dmThreadReplies,
          messageId,
          threadRootId,
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
        // Keep mention stripping on the command-only path so history and agent
        // prompt text continue to see the original Matrix message.
        const commandCheckText = stripMatrixMentionPrefix({
          text: mentionPrecheckText,
          userId: selfUserId,
          displayName: selfDisplayName,
          mentionRegexes: agentMentionRegexes,
        });
        const hasControlCommandInMessage = core.channel.text.hasControlCommand(
          commandCheckText,
          cfg,
        );
        const commandAccess = await resolveMatrixMonitorCommandAccess(accessState, {
          useAccessGroups,
          allowTextCommands,
          hasControlCommand: hasControlCommandInMessage,
        });
        const commandAuthorized = commandAccess.authorized;
        if (isRoom && commandAccess.shouldBlockControlCommand) {
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
              messageId,
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
        const commandBodyText = hasControlCommandInMessage ? commandCheckText : bodyText;
        const senderName = await getSenderName();
        if (_configuredBinding) {
          const { ensureConfiguredAcpBindingReady } = await loadAcpBindingRuntime();
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
          const { getSessionBindingService } = await loadSessionBindingRuntime();
          getSessionBindingService().touch(_runtimeBindingId, eventTs ?? undefined);
        }
        const preparedTrigger =
          isRoom && historyLimit > 0
            ? roomHistoryTracker.prepareTrigger(_route.agentId, roomId, historyLimit, {
                sender: senderName,
                body: bodyText,
                timestamp: eventTs ?? undefined,
                messageId,
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
          commandBodyText,
          media,
          locationPayload,
          messageId,
          triggerSnapshot,
          threadRootId,
          thread,
          botLoopProtection,
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
        commandBodyText,
        media,
        locationPayload,
        messageId,
        triggerSnapshot,
        threadRootId,
        thread,
        botLoopProtection,
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
      } else if (
        replyToEventId &&
        replyToEventId === threadRootId &&
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
      const textWithId = `${bodyText}\n[matrix event id: ${messageId} room: ${roomId}]`;
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
        CommandBody: commandBodyText,
        BodyForAgent: bodyText,
        BodyForCommands: commandBodyText,
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
        GroupChannel: isRoom ? roomId : undefined,
        GroupSystemPrompt: isRoom ? groupSystemPrompt : undefined,
        Provider: "matrix" as const,
        Surface: "matrix" as const,
        WasMentioned: isRoom ? wasMentioned : undefined,
        MessageSid: messageId,
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
      if (shouldAckReaction() && messageId) {
        loadMatrixSendModule()
          .then(({ reactMatrixMessage }) =>
            reactMatrixMessage(roomId, messageId, ackReaction, client),
          )
          .catch((err) => {
            logVerboseMessage(`matrix react failed for room ${roomId}: ${String(err)}`);
          });
      }

      if (messageId) {
        loadMatrixSendModule()
          .then(({ sendReadReceiptMatrix }) => sendReadReceiptMatrix(roomId, messageId, client))
          .catch((err) => {
            logVerboseMessage(
              `matrix: read receipt failed room=${roomId} id=${messageId}: ${String(err)}`,
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
        start: async () => {
          const { sendTypingMatrix } = await loadMatrixSendModule();
          await sendTypingMatrix(roomId, true, undefined, client);
        },
        stop: async () => {
          const { sendTypingMatrix } = await loadMatrixSendModule();
          await sendTypingMatrix(roomId, false, undefined, client);
        },
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
      const quietDraftStreaming = streaming === "quiet" || streaming === "progress";
      const progressDraftStreaming = streaming === "progress";
      const draftReplyToId = replyToMode !== "off" && !threadTarget ? messageId : undefined;
      const draftStream: MatrixDraftStreamHandle | undefined = draftStreamingEnabled
        ? await loadMatrixDraftStream().then(({ createMatrixDraftStream }) =>
            createMatrixDraftStream({
              roomId,
              client,
              cfg,
              mode: quietDraftStreaming ? "quiet" : "partial",
              threadId: threadTarget,
              replyToId: draftReplyToId,
              preserveReplyId: replyToMode === "all",
              accountId: _route.accountId,
              log: logVerboseMessage,
            }),
          )
        : undefined;
      draftStreamRef = draftStream;
      const shouldStreamPreviewToolProgress = Boolean(draftStream) && previewToolProgressEnabled;
      const shouldSuppressDefaultToolProgressMessages =
        Boolean(draftStream) &&
        (shouldStreamPreviewToolProgress || params.streaming === "progress");
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
      let previewToolProgressSuppressed = false;
      let previewToolProgressLines: string[] = [];
      const progressConfigEntry = params.accountConfig ?? cfg.channels?.matrix;
      const progressSeed = `${_route.accountId}:${roomId}`;
      // Set after the first final payload consumes or discards the draft event
      // so subsequent finals go through normal delivery.

      const renderProgressDraft = () => {
        if (!draftStream || !progressDraftStreaming) {
          return;
        }
        const previewText = formatChannelProgressDraftText({
          entry: progressConfigEntry,
          lines: previewToolProgressLines,
          seed: progressSeed,
          formatLine: formatMatrixToolProgressMarkdownCode,
          bullet: "-",
        });
        if (!previewText) {
          return;
        }
        draftStream.update(previewText);
      };
      const progressDraftGate = createChannelProgressDraftGate({
        onStart: renderProgressDraft,
      });

      const pushPreviewToolProgress = async (line?: string, options?: { toolName?: string }) => {
        if (!draftStream) {
          return;
        }
        if (
          options?.toolName !== undefined &&
          !isChannelProgressDraftWorkToolName(options.toolName)
        ) {
          return;
        }
        const normalized = line?.replace(/\s+/g, " ").trim();
        if (!progressDraftStreaming) {
          if (!shouldStreamPreviewToolProgress || previewToolProgressSuppressed || !normalized) {
            return;
          }
          const previous = previewToolProgressLines.at(-1);
          if (previous === normalized) {
            return;
          }
          previewToolProgressLines = [...previewToolProgressLines, normalized].slice(
            -resolveChannelProgressDraftMaxLines(progressConfigEntry),
          );
          draftStream.update(
            formatChannelProgressDraftText({
              entry: progressConfigEntry,
              lines: previewToolProgressLines,
              seed: progressSeed,
              formatLine: formatMatrixToolProgressMarkdownCode,
              bullet: "-",
            }),
          );
          return;
        }
        if (shouldStreamPreviewToolProgress && !previewToolProgressSuppressed && normalized) {
          const previous = previewToolProgressLines.at(-1);
          if (previous !== normalized) {
            previewToolProgressLines = [...previewToolProgressLines, normalized].slice(
              -resolveChannelProgressDraftMaxLines(progressConfigEntry),
            );
          }
        }
        const alreadyStarted = progressDraftGate.hasStarted;
        await progressDraftGate.noteWork();
        if (alreadyStarted && progressDraftGate.hasStarted) {
          renderProgressDraft();
        }
      };

      const suppressPreviewToolProgressForAnswerText = (text: string | undefined) => {
        if (!text?.trim()) {
          return;
        }
        previewToolProgressSuppressed = true;
        previewToolProgressLines = [];
      };

      const resetPreviewToolProgress = () => {
        previewToolProgressSuppressed = false;
        previewToolProgressLines = [];
      };

      const buildPreviewToolProgressReplyOptions = (): Partial<GetReplyOptions> => {
        if (!shouldSuppressDefaultToolProgressMessages) {
          return {};
        }
        const options: Partial<GetReplyOptions> = {
          suppressDefaultToolProgressMessages: true,
        };
        if (!shouldStreamPreviewToolProgress) {
          return options;
        }
        return {
          ...options,
          onToolStart: async (payload) => {
            const toolName = payload.name?.trim();
            await pushPreviewToolProgress(
              formatChannelProgressDraftLineForEntry(
                progressConfigEntry,
                {
                  event: "tool",
                  name: toolName,
                  phase: payload.phase,
                  args: payload.args,
                },
                payload.detailMode ? { detailMode: payload.detailMode } : undefined,
              ),
              { toolName },
            );
          },
          onItemEvent: async (payload) => {
            await pushPreviewToolProgress(
              formatChannelProgressDraftLineForEntry(progressConfigEntry, {
                event: "item",
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
            await pushPreviewToolProgress(
              formatChannelProgressDraftLine({
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
            await pushPreviewToolProgress(
              formatChannelProgressDraftLine({
                event: "approval",
                phase: payload.phase,
                title: payload.title,
                command: payload.command,
                reason: payload.reason,
                message: payload.message,
              }),
            );
          },
          onCommandOutput: async (payload) => {
            if (payload.phase !== "end") {
              return;
            }
            await pushPreviewToolProgress(
              formatChannelProgressDraftLine({
                event: "command-output",
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
            await pushPreviewToolProgress(
              formatChannelProgressDraftLine({
                event: "patch",
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
        };
      };

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

              if (draftConsumed) {
                await draftStream.discardPending();
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
              let mustDeliverFinalNormally = draftStream.mustDeliverFinalNormally();
              const canPotentiallyFinalizeDraft =
                Boolean(payload.text?.trim()) &&
                !payload.isError &&
                !payloadReplyMismatch &&
                !mustDeliverFinalNormally;

              if (canPotentiallyFinalizeDraft) {
                await draftStream.stop();
                mustDeliverFinalNormally = draftStream.mustDeliverFinalNormally();
              } else {
                await draftStream.discardPending();
              }
              const draftEventId = draftStream.eventId();

              if (
                draftEventId &&
                payload.text &&
                !payload.isError &&
                !hasMedia &&
                !payloadReplyMismatch &&
                !mustDeliverFinalNormally
              ) {
                const finalPreviewText = payload.text;
                await deliverWithFinalizableLivePreviewAdapter<
                  ReplyPayload,
                  string,
                  {
                    text: string;
                    finalizeLive: boolean;
                    extraContent?: Record<string, unknown>;
                  }
                >({
                  kind: "final",
                  payload,
                  adapter: defineFinalizableLivePreviewAdapter({
                    draft: {
                      flush: async () => {},
                      clear: async () => {},
                      discardPending: async () => {},
                      id: () => draftEventId,
                    },
                    buildFinalEdit: () => ({
                      text: finalPreviewText,
                      finalizeLive: !(
                        quietDraftStreaming || !draftStream.matchesPreparedText(finalPreviewText)
                      ),
                      ...(quietDraftStreaming
                        ? { extraContent: buildMatrixFinalizedPreviewContent() }
                        : {}),
                    }),
                    editFinal: async (_draftEventId, edit) => {
                      if (edit.finalizeLive) {
                        if (!(await draftStream.finalizeLive())) {
                          throw new Error("Matrix draft live finalize failed");
                        }
                        return;
                      }
                      const { editMessageMatrix } = await loadMatrixSendModule();
                      await editMessageMatrix(roomId, _draftEventId, edit.text, {
                        client,
                        cfg,
                        threadId: threadTarget,
                        accountId: _route.accountId,
                        extraContent: edit.extraContent,
                      });
                    },
                    createPreviewReceipt: (id): MessageReceipt =>
                      createPreviewMessageReceipt({
                        id,
                        ...(threadTarget ? { threadId: threadTarget } : {}),
                        ...(currentDraftReplyToId ? { replyToId: currentDraftReplyToId } : {}),
                      }),
                    logPreviewEditFailure: (err) => {
                      logVerboseMessage(`matrix: preview final edit failed: ${String(err)}`);
                    },
                  }),
                  deliverNormally: async () => {
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
                  },
                });
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
                  const { editMessageMatrix } = await loadMatrixSendModule();
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
                  Boolean(draftEventId) &&
                  (payload.isError || payloadReplyMismatch || mustDeliverFinalNormally);
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
                const { sendTypingMatrix } = await loadMatrixSendModule();
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
      const pinnedMainDmOwner = isDirectMessage
        ? await (async () => {
            const livePinnedCfg = core.config.current() as CoreConfig;
            const livePinnedAllowlists = resolveMatrixAccountAllowlistConfig({
              cfg: livePinnedCfg,
              accountId,
            });
            const livePinnedDmAllowFrom = await resolveCachedLiveAllowlist({
              cfg: livePinnedCfg,
              entries: livePinnedAllowlists.dmAllowFrom,
              startupResolvedEntries: allowFromResolvedEntries,
              cache: liveDmAllowlistCache,
              updateCache: (next) => {
                liveDmAllowlistCache = next;
              },
            });
            return resolvePinnedMainDmOwnerFromAllowlist({
              dmScope: livePinnedCfg.session?.dmScope,
              allowFrom: livePinnedDmAllowFrom,
              normalizeEntry: normalizeMatrixUserId,
            });
          })()
        : null;

      const turnResult = await core.channel.turn.run({
        channel: "matrix",
        accountId: _route.accountId,
        raw: event,
        adapter: {
          ingest: () => ({
            id: messageId,
            rawText: bodyText,
            textForAgent: ctxPayload.BodyForAgent,
            textForCommands: ctxPayload.CommandBody,
            raw: event,
          }),
          resolveTurn: () => ({
            channel: "matrix",
            accountId: _route.accountId,
            routeSessionKey: _route.sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: core.channel.session.recordInboundSession,
            botLoopProtection,
            record: {
              updateLastRoute: isDirectMessage
                ? {
                    sessionKey: _route.mainSessionKey,
                    channel: "matrix",
                    to: `room:${roomId}`,
                    accountId: _route.accountId,
                    mainDmOwnerPin: pinnedMainDmOwner
                      ? {
                          ownerRecipient: pinnedMainDmOwner,
                          senderRecipient: normalizeMatrixUserId(senderId),
                          onSkip: ({
                            ownerRecipient,
                            senderRecipient,
                          }: {
                            ownerRecipient: string;
                            senderRecipient: string;
                          }) => {
                            logVerboseMessage(
                              `matrix: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                            );
                          },
                        }
                      : undefined,
                  }
                : undefined,
              onRecordError: (err) => {
                logger.warn("failed updating session meta", {
                  error: String(err),
                  storePath,
                  sessionKey: ctxPayload.SessionKey ?? _route.sessionKey,
                });
              },
            },
            onPreDispatchFailure: () =>
              core.channel.reply.settleReplyDispatcher({
                dispatcher,
                onSettled: () => {
                  markRunComplete();
                  markDispatchIdle();
                },
              }),
            runDispatch: async () => {
              if (
                sharedDmContextNotice &&
                markTrackedRoomIfFirst(sharedDmContextNoticeRooms, roomId)
              ) {
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

              return await core.channel.reply.withReplyDispatcher({
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
                              if (progressDraftStreaming) {
                                return;
                              }
                              latestDraftFullText = payload.text ?? "";
                              suppressPreviewToolProgressForAnswerText(latestDraftFullText);
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
                              resetPreviewToolProgress();
                            }
                          : undefined,
                        ...buildPreviewToolProgressReplyOptions(),
                        onModelSelected,
                      },
                    });
                  } finally {
                    progressDraftGate.cancel();
                    markRunComplete();
                  }
                },
              });
            },
          }),
        },
      });
      if (!turnResult.dispatched) {
        if (
          turnResult.admission.kind === "drop" &&
          turnResult.admission.reason === "bot-loop-protection"
        ) {
          await commitInboundEventIfClaimed();
        }
        return;
      }
      const { dispatchResult } = turnResult;
      const { queuedFinal, counts } = dispatchResult;
      if (finalReplyDeliveryFailed) {
        if (retryableReplyDeliveryFailed) {
          logVerboseMessage(
            `matrix: final reply delivery failed room=${roomId} id=${messageId}; leaving event uncommitted`,
          );
          // Explicit retryable failures reopen replay so the same history can be retried.
          return;
        }
        logVerboseMessage(
          `matrix: final reply delivery failed room=${roomId} id=${messageId}; keeping replay committed`,
        );
        await commitInboundEventIfClaimed();
        return;
      }
      if (!queuedFinal && nonFinalReplyDeliveryFailed) {
        if (retryableReplyDeliveryFailed) {
          logVerboseMessage(
            `matrix: non-final reply delivery failed room=${roomId} id=${messageId}; leaving event uncommitted`,
          );
          // Explicit retryable failures reopen replay.
          return;
        }
        logVerboseMessage(
          `matrix: non-final reply delivery failed room=${roomId} id=${messageId}; keeping replay committed`,
        );
        await commitInboundEventIfClaimed();
        return;
      }
      // Advance the per-agent watermark now that the reply succeeded (or no reply was needed).
      // Only advance to the snapshot position — messages added during async processing remain
      // visible for the next trigger.
      if (isRoom && triggerSnapshot) {
        roomHistoryTracker.consumeHistory(_route.agentId, roomId, triggerSnapshot, messageId);
      }
      if (!hasFinalInboundReplyDispatch({ queuedFinal, counts })) {
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
