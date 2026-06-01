import type { TUI } from "@earendil-works/pi-tui";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchResult } from "../../packages/gateway-protocol/src/index.js";
import { resolveSessionInfoModelSelection } from "../agents/model-selection-display.js";
import {
  agentSessionKeysMatchByRequestKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import type { ChatLog } from "./components/chat-log.js";
import type { TuiAgentsList, TuiBackend, TuiSessionMutationResult } from "./tui-backend.js";
import { asString, extractTextFromMessage, isCommandMessage } from "./tui-formatters.js";
import { TUI_SESSION_LOOKUP_LIMIT } from "./tui-session-list-policy.js";
import type { SessionInfo, TuiOptions, TuiStateAccess } from "./tui-types.js";

type SessionActionBtwPresenter = {
  clear: () => void;
};

type SessionActionContext = {
  client: TuiBackend;
  chatLog: ChatLog;
  btw: SessionActionBtwPresenter;
  tui: TUI;
  opts: TuiOptions;
  state: TuiStateAccess;
  agentNames: Map<string, string>;
  initialSessionInput: string;
  initialSessionAgentId: string | null;
  resolveSessionKey: (raw?: string) => string;
  updateHeader: () => void;
  updateFooter: () => void;
  updateAutocompleteProvider: () => void;
  setActivityStatus: (text: string) => void;
  clearLocalRunIds?: () => void;
  rememberSessionKey?: (sessionKey: string) => void | Promise<void>;
  emptySessionInfoDefaults?: SessionInfo;
};

type SessionInfoDefaults = {
  model?: string | null;
  modelProvider?: string | null;
  contextTokens?: number | null;
  thinkingLevels?: Array<{ id: string; label: string }>;
};

type SessionInfoEntry = SessionInfo & {
  key?: string;
  sessionId?: string;
  modelOverride?: string;
  providerOverride?: string;
};

function thinkingLevelsEqual(
  left?: Array<{ id: string; label: string }>,
  right?: Array<{ id: string; label: string }>,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((level, index) => {
    const other = right[index];
    return other?.id === level.id && other.label === level.label;
  });
}

function goalEquals(left: SessionInfo["goal"], right: SessionInfo["goal"]): boolean {
  return left === right || JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sessionInfoUiEquals(left: SessionInfo, right: SessionInfo): boolean {
  return (
    left.thinkingLevel === right.thinkingLevel &&
    thinkingLevelsEqual(left.thinkingLevels, right.thinkingLevels) &&
    left.fastMode === right.fastMode &&
    left.verboseLevel === right.verboseLevel &&
    left.traceLevel === right.traceLevel &&
    left.reasoningLevel === right.reasoningLevel &&
    left.model === right.model &&
    left.modelProvider === right.modelProvider &&
    left.contextTokens === right.contextTokens &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.responseUsage === right.responseUsage &&
    left.displayName === right.displayName &&
    goalEquals(left.goal, right.goal)
  );
}

export function createSessionActions(context: SessionActionContext) {
  const {
    client,
    chatLog,
    btw,
    tui,
    opts,
    state,
    agentNames,
    initialSessionInput,
    initialSessionAgentId,
    resolveSessionKey,
    updateHeader,
    updateFooter,
    updateAutocompleteProvider,
    setActivityStatus,
    clearLocalRunIds,
    rememberSessionKey,
    emptySessionInfoDefaults,
  } = context;
  let refreshSessionInfoInFlight: Promise<void> | null = null;
  let refreshSessionInfoQueued = false;
  let lastSessionDefaults: SessionInfoDefaults | null = null;

  const applyAgentsResult = (result: TuiAgentsList) => {
    state.agentDefaultId = normalizeAgentId(result.defaultId);
    state.sessionMainKey = normalizeMainKey(result.mainKey);
    state.sessionScope = result.scope ?? state.sessionScope;
    state.agents = result.agents.map((agent) => ({
      id: normalizeAgentId(agent.id),
      name: normalizeOptionalString(agent.name),
    }));
    agentNames.clear();
    for (const agent of state.agents) {
      if (agent.name) {
        agentNames.set(agent.id, agent.name);
      }
    }
    if (!state.initialSessionApplied) {
      if (initialSessionAgentId) {
        if (state.agents.some((agent) => agent.id === initialSessionAgentId)) {
          state.currentAgentId = initialSessionAgentId;
        }
      } else if (!state.agents.some((agent) => agent.id === state.currentAgentId)) {
        state.currentAgentId =
          state.agents[0]?.id ?? normalizeAgentId(result.defaultId ?? state.currentAgentId);
      }
      const nextSessionKey = resolveSessionKey(initialSessionInput);
      if (nextSessionKey !== state.currentSessionKey) {
        state.currentSessionKey = nextSessionKey;
      }
      state.initialSessionApplied = true;
    } else if (!state.agents.some((agent) => agent.id === state.currentAgentId)) {
      state.currentAgentId =
        state.agents[0]?.id ?? normalizeAgentId(result.defaultId ?? state.currentAgentId);
    }
    updateHeader();
    updateFooter();
  };

  const refreshAgents = async () => {
    try {
      const result = await client.listAgents();
      applyAgentsResult(result);
    } catch (err) {
      chatLog.addSystem(`agents list failed: ${String(err)}`);
    }
  };

  const updateAgentFromSessionKey = (key: string) => {
    const parsed = parseAgentSessionKey(key);
    if (!parsed) {
      return;
    }
    const next = normalizeAgentId(parsed.agentId);
    if (next !== state.currentAgentId) {
      state.currentAgentId = next;
    }
  };

  const resolveModelSelection = (entry?: SessionInfoEntry) => {
    return resolveSessionInfoModelSelection({
      currentProvider: state.sessionInfo.modelProvider,
      currentModel: state.sessionInfo.model,
      defaultProvider: lastSessionDefaults?.modelProvider,
      defaultModel: lastSessionDefaults?.model,
      entryProvider: entry?.modelProvider,
      entryModel: entry?.model,
      overrideProvider: entry?.providerOverride,
      overrideModel: entry?.modelOverride,
    });
  };

  const applySessionInfo = (params: {
    entry?: SessionInfoEntry | null;
    defaults?: SessionInfoDefaults | null;
    force?: boolean;
    clearMissingUsage?: boolean;
  }) => {
    const hasEntryUpdate = "entry" in params;
    const entry = params.entry ?? undefined;
    const defaults = params.defaults ?? lastSessionDefaults ?? undefined;
    const previousDefaults = lastSessionDefaults;
    const defaultsChanged = params.defaults
      ? previousDefaults?.model !== params.defaults.model ||
        previousDefaults?.modelProvider !== params.defaults.modelProvider ||
        previousDefaults?.contextTokens !== params.defaults.contextTokens
      : false;
    if (params.defaults) {
      lastSessionDefaults = params.defaults;
    }

    const entryUpdatedAt = entry?.updatedAt ?? null;
    const currentUpdatedAt = state.sessionInfo.updatedAt ?? null;
    if (
      !params.force &&
      entryUpdatedAt !== null &&
      currentUpdatedAt !== null &&
      entryUpdatedAt < currentUpdatedAt &&
      !defaultsChanged
    ) {
      return;
    }

    const next = { ...state.sessionInfo };
    if (entry?.thinkingLevel !== undefined) {
      next.thinkingLevel = entry.thinkingLevel;
    }
    if (entry?.thinkingLevels !== undefined || defaults?.thinkingLevels !== undefined) {
      next.thinkingLevels = entry?.thinkingLevels ?? defaults?.thinkingLevels;
    }
    if (entry?.fastMode !== undefined) {
      next.fastMode = entry.fastMode;
    }
    if (entry?.verboseLevel !== undefined) {
      next.verboseLevel = entry.verboseLevel;
    }
    if (entry?.traceLevel !== undefined) {
      next.traceLevel = entry.traceLevel;
    }
    if (entry?.reasoningLevel !== undefined) {
      next.reasoningLevel = entry.reasoningLevel;
    }
    if (entry?.responseUsage !== undefined) {
      next.responseUsage = entry.responseUsage;
    }
    if (entry?.inputTokens !== undefined) {
      next.inputTokens = entry.inputTokens;
    }
    if (entry?.outputTokens !== undefined) {
      next.outputTokens = entry.outputTokens;
    }
    if (entry?.totalTokens !== undefined) {
      next.totalTokens = entry.totalTokens;
    }
    if (params.clearMissingUsage) {
      if (entry?.inputTokens === undefined) {
        next.inputTokens = null;
      }
      if (entry?.outputTokens === undefined) {
        next.outputTokens = null;
      }
      if (entry?.totalTokens === undefined) {
        next.totalTokens = null;
      }
    }
    if (hasEntryUpdate) {
      next.goal = entry?.goal;
    }
    if (entry?.contextTokens !== undefined || defaults?.contextTokens !== undefined) {
      next.contextTokens =
        entry?.contextTokens ?? defaults?.contextTokens ?? state.sessionInfo.contextTokens;
    }
    if (entry?.displayName !== undefined) {
      next.displayName = entry.displayName;
    }
    if (entry?.updatedAt !== undefined) {
      next.updatedAt = entry.updatedAt;
    }

    const selection = resolveModelSelection(entry);
    if (selection.modelProvider !== undefined) {
      next.modelProvider = selection.modelProvider;
    }
    if (selection.model !== undefined) {
      next.model = selection.model;
    }

    const previous = state.sessionInfo;
    const uiChanged = !sessionInfoUiEquals(previous, next);
    if (!uiChanged && previous.updatedAt === next.updatedAt) {
      return;
    }
    state.sessionInfo = next;
    if (uiChanged) {
      updateAutocompleteProvider();
      updateFooter();
      tui.requestRender();
    }
  };

  const runRefreshSessionInfo = async () => {
    try {
      const resolveListAgentId = () => {
        if (state.currentSessionKey === "global") {
          return state.currentAgentId;
        }
        if (state.currentSessionKey === "unknown") {
          return undefined;
        }
        const parsed = parseAgentSessionKey(state.currentSessionKey);
        return parsed?.agentId ? normalizeAgentId(parsed.agentId) : state.currentAgentId;
      };
      const listAgentId = resolveListAgentId();
      const result = await client.listSessions({
        limit: TUI_SESSION_LOOKUP_LIMIT,
        search: state.currentSessionKey,
        includeGlobal: state.currentSessionKey === "global",
        includeUnknown: state.currentSessionKey === "unknown",
        agentId: listAgentId,
      });
      const entry = result.sessions.find((row) => {
        return agentSessionKeysMatchByRequestKey(row.key, state.currentSessionKey);
      });
      if (entry?.key && entry.key !== state.currentSessionKey) {
        updateAgentFromSessionKey(entry.key);
        state.currentSessionKey = entry.key;
        updateHeader();
      }
      applySessionInfo({
        entry,
        defaults: result.defaults,
      });
    } catch (err) {
      chatLog.addSystem(`sessions list failed: ${String(err)}`);
    }
  };

  const drainRefreshSessionInfo = async () => {
    do {
      // Many TUI paths ask for the same session snapshot at once; keep one in-flight
      // lookup and at most one follow-up so bursts do not queue stale backend calls.
      refreshSessionInfoQueued = false;
      await runRefreshSessionInfo();
    } while (refreshSessionInfoQueued);
  };

  const refreshSessionInfo = async () => {
    if (refreshSessionInfoInFlight) {
      refreshSessionInfoQueued = true;
      await refreshSessionInfoInFlight;
      return;
    }
    refreshSessionInfoInFlight = drainRefreshSessionInfo().finally(() => {
      refreshSessionInfoInFlight = null;
    });
    await refreshSessionInfoInFlight;
  };

  const applySessionInfoFromPatch = (
    result?: SessionsPatchResult | TuiSessionMutationResult | null,
  ) => {
    if (!result?.entry) {
      return;
    }
    if (result.key && result.key !== state.currentSessionKey) {
      updateAgentFromSessionKey(result.key);
      state.currentSessionKey = result.key;
      updateHeader();
    }
    const resolved = result.resolved;
    const entry =
      resolved && (resolved.modelProvider || resolved.model)
        ? {
            ...result.entry,
            modelProvider: resolved.modelProvider ?? result.entry.modelProvider,
            model: resolved.model ?? result.entry.model,
          }
        : result.entry;
    applySessionInfo({ entry, force: true });
  };

  const clearDisplayedSession = (key = state.currentSessionKey) => {
    chatLog.clearAll();
    btw.clear();
    chatLog.addSystem(`session ${key}`);
    state.historyLoaded = true;
    void rememberSessionKey?.(key);
    tui.requestRender();
  };

  const applySessionMutationResult = (result?: TuiSessionMutationResult | null): boolean => {
    if (!result?.entry) {
      return false;
    }
    if (result.key && result.key !== state.currentSessionKey) {
      updateAgentFromSessionKey(result.key);
      state.currentSessionKey = result.key;
      updateHeader();
    }
    const sessionId = result.entry.sessionId;
    state.currentSessionId = typeof sessionId === "string" ? sessionId : null;
    applySessionInfoFromPatch(result);
    clearDisplayedSession();
    return true;
  };

  const loadHistory = async () => {
    try {
      const history = await client.loadHistory({
        sessionKey: state.currentSessionKey,
        ...(state.currentSessionKey === "global" ? { agentId: state.currentAgentId } : {}),
        limit: opts.historyLimit ?? 200,
      });
      const record = history as {
        messages?: unknown[];
        sessionId?: string;
        sessionInfo?: SessionInfoEntry;
        defaults?: SessionInfoDefaults;
        thinkingLevel?: string;
        fastMode?: boolean;
        verboseLevel?: string;
        traceLevel?: string;
        inFlightRun?: { runId?: unknown; text?: unknown };
      };
      const sessionInfo = record.sessionInfo;
      if (sessionInfo?.key && sessionInfo.key !== state.currentSessionKey) {
        updateAgentFromSessionKey(sessionInfo.key);
        state.currentSessionKey = sessionInfo.key;
        updateHeader();
      }
      const historySessionInfo =
        sessionInfo && sessionInfo.thinkingLevel === undefined && record.thinkingLevel !== undefined
          ? { ...sessionInfo, thinkingLevel: record.thinkingLevel }
          : sessionInfo;
      state.currentSessionId =
        typeof sessionInfo?.sessionId === "string"
          ? sessionInfo.sessionId
          : typeof record.sessionId === "string"
            ? record.sessionId
            : null;
      applySessionInfo({
        entry: historySessionInfo ?? {
          sessionId: record.sessionId,
          thinkingLevel: record.thinkingLevel,
          fastMode: record.fastMode,
          verboseLevel: record.verboseLevel,
          traceLevel: record.traceLevel,
        },
        defaults: record.defaults,
        clearMissingUsage: Boolean(historySessionInfo),
      });
      if (!sessionInfo) {
        await refreshSessionInfo();
      }
      const showTools = (state.sessionInfo.verboseLevel ?? "off") !== "off";
      chatLog.clearAll();
      btw.clear();
      chatLog.addSystem(`session ${state.currentSessionKey}`);
      for (const entry of record.messages ?? []) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const message = entry as Record<string, unknown>;
        if (isCommandMessage(message)) {
          const text = extractTextFromMessage(message);
          if (text) {
            chatLog.addSystem(text);
          }
          continue;
        }
        if (message.role === "user") {
          const text = extractTextFromMessage(message);
          if (text) {
            chatLog.addUser(text);
          }
          continue;
        }
        if (message.role === "assistant") {
          const text = extractTextFromMessage(message, {
            includeThinking: state.showThinking,
          });
          if (text) {
            chatLog.finalizeAssistant(text);
          }
          continue;
        }
        if (message.role === "toolResult") {
          if (!showTools) {
            continue;
          }
          const toolCallId = asString(message.toolCallId, "");
          const toolName = asString(message.toolName, "tool");
          const component = chatLog.startTool(toolCallId, toolName, {});
          component.setResult(
            {
              content: Array.isArray(message.content)
                ? (message.content as Record<string, unknown>[])
                : [],
              details:
                typeof message.details === "object" && message.details
                  ? (message.details as Record<string, unknown>)
                  : undefined,
            },
            { isError: Boolean(message.isError) },
          );
        }
      }
      // Restore a run still streaming for this session+agent that the gateway
      // reports as in-flight. Its live deltas were delivered to a per-agent key
      // we stopped watching after switching away, so the persisted history above
      // does not contain it; render the partial and re-adopt the run so further
      // deltas (now that this session is active again) continue it.
      const inFlight = record.inFlightRun;
      const inFlightRunId = asString(inFlight?.runId, "");
      const inFlightText = asString(inFlight?.text, "");
      if (inFlightRunId) {
        // Render any buffered partial (embedded runtimes); Codex has none mid-run.
        if (inFlightText) {
          chatLog.updateAssistant(inFlightText, inFlightRunId);
        }
        // Adopt the run regardless so its status shows `streaming` (not idle) and
        // its completion is handled here instead of an unowned error path.
        state.activeChatRunId = inFlightRunId;
        setActivityStatus("streaming");
      }
      state.historyLoaded = true;
      void rememberSessionKey?.(state.currentSessionKey);
    } catch (err) {
      chatLog.addSystem(`history failed: ${String(err)}`);
    }
    tui.requestRender();
  };

  const setSession = async (rawKey: string) => {
    const nextKey = resolveSessionKey(rawKey);
    updateAgentFromSessionKey(nextKey);
    state.currentSessionKey = nextKey;
    state.activeChatRunId = null;
    state.pendingChatRunId = null;
    state.pendingOptimisticUserMessage = false;
    setActivityStatus("idle");
    state.currentSessionId = null;
    // Session keys can move backwards in updatedAt ordering; drop previous session freshness
    // so refresh data for the newly selected session isn't rejected as stale.
    state.sessionInfo.updatedAt = null;
    state.historyLoaded = false;
    clearLocalRunIds?.();
    btw.clear();
    updateHeader();
    updateFooter();
    await loadHistory();
  };

  const setEmptySession = async (rawKey: string) => {
    const nextKey = resolveSessionKey(rawKey);
    updateAgentFromSessionKey(nextKey);
    state.currentSessionKey = nextKey;
    state.activeChatRunId = null;
    state.pendingChatRunId = null;
    state.pendingOptimisticUserMessage = false;
    setActivityStatus("idle");
    state.currentSessionId = null;
    const defaults = lastSessionDefaults;
    state.sessionInfo = {
      ...emptySessionInfoDefaults,
      modelProvider: defaults?.modelProvider ?? undefined,
      model: defaults?.model ?? undefined,
      contextTokens: defaults?.contextTokens ?? null,
      thinkingLevels: defaults?.thinkingLevels ?? emptySessionInfoDefaults?.thinkingLevels,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      goal: undefined,
      updatedAt: null,
      displayName: undefined,
    };
    clearLocalRunIds?.();
    updateHeader();
    updateAutocompleteProvider();
    updateFooter();
    clearDisplayedSession();
  };

  const abortActive = async (params?: { preferActive?: boolean }) => {
    if (
      opts.local === true &&
      state.activityStatus === "finishing context" &&
      !params?.preferActive &&
      !state.pendingChatRunId
    ) {
      chatLog.addSystem("agent is finishing context; wait for it to finish before aborting");
      tui.requestRender();
      return;
    }
    const runIds =
      params?.preferActive && state.activeChatRunId && state.pendingChatRunId
        ? [state.pendingChatRunId, state.activeChatRunId]
        : [
            !params?.preferActive && state.activeChatRunId && state.pendingChatRunId
              ? state.pendingChatRunId
              : (state.activeChatRunId ?? state.pendingChatRunId ?? null),
          ].filter((runId) => runId !== null);
    if (runIds.length === 0) {
      chatLog.addSystem("no active run", { coalesceConsecutive: true });
      tui.requestRender();
      return;
    }
    const abortsPendingRun = Boolean(
      state.pendingChatRunId && runIds.includes(state.pendingChatRunId),
    );
    try {
      for (const runId of runIds) {
        await client.abortChat({
          sessionKey: state.currentSessionKey,
          ...(state.currentSessionKey === "global" ? { agentId: state.currentAgentId } : {}),
          runId,
        });
      }
      state.pendingChatRunId = null;
      if (abortsPendingRun) {
        state.pendingOptimisticUserMessage = false;
      }
      setActivityStatus("aborted");
    } catch (err) {
      chatLog.addSystem(`abort failed: ${String(err)}`);
      setActivityStatus("abort failed");
    }
    tui.requestRender();
  };

  return {
    applyAgentsResult,
    refreshAgents,
    refreshSessionInfo,
    applySessionInfoFromPatch,
    applySessionMutationResult,
    loadHistory,
    setSession,
    setEmptySession,
    abortActive,
  };
}
