import { consume } from "@lit/context";
import { asNullableRecord as catalogRawRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state as litState } from "lit/decorators.js";
import type {
  SessionCatalogHost,
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogContinueResult,
  SessionsCatalogReadResult,
  TaskSuggestion,
  TaskSuggestionEvent,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { beginNativeWindowDrag } from "../../app/native-window-drag.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import {
  BROWSER_ANNOTATION_EVENT,
  type BrowserAnnotationDraft,
} from "../../components/browser/browser-annotation.ts";
import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPaletteTargetDetail,
} from "../../components/command-palette-contract.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { retirePendingChatSideQuestion } from "../../lib/chat/side-result.ts";
import { clampText } from "../../lib/format.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  announceCatalogSessionContinued,
  buildCatalogSessionKey,
  lookupCatalogSession,
  parseCatalogSessionKey,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { resolveSessionKey, scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
import { SessionUnreadPatchGuard } from "../../lib/sessions/unread.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { refreshChatAvatar } from "./chat-avatar.ts";
import {
  applyChatAgentsList,
  clearChatHistory,
  loadChatHistory,
  loadOlderChatHistoryPage,
  resolveChatHistoryPagination,
  syncSelectedSessionMessageSubscription,
  type ChatHistoryPagination,
} from "./chat-history.ts";
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
  dismissChatError,
  handlePageGatewayEvent,
  refreshChatCommands,
  refreshChatMetadata,
  refreshChatModelAuthStatus,
  refreshPageChat,
  refreshRouteSessionOptions,
  resetChatStateForRouteSession,
  retryChatComposerMemoryFallback,
  resolveAssistantAttachmentAuthToken,
  resolveChatAgentId,
  resolveChatAvatarUrl,
  saveRouteSessionSettings,
  type ChatPageHost,
} from "./chat-state.ts";
import { renderChat, resetChatViewState, type ChatProps } from "./chat-view.ts";
import {
  createBackgroundTasksProps,
  renderBackgroundTasksToggle,
  type BackgroundTasksProps,
} from "./components/chat-background-tasks.ts";
import { chatAttachmentFromDataUrl } from "./components/chat-composer.ts";
import { renderChatControls } from "./components/chat-controls.ts";
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
  type SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
import {
  CHAT_COMPOSER_DRAFT_STORAGE_ERROR,
  loadChatComposerSnapshot,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "./composer-persistence.ts";
import { exportChatMarkdown } from "./export.ts";
import {
  hasAbortableSessionRun,
  reconcileStaleChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";
import { configureToolTitleFetcher } from "./tool-titles.ts";

type ChatPageContext = ApplicationContext;
type PaneSessionChangeOptions = { replace?: boolean };
type ChatHistoryAnchor = {
  sessionKey: string;
  scrollHeight: number;
  scrollTop: number;
};

const CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS = 500;

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

function catalogMessageId(message: unknown): string | null {
  const messageId = catalogRawRecord(message)?.messageId;
  return typeof messageId === "string" && messageId ? messageId : null;
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
  "Start a new session after the active run or queued messages finish.";
const NEW_SESSION_LIST_LOADING_MESSAGE =
  "Session list is still refreshing. Try New Chat again in a moment.";
const NEW_SESSION_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new session. Try again in a moment.";

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
  /** Split mode renders an in-pane header row (title + workspace/split/close
   * controls); classic single-pane mode renders none. */
  @property({ attribute: false }) showPaneHeader = false;
  @property({ attribute: false }) paneTitle = "";
  @property({ attribute: false }) narrow = false;
  @property({ attribute: false }) onOpenSplitView?: () => void;
  @property({ attribute: false }) onSplitDown?: (paneId: string) => void;
  @property({ attribute: false }) onSplitRight?: (paneId: string) => void;
  @property({ attribute: false }) onClosePane?: (paneId: string) => void;

  private readonly chatState = new ChatStateController<ChatPageHost>(this);
  private state: ChatPageHost | undefined;
  /* Infinity until the first ResizeObserver tick so an unmeasured pane keeps
   * the wide side-by-side layout instead of flashing the stacked one. */
  @litState() private paneWidth = Number.POSITIVE_INFINITY;
  private paneResizeObserver: ResizeObserver | null = null;
  private connectedClient: GatewayBrowserClient | null = null;
  private connectionGeneration = 0;
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
  private historyObserverArmed = false;
  private historyAutoLoadBlocked = false;
  private pendingHistoryAnchor: ChatHistoryAnchor | null = null;
  private nativePaginationSnapshot: ChatHistoryPagination | null = null;
  private nativeHistoryExpanded = false;
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
    if (
      !state?.connected ||
      !row ||
      !this.unreadPatchGuard.shouldPatch(state.sessionKey, row.unread)
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
    void refreshChatAvatar(state);
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

  private catalogItemMessage(
    item: SessionCatalogTranscriptItem,
    index: number,
  ): Record<string, unknown> | null {
    const timestamp = item.timestamp ? Date.parse(item.timestamp) : Date.now() + index;
    const text = item.text?.trim() ? item.text : null;
    if (item.type === "userMessage") {
      return text ? { role: "user", content: text, timestamp, messageId: item.id } : null;
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
      timestamp,
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
        .map((item, index) => this.catalogItemMessage(item, index))
        .filter((message) => message !== null);
      const nextMessages = older ? this.prependUniqueCatalogMessages(messages) : messages;
      const grew = nextMessages.length > this.catalogMessages.length;
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
      this.pendingHistoryAnchor =
        older && grew ? this.currentHistoryAnchor(state.sessionKey) : null;
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
      this.nativeHistoryExpanded = !pagination.hasMore && pagination.completeSnapshot === true;
    }
    return pagination.hasMore && !state.chatLoading;
  }

  private resetOlderMessagesViewport(): void {
    this.olderLoadGeneration += 1;
    this.loadingOlder = false;
    this.historyObserverArmed = false;
    this.historyAutoLoadBlocked = false;
    this.pendingHistoryAnchor = null;
    this.olderCursorsSeen.clear();
    this.olderOffsetsSeen.clear();
    this.nativePaginationSnapshot = null;
    this.nativeHistoryExpanded = false;
    this.historyObserver?.disconnect();
    this.historyObserver = null;
  }

  private restoreHistoryAnchor(): void {
    const anchor = this.pendingHistoryAnchor;
    if (!anchor) {
      return;
    }
    this.pendingHistoryAnchor = null;
    const state = this.state;
    const thread = this.querySelector<HTMLElement>(".chat-thread");
    if (!state || !thread || state.sessionKey !== anchor.sessionKey) {
      return;
    }
    thread.scrollTop = anchor.scrollTop + (thread.scrollHeight - anchor.scrollHeight);
  }

  private currentHistoryAnchor(sessionKey: string): ChatHistoryAnchor | null {
    const thread = this.querySelector<HTMLElement>(".chat-thread");
    return thread
      ? { sessionKey, scrollHeight: thread.scrollHeight, scrollTop: thread.scrollTop }
      : null;
  }

  private syncHistoryObserver(): void {
    this.historyObserver?.disconnect();
    this.historyObserver = null;
    const catalogSession = Boolean(this.state && parseCatalogSessionKey(this.state.sessionKey));
    const historyLoading = catalogSession ? this.catalogLoading : this.state?.chatLoading;
    if (historyLoading) {
      this.historyObserverArmed = false;
      if (this.loadingOlder) {
        this.olderLoadGeneration += 1;
        this.loadingOlder = false;
        this.pendingHistoryAnchor = null;
      }
    }
    if (
      typeof IntersectionObserver !== "function" ||
      this.historyAutoLoadBlocked ||
      this.loadingOlder ||
      !this.hasOlderMessages()
    ) {
      return;
    }
    const root = this.querySelector<HTMLElement>(".chat-thread");
    const sentinel = root?.querySelector<HTMLElement>(".chat-history-sentinel") ?? null;
    if (!root || !sentinel) {
      return;
    }
    if (!this.historyObserverArmed) {
      this.historyObserverArmed = root.scrollHeight <= root.clientHeight;
    }
    if (!this.historyObserverArmed) {
      return;
    }
    this.historyObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void this.loadOlderMessages();
        }
      },
      { root, rootMargin: "300px 0px 0px", threshold: 0 },
    );
    this.historyObserver.observe(sentinel);
  }

  private handleTranscriptScroll(event: Event): void {
    // A failed intersecting request stays disarmed until the user scrolls again,
    // preventing a tight retry loop without permanently stranding older history.
    if (this.historyAutoLoadBlocked) {
      this.historyAutoLoadBlocked = false;
      this.syncHistoryObserver();
    } else if (!this.historyObserverArmed) {
      this.historyObserverArmed = true;
      this.syncHistoryObserver();
    }
    // Preserve the normal at-bottom/new-message bookkeeping while layering
    // history-sentinel arming onto the same scroll event.
    this.state?.handleChatScroll(event);
  }

  private async loadOlderMessages(): Promise<void> {
    const state = this.state;
    const catalogKey = state ? parseCatalogSessionKey(state.sessionKey) : null;
    if (!state || this.loadingOlder || !this.hasOlderMessages()) {
      return;
    }
    const generation = ++this.olderLoadGeneration;
    this.historyAutoLoadBlocked = false;
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
        // Native scroll-back must render the loaded prefix together with the old
        // viewport; the default tail-only DOM cap would hide every prepended page.
        this.nativeHistoryExpanded ||= grew;
        this.pendingHistoryAnchor = grew ? this.currentHistoryAnchor(state.sessionKey) : null;
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
          this.pendingHistoryAnchor = null;
          this.historyAutoLoadBlocked = this.hasOlderMessages();
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

  private readonly createSession = async (): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected) {
      return false;
    }
    const context = this.context;
    const sessions = context.sessions;
    const client = state.client;
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

    state.lastError = null;
    state.chatError = null;
    const previousSessionKey = state.sessionKey;
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
    const pageState = createPageState(this.context, chatState.createRenderLifecycle(), this);
    pageState.createChatSession = async () => {
      await this.createSession();
    };
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
      this.setPaneSessionKey(this.sessionKey);
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
    chatState.addCleanup(
      this.context.gateway.subscribe((snapshot) => {
        this.applyGatewaySnapshot(snapshot);
      }),
    );
    chatState.addCleanup(
      this.context.gateway.subscribeEvents((event) => {
        const state = this.state;
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
    this.restoreHistoryAnchor();
    this.syncHistoryObserver();
  }

  override disconnectedCallback() {
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
    this.announceCommandPaletteTarget(null);
    resetChatViewState(this.paneId);
    this.state = undefined;
    this.connectedClient = null;
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
    const selectedSession = stateValue.result?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, state.sessionKey),
    );
    if (selectedSession) {
      state.selectedChatSessionArchived = selectedSession.archived === true;
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
    if (!reconciledLocalCompletion) {
      state.requestUpdate?.();
    }
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
      this.resetOlderMessagesViewport();
      state.chatLoading = false;
    }
    state.client = snapshot.client;
    state.connected = snapshot.connected;
    state.connectionEpoch = this.connectionGeneration;
    state.hello = snapshot.hello;
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
      return;
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
      state.realtimeTalkSession?.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
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
    state.requestUpdate?.();
  }

  private renderPaneHeader(
    sessionWorkspace: SessionWorkspaceProps,
    backgroundTasks: BackgroundTasksProps,
  ) {
    return html`
      <div
        class="chat-pane__header ${this.active ? "chat-pane__header--active" : ""}"
        @mousedown=${beginNativeWindowDrag}
      >
        <!-- Static text on purpose: an interactive session picker here would
             fight pane focus. Panes change sessions via the sidebar or
             drag-and-drop. -->
        <span class="chat-pane__session-title" title=${this.paneTitle}>${this.paneTitle}</span>
        <div class="chat-pane__actions">
          ${renderSessionDiffToggle(sessionWorkspace)}
          ${renderBackgroundTasksToggle(backgroundTasks)}
          ${renderSessionWorkspaceToggle(sessionWorkspace)}
          ${!this.narrow
            ? html`
                <openclaw-tooltip .content=${t("chat.splitView.splitDown")}>
                  <button
                    class="btn btn--ghost btn--icon chat-icon-btn"
                    type="button"
                    aria-label=${t("chat.splitView.splitDown")}
                    @click=${() => this.onSplitDown?.(this.paneId)}
                  >
                    ${icons.panelBottomOpen}
                  </button>
                </openclaw-tooltip>
                <openclaw-tooltip .content=${t("chat.splitView.splitRight")}>
                  <button
                    class="btn btn--ghost btn--icon chat-icon-btn"
                    type="button"
                    aria-label=${t("chat.splitView.splitRight")}
                    @click=${() => this.onSplitRight?.(this.paneId)}
                  >
                    ${icons.panelRightOpen}
                  </button>
                </openclaw-tooltip>
              `
            : nothing}
          <openclaw-tooltip .content=${t("chat.splitView.closePane")}>
            <button
              class="btn btn--ghost btn--icon chat-icon-btn"
              type="button"
              aria-label=${t("chat.splitView.closePane")}
              @click=${() => this.onClosePane?.(this.paneId)}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        </div>
      </div>
    `;
  }

  override render() {
    const state = this.state;
    if (!state) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const currentAgentId = resolveChatAgentId(state);
    const catalogKey = parseCatalogSessionKey(state.sessionKey);
    // Tool rows consult the global title store while rendering; point its
    // fetcher at this pane's connection. Requests capture session + agent at
    // schedule time, so later renders of other panes cannot re-route them.
    configureToolTitleFetcher({
      client: state.connected ? state.client : null,
      sessionKey: catalogKey ? null : state.sessionKey || null,
      agentId: currentAgentId || null,
      onTitlesChanged: () => state.requestUpdate?.(),
    });
    const agentDefaultModel = this.context.agents.state.agentsList?.agents.find(
      (agent) => agent.id === currentAgentId,
    )?.model?.primary;
    const selectedSession = state.sessionsResult?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, state.sessionKey),
    );
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
    const sessionWorkspace = createSessionWorkspaceProps(state, {
      draftScope: this.paneId,
      narrowLayout: this.paneWidth < WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH,
    });
    const railSideDocked =
      !sessionWorkspace.collapsed &&
      !sessionWorkspace.narrowLayout &&
      sessionWorkspace.dock !== "bottom";
    // The workspace rail claims the side slot first; the tasks rail needs
    // room for both columns before it may side-dock next to it.
    const backgroundTasks = createBackgroundTasksProps(state, {
      narrowLayout:
        this.paneWidth <
        WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH + (railSideDocked ? WORKSPACE_RAIL_MAX_WIDTH : 0),
      onOpenSession: (sessionKey) => {
        this.onPaneSessionChange?.(this.paneId, sessionKey);
      },
    });
    const tasksSideDocked = !backgroundTasks.collapsed && !backgroundTasks.narrowLayout;
    // Every side-docked rail narrows the room left for the chat + detail
    // split; bottom strips do not.
    const sideRailCount = (railSideDocked ? 1 : 0) + (tasksSideDocked ? 1 : 0);
    const detailSplitWidth = this.paneWidth - sideRailCount * WORKSPACE_RAIL_MAX_WIDTH;
    const props: ChatProps = {
      paneId: this.paneId,
      sessionKey: state.sessionKey,
      onSessionKeyChange: (next) => {
        this.onPaneSessionChange?.(this.paneId, next);
      },
      thinkingLevel: state.chatThinkingLevel,
      autoExpandToolCalls: state.chatVerboseLevel === "full",
      showThinking: state.settings.chatShowThinking,
      showToolCalls: state.settings.chatShowToolCalls,
      loading: catalogKey ? this.catalogLoading : state.chatLoading,
      sending: state.chatSending,
      canAbort: hasAbortableSessionRun(state),
      runStatus: state.chatRunStatus,
      compactionStatus: state.compactionStatus,
      fallbackStatus: state.fallbackStatus,
      messages: catalogKey ? this.catalogMessages : state.chatMessages,
      renderAllLoadedHistory:
        !catalogKey &&
        (this.nativeHistoryExpanded ||
          (state.chatHistoryPagination?.hasMore === false &&
            state.chatHistoryPagination.completeSnapshot === true)),
      historyPagination:
        catalogKey || state.chatHistoryPagination?.hasMore || this.loadingOlder
          ? {
              loading: this.loadingOlder,
              // Also surface the button when auto-load is blocked after a failure: a
              // non-scrollable (short) thread can never emit the scroll event that
              // re-arms the observer, so the button is the only retry path.
              manualFallback:
                this.hasOlderMessages() &&
                (typeof IntersectionObserver !== "function" || this.historyAutoLoadBlocked),
              onLoadOlder: () => void this.loadOlderMessages(),
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
      draft: state.chatMessage,
      queue: state.chatQueue,
      realtimeTalkActive: state.realtimeTalkActive,
      realtimeTalkStatus: state.realtimeTalkStatus,
      realtimeTalkDetail: state.realtimeTalkDetail,
      realtimeTalkInputLevel: state.realtimeTalkInputLevel,
      realtimeTalkConversation: state.realtimeTalkConversation,
      connected: state.connected,
      canSend: catalogKey ? this.catalogSession?.canContinue === true : !selectedSessionArchived,
      disabledReason: catalogDisabledReason ?? disabledReason,
      error: state.lastError,
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
      paneHeaderActive: this.showPaneHeader,
      onOpenSplitView: this.onOpenSplitView,
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
        void refreshPageChat(state, { awaitHistory: true, scheduleScroll: false });
      },
      onChatScroll: (event) => this.handleTranscriptScroll(event),
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
      onDismissError: () => {
        dismissChatError(state as never);
        state.requestUpdate?.();
      },
      onDismissRealtimeTalkError: () => {
        dismissRealtimeTalkError(state as never);
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
      onOpenSidebar: state.handleOpenSidebar,
      onCloseSidebar: state.handleCloseSidebar,
      onSplitRatioChange: state.handleSplitRatioChange,
      assistantName: state.assistantName,
      assistantAvatar: state.assistantAvatar,
      userName: state.userName,
      userAvatar: state.userAvatar,
      localMediaPreviewRoots: state.localMediaPreviewRoots,
      embedSandboxMode: state.embedSandboxMode,
      allowExternalEmbedUrls: state.allowExternalEmbedUrls,
      chatMessageMaxWidth: state.chatMessageMaxWidth,
      assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state as never),
      onAssistantAttachmentLoaded: () => state.scrollToBottom(),
      basePath: state.basePath,
    };
    if (!this.showPaneHeader) {
      return renderChat(props);
    }
    return html`${this.renderPaneHeader(sessionWorkspace, backgroundTasks)}${renderChat(props)}`;
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
