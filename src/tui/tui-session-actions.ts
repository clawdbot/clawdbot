// Implements TUI session actions such as switching, forking, and resuming.
import type { TUI } from "@earendil-works/pi-tui";
import { normalizeOptionalString, type FastMode } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchResult } from "../../packages/gateway-protocol/src/index.js";
import { resolveSessionInfoModelSelection } from "../agents/model-selection-display.js";
import {
  agentSessionKeysMatchByRequestKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import type { ChatLog } from "./components/chat-log.js";
import { refreshTuiAgentList } from "./tui-agent-list-refresh.js";
import type { TuiAgentsList, TuiBackend, TuiSessionMutationResult } from "./tui-backend.js";
import {
  asString,
  extractTextFromMessage,
  formatTuiErrorMessage,
  isCommandMessage,
} from "./tui-formatters.js";
import { readTuiSessionUserMessage } from "./tui-session-events.js";
import { TUI_SESSION_LOOKUP_LIMIT } from "./tui-session-list-policy.js";
import {
  getTuiSessionProjection,
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import * as submit from "./tui-submit-state.js";
import type { SessionInfo, TuiHistoryLoadResult, TuiOptions, TuiStateAccess } from "./tui-types.js";

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

function sessionInfoUiEquals(left: SessionInfo, right: SessionInfo): boolean {
  return (
    left.thinkingLevel === right.thinkingLevel &&
    (left.thinkingLevels === right.thinkingLevels ||
      JSON.stringify(left.thinkingLevels ?? null) ===
        JSON.stringify(right.thinkingLevels ?? null)) &&
    left.fastMode === right.fastMode &&
    left.verboseLevel === right.verboseLevel &&
    left.traceLevel === right.traceLevel &&
    left.reasoningLevel === right.reasoningLevel &&
    left.model === right.model &&
    left.modelProvider === right.modelProvider &&
    left.agentRuntime?.id === right.agentRuntime?.id &&
    left.agentRuntime?.source === right.agentRuntime?.source &&
    left.agentRuntime?.fallback === right.agentRuntime?.fallback &&
    left.contextTokens === right.contextTokens &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.responseUsage === right.responseUsage &&
    left.effectiveResponseUsage === right.effectiveResponseUsage &&
    left.displayName === right.displayName &&
    (left.goal === right.goal ||
      JSON.stringify(left.goal ?? null) === JSON.stringify(right.goal ?? null))
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
  } = context;
  let refreshSessionInfoInFlight: Promise<void> | null = null;
  let refreshSessionInfoQueued = false;
  let historyLoadGeneration = 0;
  let lastSessionDefaults: SessionInfoDefaults | null = null;

  const captureSessionSelection = () => ({
    sessionKey: state.currentSessionKey,
    agentId: state.currentAgentId,
  });

  const isCurrentSessionSelection = (selection: { sessionKey: string; agentId: string }): boolean =>
    state.currentAgentId === selection.agentId &&
    agentSessionKeysMatchByRequestKey(state.currentSessionKey, selection.sessionKey);

  const isCurrentSessionMutation = (result: { key?: string }): boolean => {
    if (!result.key) {
      return true;
    }
    const parsed = parseAgentSessionKey(result.key);
    return isCurrentSessionSelection({
      sessionKey: result.key,
      agentId: parsed ? normalizeAgentId(parsed.agentId) : state.currentAgentId,
    });
  };

  const applyAgentsResult = (result: TuiAgentsList) => {
    state.agentDefaultId = normalizeAgentId(result.defaultId);
    state.sessionMainKey = normalizeMainKey(result.mainKey);
    state.sessionScope = result.scope ?? state.sessionScope;
    state.agents = result.agents.map((agent) => ({
      id: normalizeAgentId(agent.id),
      kind: agent.kind,
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

  const refreshAgents = () =>
    refreshTuiAgentList({
      load: () => client.listAgents(),
      apply: applyAgentsResult,
      reportError: (message) => chatLog.addSystem(`agents list failed: ${message}`),
    });

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
    if (entry?.agentRuntime !== undefined) {
      next.agentRuntime = entry.agentRuntime;
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
    if (entry?.effectiveResponseUsage !== undefined) {
      next.effectiveResponseUsage = entry.effectiveResponseUsage;
    }
    if (entry?.inputTokens !== undefined) {
      next.inputTokens = entry.inputTokens;
    }
    if (entry?.outputTokens !== undefined) {
      next.outputTokens = entry.outputTokens;
    }
    if (entry?.totalTokens !== undefined) {
      next.totalTokens = entry.totalTokens;
      next.totalTokensFresh = entry.totalTokensFresh === true;
    } else if (entry?.totalTokensFresh === true) {
      // Fresh session: the total is known to be 0. The gateway strips the 0 via
      // resolvePositiveNumber but still flags it fresh, so render 0 (not "?"),
      // mirroring the /status fix in #93798. See followup to #93771.
      next.totalTokens = 0;
      next.totalTokensFresh = true;
    }
    if (params.clearMissingUsage) {
      if (entry?.inputTokens === undefined) {
        next.inputTokens = null;
      }
      if (entry?.outputTokens === undefined) {
        next.outputTokens = null;
      }
      if (entry?.totalTokens === undefined && entry?.totalTokensFresh !== true) {
        next.totalTokens = null;
        next.totalTokensFresh = undefined;
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
    const selection = captureSessionSelection();
    const historyGeneration = historyLoadGeneration;
    const isCurrentRefresh = () =>
      historyGeneration === historyLoadGeneration && isCurrentSessionSelection(selection);
    try {
      const resolveListAgentId = () => {
        if (selection.sessionKey === "global") {
          return selection.agentId;
        }
        if (selection.sessionKey === "unknown") {
          return undefined;
        }
        const parsed = parseAgentSessionKey(selection.sessionKey);
        return parsed?.agentId ? normalizeAgentId(parsed.agentId) : selection.agentId;
      };
      const listAgentId = resolveListAgentId();
      const result = await client.listSessions({
        limit: TUI_SESSION_LOOKUP_LIMIT,
        search: selection.sessionKey,
        includeGlobal: selection.sessionKey === "global",
        includeUnknown: selection.sessionKey === "unknown",
        agentId: listAgentId,
      });
      // Agent-scoped list results may expand a legacy alias to its canonical key,
      // but cannot move the selection to another agent.
      if (!isCurrentRefresh()) {
        return;
      }
      const entry = result.sessions.find((row) => {
        return agentSessionKeysMatchByRequestKey(row.key, selection.sessionKey);
      });
      if (entry?.key && entry.key !== state.currentSessionKey) {
        updateAgentFromSessionKey(entry.key);
        state.currentSessionKey = entry.key;
        updateHeader();
      }
      state.currentSessionId = typeof entry?.sessionId === "string" ? entry.sessionId : null;
      applySessionInfo({
        entry,
        defaults: result.defaults,
      });
    } catch (err) {
      if (!isCurrentRefresh()) {
        return;
      }
      chatLog.addSystem(`sessions list failed: ${formatTuiErrorMessage(err)}`);
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
    if (!result?.entry || !isCurrentSessionMutation(result)) {
      return;
    }
    if (result.key && result.key !== state.currentSessionKey) {
      updateAgentFromSessionKey(result.key);
      state.currentSessionKey = result.key;
      updateHeader();
    }
    const resolved = result.resolved;
    const entry = resolved
      ? {
          ...result.entry,
          modelProvider: resolved.modelProvider ?? result.entry.modelProvider,
          model: resolved.model ?? result.entry.model,
          ...(resolved.agentRuntime ? { agentRuntime: resolved.agentRuntime } : {}),
          ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
          ...(resolved.thinkingLevels ? { thinkingLevels: resolved.thinkingLevels } : {}),
        }
      : result.entry;
    applySessionInfo({ entry, force: true });
  };

  const applySessionMutationResult = (
    result?: TuiSessionMutationResult | null,
    requestSelection = captureSessionSelection(),
  ): boolean => {
    // A reset can legitimately return a replacement key. Reject results using
    // the request's original selection, not the key the response must adopt.
    if (!result?.entry || !isCurrentSessionSelection(requestSelection)) {
      return false;
    }
    state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    reduceTuiSessionProjection(state, {
      type: "sessionReset",
      scope: readTuiSessionProjectionScope(state),
    });
    if (result.key && result.key !== state.currentSessionKey) {
      updateAgentFromSessionKey(result.key);
      state.currentSessionKey = result.key;
      updateHeader();
    }
    const sessionId = result.entry.sessionId;
    state.currentSessionId = typeof sessionId === "string" ? sessionId : null;
    applySessionInfoFromPatch(result);
    chatLog.clearAll();
    btw.clear();
    chatLog.addSystem(`session ${state.currentSessionKey}`);
    state.historyLoaded = true;
    void rememberSessionKey?.(state.currentSessionKey);
    tui.requestRender(true);
    return true;
  };

  const loadHistory = async (): Promise<TuiHistoryLoadResult> => {
    // History rebuilds mutate shared UI state after multiple awaits. Only the
    // latest request may render, or a slow reload can replace a newer selection.
    const generation = ++historyLoadGeneration;
    const selection = captureSessionSelection();
    const isCurrentLoad = () =>
      generation === historyLoadGeneration && isCurrentSessionSelection(selection);
    try {
      const history = await client.loadHistory({
        sessionKey: selection.sessionKey,
        ...(selection.sessionKey === "global" ? { agentId: selection.agentId } : {}),
        limit: opts.historyLimit ?? 200,
      });
      if (!isCurrentLoad()) {
        return { loaded: false };
      }
      const record = history as {
        messages?: unknown[];
        sessionId?: string;
        sessionInfo?: SessionInfoEntry;
        defaults?: SessionInfoDefaults;
        thinkingLevel?: string;
        fastMode?: FastMode;
        verboseLevel?: string;
        traceLevel?: string;
        inFlightRun?: { runId?: unknown; text?: unknown };
        runtimePluginsPrewarm?: { status?: string; error?: string };
      };
      const sessionInfo = record.sessionInfo;
      if (sessionInfo?.key && sessionInfo.key !== state.currentSessionKey) {
        updateAgentFromSessionKey(sessionInfo.key);
        state.currentSessionKey = sessionInfo.key;
        selection.sessionKey = state.currentSessionKey;
        selection.agentId = state.currentAgentId;
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
        if (!isCurrentLoad()) {
          return { loaded: false };
        }
      }
      const pendingRunIds = new Set(
        getTuiSessionProjection(state).entries.flatMap((entry) =>
          entry.pending && entry.pendingRunId ? [entry.pendingRunId] : [],
        ),
      );
      const projection = reduceTuiSessionProjection(state, {
        type: "snapshotLoaded",
        messages: record.messages ?? [],
        scope: readTuiSessionProjectionScope(state),
        options: {
          shouldIncludeMessage: (message) =>
            Boolean(message) &&
            typeof message === "object" &&
            ((message as { role?: unknown }).role !== "toolResult" ||
              (state.sessionInfo.verboseLevel ?? "off") !== "off"),
        },
      });
      chatLog.clearAll();
      btw.clear();
      chatLog.addSystem(`session ${state.currentSessionKey}`);
      for (const entry of projection.entries) {
        const message = entry.message as Record<string, unknown>;
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
            const liveUserMessage = readTuiSessionUserMessage({ message });
            if (entry.pending && entry.pendingRunId) {
              chatLog.addPendingUser(entry.pendingRunId, text);
            } else if (entry.live && liveUserMessage) {
              chatLog.addLiveUser(text, {
                messageId: liveUserMessage.messageId,
                ...(liveUserMessage.runId ? { runId: liveUserMessage.runId } : {}),
              });
            } else if (liveUserMessage) {
              chatLog.addUser(text, { messageId: liveUserMessage.messageId });
            } else {
              chatLog.addUser(text);
            }
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
      submit.reconcilePendingSubmitHistory(
        state,
        projection.entries.flatMap((entry) =>
          !entry.pending &&
          entry.identity?.role === "user" &&
          entry.identity.runId !== null &&
          pendingRunIds.has(entry.identity.runId)
            ? [entry.identity.runId]
            : [],
        ),
      );
      // Restore a run still streaming for this session+agent that the gateway
      // reports as in-flight. Its live deltas were delivered to a per-agent key
      // we stopped watching after switching away, so the persisted history above
      // does not contain it; render the partial and re-adopt the run so further
      // deltas (now that this session is active again) continue it.
      const inFlightRunId = asString(record.inFlightRun?.runId, "");
      const inFlightText = asString(record.inFlightRun?.text, "");
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
      if (record.runtimePluginsPrewarm?.status === "failed") {
        chatLog.addSystem(
          `runtime prewarm failed: ${record.runtimePluginsPrewarm.error ?? "unknown"}`,
        );
      }
      void rememberSessionKey?.(state.currentSessionKey);
      tui.requestRender(true);
      return { loaded: true, inFlightRunId: inFlightRunId || null };
    } catch (err) {
      if (!isCurrentLoad()) {
        return { loaded: false };
      }
      chatLog.addSystem(`history failed: ${formatTuiErrorMessage(err)}`);
      tui.requestRender(true);
      return { loaded: false };
    }
  };

  const setSession = async (rawKey: string) => {
    const previousSelection = captureSessionSelection();
    const nextKey = resolveSessionKey(rawKey);
    const selectionChanged = !(
      normalizeAgentId(parseAgentSessionKey(nextKey)?.agentId ?? previousSelection.agentId) ===
        previousSelection.agentId &&
      agentSessionKeysMatchByRequestKey(nextKey, previousSelection.sessionKey)
    );
    if (selectionChanged) {
      reduceTuiSessionProjection(state, {
        type: "sessionReset",
        scope: readTuiSessionProjectionScope(state),
      });
    }
    updateAgentFromSessionKey(nextKey);
    state.currentSessionKey = nextKey;
    state.activeChatRunId = null;
    submit.clearPendingSubmit(state);
    setActivityStatus("idle");
    if (selectionChanged) {
      state.currentSessionId = null;
    }
    // Session keys can move backwards in updatedAt ordering; drop previous session freshness
    // so refresh data for the newly selected session isn't rejected as stale.
    state.sessionInfo.updatedAt = null;
    state.historyLoaded = false;
    if (selectionChanged) {
      // Live prompt identities belong to the old selection, not its pending successor.
      chatLog.clearAll();
    }
    chatLog.clearPendingUsers();
    clearLocalRunIds?.();
    btw.clear();
    updateHeader();
    updateFooter();
    await loadHistory();
  };

  const abortActive = async (params?: { preferActive?: boolean }) => {
    if (
      opts.local === true &&
      state.activityStatus === "finishing context" &&
      !params?.preferActive &&
      !submit.getPendingSubmitAcceptedRunId(state)
    ) {
      chatLog.addSystem("agent is finishing context; wait for it to finish before aborting");
      tui.requestRender();
      return;
    }
    const selection = captureSessionSelection();
    const pendingRunId = submit.getPendingSubmitAcceptedRunId(state);
    const activeRunId = state.activeChatRunId;
    const dropPendingRun = (runId: string) => {
      reduceTuiSessionProjection(state, {
        type: "sendFailed",
        runId,
        scope: readTuiSessionProjectionScope(state),
      });
      chatLog.dropPendingUser(runId);
    };
    try {
      // Session-scoped abort is the only reliable TUI stop contract: queued
      // chat.send calls can terminalize before the queue drains, so their run
      // ids may no longer exist in local UI state.
      const result = await client.abortChat({
        sessionKey: selection.sessionKey,
        ...(selection.sessionKey === "global" ? { agentId: selection.agentId } : {}),
      });
      if (!isCurrentSessionSelection(selection)) {
        return;
      }
      if (!result.aborted) {
        chatLog.addSystem("no active run", { coalesceConsecutive: true });
        tui.requestRender();
        return;
      }
      for (const runId of result.runIds ?? []) {
        const stillTracked =
          state.activeChatRunId === runId || submit.getPendingSubmitAcceptedRunId(state) === runId;
        // The active prompt is already persisted. Pending/queued prompts may
        // terminalize while the RPC is in flight, so inspect their live state.
        if (runId !== activeRunId && !stillTracked) {
          dropPendingRun(runId);
        }
      }
      if (pendingRunId) {
        // Re-read after abortChat: an event may already have dropped the queued row.
        const pendingDraft = submit.getPendingSubmitDraft(state);
        submit.clearPendingSubmit(state, pendingRunId ?? undefined);
        if (pendingDraft?.runId === pendingRunId) {
          dropPendingRun(pendingRunId);
        }
      }
      setActivityStatus("aborted");
    } catch (err) {
      if (!isCurrentSessionSelection(selection)) {
        return;
      }
      chatLog.addSystem(`abort failed: ${formatTuiErrorMessage(err)}`);
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
    abortActive,
  };
}
