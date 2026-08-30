import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { fireFirstReplyConfetti } from "../../components/confetti.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-store.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { pickFreshestObserverDigest } from "../../lib/observer-digest.ts";
import {
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
import { sleep } from "./chat-history-retry.ts";
import {
  chatScopedEventSessionMatches,
  isHiddenAssistantStreamText,
  loadChatBranches,
  loadChatHistory,
  retireChatBranchRequests,
  shouldHideAssistantChatMessage,
} from "./chat-history.ts";
import {
  pullRequestLinksIn,
  refreshPullRequestsForStreamedLinks,
} from "./chat-pull-request-refresh.ts";
import {
  clearPendingQueueItemsForRun,
  readDeliveredQueuedChatSendForRun,
  removeDeliveredQueuedChatSendForRun,
} from "./chat-queue.ts";
import { flushChatQueueForEvent, resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { preserveQueuedUserTurn } from "./chat-send-support.ts";
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
import {
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import {
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
  reconcileChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import { reconcileSessionApprovalEvent } from "./session-approval-projection.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { isSidebarSlotVisible } from "./sidebar-layout.ts";
import { rememberAuthoritativeTerminal } from "./terminal-message-identity.ts";
import { readTerminalReplyRecoveryState } from "./terminal-reply-recovery.ts";
import { handleAgentEvent, handleSessionOperationEvent } from "./tool-stream.ts";

const BRANCH_TOPOLOGY_REASONS = new Set(["rewind", "branch-switch", "fork", "reset", "new"]);
const PENDING_INPUT_REASONS = new Set(["send", "agent.run.started", "agent.input.settled"]);
const MISSING_TERMINAL_HISTORY_RETRY_DELAYS_MS = [100, 400, 1_500, 3_000] as const;
const MAX_REMEMBERED_TERMINAL_RECOVERY_CLAIMS = 64;
type ChatPanePresentation = () => boolean;

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
    reconcileChatRunAfterSessionStatePublication(state);
  }
  return reconciled;
}

function finishSessionMessageRunReconcile(
  state: ChatPageHost,
  sessionKey: string,
  runId: string | null,
  row: SessionChangedResult["row"] | undefined,
  presentation: ChatPanePresentation,
): boolean {
  const cleared = row
    ? reconcileChatRunFromSessionRow(state, row, { publishRunStatus: true })
    : reconcileChatRunFromCurrentSessionRow(state, { publishRunStatus: true });
  if (!cleared) {
    return false;
  }
  clearPendingQueueItemsForRun(state, runId ?? undefined);
  void loadChatHistory(state, { deferBranches: !presentation() })
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

function handleSessionMessageEvent(
  state: ChatPageHost,
  payload: unknown,
  presentation: ChatPanePresentation,
) {
  const event = readSessionChangedEvent(payload);
  if (!event || !globalSessionEventMatchesChat(state, event)) {
    return;
  }
  const matchesChat = sessionMessageMatchesChat(state, event);
  const isUserMessage =
    readSessionMessageIdentity(asNullableRecord(payload)?.message)?.role === "user";
  if (matchesChat) {
    // A previous run can persist its final after the next local run starts.
    // Admit that sequenced row now so the later unsequenced chat.final replay
    // replaces it in place instead of appending below the newer user turn.
    applySessionMessagePayload(state, payload, event.hasActiveRun ?? undefined, {
      kind: "live",
      activeRunId: state.chatRunId,
    });
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
      if (isUserMessage) {
        // Promotion changes pending custody even while the next turn is active.
        void loadChatHistory(state, {
          deferBranches: !presentation(),
          supersedeInFlight: true,
        }).finally(() => state.requestUpdate?.());
      }
      return;
    }
    if (finishSessionMessageRunReconcile(state, event.key, runId, result.row, presentation)) {
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
          presentation,
        )
      ) {
        state.pendingSessionMessageReloadSessionKey = null;
      }
    });
    return;
  }
  if (matchesChat) {
    state.pendingSessionMessageReloadSessionKey = null;
    void loadChatHistory(state, {
      deferBranches: !presentation(),
      supersedeInFlight: isUserMessage && event.hasActiveRun === true,
    }).finally(() => state.requestUpdate?.());
  }
}

function replayPendingSessionMessageReload(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
  presentation: ChatPanePresentation,
  supersedeInFlight = false,
): boolean {
  const pendingSessionKey = state.pendingSessionMessageReloadSessionKey;
  const payloadSessionKey = payload?.sessionKey?.trim();
  if (
    !pendingSessionKey ||
    !payloadSessionKey ||
    !areUiSessionKeysEquivalent(pendingSessionKey, payloadSessionKey) ||
    !areUiSessionKeysEquivalent(payloadSessionKey, state.sessionKey) ||
    state.chatRunId
  ) {
    return false;
  }
  state.pendingSessionMessageReloadSessionKey = null;
  void loadChatHistory(state, {
    deferBranches: !presentation(),
    supersedeInFlight,
  }).finally(() => state.requestUpdate?.());
  return true;
}

type TerminalRecoveryOwnership = {
  sessionKey: string;
  agentId: string;
  runId: string;
  client: ChatPageHost["client"];
  connectionEpoch: number;
  runLifecycleGeneration: number;
  initialTerminalReplySignatures: ReadonlySet<string>;
};

const terminalRecoveryClaimsByPane = new WeakMap<object, Map<string, ChatPageHost["client"]>>();

function createTerminalRecoveryOwnership(
  state: ChatPageHost,
  payload: ChatEventPayload,
): TerminalRecoveryOwnership | null {
  const runId = payload.runId;
  if (!runId) {
    return null;
  }
  return {
    sessionKey: payload.sessionKey,
    agentId: resolveChatAgentId(state),
    runId,
    client: state.client,
    connectionEpoch: state.connectionEpoch,
    runLifecycleGeneration: state.chatRunLifecycleGeneration ?? 0,
    initialTerminalReplySignatures: readTerminalReplyRecoveryState(state, runId)
      .terminalReplySignatures,
  };
}

function claimTerminalRecovery(state: ChatPageHost, ownership: TerminalRecoveryOwnership): boolean {
  let claims = terminalRecoveryClaimsByPane.get(state);
  if (!claims) {
    claims = new Map();
    terminalRecoveryClaimsByPane.set(state, claims);
  }
  const key = [
    ownership.connectionEpoch,
    ownership.runLifecycleGeneration,
    ownership.agentId,
    ownership.sessionKey,
    ownership.runId,
  ].join("\0");
  if (claims.has(key) && claims.get(key) === ownership.client) {
    return false;
  }
  claims.delete(key);
  claims.set(key, ownership.client);
  while (claims.size > MAX_REMEMBERED_TERMINAL_RECOVERY_CLAIMS) {
    const oldest = claims.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    claims.delete(oldest);
  }
  return true;
}

function hasRecoveredTerminalReply(
  state: ChatPageHost,
  ownership: TerminalRecoveryOwnership,
): boolean {
  const recovery = readTerminalReplyRecoveryState(state, ownership.runId);
  return (
    recovery.acceptedFinal ||
    [...recovery.terminalReplySignatures].some(
      (signature) => !ownership.initialTerminalReplySignatures.has(signature),
    )
  );
}

function terminalRecoveryStillOwned(
  state: ChatPageHost,
  ownership: TerminalRecoveryOwnership,
): boolean {
  return (
    state.connected &&
    state.client === ownership.client &&
    state.connectionEpoch === ownership.connectionEpoch &&
    areUiSessionKeysEquivalent(state.sessionKey, ownership.sessionKey) &&
    resolveChatAgentId(state) === ownership.agentId &&
    (state.chatRunId === null || state.chatRunId === ownership.runId) &&
    (state.chatRunLifecycleGeneration ?? 0) === ownership.runLifecycleGeneration &&
    !hasRecoveredTerminalReply(state, ownership)
  );
}

async function recoverMissingTerminalReply(
  state: ChatPageHost,
  ownership: TerminalRecoveryOwnership,
  presentation: ChatPanePresentation,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (!terminalRecoveryStillOwned(state, ownership)) {
      return;
    }
    await loadChatHistory(state, {
      deferBranches: !presentation(),
      supersedeInFlight: true,
    });
    state.requestUpdate?.();
    if (!terminalRecoveryStillOwned(state, ownership)) {
      return;
    }
    const delayMs = MISSING_TERMINAL_HISTORY_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      return;
    }
    await sleep(delayMs);
  }
}

function handleSessionsChangedEvent(
  state: ChatPageHost,
  payload: unknown,
  presentation: ChatPanePresentation,
) {
  const presented = presentation();
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
  if (
    matchesChat &&
    state.client &&
    (resetsSession || source?.reason === "command-metadata" || source?.reason === "patch")
  ) {
    // Selection commands and model patches can change the persisted profile without changing credentials.
    invalidateChatMetadataStore(state.client, {
      agentId: resolveChatAgentId(state) ?? undefined,
      sessionKey: state.sessionKey,
    });
  }
  if (resetsSelectedSession) {
    const scope = readChatSessionProjectionScope(state, { agentId: resolveChatAgentId(state) });
    // Reset keeps the public session ID; the explicit reducer event is the
    // only proof that its old live and pending transcript no longer exists.
    reduceChatSessionProjection(state, { type: "sessionReset" }, { scope });
  }
  if (
    matchesChat &&
    typeof source?.reason === "string" &&
    BRANCH_TOPOLOGY_REASONS.has(source.reason)
  ) {
    retireChatBranchRequests(state);
    state.chatBranches = [];
    state.chatBranchesSessionKey = null;
    state.chatBranchesConnectionEpoch = null;
    retireSessionWorkspaceCheckout(state);
    if (presented) {
      void loadChatBranches(state);
    }
  }
  if (event && matchesChat && event.archived !== null) {
    state.selectedChatSessionArchived = event.archived;
  }
  const result = reconcileSessionEvent(state, payload);
  if (resetsSelectedSession) {
    void loadChatHistory(state, { deferBranches: !presented }).finally(() =>
      state.requestUpdate?.(),
    );
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
    void loadChatHistory(state, { deferBranches: !presented }).finally(() =>
      state.requestUpdate?.(),
    );
    return;
  }
  if (
    matchesChat &&
    typeof source?.reason === "string" &&
    PENDING_INPUT_REASONS.has(source.reason)
  ) {
    // Custody can change without a transcript append. A read begun before this
    // event must not hide accepted input until the active run ends.
    void loadChatHistory(state, {
      deferBranches: !presented,
      supersedeInFlight: true,
    }).finally(() => state.requestUpdate?.());
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
      presentation,
    )
  ) {
    return;
  }
  if (!result.applied && event?.isChatTurn !== true) {
    void refreshCurrentChatSessionList(state);
  }
}

function terminalOwnsActiveChatStream(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
): boolean {
  return typeof payload?.runId === "string" && payload.runId === state.chatRunId;
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

function hasVisibleFinalAssistantReply(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
): boolean {
  if (
    payload?.state !== "final" ||
    !chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId)
  ) {
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

export function handlePageGatewayEvent(
  state: ChatPageHost,
  event: GatewayEventFrame,
  isPresented: ChatPanePresentation = () => true,
) {
  if (event.event === "session.approval") {
    const payload = asNullableRecord(event.payload);
    if (!payload || typeof payload.sessionKey !== "string") {
      return;
    }
    const queue = reconcileSessionApprovalEvent(
      state.chatSessionApprovalQueue ?? [],
      payload,
      state.sessionKey,
      resolveChatAgentId(state),
    );
    if (queue) {
      state.chatSessionApprovalQueue = queue;
      requestChatPageUpdate(state);
    }
    return;
  }
  if (event.event === "chat") {
    const payload = event.payload as ChatEventPayload | undefined;
    const sessionMatches = Boolean(
      payload && chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId),
    );
    const recoveryRunId =
      payload?.state === "final" &&
      (payload.message === undefined || payload.message === null) &&
      sessionMatches &&
      typeof payload.runId === "string" &&
      (!state.chatRunId || state.chatRunId === payload.runId)
        ? payload.runId
        : null;
    const recoveryScope = recoveryRunId ? readChatSessionProjectionScope(state) : null;
    if (
      payload?.state === "delta" &&
      typeof payload.runId === "string" &&
      sessionMatches &&
      // Same-session background streams cannot clear the foreground run's status.
      (!state.chatRunId || state.chatRunId === payload.runId) &&
      state.observerDigest &&
      state.observerDigest.runId !== payload.runId
    ) {
      state.observerDigest = null;
    }
    if (payload?.state === "delta" && typeof payload.deltaText === "string" && sessionMatches) {
      refreshPullRequestsForStreamedLinks(state, payload, payload.deltaText);
    }
    const shouldCelebrateFirstReply = hasVisibleFinalAssistantReply(state, payload);
    const shouldRefreshPullRequests =
      shouldCelebrateFirstReply && finalAssistantReplyHasPullRequestLink(state, payload);
    const terminalPayload =
      payload &&
      (payload.state === "final" || payload.state === "aborted" || payload.state === "error")
        ? payload
        : undefined;
    // Missing ownership must not fall back to correlation-only run IDs, which
    // can collide across sessions.
    const outboxScope =
      terminalPayload &&
      resolveStoredChatOutboxScope(
        state,
        terminalPayload.sessionKey,
        isUiGlobalSessionKey(terminalPayload.sessionKey)
          ? selectedGlobalEventAgentId(state, terminalPayload.agentId ?? null)
          : terminalPayload.agentId,
      );
    const delivered = outboxScope
      ? rememberDeliveredQueuedUserTurn(state, terminalPayload.runId, outboxScope)
      : null;
    if (delivered) {
      // The queued projection is the only local copy until history catches up.
      // Materialize it before the terminal assistant to preserve transcript order.
      preserveQueuedUserTurn(state, delivered);
    }
    const result = handleChatGatewayEvent(state, payload);
    if (terminalPayload && sessionMatches) {
      clearPendingQueueItemsForRun(state, terminalPayload.runId);
    }
    if (shouldCelebrateFirstReply && result === "final") {
      fireFirstReplyConfetti();
    }
    if (shouldRefreshPullRequests) {
      void state.refreshSessionPullRequests?.({ refresh: true });
    }
    const shouldRecoverMissingTerminal = Boolean(
      recoveryRunId &&
      recoveryScope &&
      getChatSessionProjection(state, state.chatMessages, recoveryScope).runs[recoveryRunId]
        ?.status === "completed",
    );
    const recoveryOwnership =
      shouldRecoverMissingTerminal && payload
        ? createTerminalRecoveryOwnership(state, payload)
        : null;
    const recoveryClaimed = recoveryOwnership
      ? claimTerminalRecovery(state, recoveryOwnership)
      : false;
    if (recoveryOwnership && recoveryClaimed) {
      state.pendingSessionMessageReloadSessionKey = null;
      // The first owned message-less terminal recovers history even when an
      // earlier snapshot already marked the run complete. Replays, yielded, or
      // background-run terminals must not repeat I/O or disturb the foreground pane.
      // Persistence can trail the terminal event, so retry bounded authoritative
      // snapshots until the completed run's reply becomes visible.
      void recoverMissingTerminalReply(state, recoveryOwnership, isPresented).catch(
        () => undefined,
      );
    } else {
      replayPendingSessionMessageReload(state, payload, isPresented);
    }
    if (terminalPayload) {
      if (outboxScope) {
        removeDeliveredQueuedChatSendForRun(state, terminalPayload.runId, outboxScope);
      }
      void resumeStoredChatOutboxes(state);
      if (sessionMatches) {
        if (isPresented()) {
          refreshSessionWorkspace(state, isSidebarSlotVisible(state.sidebarLayout, "workspace"));
        } else {
          retireSessionWorkspaceCheckout(state);
        }
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
      requestChatPageUpdate(state, "animation-frame");
    }
    return;
  }
  if (event.event === "session.operation") {
    handleSessionOperationEvent(state as never, event.payload as never);
    requestChatPageUpdate(state, "animation-frame");
    return;
  }
  if (event.event === "chat.send_timing") {
    recordChatSendServerTiming(state, event.payload);
    return;
  }
  if (event.event === "session.message") {
    handleSessionMessageEvent(state, event.payload, isPresented);
    void resumeStoredChatOutboxes(state);
    requestChatPageUpdate(state, "animation-frame");
    return;
  }
  if (event.event === "sessions.changed") {
    handleSessionsChangedEvent(state, event.payload, isPresented);
    void resumeStoredChatOutboxes(state);
    requestChatPageUpdate(state, "animation-frame");
    return;
  }
  if (event.event === "task") {
    handleBackgroundTasksEvent(state, event.payload, isPresented());
  }
}

const MAX_REMEMBERED_DELIVERED_QUEUE_TURNS = 64;
const deliveredQueueTurnsByClient = new WeakMap<object, Map<string, ChatQueueItem>>();

function rememberDeliveredQueuedUserTurn(
  state: ChatPageHost,
  runId: string | undefined,
  scope: StoredChatOutboxScope,
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
  const deliveryKey = `${storedChatOutboxScopeKey(scope)}|${runId}`;
  const stored = readDeliveredQueuedChatSendForRun(state, runId, scope)?.item;
  if (stored) {
    turns.delete(deliveryKey);
    turns.set(deliveryKey, stored);
    while (turns.size > MAX_REMEMBERED_DELIVERED_QUEUE_TURNS) {
      const oldestRunId = turns.keys().next().value;
      if (typeof oldestRunId !== "string") {
        break;
      }
      turns.delete(oldestRunId);
    }
  }
  return stored ?? turns.get(deliveryKey) ?? null;
}
