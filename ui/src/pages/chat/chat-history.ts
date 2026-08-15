// Control UI page module owns Chat transcript loading and selected-session message subscription.
import {
  readSessionMessageIdentity,
  readSessionMessageSequence,
} from "@openclaw/gateway-client/browser";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
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
import type { ApplicationInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../../lib/chat/heartbeat-display.ts";
import { extractText, isEmptyUserTextOnlyMessage } from "../../lib/chat/message-extract.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  scopedAgentParamsForSession,
  visibleSessionMatches,
  type SessionCapability,
  type SessionMessageSubscription,
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
import { replaceChatAttachmentsFromEditor } from "./attachment-payload-store.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import {
  isRetryableStartupUnavailable,
  isUnknownGatewayMethodError,
  resolveStartupRetryDelayMs,
  sleep,
} from "./chat-history-retry.ts";
import type { ChatRunStartupPhase, ChatRunStartupState } from "./chat-run-startup.ts";
import { persistChatComposerState } from "./composer-persistence.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
} from "./history-merge.ts";
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
import { retirePersistedSteeredChips } from "./steer-lifecycle.ts";
import {
  clearToolStreamSegments,
  currentLiveToolCallIds,
  hasVisibleStreamParts,
  historyReplacedVisibleStream,
  materializeVisibleStreamState,
  maybeResetToolStream,
  persistedCurrentToolStreamIds,
  prunePersistedToolStreamMessages,
  visibleCurrentAssistantStreamTail,
} from "./stream-reconciliation.ts";
import { reconcileAuthoritativeTerminalHistory } from "./terminal-message-identity.ts";
import { handleAgentEvent, normalizePlanSnapshot, type PlanStatus } from "./tool-stream.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
export const CHAT_HISTORY_REQUEST_LIMIT = 100;
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const SESSION_MESSAGE_RELEASE_RETRY_MS = 250;
const MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS = 3;

type ChatHistoryPaneRequests = {
  historyVersion: number;
  branchVersion: number;
  subscriptionGeneration: number;
  pendingSubscriptionReleases: Set<SessionMessageSubscription>;
  inFlightHistory?: InFlightChatHistoryRequest;
};

const chatHistoryPaneRequests = new WeakMap<object, ChatHistoryPaneRequests>();

function getChatHistoryPaneRequests(owner: object): ChatHistoryPaneRequests {
  let requests = chatHistoryPaneRequests.get(owner);
  if (!requests) {
    requests = {
      historyVersion: 0,
      branchVersion: 0,
      subscriptionGeneration: 0,
      pendingSubscriptionReleases: new Set(),
    };
    chatHistoryPaneRequests.set(owner, requests);
  }
  return requests;
}

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
  return {
    version: ++getChatHistoryPaneRequests(state).historyVersion,
    client,
    connectionEpoch,
    sessionKey,
    agentId,
  };
}

function ownsChatHistoryRequest(state: ChatState, ownership: ChatHistoryRequestOwnership): boolean {
  return (
    getChatHistoryPaneRequests(state).historyVersion === ownership.version &&
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
    (!isUiSelectedGlobalSessionKey(state, ownership.sessionKey) ||
      resolveUiSelectedSessionAgentId(state) === ownership.agentId)
  );
}

function resetChatHistoryProjection(state: ChatState, agentId?: string): void {
  const requests = getChatHistoryPaneRequests(state);
  // A destructive reset keeps the session key, so invalidate both the old
  // snapshot owner and its coalesced request before creating the next epoch.
  requests.historyVersion += 1;
  requests.inFlightHistory = undefined;
  state.chatLoading = false;
  const scope = readChatSessionProjectionScope(state, { agentId });
  // Destructive operations keep the public session key, so only an explicit
  // reducer reset can prevent old live or pending rows from crossing epochs.
  reduceChatSessionProjection(state, { type: "sessionReset" }, { scope });
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

export function visibleChatHistoryMessages(messages: unknown): unknown[] {
  return Array.isArray(messages)
    ? messages.filter((message) => !shouldHideHistoryMessage(message))
    : [];
}

export function materializeVisibleAssistantStreamMessages(
  messages: unknown[],
  state: ChatState,
  opts: {
    includeCurrent?: boolean;
    requirePersistedTool?: boolean;
    replacementMessages?: unknown[];
    persistCommentary?: boolean;
    keyedStartIndex?: number;
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
  /** Active leaf of the history snapshot currently rendered by this pane. */
  chatDisplayedLeafEntryId?: string | null;
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
  chatRunUsageById?: Map<string, number>;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunStartup?: ChatRunStartupState | null;
  planStatus?: PlanStatus | null;
  lastError: string | null;
  chatError?: string | null;
  chatRunError?: { summary: string } | null;
  lastLocalTerminalReconcile?: { runId: string | null } | null;
  chatReplyTarget?: unknown;
  agentsError?: string | null;
  onAgentsList?: (agentsList: AgentsListResult, client: GatewayBrowserClient) => boolean;
  resetChatInputHistoryNavigation?: () => void;
  assistantAgentId?: string | null;
  agentsList?: ChatAgentsListSnapshot | null;
  agentsSelectedId?: string | null;
  hello: GatewayHelloOk | null;
  canvasPluginSurfaceUrl?: string | null;
  settings?: { chatPersistCommentary?: boolean; gatewayUrl?: string | null };
  sessions?: Partial<SessionCapability>;
  chatSessionMessageSubscriptionRequestedKey?: string | null;
  chatSessionMessageSubscription?: SessionMessageSubscription | null;
  chatBranches?: SessionBranch[];
  chatBranchesSessionKey?: string | null;
  chatBranchesConnectionEpoch?: number | null;
  requestUpdate?: () => void;
};

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: AgentsListResult["agents"];
};

type ChatSessionMessageSubscriptionState = ChatState & {
  sessions: Pick<SessionCapability, "subscribeMessages" | "unsubscribeMessages">;
  sessionsResult?: SessionsListResult | null;
  sessionsError?: string | null;
  chatSessionMessageSubscriptionRequestedKey?: string | null;
  chatSessionMessageSubscription?: SessionMessageSubscription | null;
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
    startedAt?: number;
    events?: Array<{
      runId: string;
      seq: number;
      stream: string;
      ts: number;
      sessionKey?: string;
      agentId?: string;
      data: Record<string, unknown>;
    }>;
    plan?: {
      steps: Array<PlanStatus["steps"][number] | string>;
      explanation?: string;
    };
  };
};

function replayInFlightRunEvents(
  state: ChatState,
  run: NonNullable<ChatHistoryResult["inFlightRun"]>,
): void {
  if (state.chatRunId !== run.runId || !Array.isArray(run.events)) {
    return;
  }
  for (const event of run.events) {
    if (!event || event.runId !== run.runId) {
      continue;
    }
    handleAgentEvent(state as never, event as never);
  }
}

function resolveInFlightAssistantTail(
  messages: unknown[],
  bufferedText: unknown,
  runId: string,
): string | null {
  if (
    typeof bufferedText !== "string" ||
    !bufferedText ||
    isHiddenAssistantStreamText(bufferedText)
  ) {
    return null;
  }

  // A steered user turn can follow an assistant from the still-active run.
  // Persisted run identity, not the latest user boundary, owns that prefix.
  const ownedPrefixIndex = messages.findIndex((message) => {
    const identity = readSessionMessageIdentity(message);
    const persistedText = identity?.runId === runId ? extractText(message) : null;
    return (
      identity?.role === "assistant" &&
      Boolean(
        persistedText &&
        (bufferedText.startsWith(persistedText) || persistedText.startsWith(bufferedText)),
      )
    );
  });
  let turnStart = ownedPrefixIndex === -1 ? 0 : ownedPrefixIndex;
  if (ownedPrefixIndex === -1) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message &&
        typeof message === "object" &&
        normalizeLowercaseStringOrEmpty((message as Record<string, unknown>).role) === "user"
      ) {
        turnStart = index + 1;
        break;
      }
    }
  }

  let persistedPrefixLength = 0;
  for (let index = turnStart; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const identity = readSessionMessageIdentity(message);
    if (identity?.role !== "assistant" || (identity.runId && identity.runId !== runId)) {
      continue;
    }

    const persistedText = extractText(message);
    if (!persistedText) {
      continue;
    }
    // One tool-using turn may persist several assistant segments; the Gateway
    // buffer includes them all, so matching only its newest row duplicates text.
    const remainingText = bufferedText.slice(persistedPrefixLength);
    if (remainingText.startsWith(persistedText)) {
      persistedPrefixLength += persistedText.length;
      continue;
    }
    // History can persist past a live delta while its request is pending.
    // That older cumulative buffer is already rendered by the persisted row.
    if (persistedText.startsWith(remainingText)) {
      return null;
    }
    const whitespace = /^\s+/u.exec(remainingText)?.[0];
    if (persistedPrefixLength > 0 && whitespace) {
      const remainingAfterWhitespace = remainingText.slice(whitespace.length);
      if (remainingAfterWhitespace.startsWith(persistedText)) {
        persistedPrefixLength += whitespace.length + persistedText.length;
        continue;
      }
      if (persistedText.startsWith(remainingAfterWhitespace)) {
        return null;
      }
    }
    if (persistedPrefixLength > 0) {
      break;
    }
  }

  const tail = bufferedText.slice(persistedPrefixLength);
  return tail && !isHiddenAssistantStreamText(tail) ? tail : null;
}

function onlyInFlightRunProjectionChanged(
  previous: ReturnType<typeof getChatSessionProjection>["runs"],
  current: ReturnType<typeof getChatSessionProjection>["runs"],
  runId: string,
): boolean {
  for (const [previousRunId, run] of Object.entries(previous)) {
    if (previousRunId !== runId && current[previousRunId] !== run) {
      return false;
    }
  }
  for (const [currentRunId, run] of Object.entries(current)) {
    if (currentRunId !== runId && previous[currentRunId] !== run) {
      return false;
    }
  }
  return true;
}

function runProjectionsUnchanged(
  previous: ReturnType<typeof getChatSessionProjection>["runs"],
  current: ReturnType<typeof getChatSessionProjection>["runs"],
): boolean {
  const previousEntries = Object.entries(previous);
  return (
    previousEntries.length === Object.keys(current).length &&
    previousEntries.every(([runId, run]) => current[runId] === run)
  );
}

function mergeInFlightAssistantTails(
  snapshotTail: string | null,
  cumulativeLiveTail: string | null,
): string | null {
  if (!snapshotTail) {
    return cumulativeLiveTail;
  }
  if (!cumulativeLiveTail || snapshotTail.startsWith(cumulativeLiveTail)) {
    return snapshotTail;
  }
  // Every Gateway delta carries its full assistant message. Comparing complete
  // projections preserves repeated tokens without guessing delta overlap.
  return cumulativeLiveTail;
}

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
    const seq = readSessionMessageSequence(message);
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
  state: "status" | "delta" | "final" | "aborted" | "error";
  phase?: ChatRunStartupPhase;
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
  if (!isUiSelectedGlobalSessionKey(state, state.sessionKey) || !isUiGlobalSessionKey(sessionKey)) {
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
    isUiSelectedGlobalSessionKey(state, state.sessionKey) &&
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
    getChatHistoryPaneRequests(state).subscriptionGeneration === params.generation &&
    state.client === params.client &&
    state.connected &&
    state.sessionKey.trim() === params.requestedKey &&
    resolveSelectedSessionMessageSubscriptionAgentId(state, params.requestedKey) ===
      (params.requestedAgentId ?? null)
  );
}

async function retryPendingSessionMessageSubscriptionReleases(
  state: ChatSessionMessageSubscriptionState,
): Promise<void> {
  const pending = getChatHistoryPaneRequests(state).pendingSubscriptionReleases;
  if (pending.size === 0) {
    return;
  }
  await Promise.all(
    [...pending].map(async (subscription) => {
      try {
        await state.sessions.unsubscribeMessages(subscription);
        pending.delete(subscription);
      } catch {
        // Keep the handle for the next synchronization attempt or connection cleanup.
      }
    }),
  );
}

export function disposeSelectedSessionMessageSubscription(state: ChatState): void {
  const requests = getChatHistoryPaneRequests(state);
  requests.subscriptionGeneration += 1;
  const subscriptions = new Set(requests.pendingSubscriptionReleases);
  requests.pendingSubscriptionReleases.clear();
  if (state.chatSessionMessageSubscription) {
    subscriptions.add(state.chatSessionMessageSubscription);
  }
  state.chatSessionMessageSubscriptionRequestedKey = null;
  state.chatSessionMessageSubscription = null;
  const sessions = state.sessions;
  if (!sessions?.unsubscribeMessages) {
    return;
  }
  const unsubscribeMessages = sessions.unsubscribeMessages.bind(sessions);
  for (const subscription of subscriptions) {
    // A detached pane cannot drain another queue. Retry on its longer-lived
    // session owner, but stop after terminal failures so timers cannot leak.
    void (async () => {
      let retryDelayMs = SESSION_MESSAGE_RELEASE_RETRY_MS;
      for (let attempt = 0; attempt < MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS; attempt += 1) {
        try {
          await unsubscribeMessages(subscription);
          return;
        } catch {
          if (attempt + 1 === MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS) {
            return;
          }
          await new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, retryDelayMs);
          });
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        }
      }
    })();
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
  await retryPendingSessionMessageSubscriptionReleases(state);
  const paneRequests = getChatHistoryPaneRequests(state);
  const generation = ++paneRequests.subscriptionGeneration;
  const previousRequestedKey = normalizeSubscriptionKey(
    state.chatSessionMessageSubscriptionRequestedKey,
  );
  const previousSubscription = state.chatSessionMessageSubscription ?? null;
  const previousCanonicalKey = normalizeSubscriptionKey(previousSubscription?.key);
  const previousSelectedKey = previousRequestedKey ?? previousCanonicalKey;
  const nextSubscriptionAgentId = resolveSelectedSessionMessageSubscriptionAgentId(state, nextKey);
  const selectedAgentChanged =
    nextSubscriptionAgentId !== null &&
    previousSelectedKey === nextKey &&
    (previousSubscription?.agentId ?? null) !== nextSubscriptionAgentId;
  const selectedKeyChanged = previousSelectedKey !== null && previousSelectedKey !== nextKey;
  const shouldUnsubscribePrevious =
    previousSubscription !== null &&
    (opts?.force === true || selectedKeyChanged || selectedAgentChanged);
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
    let unsubscribePromise: Promise<void> = Promise.resolve();
    if (shouldUnsubscribePrevious && previousSubscription) {
      unsubscribePromise = state.sessions.unsubscribeMessages(previousSubscription);
    }
    const subscribePromise =
      shouldSubscribe && isCurrent()
        ? state.sessions.subscribeMessages(nextKey, {
            agentId: nextSubscriptionAgentId ?? undefined,
          })
        : Promise.resolve(null);
    // Gateway subscriptions are independent canonical-key entries. Overlap the old
    // release with the new acquire so a session switch pays one RTT, not two.
    const [unsubscribeResult, subscribeResult] = await Promise.allSettled([
      unsubscribePromise,
      subscribePromise,
    ]);
    if (unsubscribeResult.status === "rejected") {
      if (subscribeResult.status === "fulfilled" && subscribeResult.value) {
        try {
          await state.sessions.unsubscribeMessages(subscribeResult.value);
        } catch (replacementReleaseError) {
          if (isCurrent()) {
            if (previousSubscription) {
              // Both live handles stay owned: the replacement becomes active while the
              // failed previous release remains queued until a later sync releases it.
              paneRequests.pendingSubscriptionReleases.add(previousSubscription);
            }
            state.chatSessionMessageSubscriptionRequestedKey = nextKey;
            state.chatSessionMessageSubscription = subscribeResult.value;
            state.sessionsError = `${String(unsubscribeResult.reason)}; replacement release failed: ${String(replacementReleaseError)}`;
          } else {
            paneRequests.pendingSubscriptionReleases.add(subscribeResult.value);
          }
          return;
        }
      }
      if (isCurrent()) {
        state.sessionsError = String(unsubscribeResult.reason);
      }
      return;
    }
    if (subscribeResult.status === "rejected") {
      if (isCurrent() && shouldUnsubscribePrevious) {
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscription = null;
      }
      throw subscribeResult.reason;
    }
    const subscribed = subscribeResult.value;
    if (!subscribed) {
      if (isCurrent() && shouldUnsubscribePrevious) {
        state.chatSessionMessageSubscriptionRequestedKey = null;
        state.chatSessionMessageSubscription = null;
      }
      return;
    }
    if (!isCurrent()) {
      // Generation advances before awaiting, so only the newest lease can reach assignment below.
      try {
        await state.sessions.unsubscribeMessages(subscribed);
      } catch {
        // A rejected release still owns its live Gateway observer; retain the
        // exact handle so the next sync can complete the original unsubscribe.
        paneRequests.pendingSubscriptionReleases.add(subscribed);
      }
      return;
    }
    state.chatSessionMessageSubscriptionRequestedKey = nextKey;
    state.chatSessionMessageSubscription = subscribed;
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
  promise: Promise<ChatHistoryResult | undefined>;
};

type LoadChatHistoryOptions = {
  deferBranches?: boolean;
  startup?: boolean;
};

type SharedChatHistoryRequest = {
  consumers: Set<SharedChatHistoryConsumer>;
  promise: Promise<ChatHistoryResult>;
};

type SharedChatHistoryRegistry = {
  ownerRequestCounts: WeakMap<object, Map<string, number>>;
  requests: Map<string, SharedChatHistoryRequest>;
};

type SharedChatHistoryConsumer = {
  isCurrent: () => boolean;
  retryDeadlineMs: number;
};

const sharedChatHistoryRequests = new WeakMap<GatewayBrowserClient, SharedChatHistoryRegistry>();

function updateChatHistoryOwnerRequestCount(
  registry: SharedChatHistoryRegistry,
  owner: object,
  requestKey: string,
  delta: 1 | -1,
) {
  let counts = registry.ownerRequestCounts.get(owner);
  const nextCount = (counts?.get(requestKey) ?? 0) + delta;
  if (nextCount <= 0) {
    counts?.delete(requestKey);
    if (counts?.size === 0) {
      registry.ownerRequestCounts.delete(owner);
    }
    return;
  }
  if (!counts) {
    counts = new Map();
    registry.ownerRequestCounts.set(owner, counts);
  }
  counts.set(requestKey, nextCount);
}

async function requestChatHistory(
  client: GatewayBrowserClient,
  method: "chat.history" | "chat.startup",
  sessionKey: string,
  requestAgentId: string | undefined,
  shouldContinue: () => boolean,
  shouldRetry: () => boolean,
): Promise<ChatHistoryResult> {
  for (;;) {
    try {
      return await client.request<ChatHistoryResult>(method, {
        sessionKey,
        ...(requestAgentId ? { agentId: requestAgentId } : {}),
        limit: CHAT_HISTORY_REQUEST_LIMIT,
      });
    } catch (err) {
      if (!shouldContinue()) {
        throw err;
      }
      if (method === "chat.startup" && isUnknownGatewayMethodError(err, method)) {
        return await client.request<ChatHistoryResult>("chat.history", {
          sessionKey,
          ...(requestAgentId ? { agentId: requestAgentId } : {}),
          limit: CHAT_HISTORY_REQUEST_LIMIT,
        });
      }
      if (shouldRetry() && isRetryableStartupUnavailable(err, method)) {
        await sleep(resolveStartupRetryDelayMs(err));
        if (!shouldContinue()) {
          throw err;
        }
        continue;
      }
      throw err;
    }
  }
}

function requestSharedChatHistory(
  client: GatewayBrowserClient,
  requestKey: string,
  method: "chat.history" | "chat.startup",
  sessionKey: string,
  requestAgentId: string | undefined,
  consumerOwner: object,
  isCurrentConsumer: () => boolean,
): Promise<ChatHistoryResult> {
  let registry = sharedChatHistoryRequests.get(client);
  if (!registry) {
    registry = {
      ownerRequestCounts: new WeakMap(),
      requests: new Map(),
    };
    sharedChatHistoryRequests.set(client, registry);
  }
  const requests = registry.requests;
  let shared = requests.get(requestKey);
  const existingOwner = (registry.ownerRequestCounts.get(consumerOwner)?.get(requestKey) ?? 0) > 0;
  const consumer = {
    isCurrent: isCurrentConsumer,
    retryDeadlineMs: Date.now() + STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS,
  };
  if (!shared || existingOwner) {
    const consumers = new Set([consumer]);
    const shouldContinue = () => [...consumers].some((entry) => entry.isCurrent());
    // A pane joining older shared work still owns a full retry window. Otherwise
    // it could inherit the first consumer's nearly expired startup deadline.
    const shouldRetry = () =>
      [...consumers].some((entry) => entry.isCurrent() && Date.now() < entry.retryDeadlineMs);
    const promise = requestChatHistory(
      client,
      method,
      sessionKey,
      requestAgentId,
      shouldContinue,
      shouldRetry,
    ).finally(() => {
      if (requests?.get(requestKey)?.promise === promise) {
        requests.delete(requestKey);
      }
    });
    shared = { consumers, promise };
    requests.set(requestKey, shared);
  } else {
    shared.consumers.add(consumer);
  }
  updateChatHistoryOwnerRequestCount(registry, consumerOwner, requestKey, 1);
  // The client owns this bounded in-flight map, while every pane remains responsible
  // for applying the shared payload under its own session/version ownership checks.
  // Owner counts outlive displaced map entries so overlapping refreshes never reuse stale work.
  return shared.promise.finally(() => {
    shared?.consumers.delete(consumer);
    updateChatHistoryOwnerRequestCount(registry, consumerOwner, requestKey, -1);
  });
}

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
      ...(state.chatDisplayedLeafEntryId !== undefined
        ? { displayedLeafEntryId: state.chatDisplayedLeafEntryId }
        : {}),
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

type ClearChatViewOwner = {
  client: ClearChatHistoryState["client"];
  connectionEpoch: number;
  sessionKey: string;
  agentId?: string;
};

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

function ownsClearChatView(state: ClearChatHistoryState, owner: ClearChatViewOwner): boolean {
  return (
    state.client === owner.client &&
    state.connectionEpoch === owner.connectionEpoch &&
    visibleSessionMatches(state, owner.sessionKey, owner.agentId)
  );
}

function clearPostResetBranchPrecondition(
  state: ClearChatHistoryState,
  target: {
    client: NonNullable<ClearChatHistoryState["client"]>;
    connectionEpoch: number;
    sessionKey: string;
    agentId?: string;
  },
  history: ChatHistoryResult | undefined,
) {
  if (
    !history ||
    !Object.hasOwn(history.sessionInfo ?? {}, "activeLeafEntryId") ||
    history.sessionInfo?.activeLeafEntryId !== null ||
    state.client !== target.client ||
    state.connectionEpoch !== target.connectionEpoch ||
    !state.connected ||
    !visibleSessionMatches(state, target.sessionKey, target.agentId)
  ) {
    return;
  }
  // Reset can leave old branch metadata visible after the transcript becomes
  // empty. The first post-reset send must establish the new branch itself.
  delete state.chatDisplayedLeafEntryId;
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
  const originalViewOwner: ClearChatViewOwner = {
    client,
    connectionEpoch,
    sessionKey,
    agentId: agentParams.agentId,
  };
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
      const feedbackOwner: ClearChatViewOwner = {
        client: state.client,
        connectionEpoch: state.connectionEpoch,
        sessionKey,
        agentId: agentParams.agentId,
      };
      let historyRefreshed = false;
      if (
        state.client &&
        state.connected &&
        visibleSessionMatches(state, sessionKey, agentParams.agentId)
      ) {
        // Do not let a failed refresh keep rendering the transcript that the
        // ambiguous reset may already have destroyed. Clearing first also
        // prevents history loading from preserving a pre-reset optimistic tail.
        resetChatHistoryProjection(state, agentParams.agentId);
        const history = await loadChatHistory(state);
        historyRefreshed = Boolean(history);
        clearPostResetBranchPrecondition(
          state,
          { client, connectionEpoch, sessionKey, agentId: agentParams.agentId },
          history,
        );
      }
      if (ownsClearChatView(state, feedbackOwner)) {
        setChatError(
          state,
          historyRefreshed
            ? "The clear request may have completed. Current history was refreshed; review it before resuming queued messages."
            : "The clear request may have completed. Cached history was cleared, but current history could not be refreshed; reconnect and review it before resuming queued messages.",
        );
        scheduleChatScroll(state);
      }
      // sessions.reset is not idempotent. Treat an uncertain completion as
      // consumed so a durable /clear row cannot erase newer history on retry.
      return "uncertain";
    }
  } catch (err) {
    if (ownsClearChatView(state, originalViewOwner)) {
      setChatError(state, String(err));
      scheduleChatScroll(state);
    }
    return "failed";
  }
  if (!visibleSessionMatches(state, sessionKey, agentParams.agentId)) {
    return "completed";
  }
  resetChatHistoryProjection(state, agentParams.agentId);
  state.chatRunError = null;
  state.chatReplyTarget = null;
  reconcileChatRunLifecycle(state, {
    outcome: hadActiveRun ? "interrupted" : undefined,
    sessionStatus: "killed",
    runId,
    sessionKey,
    clearLocalRun: true,
    clearChatStream: true,
    clearToolStream: true,
    clearRunStatus: !hadActiveRun,
  });
  const history = await loadChatHistory(state);
  clearPostResetBranchPrecondition(
    state,
    { client, connectionEpoch, sessionKey, agentId: agentParams.agentId },
    history,
  );
  if (ownsClearChatView(state, originalViewOwner)) {
    scheduleChatScroll(state);
  }
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
    resetChatHistoryProjection(state, agentParams.agentId);
    await Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    if (!visibleSessionMatches(state, sessionKey, agentParams.agentId)) {
      return null;
    }
    // Restored images intentionally stay in this tab's memory; persisted composer drafts remain
    // text-only so large payloads do not enter local storage.
    state.chatAttachments = replaceChatAttachmentsFromEditor(
      state.chatAttachments,
      result.editorAttachments,
    );
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
    resetChatHistoryProjection(state, agentParams.agentId);
    await Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    return visibleSessionMatches(state, sessionKey, agentParams.agentId);
  } catch (error) {
    setChatError(state, error instanceof Error ? error.message : String(error));
    scheduleChatScroll(state);
    return false;
  }
}

/** Branches for the current pane; equivalence covers alias-canonicalization windows (#124020 class). */
export function displayedChatSessionBranches(
  state: Pick<ChatState, "chatBranches" | "chatBranchesSessionKey" | "sessionKey">,
): SessionBranch[] {
  return areUiSessionKeysEquivalent(state.chatBranchesSessionKey, state.sessionKey)
    ? (state.chatBranches ?? [])
    : [];
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
  const requests = getChatHistoryPaneRequests(state);
  const version = ++requests.branchVersion;
  const connectionEpoch = state.connectionEpoch;
  const agentParams = scopedAgentParamsForSession(state, sessionKey);
  try {
    const branches = await sessions.listBranches(sessionKey, agentParams);
    if (
      requests.branchVersion !== version ||
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
    // Leave chatBranchesSessionKey unset so the next history load retries;
    // recording success here latched transient failures into a permanently
    // hidden branch dropdown with no visible outcome.
  } finally {
    if (requests.branchVersion === version) {
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
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const startupAdvertised = isGatewayMethodAdvertised(state, "chat.startup");
  const method =
    opts.startup === true && startupAdvertised !== false ? "chat.startup" : "chat.history";
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const requestKey = `${connectionEpoch}\u0000${method}\u0000${sessionKey}\u0000${requestAgentId ?? ""}\u0000${CHAT_HISTORY_REQUEST_LIMIT}`;
  const requests = getChatHistoryPaneRequests(state);
  const inFlight = requests.inFlightHistory;
  // Live events replace the rendered array while their snapshot is pending;
  // only stable session and connection ownership may start another request.
  if (
    inFlight?.key === requestKey &&
    inFlight.client === client &&
    inFlight.connectionEpoch === connectionEpoch
  ) {
    return inFlight.promise;
  }
  if (
    opts.deferBranches !== true &&
    (!areUiSessionKeysEquivalent(state.chatBranchesSessionKey, sessionKey) ||
      state.chatBranchesConnectionEpoch !== connectionEpoch)
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
    if (requests.inFlightHistory?.promise === promise) {
      requests.inFlightHistory = undefined;
    }
  });
  requests.inFlightHistory = {
    client,
    connectionEpoch,
    key: requestKey,
    promise,
  };
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
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
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
    messages: visibleChatHistoryMessages(result.messages),
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
  if (state.onAgentsList && !state.onAgentsList(agentsList, client)) {
    return;
  }
  state.agentsList = agentsList;
  state.agentsError = null;
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
  const startedAtMs = controlUiNowMs();
  const previousMessages = state.chatMessages;
  const previousRunProjections = getChatSessionProjection(
    state,
    previousMessages,
    readChatSessionProjectionScope(state, {
      sessionKey,
      ...(requestAgentId ? { agentId: requestAgentId } : {}),
    }),
  ).runs;
  const previousPagination = state.chatHistoryPagination;
  const previousSessionId = state.currentSessionId ?? null;
  const previousDisplayedLeafEntryId = state.chatDisplayedLeafEntryId;
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
    const requestKey = `${connectionEpoch}\u0000${method}\u0000${sessionKey}\u0000${requestAgentId ?? ""}\u0000${CHAT_HISTORY_REQUEST_LIMIT}`;
    const res = await requestSharedChatHistory(
      client,
      requestKey,
      method,
      sessionKey,
      requestAgentId,
      state as object,
      () => shouldApplyChatHistoryResult(state, ownership),
    );
    if (!shouldApplyChatHistoryResult(state, ownership)) {
      recordChatHistoryTiming(state, "stale", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        reason: "apply-version",
      });
      return undefined;
    }
    // Fence concurrent run lifecycle before applying the response. A remount
    // may replace the map itself, so compare its canonical run entries.
    const runProjectionsBeforeApply = getChatSessionProjection(
      state,
      state.chatMessages,
      readChatSessionProjectionScope(state, {
        sessionKey,
        ...(requestAgentId ? { agentId: requestAgentId } : {}),
      }),
    ).runs;
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const nextPagination = resolveChatHistoryPagination(res);
    const nextSessionId = resolveChatHistorySessionId(res);
    applyChatAgentsList(state, res.agentsList, client);
    const visibleMessages = visibleChatHistoryMessages(messages);
    const previousTerminalMessages = reconcileAuthoritativeTerminalHistory({
      host: state,
      previousMessages,
      sessionKey,
      visibleMessages,
    });
    const nextDisplayedLeafEntryId = Object.hasOwn(res.sessionInfo ?? {}, "activeLeafEntryId")
      ? res.sessionInfo?.activeLeafEntryId?.trim() || null
      : (previousDisplayedLeafEntryId ?? null);
    const retainsTranscriptIdentity =
      (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) &&
      (previousDisplayedLeafEntryId === undefined ||
        previousDisplayedLeafEntryId === nextDisplayedLeafEntryId);
    const reconciledHistory = reconcileLoadedHistoryTail({
      nextMessages: visibleMessages,
      nextPagination,
      nextSessionId,
      previousMessages: retainsTranscriptIdentity ? previousTerminalMessages : [],
      previousPagination,
      previousSessionId,
    });
    const authoritativeMessages = reconciledHistory?.messages ?? visibleMessages;
    const scope = readChatSessionProjectionScope(state, {
      sessionKey,
      agentId: requestAgentId,
      sessionId: nextSessionId,
      ...(Object.hasOwn(res.sessionInfo ?? {}, "activeLeafEntryId")
        ? { activeLeafEntryId: nextDisplayedLeafEntryId }
        : {}),
    });
    // Only the pane-owned reducer proves which live and pending rows survive;
    // terminal-renderer cleanup must not reclassify them as history. A new
    // session or leaf starts empty.
    const historyProjection = reduceChatSessionProjection(
      state,
      {
        type: "snapshotLoaded",
        messages: authoritativeMessages,
        options: { shouldIncludeMessage: (message) => !shouldHideHistoryMessage(message) },
      },
      {
        scope,
        messages: retainsTranscriptIdentity ? state.chatMessages : [],
        runActive:
          res.sessionInfo &&
          (typeof res.sessionInfo.hasActiveRun === "boolean" ||
            res.sessionInfo.status !== undefined)
            ? isSessionRunActive(res.sessionInfo)
            : undefined,
      },
    );
    if (Object.hasOwn(res.sessionInfo ?? {}, "activeLeafEntryId")) {
      state.chatDisplayedLeafEntryId = nextDisplayedLeafEntryId;
    }
    retirePersistedSteeredChips(state);
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
    const activeStreamBeforeReset = state.chatRunId ? state.chatStream : null;
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
      if (state.chatRunId && (hasVisibleStream || liveToolIds.length > 0)) {
        state.chatRunStartup = { state: "activity", runId: state.chatRunId };
      }
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

    const inFlightRunId = res.inFlightRun?.runId?.trim();
    const activeRunIds = res.sessionInfo?.activeRunIds;
    const projectedInFlightRun = inFlightRunId ? historyProjection.runs[inFlightRunId] : undefined;
    const sameRunContinued = Boolean(
      inFlightRunId &&
      state.chatRunId === inFlightRunId &&
      projectedInFlightRun?.status === "streaming" &&
      onlyInFlightRunProjectionChanged(
        previousRunProjections,
        historyProjection.runs,
        inFlightRunId,
      ),
    );
    const inFlightRunIsActive = Boolean(
      inFlightRunId &&
      isSessionRunActive(res.sessionInfo ?? {}) &&
      (!Array.isArray(activeRunIds) || activeRunIds.includes(inFlightRunId)) &&
      (!projectedInFlightRun || projectedInFlightRun.status === "streaming"),
    );
    const canAdoptInFlightRun = Boolean(
      inFlightRunId &&
      inFlightRunIsActive &&
      ((resetStream &&
        !state.chatRunId &&
        runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)) ||
        sameRunContinued),
    );
    if (inFlightRunId && canAdoptInFlightRun) {
      // Canonical run projections change on every live delta or terminal.
      // Their identity fences ABA races where a run starts and finishes while
      // history is pending; deltas from this same live run must still merge.
      state.chatRunId = inFlightRunId;
    }
    if (inFlightRunIsActive && res.inFlightRun && state.chatRunId === inFlightRunId) {
      const snapshotStartedAt =
        typeof res.inFlightRun.startedAt === "number" && Number.isFinite(res.inFlightRun.startedAt)
          ? res.inFlightRun.startedAt
          : null;
      const snapshotTail = resolveInFlightAssistantTail(
        state.chatMessages,
        res.inFlightRun?.text,
        inFlightRunId,
      );
      const liveTail = sameRunContinued
        ? resolveInFlightAssistantTail(
            state.chatMessages,
            extractText(projectedInFlightRun?.message),
            inFlightRunId,
          )
        : activeStreamBeforeReset;
      const tail = mergeInFlightAssistantTails(snapshotTail, liveTail);
      state.chatStream = tail;
      state.chatStreamStartedAt = snapshotStartedAt ?? state.chatStreamStartedAt ?? Date.now();
      state.chatRunStartup = { state: "activity", runId: inFlightRunId };
      // Disconnect cleanup intentionally removes transient activity rows while
      // retaining the owned run. Replay fills that gap; per-identity sequence
      // fences keep a delayed snapshot from replacing newer live progress.
      replayInFlightRunEvents(state, res.inFlightRun);
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
      resetChatHistoryProjection(state, requestAgentId);
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
