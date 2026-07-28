import {
  activeChatRunStartupStatus,
  buildAgentMainSessionKey,
  cancelQuestionPrompt,
  chatPullRequestId,
  clearChatHistory,
  configureToolTitleFetcher,
  createBackgroundTasksProps,
  createPullRequestBranch,
  createSessionWorkspaceProps,
  dismissChatError,
  dismissRealtimeTalkError,
  findInlineApproval,
  hasAbortableSessionRun,
  hasOperatorAdminAccess,
  hasOperatorWriteAccess,
  hasSessionPresenceViewers,
  html,
  isGatewayMethodAdvertised,
  nothing,
  openSessionWorkspaceFile,
  parseCatalogSessionKey,
  pickFreshestObserverDigest,
  readPresenceEntries,
  refreshChatCommands,
  refreshPageChat,
  renderBoardSessionSurface,
  renderChat,
  renderChatControls,
  resolveActiveRunOutputTokens,
  resolveChatProjectionRunId,
  resolveAssistantAttachmentAuthToken,
  resolveChatAgentId,
  resolveChatAvatarUrl,
  resolveControlUiFollowUpMode,
  resolveControlUiServerQueueMode,
  resolveCurrentSelfUser,
  resolveChatPaneObserverRunId,
  revealSessionWorkspaceFile,
  scopedAgentParamsForSession,
  selectedChatSessionRow,
  submitQuestionPrompt,
  switchChatFastMode,
  switchChatModel,
  switchChatThinkingLevel,
  t,
  SIDEBAR_NARROW_BREAKPOINT_PX,
  activatePanel,
  closeSlot,
  detachPanelToColumn,
  isSidebarRegionCollapsed,
  mergePanelIntoColumn,
  sidebarPrimaryWidth,
  workspaceResultConflictFromPlacement,
  type BoardViewCallbacks,
  type ChatProps,
  type SessionObserverDigest,
  type SidebarSide,
  type SidebarSlotId,
} from "./chat-pane-deps.ts";
import { ChatPaneHeaderRender } from "./chat-pane-header-render.ts";
import {
  SESSION_RAIL_DOCK_MIN_WIDTH,
  WORKSPACE_RAIL_MAX_WIDTH,
  WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH,
} from "./chat-pane-shared.ts";
import {
  createSidebarFullMessageLoader,
  renderSidebarRegion,
  resolveSidebarLayoutForBoard,
  restoreHiddenSidebarChat,
} from "./chat-pane-sidebar-layout.ts";
import { renderChatImageLightbox } from "./components/chat-image-lightbox.ts";

export class ChatPaneRender extends ChatPaneHeaderRender {
  override render() {
    const state = this.state;
    if (!state) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const selectedSession = selectedChatSessionRow(state);
    const projectedObserverDigest: SessionObserverDigest | null = selectedSession?.observerDigest
      ? {
          sessionKey: selectedSession.key,
          ...(selectedSession.observerDigest.agentId
            ? { agentId: selectedSession.observerDigest.agentId }
            : {}),
          runId: selectedSession.observerDigest.runId,
          revision: selectedSession.observerDigest.revision,
          updatedAt: selectedSession.observerDigest.updatedAt,
          headline: selectedSession.observerDigest.headline,
          health: selectedSession.observerDigest.health,
        }
      : null;
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
    const runtimeConfigState = this.context.runtimeConfig.state;
    const configSnapshot = runtimeConfigState.configSnapshot;
    const serverQueueMode = resolveControlUiServerQueueMode(configSnapshot?.runtimeConfig, {
      configNeedsApply: runtimeConfigState.configNeedsApply,
      effectiveMode: state.chatEffectiveQueueMode,
      sessionMetadataLoaded:
        selectedSession !== undefined || state.chatEffectiveQueueMode !== undefined,
      sessionMode: state.chatQueueModeOverride,
    });
    state.chatFollowUpMode = resolveControlUiFollowUpMode(
      state.settings.chatFollowUpMode,
      serverQueueMode,
    );
    const currentAgentId = resolveChatAgentId(state);
    const catalogKey = parseCatalogSessionKey(state.sessionKey);
    const overlays = this.context?.overlays;
    const approvalSnapshot = overlays?.snapshot;
    const inlineApproval = this.active
      ? findInlineApproval(approvalSnapshot?.approvalQueue ?? [], state.sessionKey)
      : null;
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
    const selectedSessionArchived = this.isCurrentSessionArchived(state);
    const sessionParticipationBlocked = this.sessionParticipationTracker.resolve({
      catalog: catalogKey !== null,
      listLoading: state.sessionsLoading,
      sessionKey: `${currentAgentId ?? ""}\0${state.sessionKey}`,
      session: selectedSession,
    });
    const multiIdentity = this.hasMultipleIdentities();
    const suggestionViewer =
      multiIdentity &&
      !selectedSessionArchived &&
      hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
      selectedSession?.visibility === "suggest" &&
      selectedSession.sharingRole === "viewer" &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.suggestions.add") ===
        true &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.suggestions.list") === true;
    const disabledReason =
      sessionParticipationBlocked && !suggestionViewer
        ? t("chat.sessionSharing.readOnlyNotice")
        : null;
    const typingEnabled =
      multiIdentity &&
      hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
      !catalogKey &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.typing") === true &&
      hasSessionPresenceViewers(
        this.presencePayload,
        this.context.gateway.snapshot.client?.instanceId,
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
    const primaryWidth = sidebarPrimaryWidth(sidebarLayout, this.paneWidth);
    const chatLayoutWidth = sidebarRegionCollapsed
      ? this.paneWidth
      : (sidebarChatColumn?.width ?? primaryWidth);
    const sessionWorkspace = createSessionWorkspaceProps(state, {
      draftScope: this.paneId,
      narrowLayout: chatLayoutWidth < WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH,
    });
    const railSideDocked =
      !sessionWorkspace.collapsed &&
      !sessionWorkspace.narrowLayout &&
      sessionWorkspace.dock !== "bottom";
    // The workspace rail claims the side slot first; the tasks rail needs
    // room for both columns before it may side-dock next to it.
    const backgroundTasks = createBackgroundTasksProps(state, {
      narrowLayout:
        chatLayoutWidth <
        WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH + (railSideDocked ? WORKSPACE_RAIL_MAX_WIDTH : 0),
      onOpenSession: (sessionKey) => {
        this.onPaneSessionChange?.(this.paneId, sessionKey);
      },
    });
    const tasksSideDocked = !backgroundTasks.collapsed && !backgroundTasks.narrowLayout;
    // Side-docked workspace surfaces narrow the conversation region; bottom
    // strips do not affect whether the session rail can dock beside it.
    const sideRailCount = (railSideDocked ? 1 : 0) + (tasksSideDocked ? 1 : 0);
    const chatMainWidth = chatLayoutWidth - sideRailCount * WORKSPACE_RAIL_MAX_WIDTH;
    const selectedSessionRailMode =
      this.sessionRailModeSessionKey === state.sessionKey ? this.sessionRailMode : "hidden";
    const gatewaySnapshot = this.context.gateway.snapshot;
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
    const loadSidebarFullMessage = createSidebarFullMessageLoader(state, Boolean(catalogKey));
    const projectionRunId = resolveChatProjectionRunId({
      localRunId: state.chatRunId,
      activeRunIds: selectedSession?.activeRunIds,
      queue: state.chatQueue,
    });
    const attachmentReads = this.chatState.attachmentReads;
    const attachmentReadSignal = attachmentReads.readSignal;
    const props: ChatProps = {
      transcript: this.transcript,
      paneId: this.paneId,
      sessionKey: state.sessionKey,
      announceTranscript: this.active,
      onSessionKeyChange: (next) => {
        this.onPaneSessionChange?.(this.paneId, next);
      },
      thinkingLevel: state.chatThinkingLevel,
      autoExpandToolCalls: state.chatVerboseLevel === "full",
      showThinking: state.settings.chatShowThinking,
      showToolCalls: state.settings.chatShowToolCalls,
      persistCommentary: state.settings.chatPersistCommentary !== false,
      loading: catalogKey ? this.catalogLoading : state.chatLoading,
      sending: state.chatSending || this.sessionSuggestionAddOperation !== undefined,
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
      sessionRailOpenRequest:
        this.sessionRailOpenSessionKey === state.sessionKey ? this.sessionRailOpenRequest : 0,
      sessionRailMode: selectedSessionRailMode,
      sessionRailDocked: !catalogKey && chatMainWidth >= SESSION_RAIL_DOCK_MIN_WIDTH,
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
      typingLabel: multiIdentity ? this.typingLabel() : null,
      onTypingChange: typingEnabled ? (typing) => this.sendTypingState(typing) : undefined,
      canSend: catalogKey
        ? this.catalogSession?.canContinue === true
        : !selectedSessionArchived && (!sessionParticipationBlocked || suggestionViewer),
      disabledReason: catalogDisabledReason ?? disabledReason,
      disabledBanner:
        selectedSessionArchived && !catalogDisabledReason
          ? {
              kind: "composer-replacement",
              text: t("chat.archivedSessionDisabled"),
              actionLabel: t("common.unarchive"),
              onAction: () => void this.restoreArchivedSession(state.sessionKey),
            }
          : undefined,
      error: state.lastError,
      runError: catalogKey ? null : (state.chatRunError ?? null),
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
        : renderChatControls({
            paneId: this.paneId,
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
              onModelSelect: (next, targetSessionKey) =>
                switchChatModel(state, next, targetSessionKey),
              onThinkingSelect: (next, targetSessionKey) =>
                switchChatThinkingLevel(state, next, targetSessionKey),
            },
            onboarding: state.onboarding,
            settings: state.settings,
            viewMenuOpen: state.chatViewMenuOpen,
            onSettingsChange: state.applySettings,
            onViewMenuOpenChange: (open, options) => {
              state.setChatViewMenuOpen(open, options);
            },
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
        hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      canDismissTaskSuggestions:
        state.connected &&
        hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      onAcceptTaskSuggestion: (suggestion) => void this.acceptTaskSuggestion(suggestion),
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
      onSend: () =>
        catalogKey
          ? void this.continueCatalogSession(catalogKey)
          : suggestionViewer
            ? void this.addCurrentSessionSuggestion()
            : void state.handleSendChat(),
      onCompact: () => void state.handleSendChat("/compact"),
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
      onAbort: sessionParticipationBlocked
        ? undefined
        : () => void state.handleAbortChat({ preserveDraft: true }),
      onQueueRemove: state.removeQueuedMessage,
      onQueueRetry: (id) => void state.retryQueuedChatMessage(id),
      onQueueSteer: sessionParticipationBlocked
        ? undefined
        : (id) => void state.steerQueuedChatMessage(id),
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
      onRewindMessage: (entryId) => this.rewindToMessage(entryId),
      onForkMessage: (entryId) => this.forkFromMessage(entryId),
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
      basePath: state.basePath,
      gatewayUrl: state.settings.gatewayUrl,
    };
    const chat = renderChat(props);
    const workboardCardChip = this.resolveWorkboardCardChip(board);
    const primary =
      board.hasBoard && board.face === "dashboard"
        ? renderBoardSessionSurface({
            snapshot: board.snapshot,
            observer: {
              activeRunId: observerRunId,
              digests: this.observerDigestHistory.get(
                this.resolveObserverDigestHistoryKey(board.snapshot.sessionKey),
              ),
              lastReadAt: selectedSession?.lastReadAt,
            },
            activeTabId: board.activeTabId,
            dock: board.dock,
            reopenDock: board.reopenDock,
            dockSize: this.boardChatDockSize,
            chat,
            divider: this.renderBoardDivider("bottom"),
            canMutate: board.provider.canMutate,
            canGrant: board.provider.canGrant,
            callbacks: {
              applyOps: (ops) => board.provider.applyOps(ops),
              grant: (name, decision) => board.provider.grant(name, decision),
              selectTab: (tabId) => {
                this.boardCommandDock = null;
                this.persistBoardSessionView({ face: "dashboard", activeTabId: tabId });
              },
              frameLoadFailed: (name) => board.provider.refreshWidgetFrame(name),
              widgetAppView: (name, revision) => board.provider.widgetAppView(name, revision),
              refreshWidgetAppView: (name, revision) =>
                board.provider.refreshWidgetAppView(name, revision),
            } satisfies BoardViewCallbacks,
            widgetFrameUrl: (name, revision) => board.provider.widgetFrameUrl(name, revision),
            workboardCardChip,
            onDockChange: (dock) => this.handleBoardDockChange(dock),
          })
        : chat;
    const discussion = this.buildSessionDiscussionPanel(state, state.sessionKey.trim());
    const panelTemplates = {
      chat,
      ...(state.sidebarContent
        ? {
            detail: html`<openclaw-chat-detail-panel
              class="chat-sidebar"
              .content=${state.sidebarContent}
              .loadFullMessage=${loadSidebarFullMessage}
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
        chat: Boolean(board.activeTabId) && !board.activeTabReadOnly && board.provider.canMutate,
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
