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
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import {
  asDateTimestampMs,
  parseStrictFiniteNumber,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { maybeResolveWhatsAppApprovalReaction } from "../approval-reactions.js";
import { readWebSelfIdentityForDecision, WhatsAppAuthUnstableError } from "../auth-store.js";
import { getWhatsAppConnectionController } from "../connection-controller-runtime-context.js";
import { getPrimaryIdentityId, identitiesOverlap, resolveComparableIdentity } from "../identity.js";
import { addWhatsAppImagePreviewFields } from "../image-preview.js";
import { maybeResolveWhatsAppQuestionReaction } from "../question-reactions.js";
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
import { isRecentOutboundMessage, rememberRecentOutboundMessage } from "./dedupe.js";
import {
  createWhatsAppDurableInboundMessageId,
  createWhatsAppDurableInboundQueue,
  createWhatsAppIngressDrain,
  enqueueWhatsAppDurableInbound,
  type WhatsAppDurableInboundPayload,
  type WhatsAppDurableInboundQueue,
  type WhatsAppIngressLifecycle,
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
import { attachWhatsAppIngressLifecycle } from "./ingress-lifecycle.js";
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

const LOGGED_OUT_STATUS = DisconnectReason.loggedOut;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";
const GROUP_META_TTL_MS = 5 * 60 * 1000;
const BAILEYS_MESSAGE_TTL_MS = 10 * 60 * 1000;
const INBOUND_CLOSE_DRAIN_TIMEOUT_MS = 5_000;
const WHATSAPP_INGRESS_DRAIN_INTERVAL_MS = 1_000;
const WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES = 500;

type WhatsAppGroupMetadataCacheEntry = {
  subject?: string;
  expires: number;
};

export type WhatsAppGroupMetadataCache = Map<string, WhatsAppGroupMetadataCacheEntry>;
type WhatsAppBaileysCacheEntry<T> = {
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
  durableInboundQueue?: WhatsAppDurableInboundQueue;
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
    const successor = getWhatsAppConnectionController(options.accountId);
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
    debounceKey?: string;
    turnAdoptionLifecycle?: WhatsAppIngressLifecycle;
    readReceipt?: WhatsAppReadReceiptTarget;
    receiveOrder?: number;
  };
  type QueuedInboundMessage = AdmittedWebInboundCallbackMessage & QueuedInboundMessageMetadata;
  const durableInboundQueue =
    options.durableInboundQueue ?? createWhatsAppDurableInboundQueue(options.accountId);
  const inboundDebounceMs = Math.max(0, Math.trunc(options.debounceMs ?? 0));
  const pendingDebounceKeys = new Set<string>();
  const activeInboundFlushes = new Set<Promise<void>>();
  const pendingMessageHandlers = new Set<Promise<void>>();
  // Close-path coordination: resolve waiters when debounce work appears so
  // shutdown can force-flush without timer-driven polling (fake-timer safe).
  const debounceWorkWaiters = new Set<() => void>();
  const notifyDebounceWork = () => {
    if (debounceWorkWaiters.size === 0) {
      return;
    }
    const waiters = [...debounceWorkWaiters];
    debounceWorkWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  };
  const waitForDebounceWorkOrIdle = (handlers: ReadonlyArray<Promise<void>>) => {
    if (pendingDebounceKeys.size > 0 || activeInboundFlushes.size > 0) {
      return Promise.resolve();
    }
    if (pendingMessageHandlers.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = () => {
        debounceWorkWaiters.delete(finish);
        resolve();
      };
      debounceWorkWaiters.add(finish);
      void Promise.allSettled(handlers).then(finish);
    });
  };
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

  const buildFlushIngressLifecycle = (entries: QueuedInboundMessage[]) => {
    const lifecycles = entries
      .map((entry) => entry.turnAdoptionLifecycle)
      .filter((lifecycle) => lifecycle !== undefined);
    const [firstLifecycle] = lifecycles;
    if (!firstLifecycle) {
      return {
        lifecycle: undefined,
        settle: async () => {},
        abandon: async () => {},
      };
    }
    let handedOff = false;
    const adoptAll = async () => {
      for (const lifecycle of lifecycles) {
        await lifecycle.onAdopted();
      }
    };
    return {
      lifecycle: {
        abortSignal:
          lifecycles.length === 1
            ? firstLifecycle.abortSignal
            : AbortSignal.any(lifecycles.map((lifecycle) => lifecycle.abortSignal)),
        onAdopted: async () => {
          handedOff = true;
          await adoptAll();
        },
        onDeferred: () => {
          handedOff = true;
          for (const lifecycle of lifecycles) {
            lifecycle.onDeferred();
          }
        },
        onAdoptionFinalizing: () => {
          for (const lifecycle of lifecycles) {
            lifecycle.onAdoptionFinalizing();
          }
        },
        onAbandoned: async () => {
          handedOff = true;
          await Promise.all(
            lifecycles.map((lifecycle) => Promise.resolve(lifecycle.onAbandoned())),
          );
        },
      } satisfies WhatsAppIngressLifecycle,
      // Gated or otherwise terminal no-dispatch turns still own every merged claim.
      settle: async () => {
        if (!handedOff) {
          await adoptAll();
        }
      },
      abandon: async () => {
        if (!handedOff) {
          handedOff = true;
          await Promise.all(
            lifecycles.map((lifecycle) => Promise.resolve(lifecycle.onAbandoned())),
          );
        }
      },
    };
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
      notifyDebounceWork();
      try {
        const orderedEntries = orderDebouncedInboundEntries(entries);
        const last = orderedEntries.at(-1);
        if (!last) {
          return;
        }
        const { lifecycle, settle, abandon } = buildFlushIngressLifecycle(orderedEntries);
        try {
          if (orderedEntries.length === 1) {
            await options.onMessage(attachWhatsAppIngressLifecycle(last, lifecycle));
            await settle();
            await Promise.all(
              orderedEntries.map((entry) => maybeMarkInboundAsRead(entry.readReceipt)),
            );
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
          const combinedMessage: QueuedInboundMessage = attachWhatsAppIngressLifecycle(
            withDeprecatedWebInboundMessageFlatAliases({
              ...last,
              ...(lifecycle ? { turnAdoptionLifecycle: lifecycle } : {}),
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
            }),
            lifecycle,
          );
          await options.onMessage(combinedMessage);
          await settle();
          await Promise.all(
            orderedEntries.map((entry) => maybeMarkInboundAsRead(entry.readReceipt)),
          );
        } catch (error) {
          await abandon();
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
    if (isJidGroup(jid) !== true || !mayContainWhatsAppOutboundMention(text)) {
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

  const shouldSkipRecentOutboundEcho = (msg: WAMessage): boolean => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (
      !msg.key?.fromMe ||
      !id ||
      !remoteJid ||
      !isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        messageId: id,
      })
    ) {
      return false;
    }
    logWhatsAppVerbose(
      options.verbose,
      `Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`,
    );
    return true;
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

    const group = isJidGroup(remoteJid) === true;
    // Drop echoes of messages the gateway itself sent (tracked by sendTrackedMessage).
    // Applies to both groups and DMs/self-chat — without this, self-chat mode
    // re-processes the bot's own replies as new inbound user messages.
    if (shouldSkipRecentOutboundEcho(msg)) {
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

  // Live rows keep receive-time identity facts until their first drain attempt.
  // Restart replay has no entry and re-normalizes from the persisted payload.
  type PreparedInbound = NonNullable<Awaited<ReturnType<typeof normalizeInboundMessage>>>;
  const preparedInboundByDurableId = new Map<string, Promise<PreparedInbound | null | undefined>>();

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
      readReceipt?: WhatsAppReadReceiptTarget;
      receiveOrder?: number;
      turnAdoptionLifecycle?: WhatsAppIngressLifecycle;
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
      turnAdoptionLifecycle: durable.turnAdoptionLifecycle,
      readReceipt: durable.readReceipt,
      receiveOrder: durable.receiveOrder,
    });
    const debounceKey = buildInboundDebounceKey(inboundMessage);
    if (debounceKey) {
      inboundMessage.debounceKey = debounceKey;
      if (inboundDebounceMs > 0 && shouldDebounceInboundMessage(inboundMessage)) {
        pendingDebounceKeys.add(debounceKey);
        publishPendingWorkState();
        notifyDebounceWork();
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
    await debouncer.enqueue(inboundMessage);
  };

  const dispatchInboundMessage = async (
    msg: WAMessage,
    context: Pick<
      WhatsAppDurableInboundPayload,
      "upsertType" | "skipStaleAppend" | "skipRecentOutboundEcho" | "receivedAt" | "receiveOrder"
    > & {
      eventId?: string;
      lifecycle?: WhatsAppIngressLifecycle;
    },
  ): Promise<"completed" | "deferred"> => {
    rememberBaileysMessage(msg.key?.remoteJid, msg.key?.id, msg.message);
    if (context.skipRecentOutboundEcho === true) {
      return "completed";
    }
    const preparation = context.eventId
      ? preparedInboundByDurableId.get(context.eventId)
      : undefined;
    if (context.eventId) {
      preparedInboundByDurableId.delete(context.eventId);
    }
    const prepared = await preparation;
    if (prepared === null) {
      return "completed";
    }
    const inbound = prepared ?? (await normalizeInboundMessage(msg));
    if (!inbound) {
      return "completed";
    }
    if (
      await maybeResolveWhatsAppQuestionReaction({
        cfg: options.loadConfig?.() ?? options.cfg,
        accountId: options.accountId,
        msg,
        senderId: inbound.senderE164 ?? inbound.from,
        resolveReactionTargetJids,
        logDebug: (message) => logWhatsAppVerbose(options.verbose, message),
      })
    ) {
      return "completed";
    }
    const readReceipt = buildReadReceiptTarget(inbound);
    const deliveryReadReceipt = inbound.access.isSelfChat ? undefined : readReceipt;
    if (context.skipStaleAppend === true) {
      await maybeMarkNonSelfChatReadReceipt(inbound, readReceipt);
      return "completed";
    }

    const enriched = await enrichInboundMessage(msg);
    if (!enriched) {
      await maybeMarkNonSelfChatReadReceipt(inbound, deliveryReadReceipt);
      return "completed";
    }

    recordAcceptedInboundActivity(options.accountId);
    await enqueueInboundMessage(msg, inbound, enriched, {
      readReceipt: deliveryReadReceipt,
      receiveOrder: context.receiveOrder ?? context.receivedAt,
      turnAdoptionLifecycle: context.lifecycle,
    });
    return "deferred";
  };

  let durableDrainPass: Promise<void> | undefined;
  let durableDrainRequested = false;
  let durableDrainClosed = false;
  const requestDurableInboundDrain = (): Promise<void> => {
    if (durableDrainClosed) {
      return Promise.resolve();
    }
    durableDrainRequested = true;
    if (!durableDrainPass) {
      let passFailed = false;
      const task = (async () => {
        await durableInboundDrain.recoverStaleClaims();
        while (durableDrainRequested) {
          durableDrainRequested = false;
          const result = await durableInboundDrain.drainOnce();
          if (result.started > 0) {
            await durableInboundDrain.waitForIdle();
            durableDrainRequested = true;
          }
        }
      })().catch((error: unknown) => {
        passFailed = true;
        throw error;
      });
      durableDrainPass = task;
      pendingMessageHandlers.add(task);
      publishPendingWorkState();
      void task
        .finally(() => {
          if (durableDrainPass === task) {
            durableDrainPass = undefined;
          }
          pendingMessageHandlers.delete(task);
          publishPendingWorkState();
          if (durableDrainRequested && !passFailed) {
            void requestDurableInboundDrain().catch((error: unknown) => {
              inboundLogger.error(
                { error: formatError(error) },
                "whatsapp durable inbound drain failed",
              );
            });
          }
        })
        .catch(() => undefined);
    }
    return durableDrainPass;
  };
  const requestDrainAfterLaneSettlement = () => {
    void requestDurableInboundDrain().catch((error: unknown) => {
      inboundLogger.error({ error: formatError(error) }, "whatsapp durable inbound drain failed");
    });
  };
  const continueDrainAfterLaneSettlement = (
    lifecycle: WhatsAppIngressLifecycle,
  ): WhatsAppIngressLifecycle => ({
    abortSignal: lifecycle.abortSignal,
    onAdopted: async () => {
      await lifecycle.onAdopted();
      requestDrainAfterLaneSettlement();
    },
    onDeferred: lifecycle.onDeferred,
    onAdoptionFinalizing: lifecycle.onAdoptionFinalizing,
    onAbandoned: async () => {
      await lifecycle.onAbandoned();
      requestDrainAfterLaneSettlement();
    },
  });
  // Lazy closures above only run post-start, so the const-after-use is TDZ-safe.
  const durableInboundDrain = createWhatsAppIngressDrain({
    queue: durableInboundQueue,
    dispatch: async (msg, payload, lifecycle) => {
      const remoteJid = msg.key?.remoteJid;
      const id = msg.key?.id;
      return {
        kind: await dispatchInboundMessage(msg, {
          ...payload,
          ...(remoteJid && id
            ? { eventId: createWhatsAppDurableInboundMessageId({ remoteJid, id }) }
            : {}),
          lifecycle: continueDrainAfterLaneSettlement(lifecycle),
        }),
      };
    },
    onLog: (message) => inboundLogger.warn({ message }, "whatsapp ingress drain"),
  });
  const durableDrainTimer = setInterval(() => {
    void requestDurableInboundDrain().catch((error: unknown) => {
      inboundLogger.error({ error: formatError(error) }, "whatsapp durable inbound drain failed");
    });
  }, WHATSAPP_INGRESS_DRAIN_INTERVAL_MS);
  durableDrainTimer.unref?.();

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

      const receivedAt = Date.now();
      const skipStaleAppend = shouldSkipStaleAppend(msg, upsert.type);
      const skipRecentOutboundEcho = shouldSkipRecentOutboundEcho(msg);
      const remoteJid = msg.key?.remoteJid;
      const id = msg.key?.id;
      const durableId =
        remoteJid && id ? createWhatsAppDurableInboundMessageId({ remoteJid, id }) : undefined;
      let resolvePrepared: ((inbound: PreparedInbound | null | undefined) => void) | undefined;
      // A redelivery must not clobber the first delivery's in-flight
      // preparation: the drain consumes exactly one entry per durable id.
      if (durableId && !preparedInboundByDurableId.has(durableId)) {
        // Queue pruning caps pending rows, but evicted rows' entries would
        // linger here forever on a blocked lane; evict oldest-first well above
        // the queue's own pending cap. Dispatch falls back to re-normalizing
        // the journaled payload when its entry is gone.
        if (preparedInboundByDurableId.size >= 1000) {
          const oldest = preparedInboundByDurableId.keys().next().value;
          if (oldest !== undefined) {
            preparedInboundByDurableId.delete(oldest);
          }
        }
        preparedInboundByDurableId.set(
          durableId,
          new Promise((resolve) => {
            resolvePrepared = resolve;
          }),
        );
      }
      const finishPreparation = (
        inbound: PreparedInbound | null | undefined,
        keepForDrain = false,
      ) => {
        resolvePrepared?.(inbound);
        // Only the delivery that installed the entry may remove it; a
        // duplicate pending delivery (resolvePrepared undefined) must not
        // delete the first delivery's kept preparation.
        if (!keepForDrain && durableId && resolvePrepared) {
          preparedInboundByDurableId.delete(durableId);
        }
      };
      let result: { kind: string } | undefined;
      let appendError: unknown;
      // Bounded retry for transient store blips. The retired live-dispatch
      // fallback is gone deliberately: with the replay guard deleted it
      // bypassed drain dedupe and lane serialization, trading a duplicate
      // reply/session race for availability against an already-broken store.
      for (const delayMs of [0, 100, 300]) {
        if (delayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        try {
          result = await enqueueWhatsAppDurableInbound({
            queue: durableInboundQueue,
            message: msg,
            upsertType: upsert.type,
            skipStaleAppend,
            skipRecentOutboundEcho,
            receivedAt,
            receiveOrder,
          });
          appendError = undefined;
          break;
        } catch (error) {
          appendError = error;
        }
      }
      if (result === undefined) {
        finishPreparation(undefined);
        const formattedError = formatError(appendError);
        inboundLogger.error(
          { error: formattedError },
          "failed persisting durable WhatsApp inbound after retries; message dropped",
        );
        inboundConsoleLog.error(
          `Failed persisting durable WhatsApp inbound after retries; message dropped: ${formattedError}`,
        );
        continue;
      }
      if (result.kind === "completed") {
        finishPreparation(undefined);
        const inbound = await normalizeInboundMessage(msg);
        if (inbound) {
          await maybeMarkNonSelfChatReadReceipt(inbound, buildReadReceiptTarget(inbound));
        }
      } else {
        if (result.kind === "accepted") {
          try {
            finishPreparation(
              skipRecentOutboundEcho ? null : await normalizeInboundMessage(msg),
              true,
            );
          } catch (error) {
            finishPreparation(undefined);
            throw error;
          }
        } else {
          // "pending": the first delivery owns preparation; resolving without
          // keepForDrain avoids orphaning a second map entry forever.
          finishPreparation(undefined);
        }
        void requestDurableInboundDrain().catch((error: unknown) => {
          inboundLogger.error(
            { error: formatError(error) },
            "whatsapp durable inbound drain failed",
          );
        });
      }
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
    clearInterval(durableDrainTimer);
    // Interleave force-flush with event-driven wait for drain dispatch so close
    // cannot deadlock inside the debounce window. Debounce semantics stay intact.
    for (;;) {
      await drainDebouncedInboundMessages();
      if (pendingMessageHandlers.size === 0) {
        break;
      }
      const handlers = Array.from(pendingMessageHandlers);
      await Promise.race([Promise.allSettled(handlers), waitForDebounceWorkOrIdle(handlers)]);
      if (
        pendingMessageHandlers.size === 0 &&
        pendingDebounceKeys.size === 0 &&
        activeInboundFlushes.size === 0
      ) {
        break;
      }
    }
    await drainDebouncedInboundMessages();
    // Claims must finish (or release) before a successor monitor starts.
    try {
      await durableInboundDrain.waitForIdle();
    } finally {
      durableDrainClosed = true;
      durableInboundDrain.dispose();
    }
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
      // A drain timeout abandons the graceful path before its own dispose
      // runs; a successor monitor must never share this account queue with a
      // still-live drain. dispose() is idempotent, so the graceful path's own
      // cleanup stays harmless.
      durableDrainClosed = true;
      durableInboundDrain.dispose();
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

  void requestDurableInboundDrain().catch((err: unknown) => {
    inboundLogger.error({ error: String(err) }, "failed replaying durable WhatsApp inbound");
    inboundConsoleLog.error(`Failed replaying durable WhatsApp inbound: ${String(err)}`);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
