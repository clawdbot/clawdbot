import {
  consume,
  applicationContext,
  property,
  litState,
  createQuestionPromptState,
  listQuestionPrompts,
  requestSessionObserverAnswer,
  sendSessionObserverVisibility,
  PollController,
  SubscriptionsController,
  ChatStateController,
  ChatTranscriptController,
  OpenClawLightDomElement,
  ObserverDigestHistory,
  SessionParticipationTracker,
  SessionUnreadPatchGuard,
  type BoardCommandEvent,
  type BoardProvider,
  type BoardProviderLease,
  type BoardSnapshot,
  type BoardTab,
  type BoardViewSnapshot,
  type ChatHistoryPagination,
  type ChatMessageCache,
  type ChatPageHost,
  type ChatPaneHeaderAction,
  type ChatSessionSharingState,
  type ControlUiSessionBranch,
  type ControlUiSessionPullRequest,
  type GatewayBrowserClient,
  type PresencePayload,
  type QuestionPrompt,
  type SessionCatalogHost,
  type SessionCatalogSession,
  type SessionDiscussionState,
  type SessionSharingRole,
  type SessionSuggestion,
  type SwarmRosterHydrator,
  type TaskSuggestion,
  type BoardChatDockSize,
} from "./chat-pane-deps.ts";
import {
  boardChatDockLayout,
  type ChatPageContext,
  type PaneSessionChangeOptions,
  type VisibleBoardDock,
} from "./chat-pane-shared.ts";

export abstract class ChatPaneBase extends OpenClawLightDomElement {
  // One lifecycle-owned minute tick refreshes both relative labels and external PR state.
  readonly minutePoll = new PollController(this, 60_000, () => {
    this.requestUpdate();
    void this.refreshSessionPullRequests();
  });
  @consume({ context: applicationContext, subscribe: true })
  protected context!: ChatPageContext;
  @property({ attribute: false }) paneId = "single";
  @property({ attribute: false }) chatMessagesBySession?: ChatMessageCache;
  // Empty means "no route/layout opinion yet": the pane boots on the page
  // state's default session and must not canonicalize or write global session
  // bindings until the container supplies a real key (classic mode renders
  // before route data resolves).
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) active = false;
  @property({ attribute: false }) draft?: string;
  @property({ attribute: false }) onFocusPane?: (paneId: string) => void;
  @property({ attribute: false }) onPaneSessionChange?: (
    paneId: string,
    nextSessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => void;
  @property({ attribute: false }) paneTitle = "";
  @property({ attribute: false }) narrow = false;
  @property({ attribute: false }) mergedChrome = false;
  @property({ attribute: false }) onOpenSplitView?: () => void;
  @property({ attribute: false }) onSplitDown?: (paneId: string) => void;
  @property({ attribute: false }) onSplitRight?: (paneId: string) => void;
  @property({ attribute: false }) onClosePane?: (paneId: string) => void;
  @property({ attribute: false }) boardProvider?: BoardProvider;

  protected readonly chatState = new ChatStateController<ChatPageHost>(this);
  protected readonly transcript = new ChatTranscriptController(this);
  protected readonly questionPromptState = createQuestionPromptState(() => {
    this.questionPrompts = listQuestionPrompts(this.questionPromptState);
    this.requestUpdate();
  });
  protected questionPrompts: QuestionPrompt[] = [];
  protected state: ChatPageHost | undefined;
  /* Infinity until the first ResizeObserver tick so an unmeasured pane keeps
   * the wide side-by-side layout instead of flashing the stacked one. */
  @litState() protected paneWidth = Number.POSITIVE_INFINITY;
  protected paneResizeObserver: ResizeObserver | null = null;
  protected connectedClient: GatewayBrowserClient | null = null;
  protected boardProviderLease: (BoardProviderLease & { sessionKey: string }) | undefined;
  protected boardProviderLifecycleConnected = false;
  protected connectionGeneration = 0;
  @litState() protected headerEditing = false;
  @litState() protected headerRenameValue = "";
  @litState() protected headerPlatform: string | null = null;
  @litState() protected headerCopiedAction: ChatPaneHeaderAction | null = null;
  @litState() protected presencePayload: PresencePayload | undefined;
  @litState() protected sessionSharingStates = new Map<string, ChatSessionSharingState>();
  protected readonly sessionParticipationTracker = new SessionParticipationTracker();
  @litState() protected boardCommandDock: {
    sessionKey: string;
    tabId: string;
    dock: BoardTab["chatDock"];
  } | null = null;
  @litState() protected boardChatDockSize: BoardChatDockSize = boardChatDockLayout.load();
  @litState() protected resetConfirmationOpen = false;
  @litState() protected observerHudReady = customElements.get("openclaw-chat-observer-hud") != null;
  protected observerHudLoad: Promise<void> | null = null;
  protected readonly askSessionObserver = (sessionKey: string, question: string) => {
    const state = this.state;
    if (!state?.connected || !state.client) {
      return Promise.reject(new Error("Gateway is disconnected"));
    }
    return requestSessionObserverAnswer(state.client, sessionKey, question);
  };
  protected readonly setSessionObserverVisibility = (visible: boolean) => {
    const state = this.state;
    if (state?.connected && state.client) {
      void sendSessionObserverVisibility(state.client, visible).catch(() => undefined);
    }
    this.requestUpdate();
  };
  protected resetConfirmation:
    | {
        sessionKey: string;
        promise: Promise<boolean>;
        resolve: (confirmed: boolean) => void;
      }
    | undefined;
  protected readonly lastVisibleBoardDock = new Map<string, VisibleBoardDock>();
  protected readonly observerDigestHistory = new ObserverDigestHistory();
  protected builtinBoardSnapshot: BoardViewSnapshot | null = null;
  protected builtinBoardSnapshotBase: BoardSnapshot | null = null;
  protected swarmHydrator: SwarmRosterHydrator | null = null;
  protected readonly sessionDiscussionStates = new Map<string, SessionDiscussionState>();
  protected readonly sessionDiscussionOpenUrls = new Map<string, string | null>();
  protected readonly sessionDiscussionProbes = new Set<string>();
  protected headerRenameInitialLabel: string | null = null;
  protected headerRenameInitialValue = "";
  protected headerRenameSessionKey = "";
  protected headerCopiedTimer: number | null = null;

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
  protected taskSuggestions: TaskSuggestion[] = [];
  protected readonly taskSuggestionBusyIds = new Set<string>();
  protected readonly taskSuggestionOperations = new Map<string, symbol>();
  protected taskSuggestionsRequestVersion = 0;
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
  protected readonly typingActors = new Map<string, { label: string; expiresAt: number }>();
  protected readonly typingTimers = new Map<string, number>();
  protected sessionPullRequests: ControlUiSessionPullRequest[] = [];
  protected sessionPullRequestsBranch: ControlUiSessionBranch | undefined;
  protected sessionPullRequestsRateLimited = false;
  protected sessionPullRequestsRequestVersion = 0;
  protected sessionPullRequestsExpanded = false;
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
  protected historyBootstrapPagesLoaded = 0;
  protected historyIntentConsumed = false;
  protected historyIntentTimer: number | null = null;
  protected historyTouchY: number | null = null;
  protected transcriptScrollTop: number | null = null;
  protected nativePaginationSnapshot: ChatHistoryPagination | null = null;
  // Older cursors already requested this session. A provider that cycles cursors
  // (c1 -> c2 -> c1) on empty/duplicate pages would otherwise loop forever, since
  // the sentinel never scrolls out of view when nothing new renders.
  protected readonly olderCursorsSeen = new Set<string>();
  protected readonly olderOffsetsSeen = new Set<number>();

  constructor() {
    super();
    void new SubscriptionsController(this)
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
            this.refreshBuiltinBoardSnapshot();
            notify();
          }),
      )
      .watch(
        () => this.resolveBoardProvider(),
        (provider, notify) =>
          provider.snapshot$.subscribe(() => {
            this.refreshBuiltinBoardSnapshot();
            notify();
          }),
      )
      .effect(
        () => this.resolveBoardProvider(),
        (provider) => provider.events.subscribe((event) => this.handleBoardCommand(event)),
      );
  }

  protected abstract refreshSessionPullRequests(options?: { refresh?: boolean }): Promise<void>;
  protected abstract refreshBuiltinBoardSnapshot(): void;
  protected abstract resolveBoardProvider(): BoardProvider;
  protected abstract handleBoardCommand(event: BoardCommandEvent): void;
  protected abstract reconcileWaitingApprovalSnapshot(
    approvalQueue?: ChatPageContext["overlays"]["snapshot"]["approvalQueue"],
  ): boolean;
  protected abstract publishHeaderError(error: unknown): void;
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
  protected abstract sendPendingSkillWorkshopRevision(expectedSessionKey: string): void;
}
