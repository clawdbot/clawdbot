// Whatsapp plugin module composes the inbound socket, metadata, and delivery owners.
import type { WAMessageKey, WASocket } from "baileys";
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import { createSubsystemLogger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import type { OpenClawConfig } from "../runtime-api.js";
import { createWaSocket, waitForWaConnection } from "../session.js";
import { resolveWhatsAppSocketTiming, type WhatsAppSocketTimingOptions } from "../socket-timing.js";
import {
  readWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysGroupMetadataCache,
  type WhatsAppBaileysMessageCache,
} from "./baileys-cache.js";
import {
  createWhatsAppDurableInboundQueue,
  type WhatsAppDurableInboundQueue,
} from "./durable-receive.js";
import {
  createWhatsAppGroupMetadataCacheOwner,
  type WhatsAppGroupMetadataCache,
} from "./group-metadata-cache.js";
import { closeInboundMonitorSocket } from "./lifecycle.js";
import {
  createWhatsAppMessageDeliveryCoordinator,
  type WhatsAppAppendReplyWindow,
} from "./message-delivery.js";
import { createWebSendApi } from "./send-api.js";
import { createWhatsAppAttachedSocketSession } from "./socket-session.js";
import type { AdmittedWebInboundCallbackMessage } from "./types.js";

function logWhatsAppVerbose(enabled: boolean | undefined, message: string) {
  if (enabled) {
    defaultRuntime.log(message);
  }
}

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
  appendReplyWindow?: WhatsAppAppendReplyWindow;
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
  onMessage: (msg: AdmittedWebInboundCallbackMessage) => Promise<void>;
  shouldDebounce?: (msg: AdmittedWebInboundCallbackMessage) => boolean;
};

export async function attachWebInboxToSocket(
  options: AttachWebInboxToSocketOptions & {
    sock: WASocket;
  },
) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const socketSession = await createWhatsAppAttachedSocketSession({
    sock: options.sock,
    socketRef: options.socketRef,
    accountId: options.accountId,
    authDir: options.authDir,
    selfChatMode: options.selfChatMode,
    socketTiming: options.socketTiming,
    shouldRetryDisconnect: options.shouldRetryDisconnect,
    disconnectRetryPolicy: options.disconnectRetryPolicy,
    disconnectRetryAbortSignal: options.disconnectRetryAbortSignal,
    recentMessageKeys: options.recentMessageKeys,
    logVerbose: (message) => logWhatsAppVerbose(options.verbose, message),
    logConnectionError: (error) => {
      inboundLogger.error({ error: String(error) }, "connection.update handler error");
    },
  });
  const groupMetadata = createWhatsAppGroupMetadataCacheOwner({
    sock: options.sock,
    getCurrentSock: socketSession.getCurrentSock,
    resolveInboundJid: socketSession.resolveInboundJid,
    reconnectCache: options.groupMetadataCache,
    baileysCache: options.baileysGroupMetaCache,
    listen: socketSession.listen,
    logVerbose: (message) => logWhatsAppVerbose(options.verbose, message),
    logHydrationWarning: (error) => {
      inboundLogger.warn({ error }, "failed hydrating participating groups on connect");
      inboundConsoleLog.warn(`Failed hydrating participating groups on connect: ${error}`);
    },
  });
  const delivery = createWhatsAppMessageDeliveryCoordinator({
    cfg: options.cfg,
    loadConfig: options.loadConfig,
    verbose: options.verbose,
    accountId: options.accountId,
    sock: options.sock,
    socketSession,
    groupMetadata,
    onMessage: options.onMessage,
    mediaMaxMb: options.mediaMaxMb,
    sendReadReceipts: options.sendReadReceipts,
    debounceMs: options.debounceMs,
    appendReplyWindow: options.appendReplyWindow,
    shouldDebounce: options.shouldDebounce,
    onPendingWorkChanged: options.onPendingWorkChanged,
    durableInboundQueue:
      options.durableInboundQueue ?? createWhatsAppDurableInboundQueue(options.accountId),
  });
  const sendApi = createWebSendApi({
    sock: socketSession.socketOperations,
    defaultAccountId: options.accountId,
    resolveOutboundMentions: ({ jid, text }) => groupMetadata.resolveOutboundMentions(jid, text),
    authDir: options.authDir,
  });

  delivery.start();
  socketSession.start();
  groupMetadata.start();

  return {
    close: async () => {
      delivery.stopIntake();
      socketSession.stop();
      groupMetadata.close();
      try {
        await delivery.drain();
      } catch (error) {
        logWhatsAppVerbose(options.verbose, `Inbound close drain failed: ${String(error)}`);
      } finally {
        socketSession.closeSocket();
      }
    },
    onClose: socketSession.onClose,
    signalClose: socketSession.signalClose,
    assertSendReady: socketSession.assertSendReady,
    sendComposingTo: sendApi.sendComposingTo,
    sendMessage: sendApi.sendMessage,
    sendPoll: sendApi.sendPoll,
    sendReaction: sendApi.sendReaction,
  } as const;
}

export async function monitorWebInbox(options: MonitorWebInboxOptions) {
  const socketTiming = options.socketTiming ?? resolveWhatsAppSocketTiming();
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
  } catch (error) {
    closeInboundMonitorSocket(sock);
    throw error;
  }
  return attachWebInboxToSocket({
    ...options,
    socketTiming,
    sock,
    recentMessageKeys,
    baileysGroupMetaCache,
  });
}
