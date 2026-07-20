import { consume } from "@lit/context";
import { asNullableRecord as catalogRawRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state as litState } from "lit/decorators.js";
import {
  GATEWAY_SERVER_CAPS,
  type SessionCatalogHost,
  type SessionCatalogSession,
  type SessionCatalogTranscriptItem,
  type SessionDiscussionInfo,
  type SessionDiscussionState,
  type SessionsCatalogContinueResult,
  type SessionsCatalogReadResult,
  type SessionsFilesRevealResult,
  type SystemInfoResult,
  type TaskSuggestion,
  type TaskSuggestionEvent,
  type TaskSuggestionsAcceptResult,
  type TaskSuggestionsListResult,
  type WorktreesBranchesResult,
  type WorktreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { findInlineApproval } from "../../app/approval-presentation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import {
  cancelQuestionPrompt,
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  listQuestionPrompts,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
  submitQuestionPrompt,
  type QuestionPrompt,
} from "../../app/question-prompt.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import {
  BROWSER_ANNOTATION_EVENT,
  type BrowserAnnotationDraft,
} from "../../components/browser/browser-annotation.ts";
import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPaletteTargetDetail,
} from "../../components/command-palette-contract.ts";
import "../../components/modal-dialog.ts";
import { createDockPanelLayout } from "../../components/dock-panel-layout.ts";
import { icons } from "../../components/icons.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { t } from "../../i18n/index.ts";
import { resolveBoardChatLayoutWidth } from "../../lib/board/chat-layout.ts";
import {
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
  type BoardViewCallbacks,
} from "../../lib/board/provider.ts";
import {
  updateBoardSessionView,
  type BoardFace,
  type BoardSessionView,
} from "../../lib/board/settings.ts";
import type { BoardSnapshot, BoardTab } from "../../lib/board/types.ts";
import type { BoardViewSnapshot } from "../../lib/board/view-types.ts";
import {
  resolveControlUiFollowUpMode,
  resolveControlUiServerQueueMode,
} from "../../lib/chat/follow-up-mode.ts";
import { retirePendingChatSideQuestion } from "../../lib/chat/side-result.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { clampText } from "../../lib/format.ts";
import {
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
} from "../../lib/gateway-methods.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  announceCatalogSessionContinued,
  buildCatalogSessionKey,
  lookupCatalogSession,
  parseCatalogSessionKey,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import {
  resolveSessionKey,
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
import { SessionUnreadPatchGuard } from "../../lib/sessions/unread.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  ensureBoardViewElement,
  renderBoardDockMenu,
  renderBoardFaceToggle,
  renderBoardSessionSurface,
  type BoardChatDockSize,
} from "./board-session-surface.ts";
import { catalogMessageId } from "./catalog-message-id.ts";
import { refreshChatAvatar } from "./chat-avatar.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import {
  applyChatAgentsList,
  clearChatHistory,
  loadChatHistory,
  loadOlderChatHistoryPage,
  rewindChatHistory,
  resolveChatHistoryPagination,
  switchChatHistoryBranch,
  syncSelectedSessionMessageSubscription,
} from "./chat-history.ts";
import {
  applySelectedSessionProjection,
  dismissChatError,
  resolveAssistantAttachmentAuthToken,
} from "./chat-pane-state.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue.ts";
import { dismissRealtimeTalkError } from "./chat-realtime.ts";
import { flushChatQueueForEvent, retryReconnectableQueuedChatSends } from "./chat-send.ts";
import {
  flushChatQueueAfterIdleSessionReconciliation,
  switchChatFastMode,
  switchChatModel,
  switchChatThinkingLevel,
} from "./chat-session.ts";
import {
  canCreateChatSession,
  ChatStateController,
  createPageState,
  handlePageGatewayEvent,
  refreshChatCommands,
  refreshChatMetadata,
  refreshChatModelAuthStatus,
  refreshPageChat,
  refreshRouteSessionOptions,
  resetChatStateForRouteSession,
  retryChatComposerMemoryFallback,
  resolveChatAgentId,
  resolveChatAvatarUrl,
  saveRouteSessionSettings,
  type ChatPageHost,
} from "./chat-state.ts";
import {
  renderChat,
  renderChatResizableDivider,
  resetChatViewState,
  type ChatProps,
} from "./chat-view.ts";
import { renderCatalogTerminalButton } from "./components/catalog-terminal-button.ts";
import { chatAttachmentFromDataUrl } from "./components/chat-attachments.ts";
import {
  createBackgroundTasksProps,
  renderBackgroundTasksToggle,
  type BackgroundTasksProps,
} from "./components/chat-background-tasks.ts";
import { isChatRunWorking } from "./components/chat-composer.ts";
import { renderChatControls } from "./components/chat-controls.ts";
import {
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  resolveChatPaneWorkspace,
  type ChatPaneHeaderAction,
} from "./components/chat-pane-header.ts";
import {
  chatPullRequestId,
  createPullRequestBranch,
  dismissChatPullRequest,
  listDismissedChatPullRequests,
} from "./components/chat-pull-requests.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  renderSessionDiffToggle,
  renderSessionWorkspaceToggle,
  revealSessionWorkspaceFile,
  toggleSessionWorkspace,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import {
  CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS,
  type DetailFullMessageResult,
  type SidebarContent,
  type SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
import { ChatTranscriptController } from "./components/chat-thread.ts";
import { WIDGET_PROMPT_EVENT, type WidgetPromptEventDetail } from "./components/chat-tool-cards.ts";
import {
  CHAT_COMPOSER_DRAFT_STORAGE_ERROR,
  loadChatComposerSnapshot,
  persistChatComposerState,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "./composer-persistence.ts";
import { exportChatMarkdown } from "./export.ts";
import {
  hasAbortableSessionRun,
  reconcileStaleChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import {
  clearChatMessagesFromCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { reconcileWaitingApprovalsFromSnapshot } from "./tool-stream.ts";
import { configureToolTitleFetcher } from "./tool-titles.ts";

type ChatPageContext = ApplicationContext;
type PaneSessionChangeOptions = { replace?: boolean };
type VisibleBoardDock = Exclude<BoardTab["chatDock"], "hidden">;
type ResolvedBoardView = {
  provider: BoardProvider;
  snapshot: BoardViewSnapshot;
  hasBoard: boolean;
  face: BoardFace;
  activeTabId: string;
  activeTabReadOnly: boolean;
  dock: BoardTab["chatDock"];
  reopenDock: VisibleBoardDock;
};

const boardChatDockLayout = createDockPanelLayout({
  storageKey: "openclaw.control.board-chat-dock.v1",
  minHeight: 180,
  minWidth: 320,
  defaultDock: "right",
  supportedDocks: ["bottom", "left", "right"],
  defaultHeight: 320,
  defaultWidth: 420,
});
const CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS = 500;
const CHAT_HISTORY_INTENT_EDGE_PX = 300;
const CHAT_HISTORY_INTENT_IDLE_MS = 200;
const CHAT_HISTORY_TOUCH_INTENT_PX = 8;
const CHAT_HISTORY_UPWARD_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const headerPlatformByClient = new WeakMap<GatewayBrowserClient, Promise<string | null>>();

function catalogRawString(raw: unknown, keys: readonly string[]): string | null {
  const record = catalogRawRecord(raw);
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
function catalogRawResult(raw: unknown): string | null {
  const result = catalogRawRecord(raw)?.result;
  if (result === undefined) {
    return null;
  }
  try {
    const text = JSON.stringify(result);
    return text ? clampText(text, CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS) : null;
  } catch {
    return null;
  }
}
function nativeHistoryMessageIdentity(message: unknown): string | null {
  const record = catalogRawRecord(message);
  const metadata = catalogRawRecord(record?.["__openclaw"]);
  const seq = metadata?.seq;
  const id = metadata?.id ?? record?.messageId;
  const sourceIdentity =
    typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
      ? `seq:${seq}`
      : typeof id === "string" && id.trim()
        ? `id:${id}`
        : null;
  if (!sourceIdentity) {
    return null;
  }
  try {
    // One transcript record can project to multiple visible siblings. Include
    // the projection bytes so partial page overlap removes the matching sibling.
    return `${sourceIdentity}:${JSON.stringify(message)}`;
  } catch {
    return sourceIdentity;
  }
}

type ChatPaneConnectionScope = {
  context: ChatPageContext;
  state: ChatPageHost;
  client: GatewayBrowserClient;
  generation: number;
  sessions: ChatPageContext["sessions"];
};
const CHAT_OPEN_DETAILS_SELECTOR =
  ".chat-controls__inline-select[open], .context-usage details[open], .agent-chat__attach-menu[open], .chat-pr__checks[open]";
const CHAT_COMPOSER_TEXTAREA_SELECTOR = ".agent-chat__composer-combobox > textarea";
const CHAT_TEXT_ENTRY_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='combobox'], [role='listbox'], [role='textbox']";
const CHAT_SPACE_ACTIVATION_SELECTOR =
  "a[href], button, summary, [role='button'], [role='checkbox'], [role='link'], [role='radio'], [role='switch']";
const CHAT_MODAL_SELECTOR = "dialog[open], [aria-modal='true']";
// One automatic page can fill a short initial tail without serially walking a
// collapsed or sparse transcript to exhaustion.
const CHAT_HISTORY_BOOTSTRAP_PAGE_LIMIT = 1;

/* Pane-width thresholds (CSS px). Split panes and compact windows can be far
 * narrower than the viewport, so side-by-side layouts key off the pane's own
 * measured width, never viewport media queries. */
// Side rail (230-280px) plus a readable thread; below this the rail docks bottom.
const WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH = 800;
// Widest the rail's grid column gets; a side-docked rail takes this from the
// width available to the chat + detail-panel split.
const WORKSPACE_RAIL_MAX_WIDTH = 280;
// .chat-main min-width (312) + divider + .chat-sidebar min-width (300) + slack;
// below this the detail panel stacks under the thread.
const DETAIL_SIDEBAR_SIDE_MIN_WIDTH = 680;

const NEW_SESSION_ACTIVE_RUN_MESSAGE =
  "Start a new thread after the active run or queued messages finish.";
const NEW_SESSION_LIST_LOADING_MESSAGE =
  "Thread list is still refreshing. Try New Chat again in a moment.";
const NEW_SESSION_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new thread. Try again in a moment.";

function keyboardEventPathMatches(event: KeyboardEvent, selector: string): boolean {
  return event
    .composedPath()
    .some((target) => target instanceof Element && target.matches(selector));
}

class ChatPane extends OpenClawLightDomElement {
  // One lifecycle-owned minute tick refreshes both relative labels and external PR state.
  readonly minutePoll = new PollController(this, 60_000, () => {
    this.requestUpdate();
    void this.refreshSessionPullRequests();
  });
  @consume({ context: applicationContext, subscribe: true })
  private context!: ChatPageContext;
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

  private readonly chatState = new ChatStateController<ChatPageHost>(this);
  private readonly transcript = new ChatTranscriptController(this);
  private readonly questionPromptState = createQuestionPromptState(() => {
    this.questionPrompts = listQuestionPrompts(this.questionPromptState);
    this.requestUpdate();
  });
  private questionPrompts: QuestionPrompt[] = [];
  private state: ChatPageHost | undefined;
  /* Infinity until the first ResizeObserver tick so an unmeasured pane keeps
   * the wide side-by-side layout instead of flashing the stacked one. */
  @litState() private paneWidth = Number.POSITIVE_INFINITY;
  private paneResizeObserver: ResizeObserver | null = null;
  private connectedClient: GatewayBrowserClient | null = null;
  private connectionGeneration = 0;
  @litState() private headerEditing = false;
  @litState() private headerRenameValue = "";
  @litState() private headerPlatform: string | null = null;
  @litState() private headerCopiedAction: ChatPaneHeaderAction | null = null;
  @litState() private boardCommandDock: {
    sessionKey: string;
    tabId: string;
    dock: BoardTab["chatDock"];
  } | null = null;
  @litState() private boardChatDockSize: BoardChatDockSize = boardChatDockLayout.load();
  @litState() private resetConfirmationOpen = false;
  private resetConfirmation:
    | {
        sessionKey: string;
        promise: Promise<boolean>;
        resolve: (confirmed: boolean) => void;
      }
    | undefined;
  private readonly lastVisibleBoardDock = new Map<string, VisibleBoardDock>();
  private swarmBoardSnapshot: BoardViewSnapshot | null = null;
  private swarmBoardSnapshotBase: BoardSnapshot | null = null;
  private swarmBoardSnapshotRequest = 0;
  private readonly sessionDiscussionStates = new Map<string, SessionDiscussionState>();
  private readonly sessionDiscussionProbes = new Set<string>();
  private headerRenameInitialLabel: string | null = null;
  private headerRenameInitialValue = "";
  private headerRenameSessionKey = "";
  private headerCopiedTimer: number | null = null;

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
        () => this.resolveBoardProvider(),
        (provider, notify) =>
          provider.snapshot$.subscribe(() => {
            this.refreshSwarmBoardSnapshot();
            notify();
          }),
      )
      .effect(
        () => this.resolveBoardProvider(),
        (provider) => provider.events.subscribe((event) => this.handleBoardCommand(event)),
      );
  }
  /** Checkout paths keyed by worktree id — stable for a worktree's lifetime,
   * so reused session keys can never inherit another checkout's path. */
  private readonly headerWorktreePaths = new Map<
    string,
    { loaded?: boolean; loading?: boolean; path?: string | null }
  >();
  /** HEAD keyed by the resolved root directory it was read from — a branch is
   * a fact about a checkout, so root transitions miss instead of going stale. */
  private readonly headerBranches = new Map<string, { loading?: boolean; value?: string | null }>();
  private nativeDraftCleanup: (() => void) | null = null;
  private readonly unreadPatchGuard = new SessionUnreadPatchGuard();
  private taskSuggestions: TaskSuggestion[] = [];
  private readonly taskSuggestionBusyIds = new Set<string>();
  private readonly taskSuggestionOperations = new Map<string, symbol>();
  private taskSuggestionsRequestVersion = 0;
  private sessionPullRequests: ControlUiSessionPullRequest[] = [];
  private sessionPullRequestsBranch: ControlUiSessionBranch | undefined;
  private sessionPullRequestsRateLimited = false;
  private sessionPullRequestsRequestVersion = 0;
  private sessionPullRequestsExpanded = false;
  private dismissedSessionPullRequestIds: ReadonlySet<string> = new Set();
  @litState() private catalogMessages: unknown[] = [];
  @litState() private catalogLoading = false;
  @litState() private loadingOlder = false;
  private catalogCursor: string | undefined;
  private catalogSession: SessionCatalogSession | null = null;
  private catalogHost: SessionCatalogHost | null = null;
  private catalogLoadGeneration = 0;
  private catalogRequestedSessionKey: string | null = null;
  private olderLoadGeneration = 0;
  private historyObserver: IntersectionObserver | null = null;
  private historyObserverRoot: HTMLElement | null = null;
  private historyObserverSentinel: HTMLElement | null = null;
  private historyObserverBootstrap = false;
  private historyObserverArmed = false;
  private historyAutoLoadBlocked = false;
  private historyBootstrapPagesLoaded = 0;
  private historyIntentConsumed = false;
  private historyIntentTimer: number | null = null;
  private historyTouchY: number | null = null;
  private transcriptScrollTop: number | null = null;
  private nativePaginationSnapshot: ChatHistoryPagination | null = null;
  // Older cursors already requested this session. A provider that cycles cursors
  // (c1 -> c2 -> c1) on empty/duplicate pages would otherwise loop forever, since
  // the sentinel never scrolls out of view when nothing new renders.
  private readonly olderCursorsSeen = new Set<string>();
  private readonly olderOffsetsSeen = new Set<number>();

  private captureConnectionScope(): ChatPaneConnectionScope | null {
    const context = this.context;
    const state = this.state;
    const client = state?.client;
    if (
      !this.isConnected ||
      !state?.connected ||
      !client ||
      this.connectedClient !== client ||
      !context.gateway.snapshot.connected ||
      context.gateway.snapshot.client !== client
    ) {
      return null;
    }
    return {
      context,
      state,
      client,
      generation: this.connectionGeneration,
      sessions: context.sessions,
    };
  }

  private isConnectionScopeCurrent(scope: ChatPaneConnectionScope): boolean {
    return (
      this.isConnected &&
      this.context === scope.context &&
      this.context.sessions === scope.sessions &&
      this.state === scope.state &&
      scope.state.connected &&
      scope.state.client === scope.client &&
      this.connectedClient === scope.client &&
      scope.context.gateway.snapshot.connected &&
      scope.context.gateway.snapshot.client === scope.client &&
      this.connectionGeneration === scope.generation
    );
  }

  private taskSuggestionMatchesCurrentSession(suggestion: TaskSuggestion): boolean {
    const state = this.state;
    return Boolean(
      state?.connected &&
      uiSessionEventMatches(
        {
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
          sessionKey: state.sessionKey,
        },
        suggestion.sessionKey,
        suggestion.agentId,
      ),
    );
  }

  private async refreshTaskSuggestions(): Promise<void> {
    const requestVersion = ++this.taskSuggestionsRequestVersion;
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !isGatewayMethodAdvertised(scope.context.gateway.snapshot, "taskSuggestions.list")
    ) {
      this.taskSuggestions = [];
      this.requestUpdate();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    if (parseCatalogSessionKey(sessionKey)) {
      this.taskSuggestions = [];
      this.requestUpdate();
      return;
    }
    const agentId = resolveChatAgentId(scope.state);
    try {
      const result = await scope.client.request<TaskSuggestionsListResult>("taskSuggestions.list", {
        agentId,
      });
      if (
        requestVersion !== this.taskSuggestionsRequestVersion ||
        !this.isConnectionScopeCurrent(scope) ||
        sessionKey !== scope.state.sessionKey
      ) {
        return;
      }
      this.taskSuggestions = result.suggestions.filter((suggestion) =>
        this.taskSuggestionMatchesCurrentSession(suggestion),
      );
      this.requestUpdate();
    } catch {
      // Suggestions are an optional ephemeral affordance; chat remains usable
      // when an older Gateway or a reconnect loses the process-local registry.
      // Keep event-delivered cards when a background reconciliation fails.
    }
  }

  private async refreshSessionPullRequests(): Promise<void> {
    const requestVersion = ++this.sessionPullRequestsRequestVersion;
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !isGatewayMethodAdvertised(scope.context.gateway.snapshot, "controlUi.sessionPullRequests")
    ) {
      this.sessionPullRequests = [];
      this.sessionPullRequestsBranch = undefined;
      this.sessionPullRequestsRateLimited = false;
      this.requestUpdate();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    if (!sessionKey.trim() || parseCatalogSessionKey(sessionKey)) {
      this.sessionPullRequests = [];
      this.sessionPullRequestsBranch = undefined;
      this.sessionPullRequestsRateLimited = false;
      this.requestUpdate();
      return;
    }
    try {
      const result = await scope.client.request<ControlUiSessionPullRequests>(
        "controlUi.sessionPullRequests",
        { sessionKey, ...scopedAgentParamsForSession(scope.state, sessionKey) },
      );
      if (
        requestVersion !== this.sessionPullRequestsRequestVersion ||
        !this.isConnectionScopeCurrent(scope) ||
        sessionKey !== scope.state.sessionKey
      ) {
        return;
      }
      this.sessionPullRequests = result.pullRequests;
      this.sessionPullRequestsBranch = result.branch;
      this.sessionPullRequestsRateLimited = result.rateLimited;
      this.dismissedSessionPullRequestIds = listDismissedChatPullRequests(sessionKey);
      this.requestUpdate();
    } catch {
      // PR chips are an optional affordance; keep the last snapshot so a
      // transient gateway or GitHub failure does not clear the row.
    }
  }

  private resetSessionPullRequests(): void {
    this.sessionPullRequestsRequestVersion += 1;
    this.sessionPullRequests = [];
    this.sessionPullRequestsBranch = undefined;
    this.sessionPullRequestsRateLimited = false;
    this.sessionPullRequestsExpanded = false;
    this.dismissedSessionPullRequestIds = new Set();
  }

  private readonly dismissSessionPullRequest = (pullRequest: ControlUiSessionPullRequest): void => {
    const sessionKey = this.state?.sessionKey;
    if (!sessionKey) {
      return;
    }
    this.dismissedSessionPullRequestIds = dismissChatPullRequest(sessionKey, pullRequest);
    this.requestUpdate();
  };

  private handleTaskSuggestionEvent(event: TaskSuggestionEvent): void {
    if (event.action === "created") {
      if (!this.taskSuggestionMatchesCurrentSession(event.suggestion)) {
        return;
      }
      this.taskSuggestions = [
        event.suggestion,
        ...this.taskSuggestions.filter((item) => item.id !== event.suggestion.id),
      ];
    } else {
      this.taskSuggestions = this.taskSuggestions.filter((item) => item.id !== event.taskId);
      this.taskSuggestionBusyIds.delete(event.taskId);
    }
    this.requestUpdate();
    // The replacement snapshot includes the event plus unrelated suggestions;
    // its request version prevents any older snapshot from overwriting either.
    void this.refreshTaskSuggestions();
  }

  private readonly acceptTaskSuggestion = async (suggestion: TaskSuggestion): Promise<void> => {
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !this.taskSuggestionMatchesCurrentSession(suggestion) ||
      this.taskSuggestionOperations.has(suggestion.id)
    ) {
      return;
    }
    const sessionKey = scope.state.sessionKey;
    const operation = Symbol();
    const isCurrent = () =>
      this.isConnectionScopeCurrent(scope) &&
      scope.state.sessionKey === sessionKey &&
      this.taskSuggestionOperations.get(suggestion.id) === operation;
    this.taskSuggestionOperations.set(suggestion.id, operation);
    this.taskSuggestionBusyIds.add(suggestion.id);
    this.requestUpdate();
    try {
      const result = await scope.client.request<TaskSuggestionsAcceptResult>(
        "taskSuggestions.accept",
        { taskId: suggestion.id },
      );
      if (!isCurrent()) {
        return;
      }
      this.taskSuggestions = this.taskSuggestions.filter((item) => item.id !== suggestion.id);
      this.onPaneSessionChange?.(this.paneId, result.key);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      scope.state.lastError = error instanceof Error ? error.message : String(error);
      scope.state.chatError = scope.state.lastError;
    } finally {
      if (this.taskSuggestionOperations.get(suggestion.id) === operation) {
        this.taskSuggestionOperations.delete(suggestion.id);
        this.taskSuggestionBusyIds.delete(suggestion.id);
        if (this.isConnectionScopeCurrent(scope) && scope.state.sessionKey === sessionKey) {
          this.requestUpdate();
        }
      }
    }
  };

  private readonly dismissTaskSuggestion = async (suggestion: TaskSuggestion): Promise<void> => {
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !this.taskSuggestionMatchesCurrentSession(suggestion) ||
      this.taskSuggestionOperations.has(suggestion.id)
    ) {
      return;
    }
    const sessionKey = scope.state.sessionKey;
    const operation = Symbol();
    const isCurrent = () =>
      this.isConnectionScopeCurrent(scope) &&
      scope.state.sessionKey === sessionKey &&
      this.taskSuggestionOperations.get(suggestion.id) === operation;
    this.taskSuggestionOperations.set(suggestion.id, operation);
    this.taskSuggestionBusyIds.add(suggestion.id);
    this.requestUpdate();
    try {
      await scope.client.request("taskSuggestions.dismiss", { taskId: suggestion.id });
      if (!isCurrent()) {
        return;
      }
      this.taskSuggestions = this.taskSuggestions.filter((item) => item.id !== suggestion.id);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      scope.state.lastError = error instanceof Error ? error.message : String(error);
      scope.state.chatError = scope.state.lastError;
    } finally {
      if (this.taskSuggestionOperations.get(suggestion.id) === operation) {
        this.taskSuggestionOperations.delete(suggestion.id);
        this.taskSuggestionBusyIds.delete(suggestion.id);
        if (this.isConnectionScopeCurrent(scope) && scope.state.sessionKey === sessionKey) {
          this.requestUpdate();
        }
      }
    }
  };

  private markSessionRead(row: GatewaySessionRow | undefined) {
    const state = this.state;
    if (!state?.connected || !row) {
      return;
    }
    const failureAt = row.endedAt ?? row.updatedAt ?? 0;
    const unreadFailure =
      (row.status === "failed" || row.status === "timeout") &&
      (row.lastReadAt == null || failureAt > row.lastReadAt);
    const agentStatusActive = Boolean(row.agentStatus && row.agentStatus.expiresAt > Date.now());
    if (
      !this.unreadPatchGuard.shouldPatch(
        state.sessionKey,
        row.unread === true || unreadFailure || agentStatusActive,
      )
    ) {
      return;
    }
    const agentId = parseAgentSessionKey(row.key)?.agentId ?? resolveChatAgentId(state);
    const guardKey = state.sessionKey;
    void this.context.sessions.patch(row.key, { unread: false }, { agentId }).catch(() => {
      // Unlatch so later unread snapshots retry; the session capability
      // publishes the actionable error for the owning page.
      this.unreadPatchGuard.patchFailed(guardKey);
    });
  }

  private async restoreArchivedSession(sessionKey: string) {
    const scope = this.captureConnectionScope();
    if (!scope || scope.state.sessionKey !== sessionKey) {
      return;
    }
    const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? resolveChatAgentId(scope.state);
    let failure: string | null = null;
    try {
      // The patch can resolve falsy on failure; the capability error explains it.
      const patched = await scope.sessions.patch(sessionKey, { archived: false }, { agentId });
      if (!patched) {
        failure = scope.sessions.state.error;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure && this.isConnectionScopeCurrent(scope) && scope.state.sessionKey === sessionKey) {
      scope.state.lastError = failure;
      scope.state.chatError = failure;
      scope.state.requestUpdate?.();
    }
  }

  private setPaneSessionKey(sessionKey: string): string | null {
    const state = this.state;
    if (!state) {
      return null;
    }
    const nextSessionKey = parseCatalogSessionKey(sessionKey)
      ? sessionKey
      : resolveSessionKey(sessionKey, this.context.gateway.snapshot.hello);
    if (!nextSessionKey) {
      return null;
    }
    state.sessionKey = nextSessionKey;
    return nextSessionKey;
  }

  // Global chrome (persisted session settings, gateway session, agent
  // selection) is owned by exactly one pane; the container guarantees a single
  // active pane, so inactive split panes must never run these bindings.
  private applyActiveSessionBindings() {
    const state = this.state;
    if (
      !state ||
      !this.active ||
      !this.sessionKey.trim() ||
      parseCatalogSessionKey(state.sessionKey)
    ) {
      return;
    }
    const nextSessionKey = state.sessionKey;
    saveRouteSessionSettings(state, nextSessionKey);
    this.context.gateway.setSessionKey(nextSessionKey);
    const agentId = parseAgentSessionKey(nextSessionKey)?.agentId;
    if (agentId) {
      this.context.agentSelection.set(agentId);
    }
  }

  private switchPaneSession(nextSessionKey: string) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousSessionKey = state.sessionKey;
    // An in-progress title edit belongs to the previous session; committing
    // it against the newly routed row would rename the wrong session.
    this.cancelHeaderRename();
    this.resetOlderMessagesViewport();
    const catalogKey = parseCatalogSessionKey(nextSessionKey);
    const previousSessionsResult = state.sessionsResult;
    const nextSessionRow = state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey);
    const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
    const previousComposerScope =
      this.chatState.composerScopeForRouteSwitch() ??
      resolveStoredChatOutboxScope(state, previousSessionKey);
    const previousComposerScopeKey = storedChatOutboxScopeKey(previousComposerScope);
    const existingFallback = state.chatComposerFallbackByScope[previousComposerScopeKey];
    const draftPersistResult = this.chatState.persistComposerForRouteSwitch();
    const draftPersisted = draftPersistResult.status === "persisted";
    const previousStoredSnapshot = loadChatComposerSnapshot(
      state,
      previousSessionKey,
      previousComposerScope.agentId,
    );
    const previousStoredDraft = previousStoredSnapshot ? previousStoredSnapshot.draft : null;
    const storedDraftMatches = previousStoredDraft === state.chatMessage;
    const hasStagedAttachments = state.chatAttachments.length > 0;
    const retainExistingFallback = existingFallback !== undefined && !storedDraftMatches;
    const previousDraftRetry =
      draftPersistResult.status === "storage-failed"
        ? {
            expectedDraftRevision: draftPersistResult.expectedDraftRevision,
            draftRevision: draftPersistResult.draftRevision,
          }
        : existingFallback?.storageFailed && !storedDraftMatches
          ? existingFallback.draftRetry
          : undefined;
    resetChatStateForRouteSession(state, nextSessionKey, {
      retainPreviousComposerInMemory:
        !draftPersisted || hasStagedAttachments || retainExistingFallback,
      previousDraftRetry,
      previousComposerScope,
    });
    this.reconcileWaitingApprovalSnapshot();
    retryChatComposerMemoryFallback(state, nextSessionKey);
    // Route restoration is the new persistence baseline. An untouched pane
    // must not later erase a draft written by another split pane. Memory-only
    // fallbacks stay pane-local until a later edit persists successfully.
    this.chatState.adoptComposerRoute();
    this.taskSuggestionsRequestVersion += 1;
    this.catalogLoadGeneration += 1;
    this.taskSuggestions = [];
    this.taskSuggestionBusyIds.clear();
    this.taskSuggestionOperations.clear();
    this.resetSessionPullRequests();
    if (catalogKey) {
      this.openCatalogSession(catalogKey, state);
      return;
    }
    this.catalogRequestedSessionKey = null;
    this.markSessionRead(nextSessionRow);
    if (previousSessionKey !== nextSessionKey) {
      state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
    }
    void state.loadAssistantIdentity();
    void refreshChatAvatar(state).finally(() => this.requestUpdate());
    void refreshChatMetadata(state).finally(() => state.requestUpdate?.());
    const subscriptionSync = syncSelectedSessionMessageSubscription(state);
    const composerStorageError = state.chatError === CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
    const historyLoad = loadChatHistory(state);
    if (composerStorageError) {
      // History loading clears the shared error slot synchronously. Restore the
      // pane-local storage warning unless the retry above made the draft durable.
      state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
      state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
    }
    state.requestUpdate();
    void this.refreshTaskSuggestions();
    void this.refreshSessionPullRequests();
    const scheduleHistoryScroll = () => {
      if (state.sessionKey !== nextSessionKey) {
        return;
      }
      state.requestUpdate();
      scheduleChatScroll(state, true);
    };
    void historyLoad.then(scheduleHistoryScroll, scheduleHistoryScroll);
    void historyLoad.then(
      () => this.sendPendingSkillWorkshopRevision(nextSessionKey),
      () => this.sendPendingSkillWorkshopRevision(nextSessionKey),
    );
    const sessionsRefresh = refreshRouteSessionOptions(state);
    flushChatQueueAfterIdleSessionReconciliation(
      state,
      nextSessionKey,
      historyLoad,
      sessionsRefresh,
      previousSessionsResult,
      () => void flushChatQueueForEvent(state),
    );
    void subscriptionSync;
    void historyLoad;
    void sessionsRefresh;
  }

  private openCatalogSession(key: CatalogSessionKey, state: ChatPageHost) {
    this.catalogRequestedSessionKey = buildCatalogSessionKey(key);
    this.catalogMessages = [];
    this.catalogCursor = undefined;
    this.catalogSession = null;
    this.catalogHost = null;
    state.chatAttachments = [];
    state.chatLoading = true;
    state.requestUpdate();
    void this.loadCatalogSession(key, false);
  }

  private catalogItemMessage(item: SessionCatalogTranscriptItem): Record<string, unknown> | null {
    const parsedTimestamp = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
    const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
    const text = item.text?.trim() ? item.text : null;
    if (item.type === "userMessage") {
      return text
        ? {
            role: "user",
            content: text,
            ...(timestamp == null ? {} : { timestamp }),
            messageId: item.id,
          }
        : null;
    }
    let content = text;
    if (item.type === "reasoning") {
      content = text ? `Thinking\n\n${text}` : "Thinking";
    } else if (item.type === "toolCall") {
      const label =
        text ?? catalogRawString(item.raw, ["command", "name", "tool", "title", "query"]);
      content = label ? `Tool call\n\n${label}` : "Tool call";
    } else if (item.type === "toolResult") {
      // Raw aggregated output is only bounded by the transcript read's per-item
      // byte cap (megabytes), so clamp it to the preview size before rendering.
      const aggregated = catalogRawString(item.raw, ["aggregatedOutput"]);
      const output =
        text ??
        (aggregated ? clampText(aggregated, CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS) : null) ??
        catalogRawResult(item.raw);
      content = output ? `Tool result\n\n${output}` : "Tool result";
    }
    if (!content) {
      return null;
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: content }],
      ...(timestamp == null ? {} : { timestamp }),
      messageId: item.id,
    };
  }

  private prependUniqueCatalogMessages(messages: unknown[]): unknown[] {
    const seenIds = new Set(this.catalogMessages.map(catalogMessageId).filter(Boolean));
    const uniqueMessages = messages.filter((message) => {
      const messageId = catalogMessageId(message);
      if (!messageId || !seenIds.has(messageId)) {
        if (messageId) {
          seenIds.add(messageId);
        }
        return true;
      }
      return false;
    });
    return [...uniqueMessages, ...this.catalogMessages];
  }

  private prependUniqueNativeMessages(messages: unknown[], current: unknown[]): unknown[] {
    const duplicateCounts = new Map<string, number>();
    for (const message of current) {
      const identity = nativeHistoryMessageIdentity(message);
      if (identity) {
        duplicateCounts.set(identity, (duplicateCounts.get(identity) ?? 0) + 1);
      }
    }
    const uniqueMessages = messages.filter((message) => {
      const identity = nativeHistoryMessageIdentity(message);
      if (!identity) {
        return true;
      }
      const duplicatesRemaining = duplicateCounts.get(identity) ?? 0;
      if (duplicatesRemaining === 0) {
        return true;
      }
      duplicateCounts.set(identity, duplicatesRemaining - 1);
      return false;
    });
    return [...uniqueMessages, ...current];
  }

  private async loadCatalogSession(key: CatalogSessionKey, older: boolean): Promise<boolean> {
    const state = this.state;
    const client = state?.client;
    if (!state || !client || !state.connected) {
      return false;
    }
    if (older && !this.catalogCursor) {
      return false;
    }
    const generation = older ? this.catalogLoadGeneration : ++this.catalogLoadGeneration;
    const requestedSessionKey = buildCatalogSessionKey(key);
    const isCurrent = () =>
      generation === this.catalogLoadGeneration && this.sessionKey === requestedSessionKey;
    if (!older) {
      this.catalogLoading = true;
      this.catalogCursor = undefined;
      this.olderCursorsSeen.clear();
      this.historyObserverArmed = false;
      this.historyBootstrapPagesLoaded = 0;
      this.transcriptScrollTop = null;
      this.historyObserver?.disconnect();
      this.historyObserver = null;
    }
    try {
      if (!older) {
        const lookup = await lookupCatalogSession({ client, key, isCurrent });
        if (!lookup) {
          return false;
        }
        this.catalogHost = lookup.host;
        this.catalogSession = lookup.session;
      }
      const requestedOlderCursor = older ? this.catalogCursor : undefined;
      if (requestedOlderCursor) {
        this.olderCursorsSeen.add(requestedOlderCursor);
      }
      const page = await client.request<SessionsCatalogReadResult>("sessions.catalog.read", {
        catalogId: key.catalogId,
        hostId: key.hostId,
        threadId: key.threadId,
        limit: 50,
        ...(older && this.catalogCursor ? { cursor: this.catalogCursor } : {}),
      });
      if (!isCurrent()) {
        return false;
      }
      const messages = page.items
        .toReversed()
        .map((item) => this.catalogItemMessage(item))
        .filter((message) => message !== null);
      const nextMessages = older ? this.prependUniqueCatalogMessages(messages) : messages;
      // Exhaust when the cursor cannot make new forward progress: absent, unchanged,
      // or already visited this session (a provider cycling c1 -> c2 -> c1). Any of
      // these stops the re-armed observer from looping. An advancing, never-seen
      // cursor with no newly rendered messages (an entirely filtered/duplicate page)
      // must keep paging — real older history may sit behind it.
      const olderExhausted =
        older &&
        (!page.nextCursor ||
          page.nextCursor === requestedOlderCursor ||
          this.olderCursorsSeen.has(page.nextCursor));
      this.catalogMessages = nextMessages;
      this.catalogCursor = olderExhausted ? undefined : page.nextCursor;
      const currentState = this.state ?? state;
      currentState.lastError = null;
      scheduleChatScroll(currentState, !older);
      return older ? !olderExhausted : true;
    } catch (error) {
      if (isCurrent()) {
        (this.state ?? state).lastError = error instanceof Error ? error.message : String(error);
      }
      return false;
    } finally {
      if (isCurrent()) {
        const currentState = this.state ?? state;
        if (!older) {
          this.catalogLoading = false;
          currentState.chatLoading = false;
        }
        currentState.requestUpdate();
      }
    }
  }

  private hasOlderMessages(): boolean {
    const state = this.state;
    if (!state) {
      return false;
    }
    if (parseCatalogSessionKey(state.sessionKey)) {
      return Boolean(this.catalogCursor && !this.catalogLoading);
    }
    const pagination = state.chatHistoryPagination ?? { hasMore: false };
    if (pagination !== this.nativePaginationSnapshot) {
      this.nativePaginationSnapshot = pagination;
      this.olderOffsetsSeen.clear();
    }
    return pagination.hasMore && !state.chatLoading;
  }

  private resetOlderMessagesViewport(): void {
    this.olderLoadGeneration += 1;
    this.loadingOlder = false;
    this.historyObserverArmed = false;
    this.historyAutoLoadBlocked = false;
    this.historyBootstrapPagesLoaded = 0;
    this.historyIntentConsumed = false;
    this.historyTouchY = null;
    if (this.historyIntentTimer !== null) {
      window.clearTimeout(this.historyIntentTimer);
      this.historyIntentTimer = null;
    }
    this.transcriptScrollTop = null;
    this.olderCursorsSeen.clear();
    this.olderOffsetsSeen.clear();
    this.nativePaginationSnapshot = null;
    this.clearHistoryObserver();
  }

  private clearHistoryObserver(): void {
    this.historyObserver?.disconnect();
    this.historyObserver = null;
    this.historyObserverRoot = null;
    this.historyObserverSentinel = null;
    this.historyObserverBootstrap = false;
  }

  private syncHistoryObserver(): void {
    const catalogSession = Boolean(this.state && parseCatalogSessionKey(this.state.sessionKey));
    const historyLoading = catalogSession ? this.catalogLoading : this.state?.chatLoading;
    if (historyLoading) {
      this.historyObserverArmed = false;
      if (this.loadingOlder) {
        this.olderLoadGeneration += 1;
        this.loadingOlder = false;
      }
    }
    if (
      typeof IntersectionObserver !== "function" ||
      !this.state?.connected ||
      this.loadingOlder ||
      !this.hasOlderMessages()
    ) {
      this.clearHistoryObserver();
      return;
    }
    const root = this.querySelector<HTMLElement>(".chat-thread");
    const sentinel = root?.querySelector<HTMLElement>(".chat-history-sentinel") ?? null;
    if (!root || !sentinel) {
      this.clearHistoryObserver();
      return;
    }
    this.transcriptScrollTop ??= root.scrollTop;
    const threadIsScrollable = root.scrollHeight > root.clientHeight;
    const bootstrap =
      !this.historyObserverArmed &&
      !threadIsScrollable &&
      this.historyBootstrapPagesLoaded < CHAT_HISTORY_BOOTSTRAP_PAGE_LIMIT;
    if (this.historyAutoLoadBlocked) {
      this.clearHistoryObserver();
      return;
    }
    if (!this.historyObserverArmed && !bootstrap) {
      this.clearHistoryObserver();
      if (!threadIsScrollable) {
        this.historyAutoLoadBlocked = true;
        this.requestUpdate();
      }
      return;
    }
    if (
      this.historyObserver &&
      this.historyObserverRoot === root &&
      this.historyObserverSentinel === sentinel &&
      this.historyObserverBootstrap === bootstrap
    ) {
      return;
    }
    this.clearHistoryObserver();
    this.historyObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.historyObserverArmed = false;
          if (bootstrap) {
            this.historyBootstrapPagesLoaded += 1;
          }
          void this.loadOlderMessages();
        }
      },
      { root, rootMargin: "300px 0px 0px", threshold: 0 },
    );
    this.historyObserverRoot = root;
    this.historyObserverSentinel = sentinel;
    this.historyObserverBootstrap = bootstrap;
    this.historyObserver.observe(sentinel);
  }

  private handleTranscriptScroll(event: Event): void {
    const root =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : event.target instanceof HTMLElement
          ? event.target
          : null;
    const previousScrollTop = this.transcriptScrollTop;
    if (root) {
      this.transcriptScrollTop = root.scrollTop;
    }
    const hasUpwardIntent =
      !this.loadingOlder &&
      root !== null &&
      previousScrollTop !== null &&
      root.scrollTop < previousScrollTop &&
      root.scrollTop <= CHAT_HISTORY_INTENT_EDGE_PX;
    const newHistoryIntent = hasUpwardIntent && this.consumeHistoryIntent();
    // A failed request or exhausted bootstrap stays disarmed until renewed
    // upward intent, preventing request loops without stranding older history.
    if (newHistoryIntent && this.historyAutoLoadBlocked) {
      this.historyAutoLoadBlocked = false;
      this.historyObserverArmed = true;
      this.syncHistoryObserver();
    } else if (newHistoryIntent && !this.historyObserverArmed) {
      this.historyObserverArmed = true;
      this.syncHistoryObserver();
    }
    // Preserve the normal at-bottom/new-message bookkeeping while layering
    // history-sentinel arming onto the same scroll event.
    this.state?.handleChatScroll(event);
  }

  private consumeHistoryIntent(): boolean {
    if (this.historyIntentTimer !== null) {
      window.clearTimeout(this.historyIntentTimer);
    }
    this.historyIntentTimer = window.setTimeout(() => {
      this.historyIntentTimer = null;
      this.historyIntentConsumed = false;
    }, CHAT_HISTORY_INTENT_IDLE_MS);
    if (this.historyIntentConsumed) {
      return false;
    }
    this.historyIntentConsumed = true;
    return true;
  }

  private handleTranscriptHistoryIntent(event: Event): void {
    const root = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    let upward =
      (event instanceof WheelEvent && event.deltaY < 0) ||
      (event instanceof KeyboardEvent && CHAT_HISTORY_UPWARD_KEYS.has(event.key));
    if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
      const touchY = event.touches[0]?.clientY ?? null;
      if (event.type === "touchstart") {
        this.historyTouchY = touchY;
        return;
      }
      if (event.type === "touchend" || event.type === "touchcancel") {
        this.historyTouchY = null;
        return;
      }
      const previousTouchY = this.historyTouchY;
      if (touchY !== null && previousTouchY !== null) {
        upward = touchY - previousTouchY >= CHAT_HISTORY_TOUCH_INTENT_PX;
        if (upward || touchY < previousTouchY) {
          this.historyTouchY = touchY;
        }
      }
    }
    if (
      !root ||
      !upward ||
      root.scrollTop > CHAT_HISTORY_INTENT_EDGE_PX ||
      this.loadingOlder ||
      !this.hasOlderMessages() ||
      !this.consumeHistoryIntent()
    ) {
      return;
    }
    this.historyAutoLoadBlocked = false;
    if (typeof IntersectionObserver !== "function") {
      void this.loadOlderMessages();
      return;
    }
    this.historyObserverArmed = true;
    this.syncHistoryObserver();
  }

  private async loadOlderMessages(): Promise<void> {
    const state = this.state;
    const catalogKey = state ? parseCatalogSessionKey(state.sessionKey) : null;
    if (!state || this.loadingOlder || !this.hasOlderMessages()) {
      return;
    }
    const generation = ++this.olderLoadGeneration;
    this.loadingOlder = true;
    state.requestUpdate();
    let prepended = false;
    try {
      if (catalogKey) {
        prepended = await this.loadCatalogSession(catalogKey, true);
      } else {
        const pagination = state.chatHistoryPagination;
        if (!pagination?.hasMore) {
          return;
        }
        const requestedOffset = pagination.nextOffset;
        const expectedSessionId =
          typeof state.currentSessionId === "string" ? state.currentSessionId.trim() : "";
        this.olderOffsetsSeen.add(requestedOffset);
        const result = await loadOlderChatHistoryPage(state, requestedOffset);
        if (!result || generation !== this.olderLoadGeneration) {
          return;
        }
        const resultSessionId =
          typeof result.sessionInfo?.sessionId === "string" && result.sessionInfo.sessionId.trim()
            ? result.sessionInfo.sessionId.trim()
            : typeof result.sessionId === "string"
              ? result.sessionId.trim()
              : "";
        if (expectedSessionId && resultSessionId !== expectedSessionId) {
          // Offset cursors belong to one transcript. A reset can reuse the session
          // key, so replace the tail instead of mixing two session IDs.
          await loadChatHistory(state);
          prepended = true;
          return;
        }
        const nextPagination = resolveChatHistoryPagination(result);
        const exhausted =
          !nextPagination.hasMore ||
          nextPagination.nextOffset <= requestedOffset ||
          this.olderOffsetsSeen.has(nextPagination.nextOffset);
        const messages = Array.isArray(result.messages) ? result.messages : [];
        const nextMessages = this.prependUniqueNativeMessages(messages, state.chatMessages);
        const grew = nextMessages.length > state.chatMessages.length;
        state.chatMessages = nextMessages;
        const appliedPagination: ChatHistoryPagination = exhausted
          ? {
              hasMore: false,
              ...(nextPagination.totalMessages !== undefined
                ? { totalMessages: nextPagination.totalMessages }
                : {}),
            }
          : nextPagination;
        state.chatHistoryPagination = appliedPagination;
        this.nativePaginationSnapshot = appliedPagination;
        state.lastError = null;
        scheduleChatScroll(state, false);
        prepended = grew || !exhausted;
      }
    } catch (error) {
      if (generation === this.olderLoadGeneration) {
        state.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (generation === this.olderLoadGeneration) {
        if (!prepended) {
          this.historyAutoLoadBlocked = this.hasOlderMessages();
        } else if (!this.hasOlderMessages()) {
          this.historyAutoLoadBlocked = false;
        }
        this.loadingOlder = false;
        state.requestUpdate();
      }
    }
  }

  private async continueCatalogSession(key: CatalogSessionKey) {
    const state = this.state;
    const client = state?.client;
    const draft = state?.chatMessage.trim();
    if (!state || !client || !draft || !this.catalogSession?.canContinue) {
      return;
    }
    state.chatSending = true;
    state.requestUpdate();
    try {
      const result = await client.request<SessionsCatalogContinueResult>(
        "sessions.catalog.continue",
        key,
      );
      announceCatalogSessionContinued({ ...key, sessionKey: result.sessionKey });
      this.onPaneSessionChange?.(this.paneId, result.sessionKey);
      this.switchPaneSession(result.sessionKey);
      state.handleChatDraftChange(draft);
      await state.handleSendChat();
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.chatSending = false;
      state.requestUpdate();
    }
  }

  private async rewindToMessage(entryId: string): Promise<boolean> {
    const state = this.state;
    if (!state) {
      return false;
    }
    const result = await rewindChatHistory(state, entryId);
    if (!result) {
      state.requestUpdate?.();
      return false;
    }
    state.requestUpdate?.();
    return true;
  }

  private async forkFromMessage(entryId: string): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const sourceKey = state.sessionKey;
    const agentParams = scopedAgentParamsForSession(state, sourceKey);
    try {
      const result = await state.sessions.forkAtMessage(sourceKey, entryId, agentParams);
      const editorText = result.editorText ?? "";
      const draftPersisted = persistChatComposerState(state, result.sessionKey, {
        agentId: parseAgentSessionKey(result.sessionKey)?.agentId,
        draft: editorText,
      });
      if (this.state !== state || !visibleSessionMatches(state, sourceKey, agentParams.agentId)) {
        return;
      }
      this.onPaneSessionChange?.(this.paneId, result.sessionKey);
      this.switchPaneSession(result.sessionKey);
      if (!draftPersisted) {
        state.handleChatDraftChange(editorText);
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.chatError = state.lastError;
      state.requestUpdate?.();
    }
  }

  private async switchToBranch(leafEntryId: string): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    await switchChatHistoryBranch(state, leafEntryId);
    state.requestUpdate?.();
  }

  private readonly handleCommandPaletteSlashCommand = (command: string) => {
    const state = this.state;
    if (!state) {
      return;
    }
    state.handleChatDraftChange(command.endsWith(" ") ? command : `${command} `);
    state.requestUpdate?.();
  };

  private announceCommandPaletteTarget(
    onSlashCommand: CommandPaletteTargetDetail["onSlashCommand"],
  ) {
    this.dispatchEvent(
      new CustomEvent<CommandPaletteTargetDetail>(COMMAND_PALETTE_TARGET_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          owner: this,
          onSlashCommand,
        },
      }),
    );
  }

  private resolveBoardProvider(): BoardProvider {
    const sessionKey = resolveSessionKey(
      this.state?.sessionKey ?? this.sessionKey,
      this.context?.gateway.snapshot.hello,
    );
    if (this.boardProvider) {
      return this.boardProvider;
    }
    const gateway = this.context?.gateway.snapshot;
    return boardProviderForSession(
      sessionKey,
      gateway?.client,
      !gateway || isGatewayMethodAdvertised(gateway, "board.get") !== false,
      gateway?.connected ?? false,
      !gateway ||
        isGatewayCapabilityAdvertised(gateway, GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC) ===
          true,
      !gateway ||
        (isGatewayMethodAdvertised(gateway, "board.widget.appView") === true &&
          isGatewayMethodAdvertised(gateway, "board.widget.put") === true),
    );
  }

  private resolveBoardSessionKey(snapshotSessionKey = ""): string {
    const resolved = resolveSessionKey(
      snapshotSessionKey || this.state?.sessionKey || this.sessionKey,
      this.context?.gateway.snapshot.hello,
    );
    const normalized = normalizeSessionKeyForUiComparison(resolved);
    return normalized === "main" ? buildAgentMainSessionKey({ agentId: "main" }) : normalized;
  }

  private refreshSwarmBoardSnapshot(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const request = ++this.swarmBoardSnapshotRequest;
    const sessions = state.sessionsResult?.sessions ?? [];
    void import("../../lib/board/swarm-dashboard.ts").then(({ withSwarmWidget }) => {
      if (request !== this.swarmBoardSnapshotRequest) {
        return;
      }
      const currentBase = this.resolveBoardProvider().snapshot$.value;
      this.swarmBoardSnapshotBase = currentBase;
      this.swarmBoardSnapshot = withSwarmWidget(currentBase, sessions);
      this.requestUpdate();
    });
  }

  private resolveBoardView(): ResolvedBoardView {
    const provider = this.resolveBoardProvider();
    const baseSnapshot = provider.snapshot$.value;
    const snapshot: BoardViewSnapshot =
      this.swarmBoardSnapshotBase === baseSnapshot
        ? (this.swarmBoardSnapshot ?? baseSnapshot)
        : baseSnapshot;
    const hasBoard = snapshot.tabs.length > 0 || snapshot.widgets.length > 0;
    const sessionKey = this.resolveBoardSessionKey(snapshot.sessionKey);
    const saved =
      loadSettings().boardSessionViews?.[sessionKey] ??
      this.state?.settings?.boardSessionViews?.[sessionKey];
    const savedTab = snapshot.tabs.some((tab) => tab.tabId === saved?.activeTabId)
      ? saved?.activeTabId
      : undefined;
    const activeTabId =
      savedTab ??
      snapshot.widgets.find((candidate) => candidate.builtin === "swarm")?.tabId ??
      snapshot.tabs[0]?.tabId ??
      snapshot.widgets[0]?.tabId ??
      "";
    const tab = snapshot.tabs.find((candidate) => candidate.tabId === activeTabId);
    const activeTabReadOnly = snapshot.widgets.some(
      (candidate) => candidate.tabId === activeTabId && candidate.readOnly === true,
    );
    const commandDock =
      this.boardCommandDock?.sessionKey === sessionKey &&
      this.boardCommandDock.tabId === activeTabId
        ? this.boardCommandDock.dock
        : undefined;
    const dock = commandDock ?? tab?.chatDock ?? "right";
    const dockKey = `${sessionKey}:${activeTabId}`;
    if (dock !== "hidden") {
      this.lastVisibleBoardDock.set(dockKey, dock);
    }
    return {
      provider,
      snapshot,
      hasBoard,
      face: hasBoard ? (saved?.face ?? "chat") : "chat",
      activeTabId,
      activeTabReadOnly,
      dock,
      reopenDock:
        this.lastVisibleBoardDock.get(dockKey) ?? saved?.reopenDockByTab?.[activeTabId] ?? "right",
    };
  }

  private persistBoardSessionView(patch: Partial<BoardSessionView>): void {
    const board = this.resolveBoardView();
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    if (!sessionKey) {
      return;
    }
    const settings = this.state?.settings;
    const persistedSettings = loadSettings();
    const boardSessionViews = {
      ...settings?.boardSessionViews,
      ...persistedSettings.boardSessionViews,
    };
    const next = patchSettings({
      boardSessionViews: updateBoardSessionView(boardSessionViews, sessionKey, patch),
    });
    if (this.state) {
      this.state.settings = next;
    }
    this.requestUpdate();
  }

  private persistBoardReopenDock(board: ResolvedBoardView, dock: VisibleBoardDock): void {
    if (!board.activeTabId) {
      return;
    }
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    const saved =
      loadSettings().boardSessionViews?.[sessionKey] ??
      this.state?.settings?.boardSessionViews?.[sessionKey];
    this.persistBoardSessionView({
      reopenDockByTab: {
        ...saved?.reopenDockByTab,
        [board.activeTabId]: dock,
      },
    });
  }

  private handleBoardCommand(event: BoardCommandEvent): void {
    const board = this.resolveBoardView();
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    if (!sessionKey || this.resolveBoardSessionKey(event.sessionKey) !== sessionKey) {
      return;
    }
    const command = event.command;
    if (command.kind === "focus_tab") {
      if (board.snapshot.tabs.some((tab) => tab.tabId === command.tabId)) {
        this.boardCommandDock = null;
        this.persistBoardSessionView({ face: "dashboard", activeTabId: command.tabId });
      }
      return;
    }
    if (!board.activeTabId) {
      return;
    }
    const reopenDock = command.dock === "hidden" ? board.reopenDock : command.dock;
    this.persistBoardReopenDock(board, reopenDock);
    this.boardCommandDock = {
      sessionKey,
      tabId: board.activeTabId,
      dock: command.dock,
    };
    if (command.dock !== "hidden") {
      this.lastVisibleBoardDock.set(`${sessionKey}:${board.activeTabId}`, command.dock);
    }
  }

  private handleBoardDockChange(dock: BoardTab["chatDock"]): void {
    const board = this.resolveBoardView();
    if (!board.activeTabId || board.activeTabReadOnly) {
      return;
    }
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    this.boardCommandDock = null;
    const reopenDock = dock === "hidden" ? board.reopenDock : dock;
    this.lastVisibleBoardDock.set(`${sessionKey}:${board.activeTabId}`, reopenDock);
    this.persistBoardReopenDock(board, reopenDock);
    void board.provider
      .applyOps([{ kind: "tab_update", tabId: board.activeTabId, chatDock: dock }])
      .catch((error: unknown) => this.publishHeaderError(error));
  }

  private renderBoardDivider(dock: VisibleBoardDock) {
    return renderChatResizableDivider({
      className: "board-session-surface__divider",
      orientation: dock === "bottom" ? "horizontal" : "vertical",
      splitRatio: 0.5,
      minRatio: 0.2,
      maxRatio: 0.8,
      label: t("chat.board.resizeDock"),
      onElement: (element) => {
        if (!(element instanceof HTMLElement)) {
          return;
        }
        queueMicrotask(() => {
          const previous = element.previousElementSibling?.getBoundingClientRect();
          const next = element.nextElementSibling?.getBoundingClientRect();
          const previousSize = dock === "bottom" ? (previous?.height ?? 0) : (previous?.width ?? 0);
          const nextSize = dock === "bottom" ? (next?.height ?? 0) : (next?.width ?? 0);
          const total = previousSize + nextSize;
          if (total > 0) {
            (element as HTMLElement & { splitRatio: number }).splitRatio =
              (dock === "left" ? nextSize : previousSize) / total;
          }
        });
      },
      onResize: (event) => this.handleBoardDockResize(dock, event),
    });
  }

  private handleBoardDockResize(
    dock: VisibleBoardDock,
    event: CustomEvent<{ splitRatio: number }>,
  ): void {
    const divider = event.currentTarget as HTMLElement | null;
    const previous = divider?.previousElementSibling?.getBoundingClientRect();
    const next = divider?.nextElementSibling?.getBoundingClientRect();
    const total =
      dock === "bottom"
        ? (previous?.height ?? 0) + (next?.height ?? 0)
        : (previous?.width ?? 0) + (next?.width ?? 0);
    if (total <= 0) {
      return;
    }
    if (dock === "bottom") {
      this.boardChatDockSize = {
        ...this.boardChatDockSize,
        height: Math.min(
          boardChatDockLayout.maxHeight(),
          Math.max(boardChatDockLayout.minHeight, total * (1 - event.detail.splitRatio)),
        ),
      };
    } else {
      const dockRatio = dock === "left" ? event.detail.splitRatio : 1 - event.detail.splitRatio;
      this.boardChatDockSize = {
        ...this.boardChatDockSize,
        width: Math.min(
          boardChatDockLayout.maxWidth(),
          Math.max(boardChatDockLayout.minWidth, total * dockRatio),
        ),
      };
    }
    boardChatDockLayout.save({
      ...this.boardChatDockSize,
      open: true,
      dock,
    });
  }

  private confirmConversationReset(): Promise<boolean> {
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

  private cancelResetConfirmationForSessionChange(): void {
    const pending = this.resetConfirmation;
    if (pending && !areUiSessionKeysEquivalent(pending.sessionKey, this.resolveBoardSessionKey())) {
      this.settleResetConfirmation(false);
    }
  }

  private settleResetConfirmation(confirmed: boolean): void {
    const pending = this.resetConfirmation;
    if (!pending) {
      return;
    }
    this.resetConfirmation = undefined;
    this.resetConfirmationOpen = false;
    pending.resolve(confirmed);
  }

  private renderResetConfirmation() {
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

  private readonly createSession = async (): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected) {
      return false;
    }
    const context = this.context;
    const sessions = context.sessions;
    const client = state.client;
    const previousSessionKey = state.sessionKey;
    const preservesBoard = this.resolveBoardView().hasBoard;
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
      context.gateway.snapshot.connected &&
      this.connectionGeneration === connectionGeneration;
    if (!canCreateChatSession(state)) {
      state.lastError = NEW_SESSION_ACTIVE_RUN_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return false;
    }
    if (state.sessionsLoading) {
      state.lastError = NEW_SESSION_LIST_LOADING_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
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
      state.lastError = NEW_SESSION_ACTIVE_RUN_MESSAGE;
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return false;
    }

    state.lastError = null;
    state.chatError = null;
    if (preservesBoard) {
      const resetResult = await clearChatHistory(state);
      return resetResult !== "failed";
    }
    const nextSessionKey = await sessions.create({
      currentSessionKey: previousSessionKey,
      agentId:
        scopedAgentParamsForSession(state, previousSessionKey).agentId ??
        resolveAgentIdFromSessionKey(previousSessionKey),
    });
    if (!isCurrent()) {
      return false;
    }
    if (
      !nextSessionKey ||
      state.sessionKey !== previousSessionKey ||
      !canCreateChatSession(state)
    ) {
      if (!nextSessionKey) {
        state.lastError =
          state.sessionsError ??
          (state.sessionsLoading
            ? NEW_SESSION_LIST_LOADING_MESSAGE
            : NEW_SESSION_CREATE_FAILED_MESSAGE);
        state.chatError = state.lastError;
        state.requestUpdate?.();
      }
      return false;
    }
    this.chatState.captureCreatedSessionComposer(nextSessionKey);
    this.onPaneSessionChange?.(this.paneId, nextSessionKey);
    return true;
  };

  private syncActiveBindings() {
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

  private readonly handlePaneFocus = () => {
    this.onFocusPane?.(this.paneId);
  };

  /** Receives a browser-panel annotation: attach the marked-up screenshot and append the prepackaged prompt. */
  private receiveBrowserAnnotation(event: Event): void {
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

  private sendPendingSkillWorkshopRevision(expectedSessionKey: string) {
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

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
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

  private readonly handleDocumentPointerdown = (event: PointerEvent) => {
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
    super.connectedCallback();
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
        }
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
        if (state) {
          handleQuestionPromptEvent(this.questionPromptState, event);
        }
        if (state && !parseCatalogSessionKey(state.sessionKey)) {
          if (event.event === "task.suggestion" && event.payload) {
            this.handleTaskSuggestionEvent(event.payload as TaskSuggestionEvent);
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
  }

  override disconnectedCallback() {
    this.settleResetConfirmation(false);
    this.paneResizeObserver?.disconnect();
    this.paneResizeObserver = null;
    this.connectionGeneration += 1;
    this.taskSuggestionsRequestVersion += 1;
    this.taskSuggestions = [];
    this.taskSuggestionBusyIds.clear();
    this.taskSuggestionOperations.clear();
    this.resetSessionPullRequests();
    this.resetOlderMessagesViewport();
    this.nativeDraftCleanup?.();
    this.nativeDraftCleanup = null;
    if (this.headerCopiedTimer !== null) {
      window.clearTimeout(this.headerCopiedTimer);
      this.headerCopiedTimer = null;
    }
    this.headerWorktreePaths.clear();
    this.headerBranches.clear();
    this.announceCommandPaletteTarget(null);
    resetChatViewState(this.paneId);
    this.state = undefined;
    this.connectedClient = null;
    disposeQuestionPromptState(this.questionPromptState);
    super.disconnectedCallback();
  }

  private applySessionsState(stateValue: ApplicationContext["sessions"]["state"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const selectedSessionDeleted = stateValue.deletedSessions.some(({ key, agentId }) =>
      uiSessionEventMatches(
        {
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
          sessionKey: state.sessionKey,
        },
        key,
        agentId,
      ),
    );
    for (const { key } of stateValue.deletedSessions) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey: key });
    }
    state.sessionsResult = stateValue.result;
    state.sessionsResultAgentId = stateValue.agentId;
    state.sessionsLoading = stateValue.loading;
    state.sessionsError = stateValue.error;
    this.refreshSwarmBoardSnapshot();
    const selectedSession = stateValue.result?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, state.sessionKey),
    );
    if (applySelectedSessionProjection(state, selectedSession)) {
      this.markSessionRead(selectedSession);
    }
    if (selectedSessionDeleted) {
      const agentId =
        parseAgentSessionKey(state.sessionKey)?.agentId ??
        this.context.agentSelection.state.selectedId ??
        "main";
      this.onPaneSessionChange?.(
        this.paneId,
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: this.context.agents.state.agentsList,
            hello: this.context.gateway.snapshot.hello,
          }),
        }),
      );
      return;
    }
    const reconciledLocalCompletion = reconcileStaleChatRunAfterSessionStatePublication(state);
    this.reconcileWaitingApprovalSnapshot();
    if (!reconciledLocalCompletion) {
      state.requestUpdate?.();
    }
  }

  private reconcileWaitingApprovalSnapshot(
    approvalQueue?: ApplicationContext["overlays"]["snapshot"]["approvalQueue"],
  ): boolean {
    const state = this.state;
    const queue = approvalQueue ?? this.context?.overlays?.snapshot.approvalQueue;
    if (!state || !queue) {
      return false;
    }
    return reconcileWaitingApprovalsFromSnapshot(state, queue);
  }

  private applyApplicationConfig(config: ApplicationContext["config"]["current"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousTerminalAvailable = state.terminalAvailable;
    state.terminalAvailable =
      config.terminalEnabled &&
      state.connected &&
      hasOperatorAdminAccess(state.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "terminal.open") === true;
    const rootsChanged =
      state.localMediaPreviewRoots.length !== config.localMediaPreviewRoots.length ||
      state.localMediaPreviewRoots.some(
        (value, index) => value !== config.localMediaPreviewRoots[index],
      );
    if (
      !rootsChanged &&
      state.terminalAvailable === previousTerminalAvailable &&
      state.embedSandboxMode === config.embedSandboxMode &&
      state.allowExternalEmbedUrls === config.allowExternalEmbedUrls &&
      state.chatMessageMaxWidth === config.chatMessageMaxWidth
    ) {
      return;
    }
    state.localMediaPreviewRoots = config.localMediaPreviewRoots;
    state.embedSandboxMode = config.embedSandboxMode;
    state.allowExternalEmbedUrls = config.allowExternalEmbedUrls;
    state.chatMessageMaxWidth = config.chatMessageMaxWidth;
    state.requestUpdate?.();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const state = this.state;
    if (!state) {
      return;
    }
    const wasConnected = state.connected;
    const sourceChanged = state.client !== snapshot.client || wasConnected !== snapshot.connected;
    const clientChanged = this.connectedClient !== snapshot.client;
    if (sourceChanged) {
      // A reconnect can retain the browser client. Keep async ownership tied
      // to the logical connection, not only the transport object identity.
      this.connectionGeneration += 1;
      this.taskSuggestionsRequestVersion += 1;
      this.taskSuggestions = [];
      this.taskSuggestionBusyIds.clear();
      this.taskSuggestionOperations.clear();
      this.sessionDiscussionStates.clear();
      this.resetOlderMessagesViewport();
      state.chatLoading = false;
    }
    state.client = snapshot.client;
    state.connected = snapshot.connected;
    state.connectionEpoch = this.connectionGeneration;
    state.hello = snapshot.hello;
    if (sourceChanged && state.sidebarContent?.kind === "session-discussion") {
      // A reconnect may point at a different gateway/provider; an open panel
      // would keep rendering the previous provider's URL. Close it — the
      // re-probe below restores the action for the new source.
      state.handleCloseSidebar();
    }
    if (sourceChanged && snapshot.connected && state.sessionKey) {
      // Reconnects clear the probed states above; re-probe the active session
      // so the Discussion action reappears without a manual session switch.
      void this.probeSessionDiscussion(state.sessionKey);
    }
    state.terminalAvailable =
      this.context.config.current.terminalEnabled &&
      snapshot.connected &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "terminal.open") === true;
    state.browserPanelAvailable =
      snapshot.connected &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "browser.request") === true;
    state.assistantAgentId = snapshot.assistantAgentId;
    const routeSessionKey = this.sessionKey.trim();
    const catalogRouteKey = parseCatalogSessionKey(routeSessionKey);
    const canonicalRouteSessionKey =
      routeSessionKey && !catalogRouteKey
        ? resolveSessionKey(routeSessionKey, snapshot.hello)
        : null;
    if (
      routeSessionKey &&
      canonicalRouteSessionKey &&
      canonicalRouteSessionKey !== routeSessionKey
    ) {
      this.onPaneSessionChange?.(this.paneId, canonicalRouteSessionKey, { replace: true });
      state.requestUpdate?.();
      // Persisted state may already own the canonical key; continue startup
      // because no later route update would load its history.
      if (state.sessionKey !== canonicalRouteSessionKey) {
        return;
      }
    }
    state.assistantName = this.context.config.current.assistantIdentity.name;
    if (!snapshot.connected) {
      if (wasConnected) {
        const currentSessionId =
          typeof state.currentSessionId === "string" ? state.currentSessionId.trim() : "";
        if (currentSessionId) {
          state.reconnectResumeSessionId = currentSessionId;
        }
        markQueuedChatSendsWaitingForReconnect(state);
      }
      this.connectedClient = null;
      setQuestionPromptClient(this.questionPromptState, null);
      state.realtimeTalkSession?.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkVideoStream = null;
      state.realtimeTalkCameraDevices = [];
      state.realtimeTalkVideoCapable = false;
      state.realtimeTalkVideoPending = false;
      state.realtimeTalkCameraError = false;
      state.realtimeTalkStatus = "idle";
      state.realtimeTalkInputLevel.set(0);
      state.resetToolStream();
      state.requestUpdate?.();
      return;
    }
    if (clientChanged && snapshot.client) {
      const startupClient = snapshot.client;
      const startupGeneration = this.connectionGeneration;
      const startupSessionKey = state.sessionKey;
      const agentsListBeforeStartup = this.context.agents.state.agentsList;
      const clientIsCurrent = () =>
        this.connectionGeneration === startupGeneration &&
        this.connectedClient === startupClient &&
        state.client === startupClient &&
        state.connected;
      const finishStartup = async () => {
        if (!clientIsCurrent()) {
          return;
        }
        let agentsList = this.context.agents.state.agentsList;
        if (agentsList === agentsListBeforeStartup) {
          agentsList = await this.context.agents.ensureList();
        }
        if (!clientIsCurrent()) {
          return;
        }
        if (agentsList) {
          applyChatAgentsList(state, agentsList, startupClient);
        }
        state.requestUpdate?.();
        if (state.sessionKey === startupSessionKey) {
          this.sendPendingSkillWorkshopRevision(startupSessionKey);
        }
      };
      this.connectedClient = startupClient;
      setQuestionPromptClient(this.questionPromptState, startupClient);
      refreshPendingQuestionsWithRetry(this.questionPromptState, startupClient, clientIsCurrent);
      this.headerWorktreePaths.clear();
      this.headerBranches.clear();
      this.headerPlatform = null;
      void this.loadHeaderPlatform(startupClient, startupGeneration);
      if (catalogRouteKey) {
        void this.loadCatalogSession(catalogRouteKey, false);
        state.requestUpdate?.();
        return;
      }
      void syncSelectedSessionMessageSubscription(state, { force: true });
      void retryReconnectableQueuedChatSends(state);
      void refreshPageChat(state, { startup: true, awaitHistory: true }).finally(() => {
        void finishStartup();
      });
      void refreshChatModelAuthStatus(state).finally(() => state.requestUpdate?.());
      void state.loadAssistantIdentity();
      void this.refreshTaskSuggestions();
      void this.refreshSessionPullRequests();
    }
    this.reconcileWaitingApprovalSnapshot();
    state.requestUpdate?.();
  }

  private async loadHeaderPlatform(
    client: GatewayBrowserClient,
    generation: number,
  ): Promise<void> {
    if (!isGatewayMethodAdvertised(this.context.gateway.snapshot, "system.info")) {
      return;
    }
    let platformRequest = headerPlatformByClient.get(client);
    if (!platformRequest) {
      platformRequest = client
        .request<SystemInfoResult>("system.info", {})
        .then((result) => result.platform)
        .catch(() => null);
      headerPlatformByClient.set(client, platformRequest);
    }
    try {
      const platform = await platformRequest;
      if (this.connectedClient === client && this.connectionGeneration === generation) {
        this.headerPlatform = platform;
      }
    } catch {
      // Optional label refinement. Generic file-manager copy remains correct.
    }
  }

  private beginHeaderRename(row: GatewaySessionRow): void {
    const customLabel = row.label?.trim() || null;
    this.headerRenameSessionKey = row.key;
    this.headerRenameInitialLabel = customLabel;
    this.headerRenameInitialValue = customLabel ?? this.paneTitle;
    this.headerRenameValue = this.headerRenameInitialValue;
    this.headerEditing = true;
    void this.updateComplete.then(() => {
      const input = this.querySelector<HTMLInputElement>(".chat-pane__session-title-input");
      input?.focus();
      input?.select();
    });
  }

  private cancelHeaderRename(): void {
    this.headerEditing = false;
    this.headerRenameSessionKey = "";
  }

  private commitHeaderRename(): void {
    if (!this.headerEditing) {
      return;
    }
    const key = this.headerRenameSessionKey;
    const trimmed = this.headerRenameValue.trim();
    const label = trimmed || null;
    const unchangedDerivedTitle =
      this.headerRenameInitialLabel === null && trimmed === this.headerRenameInitialValue.trim();
    const unchangedLabel = label === this.headerRenameInitialLabel;
    this.headerEditing = false;
    this.headerRenameSessionKey = "";
    if (!key || unchangedDerivedTitle || unchangedLabel) {
      return;
    }
    const agentId = parseAgentSessionKey(key)?.agentId;
    void this.context.sessions
      .patch(key, { label }, agentId ? { agentId } : undefined)
      .catch((error: unknown) => this.publishHeaderError(error));
  }

  private async loadHeaderMenuData(
    row: GatewaySessionRow,
    agentWorkspace: string | undefined,
    workspaceGit: boolean,
  ): Promise<void> {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    const loads: Promise<void>[] = [];
    // Same precedence as resolveChatPaneWorkspace/loadSessionFileRoot.
    const immediateRoot =
      (row.execNode ? row.execCwd?.trim() : undefined) ||
      row.spawnedWorkspaceDir?.trim() ||
      row.spawnedCwd?.trim() ||
      null;
    const worktreeId = row.worktree?.id;
    if (worktreeId && !immediateRoot) {
      const entry = this.headerWorktreePaths.get(worktreeId) ?? {};
      this.headerWorktreePaths.set(worktreeId, entry);
      if (!entry.loaded && !entry.loading) {
        entry.loading = true;
        loads.push(
          client
            .request<WorktreesListResult>("worktrees.list", {})
            .then((result) => {
              entry.path =
                result.worktrees.find(
                  (candidate) => candidate.id === worktreeId && candidate.removedAt === undefined,
                )?.path ?? null;
              entry.loaded = true;
            })
            .catch(() => {
              entry.path = null;
              entry.loaded = false;
            })
            .finally(() => {
              entry.loading = false;
            }),
        );
      }
    }
    const agentRoot = !row.worktree ? agentWorkspace?.trim() : undefined;
    const knownRoot =
      immediateRoot ||
      (worktreeId ? this.headerWorktreePaths.get(worktreeId)?.path : undefined) ||
      agentRoot;
    const remote = Boolean(row.execNode) || isCloudWorkerPlacementState(row.placement?.state);
    // workspaceGit describes the agent workspace only; a session-specific
    // root (spawned dir) may be a Git checkout regardless, so probe it and
    // let a failed lookup hide the branch action instead.
    const rootMayHaveBranch = knownRoot === agentRoot ? workspaceGit : Boolean(knownRoot);
    // Unlike the worktree path, HEAD moves whenever the agent checks out a
    // branch mid-session, so every menu open refetches. Deliberate
    // stale-while-revalidate: the last-known branch stays actionable during
    // the sub-second local refresh — hiding it would flicker the menu on
    // every open to guard a race narrower than the user's click.
    if (!row.worktree && !remote && knownRoot && rootMayHaveBranch) {
      const entry = this.headerBranches.get(knownRoot) ?? {};
      this.headerBranches.set(knownRoot, entry);
      if (!entry.loading) {
        entry.loading = true;
        loads.push(
          client
            .request<WorktreesBranchesResult>("worktrees.branches", { repoRoot: knownRoot })
            .then((result) => {
              entry.value = result.headBranch ?? null;
            })
            .catch(() => {
              entry.value = null;
            })
            .finally(() => {
              entry.loading = false;
            }),
        );
      }
    }
    await Promise.all(loads);
    this.requestUpdate();
  }

  private showHeaderCopied(action: ChatPaneHeaderAction): void {
    this.headerCopiedAction = action;
    if (this.headerCopiedTimer !== null) {
      window.clearTimeout(this.headerCopiedTimer);
    }
    this.headerCopiedTimer = window.setTimeout(() => {
      this.headerCopiedAction = null;
      this.headerCopiedTimer = null;
    }, 1_500);
  }

  private handleHeaderMenuAction(
    action: ChatPaneHeaderAction,
    row: GatewaySessionRow,
    workspaceRoot: string | null,
    branch: string | null,
    copy: (value: string) => Promise<boolean> = copyToClipboard,
  ): void {
    if (action === "copy-path" && workspaceRoot) {
      void copy(workspaceRoot).then((copied) => {
        if (copied) {
          this.showHeaderCopied(action);
        }
      });
      return;
    }
    if (action === "copy-branch" && branch) {
      void copy(branch).then((copied) => {
        if (copied) {
          this.showHeaderCopied(action);
        }
      });
      return;
    }
    if (action === "reveal" && workspaceRoot) {
      void this.revealHeaderWorkspace(row);
    }
  }

  private publishHeaderError(error: unknown): void {
    if (!this.state) {
      return;
    }
    this.state.chatError = error instanceof Error ? error.message : String(error);
    this.state.requestUpdate?.();
  }

  private async revealHeaderWorkspace(row: GatewaySessionRow): Promise<void> {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    const agentId = parseAgentSessionKey(row.key)?.agentId;
    try {
      const result = await client.request<SessionsFilesRevealResult>("sessions.files.reveal", {
        key: row.key,
        ...(agentId ? { agentId } : {}),
      });
      if (!result.ok) {
        this.publishHeaderError(result.error ?? "Failed to reveal thread workspace.");
      }
    } catch (error) {
      this.publishHeaderError(error);
    }
  }

  // Probe once per session activation; transient failures stay uncached so the
  // next activation retries instead of permanently hiding the feature.
  private async probeSessionDiscussion(sessionKey: string) {
    const state = this.state;
    if (
      !state?.connected ||
      !state.client ||
      this.sessionDiscussionStates.has(sessionKey) ||
      // One in-flight probe per key: a rapid A→B→A switch must not start a
      // second probe whose slower twin could later overwrite the fresh result.
      this.sessionDiscussionProbes.has(sessionKey) ||
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.info") !== true
    ) {
      return;
    }
    const generation = this.connectionGeneration;
    this.sessionDiscussionProbes.add(sessionKey);
    try {
      const info = await state.client.request<SessionDiscussionInfo>("session.discussion.info", {
        sessionKey,
      });
      // A reconnect supersedes in-flight probes; a stale result must not
      // overwrite the new source's cache (e.g. an old "none" hiding the action).
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.sessionDiscussionStates.set(sessionKey, info.state);
      this.requestUpdate();
    } catch {
      // Leave unprobed: the action stays hidden and a later switch retries.
    } finally {
      this.sessionDiscussionProbes.delete(sessionKey);
      // A reconnect during this probe skipped its own probe (the key was
      // still held here); retry now so the new source gets a fresh answer.
      if (
        generation !== this.connectionGeneration &&
        this.state?.sessionKey === sessionKey &&
        !this.sessionDiscussionStates.has(sessionKey)
      ) {
        void this.probeSessionDiscussion(sessionKey);
      }
    }
  }

  private renderSessionDiscussionAction() {
    const state = this.state;
    const sessionKey = state?.sessionKey.trim() ?? "";
    const known = sessionKey ? this.sessionDiscussionStates.get(sessionKey) : undefined;
    if (
      !state?.connected ||
      !state.client ||
      !sessionKey ||
      known === undefined ||
      known === "none" ||
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.info") !== true
    ) {
      return nothing;
    }
    const canOpen =
      hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.open") === true;
    const contentGeneration = this.connectionGeneration;
    const content: SidebarContent = {
      kind: "session-discussion",
      sessionKey,
      canOpen,
      loadInfo: async (key) => {
        if (!state.connected || !state.client) {
          throw new Error(t("chat.sessionDiscussion.disconnected"));
        }
        return await state.client.request<SessionDiscussionInfo>("session.discussion.info", {
          sessionKey: key,
        });
      },
      openDiscussion: async (key) => {
        if (!state.connected || !state.client) {
          throw new Error(t("chat.sessionDiscussion.disconnected"));
        }
        return await state.client.request<SessionDiscussionInfo>("session.discussion.open", {
          sessionKey: key,
        });
      },
      onStateChange: (key, discussionState) => {
        // Panels created under a previous connection may report late; their
        // state belongs to the old provider and must not touch the new cache.
        if (contentGeneration !== this.connectionGeneration) {
          return;
        }
        this.sessionDiscussionStates.set(key, discussionState);
        const current = state.sidebarContent;
        if (
          discussionState === "none" &&
          current?.kind === "session-discussion" &&
          current.sessionKey === key
        ) {
          state.handleCloseSidebar();
          return;
        }
        state.requestUpdate();
      },
    };
    const active =
      state.sidebarOpen &&
      state.sidebarContent?.kind === "session-discussion" &&
      state.sidebarContent.sessionKey === sessionKey;
    const label = t("chat.sessionDiscussion.show");
    return html`
      <openclaw-tooltip .content=${label}>
        <button
          class="btn btn--ghost btn--icon chat-icon-btn chat-session-discussion-toggle"
          type="button"
          aria-label=${label}
          aria-pressed=${String(active)}
          @click=${() => state.handleOpenSidebar(content)}
        >
          ${icons.messageSquare}
        </button>
      </openclaw-tooltip>
    `;
  }

  private renderPaneHeader(
    sessionWorkspace: SessionWorkspaceProps,
    backgroundTasks: BackgroundTasksProps,
    row: GatewaySessionRow | undefined,
    catalog: boolean,
    agentWorkspace: string | undefined,
    workspaceGit: boolean,
  ) {
    const board = this.resolveBoardView();
    const workspace = resolveChatPaneWorkspace({
      session: row,
      agentWorkspace: row?.worktree ? undefined : agentWorkspace,
      worktreePath: row?.worktree ? this.headerWorktreePaths.get(row.worktree.id)?.path : undefined,
    });
    // Managed worktree sessions copy the worktree record's branch — the same
    // source the sidebar subtitle and preserved-worktree prompts use. Live
    // HEAD is only resolved for plain checkouts, where no record exists.
    // Cached HEAD is keyed by the resolved root and masked while the session
    // runs remotely, so reused keys, root transitions, open menus, and
    // in-flight lookups racing a dispatch can never surface a wrong branch.
    const rowRemote = Boolean(row?.execNode) || isCloudWorkerPlacementState(row?.placement?.state);
    const branch =
      row?.worktree?.branch ||
      (rowRemote || !workspace.root ? null : this.headerBranches.get(workspace.root)?.value) ||
      null;
    const canReveal = canRevealSessionWorkspace({
      session: row,
      workspaceRoot: workspace.root,
      methodAdvertised:
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "sessions.files.reveal") === true,
      hasAdminAccess: hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
    });
    const branchSwitchWorking = this.state
      ? this.state.chatSending ||
        isChatRunWorking({
          canAbort: hasAbortableSessionRun(this.state),
          onAbort: () => undefined,
          queue: this.state.chatQueue,
          runStatus: this.state.chatRunStatus,
          sessionKey: this.state.sessionKey,
        })
      : false;
    const branchSwitchDisabledReason = !hasOperatorAdminAccess(
      this.context.gateway.snapshot.hello?.auth ?? null,
    )
      ? t("chat.sessionHeader.branchSwitchRequiresAdmin")
      : branchSwitchWorking
        ? t("chat.sessionHeader.branchSwitchUnavailable")
        : null;
    return renderChatPaneHeader({
      paneId: this.paneId,
      narrow: this.narrow,
      mergedChrome: this.mergedChrome,
      title: this.paneTitle,
      session: row,
      catalog,
      editing: this.headerEditing && this.headerRenameSessionKey === row?.key,
      renameValue: this.headerRenameValue,
      workspaceRoot: workspace.root,
      workspaceLabel: workspace.label,
      branch,
      branches:
        this.state && this.state.chatBranchesSessionKey === this.state.sessionKey
          ? (this.state.chatBranches ?? [])
          : [],
      branchSwitchDisabledReason,
      platform: this.headerPlatform,
      canReveal,
      copiedAction: this.headerCopiedAction,
      canRename:
        this.state?.connected === true &&
        hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      terminalAction: renderCatalogTerminalButton(this.state, this.catalogSession),
      discussionAction: this.renderSessionDiscussionAction(),
      diffAction: renderSessionDiffToggle(sessionWorkspace),
      backgroundTasksAction: renderBackgroundTasksToggle(backgroundTasks),
      workspaceAction: renderSessionWorkspaceToggle(sessionWorkspace),
      faceControl: renderBoardFaceToggle(board.hasBoard, board.face, (face) => {
        this.persistBoardSessionView({ face });
      }),
      boardDockAction: renderBoardDockMenu(
        board.hasBoard && !board.activeTabReadOnly,
        board.face,
        board.dock,
        (dock) => this.handleBoardDockChange(dock),
      ),
      onBeginRename: () => row && this.beginHeaderRename(row),
      onRenameInput: (value) => {
        this.headerRenameValue = value;
      },
      onCommitRename: () => this.commitHeaderRename(),
      onCancelRename: () => this.cancelHeaderRename(),
      onMenuOpenChange: (open) => {
        if (open && row) {
          void this.loadHeaderMenuData(row, agentWorkspace, workspaceGit);
        }
      },
      onMenuAction: (action) => {
        if (row) {
          this.handleHeaderMenuAction(action, row, workspace.root, branch);
        }
      },
      onBranchSelect: (leafEntryId) => void this.switchToBranch(leafEntryId),
      onOpenSplitView: this.onOpenSplitView,
      onSplitDown: this.onSplitDown,
      onSplitRight: this.onSplitRight,
      onClosePane: this.onClosePane,
    });
  }

  override render() {
    const state = this.state;
    if (!state) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const selectedSession = state.sessionsResult?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, state.sessionKey),
    );
    const board = this.resolveBoardView();
    const runtimeConfigState = this.context.runtimeConfig.state;
    const configSnapshot = runtimeConfigState.configSnapshot;
    const serverQueueMode = resolveControlUiServerQueueMode(configSnapshot?.runtimeConfig, {
      configNeedsApply: runtimeConfigState.configNeedsApply,
      effectiveMode: state.chatEffectiveQueueMode,
      sessionMetadataLoaded:
        selectedSession !== undefined || state.chatEffectiveQueueMode !== undefined,
      sessionMode: state.chatQueueModeOverride,
    });
    state.chatFollowUpMode = resolveControlUiFollowUpMode(
      state.settings.chatFollowUpMode,
      serverQueueMode,
    );
    const currentAgentId = resolveChatAgentId(state);
    const catalogKey = parseCatalogSessionKey(state.sessionKey);
    const overlays = this.context?.overlays;
    const approvalSnapshot = overlays?.snapshot;
    const inlineApproval = this.active
      ? findInlineApproval(approvalSnapshot?.approvalQueue ?? [], state.sessionKey)
      : null;
    // Tool rows consult the global title store while rendering; point its
    // fetcher at this pane's connection. Requests capture session + agent at
    // schedule time, so later renders of other panes cannot re-route them.
    configureToolTitleFetcher({
      client: state.connected ? state.client : null,
      sessionKey: catalogKey ? null : state.sessionKey || null,
      agentId: currentAgentId || null,
      onTitlesChanged: () => state.requestUpdate?.(),
    });
    const selectedAgent = this.context.agents.state.agentsList?.agents.find(
      (agent) => agent.id === currentAgentId,
    );
    const agentDefaultModel = selectedAgent?.model?.primary;
    const selectedSessionArchived =
      state.selectedChatSessionArchived ||
      state.sessionsResult?.sessions.some(
        (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, state.sessionKey),
      ) === true;
    const disabledReason = selectedSessionArchived ? t("chat.archivedSessionDisabled") : null;
    // Never flash "view-only" while metadata loads; after loading, anything short
    // of a continuable session (failed lookups too) explains the disabled composer.
    const catalogDisabledReason =
      catalogKey && !this.catalogLoading && this.catalogSession?.canContinue !== true
        ? this.catalogHost?.kind === "node"
          ? t("chat.catalog.remoteViewOnly")
          : t("chat.catalog.unsupportedViewOnly")
        : null;
    const chatLayoutWidth = resolveBoardChatLayoutWidth({
      paneWidth: this.paneWidth,
      hasBoard: board.hasBoard,
      face: board.face,
      dock: board.dock,
      dockWidth: this.boardChatDockSize.width,
    });
    const sessionWorkspace = createSessionWorkspaceProps(state, {
      draftScope: this.paneId,
      narrowLayout: chatLayoutWidth < WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH,
    });
    const railSideDocked =
      !sessionWorkspace.collapsed &&
      !sessionWorkspace.narrowLayout &&
      sessionWorkspace.dock !== "bottom";
    // The workspace rail claims the side slot first; the tasks rail needs
    // room for both columns before it may side-dock next to it.
    const backgroundTasks = createBackgroundTasksProps(state, {
      narrowLayout:
        chatLayoutWidth <
        WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH + (railSideDocked ? WORKSPACE_RAIL_MAX_WIDTH : 0),
      onOpenSession: (sessionKey) => {
        this.onPaneSessionChange?.(this.paneId, sessionKey);
      },
    });
    const tasksSideDocked = !backgroundTasks.collapsed && !backgroundTasks.narrowLayout;
    // Every side-docked rail narrows the room left for the chat + detail
    // split; bottom strips do not.
    const sideRailCount = (railSideDocked ? 1 : 0) + (tasksSideDocked ? 1 : 0);
    const detailSplitWidth = chatLayoutWidth - sideRailCount * WORKSPACE_RAIL_MAX_WIDTH;
    const props: ChatProps = {
      transcript: this.transcript,
      paneId: this.paneId,
      sessionKey: state.sessionKey,
      announceTranscript: this.active,
      onSessionKeyChange: (next) => {
        this.onPaneSessionChange?.(this.paneId, next);
      },
      thinkingLevel: state.chatThinkingLevel,
      autoExpandToolCalls: state.chatVerboseLevel === "full",
      showThinking: state.settings.chatShowThinking,
      showToolCalls: state.settings.chatShowToolCalls,
      persistCommentary: state.settings.chatPersistCommentary !== false,
      loading: catalogKey ? this.catalogLoading : state.chatLoading,
      sending: state.chatSending,
      canAbort: hasAbortableSessionRun(state),
      runStatus: state.chatRunStatus,
      waitingApproval: state.waitingApprovalStatuses.size > 0,
      compactionStatus: state.compactionStatus,
      fallbackStatus: state.fallbackStatus,
      planStatus: state.planStatus,
      gatewayQuestionPrompts: catalogKey ? [] : this.questionPrompts,
      onGatewayQuestionChange: () => {
        this.questionPrompts = [...this.questionPrompts];
        this.requestUpdate();
      },
      onGatewayQuestionSubmit: (id, answers) =>
        submitQuestionPrompt(this.questionPromptState, id, answers),
      onGatewayQuestionSkip: (id) => cancelQuestionPrompt(this.questionPromptState, id),
      messages: catalogKey ? this.catalogMessages : state.chatMessages,
      historyPagination:
        catalogKey || state.chatHistoryPagination?.hasMore || this.loadingOlder
          ? {
              loading: this.loadingOlder,
            }
          : undefined,
      sideChatTurns: catalogKey ? [] : state.chatSideChatTurns,
      sideChatPending: catalogKey ? null : state.chatSideResultPending,
      sideChatHidden: catalogKey ? true : state.chatSideChatHidden,
      toolMessages: catalogKey ? [] : state.chatToolMessages,
      streamSegments: catalogKey ? [] : state.chatStreamSegments,
      stream: catalogKey ? null : state.chatStream,
      streamStartedAt: catalogKey ? null : state.chatStreamStartedAt,
      assistantAvatarUrl: resolveChatAvatarUrl(state),
      sendShortcut: state.settings.chatSendShortcut,
      followUpMode: state.chatFollowUpMode,
      draft: state.chatMessage,
      queue: state.chatQueue,
      realtimeTalkActive: state.realtimeTalkActive,
      realtimeTalkStatus: state.realtimeTalkStatus,
      realtimeTalkDetail: state.realtimeTalkDetail,
      realtimeTalkInputLevel: state.realtimeTalkInputLevel,
      realtimeTalkConversation: state.realtimeTalkConversation,
      realtimeTalkVideoStream: state.realtimeTalkVideoStream,
      realtimeTalkCameraDevices: state.realtimeTalkCameraDevices,
      realtimeTalkVideoCapable: state.realtimeTalkVideoCapable,
      realtimeTalkVideoPending: state.realtimeTalkVideoPending,
      realtimeTalkCameraError: state.realtimeTalkCameraError,
      connected: state.connected,
      gatewayClient: state.client,
      composerHoldToRecord: state.settings.composerHoldToRecord,
      canSend: catalogKey ? this.catalogSession?.canContinue === true : !selectedSessionArchived,
      disabledReason: catalogDisabledReason ?? disabledReason,
      disabledActionLabel:
        selectedSessionArchived && !catalogDisabledReason ? t("common.restore") : null,
      onDisabledAction:
        selectedSessionArchived && !catalogDisabledReason
          ? () => void this.restoreArchivedSession(state.sessionKey)
          : null,
      error: state.lastError,
      runError: catalogKey ? null : (state.chatRunError ?? null),
      inlineApproval,
      approvalBusy: approvalSnapshot?.approvalBusy,
      approvalErrors: approvalSnapshot?.approvalErrors,
      approvalNowMs: approvalSnapshot?.approvalNowMs,
      onApprovalDecision: overlays
        ? (approvalId, decision) => overlays.decideApproval(decision, approvalId)
        : undefined,
      sessions: state.sessionsResult,
      sessionHost: {
        assistantAgentId: state.assistantAgentId,
        agentsList: state.agentsList,
        hello: state.hello,
      },
      providerUsage: {
        basePath: state.basePath,
        modelAuthStatusResult: state.modelAuthStatusResult,
      },
      composerControls: catalogKey
        ? nothing
        : renderChatControls({
            paneId: this.paneId,
            model: {
              activeRunId: state.chatRunId,
              agentDefaultModel,
              connected: state.connected,
              gatewayAvailable: Boolean(state.client),
              loading: state.chatLoading,
              modelCatalog: state.chatModelCatalog,
              modelOverrides: state.sessions.state.modelOverrides,
              modelSelectionLocked: selectedSession?.modelSelectionLocked === true,
              modelSelectionRuntimeId: selectedSession?.agentRuntime?.id,
              modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
              modelsLoading: state.chatModelsLoading,
              sending: state.chatSending,
              sessionKey: state.sessionKey,
              sessionsResult: state.sessionsResult,
              stream: state.chatStream,
              onRequestUpdate: () => state.requestUpdate?.(),
              onFastModeSelect: (next, targetSessionKey) =>
                switchChatFastMode(state, next, targetSessionKey),
              onModelSelect: (next, targetSessionKey) =>
                switchChatModel(state, next, targetSessionKey),
              onThinkingSelect: (next, targetSessionKey) =>
                switchChatThinkingLevel(state, next, targetSessionKey),
            },
            onboarding: state.onboarding,
            settings: state.settings,
            viewMenuOpen: state.chatViewMenuOpen,
            onSettingsChange: state.applySettings,
            onViewMenuOpenChange: (open, options) => {
              state.setChatViewMenuOpen(open, options);
            },
          }),
      sessionWorkspace: catalogKey ? undefined : sessionWorkspace,
      backgroundTasks: catalogKey ? undefined : backgroundTasks,
      taskSuggestions: this.taskSuggestions,
      pullRequests: this.sessionPullRequests.filter(
        (pullRequest) => !this.dismissedSessionPullRequestIds.has(chatPullRequestId(pullRequest)),
      ),
      // Decided on the undismissed list: a dismissed open PR still exists, so
      // the row must not offer creating a duplicate.
      pullRequestsBranch: createPullRequestBranch(
        this.sessionPullRequests,
        this.sessionPullRequestsBranch,
      ),
      pullRequestsRateLimited: this.sessionPullRequestsRateLimited,
      pullRequestsExpanded: this.sessionPullRequestsExpanded,
      onExpandPullRequests: () => {
        this.sessionPullRequestsExpanded = true;
        this.requestUpdate();
      },
      onDismissPullRequest: this.dismissSessionPullRequest,
      taskSuggestionBusyIds: this.taskSuggestionBusyIds,
      canAcceptTaskSuggestions:
        state.connected &&
        hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      canDismissTaskSuggestions:
        state.connected &&
        hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      onAcceptTaskSuggestion: (suggestion) => void this.acceptTaskSuggestion(suggestion),
      onDismissTaskSuggestion: (suggestion) => void this.dismissTaskSuggestion(suggestion),
      onOpenWorkspaceFile: (target) => openSessionWorkspaceFile(state, target),
      onRevealWorkspaceFile: (path) => revealSessionWorkspaceFile(state, path),
      onRefresh: () => {
        if (catalogKey) {
          void this.loadCatalogSession(catalogKey, false);
          return;
        }
        state.chatSideChatTurns = [];
        state.chatSideChatHidden = false;
        retirePendingChatSideQuestion(state);
        state.resetToolStream();
        this.reconcileWaitingApprovalSnapshot();
        void refreshPageChat(state, { awaitHistory: true, scheduleScroll: false });
      },
      onChatScroll: (event) => this.handleTranscriptScroll(event),
      onHistoryIntent: (event) => this.handleTranscriptHistoryIntent(event),
      getDraft: () => state.chatMessage,
      onDraftChange: state.handleChatDraftChange,
      onRequestUpdate: state.requestUpdate,
      onHistoryKeydown: state.handleChatInputHistoryKey,
      onSlashIntent: () => refreshChatCommands(state),
      showNewMessages: state.chatNewMessagesBelow,
      onScrollToBottom: state.scrollToBottom,
      attachments: state.chatAttachments,
      getAttachments: () => state.chatAttachments,
      onAttachmentsChange: (next) => {
        state.chatAttachments = next;
        state.requestUpdate?.();
      },
      onSend: () =>
        catalogKey ? void this.continueCatalogSession(catalogKey) : void state.handleSendChat(),
      onCompact: () => void state.handleSendChat("/compact"),
      onOpenSessionCheckpoints: () => {
        const search = new URLSearchParams({ session: state.sessionKey });
        if (selectedSessionArchived) {
          search.set("showArchived", "1");
        }
        this.context.navigate("sessions", { search: `?${search.toString()}` });
      },
      onToggleRealtimeTalk: () => void state.toggleRealtimeTalk(),
      onToggleRealtimeCamera: () => void state.toggleRealtimeTalkCamera(),
      onSwitchRealtimeCamera: () => void state.switchRealtimeTalkCamera(),
      onDismissError: () => {
        dismissChatError(state as never);
        state.requestUpdate?.();
      },
      onDismissRealtimeTalkError: () => {
        dismissRealtimeTalkError(state as never);
        state.requestUpdate?.();
      },
      onDictationError: (message) => {
        state.lastError = message;
        state.chatError = message;
        state.requestUpdate?.();
      },
      onAbort: () => void state.handleAbortChat({ preserveDraft: true }),
      onQueueRemove: state.removeQueuedMessage,
      onQueueRetry: (id) => void state.retryQueuedChatMessage(id),
      onQueueSteer: (id) => void state.steerQueuedChatMessage(id),
      onGoalCommand: (command) => void state.handleSendChat(command),
      onSideQuestion: (command, displayQuestion, onSendRejected) =>
        void state.handleSendChat(command, {
          ...(displayQuestion ? { sideQuestionDisplayText: displayQuestion } : {}),
          ...(onSendRejected ? { onSideQuestionSendRejected: onSendRejected } : {}),
        }),
      onSideChatClose: () => {
        // Hide only: a pending run keeps going and its arriving answer (or a
        // new question) reopens the panel with the conversation intact.
        state.chatSideChatHidden = true;
        state.requestUpdate?.();
      },
      onSideChatClear: () => {
        const pendingRunId = state.chatSideResultPending?.runId;
        state.chatSideChatTurns = [];
        state.chatSideChatHidden = false;
        // Retire (not just clear) so a discarded question's still-running
        // detached run cannot leak its late reply into the transcript.
        retirePendingChatSideQuestion(state);
        // Best-effort targeted abort: trash means "stop the pending side
        // question", not just hide it. The retire above already suppresses
        // the run's late events, so a failed abort needs no fallback.
        if (pendingRunId && state.client && state.connected) {
          state.client
            .request("chat.abort", {
              sessionKey: state.sessionKey,
              ...scopedAgentParamsForSession(state, state.sessionKey),
              runId: pendingRunId,
            })
            .catch(() => {});
        }
        state.requestUpdate?.();
      },
      replyTarget: state.chatReplyTarget ?? null,
      onClearReply: () => {
        state.chatReplyTarget = null;
        state.requestUpdate?.();
      },
      onSetReply: (target) => {
        state.chatReplyTarget = target;
        state.requestUpdate?.();
      },
      onRewindMessage: (entryId) => this.rewindToMessage(entryId),
      onForkMessage: (entryId) => this.forkFromMessage(entryId),
      onNewSession: () => void this.createSession(),
      onClearHistory: () => void clearChatHistory(state),
      agentsList: state.agentsList,
      currentAgentId,
      fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
      onAgentChange: (agentId) => {
        const nextSessionKey = buildAgentMainSessionKey({ agentId });
        this.onPaneSessionChange?.(this.paneId, nextSessionKey);
      },
      onSessionSelect: (next) => {
        this.onPaneSessionChange?.(this.paneId, next);
      },
      onLoadSidebarFullMessage: catalogKey
        ? undefined
        : async (request: SidebarFullMessageRequest): Promise<DetailFullMessageResult | null> => {
            if (!state.client || !state.connected) {
              return null;
            }
            return state.client.request<DetailFullMessageResult>("chat.message.get", {
              sessionKey: request.sessionKey,
              ...(request.agentId ? { agentId: request.agentId } : {}),
              messageId: request.messageId,
              maxChars: CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS,
            });
          },
      sidebarOpen: state.sidebarOpen,
      sidebarContent: state.sidebarContent,
      sidebarStacked: detailSplitWidth < DETAIL_SIDEBAR_SIDE_MIN_WIDTH,
      splitRatio: state.splitRatio,
      canvasPluginSurfaceUrl: state.hello?.pluginSurfaceUrls?.canvas ?? null,
      boardProvider: board.provider,
      onOpenSidebar: state.handleOpenSidebar,
      onCloseSidebar: state.handleCloseSidebar,
      onSplitRatioChange: state.handleSplitRatioChange,
      assistantName: state.assistantName,
      assistantAvatar: state.assistantAvatar,
      userName: state.userName,
      userAvatar: state.userAvatar,
      attributedIdentity: Boolean(this.context.gateway.snapshot.selfUser),
      localMediaPreviewRoots: state.localMediaPreviewRoots,
      embedSandboxMode: state.embedSandboxMode,
      allowExternalEmbedUrls: state.allowExternalEmbedUrls,
      chatMessageMaxWidth: state.chatMessageMaxWidth,
      assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state as never),
      basePath: state.basePath,
      gatewayUrl: state.settings.gatewayUrl,
    };
    const chat = renderChat(props);
    const content =
      board.hasBoard && board.face === "dashboard"
        ? renderBoardSessionSurface({
            snapshot: board.snapshot,
            sessions: state.sessionsResult?.sessions ?? [],
            activeTabId: board.activeTabId,
            dock: board.dock,
            reopenDock: board.reopenDock,
            dockSize: this.boardChatDockSize,
            chat,
            divider: this.renderBoardDivider(
              board.dock === "hidden" ? board.reopenDock : board.dock,
            ),
            callbacks: {
              applyOps: (ops) => board.provider.applyOps(ops),
              grant: (name, decision) => board.provider.grant(name, decision),
              selectTab: (tabId) => {
                this.boardCommandDock = null;
                this.persistBoardSessionView({ face: "dashboard", activeTabId: tabId });
              },
              frameLoadFailed: (name) => board.provider.refreshWidgetFrame(name),
              widgetAppView: (name, revision) => board.provider.widgetAppView(name, revision),
              refreshWidgetAppView: (name, revision) =>
                board.provider.refreshWidgetAppView(name, revision),
            } satisfies BoardViewCallbacks,
            widgetFrameUrl: (name, revision) => board.provider.widgetFrameUrl(name, revision),
            onDockChange: (dock) => this.handleBoardDockChange(dock),
          })
        : chat;
    return html`${this.renderPaneHeader(
      sessionWorkspace,
      backgroundTasks,
      selectedSession,
      Boolean(catalogKey),
      selectedAgent?.workspace,
      selectedAgent?.workspaceGit === true,
    )}${content}${this.renderResetConfirmation()}`;
  }
}

if (!customElements.get("openclaw-chat-pane")) {
  customElements.define("openclaw-chat-pane", ChatPane);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-pane": ChatPane;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
