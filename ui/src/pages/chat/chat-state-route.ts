import { loadLocalAssistantIdentity } from "../../app/assistant-identity.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { isRenderableControlUiAvatarUrl } from "../../lib/avatar.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { scopedAgentParamsForSession, type SessionCapability } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  canonicalUiSessionKeyForPersistence,
  isUiGlobalSessionKey,
  isUiGlobalScopeConfigured,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import {
  resolveChatComposerMemoryFallback,
  storeChatComposerMemoryFallback,
} from "./chat-composer-memory-fallback.ts";
import {
  readChatQueueForScope,
  syncVisibleChatQueueProjection,
  writeChatQueueForScope,
} from "./chat-queue.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { invalidateImageLightbox } from "./chat-state-page.ts";
import { cancelChatStreamRenderFrame } from "./chat-state-render.ts";
import {
  CHAT_COMPOSER_DRAFT_STORAGE_ERROR,
  persistChatComposerState,
  resolveStoredChatOutboxScope,
  restoreChatComposerState,
  storedChatOutboxScopeKey,
  type ChatComposerDraftRetry,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";
import { admitInitialTurnHandoff, admitInitialUserMessageHandoff } from "./initial-turn-handoff.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { normalizeSidebarLayout } from "./sidebar-layout.ts";
import { clearAuthoritativeTerminal } from "./terminal-message-identity.ts";

type ChatComposerRouteResetResult = {
  restoredFallback: boolean;
  restoredStorageFailure: boolean;
};

export function canCreateChatSession(state: ChatPageHost) {
  return (
    !state.chatLoading &&
    !state.chatSending &&
    !state.chatRunId &&
    state.chatStream === null &&
    state.chatQueue.length === 0
  );
}

export function selectedChatSessionRow(state: ChatPageHost) {
  const rows = state.sessionsResult?.sessions ?? [];
  const exact = rows.find((candidate) =>
    areUiSessionKeysEquivalent(candidate.key, state.sessionKey),
  );
  const row =
    exact ??
    (isUiGlobalScopeConfigured(state)
      ? rows.find((candidate) =>
          uiSessionRowMatchesSelectedChat(state, candidate.key, state.sessionKey),
        )
      : undefined);
  if (!row || !isUiGlobalSessionKey(row.key)) {
    return row;
  }
  const selectedAgentId = resolveUiSelectedGlobalAgentId(state);
  if (
    state.sessionsResultAgentId &&
    normalizeAgentId(state.sessionsResultAgentId) !== selectedAgentId
  ) {
    return undefined;
  }
  if (
    row.observerDigest?.agentId &&
    normalizeAgentId(row.observerDigest.agentId) !== selectedAgentId
  ) {
    return { ...row, observerDigest: undefined };
  }
  return row;
}

function saveChatQueueForSession(state: ChatPageHost, sessionKey: string) {
  const scope = resolveStoredChatOutboxScope(state, sessionKey);
  writeChatQueueForScope(state, sessionKey, state.chatQueue, scope.agentId, {
    requestUpdate: false,
  });
}

function restoreChatQueueForSession(state: ChatPageHost, sessionKey: string): ChatQueueItem[] {
  const scope = resolveStoredChatOutboxScope(state, sessionKey);
  return readChatQueueForScope(state, sessionKey, scope.agentId);
}

function saveChatMessagesForSession(state: ChatPageHost, sessionKey: string) {
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey },
    {
      ...(state.chatDisplayedLeafEntryId !== undefined
        ? { displayedLeafEntryId: state.chatDisplayedLeafEntryId }
        : {}),
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

export function saveRouteSessionSettings(state: ChatPageHost, sessionKey: string) {
  if (
    state.settings.sessionKey === sessionKey &&
    state.settings.lastActiveSessionKey === sessionKey
  ) {
    return;
  }
  state.settings = patchSettings({ sessionKey, lastActiveSessionKey: sessionKey });
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
  stopChatRealtimeTalk(state);
  const previousSessionKey = state.sessionKey;
  const previousComposerScope =
    options.previousComposerScope ?? resolveStoredChatOutboxScope(state, previousSessionKey);
  const previousComposerScopeKey = storedChatOutboxScopeKey(previousComposerScope);
  if (options.retainPreviousComposerInMemory) {
    storeChatComposerMemoryFallback(state, previousComposerScope, {
      message: state.chatMessage,
      attachments: state.chatAttachments,
      ...(options.previousDraftRetry ? { draftRetry: options.previousDraftRetry } : {}),
    });
  } else if (Object.hasOwn(state.chatComposerFallbackByScope, previousComposerScopeKey)) {
    const nextFallbacks = { ...state.chatComposerFallbackByScope };
    delete nextFallbacks[previousComposerScopeKey];
    state.chatComposerFallbackByScope = nextFallbacks;
  }
  saveChatQueueForSession(state, previousSessionKey);
  saveChatMessagesForSession(state, previousSessionKey);
  const snapshot = restoreChatMessagesForSession(state, sessionKey);
  state.sessionKey = sessionKey;
  state.sidebarContent = null;
  const sidebarSessionKey = canonicalUiSessionKeyForPersistence(state, sessionKey);
  const sidebarSettings = loadSettings();
  state.sidebarLayout = normalizeSidebarLayout(
    sidebarSettings.sidebarSessionLayouts?.[sidebarSessionKey],
  );
  state.sidebarFocusPanelId = sidebarSettings.sidebarSessionActivePanels?.[sidebarSessionKey] ?? "";
  state.sidebarFocusVersion += 1;
  invalidateImageLightbox(state);
  state.selectedChatSessionArchived =
    state.sessionsResult?.sessions.some(
      (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, sessionKey),
    ) === true;
  state.currentSessionId = snapshot.sessionId;
  state.chatDisplayedLeafEntryId = snapshot.displayedLeafEntryId;
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
  state.observerDigest = null;
  state.chatRunUsageById = new Map();
  state.chatSending = false;
  state.chatSendingScopeKey = null;
  state.lastError = null;
  state.chatError = null;
  state.chatRunError = null;
  state.chatAvatarUrl = null;
  state.chatAvatarSource = null;
  state.chatAvatarStatus = null;
  state.chatAvatarReason = null;
  clearAuthoritativeTerminal(state);
  state.chatQueue = restoreChatQueueForSession(state, sessionKey);
  restoreChatComposerState(state);
  // Composer hydration reads crash-safe queue states. Reapply the process-live
  // projection without rendering through the old route's persistence owner.
  // switchPaneSession requests an update only after adopting the new baseline.
  syncVisibleChatQueueProjection(state, { requestUpdate: false });
  const initialTurn = admitInitialTurnHandoff(state, sessionKey);
  admitInitialUserMessageHandoff(state.initialUserMessage, state, sessionKey);
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
    clearRunStatus: true,
    // chat-pane adopts the new composer owner before it renders. Rendering
    // here would persist the hydrated target through the previous owner.
    requestUpdate: false,
  });
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

export function resolveChatAgentId(state: ChatPageHost) {
  return normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ??
      scopedAgentParamsForSession(state, state.sessionKey).agentId ??
      resolveUiSelectedGlobalAgentId(state),
  );
}

export function patchChatSessionLabel(
  state: ChatPageHost,
  sessions: Pick<SessionCapability, "patch">,
  sessionKey: string,
  label: string | null,
) {
  return sessions.patch(sessionKey, { label }, { agentId: resolveChatAgentId(state) });
}

export function resolveChatAvatarUrl(state: ChatPageHost): string | null {
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
  if (
    !avatarMissing &&
    assistantAvatar &&
    isRenderableControlUiAvatarUrl(assistantAvatar) &&
    state.assistantAgentId === agentId
  ) {
    return assistantAvatar;
  }
  const agent = state.agentsList?.agents?.find((candidate) => candidate.id === agentId) as
    | { identity?: { avatar?: string; avatarUrl?: string } }
    | undefined;
  const identity = agent?.identity;
  const avatar = identity?.avatarUrl ?? identity?.avatar;
  return typeof avatar === "string" && isRenderableControlUiAvatarUrl(avatar) ? avatar : null;
}
