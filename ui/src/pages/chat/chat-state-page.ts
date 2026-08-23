import { fetchAssistantIdentity } from "../../app/assistant-identity.ts";
import {
  dispatchCommandClientPresentation,
  type CommandClientPresentationAction,
} from "../../app/command-client-presentation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  autoPromptNotificationsOnSend,
  hasActiveNotificationPromptGesture,
  shouldAutoPromptNotificationsOnSend,
} from "../../app/notifications-auto-prompt.ts";
import { loadLocalUserIdentity, loadSettings, patchSettings } from "../../app/settings.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { resolveSafeExternalUrl } from "../../lib/open-external-url.ts";
import {
  canonicalUiSessionKeyForPersistence,
  isUiSelectedGlobalSessionKey,
} from "../../lib/sessions/session-key.ts";
import { resolveAgentIdForSession } from "./chat-avatar.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import { attachChatRealtimeActions, createInitialChatRealtimeState } from "./chat-realtime.ts";
import {
  moveQueuedChatMessage,
  resumeStoredChatOutboxes,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import { retireChatModelSelectionOwnership } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  resetChatInputHistoryNavigation,
} from "./input-history.ts";
import {
  activeQueuedMessageEdit,
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  isQueuedMessageRemovalBlocked,
  QUEUED_MESSAGE_EDIT_CONFLICT_ERROR,
  QUEUED_MESSAGE_REMOVAL_CONFLICT_ERROR,
  updateQueuedMessageEdit,
} from "./queued-message-edit.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import { handleAbortChat, hasAbortableSessionRun, isChatStopCommand } from "./run-lifecycle.ts";
import { handleChatScroll, resetChatScroll, scheduleChatScroll } from "./scroll.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import {
  updateSidebarSessionActivePanel,
  updateSidebarSessionLayout,
} from "./sidebar-layout-persistence.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  activatePanel,
  closeSlot,
  fitSidebarLayout,
  normalizeSidebarLayout,
  openSlot,
} from "./sidebar-layout.ts";
import { resetToolStream } from "./tool-stream.ts";

type ChatPageElement = {
  getBoundingClientRect?: () => DOMRect;
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
  const agentId = resolveAgentIdForSession({
    sessionKey,
    assistantAgentId: state.assistantAgentId,
    agentsList: state.agentsList,
    hello: state.hello,
  });
  if (!agentId) {
    return;
  }
  const requestVersion = ++state.assistantIdentityRequestVersion;
  try {
    const identity = await fetchAssistantIdentity(client, agentId);
    if (
      state.client !== client ||
      !state.connected ||
      state.assistantIdentityRequestVersion !== requestVersion ||
      state.sessionKey.trim() !== expectedSessionKey ||
      !identity
    ) {
      return;
    }
    if (
      state.assistantAgentId !== (identity.agentId ?? null) &&
      isUiSelectedGlobalSessionKey(state, state.sessionKey)
    ) {
      retireChatModelSelectionOwnership(state);
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
  const sidebarSessionKey = canonicalUiSessionKeyForPersistence(
    { agentsList: context.agents.state.agentsList, hello: context.gateway?.snapshot.hello },
    settings.sessionKey,
  );
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
    automaticallyFetchFavicons: appConfig.automaticallyFetchFavicons,
    client: null,
    connected: false,
    connectionEpoch: 0,
    hello: null,
    selfUser: null,
    canvasPluginSurfaceUrl: null,
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
    chatToolMessages: [],
    guardianNotices: [],
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
    chatModelCatalogError: null,
    modelAuthStatusResult: null,
    modelAuthStatusError: null,
    sessionsResult: null,
    sessionsResultAgentId: null,
    sessionsLoading: false,
    sessionsError: null,
    sessionsArchivedFilter: "active",
    selectedChatSessionArchived: false,
    selectedChatSessionIncognito: false,
    agentsList: context.agents.state.agentsList,
    agentsSelectedId: context.agentSelection.state.selectedId,
    refreshSessionsAfterChat: new Map<string, { sessionKey: string; agentId?: string }>(),
    pendingAbort: null,
    pendingSessionMessageReloadSessionKey: null,
    chatSubmitGuards: new Map<string, Promise<void>>(),
    chatSendTimingsByRun: new Map(),
    chatQueue: [],
    chatComposerFallbackByScope: {},
    chatSendingScopeKey: null,
    chatMessagesBySession,
    eventLogBuffer: [],
    dispatchClientPresentation: (action: CommandClientPresentationAction) =>
      dispatchCommandClientPresentation(context, action),
    basePath: context.basePath,
    resourceBasePath: context.resourceBasePath,
    chatNewMessagesBelow: false,
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
    sidebarLayout: normalizeSidebarLayout(settings.sidebarSessionLayouts?.[sidebarSessionKey]),
    sidebarContent: null,
    sidebarFocusPanelId: settings.sidebarSessionActivePanels?.[sidebarSessionKey] ?? "",
    sidebarFocusVersion: 0,
    imageLightbox: null,
    imageLightboxRequestVersion: 0,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    activityEventSeqById: new Map(),
    toolStreamSyncTimer: null,
    ...createInitialChatRealtimeState(),
    renderLifecycle,
    requestUpdate: () => renderLifecycle.invalidate(),
    sessionWorkspaceState: undefined,
    backgroundTasksState: undefined,
    querySelector: page.querySelector.bind(page),
  } as unknown as ChatPageHost;

  state.resetToolStream = () => resetToolStream(state as never);
  state.resetChatInputHistoryNavigation = () => resetChatInputHistoryNavigation(state);
  state.resetChatScroll = () => resetChatScroll(state);
  state.scrollToBottom = (options) => {
    resetChatScroll(state);
    scheduleChatScroll(state, true, Boolean(options?.smooth), { source: "manual" });
  };
  state.handleChatScroll = (event) => handleChatScroll(state, event);
  state.handleChatDraftChange = (next) => handleChatDraftChange(state, next);
  state.handleChatInputHistoryKey = (input) => handleChatInputHistoryKey(state, input);
  state.applySettings = (patch) => {
    const next = { ...state.settings, ...patch };
    state.settings = patchSettings({
      chatShowThinking: next.chatShowThinking,
      chatShowToolCalls: next.chatShowToolCalls,
      chatPersistCommentary: next.chatPersistCommentary,
      chatSendShortcut: next.chatSendShortcut,
    });
    renderLifecycle.invalidate();
  };
  attachChatRealtimeActions(state);
  state.loadAssistantIdentity = () => loadPageAssistantIdentity(state);
  state.handleSendChat = (messageOverride, options, submissionAction) => {
    const message = messageOverride ?? state.chatMessage;
    const isCommand =
      parseSlashCommand(message) !== null ||
      (isChatStopCommand(message) && hasAbortableSessionRun(state));
    if (
      shouldAutoPromptNotificationsOnSend({
        connected: state.connected,
        directComposerSend:
          messageOverride === undefined &&
          options === undefined &&
          hasActiveNotificationPromptGesture(),
        message,
        hasAttachments: state.chatAttachments.length > 0,
        isCommand,
      })
    ) {
      autoPromptNotificationsOnSend(context);
    }
    return handleSendChat(state, messageOverride, options as never, submissionAction);
  };
  state.handleAbortChat = async (options) => {
    await handleAbortChat(state, options as never);
    renderLifecycle.invalidate();
  };
  state.removeQueuedMessage = (id) => {
    if (isQueuedMessageRemovalBlocked(state, id)) {
      setChatError(state, QUEUED_MESSAGE_REMOVAL_CONFLICT_ERROR);
      renderLifecycle.invalidate();
      return;
    }
    const outcome = removeQueuedMessage(state, id);
    if (outcome === "removed") {
      setChatError(state, null);
      void resumeStoredChatOutboxes(state);
    } else if (outcome === "rejected") {
      setChatError(state, OFFLINE_QUEUE_STORAGE_ERROR);
    }
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
  state.moveQueuedChatMessage = (id, toIndex) => {
    moveQueuedChatMessage(state, id, toIndex);
    renderLifecycle.invalidate();
  };
  state.editQueuedChatMessage = (id) => {
    if (beginQueuedMessageEdit(state, id) === "unavailable") {
      setChatError(state, QUEUED_MESSAGE_EDIT_CONFLICT_ERROR);
    }
    renderLifecycle.invalidate();
  };
  state.updateQueuedChatMessageEdit = (draftText) => {
    updateQueuedMessageEdit(state, draftText);
    renderLifecycle.invalidate();
  };
  state.submitQueuedChatMessageEdit = () => {
    const edit = activeQueuedMessageEdit(state);
    if (!edit) {
      return;
    }
    void state
      .handleSendChat(edit.draftText, {
        attachmentsOverride: [...edit.attachments],
        resumeQueuedMessageEditId: edit.id,
      })
      .then(
        () => renderLifecycle.invalidate(),
        () => renderLifecycle.invalidate(),
      );
  };
  state.cancelQueuedChatMessageEdit = () => {
    cancelQueuedMessageEdit(state);
    renderLifecycle.invalidate();
  };
  state.updateSidebarLayout = (layout) => {
    const normalized = normalizeSidebarLayout(layout);
    state.sidebarLayout = normalized;
    state.settings = patchSettings({
      sidebarSessionLayouts: updateSidebarSessionLayout(
        loadSettings().sidebarSessionLayouts,
        canonicalUiSessionKeyForPersistence(state, state.sessionKey),
        normalized,
      ),
    });
    renderLifecycle.invalidate();
  };
  state.updateSidebarActivePanel = (panelId) => {
    const normalizedPanelId = panelId.trim();
    if (!normalizedPanelId) {
      return;
    }
    state.sidebarFocusPanelId = normalizedPanelId;
    state.sidebarFocusVersion += 1;
    state.settings = patchSettings({
      sidebarSessionActivePanels: updateSidebarSessionActivePanel(
        loadSettings().sidebarSessionActivePanels,
        canonicalUiSessionKeyForPersistence(state, state.sessionKey),
        normalizedPanelId,
      ),
    });
    renderLifecycle.invalidate();
  };
  state.handleOpenSidebar = (content) => {
    const targetSlot = "detail";
    let opened = openSlot(state.sidebarLayout, targetSlot);
    const targetPanel = opened.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === targetSlot);
    if (targetPanel) {
      opened = activatePanel(opened, targetPanel.id);
    }
    const availableWidth = page.getBoundingClientRect?.().width ?? 0;
    const fitted =
      availableWidth > 0 && availableWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(opened, availableWidth) ?? opened)
        : opened;
    state.sidebarContent = content;
    state.updateSidebarLayout(fitted);
    if (targetPanel) {
      state.updateSidebarActivePanel(targetPanel.id);
    }
  };
  state.handleCloseSidebar = () => {
    state.updateSidebarLayout(closeSlot(state.sidebarLayout, "detail"));
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
  return state;
}
