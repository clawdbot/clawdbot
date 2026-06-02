import { setLastActiveSessionKey } from "./app-last-active-session.ts";
import { scheduleChatScroll, resetChatScroll } from "./app-scroll.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import {
  cloneChatAttachmentsMetadata,
  discardChatAttachmentDataUrls,
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./chat/attachment-payload-store.ts";
import {
  INTERRUPTED_MODEL_WAIT_ERROR,
  persistStoredChatComposerQueue,
  removeStoredChatComposerQueueItem,
} from "./chat/composer-persistence.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
  type ChatInputHistoryState,
} from "./chat/input-history.ts";
import { reconcileChatRunLifecycle } from "./chat/run-lifecycle.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import { executeSlashCommand } from "./chat/slash-command-executor.ts";
import { parseSlashCommand, refreshSlashCommands } from "./chat/slash-commands.ts";
import { formatConnectError } from "./connect-error.ts";
import { resolveControlUiAuthHeader } from "./control-ui-auth.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
  scheduleControlUiAfterPaint,
} from "./control-ui-performance.ts";
import {
  abortChatRun,
  appendUserChatMessage,
  loadChatHistory,
  requestChatSend,
  sendDetachedChatMessage,
  sendSteerChatMessage,
  type ChatEventPayload,
  type ChatHistoryResult,
  type ChatSendAck,
  type ChatState,
} from "./controllers/chat.ts";
import { loadModels } from "./controllers/models.ts";
import {
  applyChatHistorySessionInfo,
  loadSessions,
  type LoadSessionsOverrides,
  type SessionsState,
} from "./controllers/sessions.ts";
import { GatewayRequestError, type GatewayBrowserClient, type GatewayHelloOk } from "./gateway.ts";
import { normalizeBasePath } from "./navigation.ts";
import {
  areUiSessionKeysEquivalent,
  DEFAULT_AGENT_ID,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiKnownSelectedGlobalAgentId,
  resolveUiSelectedGlobalAgentId,
} from "./session-key.ts";
import { isSessionRunActive } from "./session-run-state.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "./string-coerce.ts";
import type {
  AgentsListResult,
  ChatModelOverride,
  GatewaySessionRow,
  ModelCatalogEntry,
} from "./types.ts";
import type { SessionsListResult } from "./types.ts";
import type { ChatAttachment, ChatQueueItem, ChatSessionRefreshTarget } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";
import { isRenderableControlUiAvatarUrl } from "./views/agents-utils.ts";

export type ChatHost = ChatInputHistoryState & {
  client: GatewayBrowserClient | null;
  chatStream: string | null;
  connected: boolean;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatQueueBySession?: Record<string, ChatQueueItem[]>;
  chatRunId: string | null;
  chatSending: boolean;
  lastError?: string | null;
  chatError?: string | null;
  basePath: string;
  settings?: { gatewayUrl?: string | null; token?: string | null };
  password?: string | null;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarReason?: string | null;
  chatSideResult?: ChatSideResult | null;
  chatSideResultTerminalRuns?: Set<string>;
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
  sessionsError?: string | null;
  sessionsShowArchived?: boolean;
  updateComplete?: Promise<unknown>;
  requestUpdate?: () => void;
  refreshSessionsAfterChat: Map<string, ChatSessionRefreshTarget>;
  pendingAbort?: { runId?: string | null; sessionKey: string; agentId?: string } | null;
  chatSubmitGuards?: Map<string, Promise<void>>;
  chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
  assistantAgentId?: string | null;
  agentsList?: ChatAgentsListSnapshot | null;
  agentsSelectedId?: string | null;
  eventLogBuffer?: unknown[];
  eventLog?: unknown[];
  tab?: string;
  /** Callback for slash-command side effects that need app-level access. */
  onSlashAction?: (action: string) => void | Promise<void>;
};

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: Array<{ id: string }>;
};

function setChatError(host: ChatHost, error: string | null) {
  host.lastError = error;
  host.chatError = error;
}

export type ChatSendOptions = {
  confirmReset?: boolean;
  restoreDraft?: boolean;
};

export type ChatAbortOptions = {
  preserveDraft?: boolean;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
};

// Chat pickers need recency-free session rows so older channel chats remain selectable.
export const CHAT_SESSIONS_ACTIVE_MINUTES = 0;
export const CHAT_SESSIONS_REFRESH_LIMIT = 50;

export function createChatSessionsLoadOverrides(
  state: { sessionsShowArchived?: boolean },
  options: { offset?: number; append?: boolean; search?: string | null } = {},
): LoadSessionsOverrides {
  const overrides: LoadSessionsOverrides = {
    activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
    limit: CHAT_SESSIONS_REFRESH_LIMIT,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
  };
  if (typeof state.sessionsShowArchived === "boolean") {
    overrides.showArchived = state.sessionsShowArchived;
  }
  const search = normalizeOptionalString(options.search ?? undefined);
  if (search) {
    overrides.search = search;
  }
  const offset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  if (offset > 0) {
    overrides.offset = offset;
  }
  if (options.append === true) {
    overrides.append = true;
  }
  return overrides;
}
export {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  resetChatInputHistoryNavigation,
};
export type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult };

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function hasAbortableSessionRun(host: {
  chatRunId?: string | null;
  sessionKey: string;
  sessionsResult?: SessionsListResult | null;
}): boolean {
  if (host.chatRunId) {
    return true;
  }
  return Boolean(
    host.sessionsResult?.sessions.some(
      (session) => session.key === host.sessionKey && isSessionRunActive(session),
    ),
  );
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "/stop") {
    return true;
  }
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

function isChatResetCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

function confirmChatResetCommand(text: string) {
  if (!isChatResetCommand(text)) {
    return true;
  }
  if (typeof globalThis.confirm !== "function") {
    return false;
  }
  return globalThis.confirm("Start a new session? This will reset the current chat.");
}

function isBtwCommand(text: string) {
  return /^\/(?:btw|side)(?::|\s|$)/i.test(text.trim());
}

function readHelloDefaultAgentId(host: Pick<ChatHost, "hello">): string | undefined {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  return snapshot?.sessionDefaults?.defaultAgentId?.trim() || undefined;
}

function scopedAgentIdForSession(host: ChatHost, sessionKey: string | undefined | null) {
  return isUiGlobalSessionKey(sessionKey)
    ? resolveUiKnownSelectedGlobalAgentId(host)
    : (resolveUiGlobalAliasAgentId(host, sessionKey) ?? undefined);
}

function visibleSessionMatches(
  host: ChatHost,
  sessionKey: string,
  agentId: string | undefined,
): boolean {
  if (host.sessionKey !== sessionKey) {
    const hostAliasAgentId = resolveUiGlobalAliasAgentId(host, host.sessionKey);
    if (!hostAliasAgentId || !isUiGlobalSessionKey(sessionKey)) {
      return false;
    }
    const expectedAgentId = agentId ?? host.agentsList?.defaultId ?? readHelloDefaultAgentId(host);
    return expectedAgentId
      ? hostAliasAgentId === normalizeAgentId(expectedAgentId)
      : hostAliasAgentId === normalizeAgentId("main");
  }
  if (!isUiGlobalSessionKey(sessionKey)) {
    return true;
  }
  const selectedAgentId = resolveUiKnownSelectedGlobalAgentId(host);
  const expectedAgentId = agentId ?? host.agentsList?.defaultId ?? readHelloDefaultAgentId(host);
  return expectedAgentId
    ? selectedAgentId === normalizeAgentId(expectedAgentId)
    : selectedAgentId === undefined;
}

export function scopedAgentParamsForSession(
  host: Pick<ChatHost, "assistantAgentId" | "agentsList" | "hello">,
  sessionKey: string,
) {
  const agentId = isUiGlobalSessionKey(sessionKey)
    ? resolveUiKnownSelectedGlobalAgentId(host)
    : resolveUiGlobalAliasAgentId(host, sessionKey);
  return agentId ? { agentId } : {};
}

export function scopedAgentListParamsForSession(
  host: Pick<ChatHost, "assistantAgentId" | "agentsList" | "hello">,
  sessionKey: string,
) {
  const parsed = parseAgentSessionKey(sessionKey);
  const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  const agentId =
    parsed?.agentId ??
    (normalizedSessionKey === "global"
      ? resolveUiKnownSelectedGlobalAgentId(host)
      : normalizedSessionKey === "unknown"
        ? undefined
        : resolveUiDefaultAgentId(host));
  return agentId ? { agentId: normalizeAgentId(agentId) } : {};
}

export function scopedAgentListParamsForRefreshTarget(
  host: Pick<ChatHost, "assistantAgentId" | "agentsList" | "hello">,
  target: ChatSessionRefreshTarget,
) {
  const agentId =
    normalizeOptionalString(target.agentId) ??
    scopedAgentListParamsForSession(host, target.sessionKey).agentId;
  return agentId ? { agentId: normalizeAgentId(agentId) } : {};
}

export async function handleAbortChat(host: ChatHost, opts?: ChatAbortOptions) {
  const activeRunId = host.chatRunId;
  const clearDraft = () => {
    if (opts?.preserveDraft) {
      return;
    }
    host.chatMessage = "";
    resetChatInputHistoryNavigation(host);
  };
  // If disconnected but this session is abortable, queue the abort for when we reconnect.
  if (!host.connected && hasAbortableSessionRun(host)) {
    clearDraft();
    host.pendingAbort = {
      runId: activeRunId,
      sessionKey: host.sessionKey,
      ...scopedAgentParamsForSession(host, host.sessionKey),
    };
    return;
  }
  if (!host.connected) {
    return;
  }
  clearDraft();
  await abortChatRun(host as unknown as ChatState);
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  localCommand?: { args: string; name: string },
): ChatQueueItem | null {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return null;
  }
  const item: ChatQueueItem = {
    id: generateUUID(),
    text: trimmed,
    createdAt: Date.now(),
    attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
    refreshSessions,
    localCommandArgs: localCommand?.args,
    localCommandName: localCommand?.name,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
  };
  host.chatQueue = [...host.chatQueue, item];
  return item;
}

function enqueuePendingRunMessage(
  host: ChatHost,
  text: string,
  pendingRunId: string,
  attachments?: ChatAttachment[],
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      kind: "steered",
      attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
      pendingRunId,
    },
  ];
}

function enqueuePendingSendMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  submittedAtMs = controlUiNowMs(),
  sendState: ChatQueueItem["sendState"] = host.connected && host.client
    ? "sending"
    : "waiting-reconnect",
): ChatQueueItem | null {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return null;
  }
  const pending: ChatQueueItem = {
    id: generateUUID(),
    text: trimmed,
    createdAt: Date.now(),
    attachments: hasAttachments ? attachments : undefined,
    refreshSessions,
    sendAttempts: 0,
    sendRunId: generateUUID(),
    sendState,
    sendSubmittedAtMs: submittedAtMs,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
  };
  host.chatQueue = [...host.chatQueue, pending];
  recordChatSendTiming(host, pending, "pending-visible", submittedAtMs);
  schedulePendingSendPaintTiming(host, pending, submittedAtMs);
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true);
  return pending;
}

function updateQueuedMessage(
  host: ChatHost,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  return updateQueuedMessageForSession(host, host.sessionKey, id, update);
}

function readChatQueueForSession(host: ChatHost, sessionKey: string): ChatQueueItem[] {
  return sessionKey === host.sessionKey
    ? host.chatQueue
    : (host.chatQueueBySession?.[sessionKey] ?? []);
}

function writeChatQueueForSession(host: ChatHost, sessionKey: string, queue: ChatQueueItem[]) {
  if (sessionKey === host.sessionKey) {
    host.chatQueue = queue;
    return;
  }
  const queueBySession = { ...host.chatQueueBySession };
  if (queue.length > 0) {
    queueBySession[sessionKey] = queue;
  } else {
    delete queueBySession[sessionKey];
  }
  host.chatQueueBySession = queueBySession;
  host.requestUpdate?.();
}

function updateQueuedMessageForSession(
  host: ChatHost,
  sessionKey: string,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  let nextItem: ChatQueueItem | null = null;
  const nextQueue = readChatQueueForSession(host, sessionKey).map((item) => {
    if (item.id !== id) {
      return item;
    }
    nextItem = update(item);
    return nextItem;
  });
  writeChatQueueForSession(host, sessionKey, nextQueue);
  return nextItem;
}

function persistQueuedMessagesForSession(host: ChatHost, sessionKey: string) {
  persistStoredChatComposerQueue(host, sessionKey, readChatQueueForSession(host, sessionKey));
}

function removeQueuedMessageWithoutReleasing(
  host: ChatHost,
  id: string,
  sessionKey = host.sessionKey,
): ChatQueueItem | null {
  const queue = readChatQueueForSession(host, sessionKey);
  const item = queue.find((entry) => entry.id === id) ?? null;
  writeChatQueueForSession(
    host,
    sessionKey,
    queue.filter((entry) => entry.id !== id),
  );
  return item;
}

function removeVisibleOrScopedQueuedMessageWithoutReleasing(
  host: ChatHost,
  id: string,
  sessionKey: string | undefined,
): ChatQueueItem | null {
  return (
    removeQueuedMessageWithoutReleasing(host, id) ??
    (sessionKey ? removeQueuedMessageWithoutReleasing(host, id, sessionKey) : null)
  );
}

function isRecoverableChatSendError(err: unknown, formattedError: string): boolean {
  if (err instanceof GatewayRequestError) {
    return err.retryable;
  }
  return /gateway (?:not connected|closed)|websocket|disconnected/i.test(formattedError);
}

function restoreComposerAfterFailedSend(
  host: ChatHost,
  opts: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
  },
) {
  if (opts.previousDraft != null && !host.chatMessage.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (opts.previousAttachments?.length && host.chatAttachments.length === 0) {
    host.chatAttachments = opts.previousAttachments;
  }
}

function cancelPendingSendBeforeRequest(
  host: ChatHost,
  queued: ChatQueueItem,
  opts: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
    restoreComposer?: boolean;
  },
) {
  const removed = removeVisibleOrScopedQueuedMessageWithoutReleasing(
    host,
    queued.id,
    queued.sessionKey,
  );
  const restoreComposer = opts.restoreComposer !== false && removed != null;
  const willRestoreDraft =
    restoreComposer && opts.previousDraft != null && !host.chatMessage.trim();
  const willRestoreAttachments = Boolean(
    restoreComposer &&
    opts.previousAttachments?.length &&
    host.chatAttachments.length === 0 &&
    (willRestoreDraft || !host.chatMessage.trim()),
  );
  if (restoreComposer) {
    if (willRestoreDraft) {
      host.chatMessage = opts.previousDraft ?? "";
    }
    if (willRestoreAttachments) {
      host.chatAttachments = opts.previousAttachments ?? [];
    }
  }
  if (removed?.sessionKey) {
    removeStoredChatComposerQueueItem(host, removed.sessionKey, removed.id);
  }
  if (removed && !willRestoreAttachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}

type QueuedChatSendResult = "sent" | "pending" | "failed";

type ChatSendTimingPhase =
  | "pending-visible"
  | "pending-painted"
  | "request-start"
  | "ack"
  | "first-assistant-visible"
  | "terminal-before-delta"
  | "queued-busy"
  | "waiting-model"
  | "waiting-reconnect"
  | "failed";

type ChatSendTimingEntry = {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  sendAttempts: number;
  sendState?: ChatQueueItem["sendState"];
  submittedAtMs: number;
  requestStartedAtMs?: number;
  ackAtMs?: number;
  ackStatus?: ChatSendAck["status"];
  firstAssistantVisibleRecorded?: boolean;
};

function recordChatSendTiming(
  host: ChatHost,
  item: Pick<
    ChatQueueItem,
    "sendRunId" | "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  phase: ChatSendTimingPhase,
  startedAtMs = item.sendSubmittedAtMs,
  extra: Record<string, unknown> = {},
) {
  if (startedAtMs == null) {
    return;
  }
  recordControlUiPerformanceEvent(
    host as Parameters<typeof recordControlUiPerformanceEvent>[0],
    "control-ui.chat.send",
    {
      phase,
      durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
      runId: item.sendRunId,
      sessionKey: item.sessionKey,
      agentId: item.agentId,
      sendAttempts: item.sendAttempts ?? 0,
      sendState: item.sendState,
      ...extra,
    },
    { console: false, maxBufferedEventsForType: 40 },
  );
}

function ensureChatSendTimingEntries(host: ChatHost): Map<string, ChatSendTimingEntry> {
  if (host.chatSendTimingsByRun) {
    return host.chatSendTimingsByRun;
  }
  const entries = new Map<string, ChatSendTimingEntry>();
  host.chatSendTimingsByRun = entries;
  return entries;
}

function registerChatSendTiming(
  host: ChatHost,
  item: Pick<
    ChatQueueItem,
    "sendRunId" | "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  runId: string,
  requestStartedAtMs: number,
) {
  ensureChatSendTimingEntries(host).set(runId, {
    runId,
    sessionKey: item.sessionKey,
    agentId: item.agentId,
    sendAttempts: item.sendAttempts ?? 0,
    sendState: item.sendState,
    submittedAtMs: item.sendSubmittedAtMs ?? requestStartedAtMs,
    requestStartedAtMs,
  });
}

function updateChatSendAckTiming(
  host: ChatHost,
  requestedRunId: string,
  ack: ChatSendAck,
  item: Pick<
    ChatQueueItem,
    "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  requestStartedAtMs: number,
) {
  const entries = ensureChatSendTimingEntries(host);
  const existing = entries.get(requestedRunId);
  const submittedAtMs = existing?.submittedAtMs ?? item.sendSubmittedAtMs ?? requestStartedAtMs;
  const next: ChatSendTimingEntry = {
    ...(existing ?? {
      runId: ack.runId,
      sessionKey: item.sessionKey,
      agentId: item.agentId,
      sendAttempts: item.sendAttempts ?? 0,
      sendState: item.sendState,
      submittedAtMs,
      requestStartedAtMs,
    }),
    runId: ack.runId,
    sessionKey: existing?.sessionKey ?? item.sessionKey,
    agentId: existing?.agentId ?? item.agentId,
    ackAtMs: controlUiNowMs(),
    ackStatus: ack.status,
  };
  if (ack.runId !== requestedRunId) {
    entries.delete(requestedRunId);
  }
  entries.set(ack.runId, next);
}

function chatEventHasVisibleTerminalPayload(payload: ChatEventPayload): boolean {
  if (payload.state === "error" && payload.errorMessage?.trim()) {
    return true;
  }
  return Boolean(payload.message && typeof payload.message === "object");
}

function resolveFirstAssistantTimingPhase(
  host: ChatHost,
  payload: ChatEventPayload,
  entry: ChatSendTimingEntry,
): Extract<ChatSendTimingPhase, "first-assistant-visible" | "terminal-before-delta"> | null {
  if (entry.firstAssistantVisibleRecorded) {
    return null;
  }
  if (payload.state === "delta") {
    return typeof host.chatStream === "string" && host.chatStream.trim()
      ? "first-assistant-visible"
      : null;
  }
  if (payload.state === "final" || payload.state === "aborted" || payload.state === "error") {
    return chatEventHasVisibleTerminalPayload(payload) ? "terminal-before-delta" : null;
  }
  return null;
}

export function recordFirstAssistantChatTiming(
  host: ChatHost,
  payload: ChatEventPayload | undefined,
  handledState: ChatEventPayload["state"] | null,
) {
  if (!payload || !handledState || typeof payload.runId !== "string") {
    return;
  }
  const runId = payload.runId.trim();
  const entry = runId ? host.chatSendTimingsByRun?.get(runId) : undefined;
  if (!entry) {
    return;
  }
  const phase = resolveFirstAssistantTimingPhase(host, payload, entry);
  if (!phase) {
    if (payload.state === "final" || payload.state === "aborted" || payload.state === "error") {
      host.chatSendTimingsByRun?.delete(runId);
    }
    return;
  }

  const eventAtMs = controlUiNowMs();
  entry.firstAssistantVisibleRecorded = true;
  scheduleControlUiAfterPaint(host, () => {
    const paintedAtMs = controlUiNowMs();
    recordControlUiPerformanceEvent(
      host as Parameters<typeof recordControlUiPerformanceEvent>[0],
      "control-ui.chat.send",
      {
        phase,
        durationMs: roundedControlUiDurationMs(paintedAtMs - entry.submittedAtMs),
        runId,
        sessionKey: entry.sessionKey ?? payload.sessionKey,
        agentId: entry.agentId ?? payload.agentId,
        sendAttempts: entry.sendAttempts,
        sendState: entry.sendState,
        ackStatus: entry.ackStatus,
        eventState: payload.state,
        firstAssistantPaintMs: roundedControlUiDurationMs(paintedAtMs - eventAtMs),
        ...(entry.requestStartedAtMs != null
          ? {
              requestToFirstAssistantEventMs: roundedControlUiDurationMs(
                eventAtMs - entry.requestStartedAtMs,
              ),
            }
          : {}),
        ...(entry.ackAtMs != null
          ? {
              ackToFirstAssistantEventMs: roundedControlUiDurationMs(eventAtMs - entry.ackAtMs),
            }
          : {}),
      },
      { console: false, maxBufferedEventsForType: 40 },
    );
    if (phase === "terminal-before-delta") {
      host.chatSendTimingsByRun?.delete(runId);
    }
  });
}

function shouldRecordPendingSendPaint(item: ChatQueueItem): boolean {
  return (
    typeof item.sendSubmittedAtMs === "number" &&
    (item.sendState === "waiting-model" ||
      item.sendState === "sending" ||
      item.sendState === "waiting-reconnect")
  );
}

function schedulePendingSendPaintTiming(
  host: ChatHost,
  item: ChatQueueItem,
  startedAtMs = item.sendSubmittedAtMs,
) {
  const sessionKey = item.sessionKey ?? host.sessionKey;
  const sendRunId = item.sendRunId;
  if (!sendRunId || startedAtMs == null) {
    return;
  }
  scheduleControlUiAfterPaint(host as Parameters<typeof scheduleControlUiAfterPaint>[0], () => {
    if (!visibleSessionMatches(host, sessionKey, item.agentId)) {
      return;
    }
    const queued = readChatQueueForSession(host, sessionKey).find(
      (entry) => entry.id === item.id && entry.sendRunId === sendRunId,
    );
    if (!queued || !shouldRecordPendingSendPaint(queued)) {
      return;
    }
    recordChatSendTiming(host, queued, "pending-painted", startedAtMs);
  });
}

function ensureQueuedSendState(
  host: ChatHost,
  item: ChatQueueItem,
  fallbackSessionKey = host.sessionKey,
): ChatQueueItem {
  if (item.sendRunId && item.sendState) {
    return item;
  }
  const sessionKey = item.sessionKey ?? fallbackSessionKey;
  const agentId = item.agentId ?? scopedAgentIdForSession(host, sessionKey);
  const prepared: ChatQueueItem = {
    ...item,
    sendAttempts: item.sendAttempts ?? 0,
    sendRunId: item.sendRunId ?? generateUUID(),
    sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
    sessionKey,
    agentId,
  };
  updateQueuedMessageForSession(host, sessionKey, item.id, () => prepared);
  return prepared;
}

async function sendQueuedChatMessage(
  host: ChatHost,
  id: string,
  opts?: {
    previousAttachments?: ChatAttachment[];
    previousDraft?: string;
  },
  queuedSessionKey = host.sessionKey,
): Promise<QueuedChatSendResult> {
  const queued = readChatQueueForSession(host, queuedSessionKey).find((item) => item.id === id);
  if (!queued || queued.pendingRunId || queued.localCommandName) {
    return "failed";
  }
  const prepared = ensureQueuedSendState(host, queued, queuedSessionKey);
  const message = prepared.text.trim();
  const attachments = prepared.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  if (!message && !hasAttachments) {
    removeQueuedMessageWithoutReleasing(host, id, prepared.sessionKey ?? host.sessionKey);
    return "sent";
  }
  const sessionKey = prepared.sessionKey ?? host.sessionKey;
  if (!host.connected || !host.client) {
    updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
      ...item,
      sendState: "waiting-reconnect",
      sendError: undefined,
    }));
    return "pending";
  }

  const runId = prepared.sendRunId ?? generateUUID();
  const startedAt = Date.now();
  const requestStartedAtMs = controlUiNowMs();
  const sendingItem =
    updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
      ...item,
      sendAttempts: (item.sendAttempts ?? 0) + 1,
      sendError: undefined,
      sendRunId: runId,
      sendState: "sending",
      sendRequestStartedAtMs: requestStartedAtMs,
      sessionKey,
      agentId: prepared.agentId,
    })) ?? prepared;
  registerChatSendTiming(host, sendingItem, runId, requestStartedAtMs);
  recordChatSendTiming(host, sendingItem, "request-start", sendingItem.sendSubmittedAtMs);
  host.chatSending = true;
  const isVisibleSession = () => visibleSessionMatches(host, sessionKey, prepared.agentId);
  if (isVisibleSession()) {
    setChatError(host, null);
    reconcileChatRunLifecycle(host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      clearRunStatus: true,
    });
  }

  try {
    const ack = await requestChatSend(host as unknown as ChatState, {
      message,
      attachments: hasAttachments ? attachments : undefined,
      runId,
      sessionKey,
      agentId: prepared.agentId,
    });
    updateChatSendAckTiming(host, runId, ack, sendingItem, requestStartedAtMs);
    recordChatSendTiming(host, sendingItem, "ack", sendingItem.sendSubmittedAtMs, {
      ackStatus: ack.status,
      requestDurationMs: roundedControlUiDurationMs(controlUiNowMs() - requestStartedAtMs),
    });
    removeQueuedMessageWithoutReleasing(host, id, sessionKey);
    if (isVisibleSession()) {
      appendUserChatMessage(
        host as unknown as ChatState,
        message,
        hasAttachments ? attachments : undefined,
        startedAt,
      );
      if (ack.status === "ok") {
        reconcileChatRunLifecycle(
          host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
          {
            sessionStatus: "done",
            runId: ack.runId,
            sessionKey,
            clearLocalRun: true,
            clearChatStream: true,
            clearToolStream: true,
            clearSideResultTerminalRuns: true,
            clearRunStatus: true,
          },
        );
        void loadChatHistory(host as unknown as ChatState);
      } else {
        const hasAlreadyAdoptedRunStream =
          host.chatRunId === ack.runId && typeof host.chatStream === "string";
        host.chatRunId = ack.runId;
        // Gateway can deliver the first delta before the chat.send ACK resolves.
        // Preserve that adopted stream; resetting here makes first replies vanish
        // until a later delta or final event arrives.
        if (!hasAlreadyAdoptedRunStream) {
          host.chatStream = "";
          (host as ChatHost & { chatStreamStartedAt?: number | null }).chatStreamStartedAt =
            startedAt;
        }
      }
    }
    if (prepared.refreshSessions) {
      const refreshTarget = {
        sessionKey,
        agentId: prepared.agentId,
      };
      if (ack.status === "ok") {
        void loadSessions(host as unknown as SessionsState, {
          ...createChatSessionsLoadOverrides(host),
          ...scopedAgentListParamsForRefreshTarget(host, refreshTarget),
        });
      } else {
        host.refreshSessionsAfterChat.set(ack.runId, refreshTarget);
      }
    }
    discardChatAttachmentDataUrls(excludeComposerAttachments(host, attachments));
    return "sent";
  } catch (err) {
    const error = formatConnectError(err);
    if (isRecoverableChatSendError(err, error)) {
      updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
        ...item,
        sendError: error,
        sendState: "waiting-reconnect",
      }));
      if (isVisibleSession()) {
        setChatError(host, "Message will send when the Gateway reconnects.");
      }
      recordChatSendTiming(host, prepared, "waiting-reconnect", prepared.sendSubmittedAtMs, {
        error,
      });
      return "pending";
    }
    updateQueuedMessageForSession(host, sessionKey, id, (item) => ({
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
    host.chatSending = false;
  }
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    queueItemId?: string;
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
    submittedAtMs?: number;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  // Reset scroll state before sending to ensure auto-scroll works for the response
  resetChatScroll(host as unknown as Parameters<typeof resetChatScroll>[0]);
  const queued =
    opts?.queueItemId != null
      ? (host.chatQueue.find((item) => item.id === opts.queueItemId) ?? null)
      : enqueuePendingSendMessage(
          host,
          message,
          opts?.attachments,
          opts?.refreshSessions,
          opts?.submittedAtMs,
        );
  if (!queued) {
    return false;
  }
  const queuedSessionKey = queued.sessionKey ?? host.sessionKey;
  const result = await sendQueuedChatMessage(host, queued.id, {
    previousDraft: opts?.previousDraft,
    previousAttachments: opts?.previousAttachments,
  });
  const ok = result === "sent";
  if (ok && host.sessionKey === queuedSessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      queuedSessionKey,
    );
    resetChatInputHistoryNavigation(host);
  }
  if (
    ok &&
    host.sessionKey === queuedSessionKey &&
    opts?.restoreDraft &&
    opts.previousDraft?.trim()
  ) {
    host.chatMessage = opts.previousDraft;
  }
  if (
    ok &&
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
  if (ok && host.sessionKey === queuedSessionKey && !host.chatRunId) {
    void flushChatQueue(host);
  }
  return ok;
}

function attachmentSubmitSignature(attachment: ChatAttachment): string {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  return JSON.stringify([
    attachment.id,
    attachment.mimeType,
    attachment.fileName ?? "",
    attachment.sizeBytes ?? 0,
    dataUrl?.length ?? 0,
    dataUrl?.slice(0, 64) ?? "",
  ]);
}

function chatSubmitKey(
  host: ChatHost,
  kind: "btw" | "message",
  message: string,
  attachments: ChatAttachment[],
): string {
  return JSON.stringify([
    kind,
    host.sessionKey,
    message.trim(),
    attachments.map(attachmentSubmitSignature),
  ]);
}

async function withChatSubmitGuard<T>(
  host: ChatHost,
  key: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const guards = (host.chatSubmitGuards ??= new Map<string, Promise<void>>());
  if (guards.has(key)) {
    return undefined;
  }
  let releaseGuard!: () => void;
  const guard = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  guards.set(key, guard);
  try {
    return await run();
  } finally {
    releaseGuard();
    if (guards.get(key) === guard) {
      guards.delete(key);
    }
  }
}

function waitForPendingChatModelSwitch(
  host: ChatHost,
  sessionKey: string,
): Promise<boolean> | true {
  const pending = host.chatModelSwitchPromises?.[sessionKey];
  if (!pending) {
    return true;
  }
  return pending;
}

function clearSubmittedComposerState(
  host: ChatHost,
  submittedDraft: string,
  submittedAttachments: ChatAttachment[],
): {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
} {
  const attachmentsUnchanged =
    host.chatAttachments.length === submittedAttachments.length &&
    host.chatAttachments.every(
      (attachment, index) =>
        attachmentSubmitSignature(attachment) ===
        attachmentSubmitSignature(submittedAttachments[index]),
    );
  const clearedDraft = host.chatMessage === submittedDraft && attachmentsUnchanged;
  const clearedAttachments = clearedDraft;
  if (clearedDraft) {
    host.chatMessage = "";
  }
  if (clearedAttachments) {
    host.chatAttachments = [];
  }
  if (clearedDraft || clearedAttachments) {
    resetChatInputHistoryNavigation(host);
  }
  return {
    previousAttachments: clearedAttachments ? submittedAttachments : undefined,
    previousDraft: clearedDraft ? submittedDraft : undefined,
  };
}

function excludeComposerAttachments(
  host: ChatHost,
  attachments: readonly ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  if (!attachments?.length) {
    return attachments ? [] : undefined;
  }
  const retainedIds = new Set((host.chatAttachments ?? []).map((attachment) => attachment.id));
  return attachments.filter((attachment) => !retainedIds.has(attachment.id));
}

function snapshotChatAttachments(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return {
      ...attachment,
      ...(dataUrl ? { dataUrl } : {}),
    };
  });
}

async function sendDetachedBtwMessage(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
  },
) {
  const runId = await sendDetachedChatMessage(
    host as unknown as ChatState,
    message,
    opts?.attachments,
  );
  const ok = Boolean(runId);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, opts?.attachments));
  }
  return ok;
}

export async function steerQueuedChatMessage(host: ChatHost, id: string) {
  if (!host.connected || !host.chatRunId) {
    return;
  }
  const activeRunId = host.chatRunId;
  const item = host.chatQueue.find(
    (entry) => entry.id === id && !entry.pendingRunId && !entry.localCommandName,
  );
  if (!item) {
    return;
  }
  const message = item.text.trim();
  const attachments = item.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  if (!message && !hasAttachments) {
    return;
  }

  host.chatQueue = host.chatQueue.map((entry) =>
    entry.id === id ? { ...entry, kind: "steered", pendingRunId: activeRunId } : entry,
  );
  const runId = await sendSteerChatMessage(
    host as unknown as ChatState,
    message,
    hasAttachments ? attachments : undefined,
  );
  if (!runId) {
    host.chatQueue = host.chatQueue.map((entry) => (entry.id === id ? item : entry));
    return;
  }
  releaseChatAttachmentPayloads(attachments);
  setLastActiveSessionKey(
    host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
    host.sessionKey,
  );
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const nextIndex = host.chatQueue.findIndex(
    (item) =>
      !item.pendingRunId &&
      item.sendState !== "sending" &&
      item.sendState !== "waiting-model" &&
      item.sendState !== "failed" &&
      (item.sessionKey == null || item.sessionKey === host.sessionKey),
  );
  if (nextIndex < 0) {
    return;
  }
  const next = host.chatQueue[nextIndex];
  let ok = false;
  try {
    if (next.localCommandName) {
      host.chatQueue = host.chatQueue.filter((_, index) => index !== nextIndex);
      await dispatchSlashCommand(host, next.localCommandName, next.localCommandArgs ?? "");
      ok = true;
    } else {
      ok = await sendChatMessageNow(host, next.text, {
        queueItemId: next.id,
        attachments: next.attachments,
        refreshSessions: next.refreshSessions,
      });
    }
  } catch (err) {
    setChatError(host, String(err));
  }
  if (!ok && next.localCommandName) {
    host.chatQueue = [next, ...host.chatQueue];
  } else if (ok && host.chatQueue.length > 0) {
    // Continue draining — local commands don't block on server response
    void flushChatQueue(host);
  }
}

function isSelectedSessionKnownIdle(
  sessionsResult: SessionsListResult,
  sessionKey: string,
): boolean {
  const row = sessionsResult.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, sessionKey),
  );
  return Boolean(row && !isSessionRunActive(row));
}

function isHistorySessionInfoForRequestedSession(
  host: ChatHost,
  historySessionKey: string | undefined,
  requestedSessionKey: string,
): boolean {
  if (areUiSessionKeysEquivalent(historySessionKey, requestedSessionKey)) {
    return true;
  }
  return Boolean(
    historySessionKey &&
    isUiGlobalSessionKey(historySessionKey) &&
    resolveUiGlobalAliasAgentId(host, requestedSessionKey),
  );
}

function findSelectedSessionRow(
  host: ChatHost,
  sessionsResult: SessionsListResult | null | undefined,
  sessionKey: string,
  historySessionKey: string | undefined,
): GatewaySessionRow | undefined {
  const requestedGlobalAgentId =
    historySessionKey && isUiGlobalSessionKey(historySessionKey)
      ? resolveUiGlobalAliasAgentId(host, sessionKey)
      : undefined;
  return sessionsResult?.sessions.find((session) => {
    if (areUiSessionKeysEquivalent(session.key, sessionKey)) {
      return true;
    }
    return (
      requestedGlobalAgentId != null &&
      resolveUiGlobalAliasAgentId(host, session.key) === requestedGlobalAgentId
    );
  });
}

function historyIdleProofIsStaleForSelectedRow(
  historySessionInfo: GatewaySessionRow,
  selectedRow: GatewaySessionRow | undefined,
): boolean {
  if (!selectedRow || !isSessionRunActive(selectedRow) || isSessionRunActive(historySessionInfo)) {
    return false;
  }
  const historyUpdatedAt =
    typeof historySessionInfo.updatedAt === "number" ? historySessionInfo.updatedAt : null;
  if (historyUpdatedAt == null) {
    return true;
  }
  const selectedUpdatedAt = typeof selectedRow.updatedAt === "number" ? selectedRow.updatedAt : 0;
  if (selectedUpdatedAt >= historyUpdatedAt) {
    return true;
  }
  const selectedStartedAt = typeof selectedRow.startedAt === "number" ? selectedRow.startedAt : 0;
  return selectedStartedAt >= historyUpdatedAt;
}

function flushChatQueueAfterIdleSessionReconciliation(
  host: ChatHost,
  sessionKey: string,
  historyRefresh: Promise<ChatHistoryResult | undefined>,
  sessionsRefresh: Promise<unknown>,
  previousSessionsResult: SessionsListResult | null | undefined,
) {
  if (host.chatQueue.length === 0) {
    return;
  }
  void Promise.allSettled([historyRefresh, sessionsRefresh]).then((results) => {
    const historyRefreshSettled = results[0];
    const sessionsRefreshSettled = results[1];
    const freshSessionsResult = host.sessionsResult;
    const historySessionInfo =
      historyRefreshSettled.status === "fulfilled"
        ? historyRefreshSettled.value?.sessionInfo
        : null;
    const selectedSessionRow = findSelectedSessionRow(
      host,
      freshSessionsResult,
      sessionKey,
      historySessionInfo?.key,
    );
    const historySessionKnownIdle = Boolean(
      historySessionInfo &&
      isHistorySessionInfoForRequestedSession(host, historySessionInfo.key, sessionKey) &&
      !isSessionRunActive(historySessionInfo) &&
      !historyIdleProofIsStaleForSelectedRow(historySessionInfo, selectedSessionRow),
    );
    const sessionsResultKnownIdle = freshSessionsResult
      ? isSelectedSessionKnownIdle(freshSessionsResult, sessionKey)
      : false;
    if (
      sessionsRefreshSettled.status !== "fulfilled" ||
      host.chatQueue.length === 0 ||
      !areUiSessionKeysEquivalent(host.sessionKey, sessionKey) ||
      (!freshSessionsResult && !historySessionKnownIdle) ||
      (freshSessionsResult === previousSessionsResult && !historySessionKnownIdle) ||
      (host.sessionsError && !historySessionKnownIdle) ||
      !(historySessionKnownIdle || sessionsResultKnownIdle)
    ) {
      return;
    }
    void flushChatQueue(host);
  });
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  const removed = host.chatQueue.filter((item) => item.id === id);
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
  for (const item of removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, item.attachments));
  }
}

export function clearPendingQueueItemsForRun(host: ChatHost, runId: string | undefined) {
  if (!runId) {
    return;
  }
  const removed = host.chatQueue.filter((item) => item.pendingRunId === runId);
  host.chatQueue = host.chatQueue.filter((item) => item.pendingRunId !== runId);
  for (const item of removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, item.attachments));
  }
}

type ChatQueueStoreHost = {
  chatQueue: ChatQueueItem[];
  chatQueueBySession?: Record<string, ChatQueueItem[]>;
};

function chatQueueCollections(host: ChatQueueStoreHost): ChatQueueItem[][] {
  return [host.chatQueue, ...Object.values(host.chatQueueBySession ?? {})];
}

export function hasReconnectableQueuedChatSends(host: ChatQueueStoreHost): boolean {
  return chatQueueCollections(host).some((queue) =>
    queue.some((item) => item.sendRunId && item.sendState === "waiting-reconnect"),
  );
}

export function markQueuedChatSendsWaitingForReconnect(host: ChatQueueStoreHost) {
  const markQueue = (queue: ChatQueueItem[]): { changed: boolean; queue: ChatQueueItem[] } => {
    let changed = false;
    const nextQueue = queue.map((item) => {
      if (!item.sendRunId || item.sendState !== "sending") {
        return item;
      }
      changed = true;
      return {
        ...item,
        sendState: "waiting-reconnect" as const,
      };
    });
    return { changed, queue: nextQueue };
  };

  const active = markQueue(host.chatQueue);
  if (active.changed) {
    host.chatQueue = active.queue;
  }

  let changed = false;
  const queueBySession = { ...host.chatQueueBySession };
  for (const [sessionKey, queue] of Object.entries(queueBySession)) {
    const next = markQueue(queue);
    if (next.changed) {
      changed = true;
      queueBySession[sessionKey] = next.queue;
    }
  }
  if (changed) {
    host.chatQueueBySession = queueBySession;
  }
}

export async function retryReconnectableQueuedChatSends(host: ChatHost) {
  if (!host.connected || !host.client || host.chatSending) {
    return;
  }
  const sessionKeys = [
    host.sessionKey,
    ...Object.keys(host.chatQueueBySession ?? {}).filter(
      (sessionKey) => sessionKey !== host.sessionKey,
    ),
  ];
  for (const sessionKey of sessionKeys) {
    const item = readChatQueueForSession(host, sessionKey).find(
      (entry) =>
        entry.sendRunId &&
        entry.sendState === "waiting-reconnect" &&
        !entry.pendingRunId &&
        !entry.localCommandName,
    );
    if (!item) {
      continue;
    }
    await sendQueuedChatMessage(host, item.id, undefined, sessionKey);
    if (host.chatRunId) {
      return;
    }
  }
  if (!host.chatRunId) {
    void flushChatQueue(host);
  }
}

export async function retryQueuedChatMessage(host: ChatHost, id: string) {
  const item = host.chatQueue.find((entry) => entry.id === id);
  if (
    !item ||
    item.localCommandName ||
    item.pendingRunId ||
    item.sendState === "sending" ||
    item.sendState === "waiting-model"
  ) {
    return;
  }
  updateQueuedMessage(host, id, (entry) => ({
    ...entry,
    sendError: undefined,
    sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
  }));
  await sendQueuedChatMessage(host, id);
  if (!host.chatRunId) {
    void flushChatQueue(host);
  }
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: ChatSendOptions,
) {
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const submittedAtMs = controlUiNowMs();
  const submittedSessionKey = host.sessionKey;
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? snapshotChatAttachments(attachments) : [];
  const hasAttachments = attachmentsToSend.length > 0;

  if (!message && !hasAttachments) {
    return;
  }

  if (messageOverride != null && opts?.confirmReset && !confirmChatResetCommand(message)) {
    return;
  }

  if (isChatStopCommand(message)) {
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, message);
    }
    await handleAbortChat(host);
    return;
  }

  if (isBtwCommand(message)) {
    const submitKey = chatSubmitKey(host, "btw", message, attachmentsToSend);
    await withChatSubmitGuard(host, submitKey, async () => {
      const modelSwitchReady = waitForPendingChatModelSwitch(host, submittedSessionKey);
      if (modelSwitchReady !== true && !(await modelSwitchReady)) {
        return;
      }
      if (host.sessionKey !== submittedSessionKey) {
        return;
      }
      const cleared =
        messageOverride == null
          ? clearSubmittedComposerState(host, previousDraft, attachmentsToSend)
          : {};
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
      }
      await sendDetachedBtwMessage(host, message, {
        previousDraft: cleared.previousDraft,
        attachments: hasAttachments ? attachmentsToSend : undefined,
        previousAttachments: cleared.previousAttachments,
      });
    });
    return;
  }

  // Intercept local slash commands (/status, /model, /compact, etc.)
  const parsed = parseSlashCommand(message);
  if (parsed?.command.executeLocal) {
    if (isChatBusy(host) && shouldQueueLocalSlashCommand(parsed.command.key)) {
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
        host.chatMessage = "";
        host.chatAttachments = [];
        resetChatInputHistoryNavigation(host);
      }
      enqueueChatMessage(host, message, undefined, isChatResetCommand(message), {
        args: parsed.args,
        name: parsed.command.key,
      });
      return;
    }
    const prevDraft = messageOverride == null ? previousDraft : undefined;
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, message);
      host.chatMessage = "";
      host.chatAttachments = [];
      resetChatInputHistoryNavigation(host);
    }
    await dispatchSlashCommand(host, parsed.command.key, parsed.args, {
      previousDraft: prevDraft,
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    });
    return;
  }

  const refreshSessions = isChatResetCommand(message);
  const submitKey = chatSubmitKey(host, "message", message, attachmentsToSend);
  await withChatSubmitGuard(host, submitKey, async () => {
    if (host.sessionKey !== submittedSessionKey) {
      return;
    }
    const cleared =
      messageOverride == null
        ? clearSubmittedComposerState(host, previousDraft, attachmentsToSend)
        : {};
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, message);
    }

    const modelSwitchReady = waitForPendingChatModelSwitch(host, submittedSessionKey);
    const waitingForModel = modelSwitchReady !== true;
    const queued = enqueuePendingSendMessage(
      host,
      message,
      hasAttachments ? attachmentsToSend : undefined,
      refreshSessions,
      submittedAtMs,
      waitingForModel ? "waiting-model" : undefined,
    );
    if (!queued) {
      return;
    }

    if (modelSwitchReady !== true && !(await modelSwitchReady)) {
      if (host.sessionKey === submittedSessionKey) {
        cancelPendingSendBeforeRequest(host, queued, {
          previousDraft: cleared.previousDraft,
          previousAttachments: cleared.previousAttachments,
        });
      } else {
        updateQueuedMessageForSession(host, submittedSessionKey, queued.id, (item) => ({
          ...item,
          sendError: INTERRUPTED_MODEL_WAIT_ERROR,
          sendState: "failed",
        }));
        persistQueuedMessagesForSession(host, submittedSessionKey);
      }
      return;
    }
    if (host.sessionKey !== submittedSessionKey) {
      updateQueuedMessageForSession(host, submittedSessionKey, queued.id, (item) => ({
        ...item,
        sendError: undefined,
        sendState: undefined,
      }));
      persistQueuedMessagesForSession(host, submittedSessionKey);
      return;
    }

    if (isChatBusy(host)) {
      updateQueuedMessage(host, queued.id, (item) => ({
        ...item,
        sendError: undefined,
        sendState: undefined,
      }));
      recordChatSendTiming(host, queued, "queued-busy", submittedAtMs);
      return;
    }

    await sendChatMessageNow(host, message, {
      queueItemId: queued.id,
      previousDraft: cleared.previousDraft,
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
      attachments: hasAttachments ? attachmentsToSend : undefined,
      previousAttachments: cleared.previousAttachments,
      restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
      refreshSessions,
      submittedAtMs,
    });
  });
}

function shouldQueueLocalSlashCommand(name: string): boolean {
  return !["stop", "export-session", "steer", "redirect", "new"].includes(name);
}

// ── Slash Command Dispatch ──

async function dispatchSlashCommand(
  host: ChatHost,
  name: string,
  args: string,
  sendOpts?: { previousDraft?: string; restoreDraft?: boolean },
) {
  switch (name) {
    case "stop":
      await handleAbortChat(host);
      return;
    case "new":
      if (!host.onSlashAction) {
        setChatError(host, "New Chat is unavailable.");
        return;
      }
      await host.onSlashAction("new-session");
      return;
    case "reset":
      await sendChatMessageNow(host, "/reset", {
        refreshSessions: true,
        previousDraft: sendOpts?.previousDraft,
        restoreDraft: sendOpts?.restoreDraft,
      });
      return;
    case "clear":
      await clearChatHistory(host);
      return;
    case "export-session":
      await host.onSlashAction?.("export");
      return;
  }

  if (!host.client || !host.connected) {
    setChatError(host, "Gateway not connected");
    injectCommandResult(
      host,
      `Cannot run \`/${name}\`: Control UI is not connected to the Gateway.`,
    );
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
    return;
  }

  const targetSessionKey = host.sessionKey;
  let result: Awaited<ReturnType<typeof executeSlashCommand>>;
  try {
    result = await executeSlashCommand(host.client, targetSessionKey, name, args, {
      chatModelCatalog: host.chatModelCatalog,
      sessionsResult: host.sessionsResult,
      agentId: scopedAgentIdForSession(host, targetSessionKey),
    });
  } catch (err) {
    setChatError(host, String(err));
    injectCommandResult(host, `Command \`/${name}\` failed unexpectedly.`);
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
    return;
  }

  if (result.content) {
    injectCommandResult(host, result.content);
  }

  if (result.trackRunId) {
    host.chatRunId = result.trackRunId;
    host.chatStream = "";
    host.chatSending = false;
  }

  if (result.pendingCurrentRun && host.chatRunId) {
    enqueuePendingRunMessage(host, `/${name} ${args}`.trim(), host.chatRunId);
  }

  if (result.sessionPatch && "modelOverride" in result.sessionPatch) {
    host.chatModelOverrides = {
      ...host.chatModelOverrides,
      [targetSessionKey]: result.sessionPatch.modelOverride ?? null,
    };
    await host.onSlashAction?.("refresh-tools-effective");
  }

  if (result.action === "refresh") {
    await refreshChat(host);
  }

  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

async function clearChatHistory(host: ChatHost) {
  if (!host.client || !host.connected) {
    return;
  }
  const hadActiveRun = hasAbortableSessionRun(host);
  try {
    await host.client.request("sessions.reset", {
      key: host.sessionKey,
      ...scopedAgentParamsForSession(host, host.sessionKey),
    });
    host.chatMessages = [];
    host.chatSideResult = null;
    reconcileChatRunLifecycle(host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      outcome: hadActiveRun ? "interrupted" : undefined,
      sessionStatus: "killed",
      runId: host.chatRunId,
      sessionKey: host.sessionKey,
      clearLocalRun: true,
      clearChatStream: true,
      clearToolStream: true,
      clearSideResultTerminalRuns: true,
      clearRunStatus: !hadActiveRun,
    });
    await loadChatHistory(host as unknown as ChatState);
  } catch (err) {
    setChatError(host, String(err));
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

function injectCommandResult(host: ChatHost, content: string) {
  host.chatMessages = [
    ...host.chatMessages,
    {
      role: "system",
      content,
      timestamp: Date.now(),
    },
  ];
}

export async function refreshChat(
  host: ChatHost,
  opts?: { scheduleScroll?: boolean; awaitHistory?: boolean; startup?: boolean },
) {
  const refreshedSessionKey = host.sessionKey;
  const requestUpdate = () => host.requestUpdate?.();
  const previousSessionsResult = host.sessionsResult;
  const historyLoad = loadChatHistory(host as unknown as ChatState, {
    startup: opts?.startup === true,
  });
  const historyRefresh = historyLoad.finally(() => {
    if (opts?.scheduleScroll !== false) {
      scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
    }
    requestUpdate();
  });
  const sessionsRefresh = historyLoad.then((history) => {
    if (history?.sessionInfo) {
      applyChatHistorySessionInfo(
        host as unknown as SessionsState,
        history.sessionInfo,
        history.defaults,
      );
    }
  });
  flushChatQueueAfterIdleSessionReconciliation(
    host,
    refreshedSessionKey,
    historyRefresh,
    sessionsRefresh,
    previousSessionsResult,
  );
  const secondaryRefresh = Promise.allSettled([sessionsRefresh]).finally(requestUpdate);
  scheduleChatMetadataRefresh(() => {
    if (host.sessionKey !== refreshedSessionKey || !host.connected) {
      return;
    }
    void Promise.allSettled([
      refreshChatAvatar(host),
      refreshChatModels(host),
      refreshChatCommands(host),
    ]).finally(requestUpdate);
  });
  void historyRefresh;
  void secondaryRefresh;
  if (opts?.awaitHistory === true) {
    await historyRefresh;
    return;
  }
  await Promise.resolve();
}

function scheduleChatMetadataRefresh(callback: () => void) {
  const requestIdleCallback =
    typeof globalThis.requestIdleCallback === "function" ? globalThis.requestIdleCallback : null;
  if (requestIdleCallback) {
    requestIdleCallback(callback, { timeout: 750 });
    return;
  }
  globalThis.setTimeout(callback, 50);
}

async function refreshChatModels(host: ChatHost) {
  if (!host.client || !host.connected) {
    host.chatModelsLoading = false;
    host.chatModelCatalog = [];
    return;
  }
  host.chatModelsLoading = true;
  try {
    host.chatModelCatalog = await loadModels(host.client);
  } finally {
    host.chatModelsLoading = false;
  }
}

async function refreshChatCommands(host: ChatHost) {
  await refreshSlashCommands({
    client: host.client,
    agentId: resolveAgentIdForSession(host),
  });
}

export const flushChatQueueForEvent = flushChatQueue;
const chatAvatarRequestVersions = new WeakMap<object, number>();

const chatAvatarObjectUrls = new WeakMap<object, string>();

function beginChatAvatarRequest(host: ChatHost): number {
  const key = host as object;
  const nextVersion = (chatAvatarRequestVersions.get(key) ?? 0) + 1;
  chatAvatarRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function shouldApplyChatAvatarResult(
  host: ChatHost,
  version: number,
  sessionKey: string,
  agentId: string | null,
): boolean {
  return (
    chatAvatarRequestVersions.get(host as object) === version &&
    host.sessionKey === sessionKey &&
    resolveAgentIdForSession(host) === agentId
  );
}

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  if (isUiGlobalSessionKey(host.sessionKey)) {
    return resolveUiSelectedGlobalAgentId(host) || DEFAULT_AGENT_ID;
  }
  return readHelloDefaultAgentId(host) || DEFAULT_AGENT_ID;
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

function clearChatAvatarUrl(host: ChatHost) {
  const key = host as object;
  const previousBlobUrl = chatAvatarObjectUrls.get(key);
  if (previousBlobUrl) {
    URL.revokeObjectURL(previousBlobUrl);
    chatAvatarObjectUrls.delete(key);
  }
  host.chatAvatarUrl = null;
}

function clearChatAvatarState(host: ChatHost) {
  clearChatAvatarUrl(host);
  host.chatAvatarSource = null;
  host.chatAvatarStatus = null;
  host.chatAvatarReason = null;
}

function setChatAvatarUrl(host: ChatHost, nextUrl: string | null) {
  const key = host as object;
  const previousBlobUrl = chatAvatarObjectUrls.get(key);
  if (previousBlobUrl && previousBlobUrl !== nextUrl) {
    URL.revokeObjectURL(previousBlobUrl);
    chatAvatarObjectUrls.delete(key);
  }
  if (nextUrl?.startsWith("blob:")) {
    chatAvatarObjectUrls.set(key, nextUrl);
  }
  host.chatAvatarUrl = nextUrl;
}

function setChatAvatarMeta(
  host: ChatHost,
  data: {
    avatarSource?: unknown;
    avatarStatus?: unknown;
    avatarReason?: unknown;
  },
) {
  const status =
    data.avatarStatus === "none" ||
    data.avatarStatus === "local" ||
    data.avatarStatus === "remote" ||
    data.avatarStatus === "data"
      ? data.avatarStatus
      : null;
  host.chatAvatarSource =
    typeof data.avatarSource === "string" && data.avatarSource.trim()
      ? data.avatarSource.trim()
      : null;
  host.chatAvatarStatus = status;
  host.chatAvatarReason =
    typeof data.avatarReason === "string" && data.avatarReason.trim()
      ? data.avatarReason.trim()
      : null;
}

function buildControlUiAuthHeaders(authHeader: string | null): Record<string, string> | undefined {
  return authHeader ? { Authorization: authHeader } : undefined;
}

function isLocalControlUiAvatarUrl(avatarUrl: string): boolean {
  return avatarUrl.startsWith("/");
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    clearChatAvatarState(host);
    return;
  }
  const sessionKey = host.sessionKey;
  const requestVersion = beginChatAvatarRequest(host);
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      clearChatAvatarState(host);
    }
    return;
  }
  clearChatAvatarState(host);
  const authHeader = resolveControlUiAuthHeader(host);
  const headers = buildControlUiAuthHeaders(authHeader);
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET", ...(headers ? { headers } : {}) });
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      return;
    }
    if (!res.ok) {
      clearChatAvatarState(host);
      return;
    }
    const data = (await res.json()) as {
      avatarUrl?: unknown;
      avatarSource?: unknown;
      avatarStatus?: unknown;
      avatarReason?: unknown;
    };
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      return;
    }
    setChatAvatarMeta(host, data);
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    if (!avatarUrl || !isRenderableControlUiAvatarUrl(avatarUrl)) {
      clearChatAvatarUrl(host);
      return;
    }
    if (!isLocalControlUiAvatarUrl(avatarUrl)) {
      setChatAvatarUrl(host, avatarUrl);
      return;
    }
    const avatarRes = await fetch(avatarUrl, {
      method: "GET",
      ...(headers ? { headers } : {}),
    });
    if (!avatarRes.ok) {
      if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
        clearChatAvatarUrl(host);
      }
      return;
    }
    const blobUrl = URL.createObjectURL(await avatarRes.blob());
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    setChatAvatarUrl(host, blobUrl);
  } catch {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey, agentId)) {
      clearChatAvatarState(host);
    }
  }
}
