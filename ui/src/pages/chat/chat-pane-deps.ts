export { consume } from "@lit/context";
export { asNullableRecord as catalogRawRecord } from "@openclaw/normalization-core/record-coerce";
export { html, nothing } from "lit";
export { property, state as litState } from "lit/decorators.js";
export {
  GATEWAY_SERVER_CAPS,
  type SessionCatalogHost,
  type SessionCatalogPullRequestSummary,
  type SessionCatalogSession,
  type SessionCatalogTranscriptItem,
  type SessionDiscussionInfo,
  type SessionDiscussionState,
  type SessionObserverDigest,
  type SessionSharingRole,
  type SessionSuggestion,
  type SessionSuggestionEvent,
  type SessionSuggestionResolution,
  type SessionSuggestionsListResult,
  type SessionTypingEvent,
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
export type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
} from "../../../../src/gateway/control-ui-contract.js";
export { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
export type {
  GatewaySessionRow,
  SessionMembersListResult,
  SessionVisibility,
} from "../../api/types.ts";
export { findInlineApproval } from "../../app/approval-presentation.ts";
export {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
export {
  hasOperatorAdminAccess,
  hasOperatorApprovalsAccess,
  hasOperatorWriteAccess,
} from "../../app/operator-access.ts";
export {
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
export { loadSettings, patchSettings } from "../../app/settings.ts";
export {
  readPresenceEntries,
  resolveCurrentSelfUser,
  type PresencePayload,
} from "../../app/user-profile.ts";
export {
  BROWSER_ANNOTATION_EVENT,
  type BrowserAnnotationDraft,
} from "../../components/browser/browser-annotation.ts";
export {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPaletteTargetDetail,
} from "../../components/command-palette-contract.ts";
import "../../components/modal-dialog.ts";
export { createDockPanelLayout } from "../../components/dock-panel-layout.ts";
export { icons } from "../../components/icons.ts";
export { listSessionCreators } from "../../components/session-owner-chip.ts";
export { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
export {
  hasMultiplePresenceIdentities,
  hasSessionPresenceViewers,
} from "../../components/viewer-facepile.ts";
export { t } from "../../i18n/index.ts";
export { resolveBoardChatLayoutWidth } from "../../lib/board/chat-layout.ts";
export {
  acquireBoardProviderForSession,
  boardProviderCacheKey,
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
  type BoardProviderLease,
  type BoardViewCallbacks,
} from "../../lib/board/provider.ts";
export {
  updateBoardSessionView,
  type BoardFace,
  type BoardSessionView,
} from "../../lib/board/settings.ts";
export type { SwarmRosterHydrator } from "../../lib/board/swarm-dashboard.ts";
export type { BoardSnapshot, BoardTab } from "../../lib/board/types.ts";
export type { BoardViewSnapshot } from "../../lib/board/view-types.ts";
export {
  resolveControlUiFollowUpMode,
  resolveControlUiServerQueueMode,
} from "../../lib/chat/follow-up-mode.ts";
export { retirePendingChatSideQuestion } from "../../lib/chat/side-result.ts";
export { copyToClipboard } from "../../lib/clipboard.ts";
export { clampText } from "../../lib/format.ts";
export {
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
} from "../../lib/gateway-methods.ts";
export {
  ObserverDigestHistory,
  pickFreshestObserverDigest,
  resolveChatPaneObserverRunId,
} from "../../lib/observer-digest.ts";
export { isWorkboardEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
export { resolveSessionDisplayName } from "../../lib/session-display.ts";
export {
  announceCatalogSessionContinued,
  buildCatalogSessionKey,
  lookupCatalogSession,
  parseCatalogSessionKey,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
export {
  resolveSessionKey,
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "../../lib/sessions/index.ts";
export {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
export { SessionUnreadPatchGuard } from "../../lib/sessions/unread.ts";
export { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
export { PollController } from "../../lit/poll-controller.ts";
export { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
export {
  ensureBoardViewElement,
  ensureWorkboardCardChipElement,
  renderBoardDockMenu,
  renderBoardFaceToggle,
  renderBoardSessionSurface,
  type BoardChatDockSize,
  type WorkboardCardChipProps,
} from "./board-session-surface.ts";
export { catalogMessageId } from "./catalog-message-id.ts";
export { refreshChatAvatar } from "./chat-avatar.ts";
export type { ChatHistoryPagination } from "./chat-history-pagination.ts";
export {
  applyChatAgentsList,
  clearChatHistory,
  loadChatHistory,
  loadOlderChatHistoryPage,
  rewindChatHistory,
  resolveChatHistoryPagination,
  switchChatHistoryBranch,
  syncSelectedSessionMessageSubscription,
} from "./chat-history.ts";
export { requestSessionObserverAnswer, sendSessionObserverVisibility } from "./chat-observer.ts";
export {
  applySelectedSessionProjection,
  dismissChatError,
  resolveAssistantAttachmentAuthToken,
  SessionParticipationTracker,
} from "./chat-pane-state.ts";
export { markQueuedChatSendsWaitingForReconnect } from "./chat-queue.ts";
export { dismissRealtimeTalkError } from "./chat-realtime.ts";
export { activeChatRunStartupStatus } from "./chat-run-startup.ts";
export { flushChatQueueForEvent, retryReconnectableQueuedChatSends } from "./chat-send-actions.ts";
export {
  flushChatQueueAfterIdleSessionReconciliation,
  switchChatFastMode,
  switchChatModel,
  switchChatThinkingLevel,
} from "./chat-session.ts";
export {
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
export { resetChatViewState } from "./chat-view-state.ts";
export { renderChat, type ChatProps } from "./chat-view.ts";
export { renderCatalogTerminalButton } from "./components/catalog-terminal-button.ts";
export { chatAttachmentFromDataUrl } from "./components/chat-attachments.ts";
export {
  createBackgroundTasksProps,
  renderBackgroundTasksToggle,
  type BackgroundTasksProps,
} from "./components/chat-background-tasks.ts";
export { isChatRunWorking } from "./components/chat-composer.ts";
export { renderChatControls } from "./components/chat-controls.ts";
export { dismissConfirmedActionPopovers } from "./components/chat-message.ts";
export {
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  resolveChatPaneWorkspace,
  type ChatPaneHeaderAction,
} from "./components/chat-pane-header.ts";
export {
  chatPullRequestId,
  createPullRequestBranch,
  dismissChatPullRequest,
  listDismissedChatPullRequests,
} from "./components/chat-pull-requests.ts";
export { renderChatResizableDivider } from "./components/chat-resizable-divider.ts";
export {
  renderChatSessionSharing,
  type ChatSessionSharingState,
} from "./components/chat-session-sharing.ts";
export {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  renderSessionDiffToggle,
  renderSessionWorkspaceToggle,
  revealSessionWorkspaceFile,
  toggleSessionWorkspace,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
export {
  CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS,
  type DetailFullMessageResult,
  type SidebarContent,
  type SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
export {
  ChatTranscriptController,
  resetChatThreadPresentationState,
} from "./components/chat-thread.ts";
export { WIDGET_PROMPT_EVENT, type WidgetPromptEventDetail } from "./components/chat-tool-cards.ts";
export {
  CHAT_COMPOSER_DRAFT_STORAGE_ERROR,
  loadChatComposerSnapshot,
  persistChatComposerState,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "./composer-persistence.ts";
export { exportChatMarkdown } from "./export.ts";
export { admitInitialUserMessageHandoff } from "./initial-turn-handoff.ts";
export {
  hasAbortableSessionRun,
  reconcileStaleChatRunAfterSessionStatePublication,
  replayPendingChatAbort,
} from "./run-lifecycle.ts";
export { scheduleChatScroll } from "./scroll.ts";
export {
  clearChatMessagesFromCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";
export {
  reconcileWaitingApprovalsFromSnapshot,
  resolveActiveRunOutputTokens,
} from "./tool-stream.ts";
export { configureToolTitleFetcher } from "./tool-titles.ts";
export { workspaceResultConflictFromPlacement } from "./workspace-conflict.ts";
