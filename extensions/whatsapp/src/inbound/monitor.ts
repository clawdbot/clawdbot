// Whatsapp plugin module implements monitor behavior.
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  proto,
  GroupMetadata,
  ReachoutTimelockState,
  WAMessage,
  WAMessageKey,
  WASocket,
} from "baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  formatInboundMediaUnavailableText,
  formatLocationText,
} from "openclaw/plugin-sdk/channel-inbound";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import {
  asDateTimestampMs,
  parseStrictFiniteNumber,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { maybeResolveWhatsAppApprovalReaction } from "../approval-reactions.js";
import { readWebSelfIdentityForDecision, WhatsAppAuthUnstableError } from "../auth-store.js";
import { getRegisteredWhatsAppConnectionController } from "../connection-controller-registry.js";
import { getPrimaryIdentityId, identitiesOverlap, resolveComparableIdentity } from "../identity.js";
import { addWhatsAppImagePreviewFields } from "../image-preview.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { DEFAULT_RECONNECT_POLICY, computeBackoff, sleepWithAbort } from "../reconnect.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { createWaSocket, formatError, getStatusCode, waitForWaConnection } from "../session.js";
import {
  createWhatsAppSocketOperationTimeoutAdapter,
  isWhatsAppSocketOperationTimeoutError,
  resolveWhatsAppSocketOperationTimeoutMs,
  resolveWhatsAppSocketTiming,
  withWhatsAppSocketOperationTimeout,
  type WhatsAppSocketOperationAdapter,
  type WhatsAppSocketTimingOptions,
} from "../socket-timing.js";
import {
  resolveEquivalentWhatsAppDirectChatJids,
  resolveJidToE164,
  toWhatsappJid,
  toWhatsappJidWithLid,
} from "../text-runtime.js";
import {
  checkInboundAccessControl,
  type AcceptedInboundAccessControlResult,
} from "./access-control.js";
import {
  requireAdmittedWhatsAppInboundMessage,
  requireWhatsAppInboundAdmission,
} from "./admission.js";
import {
  claimRecentInboundMessageDelivery,
  commitRecentInboundMessage,
  isRecentOutboundMessage,
  releaseRecentInboundMessage,
  rememberRecentOutboundMessage,
  WhatsAppRetryableInboundError,
} from "./dedupe.js";
import {
  createWhatsAppDurableInboundMessageId,
  createWhatsAppDurableInboundReceiveJournal,
  deserializeWhatsAppDurableInboundMessage,
  serializeWhatsAppDurableInboundMessage,
  type WhatsAppDurableInboundMetadata,
  type WhatsAppDurableInboundPayload,
  type WhatsAppReadReceiptTarget,
} from "./durable-receive.js";
import {
  describeReplyContext,
  extractExternalAdReplyContext,
  extractLocationData,
  extractContactContext,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
  hasInboundUserContent,
} from "./extract.js";
import { attachEmitterListener, closeInboundMonitorSocket } from "./lifecycle.js";
import { downloadInboundMedia, downloadQuotedInboundMedia } from "./media.js";
import {
  normalizeWebInboundMessage,
  withDeprecatedWebInboundMessageFlatAliases,
} from "./message-aliases.js";
import {
  addWhatsAppOutboundMentionsToContent,
  mayContainWhatsAppOutboundMention,
  resolveWhatsAppOutboundMentions,
  type WhatsAppOutboundMentionParticipant,
} from "./outbound-mentions.js";
import { DisconnectReason, isJidGroup } from "./runtime-api.js";
import { createWebSendApi } from "./send-api.js";
import { normalizeWhatsAppSendResult } from "./send-result.js";
import type {
  AdmittedWebInboundMessage,
  WebInboundMessage,
  WebInboundMessageInput,
  WebListenerCloseReason,
} from "./types.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";
const GROUP_META_TTL_MS = 5 * 60 * 1000;
const BAILEYS_MESSAGE_TTL_MS = 10 * 60 * 1000;
const INBOUND_CLOSE_DRAIN_TIMEOUT_MS = 5_000;
const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;
export const WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES = 500;

type WhatsAppGroupMetadataCacheEntry = {
  subject?: string;
  expires: number;
};

function resolveRetryableWhatsAppInboundError(
  error: unknown,
): WhatsAppRetryableInboundError | null {
  if (error instanceof WhatsAppRetryableInboundError) {
    return error;
  }
  const hasSessionInitConflict = collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.error,
  ]).some((candidate) =>
    REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(formatErrorMessage(candidate)),
  );
  if (!hasSessionInitConflict) {
    return null;
  }
  return new WhatsAppRetryableInboundError(formatErrorMessage(error), { cause: error });
}
export type WhatsAppGroupMetadataCache = Map<string, WhatsAppGroupMetadataCacheEntry>;
export type WhatsAppBaileysCacheEntry<T> = {
  expiresAt: number;
  value: T;
};
export type WhatsAppBaileysMessageCache = Map<string, WhatsAppBaileysCacheEntry<proto.IMessage>>;
export type WhatsAppBaileysGroupMetadataCache = Map<
  string,
  WhatsAppBaileysCacheEntry<GroupMetadata>
>;
type LocalGroupMetadataCacheEntry = WhatsAppGroupMetadataCacheEntry & {
  participants?: string[];
  mentionParticipants?: WhatsAppOutboundMentionParticipant[];
};

function resolveGroupMetadataExpiresAt(nowRaw = Date.now()): number | undefined {
  const now = asDateTimestampMs(nowRaw);
  return now === undefined
    ? undefined
    : resolveExpiresAtMsFromDurationMs(GROUP_META_TTL_MS, { nowMs: now });
}

function parseWhatsAppTimestampSeconds(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return parseStrictFiniteNumber(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rememberGroupMetadataCacheEntry<T extends WhatsAppGroupMetadataCacheEntry>(
  cache: Map<string, T>,
  jid: string,
  entry: T,
): void {
  if (asDateTimestampMs(entry.expires) === undefined) {
    cache.delete(jid);
    return;
  }
  if (cache.has(jid)) {
    cache.delete(jid);
  }
  cache.set(jid, entry);

  while (cache.size > WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.delete(oldest.value);
  }
}

function readGroupMetadataCacheEntry<T extends WhatsAppGroupMetadataCacheEntry>(
  cache: Map<string, T>,
  jid: string,
): T | null {
  const entry = cache.get(jid);
  if (!entry) {
    return null;
  }
  const now = asDateTimestampMs(Date.now());
  const expires = asDateTimestampMs(entry.expires);
  if (now === undefined || expires === undefined || expires <= now) {
    cache.delete(jid);
    return null;
  }
  cache.delete(jid);
  cache.set(jid, entry);
  return entry;
}

function rememberWhatsAppBaileysCacheEntry<T>(
  cache: Map<string, WhatsAppBaileysCacheEntry<T>> | undefined,
  key: string,
  value: T,
  ttlMs: number,
): void {
  if (!cache) {
    return;
  }
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
  while (cache.size > WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.delete(oldest.value);
  }
}

export function readWhatsAppBaileysCacheEntry<T>(
  cache: Map<string, WhatsAppBaileysCacheEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function logWhatsAppVerbose(enabled: boolean | undefined, message: string) {
  if (!enabled) {
    return;
  }
  defaultRuntime.log(message);
}

function isGroupJid(jid: string): boolean {
  return (typeof isJidGroup === "function" ? isJidGroup(jid) : jid.endsWith("@g.us")) === true;
}

function isDirectUserJid(jid: string): boolean {
  return /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us|lid|hosted|hosted\.lid)$/i.test(jid.trim());
}

function getActiveReachoutTimelock(
  state: ReachoutTimelockState | undefined,
): ReachoutTimelockState | undefined {
  if (state?.isActive !== true) {
    return undefined;
  }
  const endsAt = state.timeEnforcementEnds?.getTime();
  return endsAt === undefined || !Number.isFinite(endsAt) || endsAt > Date.now()
    ? state
    : undefined;
}

function formatReachoutTimelockError(state: ReachoutTimelockState): string {
  const details = [
    state.enforcementType ? `type=${state.enforcementType}` : undefined,
    state.timeEnforcementEnds instanceof Date &&
    Number.isFinite(state.timeEnforcementEnds.getTime())
      ? `until=${state.timeEnforcementEnds.toISOString()}`
      : undefined,
  ].filter(Boolean);
  return `WhatsApp reachout timelock is active; direct messages are temporarily blocked${details.length ? ` (${details.join(", ")})` : ""}`;
}

function recordAcceptedInboundActivity(accountId: string): void {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "inbound",
  });
}

function isRetryableSendDisconnectError(err: unknown): boolean {
  if (isWhatsAppSocketOperationTimeoutError(err)) {
    return false;
  }
  return /closed|reset|timed\s*out|disconnect|no active socket/i.test(formatError(err));
}

function shouldClearSocketRefAfterSendFailure(err: unknown): boolean {
  return /closed|reset|disconnect|no active socket/i.test(formatError(err));
}

function isNonEmptyString(value: string | undefined): value is string {
  return Boolean(value);
}

type AdmittedWebInboundCallbackMessage = WebInboundMessage & {
  admission: AdmittedWebInboundMessage["admission"];
};

type AppendReplyWindow = {
  afterMs: number;
  untilMs: number;
  maxAgeMs: number;
};

type MonitorWebInboxOptions = {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  socketTiming?: Required<WhatsAppSocketTimingOptions>;
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: AdmittedWebInboundCallbackMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Keep the global presence unavailable so self-chat sessions do not mute phone pushes. */
  selfChatMode?: boolean;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Bounded reconnect window for offline append auto-replies. */
  appendReplyWindow?: AppendReplyWindow;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: AdmittedWebInboundCallbackMessage) => boolean;
  /** Optional shared socket reference so reply closures can follow reconnects. */
  socketRef?: { current: WASocket | null };
  /** Whether send retries should wait for a reconnect. */
  shouldRetryDisconnect?: () => boolean;
  /** Reconnect timing for waiting through transient socket replacement gaps. */
  disconnectRetryPolicy?: {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
    maxAttempts: number;
  };
  /** Abort in-flight reconnect waits when shutdown becomes terminal. */
  disconnectRetryAbortSignal?: AbortSignal;
  /** Shared group metadata cache used only for inbound metadata fallback after fetch failures. */
  groupMetadataCache?: WhatsAppGroupMetadataCache;
  recentMessageKeys?: WhatsAppBaileysMessageCache;
  baileysGroupMetaCache?: WhatsAppBaileysGroupMetadataCache;
  onPendingWorkChanged?: (pendingWorkCount: number, at?: number) => void;
};

type AttachWebInboxToSocketOptions = Omit<
  MonitorWebInboxOptions,
  "onMessage" | "shouldDebounce" | "socketTiming"
> & {
  socketTiming: Required<WhatsAppSocketTimingOptions>;
  onMessage: (msg: WebInboundMessageInput) => Promise<void>;
  shouldDebounce?: (msg: WebInboundMessageInput) => boolean;
};

export async function attachWebInboxToSocket(
  options: AttachWebInboxToSocketOptions & {
    sock: WASocket;
  },
) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = options.sock;
  const connectedAtMs = Date.now();
  if (options.socketRef) {
    options.socketRef.current = sock;
  }
  const shouldRetryDisconnect = () => options.shouldRetryDisconnect?.() === true;
  const disconnectRetryPolicy = options.disconnectRetryPolicy ?? DEFAULT_RECONNECT_POLICY;
  const sendRetryMaxAttempts =
    disconnectRetryPolicy.maxAttempts > 0
      ? disconnectRetryPolicy.maxAttempts
      : DEFAULT_RECONNECT_POLICY.maxAttempts;
  const sendOperationTimeoutMs = resolveWhatsAppSocketOperationTimeoutMs(
    options.socketTiming.defaultQueryTimeoutMs,
  );

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };
  const presence = options.selfChatMode ? "unavailable" : "available";

  try {
    await createWhatsAppSocketOperationTimeoutAdapter(
      sock,
      sendOperationTimeoutMs,
    ).sendPresenceUpdate(presence);
    logWhatsAppVerbose(options.verbose, `Sent global '${presence}' presence on connect`);
  } catch (err) {
    logWhatsAppVerbose(
      options.verbose,
      `Failed to send '${presence}' presence on connect: ${String(err)}`,
    );
  }

  const selfIdentity = await readWebSelfIdentityForDecision(
    options.authDir,
    sock.user as { id?: string | null; lid?: string | null } | undefined,
  );
  if (selfIdentity.outcome === "unstable") {
    throw new WhatsAppAuthUnstableError(
      "WhatsApp auth state is still stabilizing; retrying inbox attach.",
    );
  }
  const self = selfIdentity.identity;
  // If this monitor's controller is shutdown while a captured reply is still in
  // flight, only hand off to a successor controller authenticated as the same
  // WhatsApp identity. Missing or mismatched identity fails closed.
  const getCurrentSock = (): WASocket | null => {
    if (!options.socketRef) {
      return sock;
    }
    if (options.socketRef.current) {
      return options.socketRef.current;
    }
    if (!self.e164 && !self.jid && !self.lid) {
      return null;
    }
    const successor = getRegisteredWhatsAppConnectionController(options.accountId);
    if (!successor) {
      return null;
    }
    const successorIdentity = successor.getSelfIdentity();
    if (!successorIdentity || !identitiesOverlap(self, successorIdentity)) {
      return null;
    }
    return successor.getCurrentSock();
  };
  type QueuedInboundMessageMetadata = {
    admission: AdmittedWebInboundCallbackMessage["admission"];
    dedupeKey?: string;
    debounceKey?: string;
    durableId?: string;
    readReceipt?: WhatsAppReadReceiptTarget;
    receiveOrder?: number;
  };
  type QueuedInboundMessage = AdmittedWebInboundCallbackMessage & QueuedInboundMessageMetadata;
  const durableInboundJournal = createWhatsAppDurableInboundReceiveJournal(options.accountId);
  const inboundDebounceMs = Math.max(0, Math.trunc(options.debounceMs ?? 0));
  const pendingDebounceKeys = new Set<string>();
  const activeInboundFlushes = new Set<Promise<void>>();
  const pendingMessageHandlers = new Set<Promise<void>>();
  let nextReceiveOrder = 0;
  const publishPendingWorkState = (at = Date.now()) => {
    options.onPendingWorkChanged?.(
      pendingMessageHandlers.size + pendingDebounceKeys.size + activeInboundFlushes.size,
      at,
    );
  };
  const buildInboundDebounceKey = (msg: QueuedInboundMessage): string | null => {
    const admission = requireWhatsAppInboundAdmission(msg);
    const sender = msg.platform.sender;
    const senderKey =
      admission.conversation.kind === "group"
        ? (getPrimaryIdentityId(sender ?? null) ??
          msg.platform.senderJid ??
          msg.platform.senderE164 ??
          msg.platform.senderName ??
          admission.sender.id)
        : admission.conversation.id;
    if (!senderKey) {
      return null;
    }
    return `${admission.accountId}:${admission.conversation.id}:${senderKey}`;
  };
  const shouldDebounceInboundMessage = (msg: AdmittedWebInboundCallbackMessage): boolean =>
    options.shouldDebounce?.(msg) ?? true;
  const orderDebouncedInboundEntries = (entries: QueuedInboundMessage[]) =>
    entries.toSorted((a, b) => {
      const timestampDiff = (a.event.timestamp ?? 0) - (b.event.timestamp ?? 0);
      if (timestampDiff !== 0) {
        return timestampDiff;
      }
      return (a.receiveOrder ?? 0) - (b.receiveOrder ?? 0);
    });

  const finalizeInboundDelivery = async (
    entries: QueuedInboundMessage[],
    error?: unknown,
  ): Promise<void> => {
    const dedupeKeys = uniqueStrings(
      entries.map((entry) => entry.dedupeKey).filter(isNonEmptyString),
    );
    const durableEntries = entries.filter(
      (entry): entry is QueuedInboundMessage & { durableId: string } =>
        isNonEmptyString(entry.durableId),
    );
    const readReceiptEntries = entries.filter(
      (entry): entry is QueuedInboundMessage & { readReceipt: WhatsAppReadReceiptTarget } =>
        Boolean(entry.readReceipt),
    );
    const retryableError = resolveRetryableWhatsAppInboundError(error);
    if (retryableError) {
      dedupeKeys.forEach((dedupeKey) => releaseRecentInboundMessage(dedupeKey, retryableError));
      await Promise.all(
        durableEntries.map((entry) =>
          durableInboundJournal.release(entry.durableId, {
            lastError: formatError(retryableError),
          }),
        ),
      );
      return;
    }
    await Promise.all([
      ...dedupeKeys.map((dedupeKey) => commitRecentInboundMessage(dedupeKey)),
      ...durableEntries.map((entry) =>
        durableInboundJournal.complete(
          entry.durableId,
          entry.readReceipt ? { metadata: { readReceipt: entry.readReceipt } } : undefined,
        ),
      ),
    ]);
    await Promise.all(readReceiptEntries.map((entry) => maybeMarkInboundAsRead(entry.readReceipt)));
  };

  const debouncer = createInboundDebouncer<QueuedInboundMessage>({
    debounceMs: inboundDebounceMs,
    buildKey: (msg) => msg.debounceKey ?? buildInboundDebounceKey(msg),
    shouldDebounce: shouldDebounceInboundMessage,
    onFlush: async (entries) => {
      let finishFlush!: () => void;
      const flushTask = new Promise<void>((resolve) => {
        finishFlush = resolve;
      });
      activeInboundFlushes.add(flushTask);
      publishPendingWorkState();
      try {
        const orderedEntries = orderDebouncedInboundEntries(entries);
        const last = orderedEntries.at(-1);
        if (!last) {
          return;
        }
        try {
          if (orderedEntries.length === 1) {
            await options.onMessage(last);
            await finalizeInboundDelivery(orderedEntries);
            return;
          }
          const mentioned = new Set<string>();
          for (const entry of orderedEntries) {
            for (const jid of entry.group?.mentions?.jids ?? []) {
              mentioned.add(jid);
            }
          }
          const combinedBody = orderedEntries
            .map((entry) => entry.payload.body)
            .filter(Boolean)
            .join("\n");
          const combinedCommandBody = orderedEntries
            .map((entry) => entry.payload.commandBody ?? entry.payload.body)
            .filter(Boolean)
            .join("\n");
          const combinedMentions =
            mentioned.size > 0
              ? {
                  ...last.group?.mentions,
                  jids: Array.from(mentioned),
                }
              : last.group?.mentions;
          const combinedGroup =
            last.group || combinedMentions
              ? {
                  ...last.group,
                  mentions: combinedMentions,
                }
              : undefined;
          const combinedMessage: QueuedInboundMessage = withDeprecatedWebInboundMessageFlatAliases({
            ...last,
            payload: {
              ...last.payload,
              body: combinedBody,
              commandBody: combinedCommandBody,
            },
            group: combinedGroup,
            event: {
              ...last.event,
              isBatched: true,
            },
          });
          await options.onMessage(combinedMessage);
          await finalizeInboundDelivery(orderedEntries);
        } catch (error) {
          await finalizeInboundDelivery(orderedEntries, error);
          throw error;
        }
      } finally {
        for (const entry of entries) {
          if (entry.debounceKey) {
            pendingDebounceKeys.delete(entry.debounceKey);
          }
        }
        activeInboundFlushes.delete(flushTask);
        finishFlush();
        publishPendingWorkState();
      }
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetadataCache = options.groupMetadataCache ?? new Map();
  const groupMetaCache = new Map<string, LocalGroupMetadataCacheEntry>();
  const lidLookup = sock.signalRepository?.lidMapping;
  const publishedGroupMetadataJids = new Set<string>();
  const invalidatedGroupMetadataJids = new Set<string>();
  let groupMetadataCacheClosed = false;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });
  const resolveReactionTargetJids = async (jid: string): Promise<string[]> =>
    resolveEquivalentWhatsAppDirectChatJids(jid, { authDir: options.authDir, lidLookup });

  const rememberBaileysMessage = (
    remoteJid: string | null | undefined,
    messageId: string | null | undefined,
    message: proto.IMessage | null | undefined,
  ) => {
    if (!options.recentMessageKeys || !remoteJid || !messageId || !message) {
      return;
    }
    rememberWhatsAppBaileysCacheEntry(
      options.recentMessageKeys,
      `${remoteJid}:${messageId}`,
      message,
      BAILEYS_MESSAGE_TTL_MS,
    );
  };

  const rememberOutboundMessage = (remoteJid: string, result: unknown) => {
    const messageId =
      typeof result === "object" && result && "key" in result
        ? ((result as { key?: { id?: string } }).key?.id ?? "")
        : "";
    if (!messageId) {
      return;
    }
    rememberRecentOutboundMessage({
      accountId: options.accountId,
      remoteJid,
      messageId,
    });
    const message =
      typeof result === "object" && result && "message" in result
        ? (result as { message?: proto.IMessage }).message
        : undefined;
    rememberBaileysMessage(remoteJid, messageId, message);
    // Baileys derives the participant for fromMe quotes from its own userJid.
    // Retain only the facts needed to avoid the cache-miss fromMe=false fallback.
    cacheInboundMessageMeta(options.accountId, remoteJid, messageId, {
      fromMe: true,
      body: extractText(message ?? undefined),
    });
  };
  const trackLateAcceptedSend = (jid: string, promise: Promise<WAMessage | undefined>) => {
    // The local send has failed terminally, but Baileys may still deliver it.
    // Track a late message id only to suppress the resulting self-echo.
    void promise.then(
      (result) => {
        rememberOutboundMessage(jid, result);
      },
      () => {},
    );
  };
  let reachoutTimeLock: ReachoutTimelockState | undefined;
  let reachoutTimeLockFetch: Promise<ReachoutTimelockState | undefined> | undefined;
  let reachoutTimeLockVersion = 0;
  let verifiedSendReady:
    | { jid: string; sock: WASocket; reachoutTimeLockVersion: number }
    | undefined;
  const rememberReachoutTimeLock = (state: ReachoutTimelockState | undefined) => {
    reachoutTimeLock = state;
    reachoutTimeLockVersion += 1;
    verifiedSendReady = undefined;
  };
  const fetchReachoutTimeLock = async (
    currentSock: WASocket,
  ): Promise<ReachoutTimelockState | undefined> => {
    if (typeof currentSock.fetchAccountReachoutTimelock !== "function") {
      return undefined;
    }
    if (!reachoutTimeLockFetch) {
      reachoutTimeLockFetch = currentSock
        .fetchAccountReachoutTimelock()
        .then((state) => {
          rememberReachoutTimeLock(state);
          return state;
        })
        .catch((err: unknown) => {
          logWhatsAppVerbose(
            options.verbose,
            `Failed fetching WhatsApp reachout timelock before send: ${formatError(err)}`,
          );
          return undefined;
        })
        .finally(() => {
          reachoutTimeLockFetch = undefined;
        });
    }
    return await reachoutTimeLockFetch;
  };
  const rememberVerifiedSendReady = (jid: string, currentSock: WASocket) => {
    verifiedSendReady = {
      jid,
      sock: currentSock,
      reachoutTimeLockVersion,
    };
  };
  const consumeVerifiedSendReady = (jid: string, currentSock: WASocket): boolean => {
    if (
      verifiedSendReady?.jid !== jid ||
      verifiedSendReady.sock !== currentSock ||
      verifiedSendReady.reachoutTimeLockVersion !== reachoutTimeLockVersion
    ) {
      return false;
    }
    verifiedSendReady = undefined;
    return true;
  };
  const assertCanSendToJid = async (
    jid: string,
    currentSock: WASocket,
    readinessOptions?: { rememberReady?: boolean; useVerifiedReady?: boolean },
  ) => {
    if (!isDirectUserJid(jid)) {
      return;
    }
    if (readinessOptions?.useVerifiedReady && consumeVerifiedSendReady(jid, currentSock)) {
      return;
    }
    const state =
      getActiveReachoutTimelock(reachoutTimeLock) ?? (await fetchReachoutTimeLock(currentSock));
    const activeState = getActiveReachoutTimelock(state);
    if (activeState) {
      throw new Error(formatReachoutTimelockError(activeState));
    }
    if (readinessOptions?.rememberReady && state) {
      // The top-level direct send checks readiness before typing; consume this
      // same socket/JID/version proof at the native send so inactive accounts
      // are not queried twice for one outbound action.
      rememberVerifiedSendReady(jid, currentSock);
    }
  };
  const assertCanSendTo = async (to: string) => {
    const currentSock = getCurrentSock();
    if (!currentSock) {
      throw new Error(RECONNECT_IN_PROGRESS_ERROR);
    }
    const jid = options.authDir
      ? toWhatsappJidWithLid(to, { authDir: options.authDir })
      : toWhatsappJid(to);
    await assertCanSendToJid(jid, currentSock, { rememberReady: true });
  };

  const sendTrackedMessage = async (
    jid: string,
    content: AnyMessageContent,
    sendOptions?: MiscMessageGenerationOptions,
  ) => {
    let lastErr: unknown = new Error(RECONNECT_IN_PROGRESS_ERROR);
    for (let attempt = 1; ; attempt++) {
      const currentSock = getCurrentSock();
      if (currentSock) {
        try {
          await assertCanSendToJid(jid, currentSock, { useVerifiedReady: true });
          const result = await createWhatsAppSocketOperationTimeoutAdapter(
            currentSock,
            sendOperationTimeoutMs,
            {
              onSendMessageTimeout: ({ jid: timedOutJid, promise }) => {
                trackLateAcceptedSend(timedOutJid, promise);
              },
            },
          ).sendMessage(jid, content, sendOptions);
          rememberOutboundMessage(jid, result);
          return result;
        } catch (err) {
          if (!shouldRetryDisconnect() || !isRetryableSendDisconnectError(err)) {
            throw err;
          }
          lastErr = err;
          if (
            shouldClearSocketRefAfterSendFailure(err) &&
            options.socketRef?.current === currentSock
          ) {
            options.socketRef.current = null;
          }
        }
      } else if (!shouldRetryDisconnect()) {
        throw lastErr;
      }

      if (attempt >= sendRetryMaxAttempts) {
        throw lastErr;
      }
      const delayMs = computeBackoff(disconnectRetryPolicy, attempt);
      logWhatsAppVerbose(
        options.verbose,
        `Waiting ${delayMs}ms for WhatsApp reconnect before retrying send to ${jid}: ${formatError(lastErr)}`,
      );
      try {
        await sleepWithAbort(delayMs, options.disconnectRetryAbortSignal);
      } catch {
        throw lastErr;
      }
    }
  };
  const sendApiSocketOperations: WhatsAppSocketOperationAdapter = {
    sendMessage: (jid, content, sendOptions) => sendTrackedMessage(jid, content, sendOptions),
    sendPresenceUpdate: async (presenceLocal, jid) => {
      const currentSock = getCurrentSock();
      if (!currentSock) {
        throw new Error(RECONNECT_IN_PROGRESS_ERROR);
      }
      return await createWhatsAppSocketOperationTimeoutAdapter(
        currentSock,
        sendOperationTimeoutMs,
      ).sendPresenceUpdate(presenceLocal, jid);
    },
  };

  const summarizeGroupMeta = async (meta: GroupMetadata) => {
    const participantEntries = await Promise.all(
      meta.participants?.map(async (p) => {
        const mapped = await resolveInboundJid(p.id);
        return {
          display: mapped ?? p.id,
          mention: {
            id: p.id,
            lid: p.lid,
            phoneNumber: p.phoneNumber,
            e164: mapped,
          } satisfies WhatsAppOutboundMentionParticipant,
        };
      }) ?? [],
    );
    const participants = participantEntries.map((entry) => entry.display).filter(Boolean);
    const mentionParticipants = participantEntries.map((entry) => entry.mention);
    return {
      subject: meta.subject,
      participants,
      mentionParticipants,
      expires: resolveGroupMetadataExpiresAt() ?? 0,
    };
  };

  const summarizeGroupMetaForReconnectCache = (
    meta: GroupMetadata,
  ): WhatsAppGroupMetadataCacheEntry => ({
    subject: meta.subject,
    expires: resolveGroupMetadataExpiresAt() ?? Number.NaN,
  });

  const getGroupMeta = async (jid: string) => {
    const cached = readGroupMetadataCacheEntry(groupMetaCache, jid);
    if (cached) {
      return cached;
    }
    try {
      const meta = await (getCurrentSock() ?? sock).groupMetadata(jid);
      rememberWhatsAppBaileysCacheEntry(
        options.baileysGroupMetaCache,
        jid,
        meta,
        GROUP_META_TTL_MS,
      );
      publishedGroupMetadataJids.add(jid);
      const entry = await summarizeGroupMeta(meta);
      rememberGroupMetadataCacheEntry(groupMetadataCache, jid, {
        subject: entry.subject,
        expires: entry.expires,
      });
      rememberGroupMetadataCacheEntry(groupMetaCache, jid, entry);
      return entry;
    } catch (err) {
      const hydrated = readGroupMetadataCacheEntry(groupMetadataCache, jid);
      if (hydrated) {
        rememberGroupMetadataCacheEntry(groupMetaCache, jid, hydrated);
        logWhatsAppVerbose(
          options.verbose,
          `Using cached group metadata for ${jid} after fetch failure: ${String(err)}`,
        );
        return hydrated;
      }
      logWhatsAppVerbose(
        options.verbose,
        `Failed to fetch group metadata for ${jid}: ${String(err)}`,
      );
      return { expires: resolveGroupMetadataExpiresAt() ?? 0 };
    }
  };

  const resolveOutboundMentionsForGroup = async (
    jid: string,
    text: string,
  ): Promise<{ text: string; mentionedJids: string[] }> => {
    if (!isGroupJid(jid) || !mayContainWhatsAppOutboundMention(text)) {
      return { text, mentionedJids: [] };
    }
    const meta = await getGroupMeta(jid);
    return resolveWhatsAppOutboundMentions({
      chatJid: jid,
      text,
      participants: meta.mentionParticipants,
    });
  };

  const applyOutboundMentionsToContent = async (
    jid: string,
    content: AnyMessageContent,
  ): Promise<AnyMessageContent> => {
    if ("text" in content && typeof content.text === "string") {
      const resolved = await resolveOutboundMentionsForGroup(jid, content.text);
      return addWhatsAppOutboundMentionsToContent(
        { ...content, text: resolved.text } as AnyMessageContent,
        resolved.mentionedJids,
      );
    }
    const caption = (content as { caption?: unknown }).caption;
    if (typeof caption === "string") {
      const resolved = await resolveOutboundMentionsForGroup(jid, caption);
      return addWhatsAppOutboundMentionsToContent(
        { ...content, caption: resolved.text } as AnyMessageContent,
        resolved.mentionedJids,
      );
    }
    return content;
  };

  type NormalizedInboundMessage = {
    id?: string;
    remoteJid: string;
    group: boolean;
    participantJid?: string;
    from: string;
    senderE164: string | null;
    groupSubject?: string;
    groupParticipants?: string[];
    messageTimestampMs?: number;
    access: AcceptedInboundAccessControlResult;
  };

  const normalizeInboundMessage = async (
    msg: WAMessage,
  ): Promise<NormalizedInboundMessage | null> => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      return null;
    }
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    const group = isGroupJid(remoteJid);
    // Drop echoes of messages the gateway itself sent (tracked by sendTrackedMessage).
    // Applies to both groups and DMs/self-chat — without this, self-chat mode
    // re-processes the bot's own replies as new inbound user messages.
    if (
      Boolean(msg.key?.fromMe) &&
      id &&
      isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        messageId: id,
      })
    ) {
      logWhatsAppVerbose(
        options.verbose,
        `Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`,
      );
      return null;
    }
    // Gate pairing access-control on extractable inbound user content. Baileys
    // delivers receipts, typing indicators, presence updates, and protocol
    // messages on the same `messages.upsert` stream as real messages; without
    // this gate, `checkInboundAccessControl` can send an unsolicited pairing
    // verification reply to a `dmPolicy: pairing` peer who never typed
    // anything (e.g. when Master sends an outbound message to a new JID and
    // the receipt round-trip arrives before the recipient ever replies).
    // Echoes of our own outbound messages are already handled above.
    if (!hasInboundUserContent(msg.message ?? undefined)) {
      return null;
    }

    const participantJid = msg.key?.participant ?? undefined;
    const from = group ? remoteJid : await resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group
      ? participantJid
        ? await resolveInboundJid(participantJid)
        : null
      : from;

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await getGroupMeta(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampSeconds = parseWhatsAppTimestampSeconds(msg.messageTimestamp);
    const messageTimestampMs =
      messageTimestampSeconds !== undefined ? messageTimestampSeconds * 1000 : undefined;

    const accessCfg = options.loadConfig?.() ?? options.cfg;
    const access = await checkInboundAccessControl({
      cfg: accessCfg,
      accountId: options.accountId,
      from,
      selfE164: self.e164 ?? null,
      senderE164,
      senderJid: participantJid,
      group,
      pushName: msg.pushName ?? undefined,
      isFromMe: Boolean(msg.key?.fromMe),
      messageTimestampMs,
      connectedAtMs,
      verbose: options.verbose,
      sock: {
        sendMessage: (jid: string, content: AnyMessageContent) => sendTrackedMessage(jid, content),
      },
      remoteJid,
    });
    if (!access.allowed) {
      return null;
    }

    return {
      id,
      remoteJid,
      group,
      participantJid,
      from,
      senderE164,
      groupSubject,
      groupParticipants,
      messageTimestampMs,
      access,
    };
  };

  const buildReadReceiptTarget = (
    inbound: NormalizedInboundMessage,
  ): WhatsAppReadReceiptTarget | undefined =>
    inbound.id
      ? {
          remoteJid: inbound.remoteJid,
          id: inbound.id,
          ...(inbound.participantJid ? { participant: inbound.participantJid } : {}),
        }
      : undefined;

  const maybeMarkInboundAsRead = async (target: WhatsAppReadReceiptTarget | undefined) => {
    if (!target || options.sendReadReceipts === false) {
      return;
    }
    const { id, remoteJid, participant } = target;
    try {
      await withWhatsAppSocketOperationTimeout(
        "readMessages",
        (getCurrentSock() ?? sock).readMessages([{ remoteJid, id, participant, fromMe: false }]),
        sendOperationTimeoutMs,
      );
      const suffix = participant ? ` (participant ${participant})` : "";
      logWhatsAppVerbose(options.verbose, `Marked message ${id} as read for ${remoteJid}${suffix}`);
    } catch (err) {
      logWhatsAppVerbose(options.verbose, `Failed to mark message ${id} read: ${String(err)}`);
    }
  };

  const maybeLogSkippedSelfChatReadReceipt = (
    inbound: NormalizedInboundMessage,
    target: WhatsAppReadReceiptTarget | undefined,
  ) => {
    if (target?.id && inbound.access.isSelfChat && options.verbose) {
      // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
      logWhatsAppVerbose(options.verbose, `Self-chat mode: skipping read receipt for ${target.id}`);
    }
  };

  const maybeMarkNonSelfChatReadReceipt = async (
    inbound: NormalizedInboundMessage,
    target: WhatsAppReadReceiptTarget | undefined,
  ) => {
    if (inbound.access.isSelfChat) {
      maybeLogSkippedSelfChatReadReceipt(inbound, target);
      return;
    }
    await maybeMarkInboundAsRead(target);
  };

  const completeUndeliverableDurableInbound = async (
    durableId: string | undefined,
    metadata: WhatsAppDurableInboundMetadata | undefined,
  ) => {
    if (!durableId) {
      return;
    }
    await durableInboundJournal.complete(
      durableId,
      metadata?.readReceipt ? { metadata: { readReceipt: metadata.readReceipt } } : undefined,
    );
  };

  const buildDurableInboundPayload = (
    msg: WAMessage,
    upsertType: string | undefined,
  ): WhatsAppDurableInboundPayload => ({
    message: serializeWhatsAppDurableInboundMessage(msg),
    ...(upsertType ? { upsertType } : {}),
    receivedAt: Date.now(),
  });

  const shouldSkipStaleAppend = (msg: WAMessage, upsertType: string | undefined): boolean => {
    if (upsertType !== "append") {
      return false;
    }
    const APPEND_RECENT_GRACE_MS = 60_000;
    const msgTsSeconds = parseWhatsAppTimestampSeconds(msg.messageTimestamp);
    const msgTsMs = msgTsSeconds !== undefined ? msgTsSeconds * 1000 : 0;
    // Reconnect catch-up is temporary; after it expires, preserve steady-state
    // handling for fresh appends instead of rejecting every later append.
    const nowMs = Date.now();
    const appendAfterMs =
      options.appendReplyWindow && nowMs <= options.appendReplyWindow.untilMs
        ? Math.max(options.appendReplyWindow.afterMs, nowMs - options.appendReplyWindow.maxAgeMs)
        : connectedAtMs - APPEND_RECENT_GRACE_MS;
    return msgTsMs < appendAfterMs;
  };

  const processDurableInboundMessage = async (
    msg: WAMessage,
    upsertType: string | undefined,
    receiveOrder: number | undefined,
    stored?: {
      id: string;
      payload: WhatsAppDurableInboundPayload;
      metadata?: WhatsAppDurableInboundMetadata;
    },
  ) => {
    const inbound = await normalizeInboundMessage(msg);
    if (!inbound) {
      if (stored) {
        await completeUndeliverableDurableInbound(stored.id, stored.metadata);
      }
      return;
    }

    const readReceipt = stored?.metadata?.readReceipt ?? buildReadReceiptTarget(inbound);
    const deliveryReadReceipt = inbound.access.isSelfChat ? undefined : readReceipt;

    if (!stored && shouldSkipStaleAppend(msg, upsertType)) {
      await maybeMarkNonSelfChatReadReceipt(inbound, readReceipt);
      return;
    }

    let durableId =
      stored?.id ??
      (inbound.id
        ? createWhatsAppDurableInboundMessageId({
            remoteJid: inbound.remoteJid,
            id: inbound.id,
          })
        : undefined);
    const durableMetadata: WhatsAppDurableInboundMetadata | undefined = deliveryReadReceipt
      ? { readReceipt: deliveryReadReceipt }
      : undefined;

    if (durableId && !stored) {
      try {
        const accepted = await durableInboundJournal.accept(
          durableId,
          buildDurableInboundPayload(msg, upsertType),
          {
            metadata: durableMetadata,
            receivedAt: inbound.messageTimestampMs,
          },
        );
        if (accepted.kind === "completed") {
          await maybeMarkNonSelfChatReadReceipt(
            inbound,
            accepted.record.metadata?.readReceipt ?? deliveryReadReceipt,
          );
          return;
        }
        if (accepted.kind === "pending" && accepted.record.attempts === 0) {
          return;
        }
      } catch (err) {
        durableId = undefined;
        const error = formatError(err);
        inboundLogger.warn(
          { error },
          "failed persisting durable WhatsApp inbound; delivering live",
        );
        inboundConsoleLog.warn(
          `Failed persisting durable WhatsApp inbound; delivering live: ${error}`,
        );
      }
    }

    const enriched = await enrichInboundMessage(msg);
    if (!enriched) {
      await completeUndeliverableDurableInbound(durableId, durableMetadata);
      await maybeMarkNonSelfChatReadReceipt(inbound, deliveryReadReceipt);
      return;
    }

    const dedupeKey = inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : "";
    const dedupeClaim = dedupeKey ? await claimRecentInboundMessageDelivery(dedupeKey) : "claimed";
    if (dedupeClaim !== "claimed") {
      if (dedupeClaim === "duplicate") {
        await completeUndeliverableDurableInbound(durableId, durableMetadata);
        await maybeMarkNonSelfChatReadReceipt(inbound, deliveryReadReceipt);
      }
      return;
    }

    recordAcceptedInboundActivity(options.accountId);
    await enqueueInboundMessage(msg, inbound, enriched, {
      durableId,
      readReceipt: deliveryReadReceipt,
      receiveOrder,
    });
  };

  const replayPendingDurableInboundMessages = async () => {
    const pending = await durableInboundJournal.pending();
    for (const record of pending) {
      await processDurableInboundMessage(
        deserializeWhatsAppDurableInboundMessage(record.payload.message),
        record.payload.upsertType,
        record.payload.receivedAt,
        {
          id: record.id,
          payload: record.payload,
          metadata: record.metadata,
        },
      );
    }
  };

  type EnrichedInboundMessage = {
    body: string;
    commandBody: string;
    location?: ReturnType<typeof extractLocationData>;
    contactContext?: ReturnType<typeof extractContactContext>;
    externalAdReplyContext?: ReturnType<typeof extractExternalAdReplyContext>;
    replyContext?: ReturnType<typeof describeReplyContext>;
    mediaPath?: string;
    mediaType?: string;
    mediaFileName?: string;
  };

  const enrichInboundMessage = async (msg: WAMessage): Promise<EnrichedInboundMessage | null> => {
    const location = extractLocationData(msg.message ?? undefined);
    const locationText = location ? formatLocationText(location) : undefined;
    const contactContext = extractContactContext(msg.message ?? undefined);
    const externalAdReplyContext = extractExternalAdReplyContext(msg.message ?? undefined);
    const mediaPlaceholder = extractMediaPlaceholder(msg.message ?? undefined);
    let body = extractText(msg.message ?? undefined);
    if (locationText) {
      body = [body, locationText].filter(Boolean).join("\n").trim();
    }
    if (!body) {
      body = mediaPlaceholder;
      if (!body) {
        return null;
      }
    }
    const commandBody = body;
    const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let mediaFileName: string | undefined;
    const maxMb =
      typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0 ? options.mediaMaxMb : 50;
    const maxBytes = maxMb * 1024 * 1024;
    const saveInboundMedia = async (
      inboundMedia: Awaited<ReturnType<typeof downloadInboundMedia>>,
    ) => {
      if (!inboundMedia) {
        return;
      }
      mediaPath = inboundMedia.saved.path;
      mediaType = inboundMedia.mimetype;
      mediaFileName = inboundMedia.fileName;
    };
    try {
      const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock, maxBytes);
      await saveInboundMedia(inboundMedia);
    } catch (err) {
      logWhatsAppVerbose(options.verbose, `Inbound media download failed: ${String(err)}`);
      body = formatInboundMediaUnavailableText({
        body,
        mediaPlaceholder,
        notice: "[whatsapp attachment unavailable]",
      });
    }
    if (!mediaPath && replyContext) {
      try {
        await saveInboundMedia(
          await downloadQuotedInboundMedia(msg as proto.IWebMessageInfo, sock, maxBytes),
        );
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Quoted media download failed: ${String(err)}`);
        body = formatInboundMediaUnavailableText({
          body,
          notice: "[whatsapp quoted attachment unavailable]",
        });
      }
    }

    return {
      body,
      commandBody,
      location: location ?? undefined,
      contactContext,
      externalAdReplyContext,
      replyContext,
      mediaPath,
      mediaType,
      mediaFileName,
    };
  };

  const enqueueInboundMessage = async (
    msg: WAMessage,
    inbound: NormalizedInboundMessage,
    enriched: EnrichedInboundMessage,
    durable: {
      durableId?: string;
      readReceipt?: WhatsAppReadReceiptTarget;
      receiveOrder?: number;
    },
  ) => {
    const chatJid = inbound.remoteJid;
    const sendComposing = async () => {
      const currentSock = getCurrentSock();
      if (!currentSock) {
        return;
      }
      try {
        await assertCanSendToJid(chatJid, currentSock);
        await sendApiSocketOperations.sendPresenceUpdate("composing", chatJid);
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Presence update failed: ${String(err)}`);
      }
    };
    const reply = async (text: string, optionsResult?: MiscMessageGenerationOptions) => {
      const resolved = await resolveOutboundMentionsForGroup(chatJid, text);
      const result = await sendTrackedMessage(
        chatJid,
        addWhatsAppOutboundMentionsToContent({ text: resolved.text }, resolved.mentionedJids),
        optionsResult,
      );
      return normalizeWhatsAppSendResult(result, "text");
    };
    const sendMedia = async (
      payload: AnyMessageContent,
      optionsValue?: MiscMessageGenerationOptions,
    ) => {
      const previewPayload = await addWhatsAppImagePreviewFields(payload);
      const result = await sendTrackedMessage(
        chatJid,
        await applyOutboundMentionsToContent(chatJid, previewPayload),
        optionsValue,
      );
      return normalizeWhatsAppSendResult(result, "media");
    };
    const timestamp = inbound.messageTimestampMs;
    const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
    const senderName = msg.pushName ?? undefined;

    inboundLogger.info(
      {
        from: inbound.from,
        to: self.e164 ?? "me",
        body: enriched.body,
        mediaPath: enriched.mediaPath,
        mediaType: enriched.mediaType,
        mediaFileName: enriched.mediaFileName,
        timestamp,
      },
      "inbound message",
    );
    const media =
      enriched.mediaPath || enriched.mediaType || enriched.mediaFileName
        ? {
            path: enriched.mediaPath,
            type: enriched.mediaType,
            fileName: enriched.mediaFileName,
          }
        : undefined;
    const groupMentions = mentionedJids ? { jids: mentionedJids } : undefined;
    const group =
      inbound.group && (inbound.groupSubject || inbound.groupParticipants?.length || groupMentions)
        ? {
            subject: inbound.groupSubject,
            participants: inbound.groupParticipants,
            mentions: groupMentions,
          }
        : undefined;
    const untrustedStructuredContext = [
      ...(enriched.contactContext
        ? [
            {
              label: "WhatsApp contact",
              source: "whatsapp",
              type: enriched.contactContext.kind,
              payload: enriched.contactContext,
            },
          ]
        : []),
      ...(enriched.externalAdReplyContext
        ? [
            {
              label: "WhatsApp external ad reply",
              source: "whatsapp",
              type: "external_ad_reply",
              payload: enriched.externalAdReplyContext,
            },
          ]
        : []),
    ];
    const inboundMessage: QueuedInboundMessage = withDeprecatedWebInboundMessageFlatAliases({
      admission: inbound.access.admission,
      event: {
        id: inbound.id,
        timestamp,
      },
      payload: {
        body: enriched.body,
        commandBody: enriched.commandBody,
        location: enriched.location ?? undefined,
        untrustedStructuredContext:
          untrustedStructuredContext.length > 0 ? untrustedStructuredContext : undefined,
        media,
      },
      platform: {
        chatJid: inbound.remoteJid,
        recipientJid: self.e164 ?? "me",
        pushName: senderName,
        sender: resolveComparableIdentity({
          jid: inbound.participantJid,
          e164: inbound.senderE164 ?? undefined,
          name: senderName,
        }),
        senderJid: inbound.participantJid,
        senderE164: inbound.senderE164 ?? undefined,
        senderName,
        self,
        selfJid: self.jid ?? undefined,
        selfLid: self.lid ?? undefined,
        selfE164: self.e164 ?? undefined,
        fromMe: Boolean(msg.key?.fromMe),
        sendComposing,
        reply,
        sendMedia,
      },
      quote: enriched.replyContext
        ? {
            context: enriched.replyContext,
            id: enriched.replyContext.id,
            body: enriched.replyContext.body,
            sender: {
              displayName: enriched.replyContext.sender?.label ?? undefined,
              jid: enriched.replyContext.sender?.jid ?? undefined,
              e164: enriched.replyContext.sender?.e164 ?? undefined,
            },
          }
        : undefined,
      group,
      dedupeKey: inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : undefined,
      durableId: durable.durableId,
      readReceipt: durable.readReceipt,
      receiveOrder: durable.receiveOrder,
    });
    const debounceKey = buildInboundDebounceKey(inboundMessage);
    if (debounceKey) {
      inboundMessage.debounceKey = debounceKey;
      if (inboundDebounceMs > 0 && shouldDebounceInboundMessage(inboundMessage)) {
        pendingDebounceKeys.add(debounceKey);
        publishPendingWorkState();
      }
    }
    if (inboundMessage.event.id) {
      const admission = requireWhatsAppInboundAdmission(inboundMessage);
      cacheInboundMessageMeta(
        admission.accountId,
        inboundMessage.platform.chatJid,
        inboundMessage.event.id,
        {
          participant: inboundMessage.platform.senderJid,
          participantE164:
            admission.conversation.kind === "direct"
              ? inboundMessage.platform.senderE164
              : undefined,
          body: inboundMessage.payload.body,
          fromMe: inboundMessage.platform.fromMe,
        },
      );
    }
    try {
      const task = Promise.resolve(debouncer.enqueue(inboundMessage));
      void task.catch((err: unknown) => {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      });
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    }
  };

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      rememberBaileysMessage(msg.key?.remoteJid, msg.key?.id, msg.message);

      const receiveOrder = nextReceiveOrder++;
      if (
        await maybeResolveWhatsAppApprovalReaction({
          cfg: options.loadConfig?.() ?? options.cfg,
          accountId: options.accountId,
          msg,
          selfJid: self.jid,
          selfLid: self.lid,
          resolveInboundJid,
          resolveReactionTargetJids,
          logVerboseMessage: (message) => logWhatsAppVerbose(options.verbose, message),
        })
      ) {
        continue;
      }

      await processDurableInboundMessage(msg, upsert.type, receiveOrder);
    }
  };
  const handleMessagesUpsertEvent = (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    const task = handleMessagesUpsert(upsert).catch((err: unknown) => {
      inboundLogger.error({ error: String(err) }, "messages.upsert handler error");
      inboundConsoleLog.error(`Messages upsert handler error: ${String(err)}`);
    });
    pendingMessageHandlers.add(task);
    publishPendingWorkState();
    void task.finally(() => {
      pendingMessageHandlers.delete(task);
      publishPendingWorkState();
    });
  };
  const waitForPendingMessageHandlers = async () => {
    while (pendingMessageHandlers.size > 0) {
      await Promise.all(Array.from(pendingMessageHandlers));
    }
  };
  const drainDebouncedInboundMessages = async () => {
    while (pendingDebounceKeys.size > 0 || activeInboundFlushes.size > 0) {
      const debounceKeys = Array.from(pendingDebounceKeys);
      if (debounceKeys.length > 0) {
        await Promise.all(debounceKeys.map((key) => debouncer.flushKey(key)));
      }

      const flushes = Array.from(activeInboundFlushes);
      if (flushes.length > 0) {
        await Promise.allSettled(flushes);
      }

      await Promise.resolve();
    }
  };
  const drainInboundBeforeSocketClose = async () => {
    groupMetadataCacheClosed = true;
    await waitForPendingMessageHandlers();
    await drainDebouncedInboundMessages();
  };
  const drainInboundBeforeSocketCloseWithTimeout = async () => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        drainInboundBeforeSocketClose(),
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Timed out draining WhatsApp inbound debounce after ${INBOUND_CLOSE_DRAIN_TIMEOUT_MS}ms`,
              ),
            );
          }, INBOUND_CLOSE_DRAIN_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };
  const handleConnectionUpdate = (update: Partial<import("baileys").ConnectionState>) => {
    try {
      if ("reachoutTimeLock" in update) {
        rememberReachoutTimeLock(update.reachoutTimeLock);
      }
      if (update.connection === "close") {
        if (options.socketRef?.current === sock) {
          options.socketRef.current = null;
        }
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === LOGGED_OUT_STATUS,
          error: update.lastDisconnect?.error,
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  const attachSockListener = (event: string, listener: (...args: unknown[]) => void) =>
    attachEmitterListener(
      sock.ev as unknown as {
        on: (event: string, listener: (...args: unknown[]) => void) => void;
        off?: (event: string, listener: (...args: unknown[]) => void) => void;
        removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
      },
      event,
      listener,
    );
  const detachMessagesUpsert = attachSockListener(
    "messages.upsert",
    handleMessagesUpsertEvent as unknown as (...args: unknown[]) => void,
  );
  const detachConnectionUpdate = attachSockListener(
    "connection.update",
    handleConnectionUpdate as unknown as (...args: unknown[]) => void,
  );

  const isFullGroupMetadataUpdate = (update: Partial<GroupMetadata>): update is GroupMetadata =>
    typeof update.id === "string" &&
    typeof update.subject === "string" &&
    Array.isArray(update.participants);

  const rememberFullGroupMetadataUpdate = (jid: string, meta: GroupMetadata) => {
    if (groupMetadataCacheClosed) {
      return;
    }
    rememberWhatsAppBaileysCacheEntry(options.baileysGroupMetaCache, jid, meta, GROUP_META_TTL_MS);
    publishedGroupMetadataJids.add(jid);
    invalidatedGroupMetadataJids.delete(jid);
    rememberGroupMetadataCacheEntry(
      groupMetadataCache,
      jid,
      summarizeGroupMetaForReconnectCache(meta),
    );
    groupMetaCache.delete(jid);
  };

  const forgetFullGroupMetadata = (jid: string) => {
    options.baileysGroupMetaCache?.delete(jid);
    groupMetadataCache.delete(jid);
    groupMetaCache.delete(jid);
    publishedGroupMetadataJids.delete(jid);
    invalidatedGroupMetadataJids.add(jid);
  };

  const detachGroupsUpsert = attachSockListener("groups.upsert", ((groups: GroupMetadata[]) => {
    for (const group of groups) {
      if (group.id) {
        rememberFullGroupMetadataUpdate(group.id, group);
      }
    }
  }) as unknown as (...args: unknown[]) => void);

  const detachGroupsUpdate = attachSockListener("groups.update", ((
    updates: Partial<GroupMetadata>[],
  ) => {
    for (const update of updates) {
      if (!update.id) {
        continue;
      }
      if (isFullGroupMetadataUpdate(update)) {
        rememberFullGroupMetadataUpdate(update.id, update);
        continue;
      }
      forgetFullGroupMetadata(update.id);
    }
  }) as unknown as (...args: unknown[]) => void);

  const detachGroupParticipantsUpdate = attachSockListener("group-participants.update", ((update: {
    id: string;
  }) => {
    forgetFullGroupMetadata(update.id);
  }) as unknown as (...args: unknown[]) => void);

  const replayTask = replayPendingDurableInboundMessages().catch((err: unknown) => {
    inboundLogger.error({ error: String(err) }, "failed replaying durable WhatsApp inbound");
    inboundConsoleLog.error(`Failed replaying durable WhatsApp inbound: ${String(err)}`);
  });
  pendingMessageHandlers.add(replayTask);
  publishPendingWorkState();
  void replayTask.finally(() => {
    pendingMessageHandlers.delete(replayTask);
    publishPendingWorkState();
  });

  const groupHydrationTask = (async () => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      if (groupMetadataCacheClosed) {
        return;
      }
      for (const [jid, meta] of Object.entries(groups ?? {})) {
        if (
          meta &&
          !publishedGroupMetadataJids.has(jid) &&
          !invalidatedGroupMetadataJids.has(jid)
        ) {
          rememberGroupMetadataCacheEntry(
            groupMetadataCache,
            jid,
            summarizeGroupMetaForReconnectCache(meta),
          );
          rememberWhatsAppBaileysCacheEntry(
            options.baileysGroupMetaCache,
            jid,
            meta,
            GROUP_META_TTL_MS,
          );
          publishedGroupMetadataJids.add(jid);
        }
      }
      logWhatsAppVerbose(
        options.verbose,
        `Hydrated ${Object.keys(groups ?? {}).length} participating groups on connect`,
      );
    } catch (err) {
      const error = String(err);
      inboundLogger.warn({ error }, "failed hydrating participating groups on connect");
      inboundConsoleLog.warn(`Failed hydrating participating groups on connect: ${error}`);
      logWhatsAppVerbose(
        options.verbose,
        `Failed to hydrate participating groups on connect: ${error}`,
      );
    }
  })();
  void groupHydrationTask;

  const sendApi = createWebSendApi({
    sock: sendApiSocketOperations,
    defaultAccountId: options.accountId,
    resolveOutboundMentions: ({ jid, text }) => resolveOutboundMentionsForGroup(jid, text),
    authDir: options.authDir,
  });

  return {
    close: async () => {
      try {
        detachMessagesUpsert();
        detachConnectionUpdate();
        detachGroupsUpsert();
        detachGroupsUpdate();
        detachGroupParticipantsUpdate();
        await drainInboundBeforeSocketCloseWithTimeout();
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Inbound close drain failed: ${String(err)}`);
      }
      try {
        closeInboundMonitorSocket(sock);
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    assertSendReady: assertCanSendTo,
    sendComposingTo: sendApi.sendComposingTo,
    sendMessage: sendApi.sendMessage,
    sendPoll: sendApi.sendPoll,
    sendReaction: sendApi.sendReaction,
  } as const;
}

export async function monitorWebInbox(options: MonitorWebInboxOptions) {
  const socketTiming = options.socketTiming ?? resolveWhatsAppSocketTiming(options.cfg);
  const recentMessageKeys: WhatsAppBaileysMessageCache = options.recentMessageKeys ?? new Map();
  const baileysGroupMetaCache: WhatsAppBaileysGroupMetadataCache =
    options.baileysGroupMetaCache ?? new Map();

  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
    ...socketTiming,
    getMessage: async (key: WAMessageKey) =>
      key.id && key.remoteJid
        ? readWhatsAppBaileysCacheEntry(recentMessageKeys, `${key.remoteJid}:${key.id}`)
        : undefined,
    cachedGroupMetadata: async (jid: string) => {
      const meta = readWhatsAppBaileysCacheEntry(baileysGroupMetaCache, jid);
      return meta?.participants?.length ? meta : undefined;
    },
  });
  try {
    await waitForWaConnection(sock, { timeoutMs: socketTiming.connectTimeoutMs });
  } catch (err) {
    closeInboundMonitorSocket(sock);
    throw err;
  }
  const shouldDebounce = options.shouldDebounce;
  const normalizeAdmittedWebInboundMessage = (
    msg: WebInboundMessageInput,
  ): AdmittedWebInboundCallbackMessage =>
    requireAdmittedWhatsAppInboundMessage(
      normalizeWebInboundMessage(msg),
    ) as AdmittedWebInboundCallbackMessage;
  return attachWebInboxToSocket({
    ...options,
    onMessage: async (msg) => {
      await options.onMessage(normalizeAdmittedWebInboundMessage(msg));
    },
    shouldDebounce: shouldDebounce
      ? (msg) => shouldDebounce(normalizeAdmittedWebInboundMessage(msg))
      : undefined,
    socketTiming,
    sock,
    recentMessageKeys,
    baileysGroupMetaCache,
  });
}
