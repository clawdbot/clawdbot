// Control UI view renders chat screen composition.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import type { TaskSuggestion } from "../../../../packages/gateway-protocol/src/index.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { SessionsListResult } from "../../api/types.ts";
import type { ChatSendShortcut } from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { ChatSideResult } from "../../lib/chat/side-result.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import type { ProviderUsageDisplayProps } from "../../lib/provider-quota-summary.ts";
import {
  handleChatAttachmentDrop,
  renderChatComposer,
  resetChatComposerState,
} from "./components/chat-composer.ts";
import { renderChatPullRequests } from "./components/chat-pull-requests.ts";
import {
  renderSessionWorkspaceRail,
  renderSessionWorkspaceToggle,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import "./components/chat-sidebar.ts";
import type {
  DetailFullMessageResult,
  SidebarContent,
  SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
import { renderChatTaskSuggestions } from "./components/chat-task-suggestions.ts";
import {
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

export type ChatProps = {
  paneId: string;
  sessionKey: string;
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
  sideResult?: ChatSideResult | null;
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
  providerUsage?: ProviderUsageDisplayProps;
  focusMode?: boolean;
  onLoadSidebarFullMessage?: (
    request: SidebarFullMessageRequest,
  ) => Promise<DetailFullMessageResult | null | undefined>;
  sidebarOpen?: boolean;
  sidebarContent?: SidebarContent | null;
  splitRatio?: number;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  chatMessageMaxWidth?: string | null;
  assistantName: string;
  sendShortcut?: ChatSendShortcut;
  assistantAvatar: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  autoExpandToolCalls?: boolean;
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onAssistantAttachmentLoaded?: () => void;
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
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
  onDismissSideResult?: () => void;
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
  /** True when a split pane header hosts the workspace toggle; suppresses the
   * single-pane floating opener so only one affordance renders. */
  paneHeaderActive?: boolean;
  taskSuggestions?: TaskSuggestion[];
  taskSuggestionBusyIds?: ReadonlySet<string>;
  canAcceptTaskSuggestions?: boolean;
  canDismissTaskSuggestions?: boolean;
  onAcceptTaskSuggestion?: (suggestion: TaskSuggestion) => void;
  onDismissTaskSuggestion?: (suggestion: TaskSuggestion) => void;
  pullRequests?: ControlUiSessionPullRequest[];
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
  const canCompose = props.canSend;
  let chatSection: HTMLElement | null = null;

  const thread = renderChatThread({
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    loading: props.loading,
    messages: props.messages,
    toolMessages: props.toolMessages,
    streamSegments: props.streamSegments,
    stream: props.stream,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    showThinking: props.showThinking,
    showToolCalls: props.showToolCalls,
    runActive: Boolean(props.canAbort),
    sessions: props.sessions,
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
    onScrollToBottom: props.onScrollToBottom,
    onChatScroll: props.onChatScroll,
    onDraftChange: props.onDraftChange,
    onSend: props.onSend,
    onSetReply: props.onSetReply,
    onFocusComposer: () =>
      chatSection
        ?.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
        ?.focus({ preventScroll: true }),
  });

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
    sideResult: props.sideResult,
    queue: props.queue,
    draft: props.draft,
    sessions: props.sessions,
    providerUsage: props.providerUsage,
    assistantName: props.assistantName,
    sendShortcut: props.sendShortcut,
    attachments: props.attachments,
    showNewMessages: props.showNewMessages,
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
    onDismissSideResult: props.onDismissSideResult,
    onNewSession: props.onNewSession,
    onClearReply: props.onClearReply,
    onScrollToBottom: props.onScrollToBottom,
    onAttachmentsChange: props.onAttachmentsChange,
  });

  return html`
    <section
      ${ref((element) => {
        chatSection = element instanceof HTMLElement ? element : null;
      })}
      class="card chat"
      style=${styleMap(
        props.chatMessageMaxWidth ? { "--chat-message-max-width": props.chatMessageMaxWidth } : {},
      )}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        if (canCompose) {
          handleChatAttachmentDrop(event, props);
        }
      }}
      @dragover=${(event: DragEvent) => event.preventDefault()}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape" && props.replyTarget && !event.defaultPrevented) {
          event.preventDefault();
          props.onClearReply?.();
          return;
        }
        if (event.key === "Escape" && props.sideResult && !isChatThreadSearchOpen(props.paneId)) {
          event.preventDefault();
          props.onDismissSideResult?.();
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
                    <openclaw-tooltip content="Dismiss error">
                      <button
                        class="callout__dismiss"
                        type="button"
                        @click=${props.onDismissError}
                        aria-label="Dismiss error"
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
            <openclaw-tooltip content="Exit focus mode">
              <button
                class="chat-focus-exit"
                type="button"
                @click=${props.onToggleFocusMode}
                aria-label="Exit focus mode"
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
        class="chat-workbench ${props.sessionWorkspace?.collapsed
          ? "chat-workbench--workspace-collapsed"
          : ""} ${props.sessionWorkspace?.dock === "bottom" ? "chat-workbench--dock-bottom" : ""}"
      >
        ${renderSessionWorkspaceRail(props.sessionWorkspace)}
        ${props.sessionWorkspace?.collapsed && !props.paneHeaderActive
          ? renderSessionWorkspaceToggle(props.sessionWorkspace, "floating")
          : nothing}
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
          <div class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}">
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
                rateLimited: props.pullRequestsRateLimited === true,
                expanded: props.pullRequestsExpanded === true,
                onExpand: () => props.onExpandPullRequests?.(),
                onDismiss: (pullRequest) => props.onDismissPullRequest?.(pullRequest),
              })}
              ${chatColumnFooter}
            </div>

            ${sidebarOpen
              ? html`
                  <resizable-divider
                    .splitRatio=${splitRatio}
                    .label=${t("nav.resize")}
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
