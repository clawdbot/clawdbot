import { formatUiError } from "../../lib/format-error.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  scopedAgentParamsForSession,
  visibleSessionMatches,
  type SessionCapability,
} from "../../lib/sessions/index.ts";
import { replaceChatAttachmentsFromEditor } from "./attachment-payload-store.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { resetChatHistoryProjection, setChatError } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { persistChatComposerState } from "./composer-persistence.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";

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
