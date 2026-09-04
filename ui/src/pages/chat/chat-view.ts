import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import type {
  SessionPlacementDiskSpace,
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../../app/exec-approval.ts";
import { renderExecApprovalCard } from "../../components/exec-approval-card.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../lib/keyboard-shortcut-catalog.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { retryChatHistoryLoad } from "./chat-history.ts";
import { getChatPendingInputs, loadChatPendingInputs } from "./chat-pending-inputs.ts";
import { chatStartupStatusLabel, type ChatRunStartupStatus } from "./chat-run-startup.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  type ChatPlacementStartupNoticeProps,
  renderChatComposerNotices,
  renderChatTopbarNotices,
} from "./chat-view-notices.ts";
import { createChatAttachmentDropHandlers } from "./components/chat-attachments.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import { isChatRunWorking, renderChatComposer } from "./components/chat-composer.ts";
import { isImageLightboxEvent, openInlineChatImage } from "./components/chat-image-lightbox.ts";
import { renderChatPullRequests } from "./components/chat-pull-requests.ts";
import { renderChatSessionSuggestions } from "./components/chat-session-suggestions.ts";
import { renderChatSwarmProgress } from "./components/chat-swarm-progress.ts";
import {
  renderChatTaskSuggestionTray,
  type ChatTaskSuggestionTrayProps,
} from "./components/chat-task-suggestions.ts";
import {
  renderTranscriptSearch,
  toggleTranscriptSearch,
  type ChatThreadProps,
} from "./components/chat-thread-interactions.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import type { ChatTranscriptController } from "./components/chat-transcript-controller.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";
import "../../components/resizable-divider.ts";
export type ChatProps = Omit<
  ChatThreadProps,
  | "pendingInputs"
  | "runActive"
  | "runWorking"
  | "startupLabel"
  | "questionPrompts"
  | "agents"
  | "queuedMessageAction"
  | "onRetryQueuedMessage"
  | "onDiscardQueuedMessage"
  | "onFocusComposer"
  | "onOpenSession"
  | "onSend"
> &
  Omit<ChatComposerProps, "anchoredNotices" | "disabled" | "onOpenImage"> &
  ChatTaskSuggestionTrayProps &
  ChatPlacementStartupNoticeProps & {
    transcript: ChatTranscriptController;
    historyState?: ChatState;
    onSessionKeyChange: (next: string) => void;
    thinkingLevel: string | null;
    startupStatus?: ChatRunStartupStatus | null;
    error: string | null;
    diskSpace?: SessionPlacementDiskSpace;
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
    swarmSessions?: readonly GatewaySessionRow[];
    focusMode?: boolean;
    chatMessageMaxWidth?: string | null;
    showNewMessages?: boolean;
    onScrollToBottom?: (options?: { smooth?: boolean }) => void;
    onRefresh: () => void;
    onToggleFocusMode?: () => void;
    onDismissError?: () => void;
    onClearHistory?: () => void;
    agentsList: {
      agents: Array<{
        id: string;
        name?: string;
        identity?: { name?: string; avatarUrl?: string };
      }>;
      defaultId?: string;
    } | null;
    onAgentChange: (agentId: string) => void;
    onNavigateToAgent?: () => void;
    onSessionSelect?: (sessionKey: string) => void;
    onRevealWorkspaceFile?: (path: string) => void;
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
    githubPublication?: import("./chat-github-publication.ts").GitHubPublicationView;
  };

export function renderChat(props: ChatProps) {
  // The request session hosts the card; only sourceSessionKey names the requester.
  const approvalSourceSessionKey = props.inlineApproval?.sourceSessionKey;
  const approvalSourceSession = approvalSourceSessionKey
    ? props.sessions?.sessions.find((row) =>
        areUiSessionKeysEquivalent(row.key, approvalSourceSessionKey),
      )
    : undefined;
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
      ...props,
      loading: props.loading && !placementStartup,
      streamStartedAt: placementStartup?.startedAt ?? props.streamStartedAt,
      queue,
      pendingInputs: pendingInputs?.page.items,
      runActive: props.runActive === true,
      runWorking,
      startupLabel: chatStartupStatusLabel(props.startupStatus, placementStartup),
      questionPrompts: props.gatewayQuestionPrompts,
      agents: props.agentsList?.agents,
      onOpenImage: openImage,
      onRequestUpdate: requestUpdate,
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
      onCompanionPrefill:
        props.canSend && !props.suggestionComposer ? props.onCompanionPrefill : undefined,
      onOpenSession: props.onSessionSelect,
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
                  ${
                    pendingInputs &&
                    (pendingInputs.error ||
                      pendingInputs.page.nextBefore !== undefined ||
                      pendingInputs.before !== undefined)
                      ? html`<div
                          class="chat-history-error chat-history-error--inline"
                          role="status"
                        >
                          ${pendingInputs.error ? html`<span>${pendingInputs.error}</span>` : nothing}
                          ${
                            pendingInputs.page.nextBefore !== undefined
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
                              : nothing
                          }
                          ${
                            pendingInputs.before !== undefined
                              ? html`<button
                                  class="btn btn--sm"
                                  type="button"
                                  ?disabled=${pendingInputs.loading}
                                  @click=${() =>
                                    props.historyState && loadChatPendingInputs(props.historyState)}
                                >
                                  ${t("chat.pendingInputs.latest")}
                                </button>`
                              : nothing
                          }
                        </div>`
                      : nothing
                  }
                  ${scrollToBottomButton}
                  ${
                    props.inlineApproval && props.onApprovalDecision
                      ? html`<div class="chat-inline-approval">
                          ${renderExecApprovalCard({
                            approval: props.inlineApproval,
                            sourceSession: approvalSourceSession,
                            busy: props.approvalBusy === true,
                            canGrant: props.approvalCanGrant,
                            error: props.approvalErrors?.get(props.inlineApproval.id) ?? null,
                            variant: "inline",
                            onDecision: props.onApprovalDecision,
                          })}
                        </div>`
                      : nothing
                  }
                  ${gutterStack}
                  ${renderChatPullRequests({
                    pullRequests: props.pullRequests ?? [],
                    branch: props.pullRequestsBranch,
                    rateLimited: props.pullRequestsRateLimited === true,
                    expanded: props.pullRequestsExpanded === true,
                    onExpand: () => props.onExpandPullRequests?.(),
                    onDismiss: (pullRequest) => props.onDismissPullRequest?.(pullRequest),
                    onOpenSessionDiff: props.onOpenSessionDiff,
                    publication: props.githubPublication,
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
