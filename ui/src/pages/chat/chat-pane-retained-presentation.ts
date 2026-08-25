import { formatUiError } from "../../lib/format-error.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { storeChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import { loadChatBranches, retireChatBranchRequests } from "./chat-history.ts";
import { ChatPaneBoard } from "./chat-pane-board.ts";
import {
  consumePaneSessionHandoff,
  type PaneSessionHandoff,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { retryReconnectableQueuedChatSends } from "./chat-send-actions.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
import { invalidateImageLightbox } from "./chat-state-page.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { dismissConfirmedActionPopovers } from "./components/chat-message.ts";
import { resetTaskDetail } from "./components/chat-task-detail-state.ts";
import { resetTranscriptSession } from "./components/chat-thread-interactions.ts";
import { CHAT_COMPOSER_DRAFT_STORAGE_ERROR } from "./composer-persistence.ts";

/** Owns foreground resources and composer state that follow one retained presentation. */
export abstract class ChatPaneRetainedPresentation extends ChatPaneBoard {
  protected abstract clearComposerPrefillAttention(): void;
  protected abstract settleResetConfirmation(confirmed: boolean): void;
  protected abstract syncActiveBindings(): void;

  protected override activeChanged(active: boolean): void {
    if (!this.isConnected) {
      return;
    }
    this.syncActiveBindings();
    if (active && this.presented && this.state?.chatQueue.length) {
      void refreshCurrentChatSessionList(this.state).catch(() => undefined);
      void retryReconnectableQueuedChatSends(this.state);
    }
    this.querySelector(".chat-transcript-announcement")?.setAttribute(
      "aria-live",
      active ? "polite" : "off",
    );
  }

  protected override presentedChanged(presented: boolean): void {
    if (!this.isConnected) {
      return;
    }
    if (presented) {
      this.minutePoll.start();
      this.consumeSessionHandoff(this.sessionKey);
      this.syncActiveBindings();
      const state = this.state;
      if (state) {
        this.unreadPatchGuard.beginActivation(state.sessionKey);
        this.markSessionRead(selectedChatSessionRow(state));
      }
      const deferredHydrationActive = this.resumeDeferredSessionHydration();
      if (
        state &&
        !deferredHydrationActive &&
        (!areUiSessionKeysEquivalent(state.chatBranchesSessionKey, state.sessionKey) ||
          state.chatBranchesConnectionEpoch !== state.connectionEpoch)
      ) {
        void loadChatBranches(state);
      }
      this.refreshSwarmRoster();
      void this.refreshSessionPullRequests();
      return;
    }
    this.minutePoll.stop();
    if (this.state) {
      retireChatBranchRequests(this.state);
    }
    this.swarmHydrator?.dispose();
    this.swarmHydrator = null;
    this.clearHistoryObserver();
    sessionPullRequestsForGateway(this.context.gateway).unwatch(this);
    this.syncActiveBindings();
    this.clearComposerPrefillAttention();
    this.settleResetConfirmation(false);
    this.cancelHeaderRename();
    dismissConfirmedActionPopovers(this);
    resetTranscriptSession(this.presentationId, this);
    const state = this.state;
    if (state) {
      stopChatRealtimeTalk(state);
      invalidateImageLightbox(state);
      // The detail slot's render guard cannot run once the content is wiped,
      // so the transcript loader's timer/fetch loop must be stopped here.
      resetTaskDetail(state);
      state.sidebarContent = null;
      state.requestUpdate?.();
    }
    this.querySelector(".chat-transcript-announcement")?.setAttribute("aria-live", "off");
  }

  public prepareForEviction(): void {
    const state = this.state;
    if (!state?.sessionKey) {
      return;
    }
    const persistResult = this.chatState.persistComposerForEviction();
    if (persistResult.status === "storage-failed") {
      const scope = this.chatState.composerScopeForEviction();
      if (scope) {
        storeChatComposerMemoryFallback(state, scope, {
          message: state.chatMessage,
          attachments: state.chatAttachments,
          draftRetry: persistResult,
        });
      }
    }
    preparePaneSessionHandoff(this.context, this.paneId, state.sessionKey, {
      // The gateway-scoped disconnect handoff owns attachments and memory
      // fallbacks. This transfer carries only composer metadata and the draft.
      attachments: [],
      draft: state.chatMessage,
      restore: true,
      storageFailed: persistResult.status === "storage-failed",
    });
  }

  protected takeSessionHandoff(sessionKey: string): PaneSessionHandoff | null {
    return consumePaneSessionHandoff(this.context, this.paneId, sessionKey);
  }

  protected consumeSessionHandoff(sessionKey: string): void {
    if (!this.state || !sessionKey) {
      return;
    }
    const handoff = this.takeSessionHandoff(sessionKey);
    if (handoff) {
      this.applySessionHandoff(sessionKey, handoff, !handoff.restore);
    }
  }

  protected applySessionHandoff(
    sessionKey: string,
    handoff: PaneSessionHandoff,
    notifyDraftChange: boolean,
  ): void {
    const state = this.state;
    if (!state) {
      return;
    }
    if (!handoff.restore) {
      if (handoff.composerFallbacks) {
        state.chatComposerFallbackByScope = handoff.composerFallbacks;
      }
      state.chatAttachments = [...handoff.attachments];
    }
    if (notifyDraftChange) {
      state.handleChatDraftChange(handoff.draft);
    } else {
      state.chatMessage = handoff.draft;
    }
    if (handoff.storageFailed) {
      state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
      state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
    }
    state.requestUpdate?.();
    if (handoff.send) {
      queueMicrotask(() => {
        if (
          this.state !== state ||
          state.sessionKey !== sessionKey ||
          !this.active ||
          !this.presented
        ) {
          return;
        }
        void state.handleSendChat().catch((error: unknown) => {
          if (this.state === state && state.sessionKey === sessionKey) {
            setChatError(state, formatUiError(error));
            state.requestUpdate?.();
          }
        });
      });
    }
  }
}
