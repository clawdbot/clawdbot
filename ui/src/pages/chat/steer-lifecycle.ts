import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SessionsListResult } from "../../api/types.ts";
import { setLastActiveSessionKey } from "../../app/settings.ts";
import { compareChatQueueOrder } from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  clearPendingQueueItemsForRun,
  clearTransientQueuedMessageProjection,
  excludeComposerAttachments,
  removeQueuedMessageWithoutReleasing,
  replacePendingQueuedMessageProjection,
  setTransientQueuedMessageProjection,
  type ChatQueueScopedSessionHost,
  updateQueuedMessage,
  writeChatQueueForScope,
} from "./chat-queue.ts";
import {
  isTerminalFailureChatSendAck,
  type ChatSendAck,
  type TerminalFailureChatSendAck,
} from "./chat-send-ack.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import {
  isQueuedMessageBeingEdited,
  QUEUED_MESSAGE_STEER_CONFLICT_ERROR,
} from "./queued-message-edit.ts";
import { hasDirectSessionRun } from "./run-lifecycle.ts";
import { scheduleChatScroll, type ChatScrollHost } from "./scroll.ts";
import { appendChatMessageToCache, readChatMessagesFromCache } from "./session-message-cache.ts";
import {
  ackSteeredChip,
  buildInflightSteerChip,
  isAckedSteeredChip,
  isSteeredQueueItem,
} from "./steered-chip.ts";
import { rolloverChatStream } from "./stream-causal-boundary.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

type SteerLifecycleHost = ChatState &
  ChatQueueScopedSessionHost & {
    sessionsResult?: SessionsListResult | null;
  };

type SteerSendHost = SteerLifecycleHost &
  ChatScrollHost &
  Parameters<typeof setLastActiveSessionKey>[0];

export type SteerSendDependencies = {
  loadChatHistory: (host: SteerSendHost) => void;
  resumeRestoredOutbox: (host: SteerSendHost, itemId: string) => void;
  sendChatMessage: (
    host: SteerSendHost,
    message: string,
    attachments: ChatAttachment[] | undefined,
    options: {
      canApplyError: () => boolean;
      queueMode?: QueueMode;
      runId: string;
      expectedRunId?: string;
      expectedLeafEntryId?: string | null;
      replyToId?: string;
    },
  ) => Promise<SteerChatSendResult>;
};

type SteerTarget = { runId: string; leafEntryId?: string | null };

function resolveSteerTarget(host: SteerLifecycleHost, item: ChatQueueItem): SteerTarget | null {
  const matchingRows =
    host.sessionsResult?.sessions.filter((row) =>
      uiSessionRowMatchesSelectedChat(host, row.key, item.sessionKey ?? host.sessionKey),
    ) ?? [];
  const serverRunIds = new Set(
    matchingRows.flatMap((row) => (row.hasActiveRun ? (row.activeRunIds ?? []) : [])),
  );
  const durableRunId = item.kind === "steered" ? item.steerTargetRunId?.trim() : undefined;
  if (item.kind === "steered" && !durableRunId) {
    return null;
  }
  const runId =
    durableRunId ||
    host.chatRunId?.trim() ||
    (serverRunIds.size === 1 ? [...serverRunIds][0] : undefined);
  if (!runId) {
    return null;
  }
  const activeRow = matchingRows.find((row) => row.activeRunIds?.includes(runId));
  const displayedLeaf =
    host.chatRunId?.trim() === runId ? host.chatDisplayedLeafEntryId : undefined;
  const leafEntryId =
    displayedLeaf === null ? null : displayedLeaf?.trim() || activeRow?.activeLeafEntryId;
  return {
    runId,
    ...(leafEntryId === null
      ? { leafEntryId: null }
      : typeof leafEntryId === "string" && leafEntryId.trim()
        ? { leafEntryId: leafEntryId.trim() }
        : {}),
  };
}

type RejectedSteerChatSend = { kind: "rejected"; error: string };
type SteerChatSendResult = ChatSendAck | RejectedSteerChatSend | null;

function isRejectedSteerChatSend(result: SteerChatSendResult): result is RejectedSteerChatSend {
  return result !== null && "kind" in result && result.kind === "rejected";
}

export const OFFLINE_QUEUE_STORAGE_ERROR =
  "Could not store this message for reconnect. Free browser storage or reconnect before sending.";
const UNCONFIRMED_STEER_ERROR =
  "Steer delivery could not be confirmed. Check the active run before retrying.";
const UNCONFIRMED_FOLLOW_UP_ERROR =
  "Follow-up delivery could not be confirmed. Check the conversation before retrying.";

export function formatTerminalChatSendAckError(
  ack: TerminalFailureChatSendAck,
  context: "chat" | "detached" | "steer",
): string {
  return ack.status === "error"
    ? context === "steer"
      ? "Steer failed before it reached the run; try again."
      : "Chat failed before the run started; try again."
    : context === "detached"
      ? "The active run ended before the detached message was accepted."
      : context === "steer"
        ? "The active run ended before the steer message was accepted."
        : "The run ended before the message was accepted.";
}

export function chatMessagesContainQueuedSend(
  messages: unknown,
  item: ChatQueueItem,
  userRoleOnly = false,
): boolean {
  return findQueuedSendMessageIndex(messages, item, userRoleOnly) >= 0;
}

function findQueuedSendMessageIndex(
  messages: unknown,
  item: ChatQueueItem,
  userRoleOnly = false,
): number {
  if (!item.sendRunId) {
    return -1;
  }
  return (Array.isArray(messages) ? messages : []).findIndex((message) => {
    if (!isRecord(message)) {
      return false;
    }
    // Render retirement requires a user-role entry: an assistant entry can
    // carry the same run key without proving the queued turn is visible.
    const record = message;
    if (userRoleOnly && record.role !== "user") {
      return false;
    }
    const markerIdempotencyKey = asOptionalRecord(record["__openclaw"])?.idempotencyKey;
    const idempotencyKey = markerIdempotencyKey ?? record.idempotencyKey;
    return idempotencyKey === item.sendRunId || idempotencyKey === `${item.sendRunId}:user`;
  });
}

function durableDeliveredAttachments(
  attachments: readonly ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  return attachments?.flatMap((attachment) => {
    // Composer uploads keep their bytes in the payload store; queue rows carry
    // metadata only. Resolve through the store or attachment-only turns
    // materialize empty and vanish at chip retirement.
    const dataUrl = getChatAttachmentDataUrl(attachment);
    if (!dataUrl) {
      return [];
    }
    // Terminal retirement releases the queue-owned live blob. Pin synthetic
    // transcript content to durable bytes before that ownership ends.
    return [{ ...attachment, dataUrl, previewUrl: dataUrl }];
  });
}

export function preserveQueuedUserTurn(state: SteerLifecycleHost, item: ChatQueueItem): void {
  const runId = item.sendRunId;
  const sessionKey = item.sessionKey ?? state.sessionKey;
  if (!runId) {
    return;
  }
  if (item.kind === "steered") {
    // A started target may exist only as an optimistic queue row. Preserve it
    // before the landed steer or stable history can invert the user turns.
    const targetRunId = item.steerTargetRunId?.trim() || item.pendingRunId;
    const target = state.chatQueue.find(
      (candidate) => candidate.kind !== "steered" && candidate.sendRunId === targetRunId,
    );
    if (target) {
      preserveQueuedUserTurn(state, target);
    }
  }
  const content = buildUserChatMessageContentBlocks(
    item.text,
    durableDeliveredAttachments(item.attachments),
  );
  if (!content.length) {
    return;
  }
  const userMessage = {
    role: "user",
    content,
    timestamp: item.createdAt,
    __openclaw: { idempotencyKey: `${runId}:user` },
  };
  if (visibleSessionMatches(state, sessionKey, item.agentId)) {
    if (!chatMessagesContainQueuedSend(state.chatMessages, item, true)) {
      const previousMessageCount = state.chatMessages.length;
      const scope = readChatSessionProjectionScope(state, {
        sessionKey,
        agentId: item.agentId,
      });
      // Steer retirement and history recovery must retain the same pending
      // entry; rendering a separate row loses it during a concurrent snapshot.
      reduceChatSessionProjection(
        state,
        { type: "sendPending", runId, message: userMessage },
        { scope },
      );
      if (
        state.chatMessages.length > previousMessageCount &&
        isSteeredQueueItem(item) &&
        state.chatRunId
      ) {
        rolloverChatStream(state, { runId: state.chatRunId, boundaryRunId: runId });
      }
    }
    return;
  }
  if (!state.chatMessagesBySession) {
    return;
  }
  const target = { sessionKey, agentId: item.agentId };
  const cached = readChatMessagesFromCache(state.chatMessagesBySession, state, target);
  if (!chatMessagesContainQueuedSend(cached, item, true)) {
    appendChatMessageToCache(state.chatMessagesBySession, state, target, userMessage);
  }
}

export function retireSteeredChipsForTerminalRun(
  state: SteerLifecycleHost,
  runId: string | undefined,
): void {
  if (!runId) {
    return;
  }
  for (const item of state.chatQueue) {
    if (isAckedSteeredChip(item) && item.pendingRunId === runId) {
      preserveQueuedUserTurn(state, item);
    }
  }
  clearPendingQueueItemsForRun(state, runId);
}

export function retireSteeredChipsForRequestRun(
  state: SteerLifecycleHost,
  runId: string | undefined,
): void {
  if (!runId) {
    return;
  }
  const landed = state.chatQueue.filter(
    (item) => isAckedSteeredChip(item) && item.sendRunId === runId,
  );
  for (const item of landed) {
    preserveQueuedUserTurn(state, item);
  }
  if (landed.length > 0) {
    const landedIds = new Set(landed.map((item) => item.id));
    writeChatQueueForScope(
      state,
      state.sessionKey,
      state.chatQueue.filter((item) => !landedIds.has(item.id)),
    );
    for (const item of landed) {
      releaseChatAttachmentPayloads(excludeComposerAttachments(state, item.attachments));
    }
  }
}

export function retirePersistedSteeredChips(state: SteerLifecycleHost): void {
  const retired = state.chatQueue.filter(
    (item) =>
      isAckedSteeredChip(item) && chatMessagesContainQueuedSend(state.chatMessages, item, true),
  );
  if (retired.length === 0) {
    return;
  }
  const retiredIds = new Set(retired.map((item) => item.id));
  writeChatQueueForScope(
    state,
    state.sessionKey,
    state.chatQueue.filter((item) => !retiredIds.has(item.id)),
  );
  for (const item of retired) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(state, item.attachments));
  }
}

function setChatError(host: SteerLifecycleHost, error: string | null): void {
  const message = error === null ? null : formatUiError(error);
  host.lastError = message;
  host.chatError = message;
}

type ChatDeliveryFailureHost = Parameters<typeof visibleSessionMatches>[0] & {
  lastError?: string | null;
  chatError?: string | null;
  sessionsResult?: SessionsListResult | null;
};

/**
 * Terminal delivery failures must always end in a visible outcome. The pane
 * showing this session keeps the inline chat error; after reconnect or alias
 * drift the owning pane may no longer be on screen, so anything else surfaces
 * a global toast naming the session instead of recording the error only on
 * the queued row where nobody sees it.
 */
export function surfaceChatDeliveryFailure(
  host: ChatDeliveryFailureHost,
  sessionKey: string,
  agentId: string | undefined,
  error: string,
): void {
  const message = formatUiError(error);
  if (visibleSessionMatches(host, sessionKey, agentId)) {
    host.lastError = message;
    host.chatError = message;
    return;
  }
  // Global rows are agent-scoped while sharing one "global" key, so an
  // agent-less equivalence match could borrow another agent's label.
  const scopedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
  const row = host.sessionsResult?.sessions.find(
    (session) =>
      areUiSessionKeysEquivalent(session.key, sessionKey) &&
      (!isUiGlobalSessionKey(sessionKey) ||
        !scopedAgentId ||
        (session.agentId !== undefined && normalizeAgentId(session.agentId) === scopedAgentId)),
  );
  showToast({ message: `${resolveSessionDisplayName(sessionKey, row)}: ${message}` });
}

export async function sendQueuedChatMessageWithQueueMode(
  host: SteerSendHost,
  id: string,
  queueMode: QueueMode | undefined,
  dependencies: SteerSendDependencies,
): Promise<void> {
  if (!host.connected || !hasDirectSessionRun(host)) {
    return;
  }
  const isSteer = queueMode === "steer";
  if (isSteer && isQueuedMessageBeingEdited(host, id)) {
    setChatError(host, QUEUED_MESSAGE_STEER_CONFLICT_ERROR);
    return;
  }
  const unconfirmedError = isSteer ? UNCONFIRMED_STEER_ERROR : UNCONFIRMED_FOLLOW_UP_ERROR;
  const item = host.chatQueue.find(
    (entry) =>
      entry.id === id &&
      !entry.pendingRunId &&
      !entry.localCommandName &&
      (entry.sendState === undefined || entry.sendState === "waiting-idle"),
  );
  if (!item) {
    return;
  }
  const steerTarget = isSteer ? resolveSteerTarget(host, item) : null;
  if (isSteer && !steerTarget) {
    const error =
      item.kind === "steered"
        ? "This restored steer has no original run target and cannot be retried safely."
        : "The active run could not be identified uniquely. Review and retry.";
    updateQueuedMessage(host, id, (entry) => ({ ...entry, sendError: error, sendState: "failed" }));
    setChatError(host, error);
    return;
  }
  const activeRunId = steerTarget?.runId ?? host.chatRunId;
  const itemSessionKey = item.sessionKey ?? host.sessionKey;
  const message = item.text.trim();
  const attachments = item.attachments ?? [];
  if (!message && attachments.length === 0) {
    return;
  }

  // Claim the durable row before transport so a crash or ambiguous ACK cannot
  // replay the original queued turn after active-run admission may have succeeded.
  const claimed = updateQueuedMessage(host, id, (entry) => ({
    ...entry,
    ...(isSteer ? { kind: "steered" as const } : {}),
    ...(steerTarget
      ? {
          steerTargetRunId: steerTarget.runId,
        }
      : {}),
    sendError: unconfirmedError,
    sendRunId: entry.sendRunId ?? generateUUID(),
    sendState: "unconfirmed",
  }));
  if (!claimed?.sendRunId) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  const pendingItem: ChatQueueItem = {
    id: item.id,
    text: item.text,
    createdAt: item.createdAt,
    attachments: item.attachments,
    replyToId: item.replyToId,
    sendRunId: claimed.sendRunId,
    sessionKey: claimed.sessionKey,
    agentId: claimed.agentId,
    ...(claimed.steerTargetRunId ? { steerTargetRunId: claimed.steerTargetRunId } : {}),
  };
  const steeringChip = buildInflightSteerChip(pendingItem, claimed.sendRunId, activeRunId);
  const pendingIndicator = isSteer
    ? steeringChip
    : ({
        ...pendingItem,
        sendState: "sending",
      } satisfies ChatQueueItem);
  const transientProjection = isSteer
    ? buildInflightSteerChip({ ...claimed, sendError: undefined }, claimed.sendRunId)
    : { ...claimed, sendError: undefined, sendState: "sending" as const };
  if (
    !setTransientQueuedMessageProjection(host, itemSessionKey, transientProjection, item.agentId)
  ) {
    const restored = updateQueuedMessage(host, id, () => item);
    if (!restored) {
      host.chatQueue = host.chatQueue.map((entry) => (entry.id === id ? item : entry));
    }
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  host.chatQueue = host.chatQueue.map((entry) => (entry.id === id ? pendingIndicator : entry));
  const result = await dependencies.sendChatMessage(
    host,
    message,
    attachments.length ? attachments : undefined,
    {
      canApplyError: () => visibleSessionMatches(host, itemSessionKey, item.agentId),
      ...(queueMode ? { queueMode } : {}),
      ...(claimed.replyToId ? { replyToId: claimed.replyToId } : {}),
      ...(steerTarget
        ? {
            expectedRunId: steerTarget.runId,
            ...(steerTarget.leafEntryId !== undefined
              ? { expectedLeafEntryId: steerTarget.leafEntryId }
              : {}),
          }
        : {}),
      runId: claimed.sendRunId,
    },
  );
  if (isSteer && activeRunId) {
    replacePendingQueuedMessageProjection(
      host,
      itemSessionKey,
      id,
      activeRunId,
      claimed,
      item.agentId,
    );
  }
  clearTransientQueuedMessageProjection(host, itemSessionKey, id, item.agentId);
  const itemStillVisible = visibleSessionMatches(host, itemSessionKey, item.agentId);
  if (!result) {
    // A transport failure does not prove active-run admission was rejected. Keep the
    // durable row parked so reconnect cannot replay it as a separate turn.
    surfaceChatDeliveryFailure(host, itemSessionKey, item.agentId, unconfirmedError);
    return;
  }
  if (isRejectedSteerChatSend(result)) {
    const failed = updateQueuedMessage(host, id, (entry) => ({
      ...entry,
      sendError: result.error,
      sendState: "failed",
    }));
    surfaceChatDeliveryFailure(
      host,
      itemSessionKey,
      item.agentId,
      failed ? result.error : OFFLINE_QUEUE_STORAGE_ERROR,
    );
    return;
  }
  const ack = result;
  if (isTerminalFailureChatSendAck(ack)) {
    const restored = updateQueuedMessage(host, id, (entry) => ({
      ...item,
      ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
    }));
    if (!restored) {
      surfaceChatDeliveryFailure(host, itemSessionKey, item.agentId, unconfirmedError);
    } else {
      surfaceChatDeliveryFailure(
        host,
        itemSessionKey,
        item.agentId,
        formatTerminalChatSendAckError(ack, isSteer ? "steer" : "chat"),
      );
      dependencies.resumeRestoredOutbox(host, id);
    }
    return;
  }
  const removed = removeQueuedMessageWithoutReleasing(host, id, itemSessionKey, item.agentId);
  if (!removed) {
    surfaceChatDeliveryFailure(host, itemSessionKey, item.agentId, unconfirmedError);
    return;
  }
  const userTurnAlreadyVisible = chatMessagesContainQueuedSend(host.chatMessages, claimed, true);
  if (isSteer && ack.status === "ok") {
    preserveQueuedUserTurn(host, claimed);
    if (itemStillVisible) {
      dependencies.loadChatHistory(host);
    }
  }
  if (isSteer && ack.status !== "ok" && itemStillVisible && !userTurnAlreadyVisible) {
    // Key the chip to the run that will emit its terminal cleanup: the active
    // run when it still owns the tab, else the steer's own gateway lifecycle
    // (session-row-only runs, or the captured run ended mid-request).
    const chipRunId = activeRunId && host.chatRunId === activeRunId ? activeRunId : ack.runId;
    const steeredIndicator = ackSteeredChip(steeringChip, chipRunId);
    writeChatQueueForScope(
      host,
      itemSessionKey,
      [...host.chatQueue.filter((entry) => entry.id !== id), steeredIndicator].toSorted(
        compareChatQueueOrder,
      ),
      item.agentId,
    );
  } else {
    releaseChatAttachmentPayloads(attachments);
  }
  if (itemStillVisible) {
    setLastActiveSessionKey(host, itemSessionKey);
    scheduleChatScroll(host);
  }
}

export function steerQueuedChatMessage(
  host: SteerSendHost,
  id: string,
  dependencies: SteerSendDependencies,
): Promise<void> {
  return sendQueuedChatMessageWithQueueMode(host, id, "steer", dependencies);
}
