import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  proto,
  GroupMetadata,
  WAMessage,
  WASocket,
} from "baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { readWebSelfIdentityForDecision, WhatsAppAuthUnstableError } from "../auth-store.js";
import { getPrimaryIdentityId, resolveComparableIdentity } from "../identity.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { DEFAULT_RECONNECT_POLICY, computeBackoff, sleepWithAbort } from "../reconnect.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { createWaSocket, formatError, getStatusCode, waitForWaConnection } from "../session.js";
import { resolveWhatsAppSocketTiming } from "../socket-timing.js";
import { resolveJidToE164 } from "../text-runtime.js";
import { checkInboundAccessControl } from "./access-control.js";
import {
  claimRecentInboundMessage,
  commitRecentInboundMessage,
  isRecentOutboundMessage,
  releaseRecentInboundMessage,
  rememberRecentOutboundMessage,
  WhatsAppRetryableInboundError,
} from "./dedupe.js";
import {
  describeReplyContext,
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
  addWhatsAppOutboundMentionsToContent,
  mayContainWhatsAppOutboundMention,
  resolveWhatsAppOutboundMentions,
  type WhatsAppOutboundMentionParticipant,
} from "./outbound-mentions.js";
import { DisconnectReason, isJidGroup } from "./runtime-api.js";
import { createWebSendApi } from "./send-api.js";
import { normalizeWhatsAppSendResult } from "./send-result.js";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";
const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
const INBOUND_CLOSE_DRAIN_TIMEOUT_MS = 5_000;
export const WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES = 500;

type WhatsAppGroupMetadataCacheEntry = {
  subject?: string;
  expires: number;
};
export type WhatsAppGroupMetadataCache = Map<string, WhatsAppGroupMetadataCacheEntry>;
type LocalGroupMetadataCacheEntry = WhatsAppGroupMetadataCacheEntry & {
  participants?: string[];
  mentionParticipants?: WhatsAppOutboundMentionParticipant[];
};

function rememberGroupMetadataCacheEntry<T extends WhatsAppGroupMetadataCacheEntry>(
  cache: Map<string, T>,
  jid: string,
  entry: T,
): void {
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
  if (entry.expires <= Date.now()) {
    cache.delete(jid);
    return null;
  }
  cache.delete(jid);
  cache.set(jid, entry);
  return entry;
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

function recordAcceptedInboundActivity(accountId: string): void {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "inbound",
  });
}

function isRetryableSendDisconnectError(err: unknown): boolean {
  return /closed|reset|timed\s*out|disconnect|no active socket/i.test(formatError(err));
}

function shouldClearSocketRefAfterSendFailure(err: unknown): boolean {
  return /closed|reset|disconnect|no active socket/i.test(formatError(err));
}

function isNonEmptyString(value: string | undefined): value is string {
  return Boolean(value);
}

type MonitorWebInboxOptions = {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Keep the global presence unavailable so self-chat sessions do not mute phone pushes. */
  selfChatMode?: boolean;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
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
};

export async function attachWebInboxToSocket(
  options: MonitorWebInboxOptions & {
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
  const getCurrentSock = () => (options.socketRef ? options.socketRef.current : sock);
  const shouldRetryDisconnect = () => options.shouldRetryDisconnect?.() === true;
  const disconnectRetryPolicy = options.disconnectRetryPolicy ?? DEFAULT_RECONNECT_POLICY;
  const sendRetryMaxAttempts =
    disconnectRetryPolicy.maxAttempts > 0
      ? disconnectRetryPolicy.maxAttempts
      : DEFAULT_RECONNECT_POLICY.maxAttempts;

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
    await sock.sendPresenceUpdate(presence);
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
  type QueuedInboundMessage = WebInboundMessage & {
    dedupeKey?: string;
    debounceKey?: string;
  };
  const inboundDebounceMs = Math.max(0, Math.trunc(options.debounceMs ?? 0));
  const pendingDebounceKeys = new Set<string>();
  const activeInboundFlushes = new Set<Promise<void>>();
  const buildInboundDebounceKey = (msg: WebInboundMessage): string | null => {
    const sender = msg.sender;
    const senderKey =
      msg.chatType === "group"
        ? (getPrimaryIdentityId(sender ?? null) ??
          msg.senderJid ??
          msg.senderE164 ??
          msg.senderName ??
          msg.from)
        : msg.from;
    if (!senderKey) {
      return null;
    }
    const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
    return `${msg.accountId}:${conversationKey}:${senderKey}`;
  };
  const shouldDebounceInboundMessage = (msg: WebInboundMessage): boolean =>
    options.shouldDebounce?.(msg) ?? true;

  const finalizeInboundDedupe = async (
    entries: QueuedInboundMessage[],
    error?: unknown,
  ): Promise<void> => {
    const dedupeKeys = [
      ...new Set(entries.map((entry) => entry.dedupeKey).filter(isNonEmptyString)),
    ];
    if (dedupeKeys.length === 0) {
      return;
    }
    if (error instanceof WhatsAppRetryableInboundError) {
      dedupeKeys.forEach((dedupeKey) => releaseRecentInboundMessage(dedupeKey, error));
      return;
    }
    await Promise.all(dedupeKeys.map((dedupeKey) => commitRecentInboundMessage(dedupeKey)));
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
      try {
        const last = entries.at(-1);
        if (!last) {
          return;
        }
        try {
          if (entries.length === 1) {
            await options.onMessage(last);
            await finalizeInboundDedupe(entries);
            return;
          }
          const mentioned = new Set<string>();
          for (const entry of entries) {
            for (const jid of entry.mentions ?? entry.mentionedJids ?? []) {
              mentioned.add(jid);
            }
          }
          const combinedBody = entries
            .map((entry) => entry.body)
            .filter(Boolean)
            .join("\n");
          const combinedMessage: WebInboundMessage = {
            ...last,
            body: combinedBody,
            mentions: mentioned.size > 0 ? Array.from(mentioned) : undefined,
            mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
            isBatched: true,
          };
          await options.onMessage(combinedMessage);
          await finalizeInboundDedupe(entries);
        } catch (error) {
          await finalizeInboundDedupe(entries, error);
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

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

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
          const result = sendOptions
            ? await currentSock.sendMessage(jid, content, sendOptions)
            : await currentSock.sendMessage(jid, content);
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
      expires: Date.now() + GROUP_META_TTL_MS,
    };
  };

  const summarizeGroupMetaForReconnectCache = (
    meta: GroupMetadata,
  ): WhatsAppGroupMetadataCacheEntry => ({
    subject: meta.subject,
    expires: Date.now() + GROUP_META_TTL_MS,
  });

  const getGroupMeta = async (jid: string) => {
    const cached = readGroupMetadataCacheEntry(groupMetaCache, jid);
    if (cached) {
      return cached;
    }
    try {
      const meta = await (getCurrentSock() ?? sock).groupMetadata(jid);
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
      return { expires: Date.now() + GROUP_META_TTL_MS };
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
    access: Awaited<ReturnType<typeof checkInboundAccessControl>>;
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
    const messageTimestampMs = msg.messageTimestamp
      ? Number(msg.messageTimestamp) * 1000
      : undefined;

    const accessCfg = options.loadConfig?.() ?? options.cfg;
    const access = await checkInboundAccessControl({
      cfg: accessCfg,
      accountId: options.accountId,
      from,
      selfE164: self.e164 ?? null,
      senderE164,
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

  const maybeMarkInboundAsRead = async (inbound: NormalizedInboundMessage) => {
    const { id, remoteJid, participantJid, access } = inbound;
    if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
      try {
        await sock.readMessages([{ remoteJid, id, participant: participantJid, fromMe: false }]);
        const suffix = participantJid ? ` (participant ${participantJid})` : "";
        logWhatsAppVerbose(
          options.verbose,
          `Marked message ${id} as read for ${remoteJid}${suffix}`,
        );
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Failed to mark message ${id} read: ${String(err)}`);
      }
    } else if (id && access.isSelfChat && options.verbose) {
      // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
      logWhatsAppVerbose(options.verbose, `Self-chat mode: skipping read receipt for ${id}`);
    }
  };

  type EnrichedInboundMessage = {
    body: string;
    location?: ReturnType<typeof extractLocationData>;
    contactContext?: ReturnType<typeof extractContactContext>;
    replyContext?: ReturnType<typeof describeReplyContext>;
    mediaPath?: string;
    mediaType?: string;
    mediaFileName?: string;
  };

  const enrichInboundMessage = async (msg: WAMessage): Promise<EnrichedInboundMessage | null> => {
    const location = extractLocationData(msg.message ?? undefined);
    const locationText = location ? formatLocationText(location) : undefined;
    const contactContext = extractContactContext(msg.message ?? undefined);
    let body = extractText(msg.message ?? undefined);
    if (locationText) {
      body = [body, locationText].filter(Boolean).join("\n").trim();
    }
    if (!body) {
      body = extractMediaPlaceholder(msg.message ?? undefined);
      if (!body) {
        return null;
      }
    }
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
      if (!mediaPath && replyContext) {
        await saveInboundMedia(
          await downloadQuotedInboundMedia(msg as proto.IWebMessageInfo, sock, maxBytes),
        );
      }
    } catch (err) {
      logWhatsAppVerbose(options.verbose, `Inbound media download failed: ${String(err)}`);
    }

    return {
      body,
      location: location ?? undefined,
      contactContext,
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
  ) => {
    const chatJid = inbound.remoteJid;
    const sendComposing = async () => {
      const currentSock = getCurrentSock();
      if (!currentSock) {
        return;
      }
      try {
        await currentSock.sendPresenceUpdate("composing", chatJid);
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Presence update failed: ${String(err)}`);
      }
    };
    const reply = async (text: string, options?: MiscMessageGenerationOptions) => {
      const resolved = await resolveOutboundMentionsForGroup(chatJid, text);
      const result = await sendTrackedMessage(
        chatJid,
        addWhatsAppOutboundMentionsToContent({ text: resolved.text }, resolved.mentionedJids),
        options,
      );
      return normalizeWhatsAppSendResult(result, "text");
    };
    const sendMedia = async (
      payload: AnyMessageContent,
      options?: MiscMessageGenerationOptions,
    ) => {
      const result = await sendTrackedMessage(
        chatJid,
        await applyOutboundMentionsToContent(chatJid, payload),
        options,
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
    const inboundMessage: QueuedInboundMessage = {
      id: inbound.id,
      from: inbound.from,
      conversationId: inbound.from,
      to: self.e164 ?? "me",
      accountId: inbound.access.resolvedAccountId,
      accessControlPassed: true,
      body: enriched.body,
      pushName: senderName,
      timestamp,
      chatType: inbound.group ? "group" : "direct",
      chatId: inbound.remoteJid,
      sender: resolveComparableIdentity({
        jid: inbound.participantJid,
        e164: inbound.senderE164 ?? undefined,
        name: senderName,
      }),
      senderJid: inbound.participantJid,
      senderE164: inbound.senderE164 ?? undefined,
      senderName,
      replyTo: enriched.replyContext ?? undefined,
      replyToId: enriched.replyContext?.id,
      replyToBody: enriched.replyContext?.body,
      replyToSender: enriched.replyContext?.sender?.label ?? undefined,
      replyToSenderJid: enriched.replyContext?.sender?.jid ?? undefined,
      replyToSenderE164: enriched.replyContext?.sender?.e164 ?? undefined,
      groupSubject: inbound.groupSubject,
      groupParticipants: inbound.groupParticipants,
      mentions: mentionedJids ?? undefined,
      mentionedJids: mentionedJids ?? undefined,
      self,
      selfJid: self.jid ?? undefined,
      selfLid: self.lid ?? undefined,
      selfE164: self.e164 ?? undefined,
      fromMe: Boolean(msg.key?.fromMe),
      location: enriched.location ?? undefined,
      untrustedStructuredContext: enriched.contactContext
        ? [
            {
              label: "WhatsApp contact",
              source: "whatsapp",
              type: enriched.contactContext.kind,
              payload: enriched.contactContext,
            },
          ]
        : undefined,
      sendComposing,
      reply,
      sendMedia,
      mediaPath: enriched.mediaPath,
      mediaType: enriched.mediaType,
      mediaFileName: enriched.mediaFileName,
      dedupeKey: inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : undefined,
    };
    const debounceKey = buildInboundDebounceKey(inboundMessage);
    if (debounceKey) {
      inboundMessage.debounceKey = debounceKey;
      if (inboundDebounceMs > 0 && shouldDebounceInboundMessage(inboundMessage)) {
        pendingDebounceKeys.add(debounceKey);
      }
    }
    if (inboundMessage.id) {
      cacheInboundMessageMeta(inboundMessage.accountId, inboundMessage.chatId, inboundMessage.id, {
        participant: inboundMessage.senderJid,
        participantE164:
          inboundMessage.chatType === "direct" ? inboundMessage.senderE164 : undefined,
        body: inboundMessage.body,
        fromMe: inboundMessage.fromMe,
      });
    }
    try {
      const task = Promise.resolve(debouncer.enqueue(inboundMessage));
      void task.catch((err) => {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      });
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    }
  };

  const pendingMessageHandlers = new Set<Promise<void>>();
  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      const inbound = await normalizeInboundMessage(msg);
      if (!inbound) {
        continue;
      }

      await maybeMarkInboundAsRead(inbound);

      // If this is history/offline catch-up, mark read above but skip auto-reply.
      if (upsert.type === "append") {
        const APPEND_RECENT_GRACE_MS = 60_000;
        const msgTsRaw = msg.messageTimestamp;
        const msgTsNum = msgTsRaw != null ? Number(msgTsRaw) : Number.NaN;
        const msgTsMs = Number.isFinite(msgTsNum) ? msgTsNum * 1000 : 0;
        if (msgTsMs < connectedAtMs - APPEND_RECENT_GRACE_MS) {
          continue;
        }
      }

      const enriched = await enrichInboundMessage(msg);
      if (!enriched) {
        continue;
      }

      const dedupeKey = inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : "";
      if (dedupeKey && !(await claimRecentInboundMessage(dedupeKey))) {
        continue;
      }

      recordAcceptedInboundActivity(options.accountId);
      await enqueueInboundMessage(msg, inbound, enriched);
    }
  };
  const handleMessagesUpsertEvent = (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    const task = handleMessagesUpsert(upsert).catch((err) => {
      inboundLogger.error({ error: String(err) }, "messages.upsert handler error");
      inboundConsoleLog.error(`Messages upsert handler error: ${String(err)}`);
    });
    pendingMessageHandlers.add(task);
    void task.finally(() => {
      pendingMessageHandlers.delete(task);
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
  const detachMessagesUpsert = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "messages.upsert",
    handleMessagesUpsertEvent as unknown as (...args: unknown[]) => void,
  );
  const detachConnectionUpdate = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "connection.update",
    handleConnectionUpdate as unknown as (...args: unknown[]) => void,
  );

  void (async () => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups ?? {})) {
        if (meta) {
          rememberGroupMetadataCacheEntry(
            groupMetadataCache,
            jid,
            summarizeGroupMetaForReconnectCache(meta),
          );
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

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (
        jid: string,
        content: AnyMessageContent,
        options?: MiscMessageGenerationOptions,
      ) => sendTrackedMessage(jid, content, options),
      sendPresenceUpdate: async (presence, jid?: string) => {
        const currentSock = getCurrentSock();
        if (!currentSock) {
          throw new Error(RECONNECT_IN_PROGRESS_ERROR);
        }
        return currentSock.sendPresenceUpdate(presence, jid);
      },
    },
    defaultAccountId: options.accountId,
    resolveOutboundMentions: ({ jid, text }) => resolveOutboundMentionsForGroup(jid, text),
    authDir: options.authDir,
  });

  return {
    close: async () => {
      try {
        detachMessagesUpsert();
        detachConnectionUpdate();
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
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
  } as const;
}

export async function monitorWebInbox(options: MonitorWebInboxOptions) {
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
    ...resolveWhatsAppSocketTiming(options.cfg),
  });
  await waitForWaConnection(sock);
  return attachWebInboxToSocket({
    ...options,
    sock,
  });
}
