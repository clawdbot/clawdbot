// Control UI page module owns Chat transcript loading and selected-session message subscription.
import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  ModelCatalogEntry,
  SessionBranch,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationInitialUserMessageHandoff } from "../../app/context.ts";
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
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import {
  isRetryableStartupUnavailable,
  isUnknownGatewayMethodError,
  resolveStartupRetryDelayMs,
  sleep,
} from "./chat-history-retry.ts";
import { persistChatComposerState } from "./composer-persistence.ts";
import {
  isLocallyOptimisticHistoryMessage,
  messageDisplaySignature,
  preserveOptimisticTailMessages,
  readTranscriptSequence,
} from "./history-merge.ts";
import { reconcileInitialUserMessageHandoff } from "./initial-turn-handoff.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
} from "./performance.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import {
  cacheChatSessionSnapshot,
  clearChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { retireHistoryProvenSteeredChips } from "./steer-lifecycle.ts";
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
import { reconcileAuthoritativeTerminalHistory } from "./terminal-message-identity.ts";
import { normalizePlanSnapshot, type PlanStatus } from "./tool-stream.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
const CHAT_HISTORY_REQUEST_LIMIT = 100;
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const chatHistoryRequestVersions = new WeakMap<object, number>();
const chatBranchRequestVersions = new WeakMap<object, number>();
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
    persistCommentary?: boolean;
  } = {},
): unknown[] {
  return materializeVisibleStreamState(messages, state, {
    ...opts,
    persistCommentary: opts.persistCommentary ?? chatPersistCommentaryEnabled(state),
    isHiddenAssistantMessage: shouldHideAssistantChatMessage,
    isHiddenStreamText: isHiddenAssistantStreamText,
  });
}

function chatPersistCommentaryEnabled(state: ChatState): boolean {
  return state.settings?.chatPersistCommentary !== false;
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

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  initialUserMessage?: ApplicationInitialUserMessageHandoff;
  /** Monotonic owner epoch; reconnects can reuse the same client object. */
  connectionEpoch: number;
  sessionKey: string;
  currentSessionId?: string | null;
  reconnectResumeSessionId?: string | null;
  chatLoading: boolean;
  chatHistoryPagination?: ChatHistoryPagination;
  chatMessages: unknown[];
  chatMessagesBySession?: ChatMessageCache;
  chatThinkingLevel: string | null;
  chatVerboseLevel: string | null;
  /** Pane-owned explicit session queue override from the latest history response. */
  chatQueueModeOverride?: GatewaySessionRow["queueMode"];
  /** Pane-owned effective queue mode from this session's latest history response. */
  chatEffectiveQueueMode?: GatewaySessionRow["effectiveQueueMode"];
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  planStatus?: PlanStatus | null;
  lastError: string | null;
  chatError?: string | null;
  chatRunError?: { summary: string } | null;
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
  sessions?: Partial<SessionCapability>;
  chatBranches?: SessionBranch[];
  chatBranchesSessionKey?: string | null;
  chatBranchesConnectionEpoch?: number | null;
  chatBranchesLoading?: boolean;
  requestUpdate?: () => void;
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
  offset?: number;
  nextOffset?: number;
  hasMore?: boolean;
  totalMessages?: number;
  completeSnapshot?: boolean;
  sessionId?: string;
  thinkingLevel?: string;
  verboseLevel?: string;
  defaults?: GatewaySessionsDefaults;
  sessionInfo?: GatewaySessionRow;
  agentsList?: AgentsListResult;
  metadata?: ChatMetadataResult;
  inFlightRun?: {
    runId: string;
    text?: string;
    plan?: {
      steps: Array<PlanStatus["steps"][number] | string>;
      explanation?: string;
    };
  };
};

function reconcileHistoryPlanStatus(params: {
  canAdoptRunSnapshot: boolean;
  inFlightRun: ChatHistoryResult["inFlightRun"];
  retainedPlan: PlanStatus | null;
  sessionInfo: GatewaySessionRow | undefined;
}): PlanStatus | null {
  if (!params.canAdoptRunSnapshot) {
    return params.retainedPlan;
  }
  const run = params.inFlightRun;
  const runId = run?.runId?.trim();
  if (run && runId) {
    if (Object.hasOwn(run, "plan")) {
      return run.plan ? normalizePlanSnapshot(run.plan, runId) : null;
    }
    return params.retainedPlan?.runId === runId ? params.retainedPlan : null;
  }
  const retainedRunId = params.retainedPlan?.runId;
  if (!retainedRunId) {
    return params.retainedPlan;
  }
  const activeRunIds = params.sessionInfo?.activeRunIds;
  const confirmsTerminal =
    params.sessionInfo?.hasActiveRun === false ||
    (Array.isArray(activeRunIds) && !activeRunIds.includes(retainedRunId));
  return confirmsTerminal ? null : params.retainedPlan;
}

export function resolveChatHistoryPagination(
  result: ChatHistoryResult | undefined,
): ChatHistoryPagination {
  const totalMessages = result?.totalMessages;
  const validTotal =
    typeof totalMessages === "number" && Number.isSafeInteger(totalMessages) && totalMessages >= 0
      ? totalMessages
      : undefined;
  const nextOffset = result?.nextOffset;
  if (
    result?.hasMore === true &&
    typeof nextOffset === "number" &&
    Number.isSafeInteger(nextOffset) &&
    nextOffset > 0
  ) {
    return {
      hasMore: true,
      nextOffset,
      ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    };
  }
  return {
    hasMore: false,
    ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    ...(result?.completeSnapshot === true ? { completeSnapshot: true as const } : {}),
  };
}

function resolveChatHistorySessionId(result: ChatHistoryResult): string | null {
  if (typeof result.sessionInfo?.sessionId === "string" && result.sessionInfo.sessionId.trim()) {
    return result.sessionInfo.sessionId.trim();
  }
  return typeof result.sessionId === "string" && result.sessionId.trim()
    ? result.sessionId.trim()
    : null;
}

function retainedRawHistoryStart(pagination: ChatHistoryPagination | undefined): number | null {
  const totalMessages = pagination?.totalMessages;
  if (
    typeof totalMessages !== "number" ||
    !Number.isSafeInteger(totalMessages) ||
    totalMessages < 0
  ) {
    return null;
  }
  const retainedDepth = pagination?.hasMore ? pagination.nextOffset : totalMessages;
  const start = totalMessages - retainedDepth + 1;
  return Number.isSafeInteger(start) && start > 0 ? start : null;
}

function reconcileLoadedHistoryTail(options: {
  nextMessages: unknown[];
  nextPagination: ChatHistoryPagination;
  nextSessionId: string | null;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination | undefined;
  previousSessionId: string | null;
}): { messages: unknown[]; pagination: ChatHistoryPagination } | null {
  if (
    !options.previousSessionId ||
    options.previousSessionId !== options.nextSessionId ||
    options.previousMessages.length === 0
  ) {
    return null;
  }
  const previousTotal = options.previousPagination?.totalMessages;
  const nextTotal = options.nextPagination.totalMessages;
  const previousStart = retainedRawHistoryStart(options.previousPagination);
  const nextStart = retainedRawHistoryStart(options.nextPagination);
  if (
    typeof previousTotal !== "number" ||
    typeof nextTotal !== "number" ||
    previousStart === null ||
    nextStart === null ||
    nextTotal < previousTotal ||
    nextStart > previousTotal + 1 ||
    nextStart <= previousStart
  ) {
    return null;
  }
  const prefix = options.previousMessages.filter((message) => {
    const seq = readTranscriptSequence(message);
    return seq !== null && seq < nextStart;
  });
  if (prefix.length === 0) {
    return null;
  }
  const retainedDepth = nextTotal - previousStart + 1;
  return {
    messages: [...prefix, ...options.nextMessages],
    pagination:
      previousStart > 1
        ? { hasMore: true, nextOffset: retainedDepth, totalMessages: nextTotal }
        : { hasMore: false, totalMessages: nextTotal },
  };
}

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
  stopReason?: string;
  yielded?: true;
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

function replaceCachedChatMessages(state: ChatState, sessionKey: string, agentId?: string) {
  if (!state.chatMessagesBySession) {
    return;
  }
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    {
      messages: state.chatMessages,
      pagination: state.chatHistoryPagination ?? { hasMore: false },
      sessionId: state.currentSessionId ?? null,
    },
  );
}

type ClearChatHistoryState = ChatState &
  Parameters<typeof reconcileChatRunLifecycle>[0] &
  Parameters<typeof scheduleChatScroll>[0] & {
    sessions: Pick<SessionCapability, "reset">;
  };

type ClearChatHistoryResult = "completed" | "failed" | "uncertain";

type RewindChatHistoryState = ChatState &
  Parameters<typeof scheduleChatScroll>[0] & {
    handleChatDraftChange: (next: string) => void;
    sessions: Pick<SessionCapability, "rewind">;
  };

type SwitchChatHistoryBranchState = ChatState &
  Parameters<typeof scheduleChatScroll>[0] & {
    sessions: Pick<SessionCapability, "listBranches" | "switchBranch">;
  };

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
  state.chatRunError = null;
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

export async function rewindChatHistory(
  state: RewindChatHistoryState,
  entryId: string,
): Promise<{ editorText?: string } | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const sessionKey = state.sessionKey;
  const agentParams = scopedAgentParamsForSession(state, sessionKey);
  try {
    const result = await state.sessions.rewind(sessionKey, entryId, agentParams);
    const editorText = result.editorText ?? "";
    if (state.chatMessagesBySession) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, {
        sessionKey,
        agentId: agentParams.agentId,
      });
    }
    persistChatComposerState(state, sessionKey, {
      agentId: agentParams.agentId,
      draft: editorText,
    });
    if (!visibleSessionMatches(state, sessionKey, agentParams.agentId)) {
      return null;
    }
    state.chatMessages = [];
    await Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    if (!visibleSessionMatches(state, sessionKey, agentParams.agentId)) {
      return null;
    }
    state.handleChatDraftChange(editorText);
    return result;
  } catch (error) {
    setChatError(state, error instanceof Error ? error.message : String(error));
    scheduleChatScroll(state);
    return null;
  }
}

export async function switchChatHistoryBranch(
  state: SwitchChatHistoryBranchState,
  leafEntryId: string,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const sessionKey = state.sessionKey;
  const agentParams = scopedAgentParamsForSession(state, sessionKey);
  try {
    await state.sessions.switchBranch(sessionKey, leafEntryId, agentParams);
    if (state.chatMessagesBySession) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, {
        sessionKey,
        agentId: agentParams.agentId,
      });
    }
    if (!visibleSessionMatches(state, sessionKey, agentParams.agentId)) {
      return false;
    }
    state.chatMessages = [];
    await Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    return visibleSessionMatches(state, sessionKey, agentParams.agentId);
  } catch (error) {
    setChatError(state, error instanceof Error ? error.message : String(error));
    scheduleChatScroll(state);
    return false;
  }
}

export async function loadChatBranches(state: ChatState): Promise<void> {
  const sessions = state.sessions;
  const client = state.client;
  const sessionKey = state.sessionKey;
  if (!sessions?.listBranches || !client || !state.connected) {
    return;
  }
  if (isGatewayMethodAdvertised(state, "sessions.branches.list") === false) {
    state.chatBranches = [];
    state.chatBranchesSessionKey = sessionKey;
    state.chatBranchesConnectionEpoch = state.connectionEpoch;
    return;
  }
  const version = (chatBranchRequestVersions.get(state as object) ?? 0) + 1;
  chatBranchRequestVersions.set(state as object, version);
  const connectionEpoch = state.connectionEpoch;
  const agentParams = scopedAgentParamsForSession(state, sessionKey);
  state.chatBranchesLoading = true;
  try {
    const branches = await sessions.listBranches(sessionKey, agentParams);
    if (
      chatBranchRequestVersions.get(state as object) !== version ||
      state.client !== client ||
      !state.connected ||
      state.connectionEpoch !== connectionEpoch ||
      !visibleSessionMatches(state, sessionKey, agentParams.agentId)
    ) {
      return;
    }
    state.chatBranches = branches;
    state.chatBranchesSessionKey = sessionKey;
    state.chatBranchesConnectionEpoch = connectionEpoch;
  } catch {
    if (
      chatBranchRequestVersions.get(state as object) === version &&
      state.client === client &&
      state.connectionEpoch === connectionEpoch &&
      visibleSessionMatches(state, sessionKey, agentParams.agentId)
    ) {
      state.chatBranches = [];
      state.chatBranchesSessionKey = sessionKey;
      state.chatBranchesConnectionEpoch = connectionEpoch;
    }
  } finally {
    if (chatBranchRequestVersions.get(state as object) === version) {
      state.chatBranchesLoading = false;
      state.requestUpdate?.();
    }
  }
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
  if (
    state.chatBranchesSessionKey !== sessionKey ||
    state.chatBranchesConnectionEpoch !== connectionEpoch
  ) {
    void loadChatBranches(state);
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

export async function loadOlderChatHistoryPage(
  state: ChatState,
  offset: number,
): Promise<ChatHistoryResult | undefined> {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const client = state.client;
  const sessionKey = state.sessionKey;
  const requestAgentId = isUiSelectedGlobalSessionKey(sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const ownership = beginChatHistoryRequest(
    state,
    client,
    state.connectionEpoch,
    sessionKey,
    requestAgentId,
  );
  const result = await client.request<ChatHistoryResult>("chat.history", {
    sessionKey,
    ...(requestAgentId ? { agentId: requestAgentId } : {}),
    limit: CHAT_HISTORY_REQUEST_LIMIT,
    offset,
  });
  if (!shouldApplyChatHistoryResult(state, ownership)) {
    return undefined;
  }
  return {
    ...result,
    messages: (Array.isArray(result.messages) ? result.messages : []).filter(
      (message) => !shouldHideHistoryMessage(message),
    ),
  };
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
  const previousPagination = state.chatHistoryPagination;
  const previousSessionId = state.currentSessionId ?? null;
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
    const nextPagination = resolveChatHistoryPagination(res);
    const nextSessionId = resolveChatHistorySessionId(res);
    applyChatAgentsList(state, res.agentsList, client);
    const visibleMessages = messages.filter((message) => !shouldHideHistoryMessage(message));
    const reconciledTerminal = reconcileAuthoritativeTerminalHistory({
      currentMessages: state.chatMessages,
      host: state,
      previousMessages,
      sessionKey,
      visibleMessages,
    });
    const reconciledHistory = reconcileLoadedHistoryTail({
      nextMessages: visibleMessages,
      nextPagination,
      nextSessionId,
      previousMessages: reconciledTerminal.previousMessages,
      previousPagination,
      previousSessionId,
    });
    const authoritativeMessages = reconciledHistory?.messages ?? visibleMessages;
    const lateOptimisticTail = collectLateOptimisticTailMessages(
      reconciledTerminal.previousMessages,
      reconciledTerminal.currentMessages,
      authoritativeMessages,
    );
    state.chatMessages = preserveOptimisticTailMessages(
      authoritativeMessages,
      reconciledTerminal.previousMessages,
      shouldHideHistoryMessage,
    );
    if (lateOptimisticTail.length > 0) {
      state.chatMessages = [...state.chatMessages, ...lateOptimisticTail];
    }
    if (state.initialUserMessage) {
      reconcileInitialUserMessageHandoff(
        state.initialUserMessage,
        state,
        sessionKey,
        authoritativeMessages,
        isSessionRunActive(res.sessionInfo ?? {}),
      );
    }
    retireHistoryProvenSteeredChips(state);
    state.chatHistoryPagination = reconciledHistory?.pagination ?? nextPagination;
    state.currentSessionId = nextSessionId;
    replaceCachedChatMessages(state, sessionKey, requestAgentId);
    if (
      state.reconnectResumeSessionId &&
      state.reconnectResumeSessionId !== state.currentSessionId
    ) {
      state.reconnectResumeSessionId = null;
    }
    state.chatThinkingLevel = res.sessionInfo?.thinkingLevel ?? res.thinkingLevel ?? null;
    state.chatVerboseLevel = res.verboseLevel ?? null;
    state.chatQueueModeOverride = res.sessionInfo?.queueMode;
    state.chatEffectiveQueueMode = res.sessionInfo?.effectiveQueueMode;
    const planStatusBeforeStreamReset = state.planStatus ?? null;
    const resetStream = !state.chatRunId || state.chatRunId === previousRunId;
    if (resetStream) {
      const streamReconciliation = {
        persistCommentary: state.chatRunId ? true : chatPersistCommentaryEnabled(state),
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
          persistCommentary: true,
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
          persistCommentary: true,
        });
        state.chatStream = visibleCurrentTail;
        if (state.chatStream === null) {
          state.chatStreamStartedAt = null;
        }
        prunePersistedToolStreamMessages(state, persistedToolStreamIds);
      }
    }
    // Plan reconciliation shares stream adoption: rejected history cannot clobber newer live state.
    // A missing plan is version-skew unknown; replacement or explicit terminal evidence clears it.
    state.planStatus = reconcileHistoryPlanStatus({
      canAdoptRunSnapshot: resetStream,
      inFlightRun: res.inFlightRun,
      retainedPlan: planStatusBeforeStreamReset,
      sessionInfo: res.sessionInfo,
    });
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
