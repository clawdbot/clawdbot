// Covers TUI session action routing and backend calls.
import { describe, expect, it, vi } from "vitest";
import type { ChatLog } from "./components/chat-log.js";
import type { TuiBackend } from "./tui-backend.js";
import { createSessionActions } from "./tui-session-actions.js";
import { TUI_SESSION_LOOKUP_LIMIT } from "./tui-session-list-policy.js";
import {
  getPendingSubmitAcceptedRunId,
  getPendingSubmitDraft,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";
import type { TuiStateAccess } from "./tui-types.js";

describe("tui session actions", () => {
  const sendingSubmit = (runId: string, draftText = "pending"): TuiPendingSubmit => ({
    phase: "sending",
    runId,
    draftText,
  });
  const acceptedSubmit = (
    runId: string,
    draftText: string | null = "pending",
  ): TuiPendingSubmit => ({ phase: "accepted", runId, draftText });
  const createBtwPresenter = () => ({
    clear: vi.fn(),
    showResult: vi.fn(),
  });
  const createDeferred = <T>() => {
    let resolve: (value: T) => void = () => {};
    let reject: (reason?: unknown) => void = () => {};
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };
  const createHistoryChatLog = () => {
    const addSystem = vi.fn();
    const addUser = vi.fn();
    const chatLog = {
      addSystem,
      clearAll: vi.fn(),
      clearPendingUsers: vi.fn(),
      addUser,
      finalizeAssistant: vi.fn(),
      reconcilePendingUsers: vi.fn().mockReturnValue([]),
      restorePendingUsers: vi.fn(),
      updateAssistant: vi.fn(),
      startTool: vi.fn(),
    } as unknown as ChatLog;
    return { chatLog, addSystem, addUser };
  };

  const createBaseState = (overrides: Partial<TuiStateAccess> = {}): TuiStateAccess => ({
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: null,
    activeChatRunId: null,
    pendingSubmit: null,
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
        addUser: vi.fn(),
        finalizeAssistant: vi.fn(),
        clearPendingUsers: vi.fn(),
        clearAll: vi.fn(),
        reconcilePendingUsers: vi.fn().mockReturnValue([]),
        restorePendingUsers: vi.fn(),
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
          sessionId: "session-old",
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
          sessionId: "session-current",
          model: "Minimax-M2.7",
          modelProvider: "minimax",
        },
      ],
    });

    await Promise.all([first, second]);

    expect(state.sessionInfo.model).toBe("Minimax-M2.7");
    expect(state.currentSessionId).toBe("session-current");
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

  it("applies the runtime-aware thinking projection returned by session patches", () => {
    const state = createBaseState();
    const { applySessionInfoFromPatch } = createTestSessionActions({ state });

    applySessionInfoFromPatch({
      ok: true,
      path: "/tmp/sessions.json",
      key: "agent:main:main",
      entry: { sessionId: "session-1", updatedAt: 200 },
      resolved: {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "session-key" },
        thinkingLevel: "ultra",
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "ultra", label: "ultra" },
        ],
      },
    });

    expect(state.sessionInfo).toEqual(
      expect.objectContaining({
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "session-key" },
        thinkingLevel: "ultra",
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "ultra", label: "ultra" },
        ],
      }),
    );
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

  it("renders a fresh session total as 0 (not '?') when totalTokensFresh is set", async () => {
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-fresh",
      sessionInfo: {
        key: "agent:main:fresh",
        sessionId: "session-fresh",
        model: "session-model",
        modelProvider: "openai",
        // The gateway strips the fresh 0 via resolvePositiveNumber but still
        // flags it fresh, so the footer must show 0 rather than "?". (#93798)
        totalTokensFresh: true,
        updatedAt: 60,
      },
      messages: [],
    });
    const state = createBaseState({
      historyLoaded: true,
      sessionInfo: {
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

    await setSession("agent:main:fresh");

    expect(state.sessionInfo.totalTokens).toBe(0);
    expect(state.sessionInfo.totalTokensFresh).toBe(true);
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
      clearPendingUsers: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      reconcilePendingUsers: vi.fn().mockReturnValue([]),
      restorePendingUsers: vi.fn(),
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
      clearPendingUsers: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      reconcilePendingUsers: vi.fn().mockReturnValue([]),
      restorePendingUsers: vi.fn(),
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
      clearPendingUsers: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      reconcilePendingUsers: vi.fn().mockReturnValue([]),
      restorePendingUsers: vi.fn(),
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

  it("keeps the newer session when an earlier switch's history resolves last", async () => {
    const historyA = createDeferred<unknown>();
    const historyB = createDeferred<unknown>();
    const loadHistory = vi
      .fn()
      .mockImplementationOnce(() => historyA.promise)
      .mockImplementationOnce(() => historyB.promise);
    const { chatLog, addUser } = createHistoryChatLog();
    const state = createBaseState({ currentSessionKey: "agent:main:home" });
    const setActivityStatus = vi.fn();

    const { setSession } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      chatLog,
      state,
      setActivityStatus,
    });

    const firstSwitch = setSession("agent:main:A");
    const secondSwitch = setSession("agent:main:B");

    historyB.resolve({
      sessionId: "session-b",
      sessionInfo: { key: "agent:main:B", sessionId: "session-b", updatedAt: 20 },
      messages: [{ role: "user", content: "message from B" }],
    });
    historyA.resolve({
      sessionId: "session-a",
      sessionInfo: { key: "agent:main:A", sessionId: "session-a", updatedAt: 10 },
      messages: [{ role: "user", content: "message from A" }],
      inFlightRun: { runId: "run-a", text: "stale A run" },
    });

    await Promise.all([firstSwitch, secondSwitch]);

    expect(state.currentSessionKey).toBe("agent:main:B");
    expect(state.currentSessionId).toBe("session-b");
    expect(state.activeChatRunId).toBeNull();
    const renderedUsers = addUser.mock.calls.map((call) => call[0]);
    expect(renderedUsers).toContain("message from B");
    expect(renderedUsers).not.toContain("message from A");
  });

  it("ignores a superseded switch whose history request rejects", async () => {
    const historyA = createDeferred<unknown>();
    const historyB = createDeferred<unknown>();
    const loadHistory = vi
      .fn()
      .mockImplementationOnce(() => historyA.promise)
      .mockImplementationOnce(() => historyB.promise);
    const { chatLog, addSystem, addUser } = createHistoryChatLog();
    const state = createBaseState({ currentSessionKey: "agent:main:home" });
    const setActivityStatus = vi.fn();

    const { setSession } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      chatLog,
      state,
      setActivityStatus,
    });

    const firstSwitch = setSession("agent:main:A");
    const secondSwitch = setSession("agent:main:B");

    historyB.resolve({
      sessionId: "session-b",
      sessionInfo: { key: "agent:main:B", sessionId: "session-b", updatedAt: 20 },
      messages: [{ role: "user", content: "message from B" }],
    });
    historyA.reject(new Error("history rpc aborted"));

    await Promise.all([firstSwitch, secondSwitch]);

    expect(state.currentSessionKey).toBe("agent:main:B");
    expect(state.currentSessionId).toBe("session-b");
    expect(state.activeChatRunId).toBeNull();
    const systemMessages = addSystem.mock.calls.map((call) => String(call[0]));
    expect(systemMessages.some((message) => message.includes("history failed"))).toBe(false);
    const renderedUsers = addUser.mock.calls.map((call) => call[0]);
    expect(renderedUsers).toContain("message from B");
  });

  it("keeps the newer session when an earlier history load awaits session info", async () => {
    const historyA = createDeferred<unknown>();
    const historyB = createDeferred<unknown>();
    const sessionInfoA = createDeferred<unknown>();
    const sessionInfoB = createDeferred<unknown>();
    const loadHistory = vi
      .fn()
      .mockImplementationOnce(() => historyA.promise)
      .mockImplementationOnce(() => historyB.promise);
    const listSessions = vi
      .fn()
      .mockImplementationOnce(() => sessionInfoA.promise)
      .mockImplementationOnce(() => sessionInfoB.promise);
    const { chatLog, addSystem, addUser } = createHistoryChatLog();
    const state = createBaseState({ currentSessionKey: "agent:main:home" });

    const { setSession } = createTestSessionActions({
      client: { listSessions, loadHistory } as unknown as TuiBackend,
      chatLog,
      state,
    });

    const firstSwitch = setSession("agent:main:A");
    historyA.resolve({
      sessionId: "session-a",
      messages: [{ role: "user", content: "message from A" }],
    });
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

    const secondSwitch = setSession("agent:main:B");
    historyB.resolve({
      sessionId: "session-b",
      messages: [{ role: "user", content: "message from B" }],
    });

    sessionInfoA.resolve({
      defaults: {},
      sessions: [{ key: "agent:main:A", sessionId: "session-a", updatedAt: 10 }],
    });
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    sessionInfoB.resolve({
      defaults: {},
      sessions: [{ key: "agent:main:B", sessionId: "session-b", updatedAt: 20 }],
    });
    await Promise.all([firstSwitch, secondSwitch]);

    expect(state.currentSessionKey).toBe("agent:main:B");
    expect(state.currentSessionId).toBe("session-b");
    const renderedUsers = addUser.mock.calls.map((call) => call[0]);
    expect(renderedUsers).toContain("message from B");
    expect(renderedUsers).not.toContain("message from A");
    expect(addSystem).not.toHaveBeenCalledWith(expect.stringContaining("sessions list failed"));
  });

  it("ignores stale session info after switching away and back to the same key", async () => {
    const firstHistoryA = createDeferred<unknown>();
    const historyB = createDeferred<unknown>();
    const secondHistoryA = createDeferred<unknown>();
    const firstSessionInfoA = createDeferred<unknown>();
    const loadHistory = vi
      .fn()
      .mockImplementationOnce(() => firstHistoryA.promise)
      .mockImplementationOnce(() => historyB.promise)
      .mockImplementationOnce(() => secondHistoryA.promise);
    const listSessions = vi.fn(() => firstSessionInfoA.promise);
    const state = createBaseState({ currentSessionKey: "agent:main:home" });

    const { setSession } = createTestSessionActions({
      client: { listSessions, loadHistory } as unknown as TuiBackend,
      state,
    });

    const firstSwitchA = setSession("agent:main:A");
    firstHistoryA.resolve({ sessionId: "session-a-old", messages: [] });
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

    const switchB = setSession("agent:main:B");
    historyB.resolve({
      sessionInfo: { key: "agent:main:B", sessionId: "session-b", updatedAt: 20 },
      messages: [],
    });
    await switchB;

    const secondSwitchA = setSession("agent:main:A");
    secondHistoryA.resolve({
      sessionInfo: {
        key: "agent:main:A",
        sessionId: "session-a-new",
        model: "new-model",
        updatedAt: 30,
      },
      messages: [],
    });
    await secondSwitchA;

    firstSessionInfoA.resolve({
      defaults: {},
      sessions: [
        {
          key: "agent:main:A",
          sessionId: "session-a-old",
          model: "old-model",
          updatedAt: 10,
        },
      ],
    });
    await firstSwitchA;

    expect(state.currentSessionKey).toBe("agent:main:A");
    expect(state.currentSessionId).toBe("session-a-new");
    expect(state.sessionInfo.model).toBe("new-model");
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
      pendingSubmit: null,
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
      pendingSubmit: sendingSubmit("run-pending"),
    });

    const { setSession } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      state,
    });

    await setSession("agent:main:other");

    expect(state.pendingSubmit).toBeNull();
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

  it("uses session-scoped abort when only an accepted pending submit is tracked", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const addSystem = vi.fn();
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      activeChatRunId: null,
      pendingSubmit: acceptedSubmit("run-pending", null),
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
    });
    expect(addSystem).not.toHaveBeenCalledWith("no active run");
    expect(state.pendingSubmit).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("drops the optimistic pending row when aborting a not-yet-registered submit", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const dropPendingUser = vi.fn();
    const state = createBaseState({
      activeChatRunId: null,
      pendingSubmit: acceptedSubmit("run-1", "hello"),
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      chatLog: {
        addSystem: vi.fn(),
        clearAll: vi.fn(),
        dropPendingUser,
      } as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    await abortActive();

    expect(dropPendingUser).toHaveBeenCalledWith("run-1");
    expect(state.pendingSubmit).toBeNull();
  });

  it("keeps the optimistic row when aborting a run that already registered", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const dropPendingUser = vi.fn();
    const state = createBaseState({
      activeChatRunId: null,
      pendingSubmit: acceptedSubmit("run-1", null),
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      chatLog: {
        addSystem: vi.fn(),
        clearAll: vi.fn(),
        dropPendingUser,
      } as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    await abortActive();

    expect(dropPendingUser).not.toHaveBeenCalled();
  });

  it("drops terminalized queued rows returned by session abort", async () => {
    const abortChat = vi.fn().mockResolvedValue({
      ok: true,
      aborted: true,
      runIds: ["run-active", "run-queued-terminal"],
    });
    const dropPendingUser = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-active",
      pendingSubmit: null,
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      chatLog: {
        addSystem: vi.fn(),
        clearAll: vi.fn(),
        dropPendingUser,
      } as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    await abortActive();

    expect(dropPendingUser).toHaveBeenCalledTimes(1);
    expect(dropPendingUser).toHaveBeenCalledWith("run-queued-terminal");
  });

  it("drops a queued row that terminalizes while session abort is pending", async () => {
    let resolveAbort:
      | ((value: { ok: boolean; aborted: boolean; runIds: string[] }) => void)
      | undefined;
    const abortChat = vi.fn().mockImplementation(
      () =>
        new Promise<{ ok: boolean; aborted: boolean; runIds: string[] }>((resolve) => {
          resolveAbort = resolve;
        }),
    );
    const dropPendingUser = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-active",
      pendingSubmit: acceptedSubmit("run-queued", "queued"),
    });
    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      chatLog: {
        addSystem: vi.fn(),
        clearAll: vi.fn(),
        dropPendingUser,
      } as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    const pendingAbort = abortActive();
    await vi.waitFor(() => expect(abortChat).toHaveBeenCalledOnce());
    state.pendingSubmit = null;
    resolveAbort?.({ ok: true, aborted: true, runIds: ["run-active", "run-queued"] });
    await pendingAbort;

    expect(dropPendingUser).toHaveBeenCalledTimes(1);
    expect(dropPendingUser).toHaveBeenCalledWith("run-queued");
  });

  it("passes the selected agent when aborting selected global runs", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const state = createBaseState({
      currentAgentId: "work",
      currentSessionKey: "global",
      pendingSubmit: acceptedSubmit("run-work-global", null),
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      state,
    });

    await abortActive();

    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "work",
    });
  });

  it("coalesces repeated no-active-run abort notices", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: false });
    const addSystem = vi.fn();
    const requestRender = vi.fn();

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
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

  it("preserves pending UI state when session abort finds no backend run", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: false });
    const dropPendingUser = vi.fn();
    const state = createBaseState({
      pendingSubmit: acceptedSubmit("run-pending", "hello"),
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      chatLog: {
        addSystem: vi.fn(),
        clearAll: vi.fn(),
        dropPendingUser,
      } as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    await abortActive();

    expect(getPendingSubmitAcceptedRunId(state)).toBe("run-pending");
    expect(getPendingSubmitDraft(state)).toEqual({ runId: "run-pending", text: "hello" });
    expect(dropPendingUser).not.toHaveBeenCalled();
  });

  it("does not abort local post-turn maintenance while finishing context", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-finishing",
      pendingSubmit: null,
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
      pendingSubmit: null,
      activityStatus: "finishing context",
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      opts: { local: true },
      state,
      setActivityStatus,
    });

    await abortActive({ preferActive: true });

    // Session-scoped abort: Gateway cancels authorized queued turns first, then active.
    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
    });
    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("aborts the queued pending run after a local finishing turn accepts the next send", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-finishing",
      pendingSubmit: acceptedSubmit("run-queued", null),
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
    });
    expect(state.pendingSubmit).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("aborts the queued pending run after a gateway active turn accepts the next send", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-active",
      pendingSubmit: acceptedSubmit("run-queued", null),
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
    });
    expect(state.pendingSubmit).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("aborted");
  });

  it("aborts the active run when requested while a queued run is pending", async () => {
    const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: true });
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      activeChatRunId: "run-active",
      pendingSubmit: acceptedSubmit("run-queued", null),
      activityStatus: "waiting",
    });

    const { abortActive } = createTestSessionActions({
      client: { listSessions: vi.fn(), abortChat } as unknown as TuiBackend,
      opts: { local: true },
      state,
      setActivityStatus,
    });

    await abortActive({ preferActive: true });

    // One session abort covers queued + active with Gateway-owned cancel order.
    expect(abortChat).toHaveBeenCalledTimes(1);
    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
    });
    expect(state.pendingSubmit).toBeNull();
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
    const state = createBaseState({ currentSessionKey: "main" });

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
    expect(state.currentSessionKey).toBe("agent:main:main");
    expect(rememberSessionKey).toHaveBeenCalledWith("agent:main:main");
  });

  it("preserves optimistic user messages across stale history rebuilds", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [{ key: "agent:main:main", sessionId: "session-main" }],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      messages: [
        { role: "user", content: "persisted", timestamp: 2_000 },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
      ],
    });
    const chatLog = {
      addSystem: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      clearAll: vi.fn(),
      clearPendingUsers: vi.fn(),
      reconcilePendingUsers: vi.fn().mockReturnValue([]),
      restorePendingUsers: vi.fn(),
    };

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
    });

    const result = await runLoadHistory();

    expect(chatLog.clearAll).toHaveBeenCalledWith({ preservePendingUsers: true });
    expect(chatLog.reconcilePendingUsers).toHaveBeenCalledWith([
      { text: "persisted", timestamp: 2_000 },
    ]);
    expect(chatLog.restorePendingUsers).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ loaded: true, inFlightRunId: null });
  });

  it("releases a pending submit when reconnect history proves it was accepted", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      messages: [{ role: "user", content: "persisted", timestamp: 2_000 }],
    });
    const chatLog = {
      addSystem: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      clearAll: vi.fn(),
      reconcilePendingUsers: vi.fn().mockReturnValue(["run-pending"]),
      restorePendingUsers: vi.fn(),
    };
    const state = createBaseState({
      pendingSubmit: acceptedSubmit("run-pending", "persisted"),
    });

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    await runLoadHistory();

    expect(state.pendingSubmit).toBeNull();
  });

  it("keeps a pending submit when reconnect history has not accepted it", async () => {
    const loadHistory = vi.fn().mockResolvedValue({ sessionId: "session-main", messages: [] });
    const chatLog = {
      addSystem: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      clearAll: vi.fn(),
      reconcilePendingUsers: vi.fn().mockReturnValue([]),
      restorePendingUsers: vi.fn(),
    };
    const state = createBaseState({
      pendingSubmit: acceptedSubmit("run-pending", "not persisted"),
    });

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    await runLoadHistory();

    expect(getPendingSubmitAcceptedRunId(state)).toBe("run-pending");
    expect(getPendingSubmitDraft(state)).toEqual({
      runId: "run-pending",
      text: "not persisted",
    });
  });

  it("force-renders after rebuilding chat history so transient status rows are cleared", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      messages: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }],
    });
    const requestRender = vi.fn();

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory,
      } as unknown as TuiBackend,
      tui: { requestRender } as unknown as import("@earendil-works/pi-tui").TUI,
    });

    await runLoadHistory();

    expect(requestRender).toHaveBeenCalledWith(true);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
