// Whatsapp plugin module owns one attached inbound socket session.
import type {
  AnyMessageContent,
  ConnectionState,
  MiscMessageGenerationOptions,
  proto,
  ReachoutTimelockState,
  WAMessage,
  WASocket,
} from "baileys";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { readWebSelfIdentityForDecision, WhatsAppAuthUnstableError } from "../auth-store.js";
import { getWhatsAppConnectionController } from "../connection-controller-runtime-context.js";
import { identitiesOverlap, type WhatsAppSelfIdentity } from "../identity.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { DEFAULT_RECONNECT_POLICY, computeBackoff, sleepWithAbort } from "../reconnect.js";
import { formatError, getStatusCode } from "../session.js";
import {
  createWhatsAppSocketOperationTimeoutAdapter,
  isWhatsAppSocketOperationTimeoutError,
  resolveWhatsAppSocketOperationTimeoutMs,
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
  rememberWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysMessageCache,
} from "./baileys-cache.js";
import { rememberRecentOutboundMessage } from "./dedupe.js";
import type { WhatsAppReadReceiptTarget } from "./durable-receive.js";
import { extractText } from "./extract.js";
import {
  attachEmitterListener,
  closeInboundMonitorSocket,
  type WhatsAppSocketListen,
} from "./lifecycle.js";
import { DisconnectReason } from "./runtime-api.js";
import type { WebListenerCloseReason } from "./types.js";

const LOGGED_OUT_STATUS = DisconnectReason.loggedOut;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";
const BAILEYS_MESSAGE_TTL_MS = 10 * 60 * 1000;

type SocketSessionOptions = {
  sock: WASocket;
  socketRef?: { current: WASocket | null };
  accountId: string;
  authDir: string;
  selfChatMode?: boolean;
  socketTiming: Required<WhatsAppSocketTimingOptions>;
  shouldRetryDisconnect?: () => boolean;
  disconnectRetryPolicy?: {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
    maxAttempts: number;
  };
  disconnectRetryAbortSignal?: AbortSignal;
  recentMessageKeys?: WhatsAppBaileysMessageCache;
  logVerbose: (message: string) => void;
  logConnectionError: (error: unknown) => void;
};

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

function isRetryableSendDisconnectError(error: unknown): boolean {
  if (isWhatsAppSocketOperationTimeoutError(error)) {
    return false;
  }
  return /closed|reset|timed\s*out|disconnect|no active socket/i.test(formatError(error));
}

function shouldClearSocketRefAfterSendFailure(error: unknown): boolean {
  return /closed|reset|disconnect|no active socket/i.test(formatError(error));
}

export async function createWhatsAppAttachedSocketSession(options: SocketSessionOptions) {
  const { sock } = options;
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
    options.logVerbose(`Sent global '${presence}' presence on connect`);
  } catch (error) {
    options.logVerbose(`Failed to send '${presence}' presence on connect: ${String(error)}`);
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
  const self: WhatsAppSelfIdentity = selfIdentity.identity;

  // Captured replies may outlive this socket. Only adopt a successor whose
  // authenticated identity overlaps, otherwise a reconnect could cross accounts.
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

  const lidLookup = sock.signalRepository?.lidMapping;
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
        .catch((error: unknown) => {
          options.logVerbose(
            `Failed fetching WhatsApp reachout timelock before send: ${formatError(error)}`,
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
      const error = new Error(formatReachoutTimelockError(activeState));
      // Only the preflight proves no native write; retry checks may follow an ambiguous send.
      throw readinessOptions?.rememberReady
        ? new PlatformMessageNotDispatchedError(error.message, { cause: error })
        : error;
    }
    if (readinessOptions?.rememberReady && state) {
      // The top-level direct send checks readiness before typing; consume this
      // same socket/JID/version proof at the native send.
      rememberVerifiedSendReady(jid, currentSock);
    }
  };

  const assertSendReady = async (to: string) => {
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
    let lastError: unknown = new Error(RECONNECT_IN_PROGRESS_ERROR);
    for (let attempt = 1; ; attempt += 1) {
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
        } catch (error) {
          if (!shouldRetryDisconnect() || !isRetryableSendDisconnectError(error)) {
            throw error;
          }
          lastError = error;
          if (
            shouldClearSocketRefAfterSendFailure(error) &&
            options.socketRef?.current === currentSock
          ) {
            options.socketRef.current = null;
          }
        }
      } else if (!shouldRetryDisconnect()) {
        throw lastError;
      }

      if (attempt >= sendRetryMaxAttempts) {
        throw lastError;
      }
      const delayMs = computeBackoff(disconnectRetryPolicy, attempt);
      options.logVerbose(
        `Waiting ${delayMs}ms for WhatsApp reconnect before retrying send to ${jid}: ${formatError(lastError)}`,
      );
      try {
        await sleepWithAbort(delayMs, options.disconnectRetryAbortSignal);
      } catch {
        throw lastError;
      }
    }
  };

  const socketOperations: WhatsAppSocketOperationAdapter = {
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

  const markRead = async (target: WhatsAppReadReceiptTarget) => {
    const { id, remoteJid, participant } = target;
    await withWhatsAppSocketOperationTimeout(
      "readMessages",
      (getCurrentSock() ?? sock).readMessages([{ remoteJid, id, participant, fromMe: false }]),
      sendOperationTimeoutMs,
    );
  };

  const attachSockListener: WhatsAppSocketListen = (event, listener) =>
    attachEmitterListener(sock.ev, event, listener);

  const handleConnectionUpdate = (update: Partial<ConnectionState>) => {
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
    } catch (error) {
      options.logConnectionError(error);
      resolveClose({ status: undefined, isLoggedOut: false, error });
    }
  };

  let detachConnectionUpdate: (() => void) | undefined;
  const start = () => {
    detachConnectionUpdate ??= attachSockListener("connection.update", handleConnectionUpdate);
  };
  const stop = () => {
    detachConnectionUpdate?.();
    detachConnectionUpdate = undefined;
  };
  const closeSocket = () => {
    try {
      closeInboundMonitorSocket(sock);
    } catch (error) {
      options.logVerbose(`Socket close failed: ${String(error)}`);
    }
  };

  return {
    connectedAtMs,
    self,
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    start,
    stop,
    closeSocket,
    listen: attachSockListener,
    getCurrentSock,
    resolveInboundJid,
    resolveReactionTargetJids,
    rememberBaileysMessage,
    assertCanSendToJid,
    assertSendReady,
    sendTrackedMessage,
    socketOperations,
    markRead,
  } as const;
}

export type WhatsAppAttachedSocketSession = Awaited<
  ReturnType<typeof createWhatsAppAttachedSocketSession>
>;
