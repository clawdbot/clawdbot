import "../../components/modal-dialog.ts";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { storeChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import { loadChatBranches, retireChatBranchRequests } from "./chat-history-branches.ts";
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

const COMPOSER_PREFILL_ATTENTION_DURATION_MS = 600;
const COMPOSER_PREFILL_ATTENTION_CLASS = "agent-chat__input--prefill-attention";

/** Owns foreground resources and composer state that follow one retained presentation. */
export abstract class ChatPaneRetainedPresentation extends ChatPaneBoard {
  protected abstract syncActiveBindings(): void;
  protected abstract activateComposerPresentation(): void;

  protected clearComposerPrefillAttention(): void {
    if (this.composerPrefillAttentionTimer !== null) {
      window.clearTimeout(this.composerPrefillAttentionTimer);
      this.composerPrefillAttentionTimer = null;
    }
    this.composerPrefillAttentionTarget?.classList.remove(COMPOSER_PREFILL_ATTENTION_CLASS);
    this.composerPrefillAttentionTarget = null;
  }

  protected showComposerPrefillAttention(input: HTMLElement): void {
    this.clearComposerPrefillAttention();
    // Force a fresh animation frame when the same mounted composer is prompted again.
    void input.offsetWidth;
    input.classList.add(COMPOSER_PREFILL_ATTENTION_CLASS);
    this.composerPrefillAttentionTarget = input;
    // Reduced motion disables animation events, so timer cleanup owns both modes.
    this.composerPrefillAttentionTimer = window.setTimeout(() => {
      if (this.composerPrefillAttentionTarget === input) {
        this.clearComposerPrefillAttention();
      }
    }, COMPOSER_PREFILL_ATTENTION_DURATION_MS);
  }

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

  protected override activeChanged(active: boolean): void {
    if (!this.isConnected) {
      return;
    }
    this.syncActiveBindings();
    if (active) {
      this.activateComposerPresentation();
    }
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
      this.activateComposerPresentation();
      this.syncActiveBindings();
      const state = this.state;
      if (state) {
        this.unreadPatchGuard.beginActivation(state.sessionKey);
      }
      const deferredHydrationActive = this.resumeDeferredSessionHydration();
      if (state && !deferredHydrationActive) {
        this.markSessionRead(selectedChatSessionRow(state));
      }
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
      state.attachmentSidebarContent = null;
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
          goalMode: state.chatGoalDraftMode,
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
      ...(state.chatGoalDraftMode ? { goalMode: state.chatGoalDraftMode } : {}),
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
    state.chatGoalDraftMode = handoff.goalMode ?? null;
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
