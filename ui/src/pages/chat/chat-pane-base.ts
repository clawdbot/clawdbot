import { consume } from "@lit/context";
import { property, state as litState } from "lit/decorators.js";
import type {
  SessionCatalogHost,
  SessionCatalogSession,
  SessionDiscussionState,
  SessionSharingRole,
  SessionSuggestion,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { chatInputOwnerForContext, type ChatInputRegion } from "../../app/chat-input-owner.ts";
import { applicationContext } from "../../app/context.ts";
import { observeNativeGateway } from "../../app/native-editor-locality.runtime.ts";
import type {
  NativeGatewaysCapability,
  NativeGatewaysSnapshot,
} from "../../app/native-gateways.runtime.ts";
import {
  createQuestionPromptState,
  listQuestionPrompts,
  type QuestionPrompt,
} from "../../app/question-prompt.ts";
import type { PresencePayload } from "../../app/user-profile.ts";
import { SessionProgressCardController } from "../../components/session-progress-card-controller.ts";
import type {
  BoardCommandEvent,
  BoardProvider,
  BoardProviderLease,
} from "../../lib/board/provider.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { GitHubPublicationBinding } from "../../lib/sessions/session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import type { SwarmRosterHydrator } from "../../lib/sessions/swarm-roster.ts";
import { SessionUnreadPatchGuard } from "../../lib/sessions/unread.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { ChatComposerCapabilityHost } from "./chat-composer-capability-host.ts";
import { CHAT_PANE_LIFECYCLE_CHANGED_EVENT } from "./chat-history-events.ts";
import { getAcceptedChatHistorySession, getChatHistoryLoadState } from "./chat-history-state.ts";
import { sendSessionObserverVisibility } from "./chat-observer.ts";
import type {
  ChatPaneConnectionScope,
  ChatPageContext,
  PaneSessionChangeOptions,
} from "./chat-pane-shared.ts";
import { SessionParticipationTracker } from "./chat-pane-state.ts";
import {
  ChatSessionCompanionThreads,
  requestSessionCompanionAnswer,
  requestSessionCompanionState,
} from "./chat-session-companion.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { requestChatPageUpdate } from "./chat-state-render.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatPaneHeaderAction } from "./components/chat-pane-header.ts";
import type { ChatSessionSharingState } from "./components/chat-session-sharing.ts";
import { ChatTranscriptController } from "./components/chat-transcript-controller.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import { handleChatScrollTakeover } from "./scroll.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { SidebarLayout } from "./sidebar-layout-types.ts";
import {
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  setSidebarOpen,
} from "./sidebar-layout.ts";

export abstract class ChatPaneBase extends OpenClawLightDomElement {
  private paneLifecycleRoot: Element | null = null;
  // The first Lit update must render even while hidden; later hidden work parks.
  // Disconnect releases the waiter so reconnect can schedule in its new lifecycle.
  private hiddenUpdateResume: (() => void) | undefined;
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState !== "hidden") {
      this.hiddenUpdateResume?.();
      return;
    }
    const state = this.state;
    if (!state) {
      return;
    }
    const liveDraft = getChatComposerState(this.paneId).composerTextarea?.value;
    const draftChanged = liveDraft !== undefined && liveDraft !== state.chatMessage;
    if (draftChanged) {
      // Page suspension can interrupt IME before compositionend; commit the
      // live textarea while visibility change can still reach browser storage.
      state.handleChatDraftChange(liveDraft);
    }
    if (draftChanged || state.chatStreamRenderFrame != null) {
      requestChatPageUpdate(state);
    }
  };
  override connectedCallback() {
    this.paneLifecycleRoot = this.closest("openclaw-app-shell") ?? this.parentElement;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    super.connectedCallback();
    this.paneLifecycleRoot?.dispatchEvent(new Event(CHAT_PANE_LIFECYCLE_CHANGED_EVENT));
  }
  protected override async scheduleUpdate() {
    while (this.hasUpdated && this.isConnected && document.visibilityState === "hidden") {
      await new Promise<void>((resolve) => {
        this.hiddenUpdateResume = resolve;
      });
    }
    await super.scheduleUpdate();
  }

  override disconnectedCallback() {
    this.hiddenUpdateResume?.();
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    super.disconnectedCallback();
    // A removed Home pane cannot bubble its final loading edge. Notify its
    // former shell so background history does not stay blocked on that pane.
    const paneRoot = this.paneLifecycleRoot;
    this.paneLifecycleRoot = null;
    this.conversationVisible = false;
    paneRoot?.dispatchEvent(new Event(CHAT_PANE_LIFECYCLE_CHANGED_EVENT));
  }

  // Relative labels still need a minute tick; external PR state is server-pushed.
  readonly minutePoll = new PollController(this, 60_000, () => {
    this.requestUpdate();
  });
  @consume({ context: applicationContext, subscribe: true })
  protected context!: ChatPageContext;
  @property({ attribute: false }) paneId = "single";
  @property({ attribute: false }) presentationId = "single";
  @property({ attribute: false }) chatMessagesBySession?: ChatMessageCache;
  @property({ attribute: false }) sessionSnapshotStore?: SessionSnapshotStore;
  // Empty means unresolved route data: boot on the page state's default session
  // without canonicalizing until the container supplies a real key.
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId?: string;
  @property({ attribute: false }) inputRegion: ChatInputRegion = "page";
  @property({ attribute: false }) compact = false;
  @property({ attribute: false }) workContext?: string;
  // Route ownership settles after retained-pane preview; dashboard activity follows
  // the pane the user can already see so its warmed runtime paints immediately.
  private visuallyPresentedValue = true;
  private conversationVisible = false;
  get visuallyPresented(): boolean {
    return this.visuallyPresentedValue;
  }
  set visuallyPresented(value: boolean) {
    const previous = this.visuallyPresentedValue;
    if (value === previous) {
      return;
    }
    const wasConversationPresented = this.conversationPresented;
    this.visuallyPresentedValue = value;
    this.requestUpdate("visuallyPresented", previous);
    this.notifyConversationPresentation(wasConversationPresented);
  }
  /** The pane's committed layout and both visual and route ownership permit idle warming. */
  get conversationPresented(): boolean {
    return this.presented && this.visuallyPresented && this.conversationVisible;
  }
  protected setConversationVisible(visible: boolean): void {
    const wasConversationPresented = this.conversationPresented;
    this.conversationVisible = visible;
    this.notifyConversationPresentation(wasConversationPresented);
  }
  private notifyConversationPresentation(wasPresented: boolean): void {
    if (wasPresented !== this.conversationPresented) {
      this.dispatchEvent(
        new Event(CHAT_PANE_LIFECYCLE_CHANGED_EVENT, { bubbles: true, composed: true }),
      );
    }
  }
  private activeValue = false;
  private headerPresentationGeneration = 0;
  private presentedValue = true;
  get presented(): boolean {
    return this.presentedValue;
  }
  set presented(value: boolean) {
    const previous = this.presentedValue;
    if (value === previous) {
      return;
    }
    const wasConversationPresented = this.conversationPresented;
    this.headerPresentationGeneration += 1;
    this.presentedValue = value;
    this.requestUpdate("presented", previous);
    this.presentedChanged(value);
    this.notifyConversationPresentation(wasConversationPresented);
  }
  protected presentedChanged(_presented: boolean): void {}
  /** True while the authoritative transcript for this pane is still being fetched. */
  get transcriptLoading(): boolean {
    const phase = this.state ? getChatHistoryLoadState(this.state).phase : "idle";
    return phase === "pending-connection" || phase === "in-flight";
  }
  /** The initial authoritative transcript has a visible result, including errors. */
  get transcriptReady(): boolean {
    const phase = this.state ? getChatHistoryLoadState(this.state).phase : "idle";
    return phase === "committed" || phase === "failed";
  }
  protected get headerOutcomeOwner(): string {
    return `${this.connectionGeneration}:${this.headerPresentationGeneration}`;
  }
  protected ownsHeaderOutcome(owner: string): boolean {
    return this.presented && owner === this.headerOutcomeOwner;
  }
  protected get selected(): boolean {
    return this.activeValue;
  }
  get active(): boolean {
    // The selected split pane stays selected while another region owns input.
    return (
      this.activeValue &&
      (!this.context || chatInputOwnerForContext(this.context).current === this.inputRegion)
    );
  }
  set active(value: boolean) {
    const previous = this.activeValue;
    if (value === previous) {
      return;
    }
    this.activeValue = value;
    this.requestUpdate("active", previous);
    this.activeChanged(this.active);
  }
  protected activeChanged(_active: boolean): void {}
  // Call wherever connectionGeneration itself advances (reconnect, capability
  // replacement, pane teardown) so a header confirm dialog open across that
  // boundary dismisses itself instead of confirming into a retired scope.
  protected retireHeaderSessionMutations(): void {
    this.headerSessionMutationAbortController.abort();
    this.headerSessionMutationAbortController = new AbortController();
  }
  @property({ attribute: false }) draft?: string;
  @property({ attribute: false }) focusComposer = false;
  @property({ attribute: false }) dashboardExpanded = false;
  @property({ attribute: false }) routeFace: BoardFace = "chat";
  @property({ attribute: false }) onFaceChange?: (
    paneId: string,
    sessionKey: string,
    face: BoardFace,
  ) => void;
  @property({ attribute: false }) onFocusPane?: (paneId: string) => void;
  onPaneSessionChange?: (
    paneId: string,
    nextSessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => boolean | void;
  @property({ attribute: false }) onSessionDeleted?: (
    paneId: string,
    sessionKey: string,
    replacementSessionKey: string,
    preserveDraft?: boolean,
  ) => void;
  @property({ attribute: false }) paneTitle = "";
  @property({ attribute: false }) narrow = false;
  @property({ attribute: false }) mergedChrome = false;
  @property({ attribute: false }) navDrawerOpen = false;
  @property({ attribute: false }) nativeGateways?: NativeGatewaysCapability | null;
  @property({ attribute: false }) gatewaysSnapshot?: NativeGatewaysSnapshot | null;
  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) onOpenSplitView?: () => void;
  @property({ attribute: false }) onSplitDown?: (paneId: string) => void;
  @property({ attribute: false }) onSplitRight?: (paneId: string) => void;
  @property({ attribute: false }) onClosePane?: (paneId: string) => void;
  @property({ attribute: false }) boardProvider?: BoardProvider;

  protected readonly chatState = new ChatStateController<ChatPageHost>(this);
  protected readonly composerCapabilities = new ChatComposerCapabilityHost(() =>
    this.requestUpdate(),
  );
  protected readonly transcript = new ChatTranscriptController(this, {
    onViewportResize: () => this.chatState.handleTranscriptResize(),
    onReaderScroll: () => this.state && handleChatScrollTakeover(this.state),
  });
  protected readonly taskSidebarTranscript = new ChatTranscriptController(this);
  protected readonly progressCard = new SessionProgressCardController(this, {
    gateway: () => this.context?.gateway,
    target: () => {
      const state = this.state;
      if (!state || this.isCurrentSessionArchived(state)) {
        return undefined;
      }
      return this.resolveChatReadTarget();
    },
  });
  protected readonly questionPromptState = createQuestionPromptState(() => {
    this.questionPrompts = listQuestionPrompts(this.questionPromptState);
    this.requestUpdate();
  });
  protected questionPrompts: QuestionPrompt[] = [];
  protected state: ChatPageHost | undefined;

  protected resolveChatReadTarget(): ReturnType<typeof resolveUiConversationIdentity> | undefined {
    const state = this.state;
    if (!state) {
      return undefined;
    }
    const identity = resolveUiConversationIdentity(state, state.sessionKey);
    if (identity.agentId) {
      return identity;
    }
    const session = getAcceptedChatHistorySession(state);
    // Raw retained panes follow their accepted history owner, never the selected assistant.
    if (session && parseAgentSessionKey(session.key)) {
      return resolveUiConversationIdentity(state, session.key);
    }
    return session?.agentId && (session.key === "global" || session.key === "unknown")
      ? { sessionKey: session.key, agentId: session.agentId }
      : undefined;
  }

  protected isCurrentSessionArchived(state: ChatPageHost): boolean {
    return (
      state.selectedChatSessionArchived ||
      state.sessionsResult?.sessions.some(
        (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, state.sessionKey),
      ) === true
    );
  }
  /* Infinity until the first ResizeObserver tick so an unmeasured pane keeps
   * the wide side-by-side layout instead of flashing the stacked one. */
  @litState() protected paneWidth = Number.POSITIVE_INFINITY;
  protected paneResizeObserver: ResizeObserver | null = null;
  protected connectedClient: GatewayBrowserClient | null = null;
  protected boardProviderLease: (BoardProviderLease & { cacheKey: string }) | undefined;
  protected boardProviderLifecycleConnected = false;
  protected connectionGeneration = 0;
  // Owns the abort signal handed to header-scoped destructive confirm dialogs.
  // Retiring it alongside every connectionGeneration bump lets a dialog open
  // across a reconnect or pane teardown dismiss itself, matching
  // SessionDataController's own epoch-scoped controller for the sidebar.
  protected headerSessionMutationAbortController = new AbortController();

  @litState() protected headerEditing = false;
  @litState() protected headerRenameValue = "";
  @litState() protected headerPlatform: string | null = null;
  @litState() protected headerCopiedAction: ChatPaneHeaderAction | null = null;
  protected continueInTerminalDialog: {
    qualifiedSessionKey: string;
    selectedGatewayUrl: string;
    clientGatewayUrl: string;
    scope: ChatPaneConnectionScope;
  } | null = null;
  @litState() protected headerPlacementMovingKey: string | null = null;
  @litState() protected headerPlacementReclaimingKey: string | null = null;
  @litState() protected headerPlacementRestartingKey: string | null = null;
  @litState() protected presencePayload: PresencePayload | undefined;
  @litState() protected sessionSharingStates = new Map<string, ChatSessionSharingState>();
  protected readonly sessionSharingHydrationTargets = new Map<string, string>();
  protected readonly sessionParticipationTracker = new SessionParticipationTracker();
  @litState() protected resetConfirmationOpen = false;
  protected deferredSessionHydrationRequestVersion = 0;
  protected sessionCompanionHydrationKey = "";
  protected readonly sessionCompanionThreads = new ChatSessionCompanionThreads(() => {
    this.requestUpdate();
  });
  protected readonly setSessionObserverVisibility = (visible: boolean) => {
    const state = this.state;
    if (state?.connected && state.client) {
      void sendSessionObserverVisibility(state.client, visible).catch(() => undefined);
    }
    this.requestUpdate();
  };

  protected selectedSessionRailMode(sessionKey: string): "expanded" | "hidden" {
    const state = this.state;
    const visible =
      state?.sessionKey === sessionKey && isSidebarSlotVisible(state.sidebarLayout, "companion");
    return visible ? "expanded" : "hidden";
  }

  protected restorePaneSidebarLayout(layout: SidebarLayout): SidebarLayout {
    if (!this.compact) {
      return layout;
    }
    // Home's visibility consumers share the restored Chat-first layout;
    // the saved full-page task layout stays intact.
    const conversation = layout.columns[0]?.panels.find((panel) => panel.slot === "conversation");
    const restored = conversation ? promoteSidebarPanel(layout, conversation.id) : layout;
    return { ...restored, open: false, expanded: false };
  }

  protected setChatSidePanelOpen(open: boolean, layout?: SidebarLayout): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const renderedLayout = layout ?? state.sidebarLayout;
    const nextLayout = setSidebarOpen(renderedLayout, open);
    if (renderedLayout.columns[0]?.panels.some((panel) => panel.slot === "companion")) {
      this.setSessionObserverVisibility(isSidebarSlotVisible(nextLayout, "companion"));
    }
    this.commitSidebarLayout(nextLayout);
  }

  protected requestSessionRail(intent: "open" | "toggle"): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const visible = this.selectedSessionRailMode(state.sessionKey) === "expanded";
    if (intent === "toggle" && visible) {
      this.commitSidebarLayout(closeSlot(state.sidebarLayout, "companion"));
      this.setSessionObserverVisibility(false);
      return;
    }
    this.commitSidebarLayout(openSlot(state.sidebarLayout, "companion"));
    this.setSessionObserverVisibility(true);
  }

  protected readonly submitSessionCompanionQuestion = async (question: string) => {
    const state = this.state;
    if (!state || !state.sessionKey) {
      return;
    }
    const sessionKey = state.sessionKey;
    const agentId = resolveChatAgentId(state);
    this.requestSessionRail("open");
    if (!state.connected || !state.client) {
      this.sessionCompanionThreads.setDraft(sessionKey, question, agentId);
      return;
    }
    const client = state.client;
    await this.sessionCompanionThreads.submit(
      sessionKey,
      question,
      (key, value) => requestSessionCompanionAnswer(client, key, value, agentId),
      agentId,
    );
  };

  protected readonly prefillSessionCompanionQuestion = (question: string) => {
    const state = this.state;
    const sessionKey = state?.sessionKey;
    if (!sessionKey) {
      return;
    }
    this.sessionCompanionThreads.setDraft(sessionKey, question, resolveChatAgentId(state));
    this.requestSessionRail("open");
  };

  protected hydrateSessionCompanion(sessionKey: string): void {
    const state = this.state;
    if (!state?.connected || !state.client || !sessionKey || parseCatalogSessionKey(sessionKey)) {
      return;
    }
    const agentId = resolveChatAgentId(state);
    const hydrationKey = `${this.connectionGeneration}\0${agentId}\0${sessionKey}`;
    if (this.sessionCompanionHydrationKey === hydrationKey) {
      return;
    }
    this.sessionCompanionHydrationKey = hydrationKey;
    void this.sessionCompanionThreads.hydrate(
      sessionKey,
      (key) => requestSessionCompanionState(state.client!, key, agentId),
      agentId,
    );
  }

  protected resetConfirmation:
    | {
        scopeKey: string;
        promise: Promise<boolean>;
        resolve: (confirmed: boolean) => void;
      }
    | undefined;
  protected readonly observedBoardPresence = new Map<string, boolean>();
  protected dashboardExpandedRouteKey = "";
  protected swarmHydrator: SwarmRosterHydrator | null = null;
  protected readonly sessionDiscussionStates = new Map<string, SessionDiscussionState>();
  protected readonly sessionDiscussionOpenUrls = new Map<string, string | null>();
  protected readonly pendingPanelToggleRequests = new Map<
    "browser" | "desktop" | "terminal",
    Event
  >();
  protected readonly sessionDiscussionProbes = new Set<string>();
  protected readonly sessionDiscussionPanels = new Map<
    string,
    {
      generation: number;
      canOpen: boolean;
      config: SessionDiscussionPanelConfig;
    }
  >();
  protected headerRenameInitialValue = "";
  protected headerRenameSession: Pick<GatewaySessionRow, "key" | "sessionId" | "label"> | null =
    null;
  protected headerCopiedTimer: number | null = null;
  protected composerPrefillAttentionTimer: number | null = null;
  protected composerPrefillAttentionTarget: HTMLElement | null = null;

  /** Checkout paths keyed by worktree id — stable for a worktree's lifetime,
   * so reused session keys can never inherit another checkout's path. */
  protected readonly headerWorktreePaths = new Map<
    string,
    { loaded?: boolean; loading?: boolean; path?: string | null }
  >();
  /** HEAD keyed by the resolved root directory it was read from — a branch is
   * a fact about a checkout, so root transitions miss instead of going stale. */
  protected readonly headerBranches = new Map<
    string,
    { loading?: boolean; value?: string | null }
  >();
  protected nativeDraftCleanup: (() => void) | null = null;
  protected readonly unreadPatchGuard = new SessionUnreadPatchGuard();
  protected sessionSuggestions: SessionSuggestion[] = [];
  protected sessionSuggestionRole: SessionSharingRole | undefined;
  protected readonly sessionSuggestionBusyIds = new Set<string>();
  protected sessionSuggestionsRequestVersion = 0;
  protected sessionSuggestionsRefreshPromise: Promise<void> | undefined;
  protected sessionSuggestionsRefreshVersion: number | undefined;
  protected sessionSuggestionsRefreshQueued = false;
  protected sessionSuggestionTargetSignature = "";
  protected sessionSuggestionAddOperation: symbol | undefined;
  protected sessionSuggestionEditOperation: symbol | undefined;
  protected readonly typingActors = new Map<
    string,
    { label: string; expiresAt: number; preview?: string }
  >();
  protected readonly typingTimers = new Map<string, number>();
  protected sessionPullRequests: ControlUiSessionPullRequest[] = [];
  protected sessionPullRequestsBranch: ControlUiSessionBranch | undefined;
  protected sessionPullRequestsRateLimited = false;
  protected sessionPullRequestsExpanded = false;
  protected githubPublication: GitHubPublicationBinding | null = null;
  protected dismissedSessionPullRequestIds: ReadonlySet<string> = new Set();
  protected readonly dismissedWorkspaceConflictRefs = new Map<string, string>();
  @litState() protected catalogMessages: unknown[] = [];
  @litState() protected catalogLoading = false;
  @litState() protected loadingOlder = false;
  protected catalogCursor: string | undefined;
  protected catalogSession: SessionCatalogSession | null = null;
  protected catalogHost: SessionCatalogHost | null = null;
  protected catalogLoadGeneration = 0;
  protected catalogRequestedSessionKey: string | null = null;
  protected olderLoadGeneration = 0;
  protected historyObserver: IntersectionObserver | null = null;
  protected historyObserverRoot: HTMLElement | null = null;
  protected historyObserverSentinel: HTMLElement | null = null;
  protected historyObserverBootstrap = false;
  protected historyObserverArmed = false;
  protected historyAutoLoadBlocked = false;
  protected historyIntentConsumed = false;
  protected historyIntentTimer: number | null = null;
  protected historyTouchY: number | null = null;
  protected transcriptScrollTop: number | null = null;
  // Older cursors already requested this session. A provider that cycles cursors
  // (c1 -> c2 -> c1) on empty/duplicate pages would otherwise loop forever, since
  // the sentinel never scrolls out of view when nothing new renders.
  protected readonly olderCursorsSeen = new Set<string>();

  constructor() {
    super();
    observeNativeGateway(this);
    void new SubscriptionsController(this)
      .watch(
        () => this.context && chatInputOwnerForContext(this.context),
        (owner, notify) => owner.subscribe(notify),
        () => this.activeChanged(this.active),
      )
      .watch(
        () => this.context?.overlays,
        (overlays, notify) =>
          overlays.subscribe((snapshot) => {
            if (this.state) {
              this.reconcileWaitingApprovalSnapshot(snapshot.approvalQueue);
            }
            notify();
          }),
      )
      .watch(
        () => this.context?.runtimeConfig,
        (runtimeConfig, notify) =>
          runtimeConfig.subscribe(() => {
            this.refreshSwarmRoster();
            notify();
          }),
      )
      .watch(
        () => this.context?.theme,
        (theme, notify) => theme.subscribe(notify),
      )
      .watch(
        () => this.context?.plugins,
        (plugins, notify) => plugins.subscribe(notify),
      )
      .watch(
        () => this.resolveBoardProvider(),
        (provider, notify) => {
          const unsubscribeSnapshot = provider.snapshot$.subscribe(notify);
          const unsubscribeError = provider.loadError$.subscribe(notify);
          return () => {
            unsubscribeSnapshot();
            unsubscribeError();
          };
        },
      )
      .effect(
        () => this.resolveBoardProvider(),
        (provider) => provider.events.subscribe((event) => this.handleBoardCommand(event)),
      );
  }

  protected abstract refreshSessionPullRequests(options?: { refresh?: boolean }): boolean;
  protected abstract commitSidebarLayout(layout: SidebarLayout): void;
  protected abstract refreshSwarmRoster(): void;
  protected abstract resolveBoardProvider(): BoardProvider;
  protected abstract handleBoardCommand(event: BoardCommandEvent): void;
  protected abstract reconcileWaitingApprovalSnapshot(
    approvalQueue?: ChatPageContext["overlays"]["snapshot"]["approvalQueue"],
  ): boolean;
  protected abstract publishHeaderError(error: unknown, owner?: string): void;
  protected abstract probeSessionDiscussion(sessionKey: string): Promise<void>;
  protected abstract loadHeaderPlatform(
    client: GatewayBrowserClient,
    generation: number,
  ): Promise<void>;
  protected abstract applyGatewaySnapshot(snapshot: ChatPageContext["gateway"]["snapshot"]): void;
  protected abstract applyApplicationConfig(config: ChatPageContext["config"]["current"]): void;
  protected abstract applySessionsState(state: ChatPageContext["sessions"]["state"]): void;
  protected abstract cancelHeaderRename(): void;
  protected abstract resetOlderMessagesViewport(): void;
}
