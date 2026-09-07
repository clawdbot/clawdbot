// Whatsapp plugin module owns inbound message admission and delivery.
import { createHash } from "node:crypto";
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WASocket } from "baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound-debounce";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime, createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { maybeResolveWhatsAppApprovalReaction } from "../approval-reactions.js";
import { resolveComparableIdentity } from "../identity.js";
import { addWhatsAppImagePreviewFields } from "../image-preview.js";
import { maybeResolveWhatsAppQuestionReaction } from "../question-reactions.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { formatError } from "../session.js";
import { requireWhatsAppInboundAdmission } from "./admission.js";
import {
  createWhatsAppDurableInboundQueue,
  createWhatsAppIngressMonitor,
  type WhatsAppDurableInboundQueue,
  type WhatsAppIngressAdmission,
  type WhatsAppIngressLifecycle,
  type WhatsAppReadReceiptTarget,
} from "./durable-receive.js";
import type { WhatsAppGroupMetadataCacheOwner } from "./group-metadata-cache.js";
import {
  createWhatsAppInboundMessageDebouncer,
  type WhatsAppQueuedInboundMessage,
} from "./message-debounce.js";
import {
  enrichWhatsAppInboundMessage,
  type WhatsAppEnrichedInboundMessage,
} from "./message-enrichment.js";
import {
  createWhatsAppInboundMessageNormalizer,
  type WhatsAppNormalizedInboundMessage,
} from "./message-normalization.js";
import { addWhatsAppOutboundMentionsToContent } from "./outbound-mentions.js";
import { createWhatsAppReadReceiptDispatcher } from "./read-receipt-dispatch.js";
import { normalizeWhatsAppSendResult } from "./send-result.js";
import type { WhatsAppAttachedSocketSession } from "./socket-session.js";
import type { WebInboundCallbackMessage } from "./types.js";

const INBOUND_CLOSE_DRAIN_TIMEOUT_MS = 5_000;
const WHATSAPP_INGRESS_DRAIN_INTERVAL_MS = 1_000;

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

function logWhatsAppVerbose(enabled: boolean | undefined, message: string) {
  if (!enabled) {
    return;
  }
  defaultRuntime.log(message);
}

function recordAcceptedInboundActivity(accountId: string): void {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "inbound",
  });
}

export type WhatsAppAppendReplyWindow = {
  afterMs: number;
  untilMs: number;
  maxAgeMs: number;
};

type WhatsAppMessageDeliveryOptions = {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  verbose: boolean;
  accountId: string;
  sock: WASocket;
  socketSession: WhatsAppAttachedSocketSession;
  groupMetadata: WhatsAppGroupMetadataCacheOwner;
  onMessage: (msg: WebInboundCallbackMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Bounded reconnect window for offline append auto-replies. */
  appendReplyWindow?: WhatsAppAppendReplyWindow;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundCallbackMessage) => boolean;
  onPendingWorkChanged?: (pendingWorkCount: number, at?: number) => void;
  durableInboundQueue?: WhatsAppDurableInboundQueue;
};

export function createWhatsAppMessageDeliveryCoordinator(options: WhatsAppMessageDeliveryOptions) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = options.sock;
  const socketSession = options.socketSession;
  const groupMetadata = options.groupMetadata;
  const {
    connectedAtMs,
    self,
    getCurrentSock,
    resolveInboundJid,
    resolveReactionTargetJids,
    rememberBaileysMessage,
    assertCanSendToJid,
    sendTrackedMessage,
    socketOperations,
  } = socketSession;
  const durableInboundQueue =
    options.durableInboundQueue ?? createWhatsAppDurableInboundQueue(options.accountId);
  const pendingMessageHandlers = new Set<Promise<void>>();
  let durableIngressActive = false;
  let nextReceiveOrder = 0;
  const publishPendingWorkState = (at = Date.now()) => {
    options.onPendingWorkChanged?.(
      pendingMessageHandlers.size +
        messageDebouncer.pendingWorkCount() +
        (durableIngressActive ? 1 : 0),
      at,
    );
  };
  const messageNormalizer = createWhatsAppInboundMessageNormalizer({
    cfg: options.cfg,
    loadConfig: options.loadConfig,
    accountId: options.accountId,
    verbose: options.verbose,
    socketSession,
    groupMetadata,
    parseTimestampSeconds: parseWhatsAppTimestampSeconds,
    logVerbose: (message) => logWhatsAppVerbose(options.verbose, message),
  });
  const normalizeInboundMessage = messageNormalizer.normalize;
  const shouldSkipRecentOutboundEcho = messageNormalizer.shouldSkipRecentOutboundEcho;

  const buildReadReceiptTarget = (
    inbound: WhatsAppNormalizedInboundMessage,
  ): WhatsAppReadReceiptTarget | undefined =>
    inbound.id
      ? {
          remoteJid: inbound.remoteJid,
          id: inbound.id,
          ...(inbound.participantJid ? { participant: inbound.participantJid } : {}),
        }
      : undefined;

  const readReceiptDispatcher = createWhatsAppReadReceiptDispatcher({
    markRead: (target) => socketSession.markRead(target),
    sendReadReceipts: options.sendReadReceipts !== false,
    logVerbose: (message) => logWhatsAppVerbose(options.verbose, message),
    logger: inboundLogger,
  });

  const maybeLogSkippedSelfChatReadReceipt = (
    inbound: WhatsAppNormalizedInboundMessage,
    target: WhatsAppReadReceiptTarget | undefined,
  ) => {
    if (target?.id && inbound.access.isSelfChat && options.verbose) {
      // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
      logWhatsAppVerbose(options.verbose, `Self-chat mode: skipping read receipt for ${target.id}`);
    }
  };

  const maybeMarkNonSelfChatReadReceipt = async (
    inbound: WhatsAppNormalizedInboundMessage,
    target: WhatsAppReadReceiptTarget | undefined,
  ) => {
    if (inbound.access.isSelfChat) {
      maybeLogSkippedSelfChatReadReceipt(inbound, target);
      return;
    }
    await readReceiptDispatcher.maybeMarkInboundAsRead(target);
  };

  // Fire-and-track dispatch: the sequential upsert loop must never wait on a
  // read-receipt acknowledgement. markRead is bounded by the socket operation
  // timeout (default 60s), so one stalled receipt would otherwise delay the
  // admission of every later message in the same upsert. The dispatch is
  // awaited nowhere; the dedupe reservation and bounded pending queue live in
  // the read-receipt dispatcher, and errors are logged here so no rejection
  // escapes unhandled.
  const dispatchReadReceipt = (
    inbound: WhatsAppNormalizedInboundMessage,
    target: WhatsAppReadReceiptTarget | undefined,
  ) => {
    maybeMarkNonSelfChatReadReceipt(inbound, target).catch((error: unknown) => {
      inboundLogger.warn(
        { error: formatError(error) },
        "failed dispatching WhatsApp receive-time read receipt",
      );
    });
  };
  const messageDebouncer = createWhatsAppInboundMessageDebouncer({
    resolveDebounceMs: () =>
      resolveInboundDebounceMs({
        cfg: options.loadConfig?.() ?? options.cfg,
        channel: "whatsapp",
        overrideMs: options.debounceMs,
      }),
    onMessage: options.onMessage,
    shouldDebounce: options.shouldDebounce,
    onPendingWorkChanged: publishPendingWorkState,
    onError: (error) => {
      inboundLogger.error({ error: String(error) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(error)}`);
    },
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

  // Live rows keep receive-time identity facts until their first drain attempt.
  // Restart replay has no entry and re-normalizes from the persisted payload.
  type PreparedInbound = NonNullable<Awaited<ReturnType<typeof normalizeInboundMessage>>>;
  const preparedInboundByDurableId = new Map<string, Promise<PreparedInbound | null | undefined>>();

  const enqueueInboundMessage = async (
    msg: WAMessage,
    inbound: WhatsAppNormalizedInboundMessage,
    enriched: WhatsAppEnrichedInboundMessage,
    durable: {
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
        await socketOperations.sendPresenceUpdate("composing", chatJid);
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Presence update failed: ${String(err)}`);
      }
    };
    const reply = async (text: string, optionsResult?: MiscMessageGenerationOptions) => {
      const resolved = await groupMetadata.resolveOutboundMentions(chatJid, text);
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
        await groupMetadata.applyOutboundMentions(chatJid, previewPayload),
        optionsValue,
      );
      return normalizeWhatsAppSendResult(result, "media");
    };
    const timestamp = inbound.messageTimestampMs;
    const mentionedJids = enriched.mentionedJids;
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
      enriched.mediaPath || enriched.mediaType || enriched.mediaFileName || enriched.mediaKind
        ? {
            path: enriched.mediaPath,
            type: enriched.mediaType,
            fileName: enriched.mediaFileName,
            kind: enriched.mediaKind,
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
    const channelStructuredContext = [
      ...(enriched.nativeMedia
        ? [
            {
              label: "WhatsApp media",
              source: "whatsapp",
              type: "media",
              payload: enriched.nativeMedia,
            },
          ]
        : []),
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
    const inboundMessage: WhatsAppQueuedInboundMessage = {
      admission: inbound.access.admission,
      event: {
        id: inbound.id,
        timestamp,
      },
      payload: {
        body: enriched.body,
        commandBody: enriched.commandBody,
        location: enriched.location ?? undefined,
        channelStructuredContext:
          channelStructuredContext.length > 0 ? channelStructuredContext : undefined,
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
            media: enriched.replyContext.media,
            sender: {
              displayName: enriched.replyContext.sender?.label ?? undefined,
              jid: enriched.replyContext.sender?.jid ?? undefined,
              e164: enriched.replyContext.sender?.e164 ?? undefined,
            },
          }
        : undefined,
      group,
      turnAdoptionLifecycle: durable.turnAdoptionLifecycle,
      receiveOrder: durable.receiveOrder,
    };
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
          media: enriched.nativeMedia,
          fromMe: inboundMessage.platform.fromMe,
        },
      );
    }
    await messageDebouncer.enqueue(inboundMessage);
  };

  const processDurableInboundMessage = async (
    admission: WhatsAppIngressAdmission,
    lifecycle: WhatsAppIngressLifecycle,
  ): Promise<"completed" | "deferred"> => {
    const { message: msg, ...context } = admission;
    rememberBaileysMessage(msg.key?.remoteJid, msg.key?.id, msg.message);
    const remoteJid = msg.key?.remoteJid;
    const id = msg.key?.id;
    const durableId =
      remoteJid && id
        ? createHash("sha256").update(`${remoteJid}\n${id}`).digest("hex")
        : undefined;
    const preparation = durableId ? preparedInboundByDurableId.get(durableId) : undefined;
    if (durableId) {
      preparedInboundByDurableId.delete(durableId);
    }
    if (context.skipRecentOutboundEcho === true) {
      return "completed";
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
    if (context.skipStaleAppend === true) {
      return "completed";
    }

    const enriched = await enrichWhatsAppInboundMessage({
      msg,
      sock,
      mediaMaxMb: options.mediaMaxMb,
      logVerbose: (message) => logWhatsAppVerbose(options.verbose, message),
    });
    if (!enriched) {
      return "completed";
    }

    // Cold durable replay (restart recovery) bypasses handleMessagesUpsert,
    // where every live receipt dispatch lives. Rows the live path admitted
    // carry a preparation entry, so only rows without one still need the
    // receive-time retry here; the dispatcher dedupes against any receipt
    // the live path already sent.
    if (preparation === undefined) {
      dispatchReadReceipt(inbound, buildReadReceiptTarget(inbound));
    }

    recordAcceptedInboundActivity(options.accountId);
    await enqueueInboundMessage(msg, inbound, enriched, {
      receiveOrder: context.receiveOrder ?? context.receivedAt,
      turnAdoptionLifecycle: lifecycle,
    });
    return "deferred";
  };

  const durableInboundMonitor = createWhatsAppIngressMonitor({
    queue: durableInboundQueue,
    dispatch: async (admission, lifecycle) => ({
      kind: await processDurableInboundMessage(admission, lifecycle),
    }),
    pollIntervalMs: WHATSAPP_INGRESS_DRAIN_INTERVAL_MS,
    onLog: (message) => inboundLogger.warn({ message }, "whatsapp ingress drain"),
    onError: (error) =>
      inboundLogger.error({ error: formatError(error) }, "whatsapp durable inbound drain failed"),
    onActivityChange: (active) => {
      durableIngressActive = active;
      publishPendingWorkState();
    },
  });

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
        remoteJid && id
          ? createHash("sha256").update(`${remoteJid}\n${id}`).digest("hex")
          : undefined;
      let resolvePrepared: ((inbound: PreparedInbound | null | undefined) => void) | undefined;
      // A redelivery must not replace the first accepted delivery's preparation.
      if (durableId && !preparedInboundByDurableId.has(durableId)) {
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
        if (!keepForDrain && durableId && resolvePrepared) {
          preparedInboundByDurableId.delete(durableId);
        }
      };
      let result: Awaited<ReturnType<typeof durableInboundMonitor.admit>>;
      try {
        // Shared admission owns the serialized [0, 100, 300] append retries and
        // returns the atomic accepted/pending/completed queue verdict.
        result = await durableInboundMonitor.admit(
          {
            message: msg,
            upsertType: upsert.type,
            skipStaleAppend,
            skipRecentOutboundEcho,
            receivedAt,
            receiveOrder,
          },
          { receivedAt },
        );
      } catch (error) {
        finishPreparation(undefined);
        const formattedError = formatError(error);
        inboundLogger.error(
          { error: formattedError },
          "failed persisting durable WhatsApp inbound after retries; message dropped",
        );
        inboundConsoleLog.error(
          `Failed persisting durable WhatsApp inbound after retries; message dropped: ${formattedError}`,
        );
        continue;
      }
      if (result.kind === "durable" && result.queueResult.kind === "completed") {
        finishPreparation(undefined);
        const inbound = await normalizeInboundMessage(msg);
        if (inbound) {
          dispatchReadReceipt(inbound, buildReadReceiptTarget(inbound));
        }
      } else if (result.kind === "durable" && result.queueResult.kind === "accepted") {
        if (skipRecentOutboundEcho) {
          finishPreparation(null);
        } else {
          let acceptedInbound: PreparedInbound | null | undefined;
          try {
            acceptedInbound = await normalizeInboundMessage(msg);
            // Publish the prepared identity first so the durable drain never
            // waits on a stalled receipt ack, then fire the read receipt.
            finishPreparation(acceptedInbound, true);
          } catch (error) {
            finishPreparation(undefined);
            acceptedInbound = undefined;
            inboundLogger.warn(
              { error: formatError(error) },
              "failed preparing WhatsApp inbound identity; durable drain will normalize again",
            );
          }
          if (acceptedInbound) {
            // Read receipts (blue ticks) fire at receive time: the sender sees
            // the message was read as soon as the gateway ingests it, before
            // the agent turn starts (issue #128875). Fire-and-track only: a
            // stalled acknowledgement must not delay the admission of later
            // messages in the same upsert.
            dispatchReadReceipt(acceptedInbound, buildReadReceiptTarget(acceptedInbound));
          }
        }
      } else {
        // Pending redelivery leaves the first accepted delivery's preparation in place.
        finishPreparation(undefined);
        // An active durable duplicate (row still pending or claimed) can carry
        // a receive-time receipt whose first attempt failed: the admission
        // verdict has no accepted branch for it, so a replay would otherwise
        // never re-reach the dispatcher and the blue tick would stay lost.
        // The dispatcher dedupes across sent/in-flight/pending, so completed
        // or in-flight acknowledgements stay no-ops, and the agent turn is
        // never redelivered here (turn dispatch is owned by the ingress drain).
        if (
          !skipRecentOutboundEcho &&
          result.kind === "durable" &&
          (result.queueResult.kind === "pending" || result.queueResult.kind === "claimed")
        ) {
          const inbound = await normalizeInboundMessage(msg);
          if (inbound) {
            dispatchReadReceipt(inbound, buildReadReceiptTarget(inbound));
          }
        }
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
    await messageDebouncer.drain();
  };
  const drainInboundBeforeSocketClose = async () => {
    // Interleave force-flush with event-driven wait for drain dispatch so close
    // cannot deadlock inside the debounce window. Debounce semantics stay intact.
    for (;;) {
      await drainDebouncedInboundMessages();
      if (pendingMessageHandlers.size === 0) {
        break;
      }
      const handlers = Array.from(pendingMessageHandlers);
      await Promise.race([
        Promise.allSettled(handlers),
        messageDebouncer.waitForWorkOrIdle(handlers, pendingMessageHandlers.size === 0),
      ]);
      if (pendingMessageHandlers.size === 0 && !messageDebouncer.hasPendingWork()) {
        break;
      }
    }
    await drainDebouncedInboundMessages();
    // A flush can adopt one claim and wake the next row in the same lane.
    // Alternate until neither the monitor nor debounce layer can create more work.
    for (;;) {
      await durableInboundMonitor.waitForIdle();
      if (!messageDebouncer.hasPendingWork()) {
        break;
      }
      await drainDebouncedInboundMessages();
    }
    await durableInboundMonitor.stop();
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
      // Start abort/dispose even when channel work ignored the graceful bound;
      // a successor must not share this account queue with a live owner.
      void durableInboundMonitor.stop();
    }
  };
  let detachMessagesUpsert: (() => void) | undefined;
  const start = () => {
    if (detachMessagesUpsert) {
      return;
    }
    detachMessagesUpsert = socketSession.listen(
      "messages.upsert",
      handleMessagesUpsertEvent as unknown as (...args: unknown[]) => void,
    );
    durableInboundMonitor.start();
  };
  const stopIntake = () => {
    detachMessagesUpsert?.();
    detachMessagesUpsert = undefined;
  };

  return {
    start,
    stopIntake,
    drain: drainInboundBeforeSocketCloseWithTimeout,
  } as const;
}
