import {
  BROWSER_ANNOTATION_EVENT,
  WIDGET_PROMPT_EVENT,
  admitInitialUserMessageHandoff,
  areUiSessionKeysEquivalent,
  chatAttachmentFromDataUrl,
  createPageState,
  disposeQuestionPromptState,
  dismissConfirmedActionPopovers,
  ensureBoardViewElement,
  ensureWorkboardCardChipElement,
  exportChatMarkdown,
  handlePageGatewayEvent,
  handleQuestionPromptEvent,
  parseCatalogSessionKey,
  readChatSessionSnapshot,
  readPresenceEntries,
  refreshPageChat,
  resetChatViewState,
  resolveChatPaneObserverRunId,
  resolveSessionKey,
  toggleSessionWorkspace,
  type BrowserAnnotationDraft,
  type SessionObserverDigest,
  type SessionSuggestionEvent,
  type SessionTypingEvent,
  type TaskSuggestionEvent,
  type WidgetPromptEventDetail,
} from "./chat-pane-deps.ts";
import { ChatPaneReset } from "./chat-pane-reset.ts";
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  CHAT_MODAL_SELECTOR,
  CHAT_OPEN_DETAILS_SELECTOR,
  CHAT_SPACE_ACTIVATION_SELECTOR,
  CHAT_TEXT_ENTRY_SELECTOR,
  keyboardEventPathMatches,
} from "./chat-pane-shared.ts";

export abstract class ChatPaneLifecycle extends ChatPaneReset {
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
    const revision = this.context.skillWorkshopRevision.consume(expectedSessionKey);
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
        state.lastError = error instanceof Error ? error.message : String(error);
        state.chatError = state.lastError;
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
      event.key.toLowerCase() === "b"
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
    this.state = pageState;
    if (this.sessionKey) {
      const initialSessionKey = this.setPaneSessionKey(this.sessionKey);
      if (initialSessionKey && !parseCatalogSessionKey(initialSessionKey)) {
        const snapshot = readChatSessionSnapshot(pageState.chatMessagesBySession, pageState, {
          sessionKey: initialSessionKey,
        });
        if (snapshot) {
          pageState.chatMessages = snapshot.messages;
          pageState.chatHistoryPagination = snapshot.pagination;
          pageState.currentSessionId = snapshot.sessionId;
          pageState.chatDisplayedLeafEntryId = snapshot.displayedLeafEntryId;
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
    chatState.addCleanup(
      this.context.gateway.subscribe((snapshot) => {
        this.applyGatewaySnapshot(snapshot);
      }),
    );
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
        this.sessionDiscussionStates.delete(nextSessionKey);
        // Resolve availability before the action renders: the methods are
        // advertised even without a provider, so an unprobed session would
        // otherwise show a dead Discussion button on provider-less installs.
        void this.probeSessionDiscussion(nextSessionKey);
      }
      if (nextSessionKey && nextSessionKey !== this.state.sessionKey) {
        this.switchPaneSession(nextSessionKey);
      } else if (catalogKey && this.catalogRequestedSessionKey !== this.sessionKey) {
        this.catalogLoadGeneration += 1;
        this.openCatalogSession(catalogKey, this.state);
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

  override updated() {
    this.cancelResetConfirmationForSessionChange();
    this.syncHistoryObserver();
    const board = this.resolveBoardView();
    if (this.resolveWorkboardCardChip(board)) {
      void ensureWorkboardCardChipElement().catch(() => undefined);
    }
    if (
      board.hasBoard &&
      board.face === "dashboard" &&
      !customElements.get("openclaw-board-view")
    ) {
      void ensureBoardViewElement().then((loaded) => {
        if (loaded) {
          this.requestUpdate();
        }
      });
    }
    const selectedSessionRow = this.state?.sessionsResult?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, this.state?.sessionKey ?? ""),
    );
    // Active runs count even without a digest: a hidden observer generates
    // none, and the HUD module owns the restore control for turning it back on.
    const observerRunId = resolveChatPaneObserverRunId({
      localRunId: this.state?.chatRunId ?? null,
      session: selectedSessionRow,
      digest: null,
    });
    if (this.state?.observerDigest || selectedSessionRow?.observerDigest || observerRunId) {
      this.ensureObserverHud();
    }
  }

  protected ensureObserverHud() {
    if (this.observerHudReady || this.observerHudLoad) {
      return;
    }
    this.observerHudLoad = import("./components/chat-observer-hud.ts")
      .then(() => {
        if (this.isConnected) {
          this.observerHudReady = true;
        }
      })
      .finally(() => {
        this.observerHudLoad = null;
      });
  }

  override disconnectedCallback() {
    this.boardProviderLifecycleConnected = false;
    this.releaseBoardProviderLease();
    this.settleResetConfirmation(false);
    this.paneResizeObserver?.disconnect();
    this.paneResizeObserver = null;
    this.connectionGeneration += 1;
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
