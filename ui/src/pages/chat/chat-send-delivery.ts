import { isNonTerminalAgentRunStatus } from "../../../../src/shared/agent-run-status.js";
import { GatewayPayloadLimitError, GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import { INTERRUPTED_SETTINGS_WAIT_ERROR } from "../../lib/chat/outbox-store-codec.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { discardChatAttachmentDataUrls } from "./attachment-payload-store.ts";
import { readChatResetTargetAccess } from "./chat-commands.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  flushStoredChatOutbox,
  scheduleStoredChatOutboxDrain as scheduleOutboxDrain,
  scheduleStoredChatOutboxRetry,
  UNCONFIRMED_CHAT_SEND_ERROR,
  type ChatOutboxDrainDependencies,
  type QueuedChatSendOptions,
  type QueuedChatSendResult,
  type QueuedChatStorageMode,
} from "./chat-outbox-drain.ts";
import { retryableGatewayDelayMs } from "./chat-outbox-retry.ts";
import {
  excludeComposerAttachments,
  readQueuedMessageById,
  removeQueuedMessageWithoutReleasing,
  updateQueuedMessage,
} from "./chat-queue.ts";
import { createResetSlashCommandSender } from "./chat-reset-delivery.ts";
import { isTerminalFailureChatSendAck } from "./chat-send-ack.ts";
import { cancelChatDelivery, canRestoreComposer } from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  captureChatConnectionOwner,
  deliveryStateWriter,
  finishChatDeliveryAdmission,
  finishScopedChatSending,
  reconnectSafeQueuedSendState,
  prepareQueuedChatPayload,
  setChatError,
  updateQueuedSendItem,
} from "./chat-send-queue-state.ts";
import { isActiveLeafChangedError, requestChatSend } from "./chat-send-request.ts";
import {
  formatTerminalChatSendAckError,
  OFFLINE_QUEUE_STORAGE_ERROR,
  surfaceChatDeliveryFailure,
} from "./chat-send-support.ts";
import {
  chatSendAckServerTimingEventFields,
  recordChatSendTiming,
  registerChatSendTiming,
  updateChatSendAckTiming,
} from "./chat-send-timing.ts";
import { getPendingChatPickerPatch, refreshChatSessionListForTarget } from "./chat-session.ts";
import { formatConnectError } from "./connect-error.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import { resetChatInputHistoryNavigation } from "./input-history.ts";
import { controlUiNowMs, roundedControlUiDurationMs } from "./performance.ts";
import {
  adoptStartedChatRun,
  hasDirectSessionRun,
  isChatBusy,
  reconcileChatRunLifecycle,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { resetToolStream } from "./tool-stream.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

async function settleDeliverySettings(
  host: ChatHost,
  item: ChatQueueItem,
  storageMode: QueuedChatStorageMode,
  queueSessionKey: string,
  options: QueuedChatSendOptions | undefined,
  consumed: Set<Promise<boolean>>,
): Promise<ChatQueueItem | QueuedChatSendResult> {
  const route = options?.routingSessionKey ?? queueSessionKey;
  const setState = deliveryStateWriter(host, storageMode, item.id);
  const routeVisible = (agentId = item.agentId) => visibleSessionMatches(host, route, agentId);
  let current = readQueuedMessageById(host, item.id);
  let pendingSettings =
    options?.pendingSettings ?? getPendingChatPickerPatch(host, route, item.agentId);

  while (pendingSettings && !consumed.has(pendingSettings)) {
    if (current?.sendState !== "waiting-model") {
      current = setState("waiting-model");
      if (!current) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      }
    }
    host.requestUpdate?.();

    const ready = await pendingSettings;
    consumed.add(pendingSettings);
    current = readQueuedMessageById(host, item.id);
    if (!current) {
      return "failed";
    }
    if (!ready) {
      if (routeVisible(current.agentId) && canRestoreComposer(host, options)) {
        cancelChatDelivery(host, current, options ?? {});
      } else if (!setState("failed", INTERRUPTED_SETTINGS_WAIT_ERROR)) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      }
      host.requestUpdate?.();
      return "failed";
    }
    pendingSettings = getPendingChatPickerPatch(host, route, current.agentId);
  }
  return current ?? "failed";
}

function publishSettledDeliverySettings(
  host: ChatHost,
  item: ChatQueueItem,
  storageMode: QueuedChatStorageMode,
): ChatQueueItem | QueuedChatSendResult {
  // Keep one non-drainable durable barrier across the complete picker tail.
  // Publishing earlier can let reconnect race a newer or cancelled selection.
  const current = deliveryStateWriter(
    host,
    storageMode,
    item.id,
  )(reconnectSafeQueuedSendState(host));
  if (!current) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return "failed";
  }
  host.requestUpdate?.();
  return current;
}

async function sendQueuedChatMessage(
  host: ChatHost,
  id: string,
  options?: QueuedChatSendOptions,
  queuedSessionKey = host.sessionKey,
): Promise<QueuedChatSendResult> {
  const storageMode = options?.storageMode ?? "durable";
  let queued = readQueuedMessageById(host, id);
  const approvedReset = queued?.localCommandName === "reset" && Boolean(options?.target);
  if (!queued || queued.pendingRunId || (queued.localCommandName && !approvedReset)) {
    return "failed";
  }
  if (
    storageMode === "durable" &&
    (queued.attachments?.length || queued.attachmentPayload || queued.attachmentStorageError)
  ) {
    const prepared = await prepareQueuedChatPayload(host, queued, queuedSessionKey);
    if (typeof prepared === "string") {
      return prepared;
    }
    queued = prepared;
  }
  const queueSessionKey = queued.sessionKey ?? queuedSessionKey;
  const consumedSettings = new Set<Promise<boolean>>();
  const route = options?.routingSessionKey ?? queueSessionKey;
  const initialSettings =
    options?.pendingSettings ?? getPendingChatPickerPatch(host, route, queued.agentId);
  let prepared: ChatQueueItem | QueuedChatSendResult = queued;
  if (initialSettings) {
    prepared = await settleDeliverySettings(
      host,
      queued,
      storageMode,
      queueSessionKey,
      { ...options, pendingSettings: initialSettings },
      consumedSettings,
    );
  }
  while (typeof prepared !== "string") {
    const latestSettings = getPendingChatPickerPatch(host, route, prepared.agentId);
    if (!latestSettings || consumedSettings.has(latestSettings)) {
      break;
    }
    prepared = await settleDeliverySettings(
      host,
      prepared,
      storageMode,
      queueSessionKey,
      { ...options, pendingSettings: latestSettings },
      consumedSettings,
    );
  }
  if (typeof prepared === "string") {
    return prepared;
  }
  if (consumedSettings.size) {
    prepared = publishSettledDeliverySettings(host, prepared, storageMode);
    if (typeof prepared === "string") {
      return prepared;
    }
  }
  prepared = finishChatDeliveryAdmission(host, prepared, storageMode, queueSessionKey, options);
  if (typeof prepared !== "string" && queued.attachmentPayload) {
    prepared = { ...prepared, attachments: queued.attachments };
  }
  if (typeof prepared === "string") {
    return prepared;
  }
  if (!prepared.sendRunId || !prepared.sendState) {
    const sessionKey = prepared.sessionKey ?? queuedSessionKey;
    prepared =
      updateQueuedSendItem(host, storageMode, prepared.id, (item) => ({
        ...item,
        sendAttempts: item.sendAttempts ?? 0,
        sendRunId: item.sendRunId ?? generateUUID(),
        sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
        sessionKey,
        agentId: item.agentId ?? scopedAgentIdForSession(host, sessionKey),
      })) ?? "pending";
  }
  if (typeof prepared === "string") {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return prepared;
  }
  if (approvedReset) {
    prepared = {
      ...prepared,
      refreshSessions: true,
      text: prepared.localCommandArgs ? `/reset ${prepared.localCommandArgs}` : "/reset",
    };
  }
  const submitted = trimHumanMentions(prepared.text, prepared.mentions);
  const message = prepared.intent ? prepared.text : submitted.text;
  const attachments = (queued.attachmentPayload ? queued.attachments : prepared.attachments) ?? [];
  if (!message && attachments.length === 0) {
    removeQueuedMessageWithoutReleasing(host, id);
    return "sent";
  }
  const sessionKey = prepared.sessionKey ?? host.sessionKey;
  const setState = deliveryStateWriter(host, storageMode, id);
  if (options?.target) {
    const access = readChatResetTargetAccess(host, options.target);
    if (!access.allowed) {
      setState("failed", access.reason);
      surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, access.reason);
      return "failed";
    }
  }
  if (!host.connected || !host.client) {
    const waiting = setState("waiting-reconnect");
    if (!waiting && canRestoreComposer(host, options)) {
      cancelChatDelivery(host, prepared, options ?? {});
      return "failed";
    }
    if (!waiting) {
      setState("failed", OFFLINE_QUEUE_STORAGE_ERROR);
      surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, OFFLINE_QUEUE_STORAGE_ERROR);
    }
    return "pending";
  }

  const requestConnectionIsCurrent = captureChatConnectionOwner(host);
  const runId = prepared.sendRunId ?? generateUUID();
  const startedAt = Date.now();
  const requestStartedAtMs = controlUiNowMs();
  const sendingItem = updateQueuedSendItem(host, storageMode, id, (item) => ({
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
    surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, OFFLINE_QUEUE_STORAGE_ERROR);
    return "pending";
  }
  registerChatSendTiming(host, sendingItem, runId, requestStartedAtMs);
  recordChatSendTiming(host, sendingItem, "request-start", sendingItem.sendSubmittedAtMs);
  const scope = {
    sessionKey,
    ...(prepared.agentId ? { agentId: prepared.agentId } : {}),
  };
  const isVisible = () => visibleSessionMatches(host, sessionKey, prepared.agentId);
  if (isVisible()) {
    host.chatSendingScopeKey = storedChatOutboxScopeKey(scope);
    host.chatSending = true;
    // Keep the current run intact until an ACK or live event owns its replacement.
    if (!host.chatRunId) {
      resetToolStream(host);
    }
    setChatError(host, null);
    reconcileChatRunLifecycle(host, {
      clearRunStatus: true,
      // A send has not replaced the active run; its progress and approvals still belong to it.
      clearIndicators: !host.chatRunId,
    });
  }

  try {
    const expectedLeafEntryId = prepared.intent
      ? prepared.expectedLeafEntryId
      : options?.expectedLeafEntryId;
    const ack = await requestChatSend(host, {
      message,
      mentions: submitted.mentions,
      attachments: attachments.length ? attachments : undefined,
      runId,
      sessionKey,
      agentId: prepared.agentId,
      ...(prepared.intent ? { intent: prepared.intent, sessionId: prepared.sessionId } : {}),
      ...(prepared.queueMode ? { queueMode: prepared.queueMode } : {}),
      ...(prepared.queueMode !== "steer" && expectedLeafEntryId !== undefined
        ? { expectedLeafEntryId }
        : {}),
      ...(prepared.replyToId ? { replyToId: prepared.replyToId } : {}),
    });
    if (!requestConnectionIsCurrent()) {
      return "pending";
    }
    updateChatSendAckTiming(host, runId, ack, sendingItem, requestStartedAtMs);
    recordChatSendTiming(host, sendingItem, "ack", sendingItem.sendSubmittedAtMs, {
      ackStatus: ack.status,
      requestDurationMs: roundedControlUiDurationMs(controlUiNowMs() - requestStartedAtMs),
      ...chatSendAckServerTimingEventFields(ack),
    });
    if (isTerminalFailureChatSendAck(ack)) {
      const error = formatTerminalChatSendAckError(ack, "chat");
      const restoreCommand =
        options?.restoreOnTerminalFailure === true && canRestoreComposer(host, options);
      // Release in-flight ownership before publishing Retry; an immediate click
      // must not see this completed send as the run that blocks its replacement.
      finishScopedChatSending(host, scope);
      if (restoreCommand) {
        cancelChatDelivery(host, prepared, options ?? {});
      } else {
        setState("failed", error);
      }
      if (isVisible()) {
        const projectionScope = readChatSessionProjectionScope(host, {
          sessionKey,
          agentId: prepared.agentId,
        });
        reduceChatSessionProjection(
          host,
          { type: "sendFailed", runId },
          { scope: projectionScope },
        );
        reconcileChatRunLifecycle(host, {
          outcome: "interrupted",
          sessionStatus: ack.status === "error" ? "failed" : "killed",
          runId: ack.runId,
          sessionKey,
          clearLocalRun: true,
          clearChatStream: true,
          clearToolStream: true,
          publishRunStatus: false,
          armLocalTerminalReconcile: ack.runId === runId,
        });
      }
      surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, error, {
        inline: storageMode === "durable" && !restoreCommand,
      });
      recordChatSendTiming(host, sendingItem, "failed", sendingItem.sendSubmittedAtMs, {
        error,
        ackStatus: ack.status,
      });
      return "failed";
    }
    const retireOnAck = ack.status === "ok" || storageMode === "memory";
    let retirementFailed = false;
    if (retireOnAck) {
      removeQueuedMessageWithoutReleasing(host, id);
      retirementFailed = storageMode === "durable" && readQueuedMessageById(host, id) !== null;
    }
    if (isVisible()) {
      if (retireOnAck) {
        const projectionScope = readChatSessionProjectionScope(host, {
          sessionKey,
          agentId: prepared.agentId,
        });
        const projectedMessage = buildLocalUserMessage({
          text: message,
          mentions: submitted.mentions,
          ...(attachments.length ? { attachments } : {}),
          createdAt: startedAt,
          runId,
          ...(prepared.replyToId ? { replyToId: prepared.replyToId } : {}),
          ...(prepared.sender ? { sender: prepared.sender } : {}),
        });
        if (projectedMessage) {
          reduceChatSessionProjection(
            host,
            { type: "sendPending", runId, message: projectedMessage },
            { scope: projectionScope },
          );
        }
        if (ack.runId !== runId) {
          reduceChatSessionProjection(
            host,
            { type: "sendAcknowledged", previousRunId: runId, runId: ack.runId },
            { scope: projectionScope },
          );
        }
      }
      if (ack.status === "ok") {
        reconcileChatRunLifecycle(host, {
          outcome: "done",
          sessionStatus: "done",
          runId: ack.runId,
          sessionKey,
          clearLocalRun: true,
          clearChatStream: true,
          clearToolStream: true,
          publishRunStatus: false,
          armLocalTerminalReconcile: true,
        });
        void loadChatHistory(host);
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        // A steer ACK identifies its client operation, not the active model run.
        if (prepared.queueMode !== "steer" || !host.chatRunId) {
          adoptStartedChatRun(host, ack.runId, startedAt);
        }
      }
    }
    if (prepared.refreshSessions) {
      const target = { sessionKey, agentId: prepared.agentId };
      if (ack.status === "ok") {
        void refreshChatSessionListForTarget(host, target);
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        host.refreshSessionsAfterChat.set(ack.runId, target);
      }
    }
    discardChatAttachmentDataUrls(excludeComposerAttachments(host, attachments));
    if (retirementFailed) {
      surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, OFFLINE_QUEUE_STORAGE_ERROR);
      return "pending";
    }
    return retireOnAck ? "sent" : "pending";
  } catch (err) {
    if (!requestConnectionIsCurrent()) {
      return "pending";
    }
    const activeLeafChanged = isActiveLeafChangedError(err);
    const error = activeLeafChanged
      ? t("chat.sendErrors.activeLeafChanged")
      : formatConnectError(err);
    if (err instanceof GatewayPayloadLimitError) {
      if (canRestoreComposer(host, options)) {
        cancelChatDelivery(host, prepared, options ?? {});
      } else {
        setState("failed", error);
      }
      surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, error);
      recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error });
      return "failed";
    }
    const restoreCommand =
      options?.restoreOnTerminalFailure === true && canRestoreComposer(host, options);
    const recoverable =
      !activeLeafChanged &&
      (err instanceof GatewayRequestError
        ? err.retryable
        : /gateway (?:not connected|closed)|websocket|disconnected/i.test(error));
    if (!activeLeafChanged && recoverable) {
      const failedBeforeTransport =
        err instanceof Error &&
        !(err instanceof GatewayRequestError) &&
        err.message === "gateway not connected";
      const retryDelayMs = retryableGatewayDelayMs(err);
      const safelyRejected = failedBeforeTransport || retryDelayMs !== null;
      const rollbackAttempt = safelyRejected
        ? {
            sendAttempts: queued.sendAttempts,
            sendRequestStartedAtMs: queued.sendRequestStartedAtMs,
          }
        : {};
      if (storageMode === "memory") {
        const restore = safelyRejected && canRestoreComposer(host, options);
        if (restore) {
          cancelChatDelivery(host, prepared, options ?? {});
        } else {
          updateQueuedSendItem(host, storageMode, id, (item) => ({
            ...item,
            ...rollbackAttempt,
            sendError: safelyRejected ? error : UNCONFIRMED_CHAT_SEND_ERROR,
            sendState: safelyRejected ? "failed" : "unconfirmed",
          }));
        }
        surfaceChatDeliveryFailure(
          host,
          sessionKey,
          prepared.agentId,
          restore ? error : OFFLINE_QUEUE_STORAGE_ERROR,
        );
        recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, {
          error: restore ? error : OFFLINE_QUEUE_STORAGE_ERROR,
        });
        return restore ? "failed" : "pending";
      }
      const waiting = updateQueuedMessage(host, id, (item) => ({
        ...item,
        ...rollbackAttempt,
        sendError: error,
        sendState: "waiting-reconnect",
      }));
      if (!waiting) {
        const restore = failedBeforeTransport && canRestoreComposer(host, options);
        if (restore) {
          cancelChatDelivery(host, prepared, options ?? {});
        } else {
          updateQueuedMessage(host, id, (item) => ({
            ...item,
            sendError: OFFLINE_QUEUE_STORAGE_ERROR,
            sendState: "failed",
          }));
        }
        surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, OFFLINE_QUEUE_STORAGE_ERROR);
        recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, {
          error: OFFLINE_QUEUE_STORAGE_ERROR,
        });
        return restore ? "failed" : "pending";
      }
      if (isVisible()) {
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
    // Keep the retry action behind terminal ownership release, as above.
    finishScopedChatSending(host, scope);
    if (restoreCommand) {
      cancelChatDelivery(host, prepared, options ?? {});
    } else {
      setState("failed", error);
    }
    if (isVisible()) {
      if (activeLeafChanged) {
        void Promise.all([loadChatHistory(host), loadChatBranches(host)]);
      }
    }
    surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, error, {
      inline: storageMode === "durable" && !restoreCommand,
    });
    recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error });
    return "failed";
  } finally {
    if (requestConnectionIsCurrent()) {
      finishScopedChatSending(host, scope);
    }
  }
}

export async function deliverChatQueueItem(
  host: ChatHost,
  item: ChatQueueItem,
  options: QueuedChatSendOptions = {},
): Promise<QueuedChatSendResult> {
  const sessionKey = item.sessionKey ?? host.sessionKey;
  const storageMode = options.storageMode ?? "durable";
  const routingSessionKey = options.routingSessionKey ?? sessionKey;
  const deliveryConnectionIsCurrent = captureChatConnectionOwner(host, false);
  const deliveryAgentId =
    item.agentId ?? scopedAgentIdForSession(host, routingSessionKey) ?? undefined;
  const sendOptions = { ...options, routingSessionKey, storageMode };
  let result: QueuedChatSendResult;
  if (storageMode === "memory") {
    result = await sendQueuedChatMessage(host, item.id, sendOptions, sessionKey);
  } else {
    const outbox = listStoredChatOutboxes(host).find((candidate) =>
      candidate.queue.some((entry) => entry.id === item.id),
    );
    if (!outbox) {
      // Admission succeeded; removal or another drain can retire the row while we yield.
      return "pending";
    }
    let drainResult: QueuedChatSendResult | undefined;
    let admittedItem = item;
    const initialSettings = item.localCommandName
      ? undefined
      : (sendOptions.pendingSettings ??
        getPendingChatPickerPatch(host, routingSessionKey, item.agentId));
    if (initialSettings) {
      const consumedSettings = new Set<Promise<boolean>>();
      let admitted = await settleDeliverySettings(
        host,
        item,
        storageMode,
        sessionKey,
        { ...sendOptions, pendingSettings: initialSettings },
        consumedSettings,
      );
      while (typeof admitted !== "string") {
        const latestSettings = getPendingChatPickerPatch(host, routingSessionKey, admitted.agentId);
        if (!latestSettings || consumedSettings.has(latestSettings)) {
          break;
        }
        admitted = await settleDeliverySettings(
          host,
          admitted,
          storageMode,
          sessionKey,
          { ...sendOptions, pendingSettings: latestSettings },
          consumedSettings,
        );
      }
      if (typeof admitted !== "string") {
        admitted = publishSettledDeliverySettings(host, admitted, storageMode);
      }
      if (typeof admitted === "string") {
        drainResult = admitted;
      } else {
        admittedItem = admitted;
      }
    }
    const routeVisible = visibleSessionMatches(host, routingSessionKey, admittedItem.agentId);
    if (
      drainResult === undefined &&
      routeVisible &&
      !admittedItem.queueMode &&
      !sendOptions.allowActiveRunSend &&
      (isChatBusy(host) || hasDirectSessionRun(host))
    ) {
      const parked = finishChatDeliveryAdmission(
        host,
        admittedItem,
        storageMode,
        sessionKey,
        sendOptions,
      );
      if (typeof parked === "string") {
        drainResult = parked;
        if (parked === "pending" && outbox.queue[0]?.id !== item.id) {
          // Reconcile older restored rows without delaying this turn's active-run policy.
          void scheduleOutboxDrain(host, outbox, chatOutboxDrainDependencies);
        }
      }
    }
    if (drainResult === undefined && host.connected && host.client) {
      // FIFO may have already spent a reconnect or settings-event drain while
      // this row was waiting-model, so foreground admission owns the wakeup.
      drainResult = routeVisible
        ? await scheduleOutboxDrain(host, outbox, chatOutboxDrainDependencies, item.id, {
            ...sendOptions,
            pendingSettings: undefined,
          })
        : await scheduleOutboxDrain(host, outbox, chatOutboxDrainDependencies);
    }
    result = drainResult ?? "pending";
  }
  if (result === "sent" && visibleSessionMatches(host, sessionKey, deliveryAgentId)) {
    resetChatInputHistoryNavigation(host);
    if (options.restoreDraft && options.previousDraft?.trim()) {
      host.chatMessage = options.previousDraft;
      host.chatMentions = options.previousMentions ?? [];
    }
    if (options.restoreAttachments && options.previousAttachments?.length) {
      host.chatAttachments = options.previousAttachments;
    }
  }
  if (
    deliveryConnectionIsCurrent() &&
    visibleSessionMatches(host, routingSessionKey, deliveryAgentId)
  ) {
    scheduleChatScroll(host, true);
  }
  if (
    result === "sent" &&
    visibleSessionMatches(host, sessionKey, deliveryAgentId) &&
    !host.chatRunId
  ) {
    void flushStoredChatOutbox(host, chatOutboxDrainDependencies);
  }
  return result;
}

const sendResetSlashCommand = createResetSlashCommandSender(deliverChatQueueItem);

export const chatOutboxDrainDependencies: ChatOutboxDrainDependencies = {
  sendQueuedChatMessage,
  sendResetSlashCommand,
  setChatError,
};
