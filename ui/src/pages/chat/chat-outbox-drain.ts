import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
} from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  captureChatCommandTarget,
  confirmConversationResetForCurrentSession,
  dispatchChatSlashCommand,
  readChatResetTargetAccess,
  type ChatCommandTarget,
  type ChatCommandResetOptions,
} from "./chat-commands.ts";
import { loadChatHistory, type ChatHistoryResult } from "./chat-history.ts";
import {
  excludeComposerAttachments,
  readQueuedMessageById,
  removeQueuedMessageWithoutReleasing,
  syncVisibleChatQueueProjection,
  updateQueuedMessageForSession,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  listStoredChatOutboxes,
  storedChatOutboxScopeKey,
  type StoredChatOutbox,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";
import { formatConnectError } from "./connect-error.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";
import { isChatBusy } from "./run-lifecycle.ts";
import {
  chatMessagesContainQueuedSend,
  OFFLINE_QUEUE_STORAGE_ERROR,
  preserveQueuedUserTurn,
  surfaceChatDeliveryFailure,
} from "./steer-lifecycle.ts";

export type QueuedChatSendResult = "sent" | "pending" | "failed";
export type QueuedChatStorageMode = "durable" | "memory";
export type QueuedChatSendOptions = {
  /** Exact submit-time leaf; restored drains omit it so intervening advances park the draft. */
  expectedLeafEntryId?: string | null;
  pendingSettings?: Promise<boolean>;
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
  restoreAttachments?: boolean;
  restoreDraft?: boolean;
  routingSessionKey?: string;
  storageMode?: QueuedChatStorageMode;
  target?: ChatCommandTarget;
};

export type ChatOutboxDrainDependencies = {
  sendQueuedChatMessage: (
    host: ChatHost,
    id: string,
    opts?: QueuedChatSendOptions,
    queuedSessionKey?: string,
  ) => Promise<QueuedChatSendResult>;
  sendResetSlashCommand: (
    host: ChatHost,
    message: string,
    opts: ChatCommandResetOptions,
  ) => Promise<void>;
  setChatError: (
    host: { lastError?: string | null; chatError?: string | null },
    error: string | null,
  ) => void;
};

type StoredChatOutboxDrainResult = "blocked" | "empty";
type StoredChatOutboxDrainLane = {
  freshAdmissions: Set<string>;
  host: ChatHost;
  // A pre-request cancellation can remove its row; retain the direct outcome so
  // the submitter never mistakes absence for a successful transport handoff.
  outcomes: Map<string, QueuedChatSendResult>;
  pendingOptions: Map<string, QueuedChatSendOptions>;
  promise: Promise<void>;
  rerun: boolean;
};

type StoredChatOutboxClientState = {
  lanes: Map<string, StoredChatOutboxDrainLane>;
  retryTimers: Map<string, ReturnType<typeof setTimeout>>;
};

const STORED_OUTBOX_RETRY_DEFAULT_MS = 500;
const STORED_OUTBOX_RETRY_MIN_MS = 100;
const STORED_OUTBOX_RETRY_MAX_MS = 30_000;
export const UNCONFIRMED_CHAT_SEND_ERROR =
  "Delivery could not be confirmed after reconnect. Check the conversation before retrying.";
const UNCERTAIN_CLEAR_SUCCESSOR_ERROR =
  "A preceding /clear may have completed. Review the current conversation before retrying.";

const storedChatOutboxClients = new WeakMap<GatewayBrowserClient, StoredChatOutboxClientState>();

function getStoredChatOutboxClientState(client: GatewayBrowserClient): StoredChatOutboxClientState {
  const existing = storedChatOutboxClients.get(client);
  if (existing) {
    return existing;
  }
  const created = { lanes: new Map(), retryTimers: new Map() };
  storedChatOutboxClients.set(client, created);
  return created;
}

export function retryableGatewayDelayMs(err: unknown): number | null {
  if (!(err instanceof GatewayRequestError) || !err.retryable) {
    return null;
  }
  const requested = err.retryAfterMs ?? STORED_OUTBOX_RETRY_DEFAULT_MS;
  return Math.min(Math.max(requested, STORED_OUTBOX_RETRY_MIN_MS), STORED_OUTBOX_RETRY_MAX_MS);
}

export function scheduleStoredChatOutboxRetry(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  delayMs: number,
  dependencies: ChatOutboxDrainDependencies,
) {
  const client = host.client;
  if (!host.connected || !client) {
    return;
  }
  const connectionEpoch = host.connectionEpoch;
  const timers = getStoredChatOutboxClientState(client).retryTimers;
  const key = storedChatOutboxScopeKey(scope);
  if (timers.has(key)) {
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(key);
    if (host.connected && host.client === client && host.connectionEpoch === connectionEpoch) {
      void scheduleStoredChatOutboxDrain(host, scope, dependencies);
    }
  }, delayMs);
  timers.set(key, timer);
}

function readStoredChatOutbox(
  host: ChatHost,
  scope: StoredChatOutboxScope,
): StoredChatOutbox | undefined {
  return listStoredChatOutboxes(host).find(
    (outbox) => outbox.sessionKey === scope.sessionKey && outbox.agentId === scope.agentId,
  );
}

function sameQueuedDeliveryVersion(left: ChatQueueItem, right: ChatQueueItem): boolean {
  return (
    left.id === right.id &&
    left.sendRunId === right.sendRunId &&
    left.sendAttempts === right.sendAttempts &&
    left.sendState === right.sendState &&
    left.agentId === right.agentId &&
    left.sessionKey === right.sessionKey
  );
}

async function readCurrentStoredChatHistory(
  host: ChatHost,
  outbox: StoredChatOutbox,
  item: ChatQueueItem,
  client: NonNullable<ChatHost["client"]>,
  connectionEpoch: number | undefined,
  dependencies: ChatOutboxDrainDependencies,
): Promise<ChatHistoryResult | "blocked" | "continue"> {
  let history: ChatHistoryResult;
  try {
    history = await client.request<ChatHistoryResult>("chat.history", {
      sessionKey: outbox.sessionKey,
      ...(isUiGlobalSessionKey(outbox.sessionKey) && outbox.agentId
        ? { agentId: outbox.agentId }
        : {}),
      limit: 1000,
    });
  } catch (err) {
    const connectionCurrent =
      host.client === client && host.connectionEpoch === connectionEpoch && host.connected;
    const retryDelayMs = retryableGatewayDelayMs(err);
    if (retryDelayMs !== null) {
      if (connectionCurrent) {
        scheduleStoredChatOutboxRetry(host, outbox, retryDelayMs, dependencies);
      }
      return "blocked";
    }
    // An authoritative non-retryable rejection (auth loss, revoked scope) will
    // repeat on every drain wakeup; leaving the head silently "blocked" wedges
    // the whole FIFO lane forever. Fail or park it visibly so the operator sees
    // the outcome and the lane can move past a never-attempted head.
    if (!connectionCurrent || !(err instanceof GatewayRequestError)) {
      return "blocked";
    }
    const attempted =
      (item.sendAttempts ?? 0) > 0 ||
      item.sendRequestStartedAtMs !== undefined ||
      item.sendState === "unconfirmed";
    const error = attempted ? UNCONFIRMED_CHAT_SEND_ERROR : formatConnectError(err);
    const targetState = attempted ? ("unconfirmed" as const) : ("failed" as const);
    if (item.sendState === targetState && item.sendError === error) {
      return "blocked";
    }
    const parked = updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
      ...entry,
      sendError: error,
      sendState: targetState,
    }));
    surfaceChatDeliveryFailure(
      host,
      outbox.sessionKey,
      outbox.agentId,
      parked ? error : OFFLINE_QUEUE_STORAGE_ERROR,
    );
    return parked && !attempted ? "continue" : "blocked";
  }
  const currentOutbox = readStoredChatOutbox(host, outbox);
  const currentItem = currentOutbox?.queue.find((entry) => entry.id === item.id);
  if (host.client !== client || host.connectionEpoch !== connectionEpoch || !host.connected) {
    return "blocked";
  }
  if (!currentOutbox || !currentItem || !sameQueuedDeliveryVersion(currentItem, item)) {
    return "continue";
  }
  syncVisibleChatQueueProjection(host);
  if (chatMessagesContainQueuedSend(history.messages, item)) {
    // Materialize server history locally before removing the queue bubble.
    preserveQueuedUserTurn(host, item);
    const removed = removeQueuedMessageWithoutReleasing(host, item.id, outbox.sessionKey);
    if (!removed) {
      return "blocked";
    }
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
    if (visibleSessionMatches(host, outbox.sessionKey, outbox.agentId)) {
      void loadChatHistory(host);
    }
    return "continue";
  }
  if (
    !history.sessionInfo ||
    history.sessionInfo.hasActiveRun === true ||
    isSessionRunActive(history.sessionInfo)
  ) {
    return "blocked";
  }
  return history;
}

async function reconcileStoredChatOutboxHead(
  host: ChatHost,
  outbox: StoredChatOutbox,
  item: ChatQueueItem,
  dependencies: ChatOutboxDrainDependencies,
): Promise<"blocked" | "continue" | "send"> {
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  if (!client || !host.connected) {
    return "blocked";
  }
  // A never-attempted head cannot be in server history, so its reconcile only
  // needs the active-run answer — which the event that woke this drain already
  // recorded into the session row. Skipping the 1000-message chat.history here
  // stops one full-history RPC per transcript event while a run streams.
  // Attempted items keep the fetch: delivered-detection must retire their
  // bubbles even mid-run, and a missing row falls through conservatively.
  const neverAttempted =
    (item.sendAttempts ?? 0) === 0 && item.sendRequestStartedAtMs === undefined;
  if (neverAttempted) {
    const row =
      !isUiGlobalSessionKey(outbox.sessionKey) || host.sessions.state.agentId === outbox.agentId
        ? host.sessions.state.result?.sessions.find((session) =>
            areUiSessionKeysEquivalent(session.key, outbox.sessionKey),
          )
        : undefined;
    if (row && isSessionRunActive(row)) {
      return "blocked";
    }
  }
  const historyArgs = [host, outbox, item, client, connectionEpoch, dependencies] as const;
  const history = await readCurrentStoredChatHistory(...historyArgs);
  // Keyed unknown sends reach history only for exact proof; absence stays blocked.
  if (history === "blocked" || history === "continue" || item.sendState === "unconfirmed") {
    return history === "continue" ? "continue" : "blocked";
  }
  if (visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) && isChatBusy(host)) {
    return "blocked";
  }
  if ((item.sendAttempts ?? 0) > 0) {
    // History and run metadata are non-atomic; verify idle before parking unknown.
    const verifiedHistory = await readCurrentStoredChatHistory(...historyArgs);
    if (verifiedHistory === "blocked" || verifiedHistory === "continue") {
      return verifiedHistory;
    }
    const parked = updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
      ...entry,
      sendError: UNCONFIRMED_CHAT_SEND_ERROR,
      sendState: "unconfirmed",
    }));
    if (parked) {
      surfaceChatDeliveryFailure(
        host,
        outbox.sessionKey,
        outbox.agentId,
        UNCONFIRMED_CHAT_SEND_ERROR,
      );
    }
    return "blocked";
  }
  return "send";
}

async function drainStoredChatOutbox(
  lane: StoredChatOutboxDrainLane,
  scope: StoredChatOutboxScope,
  dependencies: ChatOutboxDrainDependencies,
): Promise<StoredChatOutboxDrainResult> {
  while (true) {
    const host = lane.host;
    if (!host.connected || !host.client) {
      return "blocked";
    }
    const outbox = readStoredChatOutbox(host, scope);
    if (!outbox) {
      return "empty";
    }
    const storedItem = outbox.queue.find(
      (entry) =>
        lane.freshAdmissions.has(entry.id) ||
        entry.sendState !== "failed" ||
        entry.localCommandName,
    );
    const freshItem = storedItem && lane.freshAdmissions.has(storedItem.id);
    const item = freshItem
      ? (readQueuedMessageById(host, storedItem.id) ?? storedItem)
      : storedItem;
    if (!item || (item.sendState === "failed" && !freshItem)) {
      return "empty";
    }
    if (
      (item.sendState === "unconfirmed" && (!item.sendRunId || item.localCommandName)) ||
      (item.sendState === "waiting-model" && !lane.pendingOptions.has(item.id)) ||
      // An open edit owns this row: sending the superseded text would deliver a
      // message the operator is visibly rewriting. The queue behind it waits,
      // which is the same contract the row's held position promises.
      isQueuedMessageBeingEdited(host, item.id)
    ) {
      syncVisibleChatQueueProjection(host);
      return "blocked";
    }
    const visible = visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
    if (item.localCommandName) {
      const setCommandState = (sendState: ChatQueueItem["sendState"], sendError?: string) =>
        updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
          ...entry,
          sendError,
          sendState,
        }));
      if (!visible || isChatBusy(host)) {
        lane.freshAdmissions.delete(item.id);
        lane.pendingOptions.delete(item.id);
        return "blocked";
      }
      syncVisibleChatQueueProjection(host);
      if (item.localCommandName === "reset") {
        if ((item.sendAttempts ?? 0) > 0 || item.sendRequestStartedAtMs !== undefined) {
          setCommandState("unconfirmed", UNCONFIRMED_CHAT_SEND_ERROR);
          return "blocked";
        }
        const resetTarget = captureChatCommandTarget(host);
        if (!resetTarget) {
          setCommandState("failed", "The Gateway connection changed. Retry the command.");
          return "blocked";
        }
        const initialAccess = readChatResetTargetAccess(host, resetTarget);
        if (!initialAccess.allowed) {
          setCommandState("failed", initialAccess.reason);
          dependencies.setChatError(host, initialAccess.reason);
          return "blocked";
        }
        const confirmation = await confirmConversationResetForCurrentSession(host, {
          sessionKey: outbox.sessionKey,
          ...(outbox.agentId ? { agentId: outbox.agentId } : {}),
        });
        if (confirmation === "deferred") {
          setCommandState("waiting-idle");
          return "blocked";
        }
        if (confirmation === "cancelled") {
          if (!removeQueuedMessageWithoutReleasing(host, item.id, outbox.sessionKey)) {
            return "blocked";
          }
          continue;
        }
        const currentAccess = readChatResetTargetAccess(host, resetTarget);
        if (!currentAccess.allowed) {
          setCommandState("failed", currentAccess.reason);
          dependencies.setChatError(host, currentAccess.reason);
          return "blocked";
        }
        lane.pendingOptions.set(item.id, {
          ...lane.pendingOptions.get(item.id),
          target: resetTarget,
        });
        const result = await dependencies.sendQueuedChatMessage(
          host,
          item.id,
          lane.pendingOptions.get(item.id),
          outbox.sessionKey,
        );
        lane.outcomes.set(item.id, result);
        lane.pendingOptions.delete(item.id);
        if (result !== "sent") {
          return "blocked";
        }
        continue;
      }
      // Consume the live admission token before command execution or manual retry.
      const freshAdmission = lane.freshAdmissions.delete(item.id);
      lane.pendingOptions.delete(item.id);
      if (!freshAdmission) {
        const reconciled = await reconcileStoredChatOutboxHead(host, outbox, item, dependencies);
        if (reconciled === "blocked") {
          return "blocked";
        }
        if (reconciled === "continue") {
          continue;
        }
      }
      // Claim before execution to preserve FIFO and crash-review state.
      const claimed = setCommandState("executing-command");
      if (!claimed) {
        return "blocked";
      }
      const commandClient = host.client;
      const commandConnectionEpoch = host.connectionEpoch;
      const commandScopeIsCurrent = () =>
        host.connected &&
        host.client === commandClient &&
        host.connectionEpoch === commandConnectionEpoch &&
        visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
      const failCommand = (error: string, expose = false): "blocked" => {
        const updated = setCommandState("failed", error);
        if (!updated || expose) {
          surfaceChatDeliveryFailure(
            host,
            outbox.sessionKey,
            outbox.agentId,
            updated ? error : OFFLINE_QUEUE_STORAGE_ERROR,
          );
        }
        return "blocked";
      };
      try {
        const dispatchResult = await dispatchChatSlashCommand(
          host,
          claimed.localCommandName ?? item.localCommandName,
          claimed.localCommandArgs ?? "",
          {
            sendResetMessage: (message, resetOpts) =>
              dependencies.sendResetSlashCommand(host, message, resetOpts),
          },
        );
        if (dispatchResult === "deferred") {
          setCommandState("waiting-idle");
          return "blocked";
        }
        if (dispatchResult === "failed") {
          // A still-current scope already saw the dispatcher's inline error.
          // After a route switch the dispatcher withholds it and the pane is
          // gone, so the terminal failure must surface globally. A stale scope
          // with the pane still visible (connection replaced) keeps the failed
          // queue chip instead: the new connection owns the inline surface.
          const commandStillCurrent = commandScopeIsCurrent();
          const error =
            (commandStillCurrent ? host.lastError : null) ??
            `Command /${item.localCommandName} failed.`;
          const paneHidden = !visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
          return failCommand(error, !commandStillCurrent && paneHidden);
        }
        if (dispatchResult === "uncertain") {
          const currentOutbox = readStoredChatOutbox(host, outbox);
          const currentIndex =
            currentOutbox?.queue.findIndex((entry) => entry.id === item.id) ?? -1;
          const successor = currentIndex >= 0 ? currentOutbox?.queue[currentIndex + 1] : undefined;
          if (
            successor &&
            !updateQueuedMessageForSession(
              host,
              outbox.sessionKey,
              successor.id,
              (entry) => ({
                ...entry,
                sendError: UNCERTAIN_CLEAR_SUCCESSOR_ERROR,
                sendState: "unconfirmed",
              }),
              outbox.agentId,
            )
          ) {
            dependencies.setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
            // Keep the claimed clear row as the reload-safe barrier.
            return "blocked";
          }
        }
        if (!removeQueuedMessageWithoutReleasing(host, item.id, outbox.sessionKey)) {
          surfaceChatDeliveryFailure(
            host,
            outbox.sessionKey,
            outbox.agentId,
            OFFLINE_QUEUE_STORAGE_ERROR,
          );
          return "blocked";
        }
        if (dispatchResult === "uncertain") {
          // The unconfirmed successor is the FIFO lane's durable review barrier.
          return "blocked";
        }
        if (commandScopeIsCurrent()) {
          dependencies.setChatError(host, null);
        }
      } catch (err) {
        return failCommand(String(err), true);
      }
      continue;
    }
    if (isUiGlobalSessionKey(outbox.sessionKey) && !outbox.agentId) {
      lane.freshAdmissions.delete(item.id);
      lane.pendingOptions.delete(item.id);
      return "blocked";
    }
    // Consume provenance before await; restored/deferred rows reconcile history.
    const freshAdmission = lane.freshAdmissions.delete(item.id);
    const pendingOptions = lane.pendingOptions.get(item.id);
    if (!freshAdmission) {
      const reconciled = await reconcileStoredChatOutboxHead(host, outbox, item, dependencies);
      if (reconciled === "blocked") {
        return "blocked";
      }
      if (reconciled === "continue") {
        continue;
      }
    }
    const currentOutbox = readStoredChatOutbox(host, scope);
    const currentItem = freshAdmission
      ? readQueuedMessageById(host, item.id)
      : currentOutbox?.queue.find((entry) => entry.id === item.id);
    if (!currentOutbox || !currentItem || !sameQueuedDeliveryVersion(currentItem, item)) {
      lane.pendingOptions.delete(item.id);
      continue;
    }
    syncVisibleChatQueueProjection(host);
    const result = await dependencies.sendQueuedChatMessage(
      host,
      item.id,
      pendingOptions,
      outbox.sessionKey,
    );
    lane.outcomes.set(item.id, result);
    lane.pendingOptions.delete(item.id);
    if (result === "pending") {
      // Only picker admission carries its earlier settings-event rerun into history.
      if (!pendingOptions?.pendingSettings) {
        lane.rerun = false;
      }
      return "blocked";
    }
    if (result === "failed") {
      continue;
    }
  }
}

export async function scheduleStoredChatOutboxDrain(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  dependencies: ChatOutboxDrainDependencies,
  itemId?: string,
  options?: QueuedChatSendOptions,
): Promise<QueuedChatSendResult | undefined> {
  const client = host.client;
  if (!host.connected || !client) {
    return undefined;
  }
  const key = storedChatOutboxScopeKey(scope);
  const { lanes, retryTimers } = getStoredChatOutboxClientState(client);
  const retryTimer = retryTimers.get(key);
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimers.delete(key);
  }
  // Drain ownership follows the live client, never a disconnected pending RPC.
  const existing = lanes.get(key);
  if (existing) {
    const candidateOwnsScope = visibleSessionMatches(host, scope.sessionKey, scope.agentId);
    // Keep a connected visible owner for local commands across split-pane reruns.
    if (
      !existing.host.connected ||
      existing.host.client !== client ||
      (!visibleSessionMatches(existing.host, scope.sessionKey, scope.agentId) && candidateOwnsScope)
    ) {
      existing.host = host;
    }
    existing.rerun = true;
    if (itemId && options) {
      existing.pendingOptions.set(itemId, options);
    }
    if (itemId) {
      existing.freshAdmissions.add(itemId);
    }
    if (!itemId && existing.pendingOptions.size) {
      return undefined;
    }
    await existing.promise;
    return itemId ? existing.outcomes.get(itemId) : undefined;
  }
  const lane: StoredChatOutboxDrainLane = {
    freshAdmissions: new Set(itemId ? [itemId] : []),
    host,
    outcomes: new Map(),
    pendingOptions: new Map(itemId && options ? [[itemId, options]] : []),
    promise: Promise.resolve(),
    rerun: false,
  };
  lanes.set(key, lane);
  lane.promise = (async () => {
    do {
      lane.rerun = false;
      await drainStoredChatOutbox(lane, scope, dependencies);
    } while (lane.rerun);
  })();
  try {
    await lane.promise;
    return itemId ? lane.outcomes.get(itemId) : undefined;
  } finally {
    if (lanes.get(key) === lane) {
      lanes.delete(key);
    }
  }
}

export async function resumeStoredChatOutboxes(
  host: ChatHost,
  dependencies: ChatOutboxDrainDependencies,
) {
  if (!host.connected || !host.client) {
    return;
  }
  await Promise.allSettled(
    listStoredChatOutboxes(host).map((outbox) =>
      scheduleStoredChatOutboxDrain(host, outbox, dependencies),
    ),
  );
}

export async function flushStoredChatOutbox(
  host: ChatHost,
  dependencies: ChatOutboxDrainDependencies,
) {
  const outbox = listStoredChatOutboxes(host).find((candidate) =>
    visibleSessionMatches(host, candidate.sessionKey, candidate.agentId),
  );
  if (outbox) {
    await scheduleStoredChatOutboxDrain(host, outbox, dependencies);
  }
}
