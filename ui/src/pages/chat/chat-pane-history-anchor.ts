import { t } from "../../i18n/index.ts";
import { showToast } from "../../lib/toast.ts";
import { completeChatHistoryAnchorVisibility, loadChatHistory } from "./chat-history.ts";
import { ChatPaneSessionCreation } from "./chat-pane-session-creation.ts";
import { cancelChatScroll } from "./scroll.ts";

export abstract class ChatPaneHistoryAnchor extends ChatPaneSessionCreation {
  private historyAnchorRequestKey = "";

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
      this.historyAnchorRequestKey === requestKey
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
    this.historyAnchorRequestKey = requestKey;
    void loadChatHistory(state, { deferBranches: true, historyAnchor: anchor }).then(
      async (result) => {
        if (!result) {
          if (state.chatHistoryAnchorFailedRequestKey !== requestKey) {
            this.releaseHistoryAnchorRequest(requestKey);
          }
          return;
        }
        if (
          !this.ownsHistoryAnchorRequest(
            state,
            anchor,
            requestKey,
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
            sessionKey,
            connectionGeneration,
          )
        ) {
          this.releaseHistoryAnchorRequest(requestKey);
          return;
        }
        const completion = completeChatHistoryAnchorVisibility(state, anchor);
        if (centered) {
          this.onHistoryAnchorConsumed?.();
          if (!this.ownsHistoryAnchorRefreshOwner(state, sessionKey, connectionGeneration)) {
            completion?.completeRefresh(undefined);
            return;
          }
          if (completion?.shouldRefresh) {
            void loadChatHistory(state, completion.refreshOptions)
              .then(completion.completeRefresh, () => completion.completeRefresh(undefined))
              .finally(() => state.requestUpdate?.());
          }
          return;
        }

        this.onHistoryAnchorConsumed?.();
        if (!this.ownsHistoryAnchorRefreshOwner(state, sessionKey, connectionGeneration)) {
          completion?.completeRefresh(undefined);
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
          this.historyAnchorRequestKey !== requestKey
        ) {
          return;
        }
        const message = t("chat.historyAnchorUnavailable");
        state.lastError = message;
        state.chatError = message;
        showToast({ message });
        state.requestUpdate?.();
      },
    );
  }
}
