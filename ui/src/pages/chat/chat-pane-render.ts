import {
  CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS,
  activeChatRunStartupStatus,
  areUiSessionKeysEquivalent,
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
  resolveAssistantAttachmentAuthToken,
  resolveBoardChatLayoutWidth,
  resolveChatAgentId,
  resolveChatAvatarUrl,
  resolveControlUiFollowUpMode,
  resolveControlUiServerQueueMode,
  resolveCurrentSelfUser,
  resolveChatPaneObserverRunId,
  retirePendingChatSideQuestion,
  revealSessionWorkspaceFile,
  scopedAgentParamsForSession,
  submitQuestionPrompt,
  switchChatFastMode,
  switchChatModel,
  switchChatThinkingLevel,
  t,
  workspaceResultConflictFromPlacement,
  type BoardViewCallbacks,
  type ChatProps,
  type DetailFullMessageResult,
  type SessionObserverDigest,
  type SidebarFullMessageRequest,
} from "./chat-pane-deps.ts";
import { ChatPaneHeaderRender } from "./chat-pane-header-render.ts";
import {
  DETAIL_SIDEBAR_SIDE_MIN_WIDTH,
  WORKSPACE_RAIL_MAX_WIDTH,
  WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH,
} from "./chat-pane-shared.ts";

export class ChatPaneRender extends ChatPaneHeaderRender {
  override render() {
    const state = this.state;
    if (!state) {
      return html`<main class="app-shell app-shell--booting" aria-busy="true"></main>`;
    }
    const selectedSession = state.sessionsResult?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, state.sessionKey),
    );
    const projectedObserverDigest: SessionObserverDigest | null = selectedSession?.observerDigest
      ? {
          sessionKey: selectedSession.key,
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
    const chatLayoutWidth = resolveBoardChatLayoutWidth({
      paneWidth: this.paneWidth,
      hasBoard: board.hasBoard,
      face: board.face,
      dock: board.dock,
      dockWidth: this.boardChatDockSize.width,
    });
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
    // Every side-docked rail narrows the room left for the chat + detail
    // split; bottom strips do not.
    const sideRailCount = (railSideDocked ? 1 : 0) + (tasksSideDocked ? 1 : 0);
    const detailSplitWidth = chatLayoutWidth - sideRailCount * WORKSPACE_RAIL_MAX_WIDTH;
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
      observerHudReady: !catalogKey && this.observerHudReady,
      observerRunId: catalogKey ? null : observerRunId,
      observerStartedAt: selectedSession?.startedAt ?? state.chatStreamStartedAt ?? undefined,
      observerLastReadAt: selectedSession?.lastReadAt,
      onObserverAsk: catalogKey ? undefined : this.askSessionObserver,
      // Unconditional: catalog chats never render the HUD (observerHudReady is
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
      sideChatTurns: catalogKey ? [] : state.chatSideChatTurns,
      sideChatPending: catalogKey ? null : state.chatSideResultPending,
      sideChatHidden: catalogKey ? true : state.chatSideChatHidden,
      toolMessages: catalogKey ? [] : state.chatToolMessages,
      streamSegments: catalogKey ? [] : state.chatStreamSegments,
      stream: catalogKey ? null : state.chatStream,
      streamStartedAt: catalogKey ? null : state.chatStreamStartedAt,
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
        state.chatSideChatTurns = [];
        state.chatSideChatHidden = false;
        retirePendingChatSideQuestion(state);
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
      onSideQuestion: (command, displayQuestion, onSendRejected) =>
        void state.handleSendChat(command, {
          ...(displayQuestion ? { sideQuestionDisplayText: displayQuestion } : {}),
          ...(onSendRejected ? { onSideQuestionSendRejected: onSendRejected } : {}),
        }),
      onSideChatClose: () => {
        // Hide only: a pending run keeps going and its arriving answer (or a
        // new question) reopens the panel with the conversation intact.
        state.chatSideChatHidden = true;
        state.requestUpdate?.();
      },
      onSideChatClear: () => {
        const pendingRunId = state.chatSideResultPending?.runId;
        state.chatSideChatTurns = [];
        state.chatSideChatHidden = false;
        // Retire (not just clear) so a discarded question's still-running
        // detached run cannot leak its late reply into the transcript.
        retirePendingChatSideQuestion(state);
        // Best-effort targeted abort: trash means "stop the pending side
        // question", not just hide it. The retire above already suppresses
        // the run's late events, so a failed abort needs no fallback.
        if (pendingRunId && state.client && state.connected) {
          state.client
            .request("chat.abort", {
              sessionKey: state.sessionKey,
              ...scopedAgentParamsForSession(state, state.sessionKey),
              runId: pendingRunId,
            })
            .catch(() => {});
        }
        state.requestUpdate?.();
      },
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
      onLoadSidebarFullMessage: catalogKey
        ? undefined
        : async (request: SidebarFullMessageRequest): Promise<DetailFullMessageResult | null> => {
            if (!state.client || !state.connected) {
              return null;
            }
            return state.client.request<DetailFullMessageResult>("chat.message.get", {
              sessionKey: request.sessionKey,
              ...(request.agentId ? { agentId: request.agentId } : {}),
              messageId: request.messageId,
              maxChars: CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS,
            });
          },
      sidebarOpen: state.sidebarOpen,
      sidebarContent: state.sidebarContent,
      sidebarStacked: detailSplitWidth < DETAIL_SIDEBAR_SIDE_MIN_WIDTH,
      splitRatio: state.splitRatio,
      canvasPluginSurfaceUrl: state.hello?.pluginSurfaceUrls?.canvas ?? null,
      boardProvider: board.provider,
      onOpenSidebar: state.handleOpenSidebar,
      onCloseSidebar: () => {
        const content = state.sidebarContent;
        if (content?.kind === "session-discussion") {
          this.sessionDiscussionOpenUrls.delete(content.sessionKey);
        }
        state.handleCloseSidebar();
      },
      imageLightbox: state.imageLightbox,
      onRequestOpenImage: state.beginImageOpen,
      onOpenImage: state.handleOpenImage,
      onCloseImage: state.handleCloseImage,
      onSplitRatioChange: state.handleSplitRatioChange,
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
    const content =
      board.hasBoard && board.face === "dashboard"
        ? renderBoardSessionSurface({
            snapshot: board.snapshot,
            sessions: this.swarmHydrator?.rows ?? state.sessionsResult?.sessions ?? [],
            observer: {
              activeRunId: observerRunId,
              digests: this.observerDigestHistory.get(
                this.resolveBoardSessionKey(board.snapshot.sessionKey),
              ),
              lastReadAt: selectedSession?.lastReadAt,
            },
            activeTabId: board.activeTabId,
            dock: board.dock,
            reopenDock: board.reopenDock,
            dockSize: this.boardChatDockSize,
            chat,
            divider: this.renderBoardDivider(
              board.dock === "hidden" ? board.reopenDock : board.dock,
            ),
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
    return html`${this.renderPaneHeader(
      sessionWorkspace,
      backgroundTasks,
      selectedSession,
      Boolean(catalogKey),
      selectedAgent?.workspace,
      selectedAgent?.workspaceGit === true,
    )}${content}${this.renderResetConfirmation()}`;
  }
}
