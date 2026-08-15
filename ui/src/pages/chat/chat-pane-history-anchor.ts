import { t } from "../../i18n/index.ts";
import { showToast } from "../../lib/toast.ts";
import { completeChatHistoryAnchorVisibility, loadChatHistory } from "./chat-history.ts";
import { ChatPaneSessionCreation } from "./chat-pane-session-creation.ts";
import { cancelChatScroll } from "./scroll.ts";

export abstract class ChatPaneHistoryAnchor extends ChatPaneSessionCreation {
  private historyAnchorRequestKey = "";
  private historyAnchorAttemptGeneration = 0;

  private releaseHistoryAnchorRequest(requestKey: string): void {
    if (this.historyAnchorRequestKey === requestKey) {
      this.historyAnchorRequestKey = "";
    }
  }

  private ownsHistoryAnchorRefreshOwner(
    state: NonNullable<ChatPaneHistoryAnchor["state"]>,
    sessionKey: string,
    connectionGeneration: number,
  ): boolean {
    return (
      this.active &&
      this.isConnected &&
      this.connectionGeneration === connectionGeneration &&
      this.state === state &&
      state.sessionKey === sessionKey
    );
  }

  private ownsHistoryAnchorRequest(
    state: NonNullable<ChatPaneHistoryAnchor["state"]>,
    anchor: { messageId: string; sessionId: string },
    requestKey: string,
    attemptGeneration: number,
    pendingOwner: NonNullable<
      NonNullable<ChatPaneHistoryAnchor["state"]>["chatHistoryAnchorPending"]
    >,
    sessionKey: string,
    connectionGeneration: number,
  ): boolean {
    return (
      this.active &&
      this.isConnected &&
      this.connectionGeneration === connectionGeneration &&
      this.state === state &&
      state.sessionKey === sessionKey &&
      this.historyAnchor?.sessionId === anchor.sessionId &&
      this.historyAnchor.messageId === anchor.messageId &&
      this.historyAnchorRequestKey === requestKey &&
      this.historyAnchorAttemptGeneration === attemptGeneration &&
      state.chatHistoryAnchorActive === true &&
      state.chatHistoryAnchorPending === pendingOwner
    );
  }

  protected loadHistoryAnchorIfNeeded(): void {
    const state = this.state;
    const anchor = this.historyAnchor;
    if (!anchor) {
      this.historyAnchorRequestKey = "";
      return;
    }
    if (!this.active || !state?.connected || !state.client) {
      return;
    }
    const sessionKey = state.sessionKey;
    const connectionGeneration = this.connectionGeneration;
    const requestKey = `${connectionGeneration}\0${sessionKey}\0${anchor.sessionId}\0${anchor.messageId}`;
    if (this.historyAnchorRequestKey === requestKey) {
      return;
    }
    const attemptGeneration = ++this.historyAnchorAttemptGeneration;
    this.historyAnchorRequestKey = requestKey;
    const anchorLoad = loadChatHistory(state, { deferBranches: true, historyAnchor: anchor });
    const pendingOwner = state.chatHistoryAnchorPending;
    if (!pendingOwner) {
      this.releaseHistoryAnchorRequest(requestKey);
      return;
    }
    void anchorLoad.then(async (result) => {
      if (!result) {
        const failedRequestKey = pendingOwner.requestKey;
        let recovery =
          state.chatHistoryAnchorFailedRequestKey === failedRequestKey
            ? pendingOwner.deferredRefresh?.promise
            : undefined;
        if (
          !recovery &&
          this.ownsHistoryAnchorRefreshOwner(state, sessionKey, connectionGeneration) &&
          this.historyAnchor?.sessionId === anchor.sessionId &&
          this.historyAnchor.messageId === anchor.messageId &&
          this.historyAnchorRequestKey === requestKey &&
          this.historyAnchorAttemptGeneration === attemptGeneration
        ) {
          state.chatHistoryAnchorFailedRequestKey = failedRequestKey;
          recovery = loadChatHistory(state, { deferBranches: true });
        }
        if (!recovery) {
          this.releaseHistoryAnchorRequest(requestKey);
          return;
        }
        await recovery;
        if (state.chatHistoryAnchorFailedRequestKey === failedRequestKey) {
          state.chatHistoryAnchorFailedRequestKey = undefined;
        }
        if (
          this.ownsHistoryAnchorRefreshOwner(state, sessionKey, connectionGeneration) &&
          this.historyAnchor?.sessionId === anchor.sessionId &&
          this.historyAnchor.messageId === anchor.messageId &&
          this.historyAnchorRequestKey === requestKey &&
          this.historyAnchorAttemptGeneration === attemptGeneration
        ) {
          this.onHistoryAnchorConsumed?.();
        }
        this.releaseHistoryAnchorRequest(requestKey);
        return;
      }
      if (
        !this.ownsHistoryAnchorRequest(
          state,
          anchor,
          requestKey,
          attemptGeneration,
          pendingOwner,
          sessionKey,
          connectionGeneration,
        )
      ) {
        this.releaseHistoryAnchorRequest(requestKey);
        return;
      }
      this.requestUpdate();
      await this.updateComplete;
      if (
        !this.ownsHistoryAnchorRequest(
          state,
          anchor,
          requestKey,
          attemptGeneration,
          pendingOwner,
          sessionKey,
          connectionGeneration,
        )
      ) {
        this.releaseHistoryAnchorRequest(requestKey);
        return;
      }
      cancelChatScroll(state);
      const centered = await this.transcript.scrollToMessage(anchor.messageId);
      if (
        !this.ownsHistoryAnchorRequest(
          state,
          anchor,
          requestKey,
          attemptGeneration,
          pendingOwner,
          sessionKey,
          connectionGeneration,
        )
      ) {
        this.releaseHistoryAnchorRequest(requestKey);
        return;
      }
      const completion = completeChatHistoryAnchorVisibility(state, anchor);
      this.onHistoryAnchorConsumed?.();
      if (!this.ownsHistoryAnchorRefreshOwner(state, sessionKey, connectionGeneration)) {
        completion?.completeRefresh(undefined);
        return;
      }
      if (centered) {
        if (completion?.shouldRefresh) {
          void loadChatHistory(state, completion.refreshOptions)
            .then(completion.completeRefresh, () => completion.completeRefresh(undefined))
            .finally(() => state.requestUpdate?.());
        }
        return;
      }

      let currentHistory: Awaited<ReturnType<typeof loadChatHistory>> = undefined;
      try {
        currentHistory = await loadChatHistory(
          state,
          completion?.refreshOptions ?? { deferBranches: true },
        );
      } finally {
        completion?.completeRefresh(currentHistory);
      }
      if (
        !currentHistory ||
        !this.ownsHistoryAnchorRefreshOwner(state, sessionKey, connectionGeneration) ||
        this.historyAnchorAttemptGeneration !== attemptGeneration
      ) {
        return;
      }
      const message = t("chat.historyAnchorUnavailable");
      state.lastError = message;
      state.chatError = message;
      showToast({ message });
      state.requestUpdate?.();
    });
  }
}
