import {
  applyChatAgentsList,
  applySelectedSessionProjection,
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  clearChatMessagesFromCache,
  hasOperatorAdminAccess,
  isGatewayMethodAdvertised,
  markQueuedChatSendsWaitingForReconnect,
  parseAgentSessionKey,
  parseCatalogSessionKey,
  readPresenceEntries,
  reconcileStaleChatRunAfterSessionStatePublication,
  reconcileWaitingApprovalsFromSnapshot,
  replayPendingChatAbort,
  refreshChatModelAuthStatus,
  refreshPendingQuestionsWithRetry,
  refreshPageChat,
  resolveChatAgentId,
  resolveSessionKey,
  resolveUiConfiguredMainKey,
  retryReconnectableQueuedChatSends,
  setQuestionPromptClient,
  syncSelectedSessionMessageSubscription,
  uiSessionEventMatches,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "./chat-pane-deps.ts";
import { ChatPaneLifecycle } from "./chat-pane-lifecycle.ts";

export abstract class ChatPaneContext extends ChatPaneLifecycle {
  protected applySessionsState(stateValue: ApplicationContext["sessions"]["state"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const selectedSessionDeleted = stateValue.deletedSessions.some(({ key, agentId }) =>
      uiSessionEventMatches(
        {
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
          sessionKey: state.sessionKey,
        },
        key,
        agentId,
      ),
    );
    for (const { key } of stateValue.deletedSessions) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey: key });
    }
    state.sessionsResult = stateValue.result;
    state.sessionsResultAgentId = stateValue.agentId;
    state.sessionsLoading = stateValue.loading;
    state.sessionsError = stateValue.error;
    for (const row of stateValue.result?.sessions ?? []) {
      const sessionKey = this.resolveBoardSessionKey(row.key);
      this.observerDigestHistory.sync(sessionKey, row.sessionId);
      if (row.observerDigest) {
        this.observerDigestHistory.hydrate(sessionKey, row.observerDigest, row.sessionId);
      }
    }
    this.refreshBuiltinBoardSnapshot();
    const selectedSession = stateValue.result?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, state.sessionKey),
    );
    if (applySelectedSessionProjection(state, selectedSession)) {
      this.markSessionRead(selectedSession);
    }
    this.syncSessionSuggestionTarget(
      stateValue.agentId ?? resolveChatAgentId(state) ?? "main",
      selectedSession,
    );
    if (selectedSessionDeleted) {
      const agentId =
        parseAgentSessionKey(state.sessionKey)?.agentId ??
        this.context.agentSelection.state.selectedId ??
        "main";
      this.onPaneSessionChange?.(
        this.paneId,
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: this.context.agents.state.agentsList,
            hello: this.context.gateway.snapshot.hello,
          }),
        }),
      );
      return;
    }
    const reconciledLocalCompletion = reconcileStaleChatRunAfterSessionStatePublication(state);
    this.reconcileWaitingApprovalSnapshot();
    if (!reconciledLocalCompletion) {
      state.requestUpdate?.();
    }
  }

  protected reconcileWaitingApprovalSnapshot(
    approvalQueue?: ApplicationContext["overlays"]["snapshot"]["approvalQueue"],
  ): boolean {
    const state = this.state;
    const queue = approvalQueue ?? this.context?.overlays?.snapshot.approvalQueue;
    if (!state || !queue) {
      return false;
    }
    return reconcileWaitingApprovalsFromSnapshot(state, queue);
  }

  protected applyApplicationConfig(config: ApplicationContext["config"]["current"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousTerminalAvailable = state.terminalAvailable;
    state.terminalAvailable =
      config.terminalEnabled &&
      state.connected &&
      hasOperatorAdminAccess(state.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "terminal.open") === true;
    const rootsChanged =
      state.localMediaPreviewRoots.length !== config.localMediaPreviewRoots.length ||
      state.localMediaPreviewRoots.some(
        (value, index) => value !== config.localMediaPreviewRoots[index],
      );
    if (
      !rootsChanged &&
      state.terminalAvailable === previousTerminalAvailable &&
      state.embedSandboxMode === config.embedSandboxMode &&
      state.allowExternalEmbedUrls === config.allowExternalEmbedUrls
    ) {
      return;
    }
    state.localMediaPreviewRoots = config.localMediaPreviewRoots;
    state.embedSandboxMode = config.embedSandboxMode;
    state.allowExternalEmbedUrls = config.allowExternalEmbedUrls;
    state.requestUpdate?.();
  }

  protected applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const state = this.state;
    if (!state) {
      return;
    }
    const wasConnected = state.connected;
    const sourceChanged =
      state.client !== snapshot.client || wasConnected !== (snapshot.phase === "connected");
    const clientChanged = this.connectedClient !== snapshot.client;
    if (snapshot.phase !== "connected") {
      this.presencePayload = undefined;
    } else if (clientChanged || !wasConnected) {
      const presence = readPresenceEntries(snapshot.hello?.snapshot);
      this.presencePayload = presence ? { presence } : undefined;
    }
    if (sourceChanged) {
      // A reconnect can retain the browser client. Keep async ownership tied
      // to the logical connection, not only the transport object identity.
      this.connectionGeneration += 1;
      this.swarmHydrator?.dispose();
      this.swarmHydrator = null;
      this.builtinBoardSnapshot = null;
      this.builtinBoardSnapshotBase = null;
      this.taskSuggestionsRequestVersion += 1;
      this.taskSuggestions = [];
      this.taskSuggestionBusyIds.clear();
      this.taskSuggestionOperations.clear();
      this.resetSessionSuggestions();
      this.clearTypingActors();
      this.sessionDiscussionStates.clear();
      this.sessionDiscussionOpenUrls.clear();
      this.sessionParticipationTracker.reset();
      // A new gateway/account owns its own membership + identity data; drop the
      // previous connection's sharing cache so a stale loading entry cannot
      // suppress the fresh load or leak the prior account's identities.
      this.sessionSharingStates = new Map();
      this.resetSessionPullRequests();
      this.resetOlderMessagesViewport();
      state.chatLoading = false;
    }
    state.client = snapshot.client;
    state.connected = snapshot.phase === "connected";
    state.connectionEpoch = this.connectionGeneration;
    state.hello = snapshot.hello;
    if (state.connected && state.pendingAbort) {
      void replayPendingChatAbort(state).finally(() => state.requestUpdate?.());
    }
    if (sourceChanged && state.sidebarContent?.kind === "session-discussion") {
      // A reconnect may point at a different gateway/provider; an open panel
      // would keep rendering the previous provider's URL. Close it — the
      // re-probe below restores the action for the new source.
      state.handleCloseSidebar();
    }
    if (sourceChanged && snapshot.phase === "connected" && state.sessionKey) {
      // Reconnects clear the probed states above; re-probe the active session
      // so source-owned affordances reappear without a manual session switch.
      void this.probeSessionDiscussion(state.sessionKey);
      if (!clientChanged) {
        void this.refreshSessionPullRequests();
      }
    }
    state.terminalAvailable =
      this.context.config.current.terminalEnabled &&
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "terminal.open") === true;
    state.browserPanelAvailable =
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "browser.request") === true;
    state.assistantAgentId = snapshot.assistantAgentId;
    const routeSessionKey = this.sessionKey.trim();
    const catalogRouteKey = parseCatalogSessionKey(routeSessionKey);
    const canonicalRouteSessionKey =
      routeSessionKey && !catalogRouteKey
        ? resolveSessionKey(routeSessionKey, snapshot.hello)
        : null;
    if (
      routeSessionKey &&
      canonicalRouteSessionKey &&
      canonicalRouteSessionKey !== routeSessionKey
    ) {
      this.onPaneSessionChange?.(this.paneId, canonicalRouteSessionKey, { replace: true });
      state.requestUpdate?.();
      // Persisted state may already own the canonical key; continue startup
      // because no later route update would load its history.
      if (state.sessionKey !== canonicalRouteSessionKey) {
        return;
      }
    }
    // Keep the session-specific identity loaded by agent.identity.get across
    // ordinary gateway snapshots. Reset to the configured fallback only when
    // the logical connection changes; the startup path refreshes the identity
    // for the active session afterward.
    if (sourceChanged) {
      state.assistantName = this.context.config.current.assistantIdentity.name;
    }
    if (snapshot.phase !== "connected") {
      if (wasConnected) {
        const currentSessionId =
          typeof state.currentSessionId === "string" ? state.currentSessionId.trim() : "";
        if (currentSessionId) {
          state.reconnectResumeSessionId = currentSessionId;
        }
        markQueuedChatSendsWaitingForReconnect(state);
      }
      this.connectedClient = null;
      setQuestionPromptClient(this.questionPromptState, null);
      state.realtimeTalkSession?.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkVideoStream = null;
      state.realtimeTalkCameraDevices = [];
      state.realtimeTalkVideoCapable = false;
      state.realtimeTalkVideoPending = false;
      state.realtimeTalkCameraError = false;
      state.realtimeTalkStatus = "idle";
      state.realtimeTalkInputLevel.set(0);
      state.resetToolStream();
      state.requestUpdate?.();
      return;
    }
    if (clientChanged && snapshot.client) {
      const startupClient = snapshot.client;
      const startupGeneration = this.connectionGeneration;
      const startupSessionKey = state.sessionKey;
      const agentsListBeforeStartup = this.context.agents.state.agentsList;
      const clientIsCurrent = () =>
        this.connectionGeneration === startupGeneration &&
        this.connectedClient === startupClient &&
        state.client === startupClient &&
        state.connected;
      const finishStartup = async () => {
        if (!clientIsCurrent()) {
          return;
        }
        let agentsList = this.context.agents.state.agentsList;
        if (agentsList === agentsListBeforeStartup) {
          agentsList = await this.context.agents.ensureList();
        }
        if (!clientIsCurrent()) {
          return;
        }
        if (agentsList) {
          applyChatAgentsList(state, agentsList, startupClient);
        }
        state.requestUpdate?.();
        if (state.sessionKey === startupSessionKey) {
          this.sendPendingSkillWorkshopRevision(startupSessionKey);
        }
      };
      this.connectedClient = startupClient;
      setQuestionPromptClient(this.questionPromptState, startupClient);
      refreshPendingQuestionsWithRetry(this.questionPromptState, startupClient, clientIsCurrent);
      this.headerWorktreePaths.clear();
      this.headerBranches.clear();
      this.headerPlatform = null;
      void this.loadHeaderPlatform(startupClient, startupGeneration);
      if (catalogRouteKey) {
        void this.loadCatalogSession(catalogRouteKey, false);
        state.requestUpdate?.();
        return;
      }
      void syncSelectedSessionMessageSubscription(state, { force: true });
      void retryReconnectableQueuedChatSends(state);
      void refreshPageChat(state, { startup: true, awaitHistory: true }).finally(() => {
        void finishStartup();
      });
      void refreshChatModelAuthStatus(state).finally(() => state.requestUpdate?.());
      void state.loadAssistantIdentity();
      void this.refreshTaskSuggestions();
      void this.refreshSessionSuggestions();
      void this.refreshSessionPullRequests();
    }
    this.reconcileWaitingApprovalSnapshot();
    state.requestUpdate?.();
  }
}
