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
    const requestKey = `${this.connectionGeneration}\0${state.sessionKey}\0${anchor.sessionId}\0${anchor.messageId}`;
    if (this.historyAnchorRequestKey === requestKey) {
      return;
    }
    this.historyAnchorRequestKey = requestKey;
    void loadChatHistory(state, { deferBranches: true, historyAnchor: anchor }).then(
      async (result) => {
        if (
          !result ||
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
        if (this.transcript.scrollToMessage(anchor.messageId)) {
          this.onHistoryAnchorConsumed?.();
        }
      },
    );
  }
}
