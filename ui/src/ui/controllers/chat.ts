import { resetToolStream } from "../app-tool-stream.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
} from "../chat/attachment-payload-store.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../chat/heartbeat-display.ts";
import { extractText } from "../chat/message-extract.ts";
import { reconcileChatRunLifecycle } from "../chat/run-lifecycle.ts";
import { formatConnectError } from "../connect-error.ts";
import { GatewayRequestError, type GatewayBrowserClient, type GatewayHelloOk } from "../gateway.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
const CHAT_HISTORY_REQUEST_LIMIT = 100;
const CHAT_HISTORY_REQUEST_MAX_CHARS = 4_000;
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5_000;
const chatHistoryRequestVersions = new WeakMap<object, number>();

function beginChatHistoryRequest(state: ChatState): number {
  const key = state as object;
  const nextVersion = (chatHistoryRequestVersions.get(key) ?? 0) + 1;
  chatHistoryRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function isLatestChatHistoryRequest(state: ChatState, version: number): boolean {
  return chatHistoryRequestVersions.get(state as object) === version;
}

function shouldApplyChatHistoryResult(
  state: ChatState,
  version: number,
  sessionKey: string,
  agentId?: string | null,
): boolean {
  if (!isLatestChatHistoryRequest(state, version) || state.sessionKey !== sessionKey) {
    return false;
  }
  return !isSelectedGlobalEventSessionKey(sessionKey) || resolveSelectedAgentId(state) === agentId;
}

function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}

/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

function isSyntheticTranscriptRepairToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "toolresult") {
    return false;
  }
  const text = extractText(message);
  return typeof text === "string" && text.trim() === SYNTHETIC_TRANSCRIPT_REPAIR_RESULT;
}

function isTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return true;
  }
  let sawText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text") {
      return false;
    }
    sawText = true;
    if (typeof entry.text !== "string") {
      return false;
    }
  }
  return sawText;
}

function isEmptyUserTextOnlyMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (normalizeLowercaseStringOrEmpty(entry.role) !== "user") {
    return false;
  }
  const mediaPaths = Array.isArray(entry.MediaPaths)
    ? entry.MediaPaths
    : typeof entry.MediaPath === "string"
      ? [entry.MediaPath]
      : [];
  if (mediaPaths.some((value) => typeof value === "string" && value.trim())) {
    return false;
  }
  if (!isTextOnlyContent(entry.content ?? entry.text)) {
    return false;
  }
  return (extractText(message)?.trim() ?? "") === "";
}

function isHeartbeatAckStream(text: string): boolean {
  return stripHeartbeatTokenForDisplay(text).shouldSkip;
}

function shouldHideAssistantChatMessage(message: unknown): boolean {
  return isAssistantSilentReply(message) || isAssistantHeartbeatAckForDisplay(message);
}

function shouldHideHistoryMessage(message: unknown): boolean {
  return (
    shouldHideAssistantChatMessage(message) ||
    isSyntheticTranscriptRepairToolResult(message) ||
    isEmptyUserTextOnlyMessage(message)
  );
}

function hasTranscriptMeta(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { __openclaw?: unknown })["__openclaw"] &&
    typeof (message as { __openclaw?: unknown })["__openclaw"] === "object",
  );
}

function isLocallyOptimisticHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || hasTranscriptMeta(message)) {
    return false;
  }
  const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
  return role === "user" || role === "assistant";
}

function messageDisplaySignature(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
  if (!role) {
    return null;
  }
  const text = extractText(message)?.trim();
  if (text) {
    return `${role}:text:${text}`;
  }
  try {
    const content = JSON.stringify((message as { content?: unknown }).content ?? null);
    return `${role}:content:${content}`;
  } catch {
    return null;
  }
}

export function preserveOptimisticTailMessages(
  historyMessages: unknown[],
  previousMessages: unknown[],
): unknown[] {
  if (previousMessages.length === 0) {
    return historyMessages;
  }
  if (historyMessages.length === 0) {
    const optimisticMessages = previousMessages.filter(
      (message) => isLocallyOptimisticHistoryMessage(message) && !shouldHideHistoryMessage(message),
    );
    return optimisticMessages.length === previousMessages.length
      ? previousMessages
      : historyMessages;
  }
  const historySignatureIndexes = new Map<string, number>();
  historyMessages.forEach((message, index) => {
    const signature = messageDisplaySignature(message);
    if (signature) {
      historySignatureIndexes.set(signature, index);
    }
  });
  let sharedPreviousIndex = -1;
  let sharedHistoryIndex = -1;
  for (let index = previousMessages.length - 1; index >= 0; index--) {
    const signature = messageDisplaySignature(previousMessages[index]);
    const historyIndex = signature ? historySignatureIndexes.get(signature) : undefined;
    if (typeof historyIndex === "number") {
      sharedPreviousIndex = index;
      sharedHistoryIndex = historyIndex;
      break;
    }
  }
  if (sharedPreviousIndex < 0) {
    return historyMessages;
  }
  if (sharedHistoryIndex < historyMessages.length - 1) {
    return historyMessages;
  }
  const optimisticTail: unknown[] = [];
  for (const message of previousMessages.slice(sharedPreviousIndex + 1)) {
    if (!isLocallyOptimisticHistoryMessage(message) || shouldHideHistoryMessage(message)) {
      return historyMessages;
    }
    const signature = messageDisplaySignature(message);
    if (!signature || historySignatureIndexes.has(signature)) {
      return historyMessages;
    }
    optimisticTail.push(message);
  }
  return optimisticTail.length > 0 ? [...historyMessages, ...optimisticTail] : historyMessages;
}

function isRetryableStartupUnavailable(err: unknown, method: string): err is GatewayRequestError {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
    return false;
  }
  const details = err.details;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = (details as { method?: unknown }).method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

function resolveStartupRetryDelayMs(err: GatewayRequestError): number {
  const retryAfterMs =
    typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  currentSessionId?: string | null;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
  resetChatInputHistoryNavigation?: () => void;
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null } | null;
  hello?: GatewayHelloOk | null;
};

export type ChatEventPayload = {
  runId?: string;
  sessionKey: string;
  agentId?: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

function isGlobalSessionKey(sessionKey: string | undefined | null): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  return normalized === "global";
}

function isSelectedGlobalEventSessionKey(sessionKey: string | undefined | null): boolean {
  if (isGlobalSessionKey(sessionKey)) {
    return true;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeLowercaseStringOrEmpty(parsed?.rest) === "main";
}

function resolveSelectedAgentId(state: ChatState): string | undefined {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  const assistantAgentId =
    typeof state.assistantAgentId === "string" && state.assistantAgentId.trim()
      ? state.assistantAgentId
      : undefined;
  const defaultAgentId =
    typeof state.agentsList?.defaultId === "string" && state.agentsList.defaultId.trim()
      ? state.agentsList.defaultId
      : undefined;
  const helloDefaultAgentId =
    typeof snapshot?.sessionDefaults?.defaultAgentId === "string" &&
    snapshot.sessionDefaults.defaultAgentId.trim()
      ? snapshot.sessionDefaults.defaultAgentId
      : undefined;
  const selectedAgentId = assistantAgentId ?? defaultAgentId ?? helloDefaultAgentId;
  return selectedAgentId ? normalizeAgentId(selectedAgentId) : undefined;
}

function resolveDefaultAgentId(state: ChatState): string | undefined {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  const agentId =
    typeof state.agentsList?.defaultId === "string" && state.agentsList.defaultId.trim()
      ? state.agentsList.defaultId
      : typeof snapshot?.sessionDefaults?.defaultAgentId === "string" &&
          snapshot.sessionDefaults.defaultAgentId.trim()
        ? snapshot.sessionDefaults.defaultAgentId
        : undefined;
  return agentId ? normalizeAgentId(agentId) : undefined;
}

function chatEventAgentScopeMatches(state: ChatState, payload: ChatEventPayload): boolean {
  if (
    !isSelectedGlobalEventSessionKey(state.sessionKey) ||
    !isGlobalSessionKey(payload.sessionKey)
  ) {
    return true;
  }
  const payloadAgentId =
    typeof payload.agentId === "string" && payload.agentId.trim()
      ? normalizeAgentId(payload.agentId)
      : undefined;
  const selectedAgentId = resolveSelectedAgentId(state);
  return payloadAgentId
    ? selectedAgentId !== undefined && payloadAgentId === selectedAgentId
    : selectedAgentId === undefined || selectedAgentId === resolveDefaultAgentId(state);
}

function chatEventSessionMatches(state: ChatState, payload: ChatEventPayload): boolean {
  if (areUiSessionKeysEquivalent(payload.sessionKey, state.sessionKey)) {
    return chatEventAgentScopeMatches(state, payload);
  }
  return (
    isGlobalSessionKey(payload.sessionKey) &&
    isSelectedGlobalEventSessionKey(state.sessionKey) &&
    chatEventAgentScopeMatches(state, payload)
  );
}

function maybeResetToolStream(state: ChatState) {
  const toolHost = state as ChatState & Partial<Parameters<typeof resetToolStream>[0]>;
  if (
    toolHost.toolStreamById instanceof Map &&
    Array.isArray(toolHost.toolStreamOrder) &&
    Array.isArray(toolHost.chatToolMessages) &&
    Array.isArray(toolHost.chatStreamSegments)
  ) {
    resetToolStream(toolHost as Parameters<typeof resetToolStream>[0]);
  }
}

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  const sessionKey = state.sessionKey;
  const requestVersion = beginChatHistoryRequest(state);
  const requestAgentId = isSelectedGlobalEventSessionKey(sessionKey)
    ? resolveSelectedAgentId(state)
    : null;
  const startedAt = Date.now();
  const previousMessages = state.chatMessages;
  // Any pending input-history snapshot becomes invalid once we start reloading transcript state.
  state.resetChatInputHistoryNavigation?.();
  state.chatLoading = true;
  state.lastError = null;
  try {
    let res: { messages?: Array<unknown>; sessionId?: string; thinkingLevel?: string };
    for (;;) {
      try {
        res = await state.client.request<{
          messages?: Array<unknown>;
          sessionId?: string;
          thinkingLevel?: string;
        }>("chat.history", {
          sessionKey,
          ...(requestAgentId ? { agentId: requestAgentId } : {}),
          limit: CHAT_HISTORY_REQUEST_LIMIT,
          maxChars: CHAT_HISTORY_REQUEST_MAX_CHARS,
        });
        break;
      } catch (err) {
        if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey, requestAgentId)) {
          return;
        }
        const withinStartupRetryWindow =
          Date.now() - startedAt < STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS;
        if (withinStartupRetryWindow && isRetryableStartupUnavailable(err, "chat.history")) {
          await sleep(resolveStartupRetryDelayMs(err));
          if (!state.client || !state.connected) {
            return;
          }
          continue;
        }
        throw err;
      }
    }
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey, requestAgentId)) {
      return;
    }
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const visibleMessages = messages.filter((message) => !shouldHideHistoryMessage(message));
    state.chatMessages = preserveOptimisticTailMessages(visibleMessages, previousMessages);
    state.currentSessionId =
      typeof res.sessionId === "string" && res.sessionId.trim() ? res.sessionId : null;
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    // Clear all streaming state — history includes tool results and text
    // inline, so keeping streaming artifacts would cause duplicates.
    maybeResetToolStream(state);
    state.chatStream = null;
    state.chatStreamStartedAt = null;
  } catch (err) {
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey, requestAgentId)) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      state.chatMessages = [];
      state.chatThinkingLevel = null;
      state.lastError = formatMissingOperatorReadScopeMessage("existing chat history");
    } else {
      state.lastError = String(err);
    }
  } finally {
    if (isLatestChatHistoryRequest(state, requestVersion)) {
      state.chatLoading = false;
    }
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

function isInlineDataUrl(value: string): boolean {
  return /^\s*data:/iu.test(value);
}

function formatInlineImageAttachmentPlaceholder(attachment: ChatAttachment): string {
  const label = attachment.fileName?.trim();
  return label ? `Attached image: ${label}` : "Attached image";
}

function buildApiAttachments(attachments?: ChatAttachment[]) {
  const hasAttachments = attachments && attachments.length > 0;
  return hasAttachments
    ? attachments
        .map((att) => {
          const dataUrl = getChatAttachmentDataUrl(att);
          const parsed = dataUrl ? dataUrlToBase64(dataUrl) : null;
          if (!parsed) {
            return null;
          }
          return {
            type: parsed.mimeType.startsWith("image/") ? "image" : "file",
            mimeType: parsed.mimeType,
            fileName: att.fileName,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;
}

export type ChatSendAckStatus = "started" | "in_flight" | "ok";

export type ChatSendAck = {
  runId: string;
  status: ChatSendAckStatus;
};

function normalizeChatSendAck(payload: unknown, fallbackRunId: string): ChatSendAck {
  if (!payload || typeof payload !== "object") {
    return { runId: fallbackRunId, status: "started" };
  }
  const record = payload as Record<string, unknown>;
  const runId =
    typeof record.runId === "string" && record.runId.trim() ? record.runId.trim() : fallbackRunId;
  const status = record.status;
  return {
    runId,
    status: status === "in_flight" || status === "ok" ? status : "started",
  };
}

export async function requestChatSend(
  state: ChatState,
  params: {
    message: string;
    attachments?: ChatAttachment[];
    runId: string;
    sessionKey?: string;
    agentId?: string;
  },
): Promise<ChatSendAck> {
  const sessionKey = params.sessionKey ?? state.sessionKey;
  const selectedAgentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveSelectedAgentId(state);
  const currentSessionId = state.currentSessionId;
  const canReuseCurrentSessionId =
    sessionKey === state.sessionKey &&
    (!isGlobalSessionKey(sessionKey) ||
      (selectedAgentId !== undefined && selectedAgentId === resolveSelectedAgentId(state)));
  const sessionId =
    canReuseCurrentSessionId && typeof currentSessionId === "string" && currentSessionId.trim()
      ? currentSessionId.trim()
      : undefined;
  const payload = await state.client!.request("chat.send", {
    sessionKey,
    ...(isGlobalSessionKey(sessionKey) && selectedAgentId ? { agentId: selectedAgentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    message: params.message,
    deliver: false,
    idempotencyKey: params.runId,
    attachments: buildApiAttachments(params.attachments),
  });
  return normalizeChatSendAck(payload, params.runId);
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : normalizeLowercaseStringOrEmpty(roleValue);
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

function buildErrorAssistantMessage(payload: ChatEventPayload): Record<string, unknown> | null {
  const normalized = normalizeFinalAssistantMessage(payload.message);
  if (normalized && !shouldHideAssistantChatMessage(normalized)) {
    return normalized;
  }
  const error = payload.errorMessage?.trim();
  if (!error) {
    return null;
  }
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: error.startsWith("⚠️") || error.startsWith("Error:") ? error : `Error: ${error}`,
      },
    ],
    timestamp: Date.now(),
  };
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  if (state.chatSending) {
    return state.chatRunId;
  }

  const now = Date.now();
  appendUserChatMessage(state, msg, attachments, now);

  state.chatSending = true;
  state.lastError = null;
  reconcileChatRunLifecycle(state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
    clearRunStatus: true,
  });
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;

  try {
    const ack = await requestChatSend(state, { message: msg, attachments, runId });
    if (ack.status === "ok") {
      state.chatRunId = null;
      state.chatStream = null;
      state.chatStreamStartedAt = null;
    } else {
      state.chatRunId = ack.runId;
    }
    return ack.status === "ok" ? ack.runId : runId;
  } catch (err) {
    const error = formatConnectError(err);
    reconcileChatRunLifecycle(state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      outcome: "interrupted",
      sessionStatus: "failed",
      runId,
      sessionKey: state.sessionKey,
      clearLocalRun: true,
      clearChatStream: true,
    });
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export function appendUserChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  timestamp = Date.now(),
) {
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  const contentBlocks: Array<{
    type: string;
    text?: string;
    url?: string;
    source?: unknown;
    attachment?: {
      url: string;
      kind: "audio" | "document";
      label: string;
      mimeType?: string;
    };
  }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  if (hasAttachments) {
    for (const att of attachments) {
      const previewUrl = getChatAttachmentPreviewUrl(att);
      if (!previewUrl) {
        continue;
      }
      if (att.mimeType.startsWith("image/")) {
        if (isInlineDataUrl(previewUrl)) {
          contentBlocks.push({ type: "text", text: formatInlineImageAttachmentPlaceholder(att) });
          continue;
        }
        contentBlocks.push({
          type: "image",
          url: previewUrl,
          source: { type: "url", url: previewUrl },
        });
        continue;
      }
      contentBlocks.push({
        type: "attachment",
        attachment: {
          url: previewUrl,
          kind: att.mimeType.startsWith("audio/") ? "audio" : "document",
          label: att.fileName?.trim() || "Attached file",
          mimeType: att.mimeType,
        },
      });
    }
  }
  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp,
    },
  ];
}

async function sendChatMessageWithGeneratedRunId(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  state.lastError = null;
  const runId = generateUUID();
  try {
    const ack = await requestChatSend(state, { message: msg, attachments, runId });
    return ack.runId;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return null;
  }
}

export async function sendDetachedChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  return sendChatMessageWithGeneratedRunId(state, message, attachments);
}

export async function sendSteerChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  return sendChatMessageWithGeneratedRunId(state, message, attachments);
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId
        ? {
            sessionKey: state.sessionKey,
            ...(() => {
              const agentId = resolveSelectedAgentId(state);
              return isGlobalSessionKey(state.sessionKey) && agentId ? { agentId } : {};
            })(),
            runId,
          }
        : {
            sessionKey: state.sessionKey,
            ...(() => {
              const agentId = resolveSelectedAgentId(state);
              return isGlobalSessionKey(state.sessionKey) && agentId ? { agentId } : {};
            })(),
          },
    );
    return true;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  const hadActiveRunBeforeEvent = state.chatRunId !== null;
  const sessionMatches = chatEventSessionMatches(state, payload);
  const activeRunMatches =
    state.chatRunId !== null &&
    typeof payload.runId === "string" &&
    payload.runId === state.chatRunId;
  if (!sessionMatches && !activeRunMatches) {
    return null;
  }
  if (!state.chatRunId && sessionMatches && typeof payload.runId === "string") {
    state.chatRunId = payload.runId;
    state.chatStreamStartedAt ??= Date.now();
  }

  // Terminal events for the active client run carry runId; missing-runId events are unowned.
  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  const terminalRunId = payload.runId ?? state.chatRunId;
  const reconcileTerminalRun = (
    outcome: "done" | "interrupted",
    sessionStatus: "done" | "failed" | "killed",
  ) =>
    reconcileChatRunLifecycle(state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      outcome,
      sessionStatus,
      runId: terminalRunId,
      sessionKey: state.sessionKey,
      sessionKeys: sessionMatches ? [state.sessionKey, payload.sessionKey] : [],
      clearLocalRun: true,
      clearChatStream: true,
    });

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (
      typeof next === "string" &&
      !isSilentReplyStream(next) &&
      !isAssistantHeartbeatAckForDisplay(payload.message)
    ) {
      state.chatStream = next;
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
      state.chatMessages = [...state.chatMessages, finalMessage];
    } else if (
      state.chatStream?.trim() &&
      !isSilentReplyStream(state.chatStream) &&
      !isHeartbeatAckStream(state.chatStream)
    ) {
      state.chatMessages = [
        ...state.chatMessages,
        {
          role: "assistant",
          content: [{ type: "text", text: state.chatStream }],
          timestamp: Date.now(),
        },
      ];
    }
    reconcileTerminalRun("done", "done");
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !shouldHideAssistantChatMessage(normalizedMessage)) {
      state.chatMessages = [...state.chatMessages, normalizedMessage];
    } else {
      const streamedText = state.chatStream ?? "";
      if (
        streamedText.trim() &&
        !isSilentReplyStream(streamedText) &&
        !isHeartbeatAckStream(streamedText)
      ) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    reconcileTerminalRun("interrupted", "killed");
  } else if (payload.state === "error") {
    const errorMessage = hadActiveRunBeforeEvent ? buildErrorAssistantMessage(payload) : null;
    if (errorMessage) {
      state.chatMessages = [...state.chatMessages, errorMessage];
    }
    reconcileTerminalRun("interrupted", "failed");
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
