import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionBranch,
  SessionsListResult,
} from "../../api/types.ts";
import { hasOperatorApprovalsAccess } from "../../app/operator-access.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-store.ts";
import { accumulatedStreamText, advanceAccumulatedStreamText } from "../../lib/chat/chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../../lib/chat/heartbeat-display.ts";
import { extractText, isEmptyUserTextOnlyMessage } from "../../lib/chat/message-extract.ts";
// Control UI page module owns Chat transcript loading and selected-session message subscription.
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
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
  uiConversationMatches,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { replaceChatAttachmentsFromEditor } from "./attachment-payload-store.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import {
  isRetryableStartupUnavailable,
  resolveStartupRetryDelayMs,
  sleep,
} from "./chat-history-retry.ts";
import { applyChatPendingInputs, clearChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatRunStartupPhase } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { persistChatComposerState } from "./composer-persistence.ts";
import {
  getChatRunOwner,
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  setChatRunOwner,
  setChatSessionProjection,
} from "./history-merge.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
} from "./performance.ts";
import {
  adoptStartedChatRun,
  reconcileChatRunFromSessionRow,
  reconcileChatRunLifecycle,
  setChatRunError,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { projectSessionApprovalReplay } from "./session-approval-projection.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import {
  cacheChatSessionSnapshot,
  clearChatMessagesFromCache,
  readChatSessionSnapshot,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  latestPersistedSteerBoundary,
  rolloverChatStream,
  resolveCumulativeAssistantTail,
} from "./stream-causal-boundary.ts";
import {
  currentLiveToolCallIds,
  hasVisibleStreamParts,
  historyReplacedVisibleStream,
  materializeVisibleStreamState,
  maybeResetToolStream,
  visibleCurrentAssistantStreamTail,
} from "./stream-reconciliation.ts";
import {
  pruneHistoryReplacedStreamSegments,
  prunePersistedToolStreamMessages,
} from "./stream-segment-pruning.ts";
import { reconcileAuthoritativeTerminalHistory } from "./terminal-message-identity.ts";
import { persistedCurrentToolStreamIds } from "./tool-stream-identity.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
export const CHAT_HISTORY_REQUEST_LIMIT = 100;
// Back-scroll pages are larger than the startup tail: session open stays cheap
// while older-history reads amortize round trips and prepend/re-anchor cycles.
// The gateway independently bounds each response (entry cap + byte budget).
const CHAT_HISTORY_OLDER_PAGE_LIMIT = 400;
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const SESSION_MESSAGE_RELEASE_RETRY_MS = 250;
const MAX_SESSION_MESSAGE_RELEASE_ATTEMPTS = 3;

type ChatHistoryLoadRequest = {
  sessionKey: string;
  requestAgentId: string | undefined;
  startup: boolean;
};

export type ChatHistoryLoadState =
  | { phase: "idle" }
  | ({ phase: "pending-connection" } & ChatHistoryLoadRequest)
  | ({
      phase: "in-flight";
      client: GatewayBrowserClient;
      connectionEpoch: number;
      key: string;
      promise: Promise<ChatHistoryResult | undefined>;
    } & ChatHistoryLoadRequest)
  | { phase: "committed"; key: string }
  | ({ phase: "failed"; message: string; retryable: boolean } & ChatHistoryLoadRequest);

type ChatHistoryPaneRequests = {
  historyVersion: number;
  branchVersion: number;
  subscriptionGeneration: number;
  subscriptionError?: string;
  pendingSubscriptionReleases: Set<SessionMessageSubscription>;
  historyLoad: ChatHistoryLoadState;
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
      historyLoad: { phase: "idle" },
    };
    chatHistoryPaneRequests.set(owner, requests);
  }
  return requests;
}

export function getChatHistoryLoadState(state: ChatState): ChatHistoryLoadState {
  const requests = getChatHistoryPaneRequests(state);
  const load = requests.historyLoad;
  if (load.phase === "idle") {
    return load;
  }
  const requestAgentId = isUiSelectedGlobalSessionKey(state, state.sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const current =
    load.phase === "committed"
      ? load.key === `${state.sessionKey}\u0000${requestAgentId ?? ""}`
      : load.sessionKey === state.sessionKey && load.requestAgentId === requestAgentId;
  if (!current) {
    requests.historyLoad = { phase: "idle" };
    state.chatLoading = false;
  } else if (
    load.phase === "in-flight" &&
    (!state.connected ||
      load.client !== state.client ||
      load.connectionEpoch !== state.connectionEpoch)
  ) {
    // Reconnect can finish before stale work settles, so transfer its intent
    // before the connected transition decides whether to reissue history.
    requests.historyLoad = {
      phase: "pending-connection",
      sessionKey: load.sessionKey,
      requestAgentId: load.requestAgentId,
      startup: load.startup,
    };
    state.chatLoading = true;
    state.requestUpdate?.();
  }
  return requests.historyLoad;
}

export function retireChatBranchRequests(state: ChatState): void {
  getChatHistoryPaneRequests(state).branchVersion += 1;
}

export function getChatHistoryVersion(state: ChatState): number {
  return getChatHistoryPaneRequests(state).historyVersion;
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

export function resetChatHistoryProjection(state: ChatState, agentId?: string): void {
  clearChatPendingInputs(state);
  const requests = getChatHistoryPaneRequests(state);
  // A destructive reset keeps the session key, so invalidate both the old
  // snapshot owner and its coalesced request before creating the next epoch.
  requests.historyVersion += 1;
  requests.historyLoad = { phase: "idle" };
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

export type { ChatState } from "./chat-state-contract.ts";

type ChatSessionMessageSubscriptionState = ChatState & {
  sessions: Pick<SessionCapability, "subscribeMessages" | "unsubscribeMessages">;
  sessionsResult?: SessionsListResult | null;
  sessionsError?: string | null;
  chatSessionMessageSubscriptionRequestedKey?: string | null;
  chatSessionMessageSubscription?: SessionMessageSubscription | null;
};

export type ChatHistoryResult = {
  pendingInputs?: ChatPendingInputsPage;
  sourceCanonicalListRevision?: number;
  deltaCursor?: string;
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
  metadata?: ChatMetadataResult;
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    sessionAbortable?: boolean;
    events?: Array<{
      runId: string;
      seq: number;
      stream: string;
      ts: number;
      sessionKey?: string;
      agentId?: string;
      data: Record<string, unknown>;
    }>;
    plan?: { steps: Array<{ step: string; status: string }>; explanation?: string };
  };
};

type ChatHistoryDeltaResult = {
  pendingInputs?: ChatPendingInputsPage;
  kind: "delta";
  messages: unknown[];
  deltaCursor: string;
  sessionInfo: GatewaySessionRow;
  inFlightRun?: ChatHistoryResult["inFlightRun"];
  metadata?: ChatMetadataResult;
};

type ChatHistoryResetResult = { kind: "reset" };
type ChatHistoryResponse = ChatHistoryResult | ChatHistoryDeltaResult | ChatHistoryResetResult;

function isChatHistoryCursorResult(
  result: ChatHistoryResponse,
): result is ChatHistoryDeltaResult | ChatHistoryResetResult {
  return "kind" in result;
}

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

function resolveInFlightAssistantText(bufferedText: unknown): string | null {
  return typeof bufferedText === "string" &&
    bufferedText &&
    !isHiddenAssistantStreamText(bufferedText)
    ? bufferedText
    : null;
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

function readChatRunProjections(state: ChatState, sessionKey: string, agentId?: string) {
  return getChatSessionProjection(
    state,
    state.chatMessages,
    readChatSessionProjectionScope(state, {
      sessionKey,
      ...(agentId ? { agentId } : {}),
    }),
  ).runs;
}

function mergeInFlightAssistantText(snapshot: string | null, live: string | null): string | null {
  if (!snapshot || live?.startsWith(snapshot)) {
    return live ?? snapshot;
  }
  if (!live || snapshot.startsWith(live)) {
    return snapshot;
  }
  // Divergence: live deltas are newer than the bounded snapshot, so the local
  // cumulative buffer wins — a lagging snapshot must not rewind streamed text.
  return live;
}

function applyHistoryRunSnapshot(params: {
  state: ChatState;
  run: ChatHistoryResult["inFlightRun"];
  sessionInfo: GatewaySessionRow | undefined;
  previousRunProjections: ReturnType<typeof getChatSessionProjection>["runs"];
  runProjectionsBeforeApply: ReturnType<typeof getChatSessionProjection>["runs"];
  currentRunProjections: ReturnType<typeof getChatSessionProjection>["runs"];
  resetStream: boolean;
  activeStreamBeforeReset: string | null;
}): void {
  const {
    state,
    run,
    sessionInfo,
    previousRunProjections,
    runProjectionsBeforeApply,
    currentRunProjections,
    resetStream,
    activeStreamBeforeReset,
  } = params;
  const inFlightRunId = run?.runId?.trim();
  if (!inFlightRunId || !run) {
    const terminalRunId = sessionInfo?.lastRunId;
    const knownRun = terminalRunId ? currentRunProjections[terminalRunId] : undefined;
    if (
      terminalRunId &&
      (sessionInfo.status === "done" ||
        sessionInfo.status === "failed" ||
        sessionInfo.status === "timeout") &&
      sessionInfo.hasActiveRun !== true &&
      !isSessionRunActive(sessionInfo) &&
      (!state.chatRunId || state.chatRunId === terminalRunId) &&
      !state.chatQueue.some(
        (item) =>
          item.sendState === "sending" && item.sendRunId && item.sendRunId !== terminalRunId,
      ) &&
      (!knownRun ||
        state.chatRunId === terminalRunId ||
        getChatRunOwner(state) === terminalRunId) &&
      runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)
    ) {
      // A copied row cannot reclaim retired display ownership. The pane retains
      // its accepted owner past active cleanup; unseen runs recover through the
      // reducer, whose full diagnostic wins over the bounded history summary.
      const projection = reduceChatSessionProjection(state, {
        type: "runTerminal",
        runId: terminalRunId,
        status:
          sessionInfo.status === "done"
            ? "completed"
            : sessionInfo.status === "timeout"
              ? "timeout"
              : "error",
        errorMessage: sessionInfo.lastRunError,
      });
      setChatRunOwner(state, terminalRunId);
      const terminal = projection.runs[terminalRunId];
      if (terminal?.errorMessage) {
        if (state.chatRunError?.runId !== terminalRunId || !knownRun?.errorMessage) {
          setChatRunError(state, terminal.errorMessage, terminalRunId);
        }
      } else if (
        terminal?.status === "completed" &&
        state.chatRunError?.runId &&
        state.chatRunError.runId !== terminalRunId
      ) {
        state.chatRunError = null;
      }
      reconcileChatRunFromSessionRow(state, sessionInfo, { publishRunStatus: false });
    }
    return;
  }
  const projectedInFlightRun = currentRunProjections[inFlightRunId];
  const sameRunContinued =
    state.chatRunId === inFlightRunId &&
    projectedInFlightRun?.status === "streaming" &&
    onlyInFlightRunProjectionChanged(previousRunProjections, currentRunProjections, inFlightRunId);
  const retainsLiveStream =
    sameRunContinued ||
    (state.chatRunId === inFlightRunId &&
      (activeStreamBeforeReset !== null ||
        state.chatStreamSegments?.some(
          (segment) => !segment.runId || segment.runId === inFlightRunId,
        )));
  const activeRunIds = sessionInfo?.activeRunIds;
  const inFlightRunIsActive =
    isSessionRunActive(sessionInfo ?? {}) &&
    (!Array.isArray(activeRunIds) || activeRunIds.includes(inFlightRunId)) &&
    (!projectedInFlightRun || projectedInFlightRun.status === "streaming");
  const canAdoptInFlightRun =
    inFlightRunIsActive &&
    ((resetStream &&
      !state.chatRunId &&
      runProjectionsUnchanged(previousRunProjections, runProjectionsBeforeApply)) ||
      sameRunContinued);
  if (canAdoptInFlightRun) {
    // Canonical run projections change on every live delta or terminal.
    // Their identity fences ABA races where a run starts and finishes while
    // history is pending; deltas from this same live run must still merge.
    adoptStartedChatRun(state, inFlightRunId, Date.now());
    state.chatRunSessionAbortable = run?.sessionAbortable === true;
  }
  if (!inFlightRunIsActive || state.chatRunId !== inFlightRunId) {
    return;
  }
  const snapshotStartedAt =
    typeof run.startedAt === "number" && Number.isFinite(run.startedAt) ? run.startedAt : null;
  const liveText = sameRunContinued
    ? mergeInFlightAssistantText(
        resolveInFlightAssistantText(extractText(projectedInFlightRun?.message)),
        activeStreamBeforeReset,
      )
    : activeStreamBeforeReset;
  state.chatStream = mergeInFlightAssistantText(resolveInFlightAssistantText(run.text), liveText);
  state.chatStreamStartedAt = snapshotStartedAt ?? state.chatStreamStartedAt ?? Date.now();
  // A retained pane gets its boundary from session.message. Only fresh adoption
  // reconstructs it from history, with the persisted prefix as cumulative evidence.
  const boundary = retainsLiveStream
    ? null
    : latestPersistedSteerBoundary(state.chatMessages, inFlightRunId);
  const tail =
    state.chatStream === null
      ? null
      : resolveCumulativeAssistantTail(
          state.chatMessages,
          state.chatStream,
          inFlightRunId,
          boundary?.index,
        );
  const prefix = state.chatStream?.slice(0, state.chatStream.length - (tail?.length ?? 0)) ?? "";
  const accumulated = accumulatedStreamText(state.chatStreamSegments ?? []);
  if (boundary || advanceAccumulatedStreamText(accumulated, prefix) !== accumulated) {
    state.chatStreamSegments = [
      ...(state.chatStreamSegments ?? []),
      {
        text: prefix,
        ts: state.chatStreamStartedAt,
        runId: inFlightRunId,
        ...(boundary ? { boundaryRunId: boundary.runId } : {}),
        ...(prefix ? { persisted: true } : { boundaryMarker: true }),
      },
    ];
  }
  const startupPhase = run.events?.findLast((event) => event.stream === "run_status")?.data.phase;
  const hasStartupStatus =
    startupPhase === "preparing_workspace" ||
    startupPhase === "naming_worktree" ||
    startupPhase === "creating_worktree" ||
    startupPhase === "running_setup" ||
    startupPhase === "provisioning_environment" ||
    startupPhase === "preparing_context" ||
    startupPhase === "starting_model";
  state.chatRunStartup =
    hasStartupStatus && !tail && !(sameRunContinued && state.chatRunStartup?.state === "activity")
      ? { state: "status", runId: inFlightRunId, phase: startupPhase }
      : { state: "activity", runId: inFlightRunId };
  // Disconnect cleanup intentionally removes transient activity rows while
  // retaining the owned run. Replay fills that gap; per-identity sequence
  // fences keep a delayed snapshot from replacing newer live progress.
  replayInFlightRunEvents(state, run);
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

function retainedRawHistoryStart(pagination: ChatHistoryPagination): number | null {
  const totalMessages = pagination.totalMessages;
  if (
    typeof totalMessages !== "number" ||
    !Number.isSafeInteger(totalMessages) ||
    totalMessages < 0
  ) {
    return null;
  }
  const retainedDepth = pagination.hasMore ? pagination.nextOffset : totalMessages;
  const start = totalMessages - retainedDepth + 1;
  return Number.isSafeInteger(start) && start > 0 ? start : null;
}

function reconcileLoadedHistoryTail(options: {
  nextMessages: unknown[];
  nextPagination: ChatHistoryPagination;
  nextSessionId: string | null;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): { messages: unknown[]; pagination: ChatHistoryPagination } | null {
  if (
    !options.previousSessionId ||
    options.previousSessionId !== options.nextSessionId ||
    options.previousMessages.length === 0
  ) {
    return null;
  }
  const previousTotal = options.previousPagination.totalMessages;
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
  const message = error === null ? null : formatUiError(error);
  state.lastError = message;
  state.chatError = message;
}

export function chatScopedEventSessionMatches(
  state: ChatState,
  sessionKey: string,
  agentId?: string | null,
): boolean {
  return uiConversationMatches(state, state.sessionKey, sessionKey, agentId);
}

function normalizeSubscriptionKey(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
}

function resolveSelectedGlobalAliasAgentId(
  state: ChatSessionMessageSubscriptionState,
  key: string | null | undefined,
): string | null {
  return resolveUiGlobalAliasAgentId(state, key);
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
    connectionEpoch: number;
    requestedKey: string;
    requestedAgentId?: string | null;
  },
): boolean {
  return (
    getChatHistoryPaneRequests(state).subscriptionGeneration === params.generation &&
    state.client === params.client &&
    state.connectionEpoch === params.connectionEpoch &&
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
  state.chatSessionApprovalQueue = [];
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
  const connectionEpoch = state.connectionEpoch;
  const nextKey = state.sessionKey.trim();
  if (!nextKey) {
    return;
  }
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
  if (selectedAgentChanged) {
    state.chatSessionApprovalQueue = [];
    state.requestUpdate?.();
  }
  const paneRequests = getChatHistoryPaneRequests(state);
  const generation = ++paneRequests.subscriptionGeneration;
  await retryPendingSessionMessageSubscriptionReleases(state);
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
  const isCurrent = () =>
    isCurrentSelectedSessionMessageSubscriptionSync(state, {
      generation,
      client,
      connectionEpoch,
      requestedKey: nextKey,
      requestedAgentId: nextSubscriptionAgentId,
    });
  const clearRecoveredError = () => {
    const message = paneRequests.subscriptionError;
    if (!message || paneRequests.pendingSubscriptionReleases.size > 0) {
      return;
    }
    paneRequests.subscriptionError = undefined;
    for (const field of ["sessionsError", "lastError", "chatError"] as const) {
      if (state[field] === message) {
        state[field] = null;
      }
    }
    state.requestUpdate?.();
  };
  const publishError = (error: unknown) => {
    const message = formatUiError(error);
    paneRequests.subscriptionError = message;
    state.sessionsError = message;
    setChatError(state, message);
    state.requestUpdate?.();
  };
  if (!shouldUnsubscribePrevious && !shouldSubscribe) {
    if (
      isCurrent() &&
      previousSubscription &&
      areUiSessionKeysEquivalent(previousSubscription.key, nextKey) &&
      (previousSubscription.agentId ?? null) === nextSubscriptionAgentId
    ) {
      clearRecoveredError();
    }
    return;
  }
  try {
    let unsubscribePromise: Promise<void> = Promise.resolve();
    if (shouldUnsubscribePrevious && previousSubscription) {
      unsubscribePromise = state.sessions.unsubscribeMessages(previousSubscription);
    }
    const subscribePromise =
      shouldSubscribe && isCurrent()
        ? state.sessions.subscribeMessages(nextKey, {
            agentId: nextSubscriptionAgentId ?? undefined,
            ...(hasOperatorApprovalsAccess(state.hello?.auth ?? null)
              ? { includeApprovals: true }
              : {}),
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
            publishError(
              `${formatUiError(unsubscribeResult.reason)}; replacement release failed: ${formatUiError(replacementReleaseError)}`,
            );
          } else {
            paneRequests.pendingSubscriptionReleases.add(subscribeResult.value);
          }
          return;
        }
      }
      if (isCurrent()) {
        publishError(unsubscribeResult.reason);
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
    if (subscribed.includeApprovals) {
      state.chatSessionApprovalQueue = projectSessionApprovalReplay(
        subscribed.approvalReplay,
        subscribed.key,
        subscribed.agentId ?? undefined,
      );
    } else {
      state.chatSessionApprovalQueue = [];
    }
    clearRecoveredError();
  } catch (err) {
    if (isCurrent()) {
      publishError(err);
    }
  }
}

type LoadChatHistoryOptions = {
  deferBranches?: boolean;
  supersedeInFlight?: boolean;
  startup?: boolean;
};

type SharedChatHistoryResponse = ChatHistoryResponse & {
  sourceCanonicalListRevision?: number;
};

type SharedChatHistoryRequest = {
  consumers: Set<SharedChatHistoryConsumer>;
  promise: Promise<SharedChatHistoryResponse>;
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
  cursor?: string,
): Promise<ChatHistoryResponse> {
  for (;;) {
    try {
      return await client.request<ChatHistoryResponse>(method, {
        sessionKey,
        ...(requestAgentId ? { agentId: requestAgentId } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        limit: CHAT_HISTORY_REQUEST_LIMIT,
      });
    } catch (err) {
      if (!shouldContinue()) {
        throw err;
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
  cursor?: string,
  sourceCanonicalListRevision?: number,
): Promise<SharedChatHistoryResponse> {
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
      cursor,
    )
      .then((response) => ({ ...response, sourceCanonicalListRevision }))
      .finally(() => {
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

type ChatSessionSnapshotRequestResult =
  | { kind: "snapshot"; snapshot: ChatSessionSnapshot }
  | ChatHistoryDeltaResult
  | ChatHistoryResetResult;

export async function requestChatSessionSnapshot(
  client: GatewayBrowserClient,
  sessionKey: string,
  consumerOwner: object,
  isCurrentConsumer: () => boolean,
  cursor?: string,
): Promise<ChatSessionSnapshotRequestResult> {
  const method = "chat.history";
  const requestModeKey = cursor === undefined ? "page" : `cursor:${cursor}`;
  const requestKey = `prefetch\u0000${method}\u0000${sessionKey}\u0000${CHAT_HISTORY_REQUEST_LIMIT}\u0000${requestModeKey}`;
  const result = await requestSharedChatHistory(
    client,
    requestKey,
    method,
    sessionKey,
    undefined,
    consumerOwner,
    isCurrentConsumer,
    cursor,
  );
  if (isChatHistoryCursorResult(result)) {
    return result;
  }
  const sessionInfo = result.sessionInfo;
  return {
    kind: "snapshot",
    snapshot: {
      ...(result.deltaCursor !== undefined ? { deltaCursor: result.deltaCursor } : {}),
      ...(Object.hasOwn(sessionInfo ?? {}, "activeLeafEntryId")
        ? { displayedLeafEntryId: sessionInfo?.activeLeafEntryId?.trim() || null }
        : {}),
      messages: visibleChatHistoryMessages(result.messages),
      pagination: resolveChatHistoryPagination(result),
      sessionId: resolveChatHistorySessionId(result),
    },
  };
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

export function commitCurrentChatHistorySnapshot(
  state: ChatState,
  deltaCursor?: string | null,
): void {
  if (!state.chatMessagesBySession) {
    return;
  }
  const sessionKey = state.sessionKey;
  const agentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const cachedDeltaCursor =
    deltaCursor === undefined
      ? readChatSessionSnapshot(state.chatMessagesBySession, state, {
          sessionKey,
          agentId,
        })?.deltaCursor
      : (deltaCursor ?? undefined);
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    {
      ...(cachedDeltaCursor !== undefined ? { deltaCursor: cachedDeltaCursor } : {}),
      ...(state.chatDisplayedLeafEntryId !== undefined
        ? { displayedLeafEntryId: state.chatDisplayedLeafEntryId }
        : {}),
      messages: state.chatMessages,
      pagination: state.chatHistoryPagination,
      sessionId: state.currentSessionId ?? null,
    },
  );
}

function clearCachedChatDeltaCursor(state: ChatState, sessionKey: string, agentId?: string): void {
  if (!state.chatMessagesBySession) {
    return;
  }
  const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey,
    agentId,
  });
  if (snapshot?.deltaCursor === undefined) {
    return;
  }
  const { deltaCursor: _deltaCursor, ...withoutCursor } = snapshot;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    withoutCursor,
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
      setChatError(state, formatUiError(err));
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
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const connectionIsCurrent = () =>
    state.connected && state.client === client && state.connectionEpoch === connectionEpoch;
  const viewMatches = () => visibleSessionMatches(state, sessionKey, agentParams.agentId);
  const viewIsCurrent = () => connectionIsCurrent() && viewMatches();
  try {
    const result = await state.sessions.rewind(sessionKey, entryId, agentParams);
    const editorText = result.editorText ?? "";
    if (state.chatMessagesBySession) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, {
        sessionKey,
        agentId: agentParams.agentId,
      });
    }
    if (connectionIsCurrent()) {
      persistChatComposerState(state, sessionKey, {
        agentId: agentParams.agentId,
        draft: editorText,
      });
    }
    if (!viewMatches()) {
      return null;
    }
    resetChatHistoryProjection(state, agentParams.agentId);
    await Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    if (!viewIsCurrent()) {
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
    if (viewIsCurrent()) {
      setChatError(state, formatUiError(error));
      scheduleChatScroll(state);
    }
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
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const connectionIsCurrent = () =>
    state.connected && state.client === client && state.connectionEpoch === connectionEpoch;
  const viewMatches = () => visibleSessionMatches(state, sessionKey, agentParams.agentId);
  const viewIsCurrent = () => connectionIsCurrent() && viewMatches();
  try {
    await state.sessions.switchBranch(sessionKey, leafEntryId, agentParams);
    if (state.chatMessagesBySession) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, {
        sessionKey,
        agentId: agentParams.agentId,
      });
    }
    if (!viewMatches()) {
      return false;
    }
    resetChatHistoryProjection(state, agentParams.agentId);
    await Promise.all([loadChatHistory(state), loadChatBranches(state)]);
    return viewIsCurrent();
  } catch (error) {
    if (viewIsCurrent()) {
      setChatError(state, formatUiError(error));
      scheduleChatScroll(state);
    }
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
  const sessionKey = state.sessionKey;
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const startup = opts.startup === true;
  const requests = getChatHistoryPaneRequests(state);
  if (!state.client || !state.connected) {
    requests.historyLoad = { phase: "pending-connection", sessionKey, requestAgentId, startup };
    state.chatLoading = true;
    state.requestUpdate?.();
    return undefined;
  }
  const method = startup ? "chat.startup" : "chat.history";
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const deltaCursor = state.chatMessagesBySession
    ? readChatSessionSnapshot(state.chatMessagesBySession, state, {
        sessionKey,
        agentId: requestAgentId,
      })?.deltaCursor
    : undefined;
  const requestModeKey = deltaCursor === undefined ? "page" : `cursor:${deltaCursor}`;
  const requestKey = `${connectionEpoch}\u0000${method}\u0000${sessionKey}\u0000${requestAgentId ?? ""}\u0000${CHAT_HISTORY_REQUEST_LIMIT}\u0000${requestModeKey}`;
  const inFlight = requests.historyLoad;
  // Live events replace the rendered array while their snapshot is pending;
  // only stable session and connection ownership may start another request.
  if (
    opts.supersedeInFlight !== true &&
    inFlight.phase === "in-flight" &&
    inFlight.key === requestKey &&
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
    deltaCursor,
  ).then((result) => {
    const current = requests.historyLoad;
    if (current.phase === "in-flight" && current.promise === promise) {
      if (result) {
        requests.historyLoad = {
          phase: "committed",
          key: `${sessionKey}\u0000${requestAgentId ?? ""}`,
        };
      } else if (
        state.sessionKey === sessionKey &&
        (!isUiSelectedGlobalSessionKey(state, sessionKey) ||
          resolveUiSelectedSessionAgentId(state) === requestAgentId) &&
        (!state.connected ||
          current.client !== state.client ||
          current.connectionEpoch !== state.connectionEpoch)
      ) {
        requests.historyLoad = {
          phase: "pending-connection",
          sessionKey,
          requestAgentId,
          startup,
        };
        state.chatLoading = true;
      } else {
        requests.historyLoad = { phase: "idle" };
        state.chatLoading = false;
      }
      state.requestUpdate?.();
    }
    return result;
  });
  requests.historyLoad = {
    phase: "in-flight",
    client,
    connectionEpoch,
    key: requestKey,
    promise,
    sessionKey,
    requestAgentId,
    startup,
  };
  return promise;
}

export function resumePendingChatHistoryLoad(
  state: ChatState,
): Promise<ChatHistoryResult | undefined> | undefined {
  const load = getChatHistoryLoadState(state);
  if (load.phase === "pending-connection" || (load.phase === "failed" && load.retryable)) {
    return loadChatHistory(state, { startup: load.startup, deferBranches: true });
  }
  return undefined;
}

export function retryChatHistoryLoad(
  state: ChatState,
): Promise<ChatHistoryResult | undefined> | undefined {
  const load = getChatHistoryLoadState(state);
  if (load.phase !== "failed") {
    return undefined;
  }
  const retry = loadChatHistory(state, { startup: load.startup });
  state.requestUpdate?.();
  return retry;
}

async function requestOlderChatHistoryPage(
  client: GatewayBrowserClient,
  sessionKey: string,
  requestAgentId: string | undefined,
  offset: number,
): Promise<ChatHistoryResult> {
  const result = await client.request<ChatHistoryResult>("chat.history", {
    sessionKey,
    ...(requestAgentId ? { agentId: requestAgentId } : {}),
    limit: CHAT_HISTORY_OLDER_PAGE_LIMIT,
    offset,
  });
  return {
    ...result,
    messages: visibleChatHistoryMessages(result.messages),
  };
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
  const result = await requestOlderChatHistoryPage(client, sessionKey, requestAgentId, offset);
  if (!shouldApplyChatHistoryResult(state, ownership)) {
    return undefined;
  }
  return result;
}

export type StagedOlderHistoryPage = {
  claim: {
    client: GatewayBrowserClient;
    connectionEpoch: number;
    sessionKey: string;
    agentId?: string;
    /** Projection fence: any later history request or reset (tail reload,
     * rewind, branch switch) advances the version and voids this page even
     * when the replacement projection lands on the same cursor. */
    historyVersion: number;
  };
  requestedOffset: number;
  result: ChatHistoryResult;
};

// The staged prefetch deliberately skips beginChatHistoryRequest: request
// ownership is last-writer-wins, so a background fetch bumping the version
// could invalidate a concurrent tail load's apply. The claim below carries the
// same facts and the pane validates it at consume time instead.
export async function fetchStagedOlderHistoryPage(
  state: ChatState,
  offset: number,
): Promise<StagedOlderHistoryPage | undefined> {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const sessionKey = state.sessionKey;
  const historyVersion = getChatHistoryPaneRequests(state).historyVersion;
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const result = await requestOlderChatHistoryPage(client, sessionKey, requestAgentId, offset);
  return {
    claim: {
      client,
      connectionEpoch,
      sessionKey,
      historyVersion,
      ...(requestAgentId ? { agentId: requestAgentId } : {}),
    },
    requestedOffset: offset,
    result,
  };
}

/** A staged page is valid only for the exact connection, session, and the
 * pagination cursor it was fetched at; any drift means the reactive path must
 * refetch (tail reloads rebase offsets, resets reuse session keys). */
export function isStagedOlderHistoryPageCurrent(
  state: ChatState,
  staged: StagedOlderHistoryPage,
): boolean {
  const claim = staged.claim;
  const pagination = state.chatHistoryPagination;
  return (
    state.client === claim.client &&
    state.connected &&
    state.connectionEpoch === claim.connectionEpoch &&
    getChatHistoryPaneRequests(state).historyVersion === claim.historyVersion &&
    state.sessionKey === claim.sessionKey &&
    (!isUiSelectedGlobalSessionKey(state, claim.sessionKey) ||
      resolveUiSelectedSessionAgentId(state) === claim.agentId) &&
    pagination.hasMore &&
    pagination.nextOffset === staged.requestedOffset
  );
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
  deltaCursor: string | undefined,
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
  const previousRunProjections = readChatRunProjections(state, sessionKey, requestAgentId);
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
    const requestModeKey = deltaCursor === undefined ? "page" : `cursor:${deltaCursor}`;
    const requestKey = `${connectionEpoch}\u0000${method}\u0000${sessionKey}\u0000${requestAgentId ?? ""}\u0000${CHAT_HISTORY_REQUEST_LIMIT}\u0000${requestModeKey}`;
    let response = await requestSharedChatHistory(
      client,
      requestKey,
      method,
      sessionKey,
      requestAgentId,
      state,
      () => shouldApplyChatHistoryResult(state, ownership),
      deltaCursor,
      state.sessions?.canonicalListRevision,
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
    if (isChatHistoryCursorResult(response) && response.kind === "reset") {
      clearCachedChatDeltaCursor(state, sessionKey, requestAgentId);
      const pageRequestKey = `${connectionEpoch}\u0000${method}\u0000${sessionKey}\u0000${requestAgentId ?? ""}\u0000${CHAT_HISTORY_REQUEST_LIMIT}\u0000page`;
      response = await requestSharedChatHistory(
        client,
        pageRequestKey,
        method,
        sessionKey,
        requestAgentId,
        state,
        () => shouldApplyChatHistoryResult(state, ownership),
        undefined,
        state.sessions?.canonicalListRevision,
      );
      if (!shouldApplyChatHistoryResult(state, ownership)) {
        recordChatHistoryTiming(state, "stale", startedAtMs, {
          requestSessionKey: sessionKey,
          requestAgentId,
          previousRunId,
          reason: "reset-fallback-version",
        });
        return undefined;
      }
    }
    if (isChatHistoryCursorResult(response) && response.kind === "delta") {
      const runProjectionsBeforeApply = readChatRunProjections(state, sessionKey, requestAgentId);
      const activeStreamBeforeApply = state.chatRunId ? state.chatStream : null;
      const runActive = isSessionRunActive(response.sessionInfo);
      for (const payload of response.messages) {
        applySessionMessagePayload(state, payload, runActive, { kind: "history-delta" });
      }
      const historyProjection = getChatSessionProjection(state, state.chatMessages);
      if (Object.hasOwn(response.sessionInfo, "activeLeafEntryId")) {
        state.chatDisplayedLeafEntryId = response.sessionInfo.activeLeafEntryId?.trim() || null;
      }
      state.currentSessionId = response.sessionInfo.sessionId?.trim() || previousSessionId;
      applyChatPendingInputs(state, response.pendingInputs);
      // An accepted delta advances the same transcript generation, not a branch replacement.
      // Carry ownership across its leaf advance; reseeding loses attributed pending sends and runs.
      setChatSessionProjection(state, {
        ...historyProjection,
        scope: { ...historyProjection.scope, ...readChatSessionProjectionScope(state) },
      });
      state.chatThinkingLevel = response.sessionInfo.thinkingLevel ?? null;
      state.chatQueueModeOverride = response.sessionInfo.queueMode;
      state.chatEffectiveQueueMode = response.sessionInfo.effectiveQueueMode;
      applyHistoryRunSnapshot({
        state,
        run: response.inFlightRun,
        sessionInfo: response.sessionInfo,
        previousRunProjections,
        runProjectionsBeforeApply,
        currentRunProjections: historyProjection.runs,
        resetStream: !state.chatRunId || state.chatRunId === previousRunId,
        activeStreamBeforeReset: activeStreamBeforeApply,
      });
      commitCurrentChatHistorySnapshot(state, response.deltaCursor ?? null);
      recordChatHistoryTiming(state, "applied", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        messageCount: response.messages.length,
        visibleMessageCount: response.messages.length,
        resetStream: false,
      });
      return {
        messages: state.chatMessages,
        deltaCursor: response.deltaCursor,
        pendingInputs: response.pendingInputs,
        sessionInfo: response.sessionInfo,
        ...(response.inFlightRun ? { inFlightRun: response.inFlightRun } : {}),
        ...(response.metadata ? { metadata: response.metadata } : {}),
        sourceCanonicalListRevision: response.sourceCanonicalListRevision,
      };
    }
    if (isChatHistoryCursorResult(response)) {
      throw new Error("chat history page request returned a cursor reset");
    }
    const res = response;
    // Fence concurrent run lifecycle before applying the response. A remount
    // may replace the map itself, so compare its canonical run entries.
    const runProjectionsBeforeApply = readChatRunProjections(state, sessionKey, requestAgentId);
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const nextPagination = resolveChatHistoryPagination(res);
    const nextSessionId = resolveChatHistorySessionId(res);
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
    state.chatHistoryPagination = reconciledHistory?.pagination ?? nextPagination;
    state.currentSessionId = nextSessionId;
    applyChatPendingInputs(state, res.pendingInputs);
    commitCurrentChatHistorySnapshot(state, res.deltaCursor ?? null);
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
      pruneHistoryReplacedStreamSegments(state.chatMessages, state, streamReconciliation);
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
        if (state.chatRunId && historyReplacedStream) {
          rolloverChatStream(state, { runId: state.chatRunId, persisted: true });
        }
        if (liveToolStreamReplaced) {
          maybeResetToolStream(state, { preserveStreamSegments: state.chatRunId !== null });
        } else {
          prunePersistedToolStreamMessages(state, persistedToolStreamIds);
        }
        if (!state.chatRunId) {
          state.chatStream = null;
          state.chatStreamStartedAt = null;
        }
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
      } else if (historyReplacedSomeToolStream) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
          includeCurrent: false,
          requirePersistedTool: !historyReplacedToolStream,
          persistCommentary: true,
        });
        if (!visibleCurrentAssistantStreamTail(state, streamReconciliation.isHiddenStreamText)) {
          state.chatStreamStartedAt = null;
        }
        pruneHistoryReplacedStreamSegments(state.chatMessages, state, streamReconciliation);
        if (historyReplacedToolStream) {
          maybeResetToolStream(state, { preserveStreamSegments: true });
        } else {
          prunePersistedToolStreamMessages(state, persistedToolStreamIds);
        }
      }
    }

    applyHistoryRunSnapshot({
      state,
      run: res.inFlightRun,
      sessionInfo: res.sessionInfo,
      previousRunProjections,
      runProjectionsBeforeApply,
      currentRunProjections: historyProjection.runs,
      resetStream,
      activeStreamBeforeReset,
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
    const missingReadScope = isMissingOperatorReadScopeError(err);
    if (missingReadScope) {
      resetChatHistoryProjection(state, requestAgentId);
      state.chatThinkingLevel = null;
      state.chatVerboseLevel = null;
    }
    getChatHistoryPaneRequests(state).historyLoad = {
      phase: "failed",
      sessionKey,
      requestAgentId,
      startup: method === "chat.startup",
      message: missingReadScope
        ? formatMissingOperatorReadScopeMessage("existing chat history")
        : formatUiError(err),
      retryable: err instanceof GatewayRequestError && err.retryable,
    };
    state.requestUpdate?.();
  } finally {
    if (ownsChatHistoryRequest(state, ownership)) {
      state.chatLoading = false;
    }
  }
  return undefined;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
