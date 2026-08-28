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
import { chatStartupStatusLabel, type ChatRunStartupStatus } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  type ChatPlacementStartupNoticeProps,
  renderChatComposerNotices,
  renderChatTopbarNotices,
} from "./chat-view-notices.ts";
import { createChatAttachmentDropHandlers } from "./components/chat-attachments.ts";
import type { BackgroundTasksProps } from "./components/chat-background-tasks.types.ts";
import { hasTerminalRunStatus } from "./components/chat-composer-state.ts";
import type {
  CapabilityMenuProps,
  ChatComposerDisabledBanner,
  ChatComposerProps,
  ChatQueuedEditProps,
} from "./components/chat-composer-types.ts";
import { isChatRunWorking, renderChatComposer } from "./components/chat-composer.ts";
import { isImageLightboxEvent, openInlineChatImage } from "./components/chat-image-lightbox.ts";
import type { MessageReplyTarget } from "./components/chat-message-markdown.ts";
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
    replyTarget?: MessageReplyTarget | null;
    onClearReply?: () => void;
    onSetReply?: (target: MessageReplyTarget) => void;
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
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const canCompose = props.canSend;
  const showModelSetupSplash =
    props.modelSetupRequired === true &&
    props.messages.length === 0 &&
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
      announceTranscript: props.announceTranscript,
      loading: props.loading && !placementStartup,
      historyLoading: props.historyPagination?.loading,
      messages: props.messages,
      toolMessages: props.toolMessages,
      guardianNotices: props.guardianNotices,
      streamSegments: props.streamSegments,
      stream: props.stream,
      streamStartedAt: placementStartup?.startedAt ?? props.streamStartedAt,
      runId: props.runId,
      runOutputTokens: props.runOutputTokens,
      runStatus: props.runStatus,
      queue,
      queueControls: {
        queue: props.queue,
        offline: props.offline,
        canAbort:
          Boolean(props.canAbort && props.onAbort) && !hasTerminalRunStatus(props.runStatus),
        onQueueRetry: props.connected && canCompose ? props.onQueueRetry : undefined,
        onQueueSteer: props.connected && canCompose ? props.onQueueSteer : undefined,
        onQueueMove: props.onQueueMove,
        onQueueEdit: props.queuedEdit?.onEdit,
        onQueueEditChange: props.queuedEdit?.onEditChange,
        onQueueEditSubmit: props.queuedEdit?.onEditSubmit,
        onQueueEditCancel: props.queuedEdit?.onCancel,
        editingId: props.queuedEdit?.editingId ?? null,
        editingText: props.queuedEdit?.editingText,
        onQueueRemove: props.onQueueRemove,
      },
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
  const chatColumnFooter = renderChatComposer({
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    currentAgentId: props.currentAgentId,
    connected: props.connected,
    offline: props.offline,
    queuedOutboxCount: props.queuedOutboxCount,
    canSend: props.canSend,
    disabledReason: props.disabledReason,
    disabledReasonTone: props.disabledReasonTone,
    disabledBanner: props.disabledBanner,
    runError: props.runError,
    anchoredNotices: renderChatComposerNotices(props),
    sending: props.sending,
    canAbort: props.canAbort,
    runStatus: props.runStatus,
    waitingApproval: props.waitingApproval,
    compactionStatus: props.compactionStatus,
    fallbackStatus: props.fallbackStatus,
    progressCard: props.progressCard,
    progressCardHasActiveRun: props.progressCardHasActiveRun,
    onDismissProgressCard: props.onDismissProgressCard,
    gatewayQuestionPrompts: props.gatewayQuestionPrompts,
    messages: props.messages,
    stream: props.stream,
    queue: props.queue,
    draft: props.draft,
    modelCatalog: props.modelCatalog,
    modelSwitching: props.modelSwitching,
    sessions: props.sessions,
    toolOverrides: props.toolOverrides,
    capabilityMenu: props.capabilityMenu,
    providerUsage: props.providerUsage,
    assistantName: props.assistantName,
    sendShortcut: props.sendShortcut,
    followUpMode: props.followUpMode,
    attachmentLimits: props.attachmentLimits,
    attachments: props.attachments,
    getAttachments: props.getAttachments,
    pendingAttachmentReads: props.pendingAttachmentReads,
    getPendingAttachmentReads: props.getPendingAttachmentReads,
    readSignal: props.readSignal,
    onPendingReadsChange: props.onPendingReadsChange,
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
    onComposerHoldToRecordChange: props.onComposerHoldToRecordChange,
    onOpenTalkSettings: props.onOpenTalkSettings,
    onOpenDictationSettings: props.onOpenDictationSettings,
    suggestionComposer: props.suggestionComposer,
    typingActors: props.typingActors,
    onTypingChange: props.onTypingChange,
    composerControls: props.composerControls,
    permissionPicker: props.permissionPicker,
    getDraft: props.getDraft,
    onDraftChange: props.onDraftChange,
    onRequestUpdate: requestUpdate,
    onHistoryKeydown: props.onHistoryKeydown,
    onSlashIntent: props.onSlashIntent,
    onSlashCommand: props.onSlashCommand,
    onSend: props.onSend,
    onToggleRealtimeTalk: props.suggestionComposer ? undefined : props.onToggleRealtimeTalk,
    onToggleRealtimeCamera: props.onToggleRealtimeCamera,
    onSwitchRealtimeCamera: props.onSwitchRealtimeCamera,
    onDismissRealtimeTalkError: props.onDismissRealtimeTalkError,
    onAbort: props.onAbort,
    onQueueRemove: props.onQueueRemove,
    onQueueRetry: props.onQueueRetry,
    onQueueSteer: props.onQueueSteer,
    onQueueMove: props.onQueueMove,
    queuedEdit: props.queuedEdit,
    onGoalAction: props.onGoalAction,
    onGoalSubmit: props.onGoalSubmit,
    goalDraftMode: props.goalDraftMode,
    onGoalDraftModeChange: props.onGoalDraftModeChange,
    currentSessionId: props.currentSessionId,
    onGatewayQuestionChange: props.onGatewayQuestionChange,
    onGatewayQuestionSubmit: props.onGatewayQuestionSubmit,
    onGatewayQuestionSkip: props.onGatewayQuestionSkip,
    onClearReply: props.onClearReply,
    onAttachmentsChange: props.onAttachmentsChange,
    onRemoveAttachment: props.onRemoveAttachment,
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
  const earlierHistoryButton = props.historyPagination?.hasMore
    ? html`
        <button
          class="btn btn--sm chat-history-available"
          type="button"
          aria-busy=${props.historyPagination.loading ? "true" : "false"}
          aria-label=${t("chat.thread.showEarlier")}
          @click=${props.historyPagination.onShowEarlier}
        >
          ${props.historyPagination.loading
            ? html`<span class="session-run-spinner" aria-hidden="true"></span>`
            : nothing}
          <span role="status">
            ${props.historyPagination.loading
              ? t("chat.thread.loadingEarlier")
              : t("chat.thread.earlierHistoryAvailable")}
          </span>
          <strong>${t("chat.thread.showEarlier")}</strong>
        </button>
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
                  ${earlierHistoryButton} ${scrollToBottomButton}
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
