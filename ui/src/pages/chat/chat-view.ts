// Control UI view renders chat screen composition.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import type { TaskSuggestion } from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { SessionsListResult } from "../../api/types.ts";
import type { ChatFollowUpMode, ChatSendShortcut } from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { ChatSideResult, ChatSideResultPending } from "../../lib/chat/side-result.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import type { ProviderUsageDisplayProps } from "../../lib/provider-quota-summary.ts";
import type { UiSessionDefaultsHost } from "../../lib/sessions/session-key.ts";
import { handleChatAttachmentDrop } from "./components/chat-attachments.ts";
import {
  renderBackgroundTasksRail,
  renderBackgroundTasksToggle,
  type BackgroundTasksProps,
} from "./components/chat-background-tasks.ts";
import {
  isChatRunWorking,
  renderChatComposer,
  resetChatComposerState,
} from "./components/chat-composer.ts";
import { renderChatPullRequests } from "./components/chat-pull-requests.ts";
import {
  renderSessionDiffToggle,
  renderSessionWorkspaceRail,
  renderSessionWorkspaceToggle,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import { isSideChatPanelVisible, renderSideChatPanel } from "./components/chat-side-chat.ts";
import "./components/chat-sidebar.ts";
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
  resetChatThreadPresentationState,
  toggleChatThreadSearch,
} from "./components/chat-thread.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./input-history.ts";
import type { RealtimeTalkConversationEntry } from "./realtime-talk-conversation.ts";
import type { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "./realtime-talk.ts";
import type { ChatRunUiStatus } from "./run-lifecycle.ts";
import type { CompactionStatus, FallbackStatus } from "./tool-stream.ts";
import "../../components/resizable-divider.ts";

function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

export type ChatProps = {
  transcript: ChatTranscriptController;
  paneId: string;
  sessionKey: string;
  announceTranscript?: boolean;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  showToolCalls: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  compactionStatus?: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  messages: unknown[];
  historyPagination?: {
    loading: boolean;
  };
  sideChatTurns?: ChatSideResult[];
  sideChatPending?: ChatSideResultPending | null;
  sideChatHidden?: boolean;
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: RealtimeTalkStatus;
  realtimeTalkDetail?: string | null;
  realtimeTalkInputLevel?: RealtimeTalkLevelSignal;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
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
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  chatMessageMaxWidth?: string | null;
  assistantName: string;
  sendShortcut?: ChatSendShortcut;
  followUpMode?: ChatFollowUpMode;
  assistantAvatar: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  autoExpandToolCalls?: boolean;
  attachments?: ChatAttachment[];
  getAttachments?: () => ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
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
  onSend: () => void;
  onCompact?: () => void | Promise<void>;
  onOpenSessionCheckpoints?: () => void | Promise<void>;
  onToggleRealtimeTalk?: () => void;
  onDismissError?: () => void;
  onDismissRealtimeTalkError?: () => void;
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
  composerControls?: TemplateResult | typeof nothing;
  replyTarget?: { messageId: string; text: string; senderLabel?: string | null } | null;
  onClearReply?: () => void;
  onSetReply?: (target: { messageId: string; text: string; senderLabel?: string | null }) => void;
  sessionWorkspace?: SessionWorkspaceProps;
  backgroundTasks?: BackgroundTasksProps;
  /** True when a split pane header hosts the workspace toggle; suppresses the
   * single-pane floating opener so only one affordance renders. */
  paneHeaderActive?: boolean;
  /** Split-view opener shown in the floating toggle cluster. Only set for the
   * single wide pane — split mode owns its controls in pane headers. */
  onOpenSplitView?: () => void;
  taskSuggestions?: TaskSuggestion[];
  taskSuggestionBusyIds?: ReadonlySet<string>;
  canAcceptTaskSuggestions?: boolean;
  canDismissTaskSuggestions?: boolean;
  onAcceptTaskSuggestion?: (suggestion: TaskSuggestion) => void;
  onDismissTaskSuggestion?: (suggestion: TaskSuggestion) => void;
  pullRequests?: ControlUiSessionPullRequest[];
  pullRequestsBranch?: ControlUiSessionBranch;
  pullRequestsRateLimited?: boolean;
  pullRequestsExpanded?: boolean;
  onExpandPullRequests?: () => void;
  onDismissPullRequest?: (pullRequest: ControlUiSessionPullRequest) => void;
};

export function resetChatViewState(paneId?: string) {
  resetChatComposerState(paneId);
  resetChatThreadPresentationState(paneId);
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
  const sideChatVisible = isSideChatPanelVisible(sideChatProps);
  let chatSection: HTMLElement | null = null;
  // Nested dragenter/dragleave events must stay balanced so crossing transcript
  // children does not flicker the pane-level file drop affordance.
  let attachmentDragDepth = 0;
  const setAttachmentDropActive = (event: DragEvent, active: boolean) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (active) {
      if (!canCompose || !isFileDrag(event.dataTransfer)) {
        return;
      }
      attachmentDragDepth += 1;
    } else {
      attachmentDragDepth = Math.max(0, attachmentDragDepth - 1);
    }
    target.toggleAttribute("data-attachment-drop-active", attachmentDragDepth > 0);
  };
  const clearAttachmentDropActive = (event: DragEvent) => {
    attachmentDragDepth = 0;
    const target = event.currentTarget;
    if (target instanceof HTMLElement) {
      target.removeAttribute("data-attachment-drop-active");
    }
  };

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
      queue: props.queue,
      showThinking: props.showThinking,
      showToolCalls: props.showToolCalls,
      runActive: Boolean(props.canAbort),
      runWorking: isChatRunWorking(props),
      sessions: props.sessions,
      sessionHost: props.sessionHost,
      assistantName: props.assistantName,
      assistantAvatar: props.assistantAvatar,
      assistantAvatarUrl: props.assistantAvatarUrl,
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
      onRequestUpdate: requestUpdate,
      onChatScroll: props.onChatScroll,
      onHistoryIntent: props.onHistoryIntent,
      onDraftChange: props.onDraftChange,
      getDraft: props.getDraft,
      onSend: props.onSend,
      onSetReply: props.onSetReply,
      // Archived/non-composable sessions must not offer selection actions:
      // withholding the callback keeps the popup from rendering at all.
      onSideQuestion: props.canSend ? props.onSideQuestion : undefined,
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
    canSend: props.canSend,
    disabledReason: props.disabledReason,
    sending: props.sending,
    canAbort: props.canAbort,
    runStatus: props.runStatus,
    compactionStatus: props.compactionStatus,
    fallbackStatus: props.fallbackStatus,
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
    composerControls: props.composerControls,
    getDraft: props.getDraft,
    onDraftChange: props.onDraftChange,
    onRequestUpdate: requestUpdate,
    onHistoryKeydown: props.onHistoryKeydown,
    onSlashIntent: props.onSlashIntent,
    onSend: props.onSend,
    onCompact: props.onCompact,
    onToggleRealtimeTalk: props.onToggleRealtimeTalk,
    onDismissRealtimeTalkError: props.onDismissRealtimeTalkError,
    onAbort: props.onAbort,
    onQueueRemove: props.onQueueRemove,
    onQueueRetry: props.onQueueRetry,
    onQueueSteer: props.onQueueSteer,
    onGoalCommand: props.onGoalCommand,
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
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        clearAttachmentDropActive(event);
        if (canCompose) {
          handleChatAttachmentDrop(event, props);
        }
      }}
      @dragenter=${(event: DragEvent) => setAttachmentDropActive(event, true)}
      @dragleave=${(event: DragEvent) => setAttachmentDropActive(event, false)}
      @dragover=${(event: DragEvent) => {
        event.preventDefault();
        if (canCompose && event.dataTransfer && isFileDrag(event.dataTransfer)) {
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
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
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}
      ${props.error
        ? html`
            <div class="callout danger callout--dismissible" role="alert">
              <span class="callout__content">${props.error}</span>
              ${props.onDismissError
                ? html`
                    <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
                      <button
                        class="callout__dismiss"
                        type="button"
                        @click=${props.onDismissError}
                        aria-label=${t("chat.actions.dismissError")}
                      >
                        ${icons.x}
                      </button>
                    </openclaw-tooltip>
                  `
                : nothing}
            </div>
          `
        : nothing}
      ${props.focusMode && props.onToggleFocusMode
        ? html`
            <openclaw-tooltip .content=${t("chat.actions.exitFocusMode")}>
              <button
                class="chat-focus-exit"
                type="button"
                @click=${props.onToggleFocusMode}
                aria-label=${t("chat.actions.exitFocusMode")}
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>
          `
        : nothing}
      ${renderChatSearchBar(props.paneId, requestUpdate)}
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
          <!-- Floating openers share the top-right corner with the detail
               panel's header controls; hide them while the sidebar is open. -->
          ${!props.paneHeaderActive &&
          !sidebarOpen &&
          (props.onOpenSplitView ||
            props.sessionWorkspace?.collapsed ||
            props.backgroundTasks?.collapsed)
            ? html`
                <div class="chat-floating-toggles">
                  ${props.onOpenSplitView
                    ? html`
                        <openclaw-tooltip .content=${t("chat.splitView.open")}>
                          <button
                            class="btn btn--ghost btn--icon chat-icon-btn chat-open-split-view"
                            type="button"
                            aria-label=${t("chat.splitView.open")}
                            @click=${props.onOpenSplitView}
                          >
                            ${icons.columns2}
                          </button>
                        </openclaw-tooltip>
                      `
                    : nothing}
                  ${props.sessionWorkspace?.collapsed
                    ? renderSessionDiffToggle(props.sessionWorkspace)
                    : nothing}
                  ${props.backgroundTasks?.collapsed
                    ? renderBackgroundTasksToggle(props.backgroundTasks)
                    : nothing}
                  ${props.sessionWorkspace?.collapsed
                    ? renderSessionWorkspaceToggle(props.sessionWorkspace)
                    : nothing}
                </div>
              `
            : nothing}
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
              ? html`
                  <resizable-divider
                    .splitRatio=${splitRatio}
                    .label=${t("nav.resize")}
                    .orientation=${sidebarStacked ? "horizontal" : "vertical"}
                    @resize=${(event: CustomEvent) =>
                      props.onSplitRatioChange?.(event.detail.splitRatio)}
                  ></resizable-divider>
                  <openclaw-chat-detail-panel
                    class="chat-sidebar"
                    .content=${props.sidebarContent ?? null}
                    .loadFullMessage=${props.onLoadSidebarFullMessage ?? null}
                    .canvasPluginSurfaceUrl=${props.canvasPluginSurfaceUrl ?? null}
                    .embedSandboxMode=${props.embedSandboxMode ?? "scripts"}
                    .allowExternalEmbedUrls=${props.allowExternalEmbedUrls ?? false}
                    .onOpenWorkspaceFile=${props.onOpenWorkspaceFile ?? null}
                    .onRevealInWorkspace=${props.onRevealWorkspaceFile ?? null}
                    @chat-detail-panel-close=${() => props.onCloseSidebar?.()}
                  ></openclaw-chat-detail-panel>
                `
              : nothing}
          </div>
        </div>
      </div>
    </section>
  `;
}
