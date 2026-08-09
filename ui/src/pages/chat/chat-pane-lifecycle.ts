import "../../components/modal-dialog.ts";
import { html, nothing } from "lit";
import type {
  SessionObserverDigest,
  SessionSuggestionEvent,
  SessionTypingEvent,
  TaskSuggestionEvent,
} from "../../../../packages/gateway-protocol/src/index.js";
import { invalidateAssistantIdentityCache } from "../../app/assistant-identity.ts";
import {
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
} from "../../app/question-prompt.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import {
  BROWSER_ANNOTATION_EVENT,
  type BrowserAnnotationDraft,
} from "../../components/browser/browser-annotation.ts";
import { t } from "../../i18n/index.ts";
import { resolveAsciiShortcutKey } from "../../lib/keyboard-shortcuts.ts";
import { resolveChatPaneObserverRunId } from "../../lib/observer-digest.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveSessionCreateParams } from "../../lib/sessions/create.ts";
import { resolveSessionKey, scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  resolveAgentIdFromSessionKey,
} from "../../lib/sessions/session-key.ts";
import { invalidateChatAvatarCache, refreshChatAvatar } from "./chat-avatar.ts";
import { clearChatHistory } from "./chat-history.ts";
import { ChatPaneBoard } from "./chat-pane-board.ts";
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  CHAT_MODAL_SELECTOR,
  CHAT_OPEN_DETAILS_SELECTOR,
  CHAT_SPACE_ACTIVATION_SELECTOR,
  CHAT_TEXT_ENTRY_SELECTOR,
  keyboardEventPathMatches,
  NEW_SESSION_ACTIVE_RUN_MESSAGE,
  NEW_SESSION_CREATE_FAILED_MESSAGE,
  NEW_SESSION_LIST_LOADING_MESSAGE,
} from "./chat-pane-shared.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import { applySelectedChatAgent } from "./chat-session.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { createPageState } from "./chat-state-page.ts";
import { invalidateChatMetadataCache, refreshPageChat } from "./chat-state-refresh.ts";
import { selectedChatSessionRow, canCreateChatSession } from "./chat-state-route.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { chatAttachmentFromDataUrl } from "./components/chat-attachments.ts";
import { dismissConfirmedActionPopovers } from "./components/chat-message.ts";
import { clearChatModelSearchOnEscape } from "./components/chat-model-picker.ts";
import { toggleSessionWorkspace } from "./components/chat-session-workspace.ts";
import { WIDGET_PROMPT_EVENT, type WidgetPromptEventDetail } from "./components/chat-tool-cards.ts";
import { CHAT_COMPOSER_DRAFT_STORAGE_ERROR } from "./composer-persistence.ts";
import { exportChatMarkdown } from "./export.ts";
import { admitInitialTurnHandoff, admitInitialUserMessageHandoff } from "./initial-turn-handoff.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";

const COMPOSER_PREFILL_ATTENTION_DURATION_MS = 1_200;
const COMPOSER_PREFILL_ATTENTION_CLASS = "agent-chat__input--prefill-attention";

export abstract class ChatPaneLifecycle extends ChatPaneBoard {
  private clearComposerPrefillAttention(): void {
    if (this.composerPrefillAttentionTimer !== null) {
      window.clearTimeout(this.composerPrefillAttentionTimer);
      this.composerPrefillAttentionTimer = null;
    }
    this.composerPrefillAttentionTarget?.classList.remove(COMPOSER_PREFILL_ATTENTION_CLASS);
    this.composerPrefillAttentionTarget = null;
  }

  private showComposerPrefillAttention(input: HTMLElement): void {
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
    const createParams = {
      currentSessionKey: previousSessionKey,
      agentId:
        scopedAgentParamsForSession(state, previousSessionKey).agentId ??
        resolveAgentIdFromSessionKey(previousSessionKey),
    };
    const createRequestParams = {
      ...resolveSessionCreateParams(createParams.currentSessionKey, createParams.agentId),
    };
    const readCreateAccess = () =>
      readSessionMethodAccess(context.gateway.snapshot, {
        method: preservesBoard ? "sessions.reset" : "sessions.create",
        ...(preservesBoard
          ? { requiredScope: "operator.admin" as const }
          : { params: createRequestParams }),
      });
    const publishCreateAccessError = (reason: string) => {
      state.lastError = reason;
      state.chatError = reason;
      state.requestUpdate?.();
    };
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
      setChatError(state, NEW_SESSION_ACTIVE_RUN_MESSAGE);
      state.requestUpdate?.();
      return false;
    }
    if (state.sessionsLoading) {
      setChatError(state, NEW_SESSION_LIST_LOADING_MESSAGE);
      state.requestUpdate?.();
      return false;
    }
    const initialAccess = readCreateAccess();
    if (!initialAccess.allowed) {
      publishCreateAccessError(initialAccess.reason);
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
      setChatError(state, NEW_SESSION_ACTIVE_RUN_MESSAGE);
      state.requestUpdate?.();
      return false;
    }
    const currentAccess = readCreateAccess();
    if (!currentAccess.allowed) {
      publishCreateAccessError(currentAccess.reason);
      return false;
    }

    setChatError(state, null);
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
          this.resolveObserverDigestHistoryKey(previousSessionKey),
          preResetSessionId,
        );
        // Recompute rather than null: the builtin snapshot also carries the
        // swarm card, which must survive an observer-only invalidation.
        this.refreshBuiltinBoardSnapshot();
      }
      return resetResult !== "failed";
    }
    const nextSessionKey = await sessions.create(createParams);
    if (!isCurrent()) {
      return false;
    }
    if (
      !nextSessionKey ||
      state.sessionKey !== previousSessionKey ||
      !canCreateChatSession(state)
    ) {
      if (!nextSessionKey) {
        setChatError(
          state,
          state.sessionsError ??
            (state.sessionsLoading
              ? NEW_SESSION_LIST_LOADING_MESSAGE
              : NEW_SESSION_CREATE_FAILED_MESSAGE),
        );
        state.requestUpdate?.();
      }
      return false;
    }
    this.chatState.captureCreatedSessionComposer(nextSessionKey);
    this.onPaneSessionChange?.(this.paneId, nextSessionKey);
    return true;
  };

  protected syncActiveBindings() {
    this.nativeDraftCleanup?.();
    this.nativeDraftCleanup = null;
    if (!this.active) {
      this.announceCommandPaletteTarget(null);
      return;
    }
    this.announceCommandPaletteTarget(this.handleCommandPaletteSlashCommand);
    this.applyActiveSessionBindings();
    this.nativeDraftCleanup = this.context.nativeChatDrafts.subscribe((draft) => {
      const state = this.state;
      if (!state || !this.active) {
        return;
      }
      state.handleChatDraftChange(draft);
      state.requestUpdate?.();
    });
    this.sendPendingSkillWorkshopRevision(this.sessionKey);
  }

  protected readonly handlePaneFocus = () => {
    this.onFocusPane?.(this.paneId);
  };

  /** Receives a browser-panel annotation: attach the marked-up screenshot and append the prepackaged prompt. */
  protected receiveBrowserAnnotation(event: Event): void {
    const state = this.state;
    // Only the active pane consumes the annotation; defaultPrevented tells the
    // browser panel it landed (and stops sibling panes from double-adding).
    if (!state || !this.active || event.defaultPrevented || !(event instanceof CustomEvent)) {
      return;
    }
    const detail = event.detail as BrowserAnnotationDraft | null;
    if (!detail || typeof detail.text !== "string" || typeof detail.dataUrl !== "string") {
      return;
    }
    const attachment = chatAttachmentFromDataUrl(detail.dataUrl, detail.fileName || "annotation");
    if (!attachment) {
      return;
    }
    event.preventDefault();
    state.chatAttachments = [...state.chatAttachments, attachment];
    const current = state.chatMessage.trimEnd();
    state.handleChatDraftChange(current ? `${current}\n\n${detail.text}` : detail.text);
    state.requestUpdate?.();
    void this.updateComplete.then(() => {
      this.querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR)?.focus({
        preventScroll: true,
      });
    });
  }

  protected sendPendingSkillWorkshopRevision(expectedSessionKey: string) {
    const state = this.state;
    if (!this.active || !state || !state.connected || state.sessionKey !== expectedSessionKey) {
      return;
    }
    const revision = this.context.skillWorkshopRevision.consume(
      expectedSessionKey,
      this.context.gateway.snapshot.hello,
    );
    if (!revision) {
      return;
    }
    void state
      .handleSendChat(revision.instructions, {
        restoreDraft: true,
        skillWorkshopRevision: {
          proposalId: revision.proposalId,
          agentId: revision.proposalAgentId,
        },
      })
      .catch((error: unknown) => {
        setChatError(state, error instanceof Error ? error.message : String(error));
        state.requestUpdate?.();
      });
  }

  protected readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (
      this.active &&
      !event.defaultPrevented &&
      !event.altKey &&
      event.shiftKey &&
      event.metaKey &&
      !event.ctrlKey &&
      resolveAsciiShortcutKey(event) === "b"
    ) {
      const state = this.state;
      if (!state) {
        return;
      }
      event.preventDefault();
      toggleSessionWorkspace(state);
      return;
    }

    if (
      this.active &&
      !event.defaultPrevented &&
      !event.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key.length === 1 &&
      !keyboardEventPathMatches(event, CHAT_TEXT_ENTRY_SELECTOR) &&
      !(event.key === " " && keyboardEventPathMatches(event, CHAT_SPACE_ACTIVATION_SELECTOR)) &&
      !document.querySelector(CHAT_MODAL_SELECTOR)
    ) {
      const composer = this.querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR);
      if (composer && !composer.disabled && !composer.readOnly) {
        // Focus during keydown capture so the browser delivers beforeinput/input,
        // including the first character, through the composer's normal pipeline.
        composer.focus({ preventScroll: true });
      }
    }

    clearChatModelSearchOnEscape(event);
    if (event.defaultPrevented || event.key !== "Escape") {
      return;
    }
    const state = this.state;
    if (!state) {
      return;
    }
    const openDetails = this.querySelectorAll<HTMLDetailsElement>(CHAT_OPEN_DETAILS_SELECTOR);
    if (openDetails.length > 0) {
      event.preventDefault();
      openDetails.forEach((details) => {
        details.open = false;
      });
      return;
    }
    if (!state.chatViewMenuOpen) {
      return;
    }
    event.preventDefault();
    state.setChatViewMenuOpen(false, { restoreFocus: true });
  };

  protected readonly handleDocumentPointerdown = (event: PointerEvent) => {
    const state = this.state;
    if (!state) {
      return;
    }
    const path = event.composedPath();
    let changed = false;
    this.querySelectorAll<HTMLDetailsElement>(CHAT_OPEN_DETAILS_SELECTOR).forEach((details) => {
      if (!path.includes(details)) {
        details.open = false;
        changed = true;
      }
    });
    if (changed) {
      state.requestUpdate();
    }
    if (!state.chatViewMenuOpen) {
      return;
    }
    const wrapper = this.querySelector(".chat-view-menu-wrapper");
    if (wrapper && path.includes(wrapper)) {
      return;
    }
    state.setChatViewMenuOpen(false);
  };

  override connectedCallback() {
    this.boardProviderLifecycleConnected = true;
    super.connectedCallback();
    this.requestUpdate();
    if (typeof ResizeObserver === "function") {
      this.paneResizeObserver = new ResizeObserver((entries) => {
        const width = entries.at(-1)?.contentRect.width;
        // Hidden panes (narrow split view) report 0; keep the last real width.
        if (typeof width === "number" && width > 0 && width !== this.paneWidth) {
          this.paneWidth = width;
        }
      });
      this.paneResizeObserver.observe(this);
    }
    this.addEventListener("pointerdown", this.handlePaneFocus);
    this.addEventListener("focusin", this.handlePaneFocus);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    document.addEventListener("pointerdown", this.handleDocumentPointerdown, true);
    const chatState = this.chatState;
    chatState.addCleanup(() => {
      document.removeEventListener("keydown", this.handleDocumentKeydown, true);
      document.removeEventListener("pointerdown", this.handleDocumentPointerdown, true);
      this.removeEventListener("pointerdown", this.handlePaneFocus);
      this.removeEventListener("focusin", this.handlePaneFocus);
    });
    const pageState = createPageState(
      this.context,
      chatState.createRenderLifecycle(),
      this,
      this.chatMessagesBySession,
    );
    pageState.chatScrollToEnd = (options) => this.transcript.scrollToEnd(options);
    pageState.createChatSession = () => this.createSession();
    pageState.confirmConversationReset = () => this.confirmConversationReset();
    pageState.exportCurrentChat = () =>
      exportChatMarkdown(pageState.chatMessages, pageState.assistantName);
    pageState.refreshCurrentSessionTools = async () => {
      await pageState.onModelChanged?.();
      pageState.requestUpdate?.();
    };
    pageState.refreshCurrentChat = async () => {
      await refreshPageChat(pageState);
      pageState.requestUpdate?.();
    };
    pageState.refreshSessionPullRequests = (options) => this.refreshSessionPullRequests(options);
    pageState.openSessionCompanion = (question) => this.submitSessionCompanionQuestion(question);
    this.state = pageState;
    if (this.sessionKey) {
      const initialSessionKey = this.setPaneSessionKey(this.sessionKey);
      if (initialSessionKey && !parseCatalogSessionKey(initialSessionKey)) {
        // First-turn handoffs are scoped to their Gateway client and must be
        // claimed before attach starts outbox and transcript hydration.
        pageState.client = this.context.gateway.snapshot.client ?? null;
        const snapshot = readChatSessionSnapshot(pageState.chatMessagesBySession, pageState, {
          sessionKey: initialSessionKey,
        });
        if (snapshot) {
          pageState.chatMessages = snapshot.messages;
          pageState.chatHistoryPagination = snapshot.pagination;
          pageState.currentSessionId = snapshot.sessionId;
          pageState.chatDisplayedLeafEntryId = snapshot.displayedLeafEntryId;
        }
        if (admitInitialTurnHandoff(pageState, initialSessionKey)) {
          pageState.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
          pageState.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
        }
        admitInitialUserMessageHandoff(pageState.initialUserMessage, pageState, initialSessionKey);
      }
    }
    chatState.attach(pageState);
    chatState.restoreComposer({ preserveCurrent: true });
    chatState.startComposerPersistence();
    if (this.draft !== undefined) {
      this.state.handleChatDraftChange(this.draft);
    }
    const handleBrowserAnnotation = (event: Event) => this.receiveBrowserAnnotation(event);
    window.addEventListener(BROWSER_ANNOTATION_EVENT, handleBrowserAnnotation);
    chatState.addCleanup(() =>
      window.removeEventListener(BROWSER_ANNOTATION_EVENT, handleBrowserAnnotation),
    );
    // Interactive widget prompts bubble from the widget iframe; a listener on
    // the pane element keeps split-view routing correct — the prompt reaches
    // only the pane that owns the frame.
    const handleWidgetPrompt = (event: Event) => {
      const detail = (event as CustomEvent<Partial<WidgetPromptEventDetail>>).detail;
      const text = typeof detail?.text === "string" ? detail.text.trim() : "";
      if (text) {
        void this.state?.handleSendChat(text);
      }
    };
    this.addEventListener(WIDGET_PROMPT_EVENT, handleWidgetPrompt);
    chatState.addCleanup(() => this.removeEventListener(WIDGET_PROMPT_EVENT, handleWidgetPrompt));
    chatState.addCleanup(this.context.gateway.subscribe((next) => this.applyGatewaySnapshot(next)));
    chatState.addCleanup(
      this.context.agentSelection.subscribe((next) =>
        applySelectedChatAgent(this.state, next.selectedId),
      ),
    );
    const sessionPullRequests = sessionPullRequestsForGateway(this.context.gateway);
    chatState.addCleanup(
      sessionPullRequests.subscribe(() => {
        void this.refreshSessionPullRequests();
      }),
    );
    chatState.addCleanup(() => sessionPullRequests.unwatch(this));
    chatState.addCleanup(
      this.context.gateway.subscribeEvents((event) => {
        const state = this.state;
        if (event.event === "presence") {
          const hadMultipleIdentities = this.hasMultipleIdentities();
          const presence = readPresenceEntries(event.payload);
          this.presencePayload = presence ? { presence } : undefined;
          if (!this.hasMultipleIdentities()) {
            this.resetSessionSuggestions();
            this.clearTypingActors();
          } else if (!hadMultipleIdentities) {
            void this.refreshSessionSuggestions();
          }
        }
        if (state) {
          if (event.event === "config.changed") {
            invalidateChatAvatarCache(state);
            invalidateAssistantIdentityCache(state.client);
            state.assistantIdentityRequestVersion += 1;
            invalidateChatMetadataCache(state);
            void refreshChatAvatar(state).finally(() => state.requestUpdate?.());
          }
          handleQuestionPromptEvent(this.questionPromptState, event);
        }
        if (state && !parseCatalogSessionKey(state.sessionKey)) {
          if (event.event === "task.suggestion" && event.payload) {
            this.handleTaskSuggestionEvent(event.payload as TaskSuggestionEvent);
          }
          if (event.event === "session.suggestion" && event.payload) {
            this.handleSessionSuggestionEvent(event.payload as SessionSuggestionEvent);
          }
          if (event.event === "session.typing" && event.payload) {
            this.handleSessionTypingEvent(event.payload as SessionTypingEvent);
          }
          if (event.event === "session.observer" && event.payload) {
            this.recordObserverDigest(event.payload as SessionObserverDigest);
          }
          handlePageGatewayEvent(state, event);
        }
      }),
    );
    this.applyApplicationConfig(this.context.config.current);
    chatState.addCleanup(
      this.context.config.subscribe((config) => {
        this.applyApplicationConfig(config);
      }),
    );
    this.applySessionsState(this.context.sessions.state);
    chatState.addCleanup(
      this.context.sessions.subscribe((state) => {
        this.applySessionsState(state);
      }),
    );
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  override willUpdate(changedProperties: Map<PropertyKey, unknown>) {
    if (changedProperties.has("sessionKey") && this.state) {
      const catalogKey = parseCatalogSessionKey(this.sessionKey);
      const nextSessionKey = catalogKey
        ? this.sessionKey
        : resolveSessionKey(this.sessionKey, this.context.gateway.snapshot.hello);
      if (nextSessionKey) {
        // Availability belongs to one activation. The replacement probe starts
        // after its transcript commit in deferSessionHydrationUntilTranscript.
        this.sessionDiscussionStates.delete(nextSessionKey);
      }
      if (nextSessionKey && !areUiSessionKeysEquivalent(nextSessionKey, this.state.sessionKey)) {
        this.switchPaneSession(nextSessionKey);
      } else if (catalogKey && this.catalogRequestedSessionKey !== this.sessionKey) {
        this.catalogLoadGeneration += 1;
        this.openCatalogSession(catalogKey, this.state);
      } else if (nextSessionKey) {
        // Route aliases name the same conversation. Adopt the canonical spelling
        // without clearing the active stream and tool state as a session switch.
        this.state.sessionKey = nextSessionKey;
        // A pane routed straight onto the created session never runs the switch
        // path, so its one-shot handoffs would expire unclaimed: the rejected turn
        // would vanish instead of offering a retry, and the accepted prompt would
        // stay hidden until the transcript bootstrap resolved.
        const rejectedTurn = admitInitialTurnHandoff(this.state, nextSessionKey);
        const acceptedPrompt = admitInitialUserMessageHandoff(
          this.state.initialUserMessage,
          this.state,
          nextSessionKey,
        );
        if (rejectedTurn) {
          this.state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
          this.state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
        }
        if (rejectedTurn || acceptedPrompt) {
          this.requestUpdate();
        }
      }
      this.chatState.restoreCreatedSessionComposer(nextSessionKey);
    }
    if (changedProperties.has("active") || changedProperties.has("sessionKey")) {
      this.syncActiveBindings();
    }
    if (
      changedProperties.has("draft") &&
      this.draft !== undefined &&
      this.state &&
      this.draft !== this.state.chatMessage
    ) {
      this.state.handleChatDraftChange(this.draft);
    }
  }

  override updated(changedProperties: Map<PropertyKey, unknown> = new Map()) {
    if (changedProperties.has("focusComposer") && this.focusComposer) {
      const textarea = this.querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR);
      const input = textarea?.closest<HTMLElement>(".agent-chat__input");
      textarea?.focus({ preventScroll: true });
      if (input) {
        this.showComposerPrefillAttention(input);
      }
    }
    this.cancelResetConfirmationForSessionChange();
    this.syncHistoryObserver();
    const board = this.resolveBoardView();
    this.syncRetainedBoardSession(board);
    const selectedSessionRow = this.state ? selectedChatSessionRow(this.state) : undefined;
    // Active runs count even without a digest: a hidden observer generates
    // none, and the rail module owns the restore control for turning it back on.
    const observerRunId = resolveChatPaneObserverRunId({
      localRunId: this.state?.chatRunId ?? null,
      session: selectedSessionRow,
      digest: null,
    });
    if (this.state?.observerDigest || selectedSessionRow?.observerDigest || observerRunId) {
      this.ensureSessionRail();
    }
  }

  override disconnectedCallback() {
    this.clearComposerPrefillAttention();
    this.retainedBoardSessionKey = "";
    this.boardProviderLifecycleConnected = false;
    this.releaseBoardProviderLease();
    this.settleResetConfirmation(false);
    this.paneResizeObserver?.disconnect();
    this.paneResizeObserver = null;
    this.connectionGeneration += 1;
    this.deferredSessionHydrationRequestVersion += 1;
    this.sessionDiscussionPanels.clear();
    this.sessionCompanionHydrationKey = "";
    this.taskSuggestionsRequestVersion += 1;
    this.taskSuggestions = [];
    this.taskSuggestionBusyIds.clear();
    this.taskSuggestionOperations.clear();
    this.resetSessionSuggestions();
    this.clearTypingActors();
    this.resetSessionPullRequests();
    this.resetOlderMessagesViewport();
    this.nativeDraftCleanup?.();
    this.nativeDraftCleanup = null;
    if (this.headerCopiedTimer !== null) {
      window.clearTimeout(this.headerCopiedTimer);
      this.headerCopiedTimer = null;
    }
    this.swarmHydrator?.dispose();
    this.swarmHydrator = null;
    this.headerWorktreePaths.clear();
    this.headerBranches.clear();
    this.presencePayload = undefined;
    this.announceCommandPaletteTarget(null);
    dismissConfirmedActionPopovers(this);
    resetChatViewState(this.paneId);
    this.state = undefined;
    this.connectedClient = null;
    disposeQuestionPromptState(this.questionPromptState);
    super.disconnectedCallback();
  }
}
