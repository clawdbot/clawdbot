import type { GatewaySessionRow } from "../../api/types.ts";
import { invalidateAssistantIdentityCache } from "../../app/assistant-identity.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
} from "../../app/question-prompt.ts";
import { loadSettings } from "../../app/settings.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  canonicalUiSessionKeyForPersistence,
  isUiSelectedGlobalSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { invalidateChatAvatarCache } from "./chat-avatar.ts";
import {
  applyChatAgentsList,
  getChatHistoryLoadState,
  resumePendingChatHistoryLoad,
  syncSelectedSessionMessageSubscription,
} from "./chat-history.ts";
import { ChatPaneLifecycle } from "./chat-pane-lifecycle.ts";
import {
  applySelectedSessionProjection,
  resolveAssistantAttachmentAuthToken,
} from "./chat-pane-state.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { retryReconnectableQueuedChatSends } from "./chat-send-actions.ts";
import { retireChatModelSelectionOwnership } from "./chat-session.ts";
import {
  refreshChatModelAuthStatus,
  refreshPageChat,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { releaseChatMediaResourceSubscriber } from "./components/chat-message-media.ts";
import { retireSessionWorkspaceCheckout } from "./components/chat-session-workspace.ts";
import {
  reconcileChatRunAfterSessionStatePublication,
  replayPendingChatAbort,
} from "./run-lifecycle.ts";
import { cancelChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";
import { migrateLegacyDockVisibility } from "./sidebar-layout-legacy-migration.ts";
import { normalizeSidebarLayout } from "./sidebar-layout.ts";
import { maybeResetToolStream } from "./stream-reconciliation.ts";
import { reconcileWaitingApprovalsFromSnapshot } from "./tool-stream.ts";

export abstract class ChatPaneContext extends ChatPaneLifecycle {
  private gatewayConnectionLifecycle?: ReturnType<typeof createGatewayConnectionLifecycle>;
  private outboxRecoveryReady = false;

  override disconnectedCallback() {
    this.continueInTerminalDialog = null;
    this.gatewayConnectionLifecycle?.dispose();
    this.gatewayConnectionLifecycle = undefined;
    this.outboxRecoveryReady = false;
    super.disconnectedCallback();
  }

  protected async moveHeaderPlacement(row: GatewaySessionRow): Promise<void> {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const onMovingChange = (movingKey: string | null) => {
      if (movingKey !== null || this.headerPlacementMovingKey === row.key) {
        this.headerPlacementMovingKey = movingKey;
      }
    };
    const params = {
      client: scope.client,
      connectionGeneration: scope.generation,
      gatewaySnapshot: scope.context.gateway.snapshot,
      movingKey: this.headerPlacementMovingKey,
      row,
      isCurrent: () => this.ownsHeaderOutcomeScope(scope),
      onMovingChange,
      publishError: (error: unknown) => this.publishHeaderError(error, scope.headerOutcomeOwner),
      refreshReplacement: (agentId?: string | null) => scope.sessions.refreshReplacement(agentId),
      requestUpdate: () => this.requestUpdate(),
    };
    const { moveChatPanePlacement } = await import("./chat-pane-placement.runtime.ts");
    await moveChatPanePlacement(params);
  }

  protected async reclaimHeaderPlacement(row: GatewaySessionRow): Promise<void> {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const onReclaimingChange = (reclaimingKey: string | null) => {
      // A later reclaim may take ownership before this request settles. Only
      // the request that still owns the row may clear the pane's progress key.
      if (reclaimingKey !== null || this.headerPlacementReclaimingKey === row.key) {
        this.headerPlacementReclaimingKey = reclaimingKey;
      }
    };
    const params = {
      client: scope.client,
      connectionGeneration: scope.generation,
      gatewaySnapshot: scope.context.gateway.snapshot,
      reclaimingKey: this.headerPlacementReclaimingKey,
      placementStartup: scope.context.placementStartup,
      row,
      isCurrent: () => this.ownsHeaderOutcomeScope(scope),
      onReclaimingChange,
      publishError: (error: unknown) => this.publishHeaderError(error, scope.headerOutcomeOwner),
      refreshReplacement: (agentId?: string | null) => scope.sessions.refreshReplacement(agentId),
      requestUpdate: () => this.requestUpdate(),
    };
    const { reclaimChatPanePlacement } = await import("./chat-pane-placement.runtime.ts");
    await reclaimChatPanePlacement(params);
  }

  protected applySessionsState(stateValue: ApplicationContext["sessions"]["state"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const selectedSessionDeleted = this.context.sessions.deletionState(
      state.sessionKey,
      resolveChatAgentId(state),
    );
    for (const { key, agentId } of stateValue.deletedSessions) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey: key, agentId });
    }
    // A list for another agent must not overwrite this pane's global history.
    if (
      !isUiSelectedGlobalSessionKey(state, state.sessionKey) ||
      stateValue.agentId === resolveChatAgentId(state)
    ) {
      state.sessionsResult = stateValue.result;
      state.sessionsResultAgentId = stateValue.agentId;
    }
    state.sessionsLoading = stateValue.loading;
    state.sessionsError = stateValue.error;
    this.refreshSwarmRoster();
    const selectedSession = selectedChatSessionRow(state);
    if (applySelectedSessionProjection(state, selectedSession)) {
      // Hidden retained panes keep this subscription alive; only the pane the
      // user is actually looking at may clear unread/attention state.
      if (this.presented) {
        this.markSessionRead(selectedSession);
      }
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
      this.onSessionDeleted?.(
        this.paneId,
        state.sessionKey,
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: this.context.agents.state.agentsList,
            hello: this.context.gateway.snapshot.hello,
          }),
        }),
        selectedSessionDeleted === "pending",
      );
      return;
    }
    const reconciledLocalCompletion = reconcileChatRunAfterSessionStatePublication(state);
    this.reconcileWaitingApprovalSnapshot();
    if (reconciledLocalCompletion) {
      void retryReconnectableQueuedChatSends(state);
    } else if (this.presented) {
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
      state.allowExternalEmbedUrls === config.allowExternalEmbedUrls &&
      state.automaticallyFetchFavicons === config.automaticallyFetchFavicons
    ) {
      return;
    }
    if (rootsChanged) {
      releaseChatMediaResourceSubscriber(state.requestUpdate);
    }
    state.localMediaPreviewRoots = config.localMediaPreviewRoots;
    state.embedSandboxMode = config.embedSandboxMode;
    state.allowExternalEmbedUrls = config.allowExternalEmbedUrls;
    state.automaticallyFetchFavicons = config.automaticallyFetchFavicons;
    state.requestUpdate?.();
  }

  protected applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const state = this.state;
    if (!state) {
      return;
    }
    const previousMediaAuthToken = resolveAssistantAttachmentAuthToken(state);
    const wasConnected = state.connected;
    const previousAssistantAgentId = state.assistantAgentId;
    // Gateway identity is its default, while each retained pane owns its routed agent.
    const assistantAgentId =
      parseAgentSessionKey(state.sessionKey)?.agentId ??
      this.context.agentSelection.state.selectedId ??
      snapshot.assistantAgentId;
    const previousSidebarSessionKey = canonicalUiSessionKeyForPersistence(state, state.sessionKey);
    const connectionLifecycle = (this.gatewayConnectionLifecycle ??=
      createGatewayConnectionLifecycle({
        client: state.client,
        phase: state.connected ? "connected" : "stopped",
      }));
    const sourceChanged = connectionLifecycle.transition(snapshot);
    const clientChanged = this.connectedClient !== snapshot.client;
    if (clientChanged) {
      this.replaceStagedAttachmentGatewayOwner(snapshot.client);
    }
    if (snapshot.phase !== "connected") {
      this.presencePayload = undefined;
    } else if (clientChanged || !wasConnected) {
      const presence = readPresenceEntries(snapshot.hello?.snapshot);
      this.presencePayload = presence ? { presence } : undefined;
    }
    if (sourceChanged) {
      this.continueInTerminalDialog = null;
      this.cancelHeaderRename();
      cancelChatScroll(state);
      releaseChatMediaResourceSubscriber(state.requestUpdate);
      if (wasConnected) {
        if (snapshot.phase === "connected") {
          markQueuedChatSendsWaitingForReconnect(state);
        }
        state.chatSending = false;
        state.chatSendingScopeKey = null;
        invalidateAssistantIdentityCache(state.client);
      }
      // A reconnect can retain the browser client. Keep async ownership tied
      // to the logical connection, not only the transport object identity.
      this.connectionGeneration += 1;
      this.retireHeaderSessionMutations();
      invalidateChatAvatarCache(state);
      state.assistantIdentityRequestVersion += 1;
      retireChatMetadataRequests(state);
      this.swarmHydrator?.dispose();
      this.swarmHydrator = null;
      this.taskSuggestionsRequestVersion += 1;
      this.setTaskSuggestions([]);
      this.taskSuggestionBusyIds.clear();
      this.taskSuggestionOperations.clear();
      this.resetTaskSuggestionCloudProfiles();
      this.resetSessionSuggestions();
      this.clearTypingActors();
      this.sessionDiscussionStates.clear();
      this.sessionDiscussionOpenUrls.clear();
      this.sessionDiscussionPanels.clear();
      this.sessionParticipationTracker.reset();
      if (state.client !== snapshot.client) {
        this.sessionCompanionThreads.retire();
      }
      // A new gateway/account owns its own membership + identity data; drop the
      // previous connection's sharing cache so a stale loading entry cannot
      // suppress the fresh load or leak the prior account's identities.
      this.sessionSharingStates = new Map();
      state.guardianNotices = [];
      this.resetSessionPullRequests();
      this.resetOlderMessagesViewport();
      state.chatLoading = false;
    }
    if (
      sourceChanged ||
      (previousAssistantAgentId !== assistantAgentId &&
        isUiSelectedGlobalSessionKey(state, state.sessionKey))
    ) {
      retireChatModelSelectionOwnership(state);
    }
    state.client = snapshot.client;
    state.connected = snapshot.phase === "connected";
    const recoveryReady = state.connected && Boolean(state.client?.recoveryScopeReady);
    const resumeOutboxes = recoveryReady && (clientChanged || !this.outboxRecoveryReady);
    this.outboxRecoveryReady = recoveryReady;
    state.connectionEpoch = this.connectionGeneration;
    state.hello = snapshot.hello;
    state.selfUser = snapshot.selfUser ?? null;
    state.assistantAgentId = assistantAgentId;
    if (wasConnected && !state.connected) {
      // Only the connected->disconnected transition may reshape loading state;
      // repeated disconnected snapshots must stay no-ops for pane ownership.
      state.chatLoading = getChatHistoryLoadState(state).phase === "pending-connection";
    }
    const resumedHistory =
      !wasConnected && state.connected ? resumePendingChatHistoryLoad(state) : undefined;
    if (sourceChanged) {
      retireSessionWorkspaceCheckout(state);
    }
    if (!sourceChanged && previousMediaAuthToken !== resolveAssistantAttachmentAuthToken(state)) {
      releaseChatMediaResourceSubscriber(state.requestUpdate);
    }
    state.canvasPluginSurfaceUrl = snapshot.canvasPluginSurfaceUrl;
    state.terminalAvailable =
      this.context.config.current.terminalEnabled &&
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "terminal.open") === true;
    state.browserPanelAvailable =
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "browser.request") === true;
    const desktopPanelAvailable =
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "desktop.observe") === true;
    const sidebarSessionKey = canonicalUiSessionKeyForPersistence(state, state.sessionKey);
    const sidebarKeyChanged = sidebarSessionKey !== previousSidebarSessionKey;
    if (sidebarSessionKey && (clientChanged || sidebarKeyChanged)) {
      const sidebarSettings = migrateLegacyDockVisibility({
        settings: loadSettings(),
        sessionKey: sidebarSessionKey,
        browserAvailable: state.browserPanelAvailable,
        desktopAvailable: desktopPanelAvailable,
      });
      const persistedLayout = sidebarSettings.sidebarSessionLayouts?.[sidebarSessionKey];
      if (persistedLayout !== undefined) {
        state.sidebarLayout = normalizeSidebarLayout(persistedLayout);
      } else if (clientChanged) {
        state.sidebarLayout = { columns: [] };
      } else if (state.sidebarLayout.columns.length > 0) {
        state.updateSidebarLayout(state.sidebarLayout);
      }
      state.sidebarFocusPanelId =
        sidebarSettings.sidebarSessionActivePanels?.[sidebarSessionKey] ?? "";
      state.sidebarFocusVersion += 1;
    }
    if (state.connected && state.pendingAbort) {
      void replayPendingChatAbort(state).finally(() => state.requestUpdate?.());
    }
    const routeSessionKey = this.sessionKey.trim();
    const catalogRouteKey = parseCatalogSessionKey(routeSessionKey);
    if (
      sourceChanged &&
      snapshot.phase === "connected" &&
      state.sessionKey &&
      !clientChanged &&
      !catalogRouteKey
    ) {
      // A logical reconnect can retain the browser client and skip full startup.
      // Disconnect cleanup drops transient tool rows, so reload this pane's
      // active-run snapshot before secondary session surfaces hydrate.
      const historyRefresh = refreshPageChat(state, {
        startup: true,
        awaitHistory: true,
        deferBranches: true,
        historyLoad: resumedHistory,
      });
      this.deferSessionHydrationUntilTranscript(
        state.sessionKey,
        historyRefresh.then(() => getChatHistoryLoadState(state).phase === "committed"),
      );
    }
    const canonicalRouteSessionKey =
      routeSessionKey && !catalogRouteKey
        ? resolveSessionKey(routeSessionKey, snapshot.hello)
        : null;
    if (
      routeSessionKey &&
      canonicalRouteSessionKey &&
      canonicalRouteSessionKey !== routeSessionKey &&
      this.active &&
      this.presented
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
      stopChatRealtimeTalk(state);
      maybeResetToolStream(state, { preserveStreamSegments: state.chatRunId !== null });
      state.requestUpdate?.();
      return;
    }
    this.refreshSwarmRoster();
    if ((clientChanged || (sourceChanged && catalogRouteKey)) && snapshot.client) {
      const startupClient = snapshot.client;
      const startupGeneration = this.connectionGeneration;
      const startupSessionKey = state.sessionKey;
      const clientIsCurrent = () =>
        this.connectionGeneration === startupGeneration &&
        this.connectedClient === startupClient &&
        state.client === startupClient &&
        state.connected;
      const finishStartup = async () => {
        if (!clientIsCurrent()) {
          return;
        }
        const agentsList = await this.context.agents.ensureList();
        if (!clientIsCurrent()) {
          return;
        }
        if (agentsList) {
          applyChatAgentsList(state, agentsList, startupClient);
        }
        state.requestUpdate?.();
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
      const historyRefresh = refreshPageChat(state, {
        startup: true,
        awaitHistory: true,
        deferBranches: true,
        historyLoad: resumedHistory,
      });
      this.deferSessionHydrationUntilTranscript(
        startupSessionKey,
        historyRefresh.then(() => getChatHistoryLoadState(state).phase === "committed"),
      );
      void historyRefresh.finally(() => {
        void finishStartup();
      });
      void refreshChatModelAuthStatus(state).finally(() => state.requestUpdate?.());
      void state.loadAssistantIdentity();
      void this.refreshTaskSuggestions();
      void this.refreshSessionSuggestions();
    }
    // Hello precedes recovery readiness. Wake parked outboxes on that publication;
    // the shared admission check still holds any recovered initial turn.
    if (resumeOutboxes && !catalogRouteKey) {
      void retryReconnectableQueuedChatSends(state);
    }
    this.reconcileWaitingApprovalSnapshot();
    state.requestUpdate?.();
  }
}
