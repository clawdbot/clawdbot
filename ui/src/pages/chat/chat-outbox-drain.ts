import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { isUiGlobalSessionKey } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  confirmConversationResetForCurrentSession,
  dispatchChatSlashCommand,
  type ChatCommandResetOptions,
} from "./chat-commands.ts";
import { loadChatHistory, type ChatHistoryResult, type ChatState } from "./chat-history.ts";
import {
  excludeComposerAttachments,
  removeQueuedMessageWithoutReleasing,
  syncChatQueueFromStoredOutbox,
  updateQueuedMessageForSession,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  listStoredChatOutboxes,
  storedChatOutboxScopeKey,
  type StoredChatOutbox,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";
import { isChatBusy } from "./run-lifecycle.ts";
import {
  chatMessagesContainQueuedSend,
  OFFLINE_QUEUE_STORAGE_ERROR,
  preserveQueuedUserTurn,
} from "./steer-lifecycle.ts";

export type QueuedChatSendResult = "sent" | "pending" | "failed";
export type QueuedChatStorageMode = "durable" | "memory";
export type QueuedChatSendOptions = {
  /** Exact submit-time leaf for fresh foreground sends; restored drains omit it.
   * Any intervening leaf advance intentionally parks the draft for review. */
  expectedLeafEntryId?: string | null;
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
  routingSessionKey?: string;
  storageMode?: QueuedChatStorageMode;
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
  pendingOptions: Map<string, QueuedChatSendOptions>;
  promise: Promise<void>;
  rerun: boolean;
};

const STORED_OUTBOX_RETRY_DEFAULT_MS = 500;
const STORED_OUTBOX_RETRY_MIN_MS = 100;
const STORED_OUTBOX_RETRY_MAX_MS = 30_000;
export const UNCONFIRMED_CHAT_SEND_ERROR =
  "Delivery could not be confirmed after reconnect. Check the conversation before retrying.";
const UNCERTAIN_CLEAR_SUCCESSOR_ERROR =
  "A preceding /clear may have completed. Review the current conversation before retrying.";

const storedChatOutboxDrainLanesByClient = new WeakMap<
  GatewayBrowserClient,
  Map<string, StoredChatOutboxDrainLane>
>();
const storedChatOutboxRetryTimersByClient = new WeakMap<
  GatewayBrowserClient,
  Map<string, ReturnType<typeof setTimeout>>
>();

function storedChatOutboxClientMap<T>(
  store: WeakMap<GatewayBrowserClient, Map<string, T>>,
  client: GatewayBrowserClient,
): Map<string, T> {
  const existing = store.get(client);
  if (existing) {
    return existing;
  }
  const created = new Map<string, T>();
  store.set(client, created);
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
  const timers = storedChatOutboxClientMap(storedChatOutboxRetryTimersByClient, client);
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
    const retryDelayMs = retryableGatewayDelayMs(err);
    if (
      retryDelayMs !== null &&
      host.client === client &&
      host.connectionEpoch === connectionEpoch &&
      host.connected
    ) {
      scheduleStoredChatOutboxRetry(host, outbox, retryDelayMs, dependencies);
    }
    return "blocked";
  }
  const currentOutbox = readStoredChatOutbox(host, outbox);
  const currentItem = currentOutbox?.queue.find((entry) => entry.id === item.id);
  if (host.client !== client || host.connectionEpoch !== connectionEpoch || !host.connected) {
    return "blocked";
  }
  if (!currentOutbox || !currentItem || !sameQueuedDeliveryVersion(currentItem, item)) {
    return "continue";
  }
  syncChatQueueFromStoredOutbox(host, currentOutbox);
  if (chatMessagesContainQueuedSend(history.messages, item)) {
    // Server history owns the turn, but the visible transcript may not have
    // reloaded yet; materialize the turn locally before dropping the queue row
    // or the bubble vanishes until loadChatHistory below resolves.
    preserveQueuedUserTurn(host, item);
    const removed = removeQueuedMessageWithoutReleasing(host, item.id, outbox.sessionKey);
    if (!removed) {
      return "blocked";
    }
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
    if (visibleSessionMatches(host, outbox.sessionKey, outbox.agentId)) {
      void loadChatHistory(host as unknown as ChatState);
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
  const history = await readCurrentStoredChatHistory(
    host,
    outbox,
    item,
    client,
    connectionEpoch,
    dependencies,
  );
  if (history === "blocked" || history === "continue") {
    return history;
  }
  if (visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) && isChatBusy(host)) {
    return "blocked";
  }
  if ((item.sendAttempts ?? 0) > 0) {
    // History messages and active-run metadata are not captured atomically.
    // Re-read after the first idle snapshot before classifying delivery as unknown.
    const verifiedHistory = await readCurrentStoredChatHistory(
      host,
      outbox,
      item,
      client,
      connectionEpoch,
      dependencies,
    );
    if (verifiedHistory === "blocked" || verifiedHistory === "continue") {
      return verifiedHistory;
    }
    const parked = updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
      ...entry,
      sendError: UNCONFIRMED_CHAT_SEND_ERROR,
      sendState: "unconfirmed",
    }));
    if (parked && visibleSessionMatches(host, outbox.sessionKey, outbox.agentId)) {
      dependencies.setChatError(host, UNCONFIRMED_CHAT_SEND_ERROR);
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
    // Failed non-command rows are skipped; a failed command may have changed
    // session state before reporting an error, so it blocks the drain and
    // preserves FIFO until the user explicitly retries or removes it.
    let item: ChatQueueItem | undefined;
    for (const entry of outbox.queue) {
      if (entry.sendState !== "failed") {
        item = entry;
        break;
      }
      if (entry.localCommandName) {
        break;
      }
    }
    if (!item) {
      return "empty";
    }
    if (item.sendState === "unconfirmed" || item.sendState === "waiting-model") {
      syncChatQueueFromStoredOutbox(host, outbox);
      return "blocked";
    }
    const visible = visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
    if (item.localCommandName) {
      if (!visible || isChatBusy(host)) {
        lane.freshAdmissions.delete(item.id);
        lane.pendingOptions.delete(item.id);
        return "blocked";
      }
      syncChatQueueFromStoredOutbox(host, outbox);
      if (item.localCommandName === "reset") {
        const resetText = item.localCommandArgs ? `/reset ${item.localCommandArgs}` : "/reset";
        const convertResetToMessage = (sendState?: ChatQueueItem["sendState"]) =>
          updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
            ...entry,
            localCommandArgs: undefined,
            localCommandName: undefined,
            refreshSessions: true,
            text: resetText,
            ...(sendState ? { sendState } : {}),
          }));
        const confirmation = await confirmConversationResetForCurrentSession(host, {
          sessionKey: outbox.sessionKey,
          ...(outbox.agentId ? { agentId: outbox.agentId } : {}),
        });
        if (confirmation === "deferred") {
          const approvedDuringRun =
            visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) && host.chatRunId;
          const deferred = approvedDuringRun
            ? convertResetToMessage("waiting-idle")
            : updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
                ...entry,
                sendError: undefined,
                sendState: "waiting-idle",
              }));
          if (!deferred) {
            return "blocked";
          }
          return "blocked";
        }
        if (confirmation === "cancelled") {
          if (!removeQueuedMessageWithoutReleasing(host, item.id, outbox.sessionKey)) {
            return "blocked";
          }
          continue;
        }
        const converted = convertResetToMessage();
        if (!converted) {
          return "blocked";
        }
        continue;
      }
      // This token exists only in the live drain that admitted the row. Consume
      // it before command execution so a manual retry cannot inherit it.
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
      // Claim in place before executing. This preserves FIFO on command failure
      // and leaves a manual-review marker if the page disappears mid-command.
      const claimed = updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
        ...entry,
        sendError: undefined,
        sendState: "executing-command",
      }));
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
          updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
            ...entry,
            sendError: undefined,
            sendState: "waiting-idle",
          }));
          return "blocked";
        }
        if (dispatchResult === "failed") {
          const commandStillCurrent = commandScopeIsCurrent();
          const error =
            (commandStillCurrent ? host.lastError : null) ??
            `Command /${item.localCommandName} failed.`;
          if (
            !updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
              ...entry,
              sendError: error,
              sendState: "failed",
            }))
          ) {
            if (commandStillCurrent) {
              dependencies.setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
            }
          }
          return "blocked";
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
            // If the successor barrier cannot be made durable, keep the
            // claimed clear row. Its persisted executing-command projection
            // is unconfirmed, which safely blocks this lane after reload.
            return "blocked";
          }
        }
        if (!removeQueuedMessageWithoutReleasing(host, item.id, outbox.sessionKey)) {
          if (commandScopeIsCurrent()) {
            dependencies.setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          }
          return "blocked";
        }
        if (dispatchResult === "uncertain") {
          // The destructive command itself is consumed. An unconfirmed
          // successor is the durable manual-review barrier for this FIFO lane.
          return "blocked";
        }
        if (commandScopeIsCurrent()) {
          dependencies.setChatError(host, null);
        }
      } catch (err) {
        const commandStillCurrent = commandScopeIsCurrent();
        if (
          !updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
            ...entry,
            sendError: String(err),
            sendState: "failed",
          }))
        ) {
          if (commandStillCurrent) {
            dependencies.setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          }
          return "blocked";
        }
        if (commandStillCurrent) {
          dependencies.setChatError(host, String(err));
        }
        return "blocked";
      }
      continue;
    }
    if (isUiGlobalSessionKey(outbox.sessionKey) && !outbox.agentId) {
      lane.freshAdmissions.delete(item.id);
      lane.pendingOptions.delete(item.id);
      return "blocked";
    }
    // Consume fresh provenance before any await. A restored or deferred row
    // has no token and must reconcile Gateway history before transport.
    const freshAdmission = lane.freshAdmissions.delete(item.id);
    const pendingOptions = lane.pendingOptions.get(item.id);
    lane.pendingOptions.delete(item.id);
    const needsHistory = !freshAdmission;
    if (needsHistory) {
      const reconciled = await reconcileStoredChatOutboxHead(host, outbox, item, dependencies);
      if (reconciled === "blocked") {
        return "blocked";
      }
      if (reconciled === "continue") {
        continue;
      }
    }
    if (visible && isChatBusy(host)) {
      syncChatQueueFromStoredOutbox(host, outbox);
      updateQueuedMessageForSession(host, outbox.sessionKey, item.id, (entry) => ({
        ...entry,
        sendState: host.connected && host.client ? "waiting-idle" : "waiting-reconnect",
      }));
      return "blocked";
    }
    const currentOutbox = readStoredChatOutbox(host, scope);
    const currentItem = currentOutbox?.queue.find((entry) => entry.id === item.id);
    if (!currentOutbox || !currentItem || !sameQueuedDeliveryVersion(currentItem, item)) {
      continue;
    }
    syncChatQueueFromStoredOutbox(host, currentOutbox);
    const result = await dependencies.sendQueuedChatMessage(
      host,
      item.id,
      pendingOptions,
      outbox.sessionKey,
    );
    if (result === "pending") {
      // A pending ACK/reconnect state owns the next wakeup. Any rerun requested
      // while this RPC was in flight is already reflected in the durable queue.
      lane.rerun = false;
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
): Promise<void> {
  const client = host.client;
  if (!host.connected || !client) {
    return;
  }
  const key = storedChatOutboxScopeKey(scope);
  const retryTimers = storedChatOutboxRetryTimersByClient.get(client);
  const retryTimer = retryTimers?.get(key);
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimers?.delete(key);
  }
  // Drain ownership follows the live gateway client. A disconnected client can
  // leave an RPC pending, but its lane must never capture a replacement client.
  const lanes = storedChatOutboxClientMap(storedChatOutboxDrainLanesByClient, client);
  const existing = lanes.get(key);
  if (existing) {
    const existingHostOwnsScope =
      existing.host.connected &&
      existing.host.client === client &&
      visibleSessionMatches(existing.host, scope.sessionKey, scope.agentId);
    const candidateOwnsScope = visibleSessionMatches(host, scope.sessionKey, scope.agentId);
    // Local commands need the visible pane's session-bound UI state. Keep that
    // owner while connected; an inactive split pane may still request a rerun.
    if (!existingHostOwnsScope && candidateOwnsScope) {
      existing.host = host;
    } else if (!existing.host.connected || existing.host.client !== client) {
      existing.host = host;
    }
    existing.rerun = true;
    if (itemId && options) {
      existing.pendingOptions.set(itemId, options);
    }
    if (itemId) {
      existing.freshAdmissions.add(itemId);
    }
    await existing.promise;
    return;
  }
  let resolveLane!: () => void;
  let rejectLane!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveLane = resolve;
    rejectLane = reject;
  });
  const lane: StoredChatOutboxDrainLane = {
    freshAdmissions: new Set(itemId ? [itemId] : []),
    host,
    pendingOptions: new Map(itemId && options ? [[itemId, options]] : []),
    promise,
    rerun: false,
  };
  lanes.set(key, lane);
  void (async () => {
    do {
      lane.rerun = false;
      await drainStoredChatOutbox(lane, scope, dependencies);
    } while (lane.rerun);
  })().then(resolveLane, rejectLane);
  try {
    await lane.promise;
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
