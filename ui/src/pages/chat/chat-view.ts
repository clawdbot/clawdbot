import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import type {
  ProgressCard,
  SessionPlacementDiskSpace,
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type { ChatSendShortcut } from "../../app/settings.ts";
import { renderExecApprovalCard } from "../../components/exec-approval-card.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import type { SessionLinkTarget } from "../../components/markdown-session-links.ts";
import type { PersonActivityRouting } from "../../components/person-activity-link.ts";
import { t } from "../../i18n/index.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import type {
  ChatAttachment,
  ChatGuardianNotice,
  ChatQueueItem,
  ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../lib/keyboard-shortcut-catalog.ts";
import type { ProviderUsageDisplayProps } from "../../lib/provider-quota-summary.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import type { UiSessionDefaultsHost } from "../../lib/sessions/session-key.ts";
import { getChatHistoryLoadState, retryChatHistoryLoad } from "./chat-history.ts";
import { getChatPendingInputs, loadChatPendingInputs } from "./chat-pending-inputs.ts";
import { chatStartupStatusLabel, type ChatRunStartupStatus } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  type ChatPlacementStartupNoticeProps,
  renderChatComposerNotices,
  renderChatTopbarNotices,
} from "./chat-view-notices.ts";
import { createChatAttachmentDropHandlers } from "./components/chat-attachments.ts";
import type { BackgroundTasksProps } from "./components/chat-background-tasks.types.ts";
import type {
  CapabilityMenuProps,
  ChatComposerDisabledBanner,
  ChatComposerProps,
  ChatQueuedEditProps,
} from "./components/chat-composer-types.ts";
import { isChatRunWorking, renderChatComposer } from "./components/chat-composer.ts";
import { isImageLightboxEvent, openInlineChatImage } from "./components/chat-image-lightbox.ts";
import type { ArtifactDownloadResolver } from "./components/chat-message-media.ts";
import type { ChatPermissionPickerProps } from "./components/chat-permission-picker.ts";
import { renderChatPullRequests } from "./components/chat-pull-requests.ts";
import { renderChatSessionSuggestions } from "./components/chat-session-suggestions.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./components/chat-sidebar.ts";
import { renderChatSwarmProgress } from "./components/chat-swarm-progress.ts";
import { renderChatTaskSuggestionTray } from "./components/chat-task-suggestions.ts";
import type { ChatTaskSuggestionTrayProps } from "./components/chat-task-suggestions.ts";
import type { ReplyMessageAccess } from "./components/chat-thread-interactions.ts";
import {
  renderTranscriptSearch,
  toggleTranscriptSearch,
} from "./components/chat-thread-interactions.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import type { ChatTranscriptController } from "./components/chat-transcript-controller.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./input-history.ts";
import type { LinkFaviconFetcher } from "./link-favicon-loader.ts";
import type { RealtimeTalkConversationEntry } from "./realtime-talk-conversation.ts";
import type { RealtimeTalkCameraDevice } from "./realtime-talk-input.ts";
import type { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "./realtime-talk.ts";
import type { ChatRunUiStatus } from "./run-lifecycle.ts";
import type { CompactionStatus, FallbackStatus } from "./tool-stream.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";
import "../../components/resizable-divider.ts";
type ChatReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};
export type ChatProps = ChatTaskSuggestionTrayProps &
  ChatPlacementStartupNoticeProps & {
    transcript: ChatTranscriptController;
    historyState?: ChatState;
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
    progressCard?: ProgressCard | null;
    progressCardHasActiveRun?: boolean;
    collapseTaskProgress?: boolean;
    onDismissProgressCard?: (card: ProgressCard) => void;
    gatewayQuestionPrompts?: readonly QuestionPrompt[];
    onGatewayQuestionChange?: () => void;
    onGatewayQuestionSubmit?: (
      id: string,
      answers: Record<string, string[]>,
    ) => void | Promise<void>;
    onGatewayQuestionSkip?: (id: string) => void | Promise<void>;
    messages: unknown[];
    historyPagination?: {
      hasMore: boolean;
      loading: boolean;
      onShowEarlier: () => void;
    };
    toolMessages: unknown[];
    browserTabPreviewsActive?: boolean;
    guardianNotices?: ChatGuardianNotice[];
    streamSegments: ChatStreamSegment[];
    stream: string | null;
    streamStartedAt: number | null;
    /** Browser-local active run identity, retained across transient disconnects. */
    runId?: string | null;
    runOutputTokens?: number | null;
    assistantAvatarUrl?: string | null;
    draft: string;
    modelCatalog: readonly ModelCatalogEntry[];
    modelSwitching: boolean;
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
    onComposerHoldToRecordChange?: (enabled: boolean) => void;
    onOpenTalkSettings?: () => void;
    onOpenDictationSettings?: () => void;
    suggestionComposer?: boolean;
    typingActors?: readonly { id: string; label: string; preview?: string }[];
    onTypingChange?: (typing: boolean, preview?: string) => void;
    canSend: boolean;
    disabledReason: string | null;
    disabledReasonTone?: "info" | "danger";
    disabledBanner?: ChatComposerDisabledBanner;
    modelSetupRequired?: boolean;
    onModelSetup?: () => void;
    error: string | null;
    diskSpace?: SessionPlacementDiskSpace;
    runError?: { summary: string } | null;
    inlineApproval?: ExecApprovalRequest | null;
    approvalBusy?: boolean;
    approvalCanGrant: boolean;
    approvalErrors?: ReadonlyMap<string, string>;
    onApprovalDecision?: (
      approvalId: string,
      decision: ExecApprovalDecision,
    ) => void | Promise<void>;
    workspaceConflict?: WorkspaceResultConflict;
    onDismissWorkspaceConflict?: () => void;
    sessions: SessionsListResult | null;
    selectedSession: GatewaySessionRow | undefined;
    toolOverrides?: SessionToolOverrides;
    capabilityMenu?: CapabilityMenuProps;
    swarmSessions?: readonly GatewaySessionRow[];
    /** Host context resolving global-alias session keys (scope=global fleets). */
    sessionHost?: UiSessionDefaultsHost | null;
    providerUsage?: ProviderUsageDisplayProps;
    focusMode?: boolean;
    canvasPluginSurfaceUrl?: string | null;
    boardProvider?: BoardProvider;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
    fetchLinkFavicon?: LinkFaviconFetcher;
    chatMessageMaxWidth?: string | null;
    assistantName: string;
    sendShortcut?: ChatSendShortcut;
    followUpMode?: ControlUiFollowUpMode;
    assistantAvatar: string | null;
    senderAgentAvatars?: ReadonlyMap<string, string | null>;
    /** Configured main-session key; an agent's main source labels as the agent. */
    mainKey?: string;
    userId?: string | null;
    userName?: string | null;
    userAvatar?: string | null;
    personActivity?: PersonActivityRouting;
    localMediaPreviewRoots?: string[];
    connectionEpoch?: number;
    assistantAttachmentAuthToken?: string | null;
    resolveArtifactDownload?: ArtifactDownloadResolver;
    autoExpandToolCalls?: boolean;
    attachmentLimits?: { maxBytes: number; maxImageBytes: number };
    attachments?: ChatAttachment[];
    getAttachments?: () => ChatAttachment[];
    pendingAttachmentReads?: number;
    getPendingAttachmentReads?: () => number;
    readSignal?: AbortSignal;
    onPendingReadsChange?: (delta: 1 | -1) => void;
    onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
    onRemoveAttachment?: (attachment: ChatAttachment) => void;
    onRequestOpenImage?: () => number;
    onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
    onAssistantAttachmentLoaded?: () => void;
    showNewMessages?: boolean;
    onScrollToBottom?: (options?: { smooth?: boolean }) => void;
    onRefresh: () => void;
    onToggleFocusMode?: () => void;
    getDraft?: () => string;
    onDraftChange: (next: string) => void;
    onRequestUpdate?: () => void;
    onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
    onSlashIntent?: () => void | Promise<void>;
    onSlashCommand?: (command: string) => void;
    onSend: ChatComposerProps["onSend"];
    onOpenSessionCheckpoints?: () => void | Promise<void>;
    onToggleRealtimeTalk?: () => void;
    onToggleRealtimeCamera?: () => void;
    onSwitchRealtimeCamera?: () => void;
    onDismissError?: () => void;
    onDismissRealtimeTalkError?: () => void;
    onAbort?: () => void;
    onQueueRemove: (id: string) => void;
    onQueueRetry?: (id: string) => void;
    onQueueSteer?: (id: string) => void;
    onQueueMove?: (id: string, toIndex: number) => void;
    queuedEdit?: ChatQueuedEditProps;
    onGoalAction?: ChatComposerProps["onGoalAction"];
    onGoalSubmit?: ChatComposerProps["onGoalSubmit"];
    goalDraftMode?: ChatComposerProps["goalDraftMode"];
    onGoalDraftModeChange?: ChatComposerProps["onGoalDraftModeChange"];
    currentSessionId?: string | null;
    onHistoryIntent?: (event: Event) => void;
    onCompanionQuestion?: (question: string) => void;
    onCompanionPrefill?: (question: string) => void;
    onClearHistory?: () => void;
    agentsList: {
      agents: Array<{
        id: string;
        name?: string;
        identity?: { name?: string; avatarUrl?: string };
      }>;
      defaultId?: string;
    } | null;
    currentAgentId: string;
    fullMessageAgentId?: string;
    loadFullAssistantMessage?: SidebarFullMessageLoader | null;
    onAgentChange: (agentId: string) => void;
    onNavigateToAgent?: () => void;
    onSessionSelect?: (sessionKey: string) => void;
    onOpenSidebar?: (content: SidebarContent) => void;
    onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
    onOpenSessionLink?: (target: SessionLinkTarget) => void;
    onRevealWorkspaceFile?: (path: string) => void;
    onChatScroll?: (event: Event) => void;
    basePath?: string;
    resourceBasePath?: string;
    composerControls?: TemplateResult | typeof nothing;
    permissionPicker?: ChatPermissionPickerProps;
    replyTarget?: ChatReplyTarget | null;
    onClearReply?: () => void;
    onSetReply?: (target: ChatReplyTarget) => void;
    replyMessageAccess?: ReplyMessageAccess;
    onRewindMessage?: (entryId: string) => Promise<boolean> | boolean;
    onForkMessage?: (entryId: string) => Promise<void> | void;
    backgroundTasks?: BackgroundTasksProps;
    header?: TemplateResult | typeof nothing;
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
    onOpenSessionDiff?: () => void;
    onExpandPullRequests?: () => void;
    onDismissPullRequest?: (pullRequest: ControlUiSessionPullRequest) => void;
    githubPublicationBusy?: boolean;
    githubPublicationResult?:
      | import("../../../../packages/gateway-protocol/src/index.js").SessionGitHubPublicationResult
      | null;
    githubPublicationError?: string | null;
    githubPublicationGuidance?: string;
    onPublishPullRequest?: () => void;
  };

export function renderChat(props: ChatProps) {
  const pendingInputs = props.historyState ? getChatPendingInputs(props.historyState) : undefined;
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const canCompose = props.canSend;
  const showModelSetupSplash =
    props.modelSetupRequired === true &&
    props.messages.length === 0 &&
    (pendingInputs?.page.items.length ?? 0) === 0 &&
    props.toolMessages.length === 0 &&
    props.streamSegments.length === 0 &&
    !props.stream &&
    props.queue.length === 0;
  const openImage = props.onOpenImage
    ? (item: ImageLightboxItem, requestVersion?: number) =>
        requestVersion === undefined
          ? props.onOpenImage?.(item)
          : props.onOpenImage?.(item, requestVersion)
    : undefined;
  const openImmediateImage = props.onOpenImage
    ? (item: ImageLightboxItem) => openImage?.(item, props.onRequestOpenImage?.())
    : undefined;
  const attachmentDropHandlers = createChatAttachmentDropHandlers({ ...props, canCompose });
  const placementStartup =
    props.placementStartup?.phase === "failed" ? null : props.placementStartup;
  const queue = props.placementStartup?.initialTurn
    ? [...props.queue, props.placementStartup.initialTurn]
    : props.queue;
  // Placement is visible work, but does not own an abortable model run yet.
  const runWorking = Boolean(placementStartup) || isChatRunWorking(props);
  let chatSection: HTMLElement | null = null;
  const thread = renderChatThread(
    {
      paneId: props.paneId,
      sessionKey: props.sessionKey,
      selectedSession: props.selectedSession,
      announceTranscript: props.announceTranscript,
      loading: props.loading && !placementStartup,
      historyPagination: props.historyPagination,
      messages: props.messages,
      toolMessages: props.toolMessages,
      browserTabPreviewsActive: props.browserTabPreviewsActive,
      guardianNotices: props.guardianNotices,
      streamSegments: props.streamSegments,
      stream: props.stream,
      streamStartedAt: placementStartup?.startedAt ?? props.streamStartedAt,
      runId: props.runId,
      runOutputTokens: props.runOutputTokens,
      runStatus: props.runStatus,
      queue,
      pendingInputs: pendingInputs?.page.items,
      showThinking: props.showThinking,
      showToolCalls: props.showToolCalls,
      persistCommentary: props.persistCommentary,
      runActive: Boolean(props.canAbort),
      runWorking,
      startupLabel: chatStartupStatusLabel(props.startupStatus, placementStartup),
      waitingApproval: props.waitingApproval,
      questionPrompts: props.gatewayQuestionPrompts,
      sessions: props.sessions,
      sessionHost: props.sessionHost,
      boardProvider: props.boardProvider,
      assistantName: props.assistantName,
      assistantAvatar: props.assistantAvatar,
      senderAgentAvatars: props.senderAgentAvatars,
      agents: props.agentsList?.agents,
      mainKey: props.mainKey,
      currentAgentId: props.currentAgentId,
      assistantAvatarUrl: props.assistantAvatarUrl,
      userId: props.userId,
      userName: props.userName,
      userAvatar: props.userAvatar,
      personActivity: props.personActivity,
      basePath: props.basePath,
      resourceBasePath: props.resourceBasePath,
      fullMessageAgentId: props.fullMessageAgentId,
      loadFullAssistantMessage: props.loadFullAssistantMessage,
      localMediaPreviewRoots: props.localMediaPreviewRoots,
      connectionEpoch: props.connectionEpoch,
      assistantAttachmentAuthToken: props.assistantAttachmentAuthToken,
      resolveArtifactDownload: props.resolveArtifactDownload,
      canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
      embedSandboxMode: props.embedSandboxMode,
      allowExternalEmbedUrls: props.allowExternalEmbedUrls,
      fetchLinkFavicon: props.fetchLinkFavicon,
      autoExpandToolCalls: props.autoExpandToolCalls,
      realtimeTalkConversation: props.realtimeTalkConversation,
      typingActors: props.typingActors,
      onOpenSidebar: props.onOpenSidebar,
      onOpenWorkspaceFile: props.onOpenWorkspaceFile,
      onOpenSessionLink: props.onOpenSessionLink,
      onOpenSessionCheckpoints: props.onOpenSessionCheckpoints,
      onRequestOpenImage: props.onRequestOpenImage,
      onOpenImage: openImage,
      onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
      onRequestUpdate: requestUpdate,
      onChatScroll: props.onChatScroll,
      onHistoryIntent: props.onHistoryIntent,
      onDraftChange: props.onDraftChange,
      onSend: props.onSend,
      queuedMessageAction: props.placementStartup?.initialTurn
        ? {
            id: props.placementStartup.initialTurn.id,
            label:
              props.placementStartup.action === "check-delivery"
                ? t("chat.queue.checkDelivery")
                : undefined,
            onAction: props.connected ? props.onRetrySessionPlacementStartup : undefined,
          }
        : undefined,
      onRetryQueuedMessage: props.connected && canCompose ? props.onQueueRetry : undefined,
      onDiscardQueuedMessage: props.onQueueRemove,
      onSetReply: props.onSetReply,
      replyMessageAccess: props.replyMessageAccess,
      onRewindMessage: props.onRewindMessage,
      onForkMessage: props.onForkMessage,
      onCompanionQuestion:
        props.canSend && !props.suggestionComposer ? props.onCompanionQuestion : undefined,
      onCompanionPrefill:
        props.canSend && !props.suggestionComposer ? props.onCompanionPrefill : undefined,
      onOpenSession: props.onSessionSelect,
      modelSetupRequired: props.modelSetupRequired,
      onModelSetup: props.onModelSetup,
      backgroundTasks: props.backgroundTasks,
      onFocusComposer: () =>
        chatSection
          ?.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
          ?.focus({ preventScroll: true }),
    },
    props.transcript,
  );
  // The composer keeps the outbox queue; only the transcript includes the
  // placement initial turn, whose retry action belongs to startup.
  const chatColumnFooter = renderChatComposer({
    ...props,
    anchoredNotices: renderChatComposerNotices(props),
    onRequestUpdate: requestUpdate,
    onToggleRealtimeTalk: props.suggestionComposer ? undefined : props.onToggleRealtimeTalk,
    onOpenImage: openImmediateImage,
  });
  const taskSuggestionTray = renderChatTaskSuggestionTray(props);
  const gutterStack =
    taskSuggestionTray === nothing
      ? nothing
      : html`<div class="chat-gutter-stack">${taskSuggestionTray}</div>`;
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
  const historyState = props.historyState;
  const historyLoadState = historyState ? getChatHistoryLoadState(historyState) : undefined;
  const historyFailed =
    historyState !== undefined &&
    historyLoadState?.phase === "failed" &&
    historyLoadState.sessionKey === props.sessionKey;
  const transcriptEmpty =
    !runWorking &&
    props.messages.length === 0 &&
    (pendingInputs?.page.items.length ?? 0) === 0 &&
    props.toolMessages.length === 0 &&
    props.streamSegments.length === 0 &&
    !props.stream &&
    queue.length === 0;
  // A failed load with cached content must stay visible without displacing the
  // transcript; only an empty pane may replace the thread with the error panel.
  const renderHistoryFailure = (inline: boolean) =>
    html`<div
      class="chat-history-error${inline ? " chat-history-error--inline" : ""}"
      role=${inline ? "status" : "alert"}
    >
      <span>${historyLoadState?.phase === "failed" ? historyLoadState.message : ""}</span>
      <button
        class="btn btn--sm"
        type="button"
        @click=${() => historyState && retryChatHistoryLoad(historyState)}
      >
        ${t("common.retry")}
      </button>
    </div>`;
  const historyError = historyFailed && transcriptEmpty ? renderHistoryFailure(false) : nothing;
  const historyRefreshNotice =
    historyFailed && !transcriptEmpty ? renderHistoryFailure(true) : nothing;

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
        if (
          (event.key === "Enter" || event.key === " ") &&
          openInlineChatImage(event, openImmediateImage)
        ) {
          return;
        }
        if (event.key === "Escape" && props.replyTarget && !event.defaultPrevented) {
          event.preventDefault();
          props.onClearReply?.();
          return;
        }
        if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.transcriptSearch, event)) {
          event.preventDefault();
          toggleTranscriptSearch(props.paneId, requestUpdate, event);
        }
      }}
    >
      <div class="chat-workbench">
        <div class="chat-workbench__main">
          <div class="chat-split-container">
            <div class="chat-main">
              <div class="chat-main__conversation-column">
                ${props.header ?? nothing} ${renderChatTopbarNotices(props)}
                ${renderTranscriptSearch(props.paneId, requestUpdate)}
                <div class="chat-main__conversation">
                  ${historyRefreshNotice} ${historyError === nothing ? thread : historyError}
                  ${pendingInputs &&
                  (pendingInputs.page.total > 0 || pendingInputs.before !== undefined)
                    ? html`<div class="chat-history-error chat-history-error--inline" role="status">
                        <span
                          >${t("chat.pendingInputs.count", {
                            count: String(pendingInputs.page.total),
                          })}</span
                        >
                        ${pendingInputs.error ? html`<span>${pendingInputs.error}</span>` : nothing}
                        ${pendingInputs.page.nextBefore !== undefined
                          ? html`<button
                              class="btn btn--sm"
                              type="button"
                              ?disabled=${pendingInputs.loading}
                              @click=${() =>
                                props.historyState &&
                                loadChatPendingInputs(
                                  props.historyState,
                                  pendingInputs.page.nextBefore,
                                )}
                            >
                              ${t("chat.pendingInputs.earlier")}
                            </button>`
                          : nothing}
                        ${pendingInputs.before !== undefined
                          ? html`<button
                              class="btn btn--sm"
                              type="button"
                              ?disabled=${pendingInputs.loading}
                              @click=${() =>
                                props.historyState && loadChatPendingInputs(props.historyState)}
                            >
                              ${t("chat.pendingInputs.latest")}
                            </button>`
                          : nothing}
                      </div>`
                    : nothing}
                  ${scrollToBottomButton}
                  ${props.inlineApproval && props.onApprovalDecision
                    ? html`<div class="chat-inline-approval">
                        ${renderExecApprovalCard({
                          approval: props.inlineApproval,
                          busy: props.approvalBusy === true,
                          canGrant: props.approvalCanGrant,
                          error: props.approvalErrors?.get(props.inlineApproval.id) ?? null,
                          variant: "inline",
                          onDecision: props.onApprovalDecision,
                        })}
                      </div>`
                    : nothing}
                  ${gutterStack}
                  ${renderChatPullRequests({
                    pullRequests: props.pullRequests ?? [],
                    branch: props.pullRequestsBranch,
                    rateLimited: props.pullRequestsRateLimited === true,
                    expanded: props.pullRequestsExpanded === true,
                    onExpand: () => props.onExpandPullRequests?.(),
                    onDismiss: (pullRequest) => props.onDismissPullRequest?.(pullRequest),
                    onOpenSessionDiff: props.onOpenSessionDiff,
                    publicationBusy: props.githubPublicationBusy === true,
                    publicationResult: props.githubPublicationResult,
                    publicationError: props.githubPublicationError,
                    publicationGuidance: props.githubPublicationGuidance,
                    onPublish: props.onPublishPullRequest,
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
                  ${renderChatSwarmProgress({
                    sessions: props.swarmSessions ?? [],
                    sessionKey: props.sessionKey,
                  })}
                  ${showModelSetupSplash ? nothing : chatColumnFooter}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}
