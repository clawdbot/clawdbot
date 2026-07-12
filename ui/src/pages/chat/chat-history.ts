// Control UI page module owns Chat transcript loading and selected-session message subscription.
import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../api/gateway.ts";

export { GatewayRequestError };
import type {
  AgentsListResult,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../../lib/chat/heartbeat-display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import {
  retirePendingChatSideQuestion,
  type ChatSideResult,
  type ChatSideResultPending,
} from "../../lib/chat/side-result.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  scopedAgentParamsForSession,
  unsubscribeSessionMessages,
  visibleSessionMatches,
  type SessionCapability,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
} from "./performance.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import {
  cacheChatMessages,
  clearChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import {
  clearToolStreamSegments,
  currentLiveToolCallIds,
  hasVisibleStreamParts,
  historyReplacedVisibleStream,
  materializeVisibleStreamState,
  messageTimestampMs,
  maybeResetToolStream,
  persistedCurrentToolStreamIds,
  prunePersistedToolStreamMessages,
  visibleCurrentAssistantStreamTail,
} from "./stream-reconciliation.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
const CHAT_HISTORY_REQUEST_LIMIT = 100;
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5_000;
const chatHistoryRequestVersions = new WeakMap<object, number>();
const selectedSessionMessageSubscriptionGenerations = new WeakMap<object, number>();

type ChatHistoryRequestOwnership = {
  version: number;
  client: GatewayBrowserClient;
  connectionEpoch: number;
  sessionKey: string;
  agentId?: string;
};

function beginChatHistoryRequest(
  state: ChatState,
  client: GatewayBrowserClient,
  connectionEpoch: number,
  sessionKey: string,
  agentId?: string,
): ChatHistoryRequestOwnership {
  const key = state as object;
  const nextVersion = (chatHistoryRequestVersions.get(key) ?? 0) + 1;
  chatHistoryRequestVersions.set(key, nextVersion);
  return {
    version: nextVersion,
    client,
    connectionEpoch,
    sessionKey,
    agentId,
  };
}

function ownsChatHistoryRequest(state: ChatState, ownership: ChatHistoryRequestOwnership): boolean {
  return (
    chatHistoryRequestVersions.get(state as object) === ownership.version &&
    state.client === ownership.client &&
    state.connected &&
    state.connectionEpoch === ownership.connectionEpoch
  );
}

function shouldApplyChatHistoryResult(
  state: ChatState,
  ownership: ChatHistoryRequestOwnership,
): boolean {
  return (
    ownsChatHistoryRequest(state, ownership) &&
    state.sessionKey === ownership.sessionKey &&
    (!isUiSelectedGlobalSessionKey(ownership.sessionKey) ||
      resolveUiSelectedSessionAgentId(state) === ownership.agentId)
  );
}

export function isSilentReplyStream(text: string): boolean {
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

export function isHiddenAssistantStreamText(text: string): boolean {
  return isSilentReplyStream(text) || isHeartbeatAckStream(text);
}

export function shouldHideAssistantChatMessage(message: unknown): boolean {
  return isAssistantSilentReply(message) || isAssistantHeartbeatAckForDisplay(message);
}

function shouldHideHistoryMessage(message: unknown): boolean {
  return (
    shouldHideAssistantChatMessage(message) ||
    isSyntheticTranscriptRepairToolResult(message) ||
    isEmptyUserTextOnlyMessage(message)
  );
}

export function materializeVisibleAssistantStreamMessages(
  messages: unknown[],
  state: ChatState,
  opts: {
    includeCurrent?: boolean;
    requirePersistedTool?: boolean;
    replacementMessages?: unknown[];
  } = {},
): unknown[] {
  return materializeVisibleStreamState(messages, state, {
    ...opts,
    persistCommentary: chatPersistCommentaryEnabled(state),
    isHiddenAssistantMessage: shouldHideAssistantChatMessage,
    isHiddenStreamText: isHiddenAssistantStreamText,
  });
}

function chatPersistCommentaryEnabled(state: ChatState): boolean {
  return state.settings?.chatPersistCommentary === true;
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

function historyHasSameOrNewerDisplayMessage(
  historyMessages: unknown[],
  signature: string,
  message: unknown,
): boolean {
  const timestamp = messageTimestampMs(message);
  if (timestamp == null) {
    return false;
  }
  return historyMessages.some((historyMessage) => {
    if (messageDisplaySignature(historyMessage) !== signature) {
      return false;
    }
    const historyTimestamp = messageTimestampMs(historyMessage);
    return historyTimestamp != null && historyTimestamp >= timestamp;
  });
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

function collectLateOptimisticTailMessages(
  previousMessages: unknown[],
  currentMessages: unknown[],
  historyMessages: unknown[],
): unknown[] {
  if (currentMessages === previousMessages || currentMessages.length <= previousMessages.length) {
    return [];
  }
  if (previousMessages.some((message, index) => currentMessages[index] !== message)) {
    return [];
  }
  const lateTail: unknown[] = [];
  for (const message of currentMessages.slice(previousMessages.length)) {
    if (!isLocallyOptimisticHistoryMessage(message) || shouldHideHistoryMessage(message)) {
      return [];
    }
    const signature = messageDisplaySignature(message);
    if (!signature) {
      return [];
    }
    if (historyHasSameOrNewerDisplayMessage(historyMessages, signature, message)) {
      continue;
    }
    lateTail.push(message);
  }
  return lateTail;
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

function isUnknownGatewayMethodError(err: unknown, method: string): err is GatewayRequestError {
  return (
    err instanceof GatewayRequestError &&
    err.gatewayCode === "INVALID_REQUEST" &&
    err.message.includes(`unknown method: ${method}`)
  );
}

function resolveStartupRetryDelayMs(err: GatewayRequestError): number {
  const retryAfterMs =
    typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  /** Monotonic owner epoch; reconnects can reuse the same client object. */
  connectionEpoch: number;
  sessionKey: string;
  currentSessionId?: string | null;
  reconnectResumeSessionId?: string | null;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatMessagesBySession?: ChatMessageCache;
  chatThinkingLevel: string | null;
  chatVerboseLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
  chatError?: string | null;
  /** Completed side-chat turns (oldest first); follow-ups accumulate here. */
  chatSideChatTurns?: ChatSideResult[];
  chatSideResultPending?: ChatSideResultPending | null;
  chatSideResultTerminalRuns?: Set<string>;
  /** Panel closed via X/Escape; conversation kept until cleared or reset. */
  chatSideChatHidden?: boolean;
  chatReplyTarget?: unknown;
  agentsError?: string | null;
  onAgentsList?: (agentsList: AgentsListResult, client: GatewayBrowserClient) => void;
  resetChatInputHistoryNavigation?: () => void;
  assistantAgentId?: string | null;
  agentsList?: ChatAgentsListSnapshot | null;
  agentsSelectedId?: string | null;
  hello: GatewayHelloOk | null;
  settings?: { chatPersistCommentary?: boolean; gatewayUrl?: string | null };
};

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: AgentsListResult["agents"];
};

type ChatSessionMessageSubscriptionState = ChatState & {
  sessions: Pick<SessionCapability, "subscribeMessages">;
  sessionsResult?: SessionsListResult | null;
  sessionsError?: string | null;
  chatSessionMessageSubscriptionRequestedKey?: string | null;
  chatSessionMessageSubscriptionKey?: string | null;
  chatSessionMessageSubscriptionAgentId?: string | null;
};

export type ChatHistoryResult = {
  messages?: Array<unknown>;
  sessionId?: string;
  thinkingLevel?: string;
  verboseLevel?: string;
  defaults?: GatewaySessionsDefaults;
  sessionInfo?: GatewaySessionRow;
  agentsList?: AgentsListResult;
  metadata?: ChatMetadataResult;
};

export type ChatMetadataResult = CommandsListResult & {
  models?: ModelCatalogEntry[];
};

export type ChatEventPayload = {
  runId?: string;
  sessionKey: string;
  agentId?: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
};

function setChatError(state: ChatState, error: string | null) {
  state.lastError = error;
  state.chatError = error;
}

function chatScopedEventAgentScopeMatches(
  state: ChatState,
  sessionKey: string,
  agentId?: string | null,
): boolean {
  if (!isUiSelectedGlobalSessionKey(state.sessionKey) || !isUiGlobalSessionKey(sessionKey)) {
    return true;
  }
  const payloadAgentId =
    typeof agentId === "string" && agentId.trim() ? normalizeAgentId(agentId) : undefined;
  const selectedAgentId = resolveUiSelectedSessionAgentId(state);
  return payloadAgentId
    ? selectedAgentId !== undefined && payloadAgentId === selectedAgentId
    : selectedAgentId === undefined || selectedAgentId === resolveUiDefaultAgentId(state);
}

export function chatScopedEventSessionMatches(
  state: ChatState,
  sessionKey: string,
  agentId?: string | null,
): boolean {
  if (areUiSessionKeysEquivalent(sessionKey, state.sessionKey)) {
    return chatScopedEventAgentScopeMatches(state, sessionKey, agentId);
  }
  return (
    isUiGlobalSessionKey(sessionKey) &&
    isUiSelectedGlobalSessionKey(state.sessionKey) &&
    chatScopedEventAgentScopeMatches(state, sessionKey, agentId)
  );
}

function normalizeSubscriptionKey(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
}

function resolveSelectedGlobalAliasAgentId(
  state: ChatSessionMessageSubscriptionState,
  key: string | null | undefined,
): string | null {
  const row = state.sessionsResult?.sessions.find((session) => session.key === key);
  return resolveUiGlobalAliasAgentId(state, key, {
    rowKind: row?.kind,
    requireGlobalRowForMainAlias: true,
  });
}

function resolveSelectedGlobalAgentId(state: ChatSessionMessageSubscriptionState): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveUiSelectedGlobalAgentId(state);
}

function resolveSelectedSessionMessageSubscriptionAgentId(
  state: ChatSessionMessageSubscriptionState,
  key: string,
): string | null {
  if (isUiGlobalSessionKey(key)) {
    return resolveSelectedGlobalAgentId(state);
  }
  return resolveSelectedGlobalAliasAgentId(state, key);
}

function beginSelectedSessionMessageSubscriptionSync(
  state: ChatSessionMessageSubscriptionState,
): number {
  const key = state as object;
  const next = (selectedSessionMessageSubscriptionGenerations.get(key) ?? 0) + 1;
  selectedSessionMessageSubscriptionGenerations.set(key, next);
  return next;
}

function isCurrentSelectedSessionMessageSubscriptionSync(
  state: ChatSessionMessageSubscriptionState,
  params: {
    generation: number;
    client: GatewayBrowserClient;
    requestedKey: string;
    requestedAgentId?: string | null;
  },
): boolean {
  return (
    selectedSessionMessageSubscriptionGenerations.get(state as object) === params.generation &&
    state.client === params.client &&
    state.connected &&
    state.sessionKey.trim() === params.requestedKey &&
    resolveSelectedSessionMessageSubscriptionAgentId(state, params.requestedKey) ===
      (params.requestedAgentId ?? null)
  );
}

async function unsubscribeSelectedSessionMessageBestEffort(
  client: GatewayBrowserClient,
  key: string,
  agentId?: string | null,
): Promise<void> {
  try {
    await unsubscribeSessionMessages(client, {
      key,
      agentId: isUiGlobalSessionKey(key) ? agentId : null,
    });
  } catch {
    // Cleanup is best effort when a stale subscription completion loses ownership.
  }
}

export async function syncSelectedSessionMessageSubscription(
  state: ChatSessionMessageSubscriptionState,
  opts?: { force?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const nextKey = state.sessionKey.trim();
  if (!nextKey) {
    return;
  }
  const generation = beginSelectedSessionMessageSubscriptionSync(state);
  const previousRequestedKey = normalizeSubscriptionKey(
    state.chatSessionMessageSubscriptionRequestedKey,
  );
  const previousCanonicalKey = normalizeSubscriptionKey(state.chatSessionMessageSubscriptionKey);
  const previousSelectedKey = previousRequestedKey ?? previousCanonicalKey;
  const nextSubscriptionAgentId = resolveSelectedSessionMessageSubscriptionAgentId(state, nextKey);
  const selectedAgentChanged =
    nextSubscriptionAgentId !== null &&
    previousSelectedKey === nextKey &&
    (state.chatSessionMessageSubscriptionAgentId ?? null) !== nextSubscriptionAgentId;
  const selectedKeyChanged = previousSelectedKey !== null && previousSelectedKey !== nextKey;
  const shouldUnsubscribePrevious =
    previousCanonicalKey !== null && (selectedKeyChanged || selectedAgentChanged);
  const shouldSubscribe =
    opts?.force === true ||
    selectedKeyChanged ||
    selectedAgentChanged ||
    previousCanonicalKey === null ||
    previousRequestedKey === null;
  if (!shouldUnsubscribePrevious && !shouldSubscribe) {
    return;
  }
  const isCurrent = () =>
    isCurrentSelectedSessionMessageSubscriptionSync(state, {
      generation,
      client,
      requestedKey: nextKey,
      requestedAgentId: nextSubscriptionAgentId,
    });
  try {
    if (shouldUnsubscribePrevious && previousCanonicalKey) {
      await unsubscribeSessionMessages(client, {
        key: previousCanonicalKey,
        agentId:
          isUiGlobalSessionKey(previousCanonicalKey) && state.chatSessionMessageSubscriptionAgentId
            ? state.chatSessionMessageSubscriptionAgentId
            : null,
      });
      if (isCurrent()) {
        state.chatSessionMessageSubscriptionKey = null;
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscriptionAgentId = null;
      }
    }
    if (!shouldSubscribe || !isCurrent()) {
      return;
    }
    const subscribed = await state.sessions.subscribeMessages(nextKey, {
      agentId: nextSubscriptionAgentId ?? undefined,
    });
    if (!isCurrent()) {
      const staleKeyChanged =
        normalizeSubscriptionKey(state.chatSessionMessageSubscriptionKey) !== subscribed.key;
      const staleAgentChanged =
        isUiGlobalSessionKey(subscribed.key) &&
        (state.chatSessionMessageSubscriptionAgentId ?? null) !== subscribed.agentId;
      if (staleKeyChanged || staleAgentChanged) {
        await unsubscribeSelectedSessionMessageBestEffort(
          client,
          subscribed.key,
          subscribed.agentId,
        );
      }
      return;
    }
    state.chatSessionMessageSubscriptionRequestedKey = nextKey;
    state.chatSessionMessageSubscriptionKey = subscribed.key;
    state.chatSessionMessageSubscriptionAgentId = subscribed.agentId;
  } catch (err) {
    if (isCurrent()) {
      state.sessionsError = String(err);
    }
  }
}

type InFlightChatHistoryRequest = {
  client: NonNullable<ChatState["client"]>;
  connectionEpoch: number;
  key: string;
  messages: unknown[];
  promise: Promise<ChatHistoryResult | undefined>;
};

type LoadChatHistoryOptions = {
  startup?: boolean;
};

const inFlightChatHistoryRequests = new WeakMap<ChatState, InFlightChatHistoryRequest>();

function recordChatHistoryTiming(
  state: ChatState,
  phase: "start" | "applied" | "stream-reset" | "stale" | "error",
  startedAtMs: number,
  extra: Record<string, unknown> = {},
) {
  recordControlUiPerformanceEvent(
    state as ChatState & Parameters<typeof recordControlUiPerformanceEvent>[0],
    "control-ui.chat.history",
    {
      phase,
      durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
      sessionKey: state.sessionKey,
      activeRunId: state.chatRunId,
      ...extra,
    },
    { console: false, maxBufferedEventsForType: 30 },
  );
}

function replaceCachedChatMessages(
  state: ChatState,
  sessionKey: string,
  messages: unknown[],
  agentId?: string,
) {
  if (!state.chatMessagesBySession) {
    return;
  }
  cacheChatMessages(state.chatMessagesBySession, state, { sessionKey, agentId }, messages);
}

type ClearChatHistoryState = ChatState &
  Parameters<typeof reconcileChatRunLifecycle>[0] &
  Parameters<typeof scheduleChatScroll>[0] & {
    sessions: Pick<SessionCapability, "reset">;
  };

export type ClearChatHistoryResult = "completed" | "failed" | "uncertain";

function hasAbortableChatSessionRun(state: ClearChatHistoryState): boolean {
  if (state.chatRunId) {
    return true;
  }
  return Boolean(
    state.sessionsResult?.sessions.some(
      (session) => session.key === state.sessionKey && isSessionRunActive(session),
    ),
  );
}

function clearCachedChatMessagesForSession(
  state: ClearChatHistoryState,
  sessionKey: string,
  agentId?: string,
) {
  if (!state.chatMessagesBySession) {
    return;
  }
  clearChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey, agentId });
}

export async function clearChatHistory(
  state: ClearChatHistoryState,
): Promise<ClearChatHistoryResult> {
  if (!state.client || !state.connected) {
    return "failed";
  }
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const sessionKey = state.sessionKey;
  const agentParams = scopedAgentParamsForSession(state, sessionKey);
  const runId = state.chatRunId;
  const hadActiveRun = hasAbortableChatSessionRun(state);
  try {
    const resetResult = await state.sessions.reset(sessionKey, agentParams);
    if (resetResult === "not-started") {
      setChatError(state, "Gateway was unavailable before chat history could be cleared.");
      scheduleChatScroll(state);
      return "failed";
    }
    // Reset is destructive once issued. Drop the captured session's cached
    // transcript before classifying the result so an ambiguous response cannot
    // expose stale pre-reset history after a route switch.
    clearCachedChatMessagesForSession(state, sessionKey, agentParams.agentId);
    if (
      resetResult === "uncertain" ||
      state.client !== client ||
      state.connectionEpoch !== connectionEpoch ||
      !state.connected
    ) {
      let historyRefreshed = false;
      if (
        state.client &&
        state.connected &&
        visibleSessionMatches(state, sessionKey, agentParams.agentId)
      ) {
        // Do not let a failed refresh keep rendering the transcript that the
        // ambiguous reset may already have destroyed. Clearing first also
        // prevents history loading from preserving a pre-reset optimistic tail.
        state.chatMessages = [];
        historyRefreshed = Boolean(await loadChatHistory(state));
      }
      setChatError(
        state,
        historyRefreshed
          ? "The clear request may have completed. Current history was refreshed; review it before resuming queued messages."
          : "The clear request may have completed. Cached history was cleared, but current history could not be refreshed; reconnect and review it before resuming queued messages.",
      );
      scheduleChatScroll(state);
      // sessions.reset is not idempotent. Treat an uncertain completion as
      // consumed so a durable /clear row cannot erase newer history on retry.
      return "uncertain";
    }
  } catch (err) {
    setChatError(state, String(err));
    scheduleChatScroll(state);
    return "failed";
  }
  if (!visibleSessionMatches(state, sessionKey, agentParams.agentId)) {
    return "completed";
  }
  state.chatMessages = [];
  state.chatSideChatTurns = [];
  state.chatSideChatHidden = false;
  state.chatReplyTarget = null;
  reconcileChatRunLifecycle(state, {
    outcome: hadActiveRun ? "interrupted" : undefined,
    sessionStatus: "killed",
    runId,
    sessionKey,
    clearLocalRun: true,
    clearChatStream: true,
    clearToolStream: true,
    clearSideResultTerminalRuns: true,
    clearRunStatus: !hadActiveRun,
  });
  // After the suppression-set wipe above: retire (not just drop) a pending
  // BTW run so its late resultless terminal event cannot re-enter the freshly
  // cleared transcript.
  retirePendingChatSideQuestion(state);
  await loadChatHistory(state);
  scheduleChatScroll(state);
  return "completed";
}

export async function loadChatHistory(
  state: ChatState,
  opts: LoadChatHistoryOptions = {},
): Promise<ChatHistoryResult | undefined> {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const sessionKey = state.sessionKey;
  const requestAgentId = isUiSelectedGlobalSessionKey(sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const startupAdvertised = isGatewayMethodAdvertised(state, "chat.startup");
  const method =
    opts.startup === true && startupAdvertised !== false ? "chat.startup" : "chat.history";
  const requestKey = `${method}\0${sessionKey}\0${requestAgentId ?? ""}`;
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const inFlight = inFlightChatHistoryRequests.get(state);
  if (
    inFlight?.key === requestKey &&
    inFlight.client === client &&
    inFlight.connectionEpoch === connectionEpoch &&
    inFlight.messages === state.chatMessages
  ) {
    return inFlight.promise;
  }
  const promise = loadChatHistoryUncached(
    state,
    client,
    connectionEpoch,
    sessionKey,
    requestAgentId,
    method,
  ).finally(() => {
    if (inFlightChatHistoryRequests.get(state)?.promise === promise) {
      inFlightChatHistoryRequests.delete(state);
    }
  });
  inFlightChatHistoryRequests.set(state, {
    client,
    connectionEpoch,
    key: requestKey,
    messages: state.chatMessages,
    promise,
  });
  return promise;
}

export function applyChatAgentsList(
  state: ChatState,
  agentsList: AgentsListResult | undefined,
  client: GatewayBrowserClient,
) {
  if (!agentsList || state.client !== client || !state.connected) {
    return;
  }
  state.agentsList = agentsList;
  state.agentsError = null;
  state.onAgentsList?.(agentsList, client);
  const selectedId =
    typeof state.agentsSelectedId === "string" && state.agentsSelectedId.trim()
      ? normalizeAgentId(state.agentsSelectedId)
      : undefined;
  if (selectedId && agentsList.agents.some((entry) => normalizeAgentId(entry.id) === selectedId)) {
    return;
  }
  state.agentsSelectedId =
    typeof agentsList.defaultId === "string" && agentsList.defaultId.trim()
      ? agentsList.defaultId
      : (agentsList.agents[0]?.id ?? null);
}

async function loadChatHistoryUncached(
  state: ChatState,
  client: NonNullable<ChatState["client"]>,
  connectionEpoch: number,
  sessionKey: string,
  requestAgentId: string | undefined,
  method: "chat.history" | "chat.startup",
): Promise<ChatHistoryResult | undefined> {
  const ownership = beginChatHistoryRequest(
    state,
    client,
    connectionEpoch,
    sessionKey,
    requestAgentId,
  );
  const startedAt = Date.now();
  const startedAtMs = controlUiNowMs();
  const previousMessages = state.chatMessages;
  const previousRunId = state.chatRunId;
  recordChatHistoryTiming(state, "start", startedAtMs, {
    requestSessionKey: sessionKey,
    requestAgentId,
    method,
    previousRunId,
  });
  // Any pending input-history snapshot becomes invalid once we start reloading transcript state.
  state.resetChatInputHistoryNavigation?.();
  state.chatLoading = true;
  setChatError(state, null);
  try {
    let res: ChatHistoryResult;
    for (;;) {
      try {
        res = await client.request<ChatHistoryResult>(method, {
          sessionKey,
          ...(requestAgentId ? { agentId: requestAgentId } : {}),
          limit: CHAT_HISTORY_REQUEST_LIMIT,
        });
        break;
      } catch (err) {
        if (!shouldApplyChatHistoryResult(state, ownership)) {
          recordChatHistoryTiming(state, "stale", startedAtMs, {
            requestSessionKey: sessionKey,
            requestAgentId,
            previousRunId,
            reason: "request-version",
          });
          return undefined;
        }
        const withinStartupRetryWindow =
          Date.now() - startedAt < STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS;
        if (method === "chat.startup" && isUnknownGatewayMethodError(err, method)) {
          res = await client.request<ChatHistoryResult>("chat.history", {
            sessionKey,
            ...(requestAgentId ? { agentId: requestAgentId } : {}),
            limit: CHAT_HISTORY_REQUEST_LIMIT,
          });
          break;
        }
        if (withinStartupRetryWindow && isRetryableStartupUnavailable(err, method)) {
          await sleep(resolveStartupRetryDelayMs(err));
          if (!shouldApplyChatHistoryResult(state, ownership)) {
            return undefined;
          }
          continue;
        }
        throw err;
      }
    }
    if (!shouldApplyChatHistoryResult(state, ownership)) {
      recordChatHistoryTiming(state, "stale", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        reason: "apply-version",
      });
      return undefined;
    }
    const messages = Array.isArray(res.messages) ? res.messages : [];
    applyChatAgentsList(state, res.agentsList, client);
    const visibleMessages = messages.filter((message) => !shouldHideHistoryMessage(message));
    const lateOptimisticTail = collectLateOptimisticTailMessages(
      previousMessages,
      state.chatMessages,
      visibleMessages,
    );
    state.chatMessages = preserveOptimisticTailMessages(visibleMessages, previousMessages);
    if (lateOptimisticTail.length > 0) {
      state.chatMessages = [...state.chatMessages, ...lateOptimisticTail];
    }
    replaceCachedChatMessages(state, sessionKey, state.chatMessages, requestAgentId);
    state.currentSessionId =
      typeof res.sessionInfo?.sessionId === "string" && res.sessionInfo.sessionId.trim()
        ? res.sessionInfo.sessionId
        : typeof res.sessionId === "string" && res.sessionId.trim()
          ? res.sessionId
          : null;
    if (
      state.reconnectResumeSessionId &&
      state.reconnectResumeSessionId !== state.currentSessionId
    ) {
      state.reconnectResumeSessionId = null;
    }
    state.chatThinkingLevel = res.sessionInfo?.thinkingLevel ?? res.thinkingLevel ?? null;
    state.chatVerboseLevel = res.verboseLevel ?? null;
    const resetStream = !state.chatRunId || state.chatRunId === previousRunId;
    if (resetStream) {
      const streamReconciliation = {
        persistCommentary: chatPersistCommentaryEnabled(state),
        isHiddenAssistantMessage: shouldHideAssistantChatMessage,
        isHiddenStreamText: isHiddenAssistantStreamText,
      };
      const hasVisibleStream = hasVisibleStreamParts(state, streamReconciliation);
      const historyReplacedStream = historyReplacedVisibleStream(
        state.chatMessages,
        state,
        streamReconciliation,
      );
      const liveToolIds = currentLiveToolCallIds(state);
      const persistedToolStreamIds = persistedCurrentToolStreamIds(state.chatMessages, state);
      const historyReplacedToolStream =
        liveToolIds.length > 0 && liveToolIds.every((id) => persistedToolStreamIds.has(id));
      const historyReplacedSomeToolStream = persistedToolStreamIds.size > 0;
      const liveToolStreamReplaced = liveToolIds.length === 0 || historyReplacedToolStream;
      if (!hasVisibleStream || historyReplacedStream) {
        if (liveToolStreamReplaced) {
          // Clear all streaming state — history includes tool results and text
          // inline, so keeping streaming artifacts would cause duplicates.
          maybeResetToolStream(state);
        } else {
          prunePersistedToolStreamMessages(state, persistedToolStreamIds);
          clearToolStreamSegments(state);
        }
        state.chatStream = null;
        state.chatStreamStartedAt = null;
        recordChatHistoryTiming(state, "stream-reset", startedAtMs, {
          requestSessionKey: sessionKey,
          requestAgentId,
          previousRunId,
          messageCount: messages.length,
          visibleMessageCount: visibleMessages.length,
        });
      } else if (!state.chatRunId) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state);
        maybeResetToolStream(state);
        state.chatStream = null;
        state.chatStreamStartedAt = null;
      } else if (historyReplacedToolStream) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
          includeCurrent: false,
        });
        state.chatStream = visibleCurrentAssistantStreamTail(
          state,
          streamReconciliation.isHiddenStreamText,
        );
        if (state.chatStream === null) {
          state.chatStreamStartedAt = null;
        }
        maybeResetToolStream(state);
      } else if (historyReplacedSomeToolStream) {
        const visibleCurrentTail = visibleCurrentAssistantStreamTail(
          state,
          streamReconciliation.isHiddenStreamText,
        );
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
          includeCurrent: false,
          requirePersistedTool: true,
        });
        state.chatStream = visibleCurrentTail;
        if (state.chatStream === null) {
          state.chatStreamStartedAt = null;
        }
        prunePersistedToolStreamMessages(state, persistedToolStreamIds);
      }
    }
    recordChatHistoryTiming(state, "applied", startedAtMs, {
      requestSessionKey: sessionKey,
      requestAgentId,
      previousRunId,
      messageCount: messages.length,
      visibleMessageCount: visibleMessages.length,
      resetStream,
    });
    return res;
  } catch (err) {
    if (!shouldApplyChatHistoryResult(state, ownership)) {
      recordChatHistoryTiming(state, "stale", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        reason: "error-version",
      });
      return undefined;
    }
    recordChatHistoryTiming(state, "error", startedAtMs, {
      requestSessionKey: sessionKey,
      requestAgentId,
      previousRunId,
    });
    if (isMissingOperatorReadScopeError(err)) {
      state.chatMessages = [];
      state.chatThinkingLevel = null;
      state.chatVerboseLevel = null;
      setChatError(state, formatMissingOperatorReadScopeMessage("existing chat history"));
    } else {
      setChatError(state, String(err));
    }
  } finally {
    if (ownsChatHistoryRequest(state, ownership)) {
      state.chatLoading = false;
    }
  }
  return undefined;
}
