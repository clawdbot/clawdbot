import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { fetchAssistantIdentity } from "../../app/assistant-identity.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadLocalUserIdentity, loadSettings, patchSettings } from "../../app/settings.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import { attachChatRealtimeActions, createInitialChatRealtimeState } from "./chat-realtime.ts";
import {
  resumeStoredChatOutboxes,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  resetChatInputHistoryNavigation,
} from "./input-history.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import { handleAbortChat } from "./run-lifecycle.ts";
import { handleChatScroll, resetChatScroll, scheduleChatScroll } from "./scroll.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import { resetToolStream } from "./tool-stream.ts";

type ChatPageElement = {
  querySelector: (selectors: string) => Element | null;
};

function clearImageLightbox(state: ChatPageHost) {
  const item = state.imageLightbox;
  state.imageLightbox = null;
  item?.release?.();
}

export function invalidateImageLightbox(state: ChatPageHost) {
  state.imageLightboxRequestVersion += 1;
  clearImageLightbox(state);
  return state.imageLightboxRequestVersion;
}

async function loadPageAssistantIdentity(
  state: ChatPageHost,
  opts?: { sessionKey?: string; expectedSessionKey?: string },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const sessionKey = opts?.sessionKey?.trim() || state.sessionKey.trim();
  const expectedSessionKey = opts?.expectedSessionKey?.trim() || sessionKey;
  const requestVersion = ++state.assistantIdentityRequestVersion;
  try {
    const identity = await fetchAssistantIdentity(client, sessionKey);
    if (
      state.client !== client ||
      !state.connected ||
      state.assistantIdentityRequestVersion !== requestVersion ||
      state.sessionKey.trim() !== expectedSessionKey ||
      !identity
    ) {
      return;
    }
    state.assistantName = identity.name;
    state.assistantAvatar = identity.avatar;
    state.assistantAvatarSource = identity.avatarSource ?? null;
    state.assistantAvatarStatus = identity.avatarStatus ?? null;
    state.assistantAvatarReason = identity.avatarReason ?? null;
    state.assistantAgentId = identity.agentId ?? null;
    state.requestUpdate?.();
  } catch {
    // Keep the last known identity when the Gateway cannot answer.
  }
}

export function createPageState(
  context: ApplicationContext,
  renderLifecycle: RenderLifecycle,
  page: ChatPageElement,
  chatMessagesBySession: ChatMessageCache = new Map(),
): ChatPageHost {
  const settings = loadSettings();
  const identity = loadLocalUserIdentity();
  const appConfig = context.config.current;
  const state = {
    sessions: context.sessions,
    initialUserMessage: context.initialUserMessage,
    settings,
    password: "",
    onboarding: false,
    assistantName: appConfig.assistantIdentity.name,
    assistantAvatar: null,
    assistantAvatarStatus: null,
    assistantAvatarReason: null,
    assistantAvatarSource: null,
    assistantIdentityRequestVersion: 0,
    userName: identity.name,
    userAvatar: identity.avatar,
    localMediaPreviewRoots: appConfig.localMediaPreviewRoots,
    embedSandboxMode: appConfig.embedSandboxMode,
    allowExternalEmbedUrls: appConfig.allowExternalEmbedUrls,
    client: null,
    connected: false,
    connectionEpoch: 0,
    hello: null,
    terminalAvailable: false,
    browserPanelAvailable: false,
    assistantAgentId: context.agentSelection.state.selectedId,
    sessionKey: settings.sessionKey,
    chatLoading: false,
    chatHistoryPagination: { hasMore: false },
    chatSending: false,
    chatMessage: "",
    chatMessages: [],
    chatDisplayedLeafEntryId: undefined as string | null | undefined,
    chatBranches: [],
    chatBranchesSessionKey: null,
    chatBranchesConnectionEpoch: null,
    chatBranchesLoading: false,
    chatToolMessages: [],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatQueueModeOverride: undefined,
    chatEffectiveQueueMode: undefined,
    chatAttachments: [],
    chatRunId: null,
    chatRunUsageById: new Map<string, number>(),
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunStartup: null,
    lastError: null,
    chatError: null,
    chatRunError: null,
    agentsError: null,
    chatStreamSegments: [],
    chatRunStatus: null,
    compactionStatus: null,
    fallbackStatus: null,
    planStatus: null,
    observerDigest: null,
    knownAgentRunIds: new Set(),
    waitingApprovalStatuses: new Map(),
    waitingApprovalResolvedIds: new Set(),
    chatAvatarUrl: null,
    chatAvatarSource: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    chatModelSwitchPromises: {},
    chatModelsLoading: false,
    chatMetadataRequestVersion: 0,
    chatModelCatalog: [],
    modelAuthStatusResult: null,
    modelAuthStatusError: null,
    sessionsResult: null,
    sessionsResultAgentId: null,
    sessionsLoading: false,
    sessionsError: null,
    sessionsArchivedFilter: "active",
    selectedChatSessionArchived: false,
    agentsList: context.agents.state.agentsList,
    agentsSelectedId: context.agentSelection.state.selectedId,
    onAgentsList: (agentsList: AgentsListResult, client: GatewayBrowserClient) => {
      context.agents.adoptList(agentsList, client);
    },
    refreshSessionsAfterChat: new Map<string, { sessionKey: string; agentId?: string }>(),
    pendingAbort: null,
    pendingSessionMessageReloadSessionKey: null,
    chatSubmitGuards: new Map<string, Promise<void>>(),
    chatSendTimingsByRun: new Map(),
    chatQueue: [],
    chatQueueByScope: {},
    chatComposerFallbackByScope: {},
    chatSendingScopeKey: null,
    chatMessagesBySession,
    eventLogBuffer: [],
    basePath: context.basePath,
    chatNewMessagesBelow: false,
    chatViewMenuOpen: false,
    chatViewMenuTrigger: null,
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    chatScrollCommitCleanup: null,
    chatStreamRenderFrame: null,
    chatScrollFrame: null,
    chatScrollGuardFrame: null,
    chatScrollGeneration: 0,
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatIsProgrammaticScroll: false,
    chatProgrammaticScrollTarget: 0,
    sidebarOpen: false,
    sidebarContent: null,
    imageLightbox: null,
    imageLightboxRequestVersion: 0,
    splitRatio: settings.splitRatio,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    ...createInitialChatRealtimeState(),
    renderLifecycle,
    requestUpdate: () => renderLifecycle.invalidate(),
    sessionWorkspaceState: undefined,
    sessionWorkspaceOpenRequest: undefined,
    backgroundTasksState: undefined,
    querySelector: page.querySelector.bind(page),
  } as unknown as ChatPageHost;

  state.resetToolStream = () => resetToolStream(state as never);
  state.onModelChanged = () => undefined;
  state.resetChatInputHistoryNavigation = () => resetChatInputHistoryNavigation(state);
  state.resetChatScroll = () => resetChatScroll(state);
  state.scrollToBottom = (options) => {
    resetChatScroll(state);
    scheduleChatScroll(state, true, Boolean(options?.smooth), { source: "manual" });
  };
  state.handleChatScroll = (event) => handleChatScroll(state, event);
  state.handleChatDraftChange = (next) => handleChatDraftChange(state, next);
  state.handleChatInputHistoryKey = (input) => handleChatInputHistoryKey(state, input);
  state.applySettings = (next) => {
    state.settings = patchSettings({
      chatShowThinking: next.chatShowThinking,
      chatShowToolCalls: next.chatShowToolCalls,
      chatPersistCommentary: next.chatPersistCommentary,
      chatSendShortcut: next.chatSendShortcut,
      splitRatio: next.splitRatio,
    });
    state.splitRatio = state.settings.splitRatio;
    renderLifecycle.invalidate();
  };
  state.setChatViewMenuOpen = (open, options) => {
    if (open) {
      state.chatViewMenuTrigger = options?.trigger ?? state.chatViewMenuTrigger;
      state.chatViewMenuOpen = true;
      renderLifecycle.invalidate();
      return;
    }
    const focusTarget = options?.restoreFocus ? state.chatViewMenuTrigger : null;
    state.chatViewMenuOpen = false;
    state.chatViewMenuTrigger = null;
    renderLifecycle.invalidate();
    if (!(focusTarget instanceof HTMLElement) || !focusTarget.isConnected) {
      return;
    }
    requestAnimationFrame(() => {
      if (focusTarget.isConnected) {
        focusTarget.focus();
      }
    });
  };
  attachChatRealtimeActions(state);
  state.loadAssistantIdentity = () => loadPageAssistantIdentity(state);
  state.handleSendChat = (messageOverride, options) =>
    handleSendChat(state, messageOverride, options as never);
  state.handleAbortChat = async (options) => {
    await handleAbortChat(state, options as never);
    renderLifecycle.invalidate();
  };
  state.removeQueuedMessage = (id) => {
    removeQueuedMessage(state, id);
    void resumeStoredChatOutboxes(state);
    renderLifecycle.invalidate();
  };
  state.retryQueuedChatMessage = async (id) => {
    await retryQueuedChatMessage(state, id);
    renderLifecycle.invalidate();
  };
  state.steerQueuedChatMessage = async (id) => {
    await steerQueuedChatMessage(state, id);
    renderLifecycle.invalidate();
  };
  state.handleOpenSidebar = (content) => {
    state.sidebarContent = content;
    state.sidebarOpen = true;
    renderLifecycle.invalidate();
  };
  state.handleCloseSidebar = () => {
    state.sidebarOpen = false;
    renderLifecycle.invalidate();
  };
  state.beginImageOpen = () => {
    const requestVersion = invalidateImageLightbox(state);
    renderLifecycle.invalidate();
    return requestVersion;
  };
  state.handleOpenImage = (item, requestVersion) => {
    const activeRequestVersion = requestVersion ?? state.beginImageOpen();
    if (activeRequestVersion !== state.imageLightboxRequestVersion) {
      item.release?.();
      return;
    }
    const safeSrc = resolveSafeExternalUrl(item.src, window.location.href, {
      allowDataImage: true,
    });
    if (!safeSrc) {
      item.release?.();
      return;
    }
    state.imageLightbox = { ...item, src: safeSrc };
    renderLifecycle.invalidate();
  };
  state.handleCloseImage = () => {
    invalidateImageLightbox(state);
    renderLifecycle.invalidate();
  };
  state.handleSplitRatioChange = (ratio) => {
    const next = Math.max(0.4, Math.min(0.7, ratio));
    state.applySettings({ ...state.settings, splitRatio: next });
  };
  return state;
}
