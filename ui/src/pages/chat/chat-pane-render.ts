import { html, nothing } from "lit";
import { GATEWAY_SERVER_CAPS } from "../../../../packages/gateway-protocol/src/index.js";
import { isDesktopPanelAvailable } from "../../app/app-shell-chrome.ts";
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
import { isChatModelUnavailable } from "../../lib/chat/model-select-state.ts";
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
import { requiresChatModelSetup } from "./chat-model-setup.ts";
import { ChatPaneBrowserAnnotationRender } from "./chat-pane-browser-annotation-render.ts";
import {
  availableSidebarSlots,
  companionRailTemplate,
  discussionPanelTemplate,
  embeddedSurfaceTemplates,
  sidePanelHeaderActions,
} from "./chat-pane-embedded-panels.ts";
import {
  createChatPaneSessionActionCallbacks,
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import {
  renderSidebarRegion,
  resolveSidebarLayoutForBoard,
  sidebarRegionCallbacks,
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
import { renderBackgroundTasksRail } from "./components/chat-background-tasks-render.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { detailSlotOpen, renderChatDetailSlot } from "./components/chat-detail-slot.ts";
import { renderChatImageLightbox } from "./components/chat-image-lightbox.ts";
import { chatPullRequestId, createPullRequestBranch } from "./components/chat-pull-requests.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  renderSessionWorkspaceRail,
  revealSessionWorkspaceFile,
} from "./components/chat-session-workspace.ts";
import type { SidebarPanelTemplates } from "./components/chat-sidebar-region-types.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";
import { hasAbortableSessionRun } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  closeSlot,
  openSlot,
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
    const selectedSessionId = selectedSession?.sessionId?.trim() || undefined;
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
    const diskSpace = placement?.state === "active" ? placement.diskSpace : undefined;
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
      layout: state.sidebarLayout,
      paneWidth: this.paneWidth,
    });
    const hasPanelSlot = (slot: SidebarSlotId) =>
      sidebarLayout.columns[0]?.panels.some((panel) => panel.slot === slot) === true;
    const openPanelSlot = (slot: SidebarSlotId) => {
      state.updateSidebarLayout(openSlot(state.sidebarLayout, slot));
      if (slot === "companion") {
        this.setSessionObserverVisibility(true);
      }
    };
    const closePanelSlot = (slot: SidebarSlotId) => {
      if (slot === "companion") {
        this.setSessionObserverVisibility(false);
      }
      state.updateSidebarLayout(closeSlot(state.sidebarLayout, slot));
    };
    const togglePanelSlot = (slot: SidebarSlotId) =>
      hasPanelSlot(slot) ? closePanelSlot(slot) : openPanelSlot(slot);
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
    const inlineApproval = findInlineApproval(
      overlays?.snapshot?.approvalQueue ?? [],
      state.sessionKey,
    );
    // Tool rows consult the global title store while rendering. Requests capture
    // session + agent at schedule time, so another pane cannot re-route them.
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
    const modelUnavailable = isChatModelUnavailable(
      selectedSession?.model ?? agentDefaultModel,
      selectedSession?.modelProvider,
      state.chatModelCatalog,
    );
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
    const restartRecoveryTombstoned = selectedSession?.restartRecoveryStatus === "tombstoned";
    const multiIdentity = this.hasMultipleIdentities();
    const suggestionViewer =
      multiIdentity &&
      !selectedSessionArchived &&
      hasOperatorWriteAccess(gatewaySnapshot.hello?.auth ?? null) &&
      selectedSession?.visibility === "suggest" &&
      selectedSession.sharingRole === "viewer" &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.add") === true &&
      isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.list") === true;
    // Every composer-disabling gate needs a visible reason here or a banner in
    // sessionDisabledBanner; a silently disabled composer is a silent failure.
    const disabledReason = modelUnavailable
      ? `${t("modelSetup.failure.auth")}. ${t("modelSetup.failureGuidance.auth")}`
      : sessionParticipationBlocked && !suggestionViewer
        ? t("chat.sessionSharing.readOnlyNotice")
        : cloudStartupPending
          ? t("newSession.starting")
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
    // Do not flash view-only while metadata loads; failed lookups still explain
    // why the composer is disabled.
    const catalogDisabledReason =
      catalogKey && !this.catalogLoading && this.catalogSession?.canContinue !== true
        ? this.catalogHost?.kind === "node"
          ? t("chat.catalog.remoteViewOnly")
          : t("chat.catalog.unsupportedViewOnly")
        : null;
    const sessionWorkspaceBase = createSessionWorkspaceProps(state, {
      draftScope: this.presentationId,
      expanded: hasPanelSlot("workspace"),
      narrowLayout: false,
    });
    const sessionWorkspace = {
      ...sessionWorkspaceBase,
      collapsed: !hasPanelSlot("workspace"),
      narrowLayout: false,
      onToggleCollapsed: () => togglePanelSlot("workspace"),
      onToggleTerminal: state.terminalAvailable ? () => togglePanelSlot("terminal") : undefined,
      onToggleBrowser: state.browserPanelAvailable ? () => togglePanelSlot("browser") : undefined,
      onToggleDesktop: isDesktopPanelAvailable(gatewaySnapshot)
        ? () => togglePanelSlot("desktop")
        : undefined,
    };
    const backgroundTasksBase = createBackgroundTasksProps(state, {
      narrowLayout: false,
      openTaskId:
        state.sidebarContent?.kind === "task" && detailSlotOpen(sidebarLayout)
          ? state.sidebarContent.taskId
          : undefined,
      onOpenTaskDetail: (task) => state.handleOpenSidebar({ kind: "task", taskId: task.id }),
    });
    const backgroundTasks = {
      ...backgroundTasksBase,
      collapsed: !hasPanelSlot("tasks"),
      narrowLayout: false,
      onToggleCollapsed: () => togglePanelSlot("tasks"),
    };
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
    const historyHasMore = catalogKey
      ? Boolean(this.catalogCursor)
      : state.chatHistoryPagination.hasMore;
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
        this.recoveringSession ||
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
        historyHasMore || this.loadingOlder
          ? {
              hasMore: historyHasMore,
              loading: this.loadingOlder,
              onShowEarlier: () => void this.showEarlierMessages(),
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
          !modelUnavailable &&
          !selectedSessionArchived &&
          !restartRecoveryTombstoned &&
          (!sessionParticipationBlocked || suggestionViewer) &&
          !cloudStartupPending,
      disabledReason: catalogDisabledReason ?? disabledReason,
      disabledBanner: this.sessionDisabledBanner({
        catalogDisabledReason,
        modelSetupRequired,
        restartRecoveryTombstoned,
        selectedSessionArchived,
        selectedSessionId,
        sessionKey: state.sessionKey,
        unarchiveAccess: mutationAccess.unarchive,
      }),
      modelSetupRequired:
        modelSetupRequired && !selectedSessionArchived && !restartRecoveryTombstoned,
      onModelSetup: () => this.context.navigate("model-setup"),
      error: state.lastError,
      diskSpace,
      runError: catalogKey ? null : (state.chatRunError ?? placementRunError),
      inlineApproval: sessionParticipationBlocked ? null : inlineApproval,
      approvalBusy: overlays?.snapshot?.approvalBusy,
      approvalErrors: overlays?.snapshot?.approvalErrors,
      approvalNowMs: overlays?.snapshot?.approvalNowMs,
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
            onModelSetup: () => this.context.navigate("model-setup"),
          }),
      backgroundTasks: catalogKey ? undefined : backgroundTasks,
      taskSuggestions: this.taskSuggestions,
      pullRequests: this.sessionPullRequests.filter(
        (pullRequest) => !this.dismissedSessionPullRequestIds.has(chatPullRequestId(pullRequest)),
      ),
      pullRequestsBranch: createPullRequestBranch(
        this.sessionPullRequests,
        this.sessionPullRequestsBranch,
      ),
      // A dismissed open PR still exists, so the row must not offer a duplicate.
      pullRequestsRateLimited: this.sessionPullRequestsRateLimited,
      pullRequestsExpanded: this.sessionPullRequestsExpanded,
      onOpenSessionDiff: sessionWorkspace.onOpenDiff,
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
      // Metadata can resize a committed row; re-enter the scroll owner so the
      // follow lock wins.
      onAssistantAttachmentLoaded: () => scheduleChatScroll(state),
      getDraft: () => state.chatMessage,
      onDraftChange: state.handleChatDraftChange,
      onRequestUpdate: state.requestUpdate,
      onHistoryKeydown: state.handleChatInputHistoryKey,
      onSlashIntent: () => refreshChatCommands(state),
      showNewMessages: state.chatNewMessagesBelow,
      onScrollToBottom: state.scrollToBottom,
      attachments: state.chatAttachments,
      attachmentLimits: state.hello?.policy?.attachments,
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
      onSend: (followUpModeOverride) =>
        catalogKey
          ? void this.continueCatalogSession(catalogKey)
          : suggestionViewer
            ? void this.addCurrentSessionSuggestion()
            : void state.handleSendChat(
                undefined,
                followUpModeOverride ? { followUpMode: followUpModeOverride } : undefined,
              ),
      onCompact: sessionActionCallbacks.onCompact,
      // Checkpoint deep-link carries the archived filter so the row stays findable.
      onOpenSessionCheckpoints: () => {
        const status = selectedSessionArchived ? "&status=archived" : "";
        this.context.navigate("sessions", {
          search: `?session=${encodeURIComponent(state.sessionKey)}${status}`,
        });
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
      replyMessageAccess: catalogKey ? undefined : this.currentReplyMessageAccess(state.sessionKey),
      onRewindMessage: sessionActionCallbacks.onRewindMessage,
      onForkMessage: sessionActionCallbacks.onForkMessage,
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
    };
    const header = this.renderPaneHeader(
      sessionWorkspace,
      backgroundTasks,
      selectedSession,
      Boolean(catalogKey),
      selectedAgent?.workspace,
      selectedAgent?.workspaceGit === true,
    );
    const chat = renderChat({ ...props, header: board.face === "dashboard" ? nothing : header });
    // Keep this root stable across board face changes so the guarded board runtime
    // remains connected while Chat is active.
    const primary = html`<div class="chat-pane-primary-column">
      ${board.face === "dashboard" ? header : nothing}${this.renderBoardPrimary(board, chat)}
    </div>`;
    const discussion = this.buildSessionDiscussionPanel(state, state.sessionKey.trim());
    const desktopAvailable = isDesktopPanelAvailable(gatewaySnapshot);
    const companionThread = this.sessionCompanionThreads.view(state.sessionKey, currentAgentId);
    const panelTemplates: SidebarPanelTemplates = {
      chat,
      workspace: renderSessionWorkspaceRail(sessionWorkspace, { embedded: true }),
      tasks: renderBackgroundTasksRail(backgroundTasks, { embedded: true }),
      companion: companionRailTemplate({
        state,
        digest: observerDigest ?? null,
        activeRunId: observerRunId ?? null,
        startedAt: selectedSession?.startedAt ?? state.chatStreamStartedAt ?? undefined,
        lastReadAt: selectedSession?.lastReadAt,
        pullRequests: this.sessionPullRequests,
        companion: companionThread,
        onSubmit: (question) => void this.submitSessionCompanionQuestion(question),
        onDraftChange: (draft) =>
          this.sessionCompanionThreads.setDraft(state.sessionKey, draft, currentAgentId),
        onVisibilityChange: this.setSessionObserverVisibility,
      }),
      ...embeddedSurfaceTemplates({
        state,
        agentId: currentAgentId,
        desktopAvailable,
      }),
      ...(state.sidebarContent
        ? {
            detail: renderChatDetailSlot({
              backgroundTasks,
              chat: props,
              content: state.sidebarContent,
              fullMessageLoader,
              host: state,
              layout: sidebarLayout,
              transcript: this.taskSidebarTranscript,
            }),
          }
        : {}),
      ...discussionPanelTemplate(discussion, this.connectionGeneration),
    };
    const availableSlots = availableSidebarSlots({
      state,
      desktopAvailable,
      hasDiscussion: discussion !== null,
      hasBoard: board.hasBoard,
    });
    const content = renderSidebarRegion({
      availableWidth: this.paneWidth,
      availableSlots,
      callbacks: sidebarRegionCallbacks({
        state,
        closePanelSlot,
        openPanelSlot,
        hideBoard: () => this.handleBoardDockChange("hidden"),
        forgetDiscussionUrl: () => this.sessionDiscussionOpenUrls.delete(state.sessionKey.trim()),
        resizePanel: (columnId, size) =>
          this.commitSidebarPanelResize(sidebarLayout, columnId, size),
        setPanelOpen: (open) => this.setChatSidePanelOpen(open),
      }),
      layout: sidebarLayout,
      panelActions: sidePanelHeaderActions({
        connected: state.connected,
        pendingQuestion: companionThread.pendingQuestion,
        discussionOpenUrl: discussion?.openUrl ?? null,
        onClearCompanion: () => void this.clearSessionCompanion(),
      }),
      narrow: this.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX,
      panelTemplates,
      primary,
    });
    return html`${content}${renderChatImageLightbox(
      state.imageLightbox,
      state.handleCloseImage,
    )}${this.renderResetConfirmation()}`;
  }
}
