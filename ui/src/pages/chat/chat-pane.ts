import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state as litState } from "lit/decorators.js";
import type {
  TaskSuggestion,
  TaskSuggestionEvent,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
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
} from "../../components/command-palette.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { retirePendingChatSideQuestion } from "../../lib/chat/side-result.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
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
import { refreshChatAvatar } from "./chat-avatar.ts";
import {
  applyChatAgentsList,
  clearChatHistory,
  loadChatHistory,
  syncSelectedSessionMessageSubscription,
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
  handleChatManualRefresh,
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
type ChatPaneConnectionScope = {
  context: ChatPageContext;
  state: ChatPageHost;
  client: GatewayBrowserClient;
  generation: number;
  sessions: ChatPageContext["sessions"];
};

const CHAT_OPEN_DETAILS_SELECTOR =
  ".chat-controls__inline-select[open], .context-usage details[open], .agent-chat__talk-select[open], .agent-chat__attach-menu[open], .chat-pr__checks[open]";
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
  private sessionPullRequestsRateLimited = false;
  private sessionPullRequestsRequestVersion = 0;
  private sessionPullRequestsExpanded = false;
  private dismissedSessionPullRequestIds: ReadonlySet<string> = new Set();

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
      this.sessionPullRequestsRateLimited = false;
      this.requestUpdate();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    if (!sessionKey.trim()) {
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
    const nextSessionKey = resolveSessionKey(sessionKey, this.context.gateway.snapshot.hello);
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
    if (!state || !this.active || !this.sessionKey.trim()) {
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
    this.taskSuggestions = [];
    this.taskSuggestionBusyIds.clear();
    this.taskSuggestionOperations.clear();
    this.resetSessionPullRequests();
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
    if (!state.chatMobileControlsOpen) {
      return;
    }
    event.preventDefault();
    state.setChatMobileControlsOpen(false, { restoreFocus: true });
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
    if (!state.chatMobileControlsOpen) {
      return;
    }
    const wrapper =
      this.querySelector(".chat-settings-popover-wrapper") ??
      this.querySelector(".chat-mobile-controls-wrapper");
    if (wrapper && path.includes(wrapper)) {
      return;
    }
    state.setChatMobileControlsOpen(false);
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
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (mediaDevices?.addEventListener) {
      const handleDeviceChange = () => void pageState.refreshRealtimeTalkInputs();
      mediaDevices.addEventListener("devicechange", handleDeviceChange);
      chatState.addCleanup(() =>
        mediaDevices.removeEventListener("devicechange", handleDeviceChange),
      );
    }
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
    // PRs open, merge, and finish CI outside any gateway event stream, so the
    // chip row refreshes on a coarse timer between session/connect refreshes.
    const pullRequestTimer = window.setInterval(
      () => void this.refreshSessionPullRequests(),
      60_000,
    );
    chatState.addCleanup(() => window.clearInterval(pullRequestTimer));
    chatState.addCleanup(
      this.context.gateway.subscribeEvents((event) => {
        const state = this.state;
        if (state) {
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
      const nextSessionKey = resolveSessionKey(
        this.sessionKey,
        this.context.gateway.snapshot.hello,
      );
      if (nextSessionKey && nextSessionKey !== this.state.sessionKey) {
        this.switchPaneSession(nextSessionKey);
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

  override disconnectedCallback() {
    this.paneResizeObserver?.disconnect();
    this.paneResizeObserver = null;
    this.connectionGeneration += 1;
    this.taskSuggestionsRequestVersion += 1;
    this.taskSuggestions = [];
    this.taskSuggestionBusyIds.clear();
    this.taskSuggestionOperations.clear();
    this.resetSessionPullRequests();
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
    const canonicalRouteSessionKey = routeSessionKey
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
    // Tool rows consult the global title store while rendering; point its
    // fetcher at this pane's connection. Requests capture session + agent at
    // schedule time, so later renders of other panes cannot re-route them.
    configureToolTitleFetcher({
      client: state.connected ? state.client : null,
      sessionKey: state.sessionKey || null,
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
    const canOpenRealtimeTalkSettings = hasOperatorAdminAccess(
      this.context.gateway.snapshot.hello?.auth ?? null,
    );
    const sessionWorkspace = createSessionWorkspaceProps(state, {
      narrowLayout: this.paneWidth < WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH,
    });
    const backgroundTasks = createBackgroundTasksProps(state, {
      onOpenSession: (sessionKey) => {
        this.onPaneSessionChange?.(this.paneId, sessionKey);
      },
    });
    const railSideDocked =
      !sessionWorkspace.collapsed &&
      !sessionWorkspace.narrowLayout &&
      sessionWorkspace.dock !== "bottom";
    // Every open side rail (workspace and/or background tasks) narrows the
    // room left for the chat + detail split.
    const sideRailCount = (railSideDocked ? 1 : 0) + (backgroundTasks.collapsed ? 0 : 1);
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
      loading: state.chatLoading,
      sending: state.chatSending,
      canAbort: hasAbortableSessionRun(state),
      runStatus: state.chatRunStatus,
      compactionStatus: state.compactionStatus,
      fallbackStatus: state.fallbackStatus,
      messages: state.chatMessages,
      sideResult: state.chatSideResult,
      sideResultPending: state.chatSideResultPending,
      toolMessages: state.chatToolMessages,
      streamSegments: state.chatStreamSegments,
      stream: state.chatStream,
      streamStartedAt: state.chatStreamStartedAt,
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
      canSend: !selectedSessionArchived,
      disabledReason,
      error: state.lastError,
      sessions: state.sessionsResult,
      sessionHost: { agentsList: state.agentsList, hello: state.hello },
      providerUsage: {
        basePath: state.basePath,
        modelAuthStatusResult: state.modelAuthStatusResult,
      },
      composerControls: renderChatControls({
        paneId: this.paneId,
        agentsList: state.agentsList,
        connected: state.connected,
        hideCronSessions: state.sessionsHideCron,
        loading: state.chatLoading,
        manualRefreshInFlight: state.chatManualRefreshInFlight,
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
          onModelSelect: (next, targetSessionKey) => switchChatModel(state, next, targetSessionKey),
          onThinkingSelect: (next, targetSessionKey) =>
            switchChatThinkingLevel(state, next, targetSessionKey),
        },
        onboarding: state.onboarding,
        runId: state.chatRunId,
        sending: state.chatSending,
        settings: state.settings,
        settingsOpen: state.chatMobileControlsOpen,
        sessionKey: state.sessionKey,
        sessionsResult: state.sessionsResult,
        stream: state.chatStream,
        realtimeTalkOptions: state.realtimeTalkOptions,
        realtimeTalkInputDevices: state.realtimeTalkInputDevices,
        realtimeTalkInputDeviceId: state.realtimeTalkInputDeviceId,
        realtimeTalkInputLoading: state.realtimeTalkInputLoading,
        realtimeTalkInputError: state.realtimeTalkInputError,
        canOpenRealtimeTalkSettings,
        onRefresh: () => handleChatManualRefresh(state),
        onRealtimeTalkInputRefresh: () => void state.refreshRealtimeTalkInputs(true),
        onRealtimeTalkInputSelect: state.selectRealtimeTalkInput,
        onRealtimeTalkOptionsChange: state.updateRealtimeTalkOptions,
        onOpenRealtimeTalkSettings: () => {
          if (!canOpenRealtimeTalkSettings) {
            return;
          }
          this.context.navigate("communications", { search: "?section=talk" });
        },
        onSettingsChange: state.applySettings,
        onSettingsOpenChange: (open, options) => {
          state.setChatMobileControlsOpen(open, options);
          if (open) {
            void state.refreshRealtimeTalkInputs(false);
          }
        },
        onToggleCronSessions: () => {
          state.sessionsHideCron = !state.sessionsHideCron;
          state.requestUpdate?.();
        },
      }),
      sessionWorkspace,
      backgroundTasks,
      paneHeaderActive: this.showPaneHeader,
      onOpenSplitView: this.onOpenSplitView,
      taskSuggestions: this.taskSuggestions,
      pullRequests: this.sessionPullRequests.filter(
        (pullRequest) => !this.dismissedSessionPullRequestIds.has(chatPullRequestId(pullRequest)),
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
        state.chatSideResult = null;
        retirePendingChatSideQuestion(state);
        state.resetToolStream();
        void refreshPageChat(state, { awaitHistory: true, scheduleScroll: false });
      },
      onChatScroll: state.handleChatScroll,
      getDraft: () => state.chatMessage,
      onDraftChange: state.handleChatDraftChange,
      onRequestUpdate: state.requestUpdate,
      onHistoryKeydown: state.handleChatInputHistoryKey,
      onSlashIntent: () => refreshChatCommands(state),
      showNewMessages: state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
      onScrollToBottom: state.scrollToBottom,
      attachments: state.chatAttachments,
      onAttachmentsChange: (next) => {
        state.chatAttachments = next;
        state.requestUpdate?.();
      },
      onSend: () => void state.handleSendChat(),
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
      onSideQuestion: (command) => void state.handleSendChat(command),
      onDismissSideResult: () => {
        state.chatSideResult = null;
        // Retire (not just clear) so a dismissed question's still-running
        // detached run cannot leak its late reply into the transcript.
        retirePendingChatSideQuestion(state);
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
      onLoadSidebarFullMessage: async (
        request: SidebarFullMessageRequest,
      ): Promise<DetailFullMessageResult | null> => {
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
