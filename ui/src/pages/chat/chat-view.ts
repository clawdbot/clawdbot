// Control UI view renders chat screen composition.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import type {
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
  TaskSuggestion,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
  SessionObserverDigest,
  SessionsObserverAskResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type { ChatSendShortcut } from "../../app/settings.ts";
import { renderExecApprovalCard } from "../../components/exec-approval-card.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import type { ChatSideResult, ChatSideResultPending } from "../../lib/chat/side-result.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import type { ProviderUsageDisplayProps } from "../../lib/provider-quota-summary.ts";
import type { UiSessionDefaultsHost } from "../../lib/sessions/session-key.ts";
import type { ChatRunStartupStatus } from "./chat-run-startup.ts";
import { renderChatViewNotices } from "./chat-view-notices.ts";
import { createChatAttachmentDropHandlers } from "./components/chat-attachments.ts";
import {
  renderBackgroundTasksRail,
  type BackgroundTasksProps,
} from "./components/chat-background-tasks.ts";
import { isChatRunWorking, renderChatComposer } from "./components/chat-composer.ts";
import {
  inlineChatImageFromEvent,
  openInlineChatImage,
  renderChatImageLightbox,
} from "./components/chat-image-lightbox.ts";
import { renderChatPullRequests } from "./components/chat-pull-requests.ts";
import { renderChatResizableDivider } from "./components/chat-resizable-divider.ts";
import { renderChatSessionSuggestions } from "./components/chat-session-suggestions.ts";
import "./components/chat-sidebar.ts";
import {
  renderSessionWorkspaceRail,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import { isSideChatPanelVisible, renderSideChatPanel } from "./components/chat-side-chat.ts";
import type {
  DetailFullMessageResult,
  SidebarContent,
  SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
import { renderChatTaskSuggestions } from "./components/chat-task-suggestions.ts";
import {
  type ChatTranscriptController,
  isChatThreadSearchOpen,
  renderChatPinnedMessages,
  renderChatSearchBar,
  renderChatThread,
  toggleChatThreadSearch,
} from "./components/chat-thread.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./input-history.ts";
import type { RealtimeTalkConversationEntry } from "./realtime-talk-conversation.ts";
import type { RealtimeTalkCameraDevice } from "./realtime-talk-input.ts";
import type { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "./realtime-talk.ts";
import type { ChatRunUiStatus } from "./run-lifecycle.ts";
import type { CompactionStatus, FallbackStatus, PlanStatus } from "./tool-stream.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";
import "../../components/resizable-divider.ts";

type ChatReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};

export type ChatProps = {
  transcript: ChatTranscriptController;
  paneId: string;
  sessionKey: string;
  announceTranscript?: boolean;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  showToolCalls: boolean;
  persistCommentary?: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  startupStatus?: ChatRunStartupStatus | null;
  waitingApproval?: boolean;
  compactionStatus?: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  planStatus?: PlanStatus | null;
  observerDigest?: SessionObserverDigest | null;
  observerHudReady?: boolean;
  observerRunId?: string | null;
  observerStartedAt?: number;
  observerLastReadAt?: number;
  onObserverAsk?: (sessionKey: string, question: string) => Promise<SessionsObserverAskResult>;
  onObserverVisibilityChange?: (visible: boolean) => void;
  gatewayQuestionPrompts?: readonly QuestionPrompt[];
  onGatewayQuestionChange?: () => void;
  onGatewayQuestionSubmit?: (id: string, answers: Record<string, string[]>) => void | Promise<void>;
  onGatewayQuestionSkip?: (id: string) => void | Promise<void>;
  messages: unknown[];
  historyPagination?: { loading: boolean };
  sideChatTurns?: ChatSideResult[];
  sideChatPending?: ChatSideResultPending | null;
  sideChatHidden?: boolean;
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  runOutputTokens?: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  queuedOutboxCount?: number;
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: RealtimeTalkStatus;
  realtimeTalkDetail?: string | null;
  realtimeTalkInputLevel?: RealtimeTalkLevelSignal;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  realtimeTalkVideoStream?: MediaStream | null;
  realtimeTalkCameraDevices?: RealtimeTalkCameraDevice[];
  realtimeTalkVideoCapable?: boolean;
  realtimeTalkVideoPending?: boolean;
  realtimeTalkCameraError?: boolean;
  connected: boolean;
  offline?: boolean;
  gatewayClient?: GatewayBrowserClient | null;
  composerHoldToRecord?: boolean;
  suggestionComposer?: boolean;
  typingLabel?: string | null;
  onTypingChange?: (typing: boolean) => void;
  canSend: boolean;
  disabledReason: string | null;
  disabledBanner?: { text: string; actionLabel: string; onAction: () => void };
  error: string | null;
  runError?: { summary: string } | null;
  inlineApproval?: ExecApprovalRequest | null;
  approvalBusy?: boolean;
  approvalErrors?: ReadonlyMap<string, string>;
  approvalNowMs?: number;
  onApprovalDecision?: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
  workspaceConflict?: WorkspaceResultConflict;
  onDismissWorkspaceConflict?: () => void;
  sessions: SessionsListResult | null;
  /** Host context resolving global-alias session keys (scope=global fleets). */
  sessionHost?: UiSessionDefaultsHost | null;
  providerUsage?: ProviderUsageDisplayProps;
  focusMode?: boolean;
  onLoadSidebarFullMessage?: (
    request: SidebarFullMessageRequest,
  ) => Promise<DetailFullMessageResult | null | undefined>;
  sidebarOpen?: boolean;
  sidebarContent?: SidebarContent | null;
  /** Pane too narrow for side-by-side chat + detail panel: stack them
   * vertically instead (the divider flips to a horizontal handle). */
  sidebarStacked?: boolean;
  splitRatio?: number;
  canvasPluginSurfaceUrl?: string | null;
  boardProvider?: BoardProvider;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  chatMessageMaxWidth?: string | null;
  assistantName: string;
  sendShortcut?: ChatSendShortcut;
  followUpMode?: ControlUiFollowUpMode;
  assistantAvatar: string | null;
  userId?: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  autoExpandToolCalls?: boolean;
  attachments?: ChatAttachment[];
  getAttachments?: () => ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onAssistantAttachmentLoaded?: () => void;
  imageLightbox?: ImageLightboxItem | null;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
  onCloseImage?: () => void;
  showNewMessages?: boolean;
  onScrollToBottom?: (options?: { smooth?: boolean }) => void;
  onRefresh: () => void;
  onToggleFocusMode?: () => void;
  getDraft?: () => string;
  onDraftChange: (next: string) => void;
  onRequestUpdate?: () => void;
  onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
  onSlashIntent?: () => void | Promise<void>;
  onSend: () => void;
  onCompact?: () => void | Promise<void>;
  onOpenSessionCheckpoints?: () => void | Promise<void>;
  onToggleRealtimeTalk?: () => void;
  onToggleRealtimeCamera?: () => void;
  onSwitchRealtimeCamera?: () => void;
  onDismissError?: () => void;
  onDismissRealtimeTalkError?: () => void;
  onDictationError?: (message: string) => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onGoalCommand?: (command: string) => void;
  onHistoryIntent?: (event: Event) => void;
  /** Sends a detached /btw side question (selection popup or side-chat
   * follow-up). `displayQuestion` overrides the pending-turn display when the
   * command embeds carried follow-up context; `onSendRejected` lets the panel
   * restore its typed follow-up when the detached send is not accepted. */
  onSideQuestion?: (command: string, displayQuestion?: string, onSendRejected?: () => void) => void;
  /** Hides the side-chat panel; the conversation (and a pending run) survives. */
  onSideChatClose?: () => void;
  /** Discards the side-chat conversation and retires any pending run. */
  onSideChatClear?: () => void;
  onNewSession: () => void;
  onClearHistory?: () => void;
  agentsList: {
    agents: Array<{ id: string; name?: string; identity?: { name?: string; avatarUrl?: string } }>;
    defaultId?: string;
  } | null;
  currentAgentId: string;
  fullMessageAgentId?: string;
  onAgentChange: (agentId: string) => void;
  onNavigateToAgent?: () => void;
  onSessionSelect?: (sessionKey: string) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  onRevealWorkspaceFile?: (path: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
  basePath?: string;
  gatewayUrl?: string;
  composerControls?: TemplateResult | typeof nothing;
  replyTarget?: ChatReplyTarget | null;
  onClearReply?: () => void;
  onSetReply?: (target: ChatReplyTarget) => void;
  onRewindMessage?: (entryId: string) => Promise<boolean> | boolean;
  onForkMessage?: (entryId: string) => Promise<void> | void;
  sessionWorkspace?: SessionWorkspaceProps;
  backgroundTasks?: BackgroundTasksProps;
  taskSuggestions?: TaskSuggestion[];
  taskSuggestionBusyIds?: ReadonlySet<string>;
  canAcceptTaskSuggestions?: boolean;
  canDismissTaskSuggestions?: boolean;
  onAcceptTaskSuggestion?: (suggestion: TaskSuggestion) => void;
  onDismissTaskSuggestion?: (suggestion: TaskSuggestion) => void;
  sessionSuggestions?: readonly SessionSuggestion[];
  sessionSuggestionRole?: SessionSharingRole;
  sessionSuggestionBusyIds?: ReadonlySet<string>;
  sessionSuggestionsArchived?: boolean;
  canResolveSessionSuggestions?: boolean;
  onResolveSessionSuggestion?: (
    suggestion: SessionSuggestion,
    resolution: SessionSuggestionResolution,
  ) => void;
  pullRequests?: ControlUiSessionPullRequest[];
  pullRequestsBranch?: ControlUiSessionBranch;
  pullRequestsRateLimited?: boolean;
  pullRequestsExpanded?: boolean;
  onExpandPullRequests?: () => void;
  onDismissPullRequest?: (pullRequest: ControlUiSessionPullRequest) => void;
};

function isImageLightboxEvent(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (target) => target instanceof HTMLElement && target.localName === "openclaw-image-lightbox",
    );
}

export function renderChat(props: ChatProps) {
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const sidebarStacked = props.sidebarStacked === true;
  const workspaceCollapsed = props.sessionWorkspace?.collapsed !== false;
  const workspaceDockBottom = Boolean(
    props.sessionWorkspace &&
    (props.sessionWorkspace.dock === "bottom" || props.sessionWorkspace.narrowLayout),
  );
  const tasksOpen = props.backgroundTasks?.collapsed === false;
  const tasksDockBottom = tasksOpen && props.backgroundTasks?.narrowLayout === true;
  const canCompose = props.canSend;
  const sideChatProps = {
    turns: props.sideChatTurns ?? [],
    pending: props.sideChatPending ?? null,
    hidden: props.sideChatHidden === true,
  };
  const openImage = props.onOpenImage
    ? (item: ImageLightboxItem, requestVersion?: number) => {
        if (requestVersion === undefined) {
          props.onOpenImage?.(item);
        } else {
          props.onOpenImage?.(item, requestVersion);
        }
      }
    : undefined;
  const openImmediateImage = props.onOpenImage
    ? (item: ImageLightboxItem) => openImage?.(item, props.onRequestOpenImage?.())
    : undefined;
  const sideChatVisible = isSideChatPanelVisible(sideChatProps);
  const attachmentDropHandlers = createChatAttachmentDropHandlers({ ...props, canCompose });
  let chatSection: HTMLElement | null = null;
  const thread = renderChatThread(
    {
      paneId: props.paneId,
      sessionKey: props.sessionKey,
      announceTranscript: props.announceTranscript,
      loading: props.loading,
      historyPagination: props.historyPagination,
      messages: props.messages,
      toolMessages: props.toolMessages,
      streamSegments: props.streamSegments,
      stream: props.stream,
      streamStartedAt: props.streamStartedAt,
      runOutputTokens: props.runOutputTokens,
      queue: props.queue,
      showThinking: props.showThinking,
      showToolCalls: props.showToolCalls,
      persistCommentary: props.persistCommentary,
      runActive: Boolean(props.canAbort),
      runWorking: isChatRunWorking(props),
      startupStatus: props.startupStatus,
      waitingApproval: props.waitingApproval,
      planStatus: props.planStatus,
      questionPrompts: props.gatewayQuestionPrompts,
      sessions: props.sessions,
      sessionHost: props.sessionHost,
      gatewayUrl: props.gatewayUrl,
      boardProvider: props.boardProvider,
      assistantName: props.assistantName,
      assistantAvatar: props.assistantAvatar,
      assistantAvatarUrl: props.assistantAvatarUrl,
      userId: props.userId,
      userName: props.userName,
      userAvatar: props.userAvatar,
      basePath: props.basePath,
      fullMessageAgentId: props.fullMessageAgentId,
      localMediaPreviewRoots: props.localMediaPreviewRoots,
      assistantAttachmentAuthToken: props.assistantAttachmentAuthToken,
      canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
      embedSandboxMode: props.embedSandboxMode,
      allowExternalEmbedUrls: props.allowExternalEmbedUrls,
      autoExpandToolCalls: props.autoExpandToolCalls,
      realtimeTalkConversation: props.realtimeTalkConversation,
      onOpenSidebar: props.onOpenSidebar,
      onOpenWorkspaceFile: props.onOpenWorkspaceFile,
      onOpenSessionCheckpoints: props.onOpenSessionCheckpoints,
      onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
      onRequestOpenImage: props.onRequestOpenImage,
      onOpenImage: openImage,
      onRequestUpdate: requestUpdate,
      onChatScroll: props.onChatScroll,
      onHistoryIntent: props.onHistoryIntent,
      onDraftChange: props.onDraftChange,
      getDraft: props.getDraft,
      onSend: props.onSend,
      onSetReply: props.onSetReply,
      onRewindMessage: props.onRewindMessage,
      onForkMessage: props.onForkMessage,
      // Archived/non-composable sessions must not offer selection actions:
      // withholding the callback keeps the popup from rendering at all.
      onSideQuestion: props.canSend && !props.suggestionComposer ? props.onSideQuestion : undefined,
      onOpenSession: props.onSessionSelect,
      backgroundTasks: props.backgroundTasks,
      onFocusComposer: () =>
        chatSection
          ?.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
          ?.focus({ preventScroll: true }),
    },
    props.transcript,
  );

  const chatColumnFooter = renderChatComposer({
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    currentAgentId: props.currentAgentId,
    connected: props.connected,
    offline: props.offline,
    queuedOutboxCount: props.queuedOutboxCount,
    canSend: props.canSend,
    disabledReason: props.disabledReason,
    disabledBanner: props.disabledBanner,
    runError: props.runError,
    sending: props.sending,
    canAbort: props.canAbort,
    runStatus: props.runStatus,
    waitingApproval: props.waitingApproval,
    compactionStatus: props.compactionStatus,
    fallbackStatus: props.fallbackStatus,
    planStatus: props.planStatus,
    gatewayQuestionPrompts: props.gatewayQuestionPrompts,
    messages: props.messages,
    stream: props.stream,
    queue: props.queue,
    draft: props.draft,
    sessions: props.sessions,
    providerUsage: props.providerUsage,
    assistantName: props.assistantName,
    sendShortcut: props.sendShortcut,
    followUpMode: props.followUpMode,
    attachments: props.attachments,
    getAttachments: props.getAttachments,
    replyTarget: props.replyTarget,
    realtimeTalkActive: props.realtimeTalkActive,
    realtimeTalkStatus: props.realtimeTalkStatus,
    realtimeTalkDetail: props.realtimeTalkDetail,
    realtimeTalkInputLevel: props.realtimeTalkInputLevel,
    realtimeTalkConversation: props.realtimeTalkConversation,
    realtimeTalkVideoStream: props.realtimeTalkVideoStream,
    realtimeTalkCameraDevices: props.realtimeTalkCameraDevices,
    realtimeTalkVideoCapable: props.realtimeTalkVideoCapable,
    realtimeTalkVideoPending: props.realtimeTalkVideoPending,
    realtimeTalkCameraError: props.realtimeTalkCameraError,
    gatewayClient: props.gatewayClient,
    composerHoldToRecord: props.composerHoldToRecord,
    suggestionComposer: props.suggestionComposer,
    typingLabel: props.typingLabel,
    onTypingChange: props.onTypingChange,
    composerControls: props.composerControls,
    getDraft: props.getDraft,
    onDraftChange: props.onDraftChange,
    onRequestUpdate: requestUpdate,
    onHistoryKeydown: props.onHistoryKeydown,
    onSlashIntent: props.onSlashIntent,
    onSend: props.onSend,
    onCompact: props.suggestionComposer ? undefined : props.onCompact,
    onToggleRealtimeTalk: props.suggestionComposer ? undefined : props.onToggleRealtimeTalk,
    onToggleRealtimeCamera: props.onToggleRealtimeCamera,
    onSwitchRealtimeCamera: props.onSwitchRealtimeCamera,
    onDismissRealtimeTalkError: props.onDismissRealtimeTalkError,
    onDictationError: props.onDictationError,
    onAbort: props.onAbort,
    onQueueRemove: props.onQueueRemove,
    onQueueRetry: props.onQueueRetry,
    onQueueSteer: props.onQueueSteer,
    onGoalCommand: props.onGoalCommand,
    onGatewayQuestionChange: props.onGatewayQuestionChange,
    onGatewayQuestionSubmit: props.onGatewayQuestionSubmit,
    onGatewayQuestionSkip: props.onGatewayQuestionSkip,
    onNewSession: props.onNewSession,
    onClearReply: props.onClearReply,
    onAttachmentsChange: props.onAttachmentsChange,
  });
  const scrollToBottomButton =
    props.showNewMessages && props.onScrollToBottom
      ? html`
          <div class="chat-scroll-to-bottom-wrap">
            <button
              class="chat-scroll-to-bottom"
              type="button"
              @click=${() => props.onScrollToBottom?.({ smooth: true })}
              aria-label=${t("chat.actions.scrollToLatest")}
            >
              ${icons.arrowDown}
            </button>
          </div>
        `
      : nothing;

  return html`
    <section
      ${ref((element) => {
        chatSection = element instanceof HTMLElement ? element : null;
      })}
      class="card chat"
      style=${styleMap(
        props.chatMessageMaxWidth
          ? {
              "--chat-thread-max-width": props.chatMessageMaxWidth,
              "--chat-message-max-width": "100%",
            }
          : {},
      )}
      @drop=${attachmentDropHandlers.onDrop}
      @dragenter=${attachmentDropHandlers.onDragenter}
      @dragleave=${attachmentDropHandlers.onDragleave}
      @click=${(event: Event) => openInlineChatImage(event, openImmediateImage)}
      @dragover=${attachmentDropHandlers.onDragover}
      @keydown=${(event: KeyboardEvent) => {
        if (isImageLightboxEvent(event)) {
          return;
        }
        if ((event.key === "Enter" || event.key === " ") && inlineChatImageFromEvent(event)) {
          openInlineChatImage(event, openImmediateImage);
          return;
        }
        if (event.key === "Escape" && props.replyTarget && !event.defaultPrevented) {
          event.preventDefault();
          props.onClearReply?.();
          return;
        }
        if (event.key === "Escape" && sideChatVisible && !isChatThreadSearchOpen(props.paneId)) {
          event.preventDefault();
          props.onSideChatClose?.();
          return;
        }
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "f") {
          event.preventDefault();
          toggleChatThreadSearch(props.paneId, requestUpdate);
        }
      }}
    >
      ${renderChatViewNotices(props)} ${renderChatSearchBar(props.paneId, requestUpdate)}
      ${renderChatPinnedMessages(
        {
          paneId: props.paneId,
          sessionKey: props.sessionKey,
          messages: props.messages,
          userName: props.userName,
          userAvatar: props.userAvatar,
        },
        requestUpdate,
      )}
      <div
        class="chat-workbench ${workspaceCollapsed
          ? "chat-workbench--workspace-collapsed"
          : ""} ${workspaceDockBottom ? "chat-workbench--dock-bottom" : ""} ${tasksOpen &&
        !tasksDockBottom
          ? "chat-workbench--tasks-open"
          : ""} ${tasksDockBottom ? "chat-workbench--tasks-dock-bottom" : ""}"
      >
        ${renderSessionWorkspaceRail(props.sessionWorkspace)}
        ${renderBackgroundTasksRail(props.backgroundTasks)}
        ${props.sessionWorkspace?.dockDragging
          ? html`
              <div class="chat-workbench__dock-zones" aria-hidden="true">
                <div
                  class="chat-workbench__dock-zone chat-workbench__dock-zone--right ${props
                    .sessionWorkspace.dockDragZone === "right"
                    ? "chat-workbench__dock-zone--active"
                    : ""}"
                >
                  <span>${t("chat.workspaceFiles.dockRight")}</span>
                </div>
                <div
                  class="chat-workbench__dock-zone chat-workbench__dock-zone--bottom ${props
                    .sessionWorkspace.dockDragZone === "bottom"
                    ? "chat-workbench__dock-zone--active"
                    : ""}"
                >
                  <span>${t("chat.workspaceFiles.dockBottom")}</span>
                </div>
              </div>
            `
          : nothing}
        <div class="chat-workbench__main">
          <div
            class="chat-split-container ${sidebarOpen
              ? "chat-split-container--open"
              : ""} ${sidebarOpen && sidebarStacked ? "chat-split-container--stacked" : ""}"
          >
            <div
              class="chat-main"
              style="flex: ${sidebarOpen ? `0 1 ${splitRatio * 100}%` : "1 1 100%"}"
            >
              ${thread}
              ${props.inlineApproval && props.onApprovalDecision
                ? html`<div class="chat-inline-approval">
                    ${renderExecApprovalCard({
                      approval: props.inlineApproval,
                      busy: props.approvalBusy === true,
                      error: props.approvalErrors?.get(props.inlineApproval.id) ?? null,
                      nowMs: props.approvalNowMs ?? Date.now(),
                      variant: "inline",
                      onDecision: props.onApprovalDecision,
                    })}
                  </div>`
                : nothing}
              ${renderChatTaskSuggestions({
                suggestions: props.taskSuggestions ?? [],
                busyIds: props.taskSuggestionBusyIds ?? new Set(),
                canAccept: props.canAcceptTaskSuggestions === true,
                canDismiss: props.canDismissTaskSuggestions === true,
                onAccept: (suggestion) => props.onAcceptTaskSuggestion?.(suggestion),
                onDismiss: (suggestion) => props.onDismissTaskSuggestion?.(suggestion),
              })}
              ${renderChatPullRequests({
                pullRequests: props.pullRequests ?? [],
                branch: props.pullRequestsBranch,
                rateLimited: props.pullRequestsRateLimited === true,
                expanded: props.pullRequestsExpanded === true,
                onExpand: () => props.onExpandPullRequests?.(),
                onDismiss: (pullRequest) => props.onDismissPullRequest?.(pullRequest),
              })}
              ${renderChatSessionSuggestions({
                suggestions: props.sessionSuggestions ?? [],
                role: props.sessionSuggestionRole,
                busyIds: props.sessionSuggestionBusyIds ?? new Set(),
                archived: props.sessionSuggestionsArchived === true,
                canResolve: props.canResolveSessionSuggestions === true,
                onResolve: (suggestion, resolution) =>
                  props.onResolveSessionSuggestion?.(suggestion, resolution),
              })}
              ${props.observerHudReady
                ? html`
                    <openclaw-chat-observer-hud
                      .sessionKey=${props.sessionKey}
                      .digest=${props.observerDigest ?? null}
                      .running=${Boolean(props.observerRunId)}
                      .activeRunId=${props.observerRunId ?? null}
                      .startedAt=${props.observerStartedAt}
                      .lastReadAt=${props.observerLastReadAt}
                      .sideChatOpen=${sideChatVisible}
                      .planStatus=${props.planStatus ?? null}
                      .pullRequests=${props.pullRequests ?? []}
                      .onAsk=${props.onObserverAsk}
                      .onVisibilityChange=${props.onObserverVisibilityChange}
                    ></openclaw-chat-observer-hud>
                  `
                : nothing}
              ${scrollToBottomButton} ${chatColumnFooter}
              ${renderSideChatPanel({
                ...sideChatProps,
                // Detached slash sends are refused while disconnected (see
                // canSubmitDraft); hide the input instead of eating drafts.
                canFollowUp:
                  canCompose && props.connected && typeof props.onSideQuestion === "function",
                onFollowUp: props.onSideQuestion,
                onClose: props.onSideChatClose,
                onClear: props.onSideChatClear,
              })}
            </div>

            ${sidebarOpen
              ? html`${renderChatResizableDivider({
                    label: t("nav.resize"),
                    orientation: sidebarStacked ? "horizontal" : "vertical",
                    splitRatio,
                    onResize: (event) => props.onSplitRatioChange?.(event.detail.splitRatio),
                  })}
                  <openclaw-chat-detail-panel
                    class="chat-sidebar"
                    .content=${props.sidebarContent ?? null}
                    .loadFullMessage=${props.onLoadSidebarFullMessage ?? null}
                    .canvasPluginSurfaceUrl=${props.canvasPluginSurfaceUrl ?? null}
                    .embedSandboxMode=${props.embedSandboxMode ?? "scripts"}
                    .allowExternalEmbedUrls=${props.allowExternalEmbedUrls ?? false}
                    .onOpenWorkspaceFile=${props.onOpenWorkspaceFile ?? null}
                    .onRevealInWorkspace=${props.onRevealWorkspaceFile ?? null}
                    .onOpenImage=${props.onOpenImage ? openImmediateImage : null}
                    @chat-detail-panel-close=${() => props.onCloseSidebar?.()}
                  ></openclaw-chat-detail-panel> `
              : nothing}
          </div>
        </div>
      </div>
      ${renderChatImageLightbox(props.imageLightbox, props.onCloseImage)}
    </section>
  `;
}
