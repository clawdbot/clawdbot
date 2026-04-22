import { setLastActiveSessionKey } from "./app-last-active-session.ts";
import { scheduleChatScroll, resetChatScroll } from "./app-scroll.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import { executeSlashCommand } from "./chat/slash-command-executor.ts";
import { parseSlashCommand, refreshSlashCommands } from "./chat/slash-commands.ts";
import { resolveControlUiAuthHeader } from "./control-ui-auth.ts";
import {
  abortChatRun,
  loadChatHistory,
  sendChatMessage,
  sendDetachedChatMessage,
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

export type ChatHost = {
  client: GatewayBrowserClient | null;
  chatMessages: unknown[];
  chatStream: string | null;
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  lastError?: string | null;
  sessionKey: string;
  basePath: string;
  settings?: { token?: string | null };
  password?: string | null;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  chatSideResult?: ChatSideResult | null;
  chatSideResultTerminalRuns?: Set<string>;
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
  updateComplete?: Promise<unknown>;
  refreshSessionsAfterChat: Set<string>;
  /** Callback for slash-command side effects that need app-level access. */
  onSlashAction?: (action: string) => void;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
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

function isBtwCommand(text: string) {
  return /^\/btw(?::|\s|$)/i.test(text.trim());
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
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
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
      refreshSessions,
      localCommandArgs: localCommand?.args,
      localCommandName: localCommand?.name,
    },
  ];
}

function enqueuePendingRunMessage(host: ChatHost, text: string, pendingRunId: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
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
  return ok;
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
  }
  return ok;
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
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

export function clearPendingQueueItemsForRun(host: ChatHost, runId: string | undefined) {
  if (!runId) {
    return;
  }
  host.chatQueue = host.chatQueue.filter((item) => item.pendingRunId !== runId);
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
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

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  if (isBtwCommand(message)) {
    if (messageOverride == null) {
      host.chatMessage = "";
      host.chatAttachments = [];
    }
    await sendDetachedBtwMessage(host, message, {
      previousDraft: messageOverride == null ? previousDraft : undefined,
      attachments: hasAttachments ? attachmentsToSend : undefined,
      previousAttachments: messageOverride == null ? attachments : undefined,
    });
    return;
  }

  // Intercept local slash commands (/status, /model, /compact, etc.)
  const parsed = parseSlashCommand(message);
  if (parsed?.command.executeLocal) {
    if (isChatBusy(host) && shouldQueueLocalSlashCommand(parsed.command.key)) {
      if (messageOverride == null) {
        host.chatMessage = "";
        host.chatAttachments = [];
      }
      enqueueChatMessage(host, message, undefined, isChatResetCommand(message), {
        args: parsed.args,
        name: parsed.command.key,
      });
      return;
    }
    const prevDraft = messageOverride == null ? previousDraft : undefined;
    if (messageOverride == null) {
      host.chatMessage = "";
      host.chatAttachments = [];
    }
    await dispatchSlashCommand(host, parsed.command.key, parsed.args, {
      previousDraft: prevDraft,
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    });
    return;
  }

  const refreshSessions = isChatResetCommand(message);
  if (messageOverride == null) {
    host.chatMessage = "";
    host.chatAttachments = [];
  }

  if (isChatBusy(host)) {
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
}

function shouldQueueLocalSlashCommand(name: string): boolean {
  return !["stop", "focus", "export-session", "steer", "redirect"].includes(name);
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
      await sendChatMessageNow(host, "/new", {
        refreshSessions: true,
        previousDraft: sendOpts?.previousDraft,
        restoreDraft: sendOpts?.restoreDraft,
      });
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
      host.onSlashAction?.("toggle-focus");
      return;
    case "export-session":
      host.onSlashAction?.("export");
      return;
  }

  if (!host.client) {
    return;
  }

  const targetSessionKey = host.sessionKey;
  const result = await executeSlashCommand(host.client, targetSessionKey, name, args, {
    chatModelCatalog: host.chatModelCatalog,
    sessionsResult: host.sessionsResult,
  });

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
    host.onSlashAction?.("refresh-tools-effective");
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

function buildControlUiAuthHeaders(authHeader: string | null): Record<string, string> | undefined {
  return authHeader ? { Authorization: authHeader } : undefined;
}

function isLocalControlUiAvatarUrl(avatarUrl: string): boolean {
  return avatarUrl.startsWith("/");
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    clearChatAvatarUrl(host);
    return;
  }
  const sessionKey = host.sessionKey;
  const requestVersion = beginChatAvatarRequest(host);
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      clearChatAvatarUrl(host);
    }
    return;
  }
  clearChatAvatarUrl(host);
  const authHeader = resolveControlUiAuthHeader(host);
  const headers = buildControlUiAuthHeaders(authHeader);
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET", ...(headers ? { headers } : {}) });
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      return;
    }
    if (!res.ok) {
      clearChatAvatarUrl(host);
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      return;
    }
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    if (!avatarUrl || !isRenderableControlUiAvatarUrl(avatarUrl)) {
      clearChatAvatarUrl(host);
      return;
    }
    if (!authHeader || !isLocalControlUiAvatarUrl(avatarUrl)) {
      setChatAvatarUrl(host, avatarUrl);
      return;
    }
    const avatarRes = await fetch(avatarUrl, {
      method: "GET",
      headers: { Authorization: authHeader },
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
      clearChatAvatarUrl(host);
    }
  }
}
