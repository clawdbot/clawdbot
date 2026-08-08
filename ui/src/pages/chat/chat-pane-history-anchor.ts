import { t } from "../../i18n/index.ts";
import { showToast } from "../../lib/toast.ts";
import { loadChatHistory } from "./chat-history.ts";
import { ChatPaneSessionCreation } from "./chat-pane-session-creation.ts";
import { cancelChatScroll } from "./scroll.ts";

export abstract class ChatPaneHistoryAnchor extends ChatPaneSessionCreation {
  private historyAnchorRequestKey = "";

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
    const requestKey = `${this.connectionGeneration}\0${sessionKey}\0${anchor.sessionId}\0${anchor.messageId}`;
    if (this.historyAnchorRequestKey === requestKey) {
      return;
    }
    this.historyAnchorRequestKey = requestKey;
    void loadChatHistory(state, { deferBranches: true, historyAnchor: anchor }).then(
      async (result) => {
        if (!result) {
          if (
            this.isConnected &&
            this.state === state &&
            this.historyAnchor?.sessionId === anchor.sessionId &&
            this.historyAnchor.messageId === anchor.messageId &&
            this.historyAnchorRequestKey === requestKey
          ) {
            this.historyAnchorRequestKey = "";
          }
          return;
        }
        if (
          !this.isConnected ||
          this.historyAnchor?.sessionId !== anchor.sessionId ||
          this.historyAnchor.messageId !== anchor.messageId ||
          this.state !== state ||
          this.historyAnchorRequestKey !== requestKey
        ) {
          return;
        }
        this.requestUpdate();
        await this.updateComplete;
        cancelChatScroll(state);
        if (await this.transcript.scrollToMessage(anchor.messageId)) {
          this.onHistoryAnchorConsumed?.();
          return;
        }

        this.onHistoryAnchorConsumed?.();
        const currentHistory = await loadChatHistory(state, { deferBranches: true });
        if (
          !currentHistory ||
          !this.isConnected ||
          this.state !== state ||
          state.sessionKey !== sessionKey
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
