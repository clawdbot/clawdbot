import { invalidateAssistantIdentityCache } from "../../app/assistant-identity.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
} from "../../app/question-prompt.ts";
import { loadSettings } from "../../app/settings.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  canonicalUiSessionKeyForPersistence,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
import { invalidateChatAvatarCache } from "./chat-avatar.ts";
import { applyChatAgentsList, syncSelectedSessionMessageSubscription } from "./chat-history.ts";
import { ChatPaneLifecycle } from "./chat-pane-lifecycle.ts";
import { applySelectedSessionProjection } from "./chat-pane-state.ts";
import { resolveAssistantAttachmentAuthToken } from "./chat-pane-state.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue.ts";
import { retryReconnectableQueuedChatSends } from "./chat-send-actions.ts";
import {
  invalidateChatMetadataCache,
  refreshChatModelAuthStatus,
  refreshPageChat,
} from "./chat-state-refresh.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { releaseChatMediaResourceSubscriber } from "./components/chat-message-media.ts";
import {
  reconcileStaleChatRunAfterSessionStatePublication,
  replayPendingChatAbort,
} from "./run-lifecycle.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";
import { normalizeSidebarLayout } from "./sidebar-layout.ts";
import { reconcileWaitingApprovalsFromSnapshot } from "./tool-stream.ts";

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
      const sessionKey = this.resolveObserverDigestHistoryKey(
        row.key,
        row.observerDigest?.agentId ?? stateValue.agentId ?? undefined,
      );
      this.observerDigestHistory.sync(sessionKey, row.sessionId);
      if (row.observerDigest) {
        this.observerDigestHistory.hydrate(sessionKey, row.observerDigest, row.sessionId);
      }
    }
    this.refreshSwarmRoster();
    this.refreshBuiltinBoardSnapshot();
    const selectedSession = selectedChatSessionRow(state);
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
    if (rootsChanged) {
      releaseChatMediaResourceSubscriber(state.requestUpdate);
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
    const previousMediaAuthToken = resolveAssistantAttachmentAuthToken(state);
    const wasConnected = state.connected;
    const previousSidebarSessionKey = canonicalUiSessionKeyForPersistence(state, state.sessionKey);
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
      releaseChatMediaResourceSubscriber(state.requestUpdate);
      // A reconnect can retain the browser client. Keep async ownership tied
      // to the logical connection, not only the transport object identity.
      this.connectionGeneration += 1;
      invalidateChatAvatarCache(state);
      invalidateAssistantIdentityCache(state.client);
      state.assistantIdentityRequestVersion += 1;
      invalidateChatMetadataCache(state);
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
      this.sessionDiscussionPanels.clear();
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
    if (!sourceChanged && previousMediaAuthToken !== resolveAssistantAttachmentAuthToken(state)) {
      releaseChatMediaResourceSubscriber(state.requestUpdate);
    }
    state.canvasPluginSurfaceUrl = snapshot.canvasPluginSurfaceUrl;
    const sidebarSessionKey = canonicalUiSessionKeyForPersistence(state, state.sessionKey);
    const sidebarKeyChanged = sidebarSessionKey !== previousSidebarSessionKey;
    if (sidebarSessionKey && (clientChanged || sidebarKeyChanged)) {
      const sidebarSettings = loadSettings();
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
    if (sourceChanged && snapshot.phase === "connected" && state.sessionKey && !clientChanged) {
      // A logical reconnect can retain the browser client and skip full startup.
      // The existing transcript is already authoritative, so rehydrate after its next commit.
      this.deferSessionHydrationUntilTranscript(state.sessionKey, Promise.resolve());
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
    this.refreshSwarmRoster();
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
      const historyRefresh = refreshPageChat(state, {
        startup: true,
        awaitHistory: true,
        deferBranches: true,
      });
      this.deferSessionHydrationUntilTranscript(startupSessionKey, historyRefresh);
      void historyRefresh.finally(() => {
        void finishStartup();
      });
      void refreshChatModelAuthStatus(state).finally(() => state.requestUpdate?.());
      void state.loadAssistantIdentity();
      void this.refreshTaskSuggestions();
      void this.refreshSessionSuggestions();
    }
    this.reconcileWaitingApprovalSnapshot();
    state.requestUpdate?.();
  }
}
