import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { fireFirstReplyConfetti } from "../../components/confetti.ts";
import { isGitHubPullRequestLink } from "../../components/github-link-target.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { pickFreshestObserverDigest } from "../../lib/observer-digest.ts";
import {
  isStructuralSessionMutationReason,
  readSessionChangedEvent,
  type SessionChangedResult,
} from "../../lib/sessions/reconcile.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import {
  chatScopedEventSessionMatches,
  isHiddenAssistantStreamText,
  loadChatBranches,
  loadChatHistory,
  shouldHideAssistantChatMessage,
} from "./chat-history.ts";
import {
  readDeliveredQueuedChatSendForRun,
  removeDeliveredQueuedChatSendForRun,
} from "./chat-queue.ts";
import { flushChatQueueForEvent, resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { recordChatSendServerTiming } from "./chat-send-timing.ts";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { requestChatPageUpdate } from "./chat-state-render.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { handleBackgroundTasksEvent } from "./components/chat-background-tasks.ts";
import {
  refreshSessionWorkspace,
  retireSessionWorkspaceCheckout,
} from "./components/chat-session-workspace.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import {
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
  reconcileStaleChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import {
  preserveQueuedUserTurn,
  retirePersistedSteeredChips,
  retireSteeredChipsForTerminalRun,
} from "./steer-lifecycle.ts";
import { isAckedSteeredChip } from "./steered-chip.ts";
import { rememberAuthoritativeTerminal } from "./terminal-message-identity.ts";
import { handleAgentEvent, handleSessionOperationEvent } from "./tool-stream.ts";

function sessionMessageMatchesChat(
  state: ChatPageHost,
  event: NonNullable<ReturnType<typeof readSessionChangedEvent>>,
): boolean {
  return chatScopedEventSessionMatches(state, event.key, event.agentId ?? undefined);
}

function selectedGlobalEventAgentId(state: ChatPageHost, agentId: string | null): string {
  return agentId ? normalizeAgentId(agentId) : resolveUiDefaultAgentId(state);
}

function globalSessionEventMatchesChat(
  state: ChatPageHost,
  event: NonNullable<ReturnType<typeof readSessionChangedEvent>>,
): boolean {
  if (!isUiGlobalSessionKey(event.key)) {
    return true;
  }
  const selectedAgentId = isUiGlobalSessionKey(state.sessionKey)
    ? resolveUiSelectedGlobalAgentId(state)
    : resolveUiGlobalAliasAgentId(state, state.sessionKey);
  return selectedAgentId
    ? selectedGlobalEventAgentId(state, event.agentId) === selectedAgentId
    : true;
}

function reconcileSessionEvent(state: ChatPageHost, payload: unknown): SessionChangedResult {
  const selectedAgentId = resolveChatAgentId(state);
  const reconciled = state.sessions.reconcileChanged(payload, {
    resultAgentId: state.sessionsResultAgentId ?? selectedAgentId,
    selectedGlobalAgentId: selectedAgentId,
    archivedFilter: state.sessionsArchivedFilter,
  });
  if (reconciled.applied) {
    state.sessionsResult = state.sessions.state.result;
    state.sessionsResultAgentId = state.sessions.state.agentId;
    state.sessionsError = state.sessions.state.error;
    reconcileStaleChatRunAfterSessionStatePublication(state);
  }
  return reconciled;
}

function finishSessionMessageRunReconcile(
  state: ChatPageHost,
  sessionKey: string,
  runId: string | null,
  row: SessionChangedResult["row"] | undefined,
): boolean {
  const cleared = row
    ? reconcileChatRunFromSessionRow(state, row, { publishRunStatus: true })
    : reconcileChatRunFromCurrentSessionRow(state, { publishRunStatus: true });
  if (!cleared) {
    return false;
  }
  retireSteeredChipsForTerminalRun(state, runId ?? undefined);
  void loadChatHistory(state)
    .finally(() => {
      if (!areUiSessionKeysEquivalent(state.sessionKey, sessionKey)) {
        return;
      }
      void flushChatQueueForEvent(state);
      state.requestUpdate?.();
    })
    .catch(() => undefined);
  return true;
}

function handleSessionMessageEvent(state: ChatPageHost, payload: unknown) {
  const event = readSessionChangedEvent(payload);
  if (!event || !globalSessionEventMatchesChat(state, event)) {
    return;
  }
  const matchesChat = sessionMessageMatchesChat(state, event);
  if (matchesChat) {
    // A previous run can persist its final after the next local run starts.
    // Admit that sequenced row now so the later unsequenced chat.final replay
    // replaces it in place instead of appending below the newer user turn.
    applySessionMessagePayload(state, payload, event.hasActiveRun ?? undefined, {
      kind: "live",
      activeRunId: state.chatRunId,
    });
    retirePersistedSteeredChips(state);
  }
  if (matchesChat && event.archived !== null) {
    state.selectedChatSessionArchived = event.archived;
  }
  const runIdBeforeApply = state.chatRunId;
  rememberAuthoritativeTerminal({ event, host: state, matchesChat, payload, runIdBeforeApply });
  const result = reconcileSessionEvent(state, payload);
  if (runIdBeforeApply && matchesChat) {
    const runId = event.clientRunId ?? event.runId ?? runIdBeforeApply;
    state.pendingSessionMessageReloadSessionKey = event.key;
    if (event.hasActiveRun === true) {
      return;
    }
    if (finishSessionMessageRunReconcile(state, event.key, runId, result.row)) {
      state.pendingSessionMessageReloadSessionKey = null;
      return;
    }
    void refreshCurrentChatSessionList(state).then(() => {
      if (!state.pendingSessionMessageReloadSessionKey || state.chatRunId !== runIdBeforeApply) {
        return;
      }
      if (
        finishSessionMessageRunReconcile(
          state,
          state.pendingSessionMessageReloadSessionKey,
          runId,
          undefined,
        )
      ) {
        state.pendingSessionMessageReloadSessionKey = null;
      }
    });
    return;
  }
  if (matchesChat) {
    state.pendingSessionMessageReloadSessionKey = null;
    void loadChatHistory(state).finally(() => state.requestUpdate?.());
  }
}

function replayPendingSessionMessageReload(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
) {
  const pendingSessionKey = state.pendingSessionMessageReloadSessionKey;
  const payloadSessionKey = payload?.sessionKey?.trim();
  if (
    !pendingSessionKey ||
    !payloadSessionKey ||
    !areUiSessionKeysEquivalent(pendingSessionKey, payloadSessionKey) ||
    !areUiSessionKeysEquivalent(payloadSessionKey, state.sessionKey) ||
    state.chatRunId
  ) {
    return;
  }
  state.pendingSessionMessageReloadSessionKey = null;
  void loadChatHistory(state).finally(() => state.requestUpdate?.());
}

function handleSessionsChangedEvent(state: ChatPageHost, payload: unknown) {
  const runIdBeforeApply = state.chatRunId;
  const event = readSessionChangedEvent(payload);
  const matchesChat = Boolean(
    event && globalSessionEventMatchesChat(state, event) && sessionMessageMatchesChat(state, event),
  );
  const source = asNullableRecord(payload);
  const resetsSession = source?.reason === "reset" || source?.phase === "reset";
  if (event && (resetsSession || source?.reason === "new")) {
    state.retireSessionCompanion?.(event.key, event.agentId);
  }
  const resetsSelectedSession = matchesChat && resetsSession;
  if (resetsSelectedSession) {
    const scope = readChatSessionProjectionScope(state, { agentId: resolveChatAgentId(state) });
    // Reset keeps the public session ID; the explicit reducer event is the
    // only proof that its old live and pending transcript no longer exists.
    reduceChatSessionProjection(state, { type: "sessionReset" }, { scope });
  }
  if (matchesChat && isStructuralSessionMutationReason(source?.reason)) {
    state.chatBranches = [];
    state.chatBranchesSessionKey = null;
    state.chatBranchesConnectionEpoch = null;
    retireSessionWorkspaceCheckout(state);
    void loadChatBranches(state);
  }
  if (event && matchesChat && event.archived !== null) {
    state.selectedChatSessionArchived = event.archived;
  }
  const result = reconcileSessionEvent(state, payload);
  if (resetsSelectedSession) {
    void loadChatHistory(state).finally(() => state.requestUpdate?.());
    return;
  }
  if (
    matchesChat &&
    source?.phase === "message" &&
    source.message === undefined &&
    source.messageId === undefined &&
    source.messageSeq === undefined
  ) {
    // Legacy multi-message writes cannot prove individual message cursors.
    // One scoped authoritative snapshot recovers them without ending a run.
    void loadChatHistory(state).finally(() => state.requestUpdate?.());
    return;
  }
  if (
    result.applied &&
    event &&
    runIdBeforeApply &&
    matchesChat &&
    finishSessionMessageRunReconcile(
      state,
      event.key,
      event.clientRunId ?? event.runId ?? runIdBeforeApply,
      result.row,
    )
  ) {
    return;
  }
  if (!result.applied && event?.isChatTurn !== true) {
    void refreshCurrentChatSessionList(state);
  }
}

const GITHUB_URL_CANDIDATE = /https:\/\/github\.com\/[^\s<>()\]}'"`]+/giu;

function terminalOwnsActiveChatStream(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
): boolean {
  return typeof payload?.runId === "string" && payload.runId === state.chatRunId;
}

function pullRequestLinksIn(text: unknown): string[] {
  if (typeof text !== "string" || !text.includes("github.com")) {
    return [];
  }
  const links: string[] = [];
  for (const match of text.matchAll(GITHUB_URL_CANDIDATE)) {
    const href = match[0].replace(/[.,;:!?]+$/u, "");
    if (isGitHubPullRequestLink(href)) {
      links.push(href);
    }
  }
  return links;
}

function finalAssistantReplyHasPullRequestLink(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
): boolean {
  if (payload?.state !== "final") {
    return false;
  }
  const texts = [extractText(payload.message)];
  if (terminalOwnsActiveChatStream(state, payload)) {
    texts.push(
      state.chatStream,
      ...(state.chatStreamSegments ?? []).map((segment) => segment.text),
    );
  }
  return texts.some((text) => pullRequestLinksIn(text).length > 0);
}

// Bounds the refreshed-run set; clearing at worst re-fires one refresh per run.
const STREAM_PR_REFRESH_RUN_LIMIT = 200;
// Longest URL prefix worth carrying across delta chunks. GitHub caps owners at
// 39 and repos at 100 chars, so a maximal PR URL is ~175 chars; 256 covers it.
const STREAM_PR_LINK_TAIL_CHARS = 256;

/**
 * A PR created or merged mid-turn should surface a chip right away instead of
 * waiting for the terminal reply or the minute poll, so the first streamed
 * sighting of a PR link forces one chips refresh. At most one per run: the
 * refresh reloads all of the branch's PRs regardless of which link fired it,
 * so more links in the same run add GitHub quota cost without information,
 * while a later run announcing a state change (created -> merged) refreshes
 * again. Deltas are arbitrary fragments, so a short rolling tail rejoins URLs
 * split across chunks; a link the tail still misses is caught by the
 * final-reply trigger. That terminal trigger intentionally refreshes again
 * even after a stream refresh — state often changes between the announcement
 * and the end of the turn (created -> merged) — bounding forced refreshes at
 * two per run, coalesced by the gateway while one is in flight.
 */
function refreshPullRequestsForStreamedLinks(
  state: ChatPageHost,
  payload: ChatEventPayload,
  deltaText: string,
): void {
  const scope = `${payload.sessionKey}|${payload.runId ?? ""}`;
  const tail = state.streamPullRequestTail;
  // The tail is scoped like the refresh: joining across runs would falsely
  // complete split URLs.
  const joined = (tail?.scope === scope ? tail.text : "") + deltaText;
  state.streamPullRequestTail = { scope, text: joined.slice(-STREAM_PR_LINK_TAIL_CHARS) };
  const seen = (state.streamPullRequestRefreshKeys ??= new Set());
  if (seen.has(scope) || pullRequestLinksIn(joined).length === 0) {
    return;
  }
  if (seen.size > STREAM_PR_REFRESH_RUN_LIMIT) {
    seen.clear();
  }
  seen.add(scope);
  void state.refreshSessionPullRequests?.({ refresh: true });
}

function hasVisibleFinalAssistantReply(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
): boolean {
  if (payload?.state !== "final") {
    return false;
  }
  const ownsReply =
    chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId) ||
    (typeof payload.runId === "string" && payload.runId === state.chatRunId);
  if (!ownsReply) {
    return false;
  }
  const finalText = extractText(payload.message);
  if (
    typeof finalText === "string" &&
    finalText.trim().length > 0 &&
    !isHiddenAssistantStreamText(finalText) &&
    !shouldHideAssistantChatMessage(payload.message)
  ) {
    return true;
  }
  if (!terminalOwnsActiveChatStream(state, payload)) {
    return false;
  }
  return [
    state.chatStream,
    ...(state.chatStreamSegments ?? []).map((segment) => segment.text),
  ].some(
    (text) =>
      typeof text === "string" && text.trim().length > 0 && !isHiddenAssistantStreamText(text),
  );
}

function observerDigestMatchesAuthoritativeRun(
  state: ChatPageHost,
  digest: SessionObserverDigest,
): boolean {
  if (state.chatRunId) {
    return digest.runId === state.chatRunId;
  }
  const session = selectedChatSessionRow(state);
  return Boolean(
    session?.hasActiveRun && digest.runId && session.activeRunIds?.includes(digest.runId),
  );
}

export function handlePageGatewayEvent(state: ChatPageHost, event: GatewayEventFrame) {
  if (event.event === "chat") {
    const payload = event.payload as ChatEventPayload | undefined;
    if (
      payload?.state === "delta" &&
      typeof payload.runId === "string" &&
      chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId) &&
      // Same-session background streams cannot clear the foreground run's status.
      (!state.chatRunId || state.chatRunId === payload.runId) &&
      state.observerDigest &&
      state.observerDigest.runId !== payload.runId
    ) {
      state.observerDigest = null;
    }
    if (
      payload?.state === "delta" &&
      typeof payload.deltaText === "string" &&
      chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId)
    ) {
      refreshPullRequestsForStreamedLinks(state, payload, payload.deltaText);
    }
    const shouldCelebrateFirstReply = hasVisibleFinalAssistantReply(state, payload);
    const shouldRefreshPullRequests =
      shouldCelebrateFirstReply && finalAssistantReplyHasPullRequestLink(state, payload);
    const terminal =
      payload?.state === "final" || payload?.state === "aborted" || payload?.state === "error";
    const delivered = terminal ? rememberDeliveredQueuedUserTurn(state, payload?.runId) : null;
    if (delivered) {
      // The queued projection is the only local copy until history catches up.
      // Materialize it before the terminal assistant to preserve transcript order.
      preserveQueuedUserTurn(state, delivered);
    }
    const result = handleChatGatewayEvent(state, payload);
    if (shouldCelebrateFirstReply && result === "final") {
      fireFirstReplyConfetti();
    }
    if (shouldRefreshPullRequests) {
      void state.refreshSessionPullRequests?.({ refresh: true });
    }
    replayPendingSessionMessageReload(state, payload);
    if (terminal) {
      removeDeliveredQueuedChatSendForRun(state, payload?.runId);
      void resumeStoredChatOutboxes(state);
      if (chatScopedEventSessionMatches(state, payload?.sessionKey, payload?.agentId)) {
        refreshSessionWorkspace(state);
      }
    }
    requestChatPageUpdate(state, payload?.state === "delta" ? "animation-frame" : "immediate");
    return;
  }
  if (event.event === "session.observer") {
    const payload = event.payload as SessionObserverDigest | undefined;
    if (
      !payload ||
      !chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId) ||
      !observerDigestMatchesAuthoritativeRun(state, payload)
    ) {
      return;
    }
    const previous = state.observerDigest;
    if (
      previous?.runId === payload.runId &&
      pickFreshestObserverDigest(previous, payload) === previous
    ) {
      return;
    }
    state.observerDigest = payload;
    requestChatPageUpdate(state);
    return;
  }
  if (event.event === "agent" || event.event === "session.tool") {
    if (handleAgentEvent(state as never, event.payload as never)) {
      requestChatPageUpdate(state);
    }
    return;
  }
  if (event.event === "session.operation") {
    handleSessionOperationEvent(state as never, event.payload as never);
    requestChatPageUpdate(state);
    return;
  }
  if (event.event === "chat.send_timing") {
    recordChatSendServerTiming(state, event.payload);
    return;
  }
  if (event.event === "session.message") {
    handleSessionMessageEvent(state, event.payload);
    void resumeStoredChatOutboxes(state);
    requestChatPageUpdate(state);
    return;
  }
  if (event.event === "sessions.changed") {
    handleSessionsChangedEvent(state, event.payload);
    void resumeStoredChatOutboxes(state);
    requestChatPageUpdate(state);
    return;
  }
  if (event.event === "task") {
    handleBackgroundTasksEvent(state, event.payload);
  }
}

const MAX_REMEMBERED_DELIVERED_QUEUE_TURNS = 64;
const deliveredQueueTurnsByClient = new WeakMap<object, Map<string, ChatQueueItem>>();

function rememberDeliveredQueuedUserTurn(
  state: ChatPageHost,
  runId: string | undefined,
): ChatQueueItem | null {
  if (!runId) {
    return null;
  }
  // Every split pane receives the same Gateway event. Keep a bounded delivery
  // handoff so an inactive pane cannot retire the durable row before its owner
  // converts the queued projection into a transcript message.
  const owner = state.client ?? state;
  let turns = deliveredQueueTurnsByClient.get(owner);
  if (!turns) {
    turns = new Map();
    deliveredQueueTurnsByClient.set(owner, turns);
  }
  const pending = state.chatQueue.find(
    (item) => isAckedSteeredChip(item) && item.pendingRunId === runId,
  );
  const stored = readDeliveredQueuedChatSendForRun(state, runId)?.item;
  if (stored) {
    turns.delete(runId);
    turns.set(runId, stored);
    while (turns.size > MAX_REMEMBERED_DELIVERED_QUEUE_TURNS) {
      const oldestRunId = turns.keys().next().value;
      if (typeof oldestRunId !== "string") {
        break;
      }
      turns.delete(oldestRunId);
    }
  }
  // Original-turn copies first: a run can own both its queued turn (stored, or
  // its remembered fallback in `turns`) and a steered follow-up chip; the chip
  // is preserved separately by retireSteeredChipsForTerminalRun and must not
  // mask the original copy here.
  return stored ?? turns.get(runId) ?? pending ?? null;
}
