import type { FastMode, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { resolveChatModelOverrideValue } from "../../lib/chat/model-select-state.ts";
import { normalizeThinkLevel } from "../../lib/chat/thinking.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  scopedAgentParamsForSession,
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
  resolveSessionKey,
  type SessionCapability,
  type SessionListOptions,
  type SessionRefreshTarget,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import type { ChatHistoryResult } from "./chat-history.ts";

const CHAT_SESSION_LIST_ACTIVE_MINUTES = 0;
const CHAT_SESSION_LIST_LIMIT = 50;

type ChatSessionListHost = {
  sessionsShowArchived?: boolean;
};

type ChatSessionRefreshHost = ChatSessionListHost &
  SessionScopeHost & {
    sessionKey: string;
    sessions: Pick<SessionCapability, "refresh">;
  };

type ChatModelSettingsHost = ChatSessionRefreshHost & {
  client: unknown;
  connected: boolean;
  lastError?: string | null;
  chatError?: string | null;
  chatModelCatalog: Parameters<typeof resolveChatModelOverrideValue>[0]["chatModelCatalog"];
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  chatThinkingLevel: string | null;
  onModelChanged?: () => unknown;
  sessions: SessionCapability;
  sessionsResult?: SessionsListResult | null;
  requestUpdate?: () => void;
};

type ChatIdleSessionReconciliationHost = SessionScopeHost & {
  chatQueue: unknown[];
  sessionKey: string;
  sessionsError?: string | null;
  sessionsResult?: SessionsListResult | null;
};

export function buildChatSessionListOptions(
  _state: ChatSessionListHost,
  options: { offset?: number; append?: boolean; search?: string | null } = {},
): SessionListOptions {
  const result: SessionListOptions = {
    activeMinutes: CHAT_SESSION_LIST_ACTIVE_MINUTES,
    limit: CHAT_SESSION_LIST_LIMIT,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    showArchived: false,
  };
  const search = normalizeOptionalString(options.search ?? undefined);
  if (search) {
    result.search = search;
  }
  const offset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  if (offset > 0) {
    result.offset = offset;
  }
  if (options.append === true) {
    result.append = true;
  }
  return result;
}

export function refreshCurrentChatSessionList(host: ChatSessionRefreshHost): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForSession(host, host.sessionKey),
    force: true,
  });
}

export function refreshChatSessionListForTarget(
  host: ChatSessionListHost &
    SessionScopeHost & {
      sessions: Pick<SessionCapability, "refresh">;
    },
  target: SessionRefreshTarget,
): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForRefreshTarget(host, target),
    force: true,
  });
}

function isSelectedSessionKnownIdle(
  sessionsResult: SessionsListResult,
  sessionKey: string,
): boolean {
  const row = sessionsResult.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, sessionKey),
  );
  return Boolean(row && !isSessionRunActive(row));
}

function isHistorySessionInfoForRequestedSession(
  host: ChatIdleSessionReconciliationHost,
  historySessionKey: string | undefined,
  requestedSessionKey: string,
): boolean {
  if (areUiSessionKeysEquivalent(historySessionKey, requestedSessionKey)) {
    return true;
  }
  return Boolean(
    historySessionKey &&
    isUiGlobalSessionKey(historySessionKey) &&
    resolveUiGlobalAliasAgentId(host, requestedSessionKey),
  );
}

function findSelectedSessionRow(
  host: ChatIdleSessionReconciliationHost,
  sessionsResult: SessionsListResult | null | undefined,
  sessionKey: string,
  historySessionKey: string | undefined,
): GatewaySessionRow | undefined {
  const requestedGlobalAgentId =
    historySessionKey && isUiGlobalSessionKey(historySessionKey)
      ? resolveUiGlobalAliasAgentId(host, sessionKey)
      : undefined;
  return sessionsResult?.sessions.find((session) => {
    if (areUiSessionKeysEquivalent(session.key, sessionKey)) {
      return true;
    }
    return (
      requestedGlobalAgentId != null &&
      resolveUiGlobalAliasAgentId(host, session.key) === requestedGlobalAgentId
    );
  });
}

function historyIdleProofIsStaleForSelectedRow(
  historySessionInfo: GatewaySessionRow,
  selectedRow: GatewaySessionRow | undefined,
): boolean {
  if (!selectedRow || !isSessionRunActive(selectedRow) || isSessionRunActive(historySessionInfo)) {
    return false;
  }
  const historyUpdatedAt =
    typeof historySessionInfo.updatedAt === "number" ? historySessionInfo.updatedAt : null;
  if (historyUpdatedAt == null) {
    return true;
  }
  const selectedUpdatedAt = typeof selectedRow.updatedAt === "number" ? selectedRow.updatedAt : 0;
  if (selectedUpdatedAt >= historyUpdatedAt) {
    return true;
  }
  const selectedStartedAt = typeof selectedRow.startedAt === "number" ? selectedRow.startedAt : 0;
  return selectedStartedAt >= historyUpdatedAt;
}

export function flushChatQueueAfterIdleSessionReconciliation(
  host: ChatIdleSessionReconciliationHost,
  sessionKey: string,
  historyRefresh: Promise<ChatHistoryResult | undefined>,
  sessionsRefresh: Promise<unknown>,
  previousSessionsResult: SessionsListResult | null | undefined,
  flushQueue: () => void,
) {
  if (host.chatQueue.length === 0) {
    return;
  }
  void Promise.allSettled([historyRefresh, sessionsRefresh]).then((results) => {
    const historyRefreshSettled = results[0];
    const sessionsRefreshSettled = results[1];
    const freshSessionsResult = host.sessionsResult;
    const historySessionInfo =
      historyRefreshSettled.status === "fulfilled"
        ? historyRefreshSettled.value?.sessionInfo
        : null;
    const selectedSessionRow = findSelectedSessionRow(
      host,
      freshSessionsResult,
      sessionKey,
      historySessionInfo?.key,
    );
    const historySessionKnownIdle = Boolean(
      historySessionInfo &&
      isHistorySessionInfoForRequestedSession(host, historySessionInfo.key, sessionKey) &&
      !isSessionRunActive(historySessionInfo) &&
      !historyIdleProofIsStaleForSelectedRow(historySessionInfo, selectedSessionRow),
    );
    const sessionsResultKnownIdle = freshSessionsResult
      ? isSelectedSessionKnownIdle(freshSessionsResult, sessionKey)
      : false;
    if (
      sessionsRefreshSettled.status !== "fulfilled" ||
      host.chatQueue.length === 0 ||
      !areUiSessionKeysEquivalent(host.sessionKey, sessionKey) ||
      (!freshSessionsResult && !historySessionKnownIdle) ||
      (freshSessionsResult === previousSessionsResult && !historySessionKnownIdle) ||
      (host.sessionsError && !historySessionKnownIdle) ||
      !(historySessionKnownIdle || sessionsResultKnownIdle)
    ) {
      return;
    }
    flushQueue();
  });
}

function setChatError(host: ChatModelSettingsHost, error: string | null, requestUpdate = false) {
  host.lastError = error;
  host.chatError = error;
  if (requestUpdate) {
    host.requestUpdate?.();
  }
}

const pendingChatPickerPatches = new WeakMap<SessionCapability, Map<string, Promise<boolean>>>();

type ChatPickerPatchHost = SessionScopeHost & { sessions: SessionCapability };

function resolveChatPickerPatchKey(
  host: ChatPickerPatchHost,
  sessionKey: string,
  agentId?: string,
): string {
  const normalizedKey = normalizeSessionKeyForUiComparison(sessionKey);
  const match = /^agent:([^:]+):(.*)$/u.exec(normalizedKey);
  const body = match?.[2] ?? normalizedKey;
  const isGlobal = isUiGlobalSessionKey(sessionKey);
  const isMainAlias = [DEFAULT_MAIN_KEY, resolveUiConfiguredMainKey(host)].includes(
    body.toLowerCase(),
  );
  const defaultAgentId = resolveUiDefaultAgentId(host);
  const parsedAgentId = match?.[1];
  // Match the Gateway's legacy default-main remap only when the live agent
  // catalog proves that "main" is not a real agent.
  const isLegacyDefaultMainAlias =
    isMainAlias &&
    normalizeAgentId(parsedAgentId ?? "") === DEFAULT_AGENT_ID &&
    defaultAgentId !== DEFAULT_AGENT_ID &&
    host.agentsList?.agents != null &&
    !host.agentsList.agents.some(
      (candidate) => normalizeAgentId(candidate.id) === DEFAULT_AGENT_ID,
    );
  // Main aliases share the literal global store only in global session scope.
  const isGlobalMain = host.agentsList?.scope
    ? host.agentsList.scope === "global"
    : isUiGlobalSessionKey(resolveSessionKey(DEFAULT_MAIN_KEY, host.hello));
  const resolvedAgentId =
    (isLegacyDefaultMainAlias ? defaultAgentId : agentId?.trim() || parsedAgentId) ||
    (isGlobal ? resolveUiSelectedGlobalAgentId(host) : defaultAgentId);
  const settingsKey =
    isGlobal || (isMainAlias && isGlobalMain) ? "global" : isMainAlias ? DEFAULT_MAIN_KEY : body;
  return `agent:${normalizeAgentId(resolvedAgentId)}:${settingsKey}`;
}

export function getPendingChatPickerPatch(
  host: ChatPickerPatchHost,
  sessionKey: string,
  agentId?: string,
): Promise<boolean> | undefined {
  const patchKey = resolveChatPickerPatchKey(host, sessionKey, agentId);
  return pendingChatPickerPatches.get(host.sessions)?.get(patchKey);
}

export function trackPendingChatPickerPatch(
  host: ChatPickerPatchHost,
  sessionKey: string,
  patchPromise: Promise<boolean>,
) {
  const pendingBySession =
    pendingChatPickerPatches.get(host.sessions) ?? new Map<string, Promise<boolean>>();
  pendingChatPickerPatches.set(host.sessions, pendingBySession);
  const patchKey = resolveChatPickerPatchKey(host, sessionKey);
  const previous = pendingBySession.get(patchKey);
  // Aggregate every picker patch across the shared capability; overlapping
  // Gateway handlers can overtake pane-local or latest-only tracking.
  const pending = Promise.all([previous ?? true, patchPromise]).then(
    ([previousReady, patchReady]) => previousReady && patchReady,
  );
  pendingBySession.set(patchKey, pending);
  void pending.finally(() => {
    if (pendingBySession.get(patchKey) === pending) {
      pendingBySession.delete(patchKey);
    }
  });
}

// Immediate-apply pickers can overlap patches for the same session. Mirror the
// pendingModelPatches token guard in sessions/index.ts: only the latest patch
// may re-assert or roll back the optimistic row, so a slow earlier request
// cannot clobber a newer selection.
const chatFastModePatchTokens = new WeakMap<object, Map<string, symbol>>();
const chatThinkingPatchTokens = new WeakMap<object, Map<string, symbol>>();

function claimChatSettingsPatch(
  store: WeakMap<object, Map<string, symbol>>,
  host: object,
  sessionKey: string,
): symbol {
  let tokens = store.get(host);
  if (!tokens) {
    tokens = new Map();
    store.set(host, tokens);
  }
  const token = Symbol(sessionKey);
  tokens.set(sessionKey, token);
  return token;
}

function isCurrentChatSettingsPatch(
  store: WeakMap<object, Map<string, symbol>>,
  host: object,
  sessionKey: string,
  token: symbol,
): boolean {
  return store.get(host)?.get(sessionKey) === token;
}

function patchSessionRow(
  host: ChatModelSettingsHost,
  sessionKey: string,
  patch: Partial<SessionsListResult["sessions"][number]>,
) {
  const current = host.sessionsResult;
  if (!current) {
    return;
  }
  host.sessionsResult = {
    ...current,
    sessions: current.sessions.map((row) =>
      row.key === sessionKey ? Object.assign({}, row, patch) : row,
    ),
  };
}

export function switchChatFastMode(
  host: ChatModelSettingsHost,
  nextFastMode: "" | "on" | "off" | "auto",
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = host.sessionsResult?.sessions?.find((row) => row.key === targetSessionKey);
  const previousFastMode = activeRow?.fastMode;
  const previousEffectiveFastMode = activeRow?.effectiveFastMode;
  const next: FastMode | undefined =
    nextFastMode === "" ? undefined : nextFastMode === "auto" ? "auto" : nextFastMode === "on";
  if (previousFastMode === next) {
    return Promise.resolve(true);
  }
  const token = claimChatSettingsPatch(chatFastModePatchTokens, host, targetSessionKey);
  setChatError(host, null, true);
  // Patch effectiveFastMode too: the toggle displays the effective value, and
  // the server-resolved one stays stale until the session list refreshes.
  patchSessionRow(host, targetSessionKey, { fastMode: next, effectiveFastMode: next });
  const rollback = () => {
    if (isCurrentChatSettingsPatch(chatFastModePatchTokens, host, targetSessionKey, token)) {
      patchSessionRow(host, targetSessionKey, {
        fastMode: previousFastMode,
        effectiveFastMode: previousEffectiveFastMode,
      });
    }
  };
  const patchPromise = (async () => {
    try {
      const patched = await host.sessions.patch(
        targetSessionKey,
        {
          fastMode: next ?? null,
        },
        scopedAgentParamsForSession(host, targetSessionKey),
      );
      if (!patched) {
        rollback();
        return false;
      }
      await refreshCurrentChatSessionList(host);
      if (isCurrentChatSettingsPatch(chatFastModePatchTokens, host, targetSessionKey, token)) {
        patchSessionRow(host, targetSessionKey, { fastMode: next });
      }
      return true;
    } catch (err) {
      rollback();
      setChatError(host, `Failed to set speed: ${String(err)}`, true);
      return false;
    }
  })();
  trackPendingChatPickerPatch(host, targetSessionKey, patchPromise);
  return patchPromise;
}

export async function switchChatModel(
  host: ChatModelSettingsHost,
  nextModel: string,
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return false;
  }
  const currentOverride = resolveChatModelOverrideValue({
    chatModelCatalog: host.chatModelCatalog,
    modelOverrides: host.sessions.state.modelOverrides,
    sessionKey: targetSessionKey,
    sessionsResult: host.sessionsResult ?? null,
  });
  if (currentOverride === nextModel) {
    return true;
  }
  const previousModelOverride = host.sessions.state.modelOverrides[targetSessionKey];
  setChatError(host, null, true);
  const switchPromiseRef: { current?: Promise<boolean> } = {};
  const clearPendingSwitch = () => {
    if (host.chatModelSwitchPromises?.[targetSessionKey] === switchPromiseRef.current) {
      const nextSwitches = { ...host.chatModelSwitchPromises };
      delete nextSwitches[targetSessionKey];
      host.chatModelSwitchPromises = nextSwitches;
    }
  };
  const switchPromise: Promise<boolean> = (async () => {
    try {
      const patched = await host.sessions.patch(
        targetSessionKey,
        {
          model: nextModel || null,
        },
        scopedAgentParamsForSession(host, targetSessionKey),
      );
      if (!patched) {
        return false;
      }
      await host.onModelChanged?.();
      await refreshCurrentChatSessionList(host);
      return true;
    } catch (err) {
      host.sessions.setModelOverride(targetSessionKey, previousModelOverride);
      setChatError(host, `Failed to set model: ${String(err)}`, true);
      return false;
    } finally {
      clearPendingSwitch();
      host.requestUpdate?.();
    }
  })();
  switchPromiseRef.current = switchPromise;
  host.chatModelSwitchPromises = {
    ...host.chatModelSwitchPromises,
    [targetSessionKey]: switchPromise,
  };
  trackPendingChatPickerPatch(host, targetSessionKey, switchPromise);
  host.requestUpdate?.();
  return switchPromise;
}

export function switchChatThinkingLevel(
  host: ChatModelSettingsHost,
  nextThinkingLevel: string,
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const activeRow = host.sessionsResult?.sessions?.find((row) => row.key === targetSessionKey);
  const previousThinkingLevel = activeRow?.thinkingLevel;
  const normalizedNext =
    (normalizeThinkLevel(nextThinkingLevel) ?? nextThinkingLevel.trim()) || undefined;
  const normalizedPrev =
    typeof previousThinkingLevel === "string" && previousThinkingLevel.trim()
      ? (normalizeThinkLevel(previousThinkingLevel) ?? previousThinkingLevel.trim())
      : undefined;
  if ((normalizedPrev ?? "") === (normalizedNext ?? "")) {
    return Promise.resolve(true);
  }
  const token = claimChatSettingsPatch(chatThinkingPatchTokens, host, targetSessionKey);
  setChatError(host, null, true);
  patchSessionRow(host, targetSessionKey, { thinkingLevel: normalizedNext });
  if (host.sessionKey === targetSessionKey) {
    host.chatThinkingLevel = normalizedNext ?? null;
  }
  const rollback = () => {
    if (isCurrentChatSettingsPatch(chatThinkingPatchTokens, host, targetSessionKey, token)) {
      patchSessionRow(host, targetSessionKey, { thinkingLevel: previousThinkingLevel });
      if (host.sessionKey === targetSessionKey) {
        host.chatThinkingLevel = normalizedPrev ?? null;
      }
    }
  };
  const patchPromise = (async () => {
    try {
      const patched = await host.sessions.patch(
        targetSessionKey,
        {
          thinkingLevel: normalizedNext ?? null,
        },
        scopedAgentParamsForSession(host, targetSessionKey),
      );
      if (!patched) {
        rollback();
        return false;
      }
      await refreshCurrentChatSessionList(host);
      if (isCurrentChatSettingsPatch(chatThinkingPatchTokens, host, targetSessionKey, token)) {
        patchSessionRow(host, targetSessionKey, { thinkingLevel: normalizedNext });
        if (host.sessionKey === targetSessionKey) {
          host.chatThinkingLevel = normalizedNext ?? null;
        }
      }
      return true;
    } catch (err) {
      rollback();
      setChatError(host, `Failed to set thinking level: ${String(err)}`, true);
      return false;
    }
  })();
  trackPendingChatPickerPatch(host, targetSessionKey, patchPromise);
  return patchPromise;
}
