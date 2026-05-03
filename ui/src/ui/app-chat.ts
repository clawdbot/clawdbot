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
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
  type ChatInputHistoryState,
} from "./chat/input-history.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import { executeSlashCommand } from "./chat/slash-command-executor.ts";
import { parseSlashCommand, refreshSlashCommands } from "./chat/slash-commands.ts";
import { resolveControlUiAuthHeader } from "./control-ui-auth.ts";
import {
  abortChatRun,
  loadChatHistory,
  sendChatMessage,
  sendDetachedChatMessage,
  sendSteerChatMessage,
  type ChatState,
} from "./controllers/chat.ts";
import { loadModels } from "./controllers/models.ts";
import { loadSessions, type SessionsState } from "./controllers/sessions.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import { normalizeBasePath } from "./navigation.ts";
import { parseAgentSessionKey } from "./session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";
import type { ChatModelOverride, ModelCatalogEntry } from "./types.ts";
import type { SessionsListResult } from "./types.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";
import { isRenderableControlUiAvatarUrl } from "./views/agents-utils.ts";

export type ChatHost = ChatInputHistoryState & {
  client: GatewayBrowserClient | null;
  chatStream: string | null;
  connected: boolean;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  lastError?: string | null;
  basePath: string;
  settings?: { token?: string | null };
  password?: string | null;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarReason?: string | null;
  chatSideResult?: ChatSideResult | null;
  chatSideResultTerminalRuns?: Set<string>;
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
  updateComplete?: Promise<unknown>;
  refreshSessionsAfterChat: Set<string>;
  pendingAbort?: { runId?: string | null; sessionKey: string } | null;
  chatSubmitGuards?: Map<string, Promise<void>>;
  /** Callback for slash-command side effects that need app-level access. */
  onSlashAction?: (action: string) => void | Promise<void>;
};

export type ChatSendOptions = {
  confirmReset?: boolean;
  restoreDraft?: boolean;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;
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
      (session) => session.key === host.sessionKey && session.hasActiveRun === true,
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
  return /^\/btw(?::|\s|$)/i.test(text.trim());
}

export async function handleAbortChat(host: ChatHost) {
  const activeRunId = host.chatRunId;
  // If disconnected but this session is abortable, queue the abort for when we reconnect.
  if (!host.connected && hasAbortableSessionRun(host)) {
    host.chatMessage = "";
    resetChatInputHistoryNavigation(host);
    host.pendingAbort = { runId: activeRunId, sessionKey: host.sessionKey };
    return;
  }
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
  resetChatInputHistoryNavigation(host);
  await abortChatRun(host as unknown as ChatState);
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  localCommand?: { args: string; name: string },
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
      attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
      refreshSessions,
      localCommandArgs: localCommand?.args,
      localCommandName: localCommand?.name,
    },
  ];
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

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  // Reset scroll state before sending to ensure auto-scroll works for the response
  resetChatScroll(host as unknown as Parameters<typeof resetChatScroll>[0]);
  const runId = await sendChatMessage(host as unknown as ChatState, message, opts?.attachments);
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
    resetChatInputHistoryNavigation(host);
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  // Force scroll after sending to ensure viewport is at bottom for incoming stream
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  if (ok && opts?.refreshSessions && runId) {
    host.refreshSessionsAfterChat.add(runId);
  }
  if (ok) {
    discardChatAttachmentDataUrls(opts?.attachments);
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
    releaseChatAttachmentPayloads(opts?.attachments);
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
  const nextIndex = host.chatQueue.findIndex((item) => !item.pendingRunId);
  if (nextIndex < 0) {
    return;
  }
  const next = host.chatQueue[nextIndex];
  host.chatQueue = host.chatQueue.filter((_, index) => index !== nextIndex);
  let ok = false;
  try {
    if (next.localCommandName) {
      await dispatchSlashCommand(host, next.localCommandName, next.localCommandArgs ?? "");
      ok = true;
    } else {
      ok = await sendChatMessageNow(host, next.text, {
        attachments: next.attachments,
        refreshSessions: next.refreshSessions,
      });
    }
  } catch (err) {
    host.lastError = String(err);
  }
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  } else if (host.chatQueue.length > 0) {
    // Continue draining — local commands don't block on server response
    void flushChatQueue(host);
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  const removed = host.chatQueue.filter((item) => item.id === id);
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
  for (const item of removed) {
    releaseChatAttachmentPayloads(item.attachments);
  }
}

export function clearPendingQueueItemsForRun(host: ChatHost, runId: string | undefined) {
  if (!runId) {
    return;
  }
  const removed = host.chatQueue.filter((item) => item.pendingRunId === runId);
  host.chatQueue = host.chatQueue.filter((item) => item.pendingRunId !== runId);
  for (const item of removed) {
    releaseChatAttachmentPayloads(item.attachments);
  }
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: ChatSendOptions,
) {
  if (!host.connected) {
    return;
  }
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
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
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
        host.chatMessage = "";
        host.chatAttachments = [];
        resetChatInputHistoryNavigation(host);
      }
      await sendDetachedBtwMessage(host, message, {
        previousDraft: messageOverride == null ? previousDraft : undefined,
        attachments: hasAttachments ? attachmentsToSend : undefined,
        previousAttachments: messageOverride == null ? attachments : undefined,
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
    if (messageOverride == null) {
      host.chatMessage = "";
      host.chatAttachments = [];
      resetChatInputHistoryNavigation(host);
    }

    if (isChatBusy(host)) {
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
      }
      enqueueChatMessage(host, message, attachmentsToSend, refreshSessions);
      return;
    }

    await sendChatMessageNow(host, message, {
      previousDraft: messageOverride == null ? previousDraft : undefined,
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
      attachments: hasAttachments ? attachmentsToSend : undefined,
      previousAttachments: messageOverride == null ? attachments : undefined,
      restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
      refreshSessions,
    });
  });
}

function shouldQueueLocalSlashCommand(name: string): boolean {
  return !["stop", "focus", "export-session", "steer", "redirect", "new"].includes(name);
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
        host.lastError = "New Chat is unavailable.";
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
    case "focus":
      await host.onSlashAction?.("toggle-focus");
      return;
    case "export-session":
      await host.onSlashAction?.("export");
      return;
  }

  if (!host.client || !host.connected) {
    host.lastError = "Gateway not connected";
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
    });
  } catch (err) {
    host.lastError = String(err);
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
  try {
    await host.client.request("sessions.reset", { key: host.sessionKey });
    host.chatMessages = [];
    host.chatSideResult = null;
    host.chatSideResultTerminalRuns?.clear();
    host.chatStream = null;
    host.chatRunId = null;
    await loadChatHistory(host as unknown as ChatState);
  } catch (err) {
    host.lastError = String(err);
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

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as ChatState),
    loadSessions(host as unknown as SessionsState, {
      activeMinutes: 0,
      limit: 0,
      includeGlobal: true,
      includeUnknown: true,
    }),
    refreshChatAvatar(host),
    refreshChatModels(host),
    refreshChatCommands(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
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

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

const chatAvatarObjectUrls = new WeakMap<object, string>();

function beginChatAvatarRequest(host: ChatHost): number {
  const key = host as object;
  const nextVersion = (chatAvatarRequestVersions.get(key) ?? 0) + 1;
  chatAvatarRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function shouldApplyChatAvatarResult(host: ChatHost, version: number, sessionKey: string): boolean {
  return (
    chatAvatarRequestVersions.get(host as object) === version && host.sessionKey === sessionKey
  );
}

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
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
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
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
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
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
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
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
      if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
        clearChatAvatarUrl(host);
      }
      return;
    }
    const blobUrl = URL.createObjectURL(await avatarRes.blob());
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    setChatAvatarUrl(host, blobUrl);
  } catch {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      clearChatAvatarState(host);
    }
  }
}
