import type {
  SessionSuggestionEvent,
  SessionTypingEvent,
  TaskSuggestionEvent,
} from "../../../../packages/gateway-protocol/src/index.js";
import { invalidateAssistantIdentityCache } from "../../app/assistant-identity.ts";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import {
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
} from "../../app/question-prompt.ts";
import { CHAT_ROUTE_READY_EVENT } from "../../app/route-transition.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { BROWSER_ANNOTATION_EVENT } from "../../components/browser/browser-annotation.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  isTerminalPanelShortcut,
  TERMINAL_PANEL_DOCK_BOTTOM_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../../components/panel-toggle-contract.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../lib/keyboard-shortcut-catalog.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import * as chatAvatars from "./chat-avatar.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import {
  type ChatAttachmentGatewayOwner,
  ChatPaneComposerHandoff,
  discardStateStagedAttachments,
  preparePaneStagedAttachments,
  replacePaneStagedAttachmentGatewayOwner,
  restorePaneStagedAttachments,
} from "./chat-pane-attachment-handoff.ts";
import {
  focusBrowserAnnotationComposerAfterUpdate,
  receiveBrowserAnnotation as admitBrowserAnnotation,
} from "./chat-pane-browser-annotation.ts";
import { releaseAttachmentWorkspaceOwner } from "./chat-pane-rails.ts";
import { ChatPaneSessionCreation } from "./chat-pane-session-creation.ts";
import { ChatPaneSessionPanelToggleController } from "./chat-pane-session-panel-toggle.ts";
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  CHAT_OPEN_DETAILS_SELECTOR,
  focusChatComposerFromPrintableKeydown,
} from "./chat-pane-shared.ts";
import {
  subscribeChatPaneSnapshotInvalidation,
  subscribeChatPaneStartup,
} from "./chat-pane-startup-subscriptions.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { createPageState } from "./chat-state-page.ts";
import {
  applyChatAgentOwnerTransition,
  applySelectedChatAgent,
  refreshPageChat,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { publishChatWorkContext } from "./chat-work-context.ts";
import { dismissConfirmedActionPopovers } from "./components/chat-message.ts";
import { clearChatModelSearchOnEscape } from "./components/chat-model-picker.ts";
import { dismissThreadPortals } from "./components/chat-thread-interactions.ts";
import { WIDGET_PROMPT_EVENT, type WidgetPromptEventDetail } from "./components/chat-tool-cards.ts";
import { CHAT_COMPOSER_DRAFT_STORAGE_ERROR } from "./composer-persistence.ts";
import { exportChatMarkdown } from "./export.ts";
import { admitChatSubmission } from "./history-merge.ts";
import { admitInitialTurnHandoff } from "./initial-turn-handoff.ts";
import {
  applyChatCacheSnapshot,
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  resolveChatSnapshotKey,
} from "./session-message-cache.ts";
import { closeSlot, isSidebarSlotVisible, openSlot, type SidebarSlotId } from "./sidebar-layout.ts";
import { subscribeToolTitleChanges } from "./tool-titles.ts";

export abstract class ChatPaneLifecycle extends ChatPaneSessionCreation {
  private readonly sessionPanelToggles = new ChatPaneSessionPanelToggleController({
    current: () => {
      const state = this.state;
      return state && this.active && this.presented
        ? { renderRoot: this.renderRoot, state, updateComplete: this.updateComplete }
        : null;
    },
    pending: this.pendingPanelToggleRequests,
    requestUpdate: () => this.requestUpdate(),
    updateSidebarLayout: (layout) => this.commitSidebarLayout(layout),
  });

  private chatRouteReadyReported = false;
  private currentSessionArchived: boolean | undefined;
  private stagedAttachmentGatewayOwner: ChatAttachmentGatewayOwner = null;
  private suppressStagedAttachmentHandoffOnDisconnect = false;
  private composerPresentation: ChatPaneComposerHandoff | undefined;

  protected activateComposerPresentation(): void {
    if (this.selected && this.presented) {
      this.composerPresentation?.claim();
    }
  }

  private hydrateStoredChatSnapshot(
    state: NonNullable<ChatPaneLifecycle["state"]>,
    sessionKey: string,
  ): void {
    const store = this.sessionSnapshotStore;
    if (!store) {
      return;
    }
    const cacheKey = resolveChatSnapshotKey(state, { sessionKey });
    void store.read(cacheKey).then((snapshot) => {
      if (
        !snapshot ||
        this.state !== state ||
        !areUiSessionKeysEquivalent(state.sessionKey, sessionKey) ||
        readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey })
      ) {
        return;
      }
      // The memory miss fences network replacement; the pane projection merges
      // live and pending rows that arrived while IndexedDB was pending.
      applyChatCacheSnapshot(state, snapshot);
      const mergedSnapshot = { ...snapshot, messages: state.chatMessages };
      cacheChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey }, mergedSnapshot);
      state.requestUpdate?.();
    });
  }

  public discardStagedAttachments(): void {
    // Explicit pane disposal is terminal. The DOM disconnect that follows must
    // not recreate an empty fallback handoff under a later reused pane id.
    this.suppressStagedAttachmentHandoffOnDisconnect = true;
    this.chatState.attachmentReads.abortReads();
    discardStateStagedAttachments(this.state);
  }

  public resumeStagedAttachments(): void {
    this.suppressStagedAttachmentHandoffOnDisconnect = false;
  }

  protected browserAnnotationOwner(): NonNullable<ChatAttachmentGatewayOwner> | undefined {
    return this.stagedAttachmentGatewayOwner ?? undefined;
  }

  protected replaceStagedAttachmentGatewayOwner(nextOwner: ChatAttachmentGatewayOwner): void {
    this.stagedAttachmentGatewayOwner = replacePaneStagedAttachmentGatewayOwner(
      this.context,
      this.paneId,
      this.state,
      this.stagedAttachmentGatewayOwner,
      nextOwner,
    );
  }

  protected syncActiveBindings() {
    this.nativeDraftCleanup?.();
    this.nativeDraftCleanup = null;
    if (!this.state || !this.active || !this.presented) {
      this.announceCommandPaletteTarget(null);
      return;
    }
    this.announceCommandPaletteTarget(this.handleCommandPaletteSlashCommand);
    this.nativeDraftCleanup = this.context.nativeChatDrafts.subscribe((draft) => {
      const state = this.state;
      if (!state || !this.active || !this.presented) {
        return;
      }
      state.handleChatDraftChange(draft);
      state.requestUpdate?.();
    });
  }

  protected readonly handlePaneFocus = () => {
    chatInputOwnerForContext(this.context).claim(this.inputRegion);
    this.onFocusPane?.(this.paneId);
  };

  /** Receives one complete browser annotation without mixing generated context into the user's draft. */
  protected receiveBrowserAnnotation(event: Event): void {
    if (!admitBrowserAnnotation(this.state, this.active && this.presented, event)) {
      return;
    }
    // A null mount binds only when its first annotation ownership begins.
    this.stagedAttachmentGatewayOwner ??= this.context.gateway.snapshot.client;
    focusBrowserAnnotationComposerAfterUpdate(this);
  }

  protected readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    const state = this.state;
    // Retained panes keep their document listeners; only the current input owner
    // may consume a key before the visible pane receives it.
    if (
      !state ||
      !this.active ||
      !this.presented ||
      event.defaultPrevented ||
      document.querySelector(".shell-nav[aria-modal='true']")
    ) {
      return;
    }
    const togglePanelSlot = (slot: SidebarSlotId) => {
      const visible = isSidebarSlotVisible(state.sidebarLayout, slot);
      if (visible) {
        releaseAttachmentWorkspaceOwner(state, slot);
      }
      this.commitSidebarLayout(
        visible ? closeSlot(state.sidebarLayout, slot) : openSlot(state.sidebarLayout, slot),
      );
    };
    if (state.terminalAvailable && isTerminalPanelShortcut(event)) {
      event.preventDefault();
      togglePanelSlot("terminal");
      return;
    }
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.workspaceFiles, event)) {
      event.preventDefault();
      togglePanelSlot("workspace");
      return;
    }

    focusChatComposerFromPrintableKeydown(this, event);

    clearChatModelSearchOnEscape(event);
    if (event.defaultPrevented || event.key !== "Escape") {
      return;
    }
    const openDetails = this.querySelectorAll<HTMLDetailsElement>(CHAT_OPEN_DETAILS_SELECTOR);
    if (openDetails.length > 0) {
      event.preventDefault();
      openDetails.forEach((details) => {
        details.open = false;
      });
    }
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
  };

  override connectedCallback() {
    this.boardProviderLifecycleConnected = true;
    this.resumeStagedAttachments();
    super.connectedCallback();
    if (!this.presented) {
      this.minutePoll.stop();
    }
    const mountGatewayOwner = this.context.gateway.snapshot.client;
    this.stagedAttachmentGatewayOwner = mountGatewayOwner;
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
    chatState.addCleanup(() => publishChatWorkContext(this.context, this));
    chatState.addCleanup(subscribeToolTitleChanges(() => this.state?.requestUpdate?.()));
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
    const paneAgentId = parseAgentSessionKey(this.sessionKey)?.agentId ?? this.agentId;
    if (paneAgentId) {
      pageState.assistantAgentId = paneAgentId;
      pageState.agentsSelectedId = paneAgentId;
    }
    if (this.compact) {
      pageState.sidebarLayout = { ...pageState.sidebarLayout, open: false };
    }
    pageState.getWorkContext = () => this.workContext;
    // Task tabs can precede main chat in DOM order; viewport reads and commands
    // must resolve through the same transcript owner.
    pageState.chatIsProgrammaticScroll = () => this.transcript.isProgrammaticScroll;
    pageState.chatScrollElement = () => this.transcript.scrollElement;
    pageState.chatScrollToEnd = (options) => this.transcript.scrollToEnd(options);
    pageState.createChatSession = () => this.createSession();
    pageState.confirmConversationReset = () => this.confirmConversationReset();
    pageState.exportCurrentChat = () =>
      exportChatMarkdown(pageState.chatMessages, pageState.assistantName);
    // Effective-tools previews key their requests on the model override, so a
    // post-switch refresh only needs a re-render.
    pageState.refreshCurrentSessionTools = async () => {
      pageState.requestUpdate?.();
    };
    pageState.refreshCurrentChat = async () => {
      await refreshPageChat(pageState);
      pageState.requestUpdate?.();
    };
    pageState.refreshSessionPullRequests = (options) => this.refreshSessionPullRequests(options);
    pageState.openSessionCompanion = (question) => this.submitSessionCompanionQuestion(question);
    pageState.retireSessionCompanion = (key, agentId) =>
      this.sessionCompanionThreads.retire(key, agentId);
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
          applyChatCacheSnapshot(pageState, snapshot);
        } else {
          this.hydrateStoredChatSnapshot(pageState, initialSessionKey);
        }
        if (admitInitialTurnHandoff(pageState, initialSessionKey)) {
          pageState.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
          pageState.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
        }
        admitChatSubmission(pageState);
      }
    }
    chatState.attach(pageState);
    chatState.restoreComposer({ preserveCurrent: true });
    const sessionHandoff = this.takeSessionHandoff(pageState.sessionKey);
    if (sessionHandoff?.restore) {
      this.applySessionHandoff(pageState.sessionKey, sessionHandoff, false);
    }
    restorePaneStagedAttachments(this.context, this.paneId, pageState, mountGatewayOwner);
    chatState.startComposerPersistence();
    if (sessionHandoff && !sessionHandoff.restore) {
      this.applySessionHandoff(pageState.sessionKey, sessionHandoff, true);
    }
    if (this.draft !== undefined) {
      this.state.handleChatDraftChange(this.draft);
    }
    const handleBrowserAnnotation = (event: Event) => this.receiveBrowserAnnotation(event);
    window.addEventListener(BROWSER_ANNOTATION_EVENT, handleBrowserAnnotation);
    chatState.addCleanup(() =>
      window.removeEventListener(BROWSER_ANNOTATION_EVENT, handleBrowserAnnotation),
    );
    const panelToggleEvents = [
      [TERMINAL_PANEL_TOGGLE_EVENT, "terminal", "openclaw-terminal-panel"],
      [BROWSER_PANEL_TOGGLE_EVENT, "browser", "openclaw-browser-panel"],
      [DESKTOP_PANEL_TOGGLE_EVENT, "desktop", "openclaw-desktop-panel"],
    ] as const;
    const panelToggleCleanups = panelToggleEvents.map(([eventName, slot, tagName]) => {
      const listener = (event: Event) => {
        this.sessionPanelToggles.handle(slot, tagName, event);
      };
      window.addEventListener(eventName, listener);
      return () => window.removeEventListener(eventName, listener);
    });
    const handleTerminalDockBottom = () => {
      const state = this.state;
      if (!state || !this.active || !this.presented) {
        return;
      }
      state.updateSidebarLayout(closeSlot(state.sidebarLayout, "terminal"));
    };
    window.addEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, handleTerminalDockBottom);
    chatState.addCleanup(() => {
      panelToggleCleanups.forEach((cleanup) => cleanup());
      window.removeEventListener(TERMINAL_PANEL_DOCK_BOTTOM_EVENT, handleTerminalDockBottom);
      this.pendingPanelToggleRequests.clear();
    });
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
      this.context.theme.subscribe(() => {
        pageState.settings = {
          ...this.context.theme.settings,
          token: this.context.gateway.connection.token,
        };
        pageState.requestUpdate();
      }),
    );
    chatState.addCleanup(
      this.context.agentSelection.subscribe((next) => {
        applySelectedChatAgent(this.state, this.agentId ?? next.selectedId);
        if (this.state) {
          void syncSelectedSessionMessageSubscription(this.state);
        }
        this.activateComposerPresentation();
      }),
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
            chatAvatars.invalidateChatAvatarCache(state);
            invalidateAssistantIdentityCache(state.client);
            state.assistantIdentityRequestVersion += 1;
            void chatAvatars.refreshChatAvatar(state).finally(() => state.requestUpdate?.());
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
          if (event.event === "session.message") {
            this.clearTypingActorForSessionMessage(event.payload);
          }
          handlePageGatewayEvent(state, event, () => this.presented);
        }
      }),
    );
    this.applyApplicationConfig(this.context.config.current);
    chatState.addCleanup(this.context.config.subscribe(this.applyApplicationConfig.bind(this)));
    this.applySessionsState(this.context.sessions.state);
    chatState.addCleanup(this.context.sessions.subscribe(this.applySessionsState.bind(this)));
    chatState.addCleanup(subscribeChatPaneStartup(this.context, () => this.state));
    chatState.addCleanup(subscribeChatPaneSnapshotInvalidation(() => this.state));
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
    this.composerPresentation = new ChatPaneComposerHandoff(this.context, {
      state: () => this.state,
      owner: () => this.stagedAttachmentGatewayOwner,
      region: () => this.inputRegion,
      presented: () => this.selected && this.presented,
      pause: () => this.chatState.pauseComposerPersistence(),
      resume: (restore) => {
        if (restore) {
          this.chatState.restoreComposer();
        }
        this.chatState.startComposerPersistence();
      },
    });
    this.activateComposerPresentation();
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
      if (catalogKey && this.catalogRequestedSessionKey !== this.sessionKey) {
        this.catalogLoadGeneration += 1;
        this.openCatalogSession(catalogKey, this.state);
      } else if (nextSessionKey) {
        // A retained pane owns one conversation for its lifetime. Only its
        // canonical spelling can change after Gateway defaults resolve.
        this.state.sessionKey = nextSessionKey;
        const nextAgentId = parseAgentSessionKey(nextSessionKey)?.agentId;
        if (nextAgentId) {
          applyChatAgentOwnerTransition(this.state, nextAgentId);
        }
        // A pane routed straight onto the created session never runs the switch
        // path, so its one-shot handoffs would expire unclaimed: the rejected turn
        // would vanish instead of offering a retry, and the accepted prompt would
        // stay hidden until the transcript bootstrap resolved.
        const rejectedTurn = admitInitialTurnHandoff(this.state, nextSessionKey);
        const acceptedPrompt = admitChatSubmission(this.state);
        if (rejectedTurn) {
          this.state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
          this.state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
        }
        if (rejectedTurn || acceptedPrompt) {
          this.requestUpdate();
        }
      }
      if (nextSessionKey) {
        const handoff = this.takeSessionHandoff(nextSessionKey);
        if (handoff) {
          this.applySessionHandoff(nextSessionKey, handoff, true);
        }
      }
    }
    if (changedProperties.has("sessionKey") || changedProperties.has("inputRegion")) {
      this.syncActiveBindings();
      this.activateComposerPresentation();
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
    void chatAvatars.refreshSenderAgentAvatars(this.state);
    if (!this.chatRouteReadyReported && this.querySelector(CHAT_COMPOSER_TEXTAREA_SELECTOR)) {
      // The outer router commit is not a meaningful chat paint. Keep the
      // handoff cover until this pane has committed its usable composer.
      this.chatRouteReadyReported = true;
      this.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT, { bubbles: true, composed: true }));
    }
    if (changedProperties.has("focusComposer") && this.focusComposer) {
      const textarea = this.querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR);
      const input = textarea?.closest<HTMLElement>(".agent-chat__input");
      textarea?.focus({ preventScroll: true });
      if (input) {
        this.showComposerPrefillAttention(input);
      }
    }
    const archived = this.state ? this.isCurrentSessionArchived(this.state) : false;
    if (archived && this.currentSessionArchived === false) {
      dismissThreadPortals(this.presentationId, this);
      this.querySelector<HTMLElement>(".chat-thread")?.focus({ preventScroll: true });
    }
    this.currentSessionArchived = archived;
    this.cancelResetConfirmationForSessionChange();
    this.syncHistoryObserver();
    const board = this.resolveBoardView();
    this.syncRetainedBoardSession(board);
    this.sessionPanelToggles.flush();
  }

  override disconnectedCallback() {
    this.composerPresentation?.dispose();
    this.composerPresentation = undefined;
    if (this.state) {
      chatAvatars.invalidateChatAvatarCache(this.state);
      retireChatMetadataRequests(this.state);
      if (this.suppressStagedAttachmentHandoffOnDisconnect) {
        // MCP app teardown can delay DOM removal after pane close. Finalize any
        // attachment that completed during that delay instead of leaking it.
        discardStateStagedAttachments(this.state);
      } else {
        preparePaneStagedAttachments(
          this.context,
          this.paneId,
          this.state,
          this.stagedAttachmentGatewayOwner,
        );
      }
    }
    this.stagedAttachmentGatewayOwner = null;
    this.clearComposerPrefillAttention();
    this.retainedBoardSessionKey = "";
    this.boardProviderLifecycleConnected = false;
    this.releaseBoardProviderLease();
    this.settleResetConfirmation(false);
    this.paneResizeObserver?.disconnect();
    this.paneResizeObserver = null;
    this.connectionGeneration += 1;
    this.retireHeaderSessionMutations();
    this.retireDeferredSessionHydration();
    this.sessionDiscussionPanels.clear();
    this.taskSuggestionsRequestVersion += 1;
    this.setTaskSuggestions([]);
    this.taskSuggestionBusyIds.clear();
    this.taskSuggestionOperations.clear();
    this.resetTaskSuggestionCloudProfiles();
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
    resetChatViewState(this.presentationId);
    this.state = undefined;
    this.connectedClient = null;
    disposeQuestionPromptState(this.questionPromptState);
    super.disconnectedCallback();
  }
}
