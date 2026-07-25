// Control UI queued-send implementation.
import { isNonTerminalAgentRunStatus } from "../../../../src/shared/agent-run-status.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { setLastActiveSessionKey } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { discardChatAttachmentDataUrls } from "./attachment-payload-store.ts";
import type { ChatCommandResetOptions } from "./chat-commands.ts";
import { loadChatBranches, loadChatHistory, type ChatState } from "./chat-history.ts";
import {
  flushStoredChatOutbox,
  retryableGatewayDelayMs,
  scheduleStoredChatOutboxDrain,
  scheduleStoredChatOutboxRetry,
  UNCONFIRMED_CHAT_SEND_ERROR,
  type ChatOutboxDrainDependencies,
  type QueuedChatSendOptions,
  type QueuedChatSendResult,
  type QueuedChatStorageMode,
} from "./chat-outbox-drain.ts";
import {
  admitQueuedMessageForSession,
  excludeComposerAttachments,
  readQueuedMessageById,
  removeQueuedMessageWithoutReleasing,
  updateQueuedMessageForSession,
} from "./chat-queue.ts";
import { isTerminalFailureChatSendAck } from "./chat-send-ack.ts";
import {
  cancelPendingSendBeforeRequest,
  pendingComposerRestorePlan,
  restoreComposerAfterFailedSend,
} from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  enqueuePendingSendMessage,
  finishScopedChatSending,
  reconnectSafeQueuedSendState,
  setChatError,
  updateQueuedSendItem,
  waitForPendingChatSettings,
} from "./chat-send-queue-state.ts";
import {
  isActiveLeafChangedError,
  requestChatSend,
  requestSkillWorkshopRevisionChatSend,
} from "./chat-send-request.ts";
import {
  chatSendAckServerTimingEventFields,
  recordChatSendTiming,
  registerChatSendTiming,
  updateChatSendAckTiming,
} from "./chat-send-timing.ts";
import { getPendingChatPickerPatch, refreshChatSessionListForTarget } from "./chat-session.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  listStoredChatOutboxes,
  storedChatOutboxScopeKey,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";
import { formatConnectError } from "./connect-error.ts";
import { resetChatInputHistoryNavigation } from "./input-history.ts";
import { controlUiNowMs, roundedControlUiDurationMs } from "./performance.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll, resetChatScroll } from "./scroll.ts";
import { formatTerminalChatSendAckError, OFFLINE_QUEUE_STORAGE_ERROR } from "./steer-lifecycle.ts";
import { resetToolStream } from "./tool-stream.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

export const chatOutboxDrainDependencies: ChatOutboxDrainDependencies = {
  sendQueuedChatMessage,
  sendResetSlashCommand: (host, message, opts: ChatCommandResetOptions) =>
    sendChatMessageNow(host, message, {
      refreshSessions: true,
      previousDraft: opts.previousDraft,
      restoreDraft: opts.restoreDraft,
      routingSessionKey: host.sessionKey,
    }).then(() => undefined),
  setChatError,
};

export async function sendQueuedChatMessage(
  host: ChatHost,
  id: string,
  opts?: QueuedChatSendOptions,
  queuedSessionKey = host.sessionKey,
): Promise<QueuedChatSendResult> {
  const storageMode = opts?.storageMode ?? "durable";
  let queued = readQueuedMessageById(host, id);
  if (!queued || queued.pendingRunId || queued.localCommandName) {
    return "failed";
  }
  // Foreground sends keep the submitted route for picker admission. Durable
  // storage may canonicalize an agent-main alias to its global outbox scope.
  const queueSessionKey = queued.sessionKey ?? queuedSessionKey;
  const pickerSessionKey = opts?.routingSessionKey ?? queueSessionKey;
  const pendingSettings = getPendingChatPickerPatch(host, pickerSessionKey, queued.agentId);
  if (pendingSettings) {
    // Final admission gate for retries/reconnect replays and picker patches
    // that start after the composer-level snapshot.
    updateQueuedSendItem(host, storageMode, queueSessionKey, id, (item) => ({
      ...item,
      sendError: undefined,
      sendState: "waiting-model",
    }));
    host.requestUpdate?.();
    if (
      !(await waitForPendingChatSettings(host, pickerSessionKey, pendingSettings, queued.agentId))
    ) {
      const canRestoreComposer =
        opts?.previousDraft !== undefined &&
        !host.chatMessage.trim() &&
        host.chatAttachments.length === 0;
      if (
        canRestoreComposer &&
        host.sessionKey === pickerSessionKey &&
        visibleSessionMatches(host, pickerSessionKey, queued.agentId)
      ) {
        cancelPendingSendBeforeRequest(host, queued, {
          previousDraft: opts.previousDraft,
          previousAttachments: opts.previousAttachments,
        });
      } else {
        updateQueuedSendItem(host, storageMode, queueSessionKey, id, (item) => ({
          ...item,
          sendError: INTERRUPTED_SETTINGS_WAIT_ERROR,
          sendState: "failed",
        }));
      }
      host.requestUpdate?.();
      return "failed";
    }
    queued = readQueuedMessageById(host, id);
    if (!queued) {
      return "failed";
    }
  }
  if (
    opts?.routingSessionKey &&
    (host.sessionKey !== opts.routingSessionKey ||
      !visibleSessionMatches(host, opts.routingSessionKey, queued.agentId))
  ) {
    const parked = updateQueuedSendItem(host, storageMode, queueSessionKey, id, (item) => ({
      ...item,
      sendError: undefined,
      sendState: host.connected && host.client ? "waiting-idle" : "waiting-reconnect",
    }));
    if (!parked) {
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    }
    return "pending";
  }
  const queuedForRoute = opts?.routingSessionKey
    ? { ...queued, sessionKey: opts.routingSessionKey }
    : queued;
  let prepared: ChatQueueItem | null = queuedForRoute;
  if (!prepared.sendRunId || !prepared.sendState) {
    const sessionKey = prepared.sessionKey ?? queuedSessionKey;
    const next: ChatQueueItem = {
      ...prepared,
      sendAttempts: prepared.sendAttempts ?? 0,
      sendRunId: prepared.sendRunId ?? generateUUID(),
      sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
      sessionKey,
      agentId: prepared.agentId ?? scopedAgentIdForSession(host, sessionKey),
    };
    prepared = updateQueuedSendItem(host, storageMode, sessionKey, prepared.id, () => next);
  }
  if (!prepared) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return "pending";
  }
  const message = prepared.text.trim();
  const attachments = prepared.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  if (!message && !hasAttachments) {
    removeQueuedMessageWithoutReleasing(host, id, prepared.sessionKey ?? host.sessionKey);
    return "sent";
  }
  if (prepared.skillWorkshopRevision && hasAttachments) {
    updateQueuedSendItem(host, storageMode, prepared.sessionKey ?? host.sessionKey, id, (item) => ({
      ...item,
      sendError: "Skill Workshop revision requests do not support attachments.",
      sendState: "failed",
    }));
    return "failed";
  }
  const sessionKey = prepared.sessionKey ?? host.sessionKey;
  if (!host.connected || !host.client) {
    const waiting = updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
      ...item,
      sendState: "waiting-reconnect",
      sendError: undefined,
    }));
    if (!waiting) {
      const hasComposerSnapshot =
        opts?.previousDraft !== undefined || opts?.previousAttachments !== undefined;
      const canRestoreComposer =
        hasComposerSnapshot && pendingComposerRestorePlan(host, opts ?? {}).complete;
      if (canRestoreComposer) {
        cancelPendingSendBeforeRequest(host, waiting ?? prepared, {
          previousDraft: opts?.previousDraft,
          previousAttachments: opts?.previousAttachments,
        });
      } else {
        updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
          ...item,
          sendError: OFFLINE_QUEUE_STORAGE_ERROR,
          sendState: "failed",
        }));
      }
      if (visibleSessionMatches(host, sessionKey, prepared.agentId)) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      }
      return canRestoreComposer ? "failed" : "pending";
    }
    return "pending";
  }

  const runId = prepared.sendRunId ?? generateUUID();
  const startedAt = Date.now();
  const requestStartedAtMs = controlUiNowMs();
  const sendingItem = updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
    ...item,
    sendAttempts: (item.sendAttempts ?? 0) + 1,
    sendError: undefined,
    sendRunId: runId,
    sendState: "sending",
    sendRequestStartedAtMs: requestStartedAtMs,
    sessionKey,
    agentId: prepared.agentId,
  }));
  if (!sendingItem) {
    if (visibleSessionMatches(host, sessionKey, prepared.agentId)) {
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    }
    return "pending";
  }
  registerChatSendTiming(host, sendingItem, runId, requestStartedAtMs);
  recordChatSendTiming(host, sendingItem, "request-start", sendingItem.sendSubmittedAtMs);
  const sendingScope: StoredChatOutboxScope = {
    sessionKey,
    ...(prepared.agentId ? { agentId: prepared.agentId } : {}),
  };
  if (visibleSessionMatches(host, sendingScope.sessionKey, sendingScope.agentId)) {
    host.chatSendingScopeKey = storedChatOutboxScopeKey(sendingScope);
    host.chatSending = true;
  }
  const isVisibleSession = () => visibleSessionMatches(host, sessionKey, prepared.agentId);
  if (isVisibleSession()) {
    resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
    resetChatScroll(host as unknown as Parameters<typeof resetChatScroll>[0]);
    setChatError(host, null);
    reconcileChatRunLifecycle(host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      clearRunStatus: true,
    });
  }

  try {
    const ack = prepared.skillWorkshopRevision
      ? await requestSkillWorkshopRevisionChatSend(host as unknown as ChatState, {
          proposalId: prepared.skillWorkshopRevision.proposalId,
          ...(prepared.skillWorkshopRevision.agentId
            ? { agentId: prepared.skillWorkshopRevision.agentId }
            : {}),
          ...(prepared.agentId ? { targetAgentId: prepared.agentId } : {}),
          instructions: message,
          runId,
          sessionKey,
        })
      : await requestChatSend(host as unknown as ChatState, {
          message,
          attachments: hasAttachments ? attachments : undefined,
          runId,
          sessionKey,
          agentId: prepared.agentId,
          ...(opts?.expectedLeafEntryId !== undefined
            ? { expectedLeafEntryId: opts.expectedLeafEntryId }
            : {}),
          ...(prepared.replyToId ? { replyToId: prepared.replyToId } : {}),
        });
    updateChatSendAckTiming(host, runId, ack, sendingItem, requestStartedAtMs);
    recordChatSendTiming(host, sendingItem, "ack", sendingItem.sendSubmittedAtMs, {
      ackStatus: ack.status,
      requestDurationMs: roundedControlUiDurationMs(controlUiNowMs() - requestStartedAtMs),
      ...chatSendAckServerTimingEventFields(ack),
    });
    if (isTerminalFailureChatSendAck(ack)) {
      const error = formatTerminalChatSendAckError(ack, "chat");
      updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
        ...item,
        sendError: error,
        sendState: "failed",
      }));
      if (isVisibleSession()) {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            outcome: "interrupted",
            sessionStatus: ack.status === "error" ? "failed" : "killed",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            publishRunStatus: false,
            armLocalTerminalReconcile: ack.runId === runId,
          },
        );
        setChatError(host, error);
        restoreComposerAfterFailedSend(host, opts ?? {});
      }
      recordChatSendTiming(host, sendingItem, "failed", sendingItem.sendSubmittedAtMs, {
        error,
        ackStatus: ack.status,
      });
      return "failed";
    }
    const retireOnAck = ack.status === "ok" || storageMode === "memory";
    if (retireOnAck) {
      removeQueuedMessageWithoutReleasing(host, id, sessionKey);
    }
    if (isVisibleSession()) {
      if (retireOnAck) {
        host.chatMessages = [
          ...host.chatMessages,
          {
            role: "user",
            content: buildUserChatMessageContentBlocks(
              message,
              hasAttachments ? attachments : undefined,
            ),
            timestamp: startedAt,
            // Send identity keeps this optimistic turn on the same rendered
            // bubble key as the pending row and the authoritative history copy.
            __openclaw: { idempotencyKey: `${runId}:user` },
          },
        ];
      }
      if (ack.status === "ok") {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            outcome: "done",
            sessionStatus: "done",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            publishRunStatus: false,
            armLocalTerminalReconcile: true,
          },
        );
        void loadChatHistory(host as unknown as ChatState);
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        const hasAlreadyAdoptedRun = host.chatRunId === ack.runId;
        const hasAlreadyAdoptedRunStream =
          hasAlreadyAdoptedRun && typeof host.chatStream === "string";
        host.chatRunId = ack.runId;
        if (!hasAlreadyAdoptedRun) {
          host.chatRunStartup = null;
        }
        // Gateway can deliver the first delta before the chat.send ACK resolves.
        // Preserve that adopted stream; resetting here makes first replies vanish
        // until a later delta or final event arrives.
        if (!hasAlreadyAdoptedRunStream) {
          host.chatStream = "";
          (host as ChatHost & { chatStreamStartedAt?: number | null }).chatStreamStartedAt =
            startedAt;
        }
      } else {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            outcome: "interrupted",
            sessionStatus: ack.status === "error" ? "failed" : "killed",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            publishRunStatus: false,
            armLocalTerminalReconcile: ack.runId === runId,
          },
        );
      }
    }
    if (prepared.refreshSessions) {
      const refreshTarget = {
        sessionKey,
        agentId: prepared.agentId,
      };
      if (ack.status === "ok") {
        void refreshChatSessionListForTarget(host, refreshTarget);
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        host.refreshSessionsAfterChat.set(ack.runId, refreshTarget);
      }
    }
    discardChatAttachmentDataUrls(excludeComposerAttachments(host, attachments));
    return retireOnAck ? "sent" : "pending";
  } catch (err) {
    finishScopedChatSending(host, sendingScope);
    if (isActiveLeafChangedError(err)) {
      const error = t("chat.sendErrors.activeLeafChanged");
      updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
        ...item,
        sendError: error,
        sendState: "failed",
      }));
      if (isVisibleSession()) {
        setChatError(host, error);
        restoreComposerAfterFailedSend(host, opts ?? {});
        void Promise.all([
          loadChatHistory(host as unknown as ChatState),
          loadChatBranches(host as unknown as ChatState),
        ]);
      }
      recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error });
      return "failed";
    }
    const error = formatConnectError(err);
    const recoverable =
      err instanceof GatewayRequestError
        ? err.retryable
        : /gateway (?:not connected|closed)|websocket|disconnected/i.test(error);
    if (recoverable) {
      const failedBeforeTransport =
        err instanceof Error &&
        !(err instanceof GatewayRequestError) &&
        err.message === "gateway not connected";
      const retryDelayMs = retryableGatewayDelayMs(err);
      const safelyRejected = failedBeforeTransport || retryDelayMs !== null;
      if (storageMode === "memory") {
        const hasComposerSnapshot =
          opts?.previousDraft !== undefined || opts?.previousAttachments !== undefined;
        const canRestoreSafely =
          hasComposerSnapshot &&
          safelyRejected &&
          pendingComposerRestorePlan(host, opts ?? {}).complete;
        if (canRestoreSafely) {
          cancelPendingSendBeforeRequest(host, prepared, {
            previousDraft: opts?.previousDraft,
            previousAttachments: opts?.previousAttachments,
          });
        } else {
          updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
            ...item,
            ...(safelyRejected
              ? {
                  sendAttempts: queued.sendAttempts,
                  sendRequestStartedAtMs: queued.sendRequestStartedAtMs,
                }
              : {}),
            sendError: safelyRejected ? error : UNCONFIRMED_CHAT_SEND_ERROR,
            sendState: safelyRejected ? "failed" : "unconfirmed",
          }));
        }
        if (isVisibleSession()) {
          setChatError(host, canRestoreSafely ? error : OFFLINE_QUEUE_STORAGE_ERROR);
        }
        recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, {
          error: canRestoreSafely ? error : OFFLINE_QUEUE_STORAGE_ERROR,
        });
        return canRestoreSafely ? "failed" : "pending";
      }
      const waiting = updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
        ...item,
        ...(safelyRejected
          ? {
              sendAttempts: queued.sendAttempts,
              sendRequestStartedAtMs: queued.sendRequestStartedAtMs,
            }
          : {}),
        sendError: error,
        sendState: "waiting-reconnect",
      }));
      if (!waiting) {
        const hasComposerSnapshot =
          opts?.previousDraft !== undefined || opts?.previousAttachments !== undefined;
        const canRestorePreTransport =
          hasComposerSnapshot &&
          failedBeforeTransport &&
          pendingComposerRestorePlan(host, opts ?? {}).complete;
        if (canRestorePreTransport) {
          cancelPendingSendBeforeRequest(host, waiting ?? prepared, {
            previousDraft: opts?.previousDraft,
            previousAttachments: opts?.previousAttachments,
          });
        } else {
          // The request may have reached the Gateway. Retain its run id so a
          // manual retry remains idempotent even when this tab cannot persist it.
          updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
            ...item,
            sendError: OFFLINE_QUEUE_STORAGE_ERROR,
            sendState: "failed",
          }));
        }
        if (isVisibleSession()) {
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        }
        recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, {
          error: OFFLINE_QUEUE_STORAGE_ERROR,
        });
        return canRestorePreTransport ? "failed" : "pending";
      }
      if (isVisibleSession()) {
        setChatError(
          host,
          retryDelayMs === null
            ? "Message will send when the Gateway reconnects."
            : "The Gateway asked us to retry this message shortly.",
        );
      }
      if (retryDelayMs !== null) {
        scheduleStoredChatOutboxRetry(
          host,
          { sessionKey, agentId: prepared.agentId },
          retryDelayMs,
          chatOutboxDrainDependencies,
        );
      }
      recordChatSendTiming(host, prepared, "waiting-reconnect", prepared.sendSubmittedAtMs, {
        error,
      });
      return "pending";
    }
    updateQueuedSendItem(host, storageMode, sessionKey, id, (item) => ({
      ...item,
      sendError: error,
      sendState: "failed",
    }));
    if (isVisibleSession()) {
      setChatError(host, error);
      restoreComposerAfterFailedSend(host, opts ?? {});
    }
    recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error });
    return "failed";
  } finally {
    finishScopedChatSending(host, sendingScope);
  }
}

export async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    queueItemId?: string;
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    expectedLeafEntryId?: string | null;
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
    routingSessionKey?: string;
    storageMode?: QueuedChatStorageMode;
    submittedAtMs?: number;
  },
): Promise<QueuedChatSendResult> {
  const queued =
    opts?.queueItemId != null
      ? (host.chatQueue.find((item) => item.id === opts.queueItemId) ?? null)
      : enqueuePendingSendMessage(
          host,
          message,
          opts?.attachments,
          opts?.refreshSessions,
          opts?.submittedAtMs,
          reconnectSafeQueuedSendState(host),
        );
  if (!queued) {
    return "failed";
  }
  const queuedSessionKey = queued.sessionKey ?? host.sessionKey;
  if (opts?.queueItemId == null && !admitQueuedMessageForSession(host, queuedSessionKey, queued)) {
    cancelPendingSendBeforeRequest(host, queued, {
      previousDraft: opts?.previousDraft,
      previousAttachments: opts?.previousAttachments,
    });
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return "failed";
  }
  const storageMode = opts?.storageMode ?? "durable";
  let result: QueuedChatSendResult;
  if (storageMode === "memory") {
    result = await sendQueuedChatMessage(
      host,
      queued.id,
      {
        previousDraft: opts?.previousDraft,
        previousAttachments: opts?.previousAttachments,
        ...(opts?.expectedLeafEntryId !== undefined
          ? { expectedLeafEntryId: opts.expectedLeafEntryId }
          : {}),
        routingSessionKey: opts?.routingSessionKey ?? queuedSessionKey,
        storageMode,
      },
      queuedSessionKey,
    );
  } else {
    const queuedOutbox = listStoredChatOutboxes(host).find((outbox) =>
      outbox.queue.some((item) => item.id === queued.id),
    );
    if (!queuedOutbox) {
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return "pending";
    }
    await scheduleStoredChatOutboxDrain(
      host,
      queuedOutbox,
      chatOutboxDrainDependencies,
      queued.id,
      {
        previousDraft: opts?.previousDraft,
        previousAttachments: opts?.previousAttachments,
        ...(opts?.expectedLeafEntryId !== undefined
          ? { expectedLeafEntryId: opts.expectedLeafEntryId }
          : {}),
        routingSessionKey: opts?.routingSessionKey ?? queuedSessionKey,
      },
    );
    const storedItem = listStoredChatOutboxes(host)
      .flatMap((outbox) => outbox.queue)
      .find((item) => item.id === queued.id);
    result = !storedItem ? "sent" : storedItem.sendState === "failed" ? "failed" : "pending";
  }
  const sent = result === "sent";
  if (sent && host.sessionKey === queuedSessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      queuedSessionKey,
    );
    resetChatInputHistoryNavigation(host);
  }
  if (
    sent &&
    host.sessionKey === queuedSessionKey &&
    opts?.restoreDraft &&
    opts.previousDraft?.trim()
  ) {
    host.chatMessage = opts.previousDraft;
  }
  if (
    sent &&
    host.sessionKey === queuedSessionKey &&
    opts?.restoreAttachments &&
    opts.previousAttachments?.length
  ) {
    host.chatAttachments = opts.previousAttachments;
  }
  // Force scroll after sending to ensure viewport is at bottom for incoming stream
  if (host.sessionKey === queuedSessionKey) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true);
  }
  if (sent && host.sessionKey === queuedSessionKey && !host.chatRunId) {
    void flushStoredChatOutbox(host, chatOutboxDrainDependencies);
  }
  return result;
}
