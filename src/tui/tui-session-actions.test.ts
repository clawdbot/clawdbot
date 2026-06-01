import { describe, expect, it, vi } from "vitest";
import type { TuiBackend } from "./tui-backend.js";
import { createSessionActions } from "./tui-session-actions.js";
import { TUI_SESSION_LOOKUP_LIMIT } from "./tui-session-list-policy.js";
import type { TuiStateAccess } from "./tui-types.js";

describe("tui session actions", () => {
  const createBtwPresenter = () => ({
    clear: vi.fn(),
    showResult: vi.fn(),
  });

  const createBaseState = (overrides: Partial<TuiStateAccess> = {}): TuiStateAccess => ({
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: null,
    activeChatRunId: null,
    historyLoaded: false,
    sessionInfo: {},
    initialSessionApplied: true,
    isConnected: true,
    autoMessageSent: false,
    toolsExpanded: false,
    showThinking: false,
    connectionStatus: "connected",
    activityStatus: "idle",
    statusTimeout: null,
    lastCtrlCAt: 0,
    ...overrides,
  });

  const createTestSessionActions = (
    overrides: Partial<Parameters<typeof createSessionActions>[0]>,
  ) =>
    createSessionActions({
      client: { listSessions: vi.fn() } as unknown as TuiBackend,
      chatLog: {
        addSystem: vi.fn(),
        clearAll: vi.fn(),
      } as unknown as import("./components/chat-log.js").ChatLog,
      btw: createBtwPresenter(),
      tui: { requestRender: vi.fn() } as unknown as import("@earendil-works/pi-tui").TUI,
      opts: {},
      state: createBaseState(),
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionKey: vi.fn((raw?: string) => raw ?? "agent:main:main"),
      updateHeader: vi.fn(),
      updateFooter: vi.fn(),
      updateAutocompleteProvider: vi.fn(),
      setActivityStatus: vi.fn(),
      ...overrides,
    });

  it("queues session refreshes and applies the latest result", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;

    const listSessions = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const state = createBaseState();

    const updateFooter = vi.fn();
    const updateAutocompleteProvider = vi.fn();
    const requestRender = vi.fn();

    const { refreshSessionInfo } = createTestSessionActions({
      client: { listSessions } as unknown as TuiBackend,
      chatLog: { addSystem: vi.fn() } as unknown as import("./components/chat-log.js").ChatLog,
      btw: createBtwPresenter(),
      tui: { requestRender } as unknown as import("@earendil-works/pi-tui").TUI,
      state,
      updateFooter,
      updateAutocompleteProvider,
    });

    const first = refreshSessionInfo();
    const second = refreshSessionInfo();

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenNthCalledWith(1, {
      limit: TUI_SESSION_LOOKUP_LIMIT,
      search: "agent:main:main",
      includeGlobal: false,
      includeUnknown: false,
      agentId: "main",
    });

    resolveFirst?.({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "agent:main:main",
          model: "old",
          modelProvider: "anthropic",
        },
      ],
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(listSessions).toHaveBeenCalledTimes(2);

    resolveSecond?.({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "agent:main:main",
          model: "Minimax-M2.7",
          modelProvider: "minimax",
        },
      ],
    });

    await Promise.all([first, second]);

    expect(state.sessionInfo.model).toBe("Minimax-M2.7");
    expect(updateAutocompleteProvider).toHaveBeenCalledTimes(2);
    expect(updateFooter).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("coalesces refresh bursts into a single follow-up lookup", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;

    const listSessions = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const { refreshSessionInfo } = createTestSessionActions({
      client: { listSessions } as unknown as TuiBackend,
    });

    const first = refreshSessionInfo();
    const second = refreshSessionInfo();
    const third = refreshSessionInfo();

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(listSessions).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      defaults: {},
      sessions: [{ key: "agent:main:main", updatedAt: 1 }],
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(listSessions).toHaveBeenCalledTimes(2);

    resolveSecond?.({
      defaults: {},
      sessions: [{ key: "agent:main:main", updatedAt: 2 }],
    });
    await Promise.all([first, second, third]);

    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("skips UI work when session refresh metadata is unchanged", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "agent:main:main",
          model: "sonnet-4.6",
          modelProvider: "anthropic",
          totalTokens: 42,
          updatedAt: 200,
        },
      ],
    });
    const state = createBaseState({
      sessionInfo: {
        model: "sonnet-4.6",
        modelProvider: "anthropic",
        totalTokens: 42,
        updatedAt: 100,
      },
    });
    const updateFooter = vi.fn();
    const updateAutocompleteProvider = vi.fn();
    const requestRender = vi.fn();

    const { refreshSessionInfo } = createTestSessionActions({
      client: { listSessions } as unknown as TuiBackend,
      state,
      updateFooter,
      updateAutocompleteProvider,
      tui: { requestRender } as unknown as import("@earendil-works/pi-tui").TUI,
    });

    await refreshSessionInfo();

    expect(state.sessionInfo.updatedAt).toBe(200);
    expect(updateAutocompleteProvider).not.toHaveBeenCalled();
    expect(updateFooter).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("keeps patched model selection when a refresh returns an older snapshot", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "agent:main:main",
          model: "old-model",
          modelProvider: "ollama",
          updatedAt: 100,
        },
      ],
    });

    const state = createBaseState({
      sessionInfo: {
        model: "old-model",
        modelProvider: "ollama",
        updatedAt: 100,
      },
    });

    const { applySessionInfoFromPatch, refreshSessionInfo } = createTestSessionActions({
      client: { listSessions } as unknown as TuiBackend,
      state,
    });

    applySessionInfoFromPatch({
      ok: true,
      path: "/tmp/sessions.json",
      key: "agent:main:main",
      entry: {
        sessionId: "session-1",
        model: "new-model",
        modelProvider: "openai",
        updatedAt: 200,
      },
    });

    expect(state.sessionInfo.model).toBe("new-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");

    await refreshSessionInfo();

    expect(state.sessionInfo.model).toBe("new-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.updatedAt).toBe(200);
  });

  it("clears the footer goal when the current session has no row yet", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 0,
      defaults: {},
      sessions: [],
    });
    const state = createBaseState({
      sessionInfo: {
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "old goal",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokenStartFresh: true,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
    });

    const { refreshSessionInfo } = createTestSessionActions({
      client: { listSessions } as unknown as TuiBackend,
      state,
    });

    await refreshSessionInfo();

    expect(state.sessionInfo.goal).toBeUndefined();
  });

  it("includes the global row when refreshing a global session", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [{ key: "global", updatedAt: 1 }],
    });
    const state = createBaseState({
      currentSessionKey: "global",
      sessionScope: "global",
    });

    const { refreshSessionInfo } = createTestSessionActions({
      client: { listSessions } as unknown as TuiBackend,
      state,
    });

    await refreshSessionInfo();

    expect(listSessions).toHaveBeenCalledWith({
      limit: TUI_SESSION_LOOKUP_LIMIT,
      search: "global",
      includeGlobal: true,
      includeUnknown: false,
      agentId: "main",
    });
  });

  it("keeps global session info aligned with selected-agent chat history", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [{ key: "global", updatedAt: 1 }],
    });
    const state = createBaseState({
      currentAgentId: "work",
      currentSessionKey: "global",
      sessionScope: "global",
    });

    const { refreshSessionInfo } = createTestSessionActions({
      client: { listSessions } as unknown as TuiBackend,
      state,
    });

    await refreshSessionInfo();

    expect(listSessions).toHaveBeenCalledWith({
      limit: TUI_SESSION_LOOKUP_LIMIT,
      search: "global",
      includeGlobal: true,
      includeUnknown: false,
      agentId: "work",
    });
  });

  it("accepts older session snapshots after switching session keys", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "agent:main:other",
          model: "session-model",
          modelProvider: "openai",
          updatedAt: 50,
        },
      ],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-2",
      sessionInfo: {
        key: "agent:main:other",
        sessionId: "session-2",
        model: "session-model",
        modelProvider: "openai",
        updatedAt: 50,
      },
      messages: [],
    });
    const btw = createBtwPresenter();

    const state = createBaseState({
      historyLoaded: true,
      sessionInfo: {
        model: "previous-model",
        modelProvider: "anthropic",
        updatedAt: 500,
      },
    });

    const setActivityStatus = vi.fn();
    const { setSession } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      btw,
      state,
      setActivityStatus,
    });

    await setSession("agent:main:other");

    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(loadHistory).toHaveBeenCalledWith({
      sessionKey: "agent:main:other",
      limit: 200,
    });
    expect(state.currentSessionKey).toBe("agent:main:other");
    expect(state.sessionInfo.model).toBe("session-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.updatedAt).toBe(50);
    expect(listSessions).not.toHaveBeenCalled();
    expect(btw.clear).toHaveBeenCalled();
  });

  it("clears stale token counts when history supplies lightweight session metadata", async () => {
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-2",
      sessionInfo: {
        key: "agent:main:other",
        sessionId: "session-2",
        model: "session-model",
        modelProvider: "openai",
        updatedAt: 50,
      },
      messages: [],
    });
    const state = createBaseState({
      historyLoaded: true,
      sessionInfo: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        updatedAt: 500,
      },
    });

    const { setSession } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      state,
    });

    await setSession("agent:main:other");

    expect(state.sessionInfo.inputTokens).toBeNull();
    expect(state.sessionInfo.outputTokens).toBeNull();
    expect(state.sessionInfo.totalTokens).toBeNull();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("restores an in-flight run reported by chat.history on switch-back", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-bg",
      messages: [],
      inFlightRun: { runId: "run-bg", text: "still working in the background" },
    });
    const updateAssistant = vi.fn();
    const setActivityStatus = vi.fn();
    const chatLog = {
      addSystem: vi.fn(),
      clearAll: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      updateAssistant,
      startTool: vi.fn(),
    } as unknown as import("./components/chat-log.js").ChatLog;
    const state = createBaseState({ currentSessionKey: "agent:main:other" });

    const { setSession } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      chatLog,
      state,
      setActivityStatus,
    });

    await setSession("agent:main:main");

    expect(updateAssistant).toHaveBeenCalledWith("still working in the background", "run-bg");
    expect(state.activeChatRunId).toBe("run-bg");
    expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");
  });

  it("adopts an in-flight run with no buffered text (Codex) and shows streaming", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-bg",
      messages: [],
      inFlightRun: { runId: "run-bg", text: "" },
    });
    const updateAssistant = vi.fn();
    const setActivityStatus = vi.fn();
    const chatLog = {
      addSystem: vi.fn(),
      clearAll: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      updateAssistant,
      startTool: vi.fn(),
    } as unknown as import("./components/chat-log.js").ChatLog;
    const state = createBaseState({ currentSessionKey: "agent:main:other" });

    const { setSession } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      chatLog,
      state,
      setActivityStatus,
    });

    await setSession("agent:main:main");

    // No partial bubble (none exists), but the run is adopted and shows streaming.
    expect(updateAssistant).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-bg");
    expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");
  });

  it("stays idle when chat.history reports no in-flight run", async () => {
    const loadHistory = vi.fn().mockResolvedValue({ sessionId: "session-x", messages: [] });
    const updateAssistant = vi.fn();
    const setActivityStatus = vi.fn();
    const chatLog = {
      addSystem: vi.fn(),
      clearAll: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      updateAssistant,
      startTool: vi.fn(),
    } as unknown as import("./components/chat-log.js").ChatLog;
    const state = createBaseState({ currentSessionKey: "agent:main:other" });

    const { setSession } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      chatLog,
      state,
      setActivityStatus,
    });

    await setSession("agent:main:main");

    expect(updateAssistant).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
  });

  it("applies default model info when the current session has no persisted entry yet", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 0,
      defaults: {
        model: "gpt-5.4",
        modelProvider: "openai",
        contextTokens: 272000,
      },
      sessions: [],
    });

    const state: TuiStateAccess = {
      agentDefaultId: "main",
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      agents: [],
      currentAgentId: "main",
      currentSessionKey: "agent:main:brand-new",
      currentSessionId: null,
      activeChatRunId: null,
      historyLoaded: false,
      sessionInfo: {},
      initialSessionApplied: true,
      isConnected: true,
      autoMessageSent: false,
      toolsExpanded: false,
      showThinking: false,
      connectionStatus: "connected",
      activityStatus: "idle",
      statusTimeout: null,
      lastCtrlCAt: 0,
    };

    const { refreshSessionInfo } = createSessionActions({
      client: { listSessions } as unknown as TuiBackend,
      chatLog: { addSystem: vi.fn() } as unknown as import("./components/chat-log.js").ChatLog,
      btw: createBtwPresenter(),
      tui: { requestRender: vi.fn() } as unknown as import("@earendil-works/pi-tui").TUI,
      opts: {},
      state,
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionKey: vi.fn(),
      updateHeader: vi.fn(),
      updateFooter: vi.fn(),
      updateAutocompleteProvider: vi.fn(),
      setActivityStatus: vi.fn(),
    });

    await refreshSessionInfo();

    expect(state.sessionInfo.model).toBe("gpt-5.4");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.contextTokens).toBe(272000);
  });

  it("resets activity status to idle when switching sessions after streaming", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 0,
      defaults: {},
      sessions: [],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-b",
      messages: [],
    });
    const setActivityStatus = vi.fn();

    const state = createBaseState({
      activeChatRunId: "run-1",
      historyLoaded: true,
      activityStatus: "streaming",
    });

    const { setSession } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      state,
      setActivityStatus,
    });

    await setSession("agent:main:other");

    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBeNull();
    expect(listSessions).toHaveBeenCalled();
  });

  it("clears optimistic pending state when switching sessions", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 0,
      defaults: {},
      sessions: [],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-b",
      messages: [],
    });
    const state = createBaseState({
      activeChatRunId: null,
      pendingChatRunId: null,
      pendingOptimisticUserMessage: true,
    });

    const { setSession } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      state,
    });

    await setSession("agent:main:other");

    expect(state.pendingOptimisticUserMessage).toBe(false);
    expect(state.pendingChatRunId).toBeNull();
  });

  it("starts an empty session without loading gateway history", async () => {
    const loadHistory = vi.fn().mockResolvedValue({ messages: [] });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    const addSystem = vi.fn();
    const clearAll = vi.fn();
    const requestRender = vi.fn();
    const rememberSessionKey = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-1",
      pendingChatRunId: "run-2",
      pendingOptimisticUserMessage: true,
      currentSessionId: "old-session",
      historyLoaded: false,
      sessionInfo: {
        model: "old-model",
        modelProvider: "old-provider",
        contextTokens: 99,
        thinkingLevel: "high",
        fastMode: false,
        verboseLevel: "debug",
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    });

    const { setEmptySession } = createTestSessionActions({
      client: { listSessions, loadHistory } as unknown as TuiBackend,
      chatLog: {
        addSystem,
        clearAll,
      } as unknown as import("./components/chat-log.js").ChatLog,
      tui: { requestRender } as unknown as import("@earendil-works/pi-tui").TUI,
      state,
      rememberSessionKey,
      emptySessionInfoDefaults: {
        verboseLevel: "on",
      },
    });

    await setEmptySession("agent:main:tui-empty");

    expect(loadHistory).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
    expect(state.currentSessionKey).toBe("agent:main:tui-empty");
    expect(state.currentSessionId).toBeNull();
    expect(state.activeChatRunId).toBeNull();
    expect(state.pendingChatRunId).toBeNull();
    expect(state.pendingOptimisticUserMessage).toBe(false);
    expect(state.historyLoaded).toBe(true);
    expect(state.sessionInfo.model).toBeUndefined();
    expect(state.sessionInfo.modelProvider).toBeUndefined();
    expect(state.sessionInfo.contextTokens).toBeNull();
    expect(state.sessionInfo.thinkingLevel).toBeUndefined();
    expect(state.sessionInfo.fastMode).toBeUndefined();
    expect(state.sessionInfo.verboseLevel).toBe("on");
    expect(state.sessionInfo.inputTokens).toBeNull();
    expect(state.sessionInfo.outputTokens).toBeNull();
    expect(state.sessionInfo.totalTokens).toBeNull();
    expect(clearAll).toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("session agent:main:tui-empty");
    expect(rememberSessionKey).toHaveBeenCalledWith("agent:main:tui-empty");
    expect(requestRender).toHaveBeenCalled();
  });

  it("applies reset mutation result without reloading gateway history", () => {
    const loadHistory = vi.fn().mockResolvedValue({ messages: [] });
    const addSystem = vi.fn();
    const clearAll = vi.fn();
    const state = createBaseState({
      currentSessionKey: "agent:main:old",
      currentSessionId: "old-session",
      sessionInfo: {
        model: "old-model",
        modelProvider: "old-provider",
      },
    });

    const { applySessionMutationResult } = createTestSessionActions({
      client: { loadHistory } as unknown as TuiBackend,
      chatLog: {
        addSystem,
        clearAll,
      } as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    const applied = applySessionMutationResult({
      ok: true,
      key: "agent:main:new",
      entry: {
        sessionId: "new-session",
        model: "new-model",
        modelProvider: "openai",
        updatedAt: 123,
      },
    });

    expect(applied).toBe(true);
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.currentSessionKey).toBe("agent:main:new");
    expect(state.currentSessionId).toBe("new-session");
    expect(state.sessionInfo.model).toBe("new-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.updatedAt).toBe(123);
    expect(state.historyLoaded).toBe(true);
    expect(clearAll).toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("session agent:main:new");
  });

  it("does not fast-clear reset results without a replacement entry", () => {
    const addSystem = vi.fn();
    const clearAll = vi.fn();
    const state = createBaseState({
      currentSessionKey: "agent:main:old",
      currentSessionId: "old-session",
      historyLoaded: false,
    });

    const { applySessionMutationResult } = createTestSessionActions({
      chatLog: {
        addSystem,
        clearAll,
      } as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    const applied = applySessionMutationResult({ ok: true });

    expect(applied).toBe(false);
    expect(state.currentSessionKey).toBe("agent:main:old");
    expect(state.currentSessionId).toBe("old-session");
    expect(state.historyLoaded).toBe(false);
    expect(clearAll).not.toHaveBeenCalled();
    expect(addSystem).not.toHaveBeenCalled();
  });

  it("aborts the in-flight runId when only pendingChatRunId is set", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const addSystem = vi.fn();
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      activeChatRunId: null,
      pendingChatRunId: "run-pending",
    });

    const { abortActive } = createSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      chatLog: {
        addSystem,
        clearAll: vi.fn(),
      } as unknown as import("./components/chat-log.js").ChatLog,
      btw: createBtwPresenter(),
      tui: { requestRender: vi.fn() } as unknown as import("@earendil-works/pi-tui").TUI,
      opts: {},
      state,
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionKey: vi.fn((raw?: string) => raw ?? "agent:main:main"),
      updateHeader: vi.fn(),
      updateFooter: vi.fn(),
      updateAutocompleteProvider: vi.fn(),
      setActivityStatus,
    });

    await abortActive();

    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      runId: "run-pending",
    });
    expect(addSystem).not.toHaveBeenCalledWith("no active run");
    expect(state.pendingChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("passes the selected agent when aborting selected global runs", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const state = createBaseState({
      currentAgentId: "work",
      currentSessionKey: "global",
      pendingChatRunId: "run-work-global",
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      state,
    });

    await abortActive();

    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "work",
      runId: "run-work-global",
    });
  });

  it("coalesces repeated no-active-run abort notices", async () => {
    const addSystem = vi.fn();
    const requestRender = vi.fn();

    const { abortActive } = createTestSessionActions({
      chatLog: {
        addSystem,
        clearAll: vi.fn(),
      } as unknown as import("./components/chat-log.js").ChatLog,
      tui: { requestRender } as unknown as import("@earendil-works/pi-tui").TUI,
    });

    await abortActive();

    expect(addSystem).toHaveBeenCalledWith("no active run", {
      coalesceConsecutive: true,
    });
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("does not abort local post-turn maintenance while finishing context", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-finishing",
      pendingChatRunId: null,
      activityStatus: "finishing context",
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      chatLog: {
        addSystem,
        clearAll: vi.fn(),
      } as unknown as import("./components/chat-log.js").ChatLog,
      tui: { requestRender } as unknown as import("@earendil-works/pi-tui").TUI,
      opts: { local: true },
      state,
    });

    await abortActive();

    expect(abortChat).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith(
      "agent is finishing context; wait for it to finish before aborting",
    );
    expect(requestRender).toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-finishing");
  });

  it("aborts local post-turn maintenance for explicit stop", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-finishing",
      pendingChatRunId: null,
      activityStatus: "finishing context",
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      opts: { local: true },
      state,
      setActivityStatus,
    });

    await abortActive({ preferActive: true });

    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      runId: "run-finishing",
    });
    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("aborts the queued pending run after a local finishing turn accepts the next send", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-finishing",
      pendingChatRunId: "run-queued",
      pendingOptimisticUserMessage: true,
      activityStatus: "waiting",
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      opts: { local: true },
      state,
      setActivityStatus,
    });

    await abortActive();

    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      runId: "run-queued",
    });
    expect(state.pendingChatRunId).toBeNull();
    expect(state.pendingOptimisticUserMessage).toBe(false);
    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("aborts the queued pending run after a gateway active turn accepts the next send", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-active",
      pendingChatRunId: "run-queued",
      activityStatus: "waiting",
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      opts: { local: false },
      state,
      setActivityStatus,
    });

    await abortActive();

    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      runId: "run-queued",
    });
    expect(state.pendingChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("aborts the active run when requested while a queued run is pending", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-active",
      pendingChatRunId: "run-queued",
      activityStatus: "waiting",
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      opts: { local: true },
      state,
      setActivityStatus,
    });

    await abortActive({ preferActive: true });

    expect(abortChat).toHaveBeenNthCalledWith(1, {
      sessionKey: "agent:main:main",
      runId: "run-queued",
    });
    expect(abortChat).toHaveBeenNthCalledWith(2, {
      sessionKey: "agent:main:main",
      runId: "run-active",
    });
    expect(state.pendingChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("remembers the selected session after history loads", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [{ key: "agent:main:main", sessionId: "session-main" }],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      messages: [],
    });
    const rememberSessionKey = vi.fn();
    const state = createBaseState();

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      state,
      rememberSessionKey,
    });

    await runLoadHistory();

    expect(state.currentSessionId).toBe("session-main");
    expect(rememberSessionKey).toHaveBeenCalledWith("agent:main:main");
  });

  it("hydrates session info from chat history without listing sessions", async () => {
    const listSessions = vi.fn();
    const loadHistory = vi.fn().mockResolvedValue({
      messages: [],
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "session-main",
        modelProvider: "openai",
        model: "gpt-5",
        contextTokens: 120_000,
        thinkingLevel: "medium",
        updatedAt: 200,
      },
      defaults: {
        modelProvider: "openai",
        model: "gpt-5",
        contextTokens: 120_000,
      },
    });
    const state = createBaseState();

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      state,
    });

    await runLoadHistory();

    expect(listSessions).not.toHaveBeenCalled();
    expect(state.currentSessionId).toBe("session-main");
    expect(state.sessionInfo.model).toBe("gpt-5");
    expect(state.sessionInfo.contextTokens).toBe(120_000);
    expect(state.sessionInfo.thinkingLevel).toBe("medium");
  });

  it("uses top-level chat history thinking level when session info inherits it", async () => {
    const listSessions = vi.fn();
    const loadHistory = vi.fn().mockResolvedValue({
      messages: [],
      thinkingLevel: "medium",
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "session-main",
        modelProvider: "openai",
        model: "gpt-5",
        contextTokens: 120_000,
        thinkingDefault: "medium",
        updatedAt: 200,
      },
    });
    const state = createBaseState();

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      state,
    });

    await runLoadHistory();

    expect(listSessions).not.toHaveBeenCalled();
    expect(state.sessionInfo.thinkingLevel).toBe("medium");
  });

  it("loads selected-agent global history with the selected agent id", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-work-global",
      messages: [],
    });
    const state = createBaseState({
      currentAgentId: "work",
      currentSessionKey: "global",
    });

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory,
      } as unknown as TuiBackend,
      state,
    });

    await runLoadHistory();

    expect(loadHistory).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "work",
      limit: 200,
    });
    expect(state.currentSessionId).toBe("session-work-global");
  });
});
