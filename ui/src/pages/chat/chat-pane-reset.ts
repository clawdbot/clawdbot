import { ChatPaneBoard } from "./chat-pane-board.ts";
import {
  areUiSessionKeysEquivalent,
  canCreateChatSession,
  clearChatHistory,
  html,
  nothing,
  resolveAgentIdFromSessionKey,
  scopedAgentParamsForSession,
  t,
} from "./chat-pane-deps.ts";
import {
  NEW_SESSION_ACTIVE_RUN_MESSAGE,
  NEW_SESSION_CREATE_FAILED_MESSAGE,
  NEW_SESSION_LIST_LOADING_MESSAGE,
} from "./chat-pane-shared.ts";

export abstract class ChatPaneReset extends ChatPaneBoard {
  protected confirmConversationReset(): Promise<boolean> {
    const board = this.resolveBoardView();
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    const pending = this.resetConfirmation;
    if (pending && !areUiSessionKeysEquivalent(pending.sessionKey, sessionKey)) {
      this.settleResetConfirmation(false);
    }
    if (!board.hasBoard) {
      return Promise.resolve(true);
    }
    if (this.resetConfirmation) {
      return this.resetConfirmation.promise;
    }
    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((next) => {
      resolve = next;
    });
    this.resetConfirmation = { sessionKey, promise, resolve };
    this.resetConfirmationOpen = true;
    return promise;
  }

  protected cancelResetConfirmationForSessionChange(): void {
    const pending = this.resetConfirmation;
    if (pending && !areUiSessionKeysEquivalent(pending.sessionKey, this.resolveBoardSessionKey())) {
      this.settleResetConfirmation(false);
    }
  }

  protected settleResetConfirmation(confirmed: boolean): void {
    const pending = this.resetConfirmation;
    if (!pending) {
      return;
    }
    this.resetConfirmation = undefined;
    this.resetConfirmationOpen = false;
    pending.resolve(confirmed);
  }

  protected renderResetConfirmation() {
    if (!this.resetConfirmationOpen) {
      return nothing;
    }
    const title = t("chat.board.resetTitle");
    const description = t("chat.board.resetDescription");
    return html`
      <openclaw-modal-dialog
        label=${title}
        description=${description}
        @modal-cancel=${() => this.settleResetConfirmation(false)}
      >
        <div class="exec-approval-card board-reset-confirmation">
          <div class="exec-approval-header">
            <div>
              <div class="exec-approval-title">${title}</div>
              <div class="exec-approval-sub">${description}</div>
            </div>
          </div>
          <div class="exec-approval-actions">
            <button
              class="btn primary"
              type="button"
              @click=${() => this.settleResetConfirmation(true)}
            >
              ${t("common.confirm")}
            </button>
            <button
              class="btn"
              type="button"
              autofocus
              @click=${() => this.settleResetConfirmation(false)}
            >
              ${t("common.cancel")}
            </button>
          </div>
        </div>
      </openclaw-modal-dialog>
    `;
  }

  protected readonly createSession = async (): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected) {
      return false;
    }
    const context = this.context;
    const sessions = context.sessions;
    const client = state.client;
    const previousSessionKey = state.sessionKey;
    const preservesBoard = this.resolveBoardView().hasBoard;
    const connectionGeneration = this.connectionGeneration;
    const isCurrent = () =>
      this.isConnected &&
      this.state === state &&
      this.context === context &&
      this.context.sessions === sessions &&
      state.client === client &&
      state.connected &&
      this.connectedClient === client &&
      context.gateway.snapshot.client === client &&
      context.gateway.snapshot.phase === "connected" &&
      this.connectionGeneration === connectionGeneration;
    if (!canCreateChatSession(state)) {
      state.lastError = NEW_SESSION_ACTIVE_RUN_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return false;
    }
    if (state.sessionsLoading) {
      state.lastError = NEW_SESSION_LIST_LOADING_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return false;
    }
    if (
      !(await this.confirmConversationReset()) ||
      !isCurrent() ||
      !areUiSessionKeysEquivalent(state.sessionKey, previousSessionKey)
    ) {
      return false;
    }
    if (!canCreateChatSession(state)) {
      state.lastError = NEW_SESSION_ACTIVE_RUN_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return false;
    }

    state.lastError = null;
    state.chatError = null;
    if (preservesBoard) {
      // Captured before the await: the reset can land and refresh session rows
      // mid-flight, and invalidating the post-reset id would eat fresh digests.
      const preResetSessionId = state.sessionsResult?.sessions.find((row) =>
        areUiSessionKeysEquivalent(row.key, previousSessionKey),
      )?.sessionId;
      const resetResult = await clearChatHistory(state);
      if (resetResult !== "failed") {
        // A reset reuses the session key; prior-run digests must not survive
        // into the fresh conversation or keep injecting the observer card.
        this.observerDigestHistory.markReset(
          this.resolveBoardSessionKey(previousSessionKey),
          preResetSessionId,
        );
        // Recompute rather than null: the builtin snapshot also carries the
        // swarm card, which must survive an observer-only invalidation.
        this.refreshBuiltinBoardSnapshot();
      }
      return resetResult !== "failed";
    }
    const nextSessionKey = await sessions.create({
      currentSessionKey: previousSessionKey,
      agentId:
        scopedAgentParamsForSession(state, previousSessionKey).agentId ??
        resolveAgentIdFromSessionKey(previousSessionKey),
    });
    if (!isCurrent()) {
      return false;
    }
    if (
      !nextSessionKey ||
      state.sessionKey !== previousSessionKey ||
      !canCreateChatSession(state)
    ) {
      if (!nextSessionKey) {
        state.lastError =
          state.sessionsError ??
          (state.sessionsLoading
            ? NEW_SESSION_LIST_LOADING_MESSAGE
            : NEW_SESSION_CREATE_FAILED_MESSAGE);
        state.chatError = state.lastError;
        state.requestUpdate?.();
      }
      return false;
    }
    this.chatState.captureCreatedSessionComposer(nextSessionKey);
    this.onPaneSessionChange?.(this.paneId, nextSessionKey);
    return true;
  };
}
