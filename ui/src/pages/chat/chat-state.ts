import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import {
  fetchAssistantIdentity,
  loadLocalAssistantIdentity,
} from "../../app/assistant-identity.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  loadLocalUserIdentity,
  loadSettings,
  patchSettings,
  type UiSettings,
} from "../../app/settings.ts";
import { fireFirstReplyConfetti } from "../../components/confetti.ts";
import { isRenderableControlUiAvatarUrl } from "../../lib/avatar.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { retirePendingChatSideQuestion, type ChatSideResult } from "../../lib/chat/side-result.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { scopedAgentParamsForSession, type SessionCapability } from "../../lib/sessions/index.ts";
import {
  readSessionChangedEvent,
  type SessionChangedResult,
} from "../../lib/sessions/reconcile.ts";
import {
  DEFAULT_MAIN_KEY,
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiConfiguredMainKey,
  resolveUiGlobalAliasAgentId,
  resolveUiKnownSelectedGlobalAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { refreshChatAvatar, resolveAgentIdForSession } from "./chat-avatar.ts";
import { applyRemoteSlashCommandsResult, refreshSlashCommands } from "./chat-commands.ts";
import {
  handleChatGatewayEvent,
  handleChatSideResultGatewayEvent,
  type ChatEventPayload,
} from "./chat-gateway.ts";
import {
  chatScopedEventSessionMatches,
  isHiddenAssistantStreamText,
  loadChatBranches,
  loadChatHistory,
  shouldHideAssistantChatMessage,
  type ChatMetadataResult,
  type ChatState,
} from "./chat-history.ts";
import {
  readDeliveredQueuedChatSendForRun,
  removeDeliveredQueuedChatSendForRun,
  removeQueuedMessage,
  subscribeChatOutboxProjection,
  syncVisibleChatQueueProjection,
} from "./chat-queue.ts";
import {
  attachChatRealtimeActions,
  createInitialChatRealtimeState,
  resetChatRealtimeConversation,
  type ChatRealtimeState,
} from "./chat-realtime.ts";
import type { ChatSendTimingEntry } from "./chat-send-contract.ts";
import { recordChatSendServerTiming } from "./chat-send-timing.ts";
import {
  flushChatQueueForEvent,
  handleSendChat,
  resumeStoredChatOutboxes,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
  type ChatHost,
} from "./chat-send.ts";
import {
  flushChatQueueAfterIdleSessionReconciliation,
  refreshCurrentChatSessionList,
} from "./chat-session.ts";
import type { ChatProps } from "./chat-view.ts";
import {
  handleBackgroundTasksEvent,
  type BackgroundTasksHost,
} from "./components/chat-background-tasks.ts";
import {
  clearSessionWorkspaceTimers,
  type SessionWorkspaceHost,
} from "./components/chat-session-workspace.ts";
import type { SidebarContent } from "./components/chat-sidebar.ts";
import {
  CHAT_COMPOSER_DRAFT_STORAGE_ERROR,
  ChatComposerPersistence,
  type ChatComposerDraftRetry,
  type ChatComposerPersistResult,
  loadChatComposerCommittedDraftRevision,
  loadChatComposerDraftRevision,
  persistChatComposerState,
  resolveStoredChatOutboxScope,
  restoreChatComposerState,
  storedChatOutboxScopeKey,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";
import { admitInitialTurnHandoff } from "./initial-turn-handoff.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  resetChatInputHistoryNavigation,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
} from "./input-history.ts";
import { applyModelCatalogResult, loadModels } from "./models.ts";
import type { AfterCommitEffect, RenderLifecycle } from "./render-lifecycle.ts";
import {
  handleAbortChat,
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
  reconcileChatRunLifecycle,
  reconcileStaleChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import {
  cancelChatScroll,
  handleChatScroll,
  resetChatScroll,
  scheduleChatScroll,
  scheduleCommittedChatScroll,
} from "./scroll.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { preserveQueuedUserTurn, retireSteeredChipsForTerminalRun } from "./steer-lifecycle.ts";
import { isAckedSteeredChip } from "./steered-chip.ts";
import {
  clearAuthoritativeTerminal,
  rememberAuthoritativeTerminal,
} from "./terminal-message-identity.ts";
import {
  handleAgentEvent,
  handleSessionOperationEvent,
  resetToolStream,
  type CompactionStatus,
  type FallbackStatus,
  type PlanStatus,
  type ToolStreamEntry,
  type WaitingApprovalStatus,
} from "./tool-stream.ts";

type ChatPageElement = {
  querySelector: (selectors: string) => Element | null;
};

type ChatComposerMemoryFallback = {
  message: string;
  attachments: ChatAttachment[];
  storageFailed: boolean;
  draftRetry?: ChatComposerDraftRetry;
  sequence: number;
};

let lastChatComposerMemoryFallbackSequence = 0;

type ChatComposerRouteResetResult = {
  restoredFallback: boolean;
  restoredStorageFailure: boolean;
};

export type ChatPageHost = ChatHost &
  ChatState &
  ChatRealtimeState &
  SessionWorkspaceHost &
  BackgroundTasksHost & {
    sessions: SessionCapability;
    settings: UiSettings;
    password: string;
    onboarding: boolean;
    assistantName: string;
    assistantAvatar: string | null;
    assistantAvatarStatus: "none" | "local" | "remote" | "data" | null;
    assistantAvatarReason: string | null;
    assistantAvatarSource: string | null;
    assistantIdentityRequestVersion: number;
    userName: string | null;
    userAvatar: string | null;
    localMediaPreviewRoots: string[];
    embedSandboxMode: EmbedSandboxMode;
    allowExternalEmbedUrls: boolean;
    chatMessageMaxWidth: string | null;
    chatToolMessages: Record<string, unknown>[];
    chatAttachments: ChatAttachment[];
    chatQueue: ChatQueueItem[];
    chatQueueByScope: Record<string, ChatQueueItem[]>;
    chatComposerFallbackByScope: Record<string, ChatComposerMemoryFallback>;
    chatSendingScopeKey: string | null;
    chatMessagesBySession: ChatMessageCache;
    basePath: string;
    chatAvatarUrl: string | null;
    chatAvatarSource: string | null;
    chatAvatarStatus: "none" | "local" | "remote" | "data" | null;
    chatAvatarReason: string | null;
    chatSideResultTerminalRuns: Set<string>;
    chatModelSwitchPromises: Record<string, Promise<boolean>>;
    chatModelCatalog: ModelCatalogEntry[];
    modelAuthStatusResult: ModelAuthStatusResult | null;
    modelAuthStatusError: string | null;
    sessionsResult: SessionsListResult | null;
    sessionsResultAgentId: string | null;
    sessionsError: string | null;
    sessionsShowArchived: boolean;
    selectedChatSessionArchived: boolean;
    agentsList: AgentsListResult | null;
    agentsSelectedId: string | null;
    refreshSessionsAfterChat: Map<string, { sessionKey: string; agentId?: string }>;
    pendingAbort: { runId?: string | null; sessionKey: string; agentId?: string } | null;
    pendingSessionMessageReloadSessionKey: string | null;
    chatSubmitGuards: Map<string, Promise<void>>;
    chatSendTimingsByRun: Map<string, ChatSendTimingEntry>;
    chatStreamSegments: Array<{ text: string; ts: number }>;
    toolStreamById: Map<string, ToolStreamEntry>;
    toolStreamOrder: string[];
    toolStreamSyncTimer: number | null;
    compactionStatus: CompactionStatus | null;
    fallbackStatus: FallbackStatus | null;
    planStatus: PlanStatus | null;
    knownAgentRunIds: Set<string>;
    waitingApprovalStatuses: Map<string, WaitingApprovalStatus>;
    waitingApprovalResolvedIds: Set<string>;
    chatRunStatus: ChatProps["runStatus"];
    chatNewMessagesBelow: boolean;
    chatMetadataRequestVersion: number;
    chatModelsLoading: boolean;
    chatViewMenuOpen: boolean;
    chatViewMenuTrigger: HTMLElement | null;
    sessionsLoading: boolean;
    lastErrorCode: string | null;
    chatLocalInputHistoryBySession: Record<string, Array<{ text: string; ts: number }>>;
    chatInputHistorySessionKey: string | null;
    chatInputHistoryItems: string[] | null;
    chatInputHistoryIndex: number;
    chatDraftBeforeHistory: string | null;
    chatScrollCommitCleanup: (() => void) | null;
    chatStreamRenderFrame: number | null;
    chatScrollFrame: number | null;
    chatScrollGuardFrame: number | null;
    chatScrollGeneration: number;
    chatLastScrollTop: number;
    chatLastScrollHeight: number;
    chatHasAutoScrolled: boolean;
    chatUserNearBottom: boolean;
    chatFollowLocked: boolean;
    chatIsProgrammaticScroll: boolean;
    chatProgrammaticScrollTarget: number;
    chatScrollToEnd?: (options: { behavior?: ScrollBehavior }) => void;
    sidebarOpen: boolean;
    sidebarContent: SidebarContent | null;
    splitRatio: number;
    querySelector: (selectors: string) => Element | null;
    renderLifecycle: RenderLifecycle;
    requestUpdate: () => void;
    onModelChanged: () => Promise<void> | void;
    resetToolStream: () => void;
    resetChatScroll: () => void;
    resetChatInputHistoryNavigation: () => void;
    scrollToBottom: (opts?: { smooth?: boolean }) => void;
    setChatViewMenuOpen: (
      open: boolean,
      options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
    ) => void;
    loadAssistantIdentity: () => Promise<void>;
    applySettings: (next: UiSettings) => void;
    handleChatScroll: (event: Event) => void;
    handleChatDraftChange: (next: string) => void;
    handleChatInputHistoryKey: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
    handleSendChat: (messageOverride?: string, options?: unknown) => Promise<void>;
    handleAbortChat: (options?: unknown) => Promise<void>;
    removeQueuedMessage: (id: string) => void;
    retryQueuedChatMessage: (id: string) => Promise<void>;
    steerQueuedChatMessage: (id: string) => Promise<void>;
    handleOpenSidebar: (content: Parameters<SessionWorkspaceHost["handleOpenSidebar"]>[0]) => void;
    handleCloseSidebar: () => void;
    handleSplitRatioChange: (ratio: number) => void;
    announceSessionSwitch?: (sessionKey: string, label: string) => void;
    createChatSession?: () => Promise<boolean>;
    confirmConversationReset?: () => Promise<boolean>;
    exportCurrentChat?: () => Promise<void> | void;
    refreshCurrentSessionTools?: () => Promise<void>;
    refreshCurrentChat?: () => Promise<void>;
  };

type PendingCreatedSessionComposer = {
  sessionKey: string;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
};

export function canCreateChatSession(
  state: Pick<
    ChatPageHost,
    "chatLoading" | "chatSending" | "chatRunId" | "chatStream" | "chatQueue"
  >,
) {
  return (
    !state.chatLoading &&
    !state.chatSending &&
    !state.chatRunId &&
    state.chatStream === null &&
    state.chatQueue.length === 0
  );
}

function saveChatQueueForSession(state: ChatPageHost, sessionKey: string) {
  const scope = resolveStoredChatOutboxScope(state, sessionKey);
  const scopeKey = storedChatOutboxScopeKey(scope);
  const queueByScope = state.chatQueueByScope;
  if (state.chatQueue.length > 0) {
    state.chatQueueByScope = {
      ...queueByScope,
      [scopeKey]: [...state.chatQueue],
    };
    return;
  }
  if (!Object.hasOwn(queueByScope, scopeKey)) {
    return;
  }
  const nextQueueByScope = { ...queueByScope };
  delete nextQueueByScope[scopeKey];
  state.chatQueueByScope = nextQueueByScope;
}

function restoreChatQueueForSession(state: ChatPageHost, sessionKey: string): ChatQueueItem[] {
  const scope = resolveStoredChatOutboxScope(state, sessionKey);
  return [...(state.chatQueueByScope[storedChatOutboxScopeKey(scope)] ?? [])];
}

function saveChatMessagesForSession(state: ChatPageHost, sessionKey: string) {
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey },
    {
      messages: state.chatMessages,
      pagination: state.chatHistoryPagination ?? { hasMore: false },
      sessionId: state.currentSessionId ?? null,
    },
  );
}

function restoreChatMessagesForSession(
  state: ChatPageHost,
  sessionKey: string,
): ChatSessionSnapshot {
  return (
    readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey }) ?? {
      messages: [],
      pagination: { hasMore: false },
      sessionId: null,
    }
  );
}

function resolveChatComposerMemoryFallback(
  state: ChatPageHost,
  sessionKey: string,
): { fallback?: ChatComposerMemoryFallback; scopeKey: string } {
  const scope = resolveStoredChatOutboxScope(state, sessionKey);
  const scopeKey = storedChatOutboxScopeKey(scope);
  const fallback = state.chatComposerFallbackByScope[scopeKey];
  const selectedGlobalAgentId = resolveUiKnownSelectedGlobalAgentId(state);
  if (scope.sessionKey !== "global" || !scope.agentId) {
    return { fallback, scopeKey };
  }
  const configuredMainKey = resolveUiConfiguredMainKey(state);
  const isSelectedTarget = scope.agentId === selectedGlobalAgentId;
  const isDefaultTarget = scope.agentId === resolveUiDefaultAgentId(state);
  const qualifiedMainScopeKey =
    configuredMainKey === DEFAULT_MAIN_KEY
      ? undefined
      : storedChatOutboxScopeKey({
          sessionKey: buildAgentMainSessionKey({
            agentId: scope.agentId,
            mainKey: configuredMainKey,
          }),
          agentId: scope.agentId,
        });
  if (!isSelectedTarget && !isDefaultTarget && !qualifiedMainScopeKey) {
    return { fallback, scopeKey };
  }
  const fallbackSourceKeys = [
    ...new Set([
      scopeKey,
      ...(isSelectedTarget ? [storedChatOutboxScopeKey({ sessionKey: "global" })] : []),
      ...(isDefaultTarget
        ? [
            storedChatOutboxScopeKey({ sessionKey: DEFAULT_MAIN_KEY }),
            storedChatOutboxScopeKey({ sessionKey: configuredMainKey }),
          ]
        : []),
      ...(qualifiedMainScopeKey ? [qualifiedMainScopeKey] : []),
    ]),
  ];
  const candidates = fallbackSourceKeys
    .map((candidateScopeKey) => ({
      fallback: state.chatComposerFallbackByScope[candidateScopeKey],
      scopeKey: candidateScopeKey,
    }))
    .filter(
      (candidate): candidate is { fallback: ChatComposerMemoryFallback; scopeKey: string } =>
        candidate.fallback !== undefined,
    );
  const newest = candidates.toSorted(
    (left, right) => right.fallback.sequence - left.fallback.sequence,
  )[0];
  if (!newest) {
    return { scopeKey };
  }
  const sourceKey = newest.scopeKey;
  const sourceFallback = newest.fallback;
  if (candidates.length === 1 && sourceKey === scopeKey) {
    return { fallback: sourceFallback, scopeKey };
  }
  let adoptedFallback = sourceFallback;
  if (sourceKey !== scopeKey && sourceFallback.draftRetry) {
    const committedRevision = loadChatComposerCommittedDraftRevision(
      state,
      sessionKey,
      scope.agentId,
    );
    const latestRevision = loadChatComposerDraftRevision(state, sessionKey, scope.agentId);
    // Rebase only when this unresolved edit is newer than every resolved
    // attempt. Otherwise its original CAS must keep newer pane input intact.
    if (sourceFallback.draftRetry.draftRevision > latestRevision) {
      adoptedFallback = {
        ...sourceFallback,
        draftRetry: {
          ...sourceFallback.draftRetry,
          expectedDraftRevision: committedRevision,
        },
      };
    }
  }
  const nextFallbacks = { ...state.chatComposerFallbackByScope };
  for (const candidate of candidates) {
    delete nextFallbacks[candidate.scopeKey];
  }
  nextFallbacks[scopeKey] = adoptedFallback;
  state.chatComposerFallbackByScope = nextFallbacks;
  return { fallback: adoptedFallback, scopeKey };
}

export function saveRouteSessionSettings(state: ChatPageHost, sessionKey: string) {
  if (
    state.settings.sessionKey === sessionKey &&
    state.settings.lastActiveSessionKey === sessionKey
  ) {
    return;
  }
  state.settings = patchSettings({
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

export function resetChatStateForRouteSession(
  state: ChatPageHost,
  sessionKey: string,
  options: {
    retainPreviousComposerInMemory?: boolean;
    previousDraftRetry?: ChatComposerDraftRetry;
    previousComposerScope?: StoredChatOutboxScope;
  } = {},
): ChatComposerRouteResetResult {
  cancelChatStreamRenderFrame(state);
  const previousSessionKey = state.sessionKey;
  const previousComposerScopeKey = storedChatOutboxScopeKey(
    options.previousComposerScope ?? resolveStoredChatOutboxScope(state, previousSessionKey),
  );
  if (options.retainPreviousComposerInMemory) {
    state.chatComposerFallbackByScope = {
      ...state.chatComposerFallbackByScope,
      [previousComposerScopeKey]: {
        message: state.chatMessage,
        attachments: [...state.chatAttachments],
        storageFailed: options.previousDraftRetry !== undefined,
        sequence: ++lastChatComposerMemoryFallbackSequence,
        ...(options.previousDraftRetry ? { draftRetry: options.previousDraftRetry } : {}),
      },
    };
  } else if (Object.hasOwn(state.chatComposerFallbackByScope, previousComposerScopeKey)) {
    const nextFallbacks = { ...state.chatComposerFallbackByScope };
    delete nextFallbacks[previousComposerScopeKey];
    state.chatComposerFallbackByScope = nextFallbacks;
  }
  saveChatQueueForSession(state, previousSessionKey);
  saveChatMessagesForSession(state, previousSessionKey);
  const snapshot = restoreChatMessagesForSession(state, sessionKey);
  state.sessionKey = sessionKey;
  if (state.sidebarContent?.kind === "session-discussion") {
    state.sidebarContent = { ...state.sidebarContent, sessionKey };
  }
  state.selectedChatSessionArchived =
    state.sessionsResult?.sessions.some(
      (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, sessionKey),
    ) === true;
  state.currentSessionId = snapshot.sessionId;
  state.reconnectResumeSessionId = null;
  state.chatHistoryPagination = snapshot.pagination;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatReplyTarget = null;
  state.chatMessages = snapshot.messages;
  state.chatBranches = [];
  state.chatBranchesSessionKey = null;
  state.chatBranchesConnectionEpoch = null;
  state.chatBranchesLoading = false;
  state.chatToolMessages = [];
  state.chatStreamSegments = [];
  state.chatThinkingLevel = null;
  state.chatVerboseLevel = null;
  state.chatQueueModeOverride = undefined;
  state.chatEffectiveQueueMode = undefined;
  state.chatStream = null;
  state.chatSending = false;
  state.chatSendingScopeKey = null;
  state.chatSideChatTurns = [];
  state.chatSideChatHidden = false;
  state.lastError = null;
  state.chatError = null;
  state.chatRunError = null;
  state.chatAvatarUrl = null;
  state.chatAvatarSource = null;
  state.chatAvatarStatus = null;
  state.chatAvatarReason = null;
  clearAuthoritativeTerminal(state);
  resetChatRealtimeConversation(state);
  state.chatQueue = restoreChatQueueForSession(state, sessionKey);
  restoreChatComposerState(state);
  // Composer hydration reads crash-safe queue states. Reapply the process-live
  // projection without rendering through the old route's persistence owner.
  // switchPaneSession requests an update only after adopting the new baseline.
  syncVisibleChatQueueProjection(state, { requestUpdate: false });
  const initialTurn = admitInitialTurnHandoff(state, sessionKey);
  const { fallback } = resolveChatComposerMemoryFallback(state, sessionKey);
  if (fallback) {
    state.chatMessage = fallback.message;
    state.chatAttachments = [...fallback.attachments];
  }
  const restoredStorageFailure = fallback?.storageFailed === true || initialTurn;
  if (options.previousDraftRetry || restoredStorageFailure) {
    state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
    state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
  }
  state.resetChatInputHistoryNavigation();
  state.chatStreamStartedAt = null;
  reconcileChatRunLifecycle(state, {
    clearLocalRun: true,
    clearChatStream: true,
    clearToolStream: true,
    clearSideResultTerminalRuns: true,
    clearRunStatus: true,
    // chat-pane adopts the new composer owner before it renders. Rendering
    // here would persist the hydrated target through the previous owner.
    requestUpdate: false,
  });
  // After the suppression-set wipe above: retire (not just drop) a pending
  // BTW run so its late resultless terminal event cannot be adopted into the
  // old session's cached transcript.
  retirePendingChatSideQuestion(state);
  state.resetChatScroll();
  // Deliberately no saveRouteSessionSettings here: this runs for every split
  // pane, and only the active pane may write the global sessionKey /
  // lastActiveSessionKey settings (chat-pane applyActiveSessionBindings).
  return {
    restoredFallback: Boolean(fallback),
    restoredStorageFailure,
  };
}

export function retryChatComposerMemoryFallback(state: ChatPageHost, sessionKey: string): boolean {
  const { fallback, scopeKey } = resolveChatComposerMemoryFallback(state, sessionKey);
  const draftRetry = fallback?.draftRetry;
  if (!fallback?.storageFailed || !draftRetry) {
    return false;
  }
  if (
    !persistChatComposerState(state, sessionKey, {
      draft: fallback.message,
      draftRevision: draftRetry.draftRevision,
      expectedDraftRevision: draftRetry.expectedDraftRevision,
    })
  ) {
    return false;
  }
  const nextFallbacks = { ...state.chatComposerFallbackByScope };
  if (state.chatAttachments.length > 0) {
    nextFallbacks[scopeKey] = {
      ...fallback,
      storageFailed: false,
      draftRetry: undefined,
    };
  } else {
    delete nextFallbacks[scopeKey];
  }
  state.chatComposerFallbackByScope = nextFallbacks;
  if (state.chatError === CHAT_COMPOSER_DRAFT_STORAGE_ERROR) {
    state.lastError = null;
    state.chatError = null;
  }
  return true;
}

export async function refreshRouteSessionOptions(state: ChatPageHost) {
  await refreshCurrentChatSessionList(state);
}

export function resolveChatAgentId(
  state: Pick<ChatPageHost, "sessionKey" | "agentsList" | "assistantAgentId" | "hello">,
) {
  return normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ??
      scopedAgentParamsForSession(state, state.sessionKey).agentId ??
      resolveUiSelectedGlobalAgentId(state),
  );
}

export function resolveChatAvatarUrl(
  state: Pick<
    ChatPageHost,
    | "sessionKey"
    | "agentsList"
    | "assistantAgentId"
    | "hello"
    | "assistantAvatar"
    | "assistantAvatarStatus"
    | "assistantAvatarReason"
    | "chatAvatarUrl"
    | "chatAvatarStatus"
    | "chatAvatarReason"
  >,
): string | null {
  const agentId = resolveChatAgentId(state);
  if (state.chatAvatarUrl) {
    return state.chatAvatarUrl;
  }
  const localAvatar = loadLocalAssistantIdentity({ agentId }).avatar;
  if (localAvatar) {
    return localAvatar;
  }
  const avatarMissing =
    (state.chatAvatarStatus ?? state.assistantAvatarStatus) === "none" &&
    (state.chatAvatarReason ?? state.assistantAvatarReason) === "missing";
  const assistantAvatar = state.assistantAvatar;
  if (!avatarMissing && assistantAvatar && isRenderableControlUiAvatarUrl(assistantAvatar)) {
    if (state.assistantAgentId === agentId) {
      return assistantAvatar;
    }
  }
  const agent = state.agentsList?.agents?.find((candidate) => candidate.id === agentId) as
    | { identity?: { avatar?: string; avatarUrl?: string } }
    | undefined;
  const identity = agent?.identity;
  const avatar = identity?.avatarUrl ?? identity?.avatar;
  return typeof avatar === "string" && isRenderableControlUiAvatarUrl(avatar) ? avatar : null;
}

type ChatMetadataApplyResult = {
  commands: boolean;
  models: boolean;
};

type ChatRefreshOptions = {
  scheduleScroll?: boolean;
  awaitHistory?: boolean;
  startup?: boolean;
};

type ChatStartupMetadataHandler = (params: {
  client: GatewayBrowserClient;
  agentId: string | null | undefined;
  metadata: ChatMetadataResult | undefined;
}) => void | Promise<void>;

function scheduleChatMetadataRefresh(callback: () => void) {
  const requestIdleCallback =
    typeof globalThis.requestIdleCallback === "function" ? globalThis.requestIdleCallback : null;
  if (requestIdleCallback) {
    requestIdleCallback(callback, { timeout: 750 });
    return;
  }
  globalThis.setTimeout(callback, 50);
}

export async function refreshChatCommands(host: ChatPageHost) {
  await refreshSlashCommands({
    client: host.client,
    agentId: resolveChatAgentId(host),
  });
}

function applyChatMetadataResult(
  host: ChatPageHost,
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  result: ChatMetadataResult,
): ChatMetadataApplyResult {
  const models = applyModelCatalogResult(result.models);
  if (models) {
    host.chatModelCatalog = models;
  }
  const commandsApplied = applyRemoteSlashCommandsResult({
    client,
    agentId,
    result,
  });
  return { commands: commandsApplied, models: Boolean(models) };
}

function ownsChatMetadataRequest(
  host: ChatPageHost,
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  requestVersion: number,
): boolean {
  return (
    host.client === client &&
    host.connected &&
    host.chatMetadataRequestVersion === requestVersion &&
    resolveChatAgentId(host) === agentId
  );
}

async function refreshCompatibilityModelCatalog(
  host: ChatPageHost,
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  requestVersion: number,
) {
  const models = await loadModels(client);
  if (ownsChatMetadataRequest(host, client, agentId, requestVersion)) {
    host.chatModelCatalog = models;
  }
}

async function refreshCompatibilityCommands(
  host: ChatPageHost,
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  requestVersion: number,
) {
  await refreshSlashCommands({
    client,
    agentId,
    shouldApply: () => ownsChatMetadataRequest(host, client, agentId, requestVersion),
  });
}

function canUseCompatibilityModelCatalog(
  host: ChatPageHost,
  agentId: string | null | undefined,
): boolean {
  return agentId === resolveUiDefaultAgentId(host);
}

export async function refreshChatMetadata(
  host: ChatPageHost,
  opts?: { preserveModelCatalogOnFallback?: boolean },
) {
  const requestVersion = ++host.chatMetadataRequestVersion;
  if (!host.client || !host.connected) {
    host.chatModelsLoading = false;
    host.chatModelCatalog = [];
    return;
  }
  const client = host.client;
  const agentId = resolveChatAgentId(host);
  const shouldRefreshCompatibilityModels =
    !opts?.preserveModelCatalogOnFallback && canUseCompatibilityModelCatalog(host, agentId);
  const shouldClearUnresolvedModels =
    !opts?.preserveModelCatalogOnFallback && !shouldRefreshCompatibilityModels;
  host.chatModelsLoading = true;
  try {
    if (isGatewayMethodAdvertised(host as unknown as ChatState, "chat.metadata") === false) {
      if (shouldClearUnresolvedModels) {
        host.chatModelCatalog = [];
      }
      await Promise.allSettled([
        ...(shouldRefreshCompatibilityModels
          ? [refreshCompatibilityModelCatalog(host, client, agentId, requestVersion)]
          : []),
        refreshCompatibilityCommands(host, client, agentId, requestVersion),
      ]);
      return;
    }

    const result = await client.request<ChatMetadataResult>(
      "chat.metadata",
      agentId ? { agentId } : {},
    );
    if (!ownsChatMetadataRequest(host, client, agentId, requestVersion)) {
      return;
    }
    const metadataApplied = applyChatMetadataResult(host, client, agentId, result);
    if (!metadataApplied.models && shouldClearUnresolvedModels) {
      host.chatModelCatalog = [];
    }
    if (!metadataApplied.models || !metadataApplied.commands) {
      await Promise.allSettled([
        ...(!metadataApplied.models && shouldRefreshCompatibilityModels
          ? [refreshCompatibilityModelCatalog(host, client, agentId, requestVersion)]
          : []),
        ...(metadataApplied.commands
          ? []
          : [refreshCompatibilityCommands(host, client, agentId, requestVersion)]),
      ]);
    }
  } catch {
    if (ownsChatMetadataRequest(host, client, agentId, requestVersion)) {
      if (shouldClearUnresolvedModels) {
        host.chatModelCatalog = [];
      }
      await Promise.allSettled([
        ...(shouldRefreshCompatibilityModels
          ? [refreshCompatibilityModelCatalog(host, client, agentId, requestVersion)]
          : []),
        refreshCompatibilityCommands(host, client, agentId, requestVersion),
      ]);
    }
  } finally {
    if (ownsChatMetadataRequest(host, client, agentId, requestVersion)) {
      host.chatModelsLoading = false;
    }
  }
}

export async function refreshChatModelAuthStatus(host: ChatPageHost, opts?: { refresh?: boolean }) {
  if (!host.client || !host.connected) {
    return;
  }
  const client = host.client;
  try {
    const result = await loadModelAuthStatus(client, opts);
    if (host.client !== client || !host.connected) {
      return;
    }
    host.modelAuthStatusResult = result;
    host.modelAuthStatusError = null;
  } catch (err) {
    if (host.client !== client || !host.connected) {
      return;
    }
    host.modelAuthStatusResult = { ts: 0, providers: [] };
    host.modelAuthStatusError = err instanceof Error ? err.message : String(err);
  }
}

async function refreshChat(
  host: ChatPageHost,
  opts?: ChatRefreshOptions & {
    onStartupMetadata?: ChatStartupMetadataHandler;
  },
) {
  const refreshedSessionKey = host.sessionKey;
  const refreshedClient = host.client;
  const refreshedAgentId = resolveAgentIdForSession(host);
  const requestUpdate = () => host.requestUpdate?.();
  const previousSessionsResult = host.sessionsResult;
  const historyLoad = loadChatHistory(host as unknown as ChatState, {
    startup: opts?.startup === true,
  });
  const historyRefresh = historyLoad.finally(() => {
    if (opts?.scheduleScroll !== false) {
      scheduleChatScroll(host);
    }
    requestUpdate();
  });
  const sessionsRefresh = historyLoad.then((history) => {
    if (!history?.sessionInfo) {
      return;
    }
    if (areUiSessionKeysEquivalent(history.sessionInfo.key, refreshedSessionKey)) {
      host.selectedChatSessionArchived = history.sessionInfo.archived === true;
    }
    const reconciled = host.sessions.reconcile(history.sessionInfo, history.defaults, {
      resultAgentId: host.sessionsResultAgentId ?? refreshedAgentId,
      selectedGlobalAgentId: refreshedAgentId,
      showArchived: host.sessionsShowArchived,
    });
    const sessionsResult = reconciled ? host.sessions.state.result : host.sessionsResult;
    if (reconciled) {
      host.sessionsResult = sessionsResult;
    }
    const sessionInfo = sessionsResult?.sessions.find(
      (row: GatewaySessionRow) =>
        areUiSessionKeysEquivalent(row.key, history.sessionInfo?.key) ||
        row.key === refreshedSessionKey,
    );
    if (!sessionInfo) {
      return;
    }
    const runReconciled = reconcileChatRunFromSessionRow(host, sessionInfo, {
      publishRunStatus: true,
    });
    if (!runReconciled) {
      reconcileChatRunFromCurrentSessionRow(host, { publishRunStatus: true });
    }
  });
  const startupMetadataRefresh =
    opts?.startup === true && opts.onStartupMetadata && refreshedClient
      ? historyLoad.then((history) => {
          if (
            host.client !== refreshedClient ||
            !host.connected ||
            host.sessionKey !== refreshedSessionKey ||
            resolveAgentIdForSession(host) !== refreshedAgentId
          ) {
            return;
          }
          return opts.onStartupMetadata?.({
            client: refreshedClient,
            agentId: refreshedAgentId,
            metadata: history?.metadata,
          });
        })
      : Promise.resolve();
  flushChatQueueAfterIdleSessionReconciliation(
    host,
    refreshedSessionKey,
    historyRefresh,
    sessionsRefresh,
    previousSessionsResult,
    () => void flushChatQueueForEvent(host),
  );
  const secondaryRefresh = Promise.allSettled([sessionsRefresh, startupMetadataRefresh]).finally(
    requestUpdate,
  );
  void historyRefresh;
  void secondaryRefresh;
  if (opts?.awaitHistory === true) {
    await historyRefresh;
    return;
  }
  await Promise.resolve();
}

export function refreshPageChat(host: ChatPageHost, opts?: ChatRefreshOptions) {
  let resolveStartupMetadata: (result: ChatMetadataApplyResult) => void = () => {};
  const ownsStartupMetadata = Boolean(opts?.startup && host.client && host.connected);
  const startupMetadataRequestVersion = ownsStartupMetadata
    ? ++host.chatMetadataRequestVersion
    : null;
  const startupMetadataApplied = ownsStartupMetadata
    ? new Promise<ChatMetadataApplyResult>((resolve) => {
        resolveStartupMetadata = resolve;
      })
    : Promise.resolve({ commands: false, models: false });

  const refresh = refreshChat(host, {
    ...opts,
    onStartupMetadata: ({ client, agentId, metadata }) => {
      const ownsMetadata =
        startupMetadataRequestVersion !== null &&
        host.chatMetadataRequestVersion === startupMetadataRequestVersion &&
        host.client === client &&
        host.connected &&
        resolveChatAgentId(host) === agentId;
      const applied =
        metadata && ownsMetadata
          ? applyChatMetadataResult(host, client, agentId, metadata)
          : { commands: false, models: false };
      resolveStartupMetadata(applied);
    },
  });

  const refreshedSessionKey = host.sessionKey;
  const ownsScheduledMetadataRefresh = () =>
    host.sessionKey === refreshedSessionKey &&
    host.connected &&
    (startupMetadataRequestVersion === null ||
      host.chatMetadataRequestVersion === startupMetadataRequestVersion);
  scheduleChatMetadataRefresh(() => {
    if (!ownsScheduledMetadataRefresh()) {
      return;
    }
    void startupMetadataApplied
      .catch(() => ({ commands: false, models: false }))
      .then(async (metadataApplied) => {
        // Startup metadata can settle after a session switch. Recheck ownership
        // so stale startup work cannot supersede the new pane's catalog refresh.
        if (!ownsScheduledMetadataRefresh()) {
          return;
        }
        await Promise.allSettled([
          refreshChatAvatar(host),
          refreshChatMetadata(host, {
            preserveModelCatalogOnFallback: opts?.startup === true && metadataApplied.models,
          }),
        ]);
      })
      .finally(() => host.requestUpdate?.());
  });
  return refresh;
}

function sessionMessageMatchesChat(
  state: ChatPageHost,
  event: NonNullable<ReturnType<typeof readSessionChangedEvent>>,
): boolean {
  return chatScopedEventSessionMatches(state, event.key, event.agentId ?? undefined);
}

function selectedGlobalEventAgentId(state: ChatPageHost, agentId: string | null): string {
  return agentId ? normalizeAgentId(agentId) : resolveUiDefaultAgentId(state);
}

function globalSessionEventMatchesChat(
  state: ChatPageHost,
  event: NonNullable<ReturnType<typeof readSessionChangedEvent>>,
): boolean {
  if (!isUiGlobalSessionKey(event.key)) {
    return true;
  }
  const selectedAgentId = isUiGlobalSessionKey(state.sessionKey)
    ? resolveUiSelectedGlobalAgentId(state)
    : resolveUiGlobalAliasAgentId(state, state.sessionKey);
  return selectedAgentId
    ? selectedGlobalEventAgentId(state, event.agentId) === selectedAgentId
    : true;
}

function reconcileSessionEvent(state: ChatPageHost, payload: unknown): SessionChangedResult {
  const selectedAgentId = resolveChatAgentId(state);
  const reconciled = state.sessions.reconcileChanged(payload, {
    resultAgentId: state.sessionsResultAgentId ?? selectedAgentId,
    selectedGlobalAgentId: selectedAgentId,
    showArchived: state.sessionsShowArchived,
  });
  if (reconciled.applied) {
    state.sessionsResult = state.sessions.state.result;
    state.sessionsResultAgentId = state.sessions.state.agentId;
    state.sessionsError = state.sessions.state.error;
    reconcileStaleChatRunAfterSessionStatePublication(state);
  }
  return reconciled;
}

function finishSessionMessageRunReconcile(
  state: ChatPageHost,
  sessionKey: string,
  runId: string | null,
  row: SessionChangedResult["row"] | undefined,
): boolean {
  const cleared = row
    ? reconcileChatRunFromSessionRow(state, row, { publishRunStatus: true })
    : reconcileChatRunFromCurrentSessionRow(state, { publishRunStatus: true });
  if (!cleared) {
    return false;
  }
  retireSteeredChipsForTerminalRun(state, runId ?? undefined);
  void loadChatHistory(state)
    .finally(() => {
      if (!areUiSessionKeysEquivalent(state.sessionKey, sessionKey)) {
        return;
      }
      void flushChatQueueForEvent(state);
      state.requestUpdate?.();
    })
    .catch(() => undefined);
  return true;
}

function handleSessionMessageEvent(state: ChatPageHost, payload: unknown) {
  const event = readSessionChangedEvent(payload);
  if (!event || !globalSessionEventMatchesChat(state, event)) {
    return;
  }
  const matchesChat = sessionMessageMatchesChat(state, event);
  if (matchesChat) {
    void loadChatBranches(state);
  }
  if (matchesChat && event.archived !== null) {
    state.selectedChatSessionArchived = event.archived;
  }
  const runIdBeforeApply = state.chatRunId;
  rememberAuthoritativeTerminal({ event, host: state, matchesChat, payload, runIdBeforeApply });
  const result = reconcileSessionEvent(state, payload);
  if (runIdBeforeApply && matchesChat) {
    const runId = event.clientRunId ?? event.runId ?? runIdBeforeApply;
    state.pendingSessionMessageReloadSessionKey = event.key;
    if (event.hasActiveRun === true) {
      return;
    }
    if (finishSessionMessageRunReconcile(state, event.key, runId, result.row)) {
      state.pendingSessionMessageReloadSessionKey = null;
      return;
    }
    void refreshCurrentChatSessionList(state).then(() => {
      if (!state.pendingSessionMessageReloadSessionKey || state.chatRunId !== runIdBeforeApply) {
        return;
      }
      if (
        finishSessionMessageRunReconcile(
          state,
          state.pendingSessionMessageReloadSessionKey,
          runId,
          undefined,
        )
      ) {
        state.pendingSessionMessageReloadSessionKey = null;
      }
    });
    return;
  }
  if (matchesChat) {
    state.pendingSessionMessageReloadSessionKey = null;
    void loadChatHistory(state).finally(() => state.requestUpdate?.());
  }
}

function replayPendingSessionMessageReload(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
) {
  const pendingSessionKey = state.pendingSessionMessageReloadSessionKey;
  const payloadSessionKey = payload?.sessionKey?.trim();
  if (
    !pendingSessionKey ||
    !payloadSessionKey ||
    !areUiSessionKeysEquivalent(pendingSessionKey, payloadSessionKey) ||
    !areUiSessionKeysEquivalent(payloadSessionKey, state.sessionKey) ||
    state.chatRunId
  ) {
    return;
  }
  state.pendingSessionMessageReloadSessionKey = null;
  void loadChatHistory(state).finally(() => state.requestUpdate?.());
}

function handleSessionsChangedEvent(state: ChatPageHost, payload: unknown) {
  const runIdBeforeApply = state.chatRunId;
  const event = readSessionChangedEvent(payload);
  const matchesChat = Boolean(
    event && globalSessionEventMatchesChat(state, event) && sessionMessageMatchesChat(state, event),
  );
  if (matchesChat) {
    void loadChatBranches(state);
  }
  if (event && matchesChat && event.archived !== null) {
    state.selectedChatSessionArchived = event.archived;
  }
  const result = reconcileSessionEvent(state, payload);
  if (
    result.applied &&
    event &&
    runIdBeforeApply &&
    matchesChat &&
    finishSessionMessageRunReconcile(
      state,
      event.key,
      event.clientRunId ?? event.runId ?? runIdBeforeApply,
      result.row,
    )
  ) {
    return;
  }
  if (!result.applied && event?.isChatTurn !== true) {
    void refreshCurrentChatSessionList(state);
  }
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
    chatMessageMaxWidth: appConfig.chatMessageMaxWidth,
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
    chatMessages: [] as unknown[],
    chatBranches: [],
    chatBranchesSessionKey: null,
    chatBranchesConnectionEpoch: null,
    chatBranchesLoading: false,
    chatToolMessages: [] as Record<string, unknown>[],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatQueueModeOverride: undefined,
    chatEffectiveQueueMode: undefined,
    chatAttachments: [] as ChatAttachment[],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    chatError: null,
    chatRunError: null,
    agentsError: null,
    chatStreamSegments: [] as Array<{ text: string; ts: number }>,
    chatSideChatTurns: [] as ChatSideResult[],
    chatSideResultPending: null,
    chatSideResultTerminalRuns: new Set<string>(),
    chatSideChatHidden: false,
    chatRunStatus: null,
    compactionStatus: null,
    fallbackStatus: null,
    planStatus: null,
    knownAgentRunIds: new Set(),
    waitingApprovalStatuses: new Map(),
    waitingApprovalResolvedIds: new Set(),
    chatAvatarUrl: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    chatModelSwitchPromises: {} as Record<string, Promise<boolean>>,
    chatModelsLoading: false,
    chatMetadataRequestVersion: 0,
    chatModelCatalog: [] as ModelCatalogEntry[],
    modelAuthStatusResult: null,
    modelAuthStatusError: null,
    sessionsResult: null,
    sessionsResultAgentId: null,
    sessionsLoading: false,
    sessionsError: null,
    sessionsShowArchived: false,
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
    chatSendTimingsByRun: new Map<string, ChatSendTimingEntry>(),
    chatQueue: [] as ChatQueueItem[],
    chatQueueByScope: {} as Record<string, ChatQueueItem[]>,
    chatComposerFallbackByScope: {} as Record<string, ChatComposerMemoryFallback>,
    chatSendingScopeKey: null,
    chatMessagesBySession,
    eventLogBuffer: [] as unknown[],
    basePath: context.basePath,
    chatNewMessagesBelow: false,
    chatViewMenuOpen: false,
    chatViewMenuTrigger: null,
    chatLocalInputHistoryBySession: {} as Record<string, Array<{ text: string; ts: number }>>,
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
    splitRatio: settings.splitRatio,
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [] as string[],
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
  state.loadAssistantIdentity = async () => {
    await loadPageAssistantIdentity(state);
  };
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
  state.handleSplitRatioChange = (ratio) => {
    const next = Math.max(0.4, Math.min(0.7, ratio));
    state.applySettings({ ...state.settings, splitRatio: next });
  };
  return state;
}

function hasVisibleFinalAssistantReply(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
): boolean {
  if (payload?.state !== "final") {
    return false;
  }
  const ownsReply =
    chatScopedEventSessionMatches(state, payload.sessionKey, payload.agentId) ||
    (typeof payload.runId === "string" && payload.runId === state.chatRunId);
  if (!ownsReply) {
    return false;
  }
  const finalText = extractText(payload.message);
  if (
    typeof finalText === "string" &&
    finalText.trim().length > 0 &&
    !isHiddenAssistantStreamText(finalText) &&
    !shouldHideAssistantChatMessage(payload.message)
  ) {
    return true;
  }
  return [
    state.chatStream,
    ...(state.chatStreamSegments ?? []).map((segment) => segment.text),
  ].some(
    (text) =>
      typeof text === "string" && text.trim().length > 0 && !isHiddenAssistantStreamText(text),
  );
}

export function handlePageGatewayEvent(state: ChatPageHost, event: GatewayEventFrame) {
  if (event.event === "chat") {
    const payload = event.payload as ChatEventPayload | undefined;
    const shouldCelebrateFirstReply = hasVisibleFinalAssistantReply(state, payload);
    const terminal =
      payload?.state === "final" || payload?.state === "aborted" || payload?.state === "error";
    const delivered = terminal ? rememberDeliveredQueuedUserTurn(state, payload?.runId) : null;
    if (delivered) {
      // The queued projection is the only local copy until history catches up.
      // Materialize it before the terminal assistant to preserve transcript order.
      preserveQueuedUserTurn(state, delivered);
    }
    const result = handleChatGatewayEvent(state as unknown as ChatState, payload);
    if (shouldCelebrateFirstReply && result === "final") {
      fireFirstReplyConfetti();
    }
    replayPendingSessionMessageReload(state, payload);
    if (terminal) {
      removeDeliveredQueuedChatSendForRun(state, payload?.runId);
      void resumeStoredChatOutboxes(state);
    }
    requestChatPageUpdate(state, payload?.state === "delta" ? "animation-frame" : "immediate");
    return;
  }
  if (event.event === "chat.side_result") {
    if (handleChatSideResultGatewayEvent(state as unknown as ChatState, event.payload)) {
      requestChatPageUpdate(state);
    }
    return;
  }
  if (event.event === "agent" || event.event === "session.tool") {
    handleAgentEvent(state as never, event.payload as never);
    requestChatPageUpdate(state);
    return;
  }
  if (event.event === "session.operation") {
    handleSessionOperationEvent(state as never, event.payload as never);
    requestChatPageUpdate(state);
    return;
  }
  if (event.event === "chat.send_timing") {
    recordChatSendServerTiming(state, event.payload);
    return;
  }
  if (event.event === "session.message") {
    handleSessionMessageEvent(state, event.payload);
    void resumeStoredChatOutboxes(state);
    requestChatPageUpdate(state);
    return;
  }
  if (event.event === "sessions.changed") {
    handleSessionsChangedEvent(state, event.payload);
    void resumeStoredChatOutboxes(state);
    requestChatPageUpdate(state);
    return;
  }
  if (event.event === "task") {
    handleBackgroundTasksEvent(state, event.payload);
  }
}

const MAX_REMEMBERED_DELIVERED_QUEUE_TURNS = 64;
const deliveredQueueTurnsByClient = new WeakMap<object, Map<string, ChatQueueItem>>();

function rememberDeliveredQueuedUserTurn(
  state: ChatPageHost,
  runId: string | undefined,
): ChatQueueItem | null {
  if (!runId) {
    return null;
  }
  // Every split pane receives the same Gateway event. Keep a bounded delivery
  // handoff so an inactive pane cannot retire the durable row before its owner
  // converts the queued projection into a transcript message.
  const owner = state.client ?? state;
  let turns = deliveredQueueTurnsByClient.get(owner);
  if (!turns) {
    turns = new Map();
    deliveredQueueTurnsByClient.set(owner, turns);
  }
  const pending = state.chatQueue.find(
    (item) => isAckedSteeredChip(item) && item.pendingRunId === runId,
  );
  const stored = readDeliveredQueuedChatSendForRun(state, runId)?.item;
  if (stored) {
    turns.delete(runId);
    turns.set(runId, stored);
    while (turns.size > MAX_REMEMBERED_DELIVERED_QUEUE_TURNS) {
      const oldestRunId = turns.keys().next().value;
      if (typeof oldestRunId !== "string") {
        break;
      }
      turns.delete(oldestRunId);
    }
  }
  // Original-turn copies first: a run can own both its queued turn (stored, or
  // its remembered fallback in `turns`) and a steered follow-up chip; the chip
  // is preserved separately by retireSteeredChipsForTerminalRun and must not
  // mask the original copy here.
  return stored ?? turns.get(runId) ?? pending ?? null;
}

type ChatPageUpdateMode = "immediate" | "animation-frame";

function cancelChatStreamRenderFrame(state: Pick<ChatPageHost, "chatStreamRenderFrame">): void {
  const frame = state.chatStreamRenderFrame;
  if (frame == null) {
    return;
  }
  state.chatStreamRenderFrame = null;
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(frame);
  }
}

function requestChatPageUpdate(
  state: Pick<ChatPageHost, "chatStreamRenderFrame" | "requestUpdate">,
  mode: ChatPageUpdateMode = "immediate",
): void {
  if (mode === "immediate" || typeof globalThis.requestAnimationFrame !== "function") {
    cancelChatStreamRenderFrame(state);
    state.requestUpdate?.();
    return;
  }
  if (state.chatStreamRenderFrame != null) {
    return;
  }
  // Deltas still mutate the canonical stream immediately. One frame owns the
  // paint; terminal/non-stream events cancel it so stale partial UI cannot win.
  let frame = 0;
  frame = globalThis.requestAnimationFrame(() => {
    if (state.chatStreamRenderFrame !== frame) {
      return;
    }
    state.chatStreamRenderFrame = null;
    state.requestUpdate?.();
  });
  state.chatStreamRenderFrame = frame;
}

type ChatRenderLifecycleScope = {
  connectionEpoch: number;
  cancellations: Set<() => void>;
};

export class ChatStateController<TState extends ChatPageHost> implements ReactiveController {
  private readonly composerPersistence: ChatComposerPersistence;
  private stateValue: TState | undefined;
  private previousChatLoading = false;
  private previousChatMessages: unknown[] = [];
  private previousChatToolMessages: Record<string, unknown>[] = [];
  private previousChatStream: string | null = null;
  private previousRealtimeConversation: ChatPageHost["realtimeTalkConversation"] = [];
  private scrollAfterUpdate = false;
  private scrollContentChangedAfterUpdate = false;
  private forceScrollAfterUpdate = false;
  private chatThreadResizeObserver: ResizeObserver | null = null;
  private chatThreadResizeTargets:
    | {
        thread: Element;
      }
    | undefined;
  private pendingCreatedSessionComposer: PendingCreatedSessionComposer | null = null;
  private readonly cleanups: Array<() => void> = [];
  private renderLifecycleConnected = false;
  private renderLifecycleConnectionEpoch = 0;
  private renderLifecycleScope: ChatRenderLifecycleScope | undefined;

  constructor(private readonly host: ReactiveControllerHost) {
    this.composerPersistence = new ChatComposerPersistence(() => this.stateValue);
    host.addController(this);
  }

  get state(): TState | undefined {
    return this.stateValue;
  }

  createRenderLifecycle(): RenderLifecycle {
    this.cancelRenderLifecycleScope();
    const scope: ChatRenderLifecycleScope = {
      connectionEpoch: this.renderLifecycleConnectionEpoch,
      cancellations: new Set(),
    };
    this.renderLifecycleScope = scope;
    return {
      invalidate: () => {
        this.requestUpdateForScope(scope);
      },
      afterCommit: (effect, onCancel) => this.afterCommit(scope, effect, onCancel),
    };
  }

  attach(state: TState) {
    if (this.stateValue && this.stateValue !== state) {
      this.composerPersistence.stop();
      cancelChatStreamRenderFrame(this.stateValue);
      cancelChatScroll(this.stateValue);
    }
    this.stateValue = state;
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
    const renderLifecycle = state.renderLifecycle;
    state.requestUpdate = () => renderLifecycle.invalidate();
    this.cleanups.push(subscribeChatOutboxProjection(state));
    const sendChat = state.handleSendChat;
    state.handleSendChat = async (messageOverride, options) => {
      const pending = sendChat(messageOverride, options);
      renderLifecycle.invalidate();
      try {
        await pending;
      } finally {
        renderLifecycle.invalidate();
      }
    };
    const commitDraftChange = state.handleChatDraftChange;
    state.handleChatDraftChange = (next) => {
      commitDraftChange(next);
      this.composerPersistence.schedule();
    };
    const navigateInputHistory = state.handleChatInputHistoryKey;
    state.handleChatInputHistoryKey = (input) => {
      const result = navigateInputHistory(input);
      if (result.handled) {
        this.composerPersistence.schedule();
      }
      return result;
    };
  }

  addCleanup(cleanup: () => void) {
    this.cleanups.push(cleanup);
  }

  private isRenderLifecycleScopeActive(scope: ChatRenderLifecycleScope): boolean {
    return (
      this.renderLifecycleConnected &&
      this.renderLifecycleScope === scope &&
      scope.connectionEpoch === this.renderLifecycleConnectionEpoch
    );
  }

  private requestUpdateForScope(scope: ChatRenderLifecycleScope): boolean {
    if (!this.isRenderLifecycleScopeActive(scope)) {
      return false;
    }
    this.composerPersistence.persistChangedState();
    this.captureRenderLifecycleChanges();
    this.host.requestUpdate();
    return true;
  }

  private cancelRenderLifecycleScope(): void {
    const scope = this.renderLifecycleScope;
    if (!scope) {
      return;
    }
    this.renderLifecycleScope = undefined;
    for (const cancel of scope.cancellations) {
      cancel();
    }
  }

  private afterCommit(
    scope: ChatRenderLifecycleScope,
    effect: AfterCommitEffect,
    onCancel?: () => void,
  ): () => void {
    if (!this.isRenderLifecycleScopeActive(scope)) {
      onCancel?.();
      return () => undefined;
    }
    let active = true;
    let committed = false;
    let cleanup: (() => void) | undefined;
    const complete = () => {
      if (!active) {
        return;
      }
      active = false;
      cleanup = undefined;
      scope.cancellations.delete(cancel);
    };
    const cancel = () => {
      if (!active) {
        return;
      }
      active = false;
      scope.cancellations.delete(cancel);
      try {
        cleanup?.();
      } finally {
        cleanup = undefined;
        if (!committed) {
          onCancel?.();
        }
      }
    };
    scope.cancellations.add(cancel);
    // Request first so updateComplete represents the render this effect needs.
    if (!this.requestUpdateForScope(scope)) {
      cancel();
      return cancel;
    }
    const completion = this.host.updateComplete;
    void completion.then(() => {
      if (!active) {
        return;
      }
      if (!this.isRenderLifecycleScopeActive(scope)) {
        cancel();
        return;
      }
      committed = true;
      try {
        const nextCleanup = effect(complete);
        if (typeof nextCleanup === "function") {
          if (active && this.isRenderLifecycleScopeActive(scope)) {
            cleanup = nextCleanup;
          } else {
            nextCleanup();
          }
        } else {
          complete();
        }
      } catch (error) {
        complete();
        throw error;
      }
    }, cancel);
    return cancel;
  }

  private captureRenderLifecycleChanges() {
    const state = this.stateValue;
    if (!state) {
      return;
    }
    const messagesChanged =
      this.previousChatMessages !== state.chatMessages ||
      this.previousChatToolMessages !== state.chatToolMessages ||
      this.previousRealtimeConversation !== state.realtimeTalkConversation;
    const streamChanged = this.previousChatStream !== state.chatStream;
    const loadingChanged = this.previousChatLoading !== state.chatLoading;
    const loadFinished = this.previousChatLoading && !state.chatLoading;
    const streamStarted = this.previousChatStream == null && typeof state.chatStream === "string";
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
    if (!messagesChanged && !streamChanged && !loadingChanged) {
      return;
    }
    this.scrollAfterUpdate = true;
    this.scrollContentChangedAfterUpdate ||= messagesChanged || streamChanged;
    this.forceScrollAfterUpdate ||= loadFinished || streamStarted || !state.chatHasAutoScrolled;
  }

  private syncChatThreadResizeObserver(state: TState) {
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const thread = state.querySelector(".chat-thread");
    if (thread && this.chatThreadResizeTargets?.thread === thread) {
      return;
    }

    this.chatThreadResizeObserver?.disconnect();
    this.chatThreadResizeObserver = null;
    this.chatThreadResizeTargets = undefined;
    if (!thread) {
      return;
    }

    // The transcript virtualizer owns row measurement and content-height
    // correction. This observer only follows viewport-size changes.
    this.chatThreadResizeObserver = new ResizeObserver(() => {
      const currentState = this.stateValue;
      if (!currentState) {
        return;
      }
      scheduleCommittedChatScroll(currentState, false, false, { source: "resize" });
    });
    this.chatThreadResizeObserver.observe(thread);
    this.chatThreadResizeTargets = { thread };
  }

  hostConnected() {
    this.renderLifecycleConnectionEpoch += 1;
    this.renderLifecycleConnected = true;
    // A lifecycle created while detached must never become active on reconnect.
    this.cancelRenderLifecycleScope();
  }

  hostUpdated() {
    const state = this.stateValue;
    if (state) {
      this.syncChatThreadResizeObserver(state);
    }
    if (!this.scrollAfterUpdate) {
      return;
    }
    const force = this.forceScrollAfterUpdate;
    const contentChanged = this.scrollContentChangedAfterUpdate;
    this.scrollAfterUpdate = false;
    this.scrollContentChangedAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
    if (!state) {
      return;
    }
    scheduleCommittedChatScroll(state, force, false, { contentChanged });
  }

  restoreComposer(options: { preserveCurrent?: boolean } = {}) {
    this.composerPersistence.restore(options);
  }

  startComposerPersistence() {
    this.composerPersistence.start();
  }

  persistComposerForRouteSwitch(): ChatComposerPersistResult {
    return this.composerPersistence.persistForRouteSwitchResult();
  }

  composerScopeForRouteSwitch(): StoredChatOutboxScope | null {
    return this.composerPersistence.scopeForRouteSwitch();
  }

  adoptComposerRoute() {
    this.composerPersistence.adoptCurrentRoute();
  }

  captureCreatedSessionComposer(sessionKey: string) {
    const state = this.stateValue;
    if (!state) {
      return;
    }
    this.pendingCreatedSessionComposer = {
      sessionKey,
      chatMessage: state.chatMessage,
      chatAttachments: state.chatAttachments,
    };
  }

  restoreCreatedSessionComposer(sessionKey: string | null | undefined): boolean {
    const state = this.stateValue;
    const pending = this.pendingCreatedSessionComposer;
    if (!state || !pending || pending.sessionKey !== sessionKey) {
      return false;
    }
    this.pendingCreatedSessionComposer = null;
    state.chatMessage = pending.chatMessage;
    state.chatAttachments = pending.chatAttachments;
    this.composerPersistence.persistNow();
    return true;
  }

  private stopChatEffects() {
    this.chatThreadResizeObserver?.disconnect();
    this.chatThreadResizeObserver = null;
    this.chatThreadResizeTargets = undefined;
    while (this.cleanups.length > 0) {
      this.cleanups.pop()?.();
    }
    const state = this.stateValue;
    if (state) {
      cancelChatStreamRenderFrame(state);
      cancelChatScroll(state);
      clearSessionWorkspaceTimers(state);
    }
    state?.realtimeTalkSession?.stop();
    if (state) {
      state.realtimeTalkSession = null;
      state.realtimeTalkVideoStream = null;
      state.realtimeTalkCameraDevices = [];
      state.realtimeTalkVideoCapable = false;
      state.realtimeTalkVideoPending = false;
      state.realtimeTalkCameraError = false;
      state.resetToolStream?.();
    }
  }

  hostDisconnected() {
    this.renderLifecycleConnected = false;
    this.cancelRenderLifecycleScope();
    // Flush while stateValue still points at the active session. Composer
    // persistence is owned here so controller registration order cannot lose it.
    this.composerPersistence.stop();
    this.stopChatEffects();
    this.stateValue = undefined;
    this.scrollAfterUpdate = false;
    this.scrollContentChangedAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
    this.pendingCreatedSessionComposer = null;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
