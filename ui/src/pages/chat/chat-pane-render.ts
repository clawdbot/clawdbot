import { html, nothing } from "lit";
import { GATEWAY_SERVER_CAPS } from "../../../../packages/gateway-protocol/src/index.js";
import { findInlineApproval } from "../../app/approval-presentation.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { cancelQuestionPrompt, submitQuestionPrompt } from "../../app/question-prompt.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../../app/user-profile.ts";
import { hasSessionPresenceViewers } from "../../components/viewer-facepile.ts";
import { t } from "../../i18n/index.ts";
import {
  resolveControlUiFollowUpMode,
  resolveControlUiServerQueueMode,
} from "../../lib/chat/follow-up-mode.ts";
import {
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
} from "../../lib/gateway-methods.ts";
import {
  pickFreshestObserverDigest,
  projectSessionObserverDigest,
  resolveChatPaneObserverRunId,
} from "../../lib/observer-digest.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import { clearChatHistory } from "./chat-history.ts";
import { resolveChatMessageAccess } from "./chat-message-access.ts";
import { createChatModelSetupBanner, requiresChatModelSetup } from "./chat-model-setup.ts";
import { ChatPaneBrowserAnnotationRender } from "./chat-pane-browser-annotation-render.ts";
import {
  createChatPaneSessionActionCallbacks,
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import {
  SESSION_RAIL_SIDE_MIN_PANE_WIDTH,
  WORKSPACE_RAIL_MAX_WIDTH,
  WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH,
} from "./chat-pane-shared.ts";
import {
  renderSidebarRegion,
  resolveSidebarLayoutForBoard,
  restoreHiddenSidebarChat,
} from "./chat-pane-sidebar-layout.ts";
import {
  dismissChatError,
  resolveAssistantAttachmentAuthToken,
  resolveChatArtifactDownload,
} from "./chat-pane-state.ts";
import { dismissRealtimeTalkError } from "./chat-realtime.ts";
import { activeChatRunStartupStatus } from "./chat-run-startup.ts";
import { refreshChatCommands, refreshPageChat } from "./chat-state-refresh.ts";
import {
  resolveChatAgentId,
  resolveChatAvatarUrl,
  selectedChatSessionRow,
} from "./chat-state-route.ts";
import { renderChat, type ChatProps } from "./chat-view.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { renderChatImageLightbox } from "./components/chat-image-lightbox.ts";
import { chatPullRequestId, createPullRequestBranch } from "./components/chat-pull-requests.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  revealSessionWorkspaceFile,
} from "./components/chat-session-workspace.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";
import { hasAbortableSessionRun } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  activatePanel,
  closeSlot,
  detachPanelToColumn,
  isSidebarRegionCollapsed,
  mergePanelIntoColumn,
  sidebarPrimaryWidth,
  type SidebarSide,
  type SidebarSlotId,
} from "./sidebar-layout.ts";
import { resolveActiveRunOutputTokens, resolveChatProjectionRunId } from "./tool-stream.ts";
import { configureToolTitleFetcher } from "./tool-titles.ts";
import { workspaceResultConflictFromPlacement } from "./workspace-conflict.ts";

export class ChatPane extends ChatPaneBrowserAnnotationRender {
  override render() {
    const state = this.state;
    if (!state) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    void this.ensureTaskSuggestionCloudProfiles();
    const selectedSession = selectedChatSessionRow(state);
    const mutationAccess = readChatPaneMutationAccess(
      this.context.gateway.snapshot,
      state.sessionKey,
    );
    const projectedObserverDigest = projectSessionObserverDigest(
      selectedSession?.key ?? state.sessionKey,
      selectedSession?.observerDigest,
    );
    const observerDigest = pickFreshestObserverDigest(
      state.observerDigest,
      projectedObserverDigest,
    );
    const observerRunId = resolveChatPaneObserverRunId({
      localRunId: state.chatRunId,
      session: selectedSession,
      digest: observerDigest,
    });
    const workspaceConflict = workspaceResultConflictFromPlacement(selectedSession?.placement);
    const placement = selectedSession?.placement;
    const terminalReason = (placement as { terminalReason?: string } | undefined)?.terminalReason;
    const placementRunError = terminalReason
      ? { summary: t("chat.cloudWorkerFailed", { error: terminalReason }) }
      : null;
    const visibleWorkspaceConflict =
      workspaceConflict &&
      this.dismissedWorkspaceConflictRefs.get(selectedSession?.key ?? state.sessionKey) !==
        workspaceConflict.stagedResultRef
        ? workspaceConflict
        : undefined;
    const board = this.resolveBoardView();
    const sidebarLayout = resolveSidebarLayoutForBoard({
      board,
      hasDetail: state.sidebarContent !== null,
      layout: state.sidebarLayout,
      paneWidth: this.paneWidth,
    });
    state.chatFollowUpMode = resolveControlUiFollowUpMode(
      state.settings.chatFollowUpMode,
      resolveControlUiServerQueueMode(
        this.context.runtimeConfig.state.configSnapshot?.runtimeConfig,
        {
          configNeedsApply: this.context.runtimeConfig.state.configNeedsApply,
          effectiveMode: state.chatEffectiveQueueMode,
          sessionMetadataLoaded:
            selectedSession !== undefined || state.chatEffectiveQueueMode !== undefined,
          sessionMode: state.chatQueueModeOverride,
        },
      ),
    );
    const currentAgentId = resolveChatAgentId(state);
    const { catalogKey, fullMessageLoader, chatProps } = resolveChatMessageAccess(state);
    const overlays = this.context?.overlays;
    const approvalSnapshot = overlays?.snapshot;
    const inlineApproval = findInlineApproval(
      approvalSnapshot?.approvalQueue ?? [],
      state.sessionKey,
    );
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
    const modelSetupRequired = requiresChatModelSetup({
      catalog: catalogKey !== null,
      connected: state.connected,
      agentsLoaded: this.context.agents.state.agentsList !== null,
      selectedAgentFound: selectedAgent !== undefined,
      agentModel: agentDefaultModel,
    });
    const selectedSessionArchived = this.isCurrentSessionArchived(state);
    const cloudStartup = this.context.cloudStartup.get(state.sessionKey);
    const cloudStartupPending = cloudStartup !== null && cloudStartup.phase !== "failed";
    const sessionParticipationBlocked = this.sessionParticipationTracker.resolve({
      catalog: catalogKey !== null,
      listLoading: state.sessionsLoading,
      sessionKey: `${currentAgentId ?? ""}\0${state.sessionKey}`,
      session: selectedSession,
    });
    const gatewaySnapshot = this.context.gateway.snapshot;
    const multiIdentity = this.hasMultipleIdentities();
    const suggestionViewer =
      multiIdentity &&
      !selectedSessionArchived &&
      hasOperatorWriteAccess(gatewaySnapshot.hello?.auth ?? null) &&
      selectedSession?.visibility === "suggest" &&
      selectedSession.sharingRole === "viewer" &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.add") === true &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.list") === true;
    const disabledReason =
      sessionParticipationBlocked && !suggestionViewer
        ? t("chat.sessionSharing.readOnlyNotice")
        : null;
    const typingEnabled =
      multiIdentity &&
      hasOperatorWriteAccess(gatewaySnapshot.hello?.auth ?? null) &&
      !catalogKey &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.typing") === true &&
      hasSessionPresenceViewers(
        this.presencePayload,
        gatewaySnapshot.selfUser?.id,
        gatewaySnapshot.client?.instanceId,
        state.sessionKey,
      );
    // Never flash "view-only" while metadata loads; after loading, anything short
    // of a continuable session (failed lookups too) explains the disabled composer.
    const catalogDisabledReason =
      catalogKey && !this.catalogLoading && this.catalogSession?.canContinue !== true
        ? this.catalogHost?.kind === "node"
          ? t("chat.catalog.remoteViewOnly")
          : t("chat.catalog.unsupportedViewOnly")
        : null;
    const sidebarChatColumn = sidebarLayout.columns.find((column) =>
      column.panels.some((panel) => panel.slot === "chat"),
    );
    const sidebarRegionCollapsed = isSidebarRegionCollapsed(sidebarLayout, this.paneWidth);
    const chatLayoutWidth = sidebarRegionCollapsed
      ? this.paneWidth
      : (sidebarChatColumn?.width ?? sidebarPrimaryWidth(sidebarLayout, this.paneWidth));
    const sessionWorkspace = createSessionWorkspaceProps(state, {
      draftScope: this.presentationId,
      narrowLayout: chatLayoutWidth < WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH,
    });
    const railSideDocked =
      !sessionWorkspace.collapsed &&
      !sessionWorkspace.narrowLayout &&
      sessionWorkspace.dock !== "bottom";
    // The workspace rail claims the first side slot; tasks need room for both columns.
    const backgroundTasks = createBackgroundTasksProps(state, {
      narrowLayout:
        chatLayoutWidth <
        WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH + (railSideDocked ? WORKSPACE_RAIL_MAX_WIDTH : 0),
    });
    const tasksSideDocked = !backgroundTasks.collapsed && !backgroundTasks.narrowLayout;
    // Only side-docked rails narrow the conversation region.
    const sideRailCount = (railSideDocked ? 1 : 0) + (tasksSideDocked ? 1 : 0);
    const chatMainWidth = chatLayoutWidth - sideRailCount * WORKSPACE_RAIL_MAX_WIDTH;
    const selfUser = resolveCurrentSelfUser({
      snapshotUser: gatewaySnapshot.selfUser,
      presenceEntries: readPresenceEntries(gatewaySnapshot.hello?.snapshot),
      presenceInstanceId: gatewaySnapshot.client?.instanceId,
    });
    const runOutputTokens = resolveActiveRunOutputTokens({
      localRunId: state.chatRunId,
      activeRunIds: selectedSession?.activeRunIds,
      usageByRun: state.chatRunUsageById,
    });
    const projectionRunId = resolveChatProjectionRunId({
      localRunId: state.chatRunId,
      activeRunIds: selectedSession?.activeRunIds,
      queue: state.chatQueue,
    });
    const attachmentReads = this.chatState.attachmentReads;
    const attachmentReadSignal = attachmentReads.readSignal;
    const sessionActionCallbacks = createChatPaneSessionActionCallbacks({
      getSnapshot: () => this.context.gateway.snapshot,
      hasLocalRun: () => Boolean(state.chatRunId),
      sessionParticipationBlocked,
      onDenied: (reason) => this.publishHeaderError(reason),
      onCompact: () => void state.handleSendChat("/compact"),
      onAbort: () => void state.handleAbortChat({ preserveDraft: true }),
      onRewind: (entryId) => this.rewindToMessage(entryId),
      onFork: (entryId) => this.forkFromMessage(entryId),
      onReset: () => void clearChatHistory(state),
    });
    const props: ChatProps = {
      transcript: this.transcript,
      backgroundTaskTranscript: this.backgroundTaskTranscript,
      paneId: this.presentationId,
      sessionKey: state.sessionKey,
      announceTranscript: this.active && this.presented,
      onSessionKeyChange: (next) => {
        this.onPaneSessionChange?.(this.paneId, next);
      },
      thinkingLevel: state.chatThinkingLevel,
      autoExpandToolCalls: state.chatVerboseLevel === "full",
      showThinking: state.settings.chatShowThinking,
      showToolCalls: state.settings.chatShowToolCalls,
      persistCommentary: state.settings.chatPersistCommentary !== false,
      loading: catalogKey ? this.catalogLoading : state.chatLoading,
      sending:
        cloudStartupPending ||
        state.chatSending ||
        this.sessionSuggestionAddOperation !== undefined,
      cloudStartup,
      onRetryCloudStartup: cloudStartup?.retryable
        ? () => this.context.cloudStartup.retry(state.sessionKey)
        : undefined,
      canAbort: sessionParticipationBlocked ? false : hasAbortableSessionRun(state),
      runStatus: state.chatRunStatus,
      startupStatus: activeChatRunStartupStatus(state.chatRunStartup),
      waitingApproval: state.waitingApprovalStatuses.size > 0,
      compactionStatus: state.compactionStatus,
      fallbackStatus: state.fallbackStatus,
      planStatus: state.planStatus,
      observerDigest: catalogKey ? null : observerDigest,
      sessionRailReady: !catalogKey && this.sessionRailReady,
      observerRunId: catalogKey ? null : observerRunId,
      observerStartedAt: selectedSession?.startedAt ?? state.chatStreamStartedAt ?? undefined,
      observerLastReadAt: selectedSession?.lastReadAt,
      sessionRailCompanion: catalogKey
        ? undefined
        : this.sessionCompanionThreads.view(state.sessionKey),
      ...this.sessionRailCommandProps(state.sessionKey),
      sessionRailMode: this.selectedSessionRailMode(state.sessionKey),
      sessionRailDocked: !catalogKey && chatMainWidth >= SESSION_RAIL_SIDE_MIN_PANE_WIDTH,
      onSessionRailSubmit: (question) => void this.submitSessionCompanionQuestion(question),
      onSessionRailDraftChange: (draft) =>
        this.sessionCompanionThreads.setDraft(state.sessionKey, draft),
      onSessionRailClear: () => void this.clearSessionCompanion(),
      onSessionRailModeChange: (mode) => {
        if (state.sessionKey !== this.sessionRailModeSessionKey || mode !== this.sessionRailMode) {
          this.sessionRailModeSessionKey = state.sessionKey;
          this.sessionRailMode = mode;
        }
      },
      // Unconditional: catalog chats never render the rail (sessionRailReady is
      // forced false), and a hide/show from any surface must reach the gateway.
      onObserverVisibilityChange: this.setSessionObserverVisibility,
      gatewayQuestionPrompts: catalogKey || sessionParticipationBlocked ? [] : this.questionPrompts,
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
      toolMessages: catalogKey ? [] : state.chatToolMessages,
      streamSegments: catalogKey ? [] : state.chatStreamSegments,
      stream: catalogKey ? null : state.chatStream,
      streamStartedAt: catalogKey ? null : state.chatStreamStartedAt,
      runId: catalogKey ? null : projectionRunId,
      runOutputTokens: catalogKey ? null : runOutputTokens,
      assistantAvatarUrl: resolveChatAvatarUrl(state),
      sendShortcut: state.settings.chatSendShortcut,
      followUpMode: state.chatFollowUpMode,
      draft: state.chatMessage,
      queue: state.chatQueue,
      queuedOutboxCount: state.chatQueue.filter((item) => !item.pendingRunId).length,
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
      offline: gatewaySnapshot.offlineStable,
      gatewayClient: state.client,
      composerHoldToRecord: state.settings.composerHoldToRecord,
      suggestionComposer: suggestionViewer,
      typingActors: multiIdentity ? this.typingActorViews() : [],
      onTypingChange: typingEnabled ? (typing) => this.sendTypingState(typing) : undefined,
      canSend: catalogKey
        ? this.catalogSession?.canContinue === true
        : !modelSetupRequired &&
          !selectedSessionArchived &&
          (!sessionParticipationBlocked || suggestionViewer) &&
          !cloudStartupPending,
      disabledReason: catalogDisabledReason ?? disabledReason,
      disabledBanner:
        selectedSessionArchived && !catalogDisabledReason
          ? {
              kind: "composer-replacement",
              text: t("chat.archivedSessionDisabled"),
              actionLabel: t("common.unarchive"),
              disabledReason: mutationAccess.unarchive.allowed
                ? undefined
                : mutationAccess.unarchive.reason,
              onAction: () => {
                if (mutationAccess.unarchive.allowed) {
                  void this.restoreArchivedSession(state.sessionKey);
                }
              },
            }
          : modelSetupRequired
            ? createChatModelSetupBanner(() => this.context.navigate("model-setup"))
            : undefined,
      modelSetupRequired: modelSetupRequired && !selectedSessionArchived,
      onModelSetup: () => this.context.navigate("model-setup"),
      error: state.lastError,
      runError: catalogKey ? null : (state.chatRunError ?? placementRunError),
      inlineApproval: sessionParticipationBlocked ? null : inlineApproval,
      approvalBusy: approvalSnapshot?.approvalBusy,
      approvalErrors: approvalSnapshot?.approvalErrors,
      approvalNowMs: approvalSnapshot?.approvalNowMs,
      onApprovalDecision:
        overlays && !sessionParticipationBlocked
          ? (approvalId, decision) => overlays.decideApproval(decision, approvalId)
          : undefined,
      workspaceConflict: visibleWorkspaceConflict,
      onDismissWorkspaceConflict:
        visibleWorkspaceConflict && selectedSession
          ? () => {
              this.dismissedWorkspaceConflictRefs.set(
                selectedSession.key,
                visibleWorkspaceConflict.stagedResultRef,
              );
              this.requestUpdate();
            }
          : undefined,
      sessions: state.sessionsResult,
      toolOverrides: selectedSession?.toolOverrides,
      capabilityMenu: catalogKey
        ? undefined
        : this.composerCapabilities.props(this.context, state, selectedSession, currentAgentId),
      swarmSessions: this.swarmHydrator?.rows ?? [],
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
        : renderChatPaneComposerControls({
            state,
            selectedSession,
            agentDefaultModel,
            modelAccess: mutationAccess.model,
            effortAccess: mutationAccess.effort,
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
      sessionSuggestions: multiIdentity ? this.sessionSuggestions : [],
      sessionSuggestionRole: this.sessionSuggestionRole,
      sessionSuggestionBusyIds: this.sessionSuggestionBusyIds,
      sessionSuggestionsArchived: selectedSessionArchived,
      canResolveSessionSuggestions:
        state.connected &&
        hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.suggestions.resolve") ===
          true,
      onResolveSessionSuggestion: (suggestion, resolution) =>
        void this.resolveCurrentSessionSuggestion(suggestion, resolution),
      canAcceptTaskSuggestions:
        state.connected &&
        hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "taskSuggestions.accept") === true,
      canAcceptTaskSuggestionModes:
        isGatewayCapabilityAdvertised(
          this.context.gateway.snapshot,
          GATEWAY_SERVER_CAPS.TASK_SUGGESTIONS_ACCEPT_MODES,
        ) === true,
      canDismissTaskSuggestions:
        state.connected &&
        hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "taskSuggestions.dismiss") ===
          true,
      taskSuggestionCloudProfiles: this.taskSuggestionCloudProfiles,
      taskSuggestionCopiedIds: this.taskSuggestionCopiedIds,
      onCopyTaskSuggestionPrompt: (suggestion) => void this.copyTaskSuggestionPrompt(suggestion),
      onAcceptTaskSuggestion: (suggestion, mode, cloudProfileId) =>
        void this.acceptTaskSuggestion(suggestion, mode, cloudProfileId),
      onDismissTaskSuggestion: (suggestion) => void this.dismissTaskSuggestion(suggestion),
      onOpenWorkspaceFile: (target) => openSessionWorkspaceFile(state, target),
      onRevealWorkspaceFile: (path) => revealSessionWorkspaceFile(state, path),
      onRefresh: () => {
        if (catalogKey) {
          void this.loadCatalogSession(catalogKey, false);
          return;
        }
        state.resetToolStream();
        this.reconcileWaitingApprovalSnapshot();
        void refreshPageChat(state, { awaitHistory: true, scheduleScroll: false });
      },
      onChatScroll: (event) => this.handleTranscriptScroll(event),
      onHistoryIntent: (event) => this.handleTranscriptHistoryIntent(event),
      // Metadata can resize a committed row; re-enter the scroll owner so the follow lock wins.
      onAssistantAttachmentLoaded: () => scheduleChatScroll(state),
      getDraft: () => state.chatMessage,
      onDraftChange: state.handleChatDraftChange,
      onRequestUpdate: state.requestUpdate,
      onHistoryKeydown: state.handleChatInputHistoryKey,
      onSlashIntent: () => refreshChatCommands(state),
      showNewMessages: state.chatNewMessagesBelow,
      onScrollToBottom: state.scrollToBottom,
      attachments: state.chatAttachments,
      getAttachments: () => state.chatAttachments,
      pendingAttachmentReads: attachmentReads.pendingReads,
      getPendingAttachmentReads: () => attachmentReads.pendingReads,
      readSignal: attachmentReadSignal,
      onPendingReadsChange: (delta) => attachmentReads.updatePending(attachmentReadSignal, delta),
      onAttachmentsChange: (next) => {
        state.chatAttachments = next;
        state.requestUpdate?.();
      },
      onRemoveAttachment: this.removeBrowserAnnotation,
      onSend: () =>
        catalogKey
          ? void this.continueCatalogSession(catalogKey)
          : suggestionViewer
            ? void this.addCurrentSessionSuggestion()
            : void state.handleSendChat(),
      onCompact: sessionActionCallbacks.onCompact,
      onOpenSessionCheckpoints: () => {
        const search = new URLSearchParams({ session: state.sessionKey });
        if (selectedSessionArchived) {
          search.set("status", "archived");
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
      onAbort: sessionActionCallbacks.onAbort,
      onQueueRemove: state.removeQueuedMessage,
      onQueueRetry: (id) => void state.retryQueuedChatMessage(id),
      onQueueSteer: sessionParticipationBlocked
        ? undefined
        : (id) => void state.steerQueuedChatMessage(id),
      onQueueMove: sessionParticipationBlocked ? undefined : state.moveQueuedChatMessage,
      queuedEdit: {
        editingId: activeQueuedMessageEdit(state)?.id ?? null,
        onEdit: sessionParticipationBlocked ? undefined : state.editQueuedChatMessage,
        onCancel: state.cancelQueuedChatMessageEdit,
      },
      onGoalCommand: (command) => void state.handleSendChat(command),
      onCompanionQuestion: (question) => void this.submitSessionCompanionQuestion(question),
      onCompanionPrefill: this.prefillSessionCompanionQuestion,
      replyTarget: state.chatReplyTarget ?? null,
      onClearReply: () => {
        state.chatReplyTarget = null;
        state.requestUpdate?.();
      },
      onSetReply: (target) => {
        state.chatReplyTarget = target;
        state.requestUpdate?.();
      },
      onRewindMessage: sessionActionCallbacks.onRewindMessage,
      onForkMessage: sessionActionCallbacks.onForkMessage,
      onNewSession: () => void this.createSession(),
      onClearHistory: sessionActionCallbacks.onClearHistory,
      agentsList: state.agentsList,
      currentAgentId,
      ...chatProps,
      onAgentChange: (agentId) => {
        const nextSessionKey = buildAgentMainSessionKey({ agentId });
        this.onPaneSessionChange?.(this.paneId, nextSessionKey);
      },
      onSessionSelect: (next) => {
        this.onPaneSessionChange?.(this.paneId, next);
      },
      canvasPluginSurfaceUrl: state.canvasPluginSurfaceUrl,
      boardProvider: board.provider,
      onOpenSidebar: state.handleOpenSidebar,
      onRequestOpenImage: state.beginImageOpen,
      onOpenImage: state.handleOpenImage,
      assistantName: state.assistantName,
      assistantAvatar: state.assistantAvatar,
      userId: selfUser?.id ?? null,
      userName: selfUser?.name ?? state.userName,
      userAvatar: selfUser?.avatarUrl ?? state.userAvatar,
      localMediaPreviewRoots: state.localMediaPreviewRoots,
      embedSandboxMode: state.embedSandboxMode,
      allowExternalEmbedUrls: state.allowExternalEmbedUrls,
      chatMessageMaxWidth: state.settings.chatMessageMaxWidth,
      assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state as never),
      resolveArtifactDownload: (params) => resolveChatArtifactDownload(state, params),
      basePath: state.basePath,
      gatewayUrl: state.settings.gatewayUrl,
    };
    const chat = renderChat(props);
    const primary = this.renderBoardPrimary(board, chat);
    const discussion = this.buildSessionDiscussionPanel(state, state.sessionKey.trim());
    const panelTemplates = {
      chat,
      ...(state.sidebarContent
        ? {
            detail: html`<openclaw-chat-detail-panel
              class="chat-sidebar"
              .content=${state.sidebarContent}
              .loadFullMessage=${fullMessageLoader}
              .canvasPluginSurfaceUrl=${state.canvasPluginSurfaceUrl}
              .embedSandboxMode=${state.embedSandboxMode}
              .allowExternalEmbedUrls=${state.allowExternalEmbedUrls}
              .onOpenWorkspaceFile=${(target: { path: string; line?: number | null }) =>
                openSessionWorkspaceFile(state, target)}
              .onRevealInWorkspace=${(path: string) => revealSessionWorkspaceFile(state, path)}
              .onOpenImage=${(item: Parameters<typeof state.handleOpenImage>[0]) =>
                state.handleOpenImage(item, state.beginImageOpen())}
              .embedded=${true}
              @chat-detail-panel-close=${() => state.handleCloseSidebar()}
            ></openclaw-chat-detail-panel>`,
          }
        : {}),
      ...(discussion
        ? {
            discussion: html`<openclaw-session-discussion
              .sessionKey=${discussion.sessionKey}
              .canOpen=${discussion.canOpen}
              .sourceGeneration=${this.connectionGeneration}
              .loadInfo=${discussion.loadInfo}
              .openDiscussion=${discussion.openDiscussion}
              .onStateChange=${discussion.onStateChange}
            ></openclaw-session-discussion>`,
          }
        : {}),
    };
    const sidebarCallbacks = {
      activatePanel: (panelId: string) => {
        state.updateSidebarLayout(activatePanel(state.sidebarLayout, panelId));
        state.updateSidebarActivePanel(panelId);
      },
      closeSlot: (slot: SidebarSlotId) => {
        if (slot === "chat") {
          this.handleBoardDockChange("hidden");
          return;
        }
        if (slot === "discussion") {
          this.sessionDiscussionOpenUrls.delete(state.sessionKey.trim());
        }
        state.updateSidebarLayout(closeSlot(state.sidebarLayout, slot));
      },
      detachPanel: (panelId: string, side: SidebarSide, columnIndex: number) => {
        const moved = restoreHiddenSidebarChat({
          activatedPanelId: panelId,
          movedLayout: detachPanelToColumn(sidebarLayout, panelId, side, columnIndex),
          renderedLayout: sidebarLayout,
          storedLayout: state.sidebarLayout,
        });
        this.commitSidebarPanelMove(moved, panelId, side, board);
      },
      mergePanel: (panelId: string, targetColumnId: string, panelIndex: number) => {
        const target = sidebarLayout.columns.find((column) => column.id === targetColumnId);
        const merged = restoreHiddenSidebarChat({
          activatedPanelId: panelId,
          movedLayout: mergePanelIntoColumn(sidebarLayout, panelId, targetColumnId, panelIndex),
          renderedLayout: sidebarLayout,
          storedLayout: state.sidebarLayout,
        });
        if (target) {
          this.commitSidebarPanelMove(merged, panelId, target.side, board);
        }
      },
      resizeColumn: (columnId: string, width: number) => {
        this.commitSidebarColumnResize(sidebarLayout, columnId, width);
      },
    };
    const content = renderSidebarRegion({
      availableWidth: this.paneWidth,
      callbacks: sidebarCallbacks,
      discussionOpenUrl: discussion?.openUrl ?? null,
      focusPanelId: state.sidebarFocusPanelId,
      focusVersion: state.sidebarFocusVersion,
      layout: sidebarLayout,
      narrow: this.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX,
      panelMutationEnabled: {
        chat: Boolean(board.activeTabId) && board.provider.canMutate,
      },
      panelTemplates,
      primary,
      sessionKey: state.sessionKey,
    });
    return html`${this.renderPaneHeader(
      sessionWorkspace,
      backgroundTasks,
      selectedSession,
      Boolean(catalogKey),
      selectedAgent?.workspace,
      selectedAgent?.workspaceGit === true,
    )}${content}${renderChatImageLightbox(
      state.imageLightbox,
      state.handleCloseImage,
    )}${this.renderResetConfirmation()}`;
  }
}
