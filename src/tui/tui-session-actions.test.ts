// Covers TUI session action routing and backend calls.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { ChatLog } from "./components/chat-log.js";
import type { TuiBackend } from "./tui-backend.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { createSessionActions } from "./tui-session-actions.js";
import { TUI_SESSION_LOOKUP_LIMIT } from "./tui-session-list-policy.js";
import {
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import {
  getPendingSubmitAcceptedRunId,
  getPendingSubmitDraft,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";
import type { TuiHistoryLoadResult, TuiStateAccess } from "./tui-types.js";

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
  const createHistoryChatLog = () => {
    const addSystem = vi.fn();
    const addUser = vi.fn();
    const clearAll = vi.fn();
    const chatLog = {
      addSystem,
      clearAll,
      clearPendingUsers: vi.fn(),
      addUser,
      addLiveUser: vi.fn(),
      addPendingUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      updateAssistant: vi.fn(),
      startTool: vi.fn(),
    } as unknown as ChatLog;
    return { chatLog, addSystem, addUser, clearAll };
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

  const persistLiveUser = (
    state: TuiStateAccess,
    params: { text: string; messageId: string; messageSeq?: number; runId?: string },
  ) =>
    reduceTuiSessionProjection(state, {
      type: "messagePersisted",
      message: {
        role: "user",
        content: params.text,
        __openclaw: {
          id: params.messageId,
          ...(params.messageSeq !== undefined ? { seq: params.messageSeq } : {}),
          ...(params.runId ? { idempotencyKey: `${params.runId}:user` } : {}),
        },
      },
      scope: readTuiSessionProjectionScope(state),
    });

  const sendPendingUser = (state: TuiStateAccess, runId: string, text: string) =>
    reduceTuiSessionProjection(state, {
      type: "sendPending",
      message: { role: "user", content: text, idempotencyKey: `${runId}:user` },
      runId,
      scope: readTuiSessionProjectionScope(state),
    });

  const createTestSessionActions = (
    overrides: Partial<Parameters<typeof createSessionActions>[0]>,
  ) =>
    createSessionActions({
      client: { listSessions: vi.fn() } as unknown as TuiBackend,
      chatLog: {
        addSystem: vi.fn(),
        addUser: vi.fn(),
        addLiveUser: vi.fn(),
        addPendingUser: vi.fn(),
        finalizeAssistant: vi.fn(),
        clearPendingUsers: vi.fn(),
        clearAll: vi.fn(),
      } as unknown as import("./components/chat-log.js").ChatLog,
      btw: createBtwPresenter(),
      tui: { requestRender: vi.fn() } as unknown as import("@earendil-works/pi-tui").TUI,
      opts: {},
      state: createBaseState(),
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionSelection: vi.fn((raw?: string) => ({
        key: raw ?? "agent:main:main",
        agentId: "main",
      })),
      updateHeader: vi.fn(),
      updateFooter: vi.fn(),
      updateAutocompleteProvider: vi.fn(),
      setActivityStatus: vi.fn(),
      ...overrides,
    });

  it("keeps the cached agent roster when a refresh fails", async () => {
    const cachedAgents = [{ id: "cached", name: "Cached Agent" }];
    const state = createBaseState({
      agentDefaultId: "cached",
      sessionMainKey: "cached-main",
      sessionScope: "per-sender",
      agents: cachedAgents,
      currentAgentId: "cached",
    });
    const agentNames = new Map([["cached", "Cached Agent"]]);
    const addSystem = vi.fn();
    const { refreshAgents } = createTestSessionActions({
      client: {
        listAgents: vi.fn().mockRejectedValue(new Error("gateway unavailable")),
      } as unknown as TuiBackend,
      chatLog: { addSystem } as unknown as import("./components/chat-log.js").ChatLog,
      state,
      agentNames,
    });

    await expect(refreshAgents()).resolves.toEqual({
      ok: false,
      error: "gateway unavailable",
    });
    expect(state.agents).toBe(cachedAgents);
    expect(state.agentDefaultId).toBe("cached");
    expect(state.sessionMainKey).toBe("cached-main");
    expect(state.sessionScope).toBe("per-sender");
    expect([...agentNames]).toEqual([["cached", "Cached Agent"]]);
    expect(addSystem).toHaveBeenCalledWith("agents list failed: gateway unavailable");
  });

  it("switches colliding global sessions as an owner-key pair", async () => {
    const state = createBaseState({
      currentAgentId: "research",
      currentSessionKey: "global",
    });
    const loadHistory = vi.fn().mockResolvedValue({ messages: [] });
    const { setSession } = createTestSessionActions({
      client: { loadHistory, listSessions: vi.fn() } as unknown as TuiBackend,
      state,
      resolveSessionSelection: vi.fn(() => ({ key: "global", agentId: "ops" })),
    });

    await setSession("agent:ops:global");

    expect(state.currentAgentId).toBe("ops");
    expect(state.currentSessionKey).toBe("global");
    expect(loadHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "global", agentId: "ops" }),
    );
  });

  it("returns success after applying a normalized fresh agent roster", async () => {
    const state = createBaseState({
      agents: [{ id: "cached", name: "Cached Agent" }],
      currentAgentId: "cached",
    });
    const agentNames = new Map([["cached", "Cached Agent"]]);
    const updateHeader = vi.fn();
    const updateFooter = vi.fn();
    const { refreshAgents } = createTestSessionActions({
      client: {
        listAgents: vi.fn().mockResolvedValue({
          defaultId: " Team Lead ",
          mainKey: " Primary ",
          scope: "per-sender",
          agents: [
            { id: " Team Lead ", name: " Lead Agent " },
            { id: " System Agent ", kind: "system", name: " System Agent " },
          ],
        }),
      } as unknown as TuiBackend,
      state,
      agentNames,
      updateHeader,
      updateFooter,
    });

    await expect(refreshAgents()).resolves.toEqual({ ok: true, value: undefined });
    expect(state.agentDefaultId).toBe("team-lead");
    expect(state.sessionMainKey).toBe("primary");
    expect(state.sessionScope).toBe("per-sender");
    expect(state.agents).toEqual([
      { id: "team-lead", kind: undefined, name: "Lead Agent" },
      { id: "system-agent", kind: "system", name: "System Agent" },
    ]);
    expect(state.currentAgentId).toBe("team-lead");
    expect([...agentNames]).toEqual([
      ["team-lead", "Lead Agent"],
      ["system-agent", "System Agent"],
    ]);
    expect(updateHeader).toHaveBeenCalledTimes(1);
    expect(updateFooter).toHaveBeenCalledTimes(1);
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

  it.each([
    {
      name: "another session",
      currentAgentId: "main",
      currentSessionKey: "agent:main:current",
      resultKey: "agent:main:previous",
    },
    {
      name: "the same request key owned by another agent",
      currentAgentId: "main",
      currentSessionKey: "agent:main:main",
      resultKey: "agent:work:main",
    },
  ])(
    "ignores a session patch belonging to $name",
    ({ currentAgentId, currentSessionKey, resultKey }) => {
      const updateHeader = vi.fn();
      const updateFooter = vi.fn();
      const state = createBaseState({
        currentAgentId,
        currentSessionKey,
        sessionInfo: { model: "current-model", modelProvider: "openai" },
      });
      const { applySessionInfoFromPatch } = createTestSessionActions({
        state,
        updateHeader,
        updateFooter,
      });

      applySessionInfoFromPatch({
        ok: true,
        path: "/sessions/patch",
        key: resultKey,
        entry: { model: "stale-model", modelProvider: "anthropic" },
      });

      expect(state.currentSessionKey).toBe(currentSessionKey);
      expect(state.currentAgentId).toBe(currentAgentId);
      expect(state.sessionInfo.model).toBe("current-model");
      expect(state.sessionInfo.modelProvider).toBe("openai");
      expect(updateHeader).not.toHaveBeenCalled();
      expect(updateFooter).not.toHaveBeenCalled();
    },
  );

  it("adopts the canonical key for a patch belonging to the selected alias", () => {
    const state = createBaseState({ currentSessionKey: "main" });
    const updateHeader = vi.fn();
    const { applySessionInfoFromPatch } = createTestSessionActions({
      state,
      updateHeader,
    });

    applySessionInfoFromPatch({
      ok: true,
      path: "/sessions/patch",
      key: "agent:main:main",
      entry: { model: "gpt-5.6-luna", modelProvider: "openai" },
    });

    expect(state.currentSessionKey).toBe("agent:main:main");
    expect(state.currentAgentId).toBe("main");
    expect(state.sessionInfo.model).toBe("gpt-5.6-luna");
    expect(updateHeader).toHaveBeenCalledOnce();
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

  it("preserves an authoritative user received while same-session history is loading", async () => {
    const deferredHistory = createDeferred<unknown>();
    const chatLog = new ChatLog();
    const state = createBaseState({ currentSessionId: "session-main" });
    const { loadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn(() => deferredHistory.promise),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    const loading = loadHistory();
    persistLiveUser(state, {
      text: "Browser prompt received during refresh",
      messageId: "shared-user-1",
      messageSeq: 1,
      runId: "shared-run-1",
    });
    deferredHistory.resolve({
      sessionId: "session-main",
      sessionInfo: { key: "agent:main:main", sessionId: "session-main" },
      messages: [
        {
          role: "assistant",
          content: "History completed",
          __openclaw: { id: "shared-assistant-1", seq: 2 },
        },
      ],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("Browser prompt received during refresh");
    expect(rendered.match(/Browser prompt received during refresh/g)).toHaveLength(1);
    expect(rendered).toContain("History completed");
    expect(rendered.indexOf("Browser prompt received during refresh")).toBeLessThan(
      rendered.indexOf("History completed"),
    );
  });

  it("does not restore deleted history while recovering an in-flight authoritative live user", async () => {
    const deferredHistory = createDeferred<unknown>();
    const chatLog = new ChatLog();
    chatLog.addUser("Deleted prompt from an earlier branch", {
      messageId: "deleted-history-user",
    });
    const state = createBaseState({ currentSessionId: "session-main" });
    const { loadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn(() => deferredHistory.promise),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    const loading = loadHistory();
    persistLiveUser(state, {
      text: "Browser prompt received during refresh",
      messageId: "live-user",
      messageSeq: 3,
      runId: "live-run",
    });
    deferredHistory.resolve({
      sessionId: "session-main",
      sessionInfo: { key: "agent:main:main", sessionId: "session-main" },
      messages: [
        {
          role: "user",
          content: "Current branch prompt",
          __openclaw: { id: "current-history-user", seq: 2 },
        },
        {
          role: "assistant",
          content: "Current branch reply",
          __openclaw: { id: "current-assistant", seq: 4 },
        },
      ],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = chatLog.render(120).join("\n");
    expect(rendered).not.toContain("Deleted prompt from an earlier branch");
    expect(rendered.match(/Browser prompt received during refresh/g)).toHaveLength(1);
    expect(rendered.indexOf("Browser prompt received during refresh")).toBeLessThan(
      rendered.indexOf("Current branch reply"),
    );
  });

  it("deduplicates an authoritative live user already included in same-session history", async () => {
    const deferredHistory = createDeferred<unknown>();
    const chatLog = new ChatLog();
    const state = createBaseState({ currentSessionId: "session-main" });
    const { loadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn(() => deferredHistory.promise),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    const loading = loadHistory();
    persistLiveUser(state, {
      text: "Persisted browser prompt",
      messageId: "shared-user-2",
      messageSeq: 1,
      runId: "shared-run-2",
    });
    deferredHistory.resolve({
      sessionId: "session-main",
      sessionInfo: { key: "agent:main:main", sessionId: "session-main" },
      messages: [
        {
          role: "user",
          content: "Persisted browser prompt",
          __openclaw: { id: "shared-user-2", seq: 1 },
        },
        {
          role: "assistant",
          content: "Persisted reply",
          __openclaw: { id: "shared-assistant-2", seq: 2 },
        },
      ],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = chatLog.render(120).join("\n");
    expect(rendered.match(/Persisted browser prompt/g)).toHaveLength(1);
    expect(rendered).toContain("Persisted reply");
  });

  it("preserves distinct imported live users through a stale history snapshot", async () => {
    const deferredHistory = createDeferred<unknown>();
    const chatLog = new ChatLog();
    const state = createBaseState({ currentSessionId: "session-main" });
    const { loadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn(() => deferredHistory.promise),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    const loading = loadHistory();
    for (const [index, cliSessionId] of ["first-cli-session", "second-cli-session"].entries()) {
      reduceTuiSessionProjection(state, {
        type: "messagePersisted",
        message: {
          role: "user",
          content: `Imported live prompt ${index + 1}`,
          __openclaw: {
            id: "shared-provider-id",
            importedFrom: "claude-cli",
            cliSessionId,
            externalId: "shared-provider-id",
            seq: index + 1,
          },
        },
        scope: readTuiSessionProjectionScope(state),
      });
    }
    deferredHistory.resolve({
      sessionId: "session-main",
      sessionInfo: { key: "agent:main:main", sessionId: "session-main" },
      messages: [
        {
          role: "assistant",
          content: "Current branch reply",
          __openclaw: { id: "imported-live-reply", seq: 3 },
        },
      ],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = chatLog.render(120).join("\n");
    expect(rendered.match(/Imported live prompt 1/g)).toHaveLength(1);
    expect(rendered.match(/Imported live prompt 2/g)).toHaveLength(1);
    expect(rendered).toContain("Current branch reply");
  });

  it("keeps native and separately imported users with the same provider-local ID distinct", async () => {
    const chatLog = new ChatLog();
    const state = createBaseState({ currentSessionId: "session-main" });
    const sharedId = "provider-local-user";
    const { loadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn().mockResolvedValue({
          sessionId: "session-main",
          sessionInfo: { key: "agent:main:main", sessionId: "session-main" },
          messages: [
            {
              role: "user",
              content: "Native canonical prompt",
              __openclaw: { id: sharedId, seq: 1 },
            },
            {
              role: "user",
              content: "First imported prompt",
              __openclaw: {
                id: sharedId,
                importedFrom: "claude-cli",
                cliSessionId: "first-cli-session",
                externalId: sharedId,
                seq: 2,
              },
            },
            {
              role: "user",
              content: "Second imported prompt",
              __openclaw: {
                id: sharedId,
                importedFrom: "claude-cli",
                cliSessionId: "second-cli-session",
                externalId: sharedId,
                seq: 3,
              },
            },
            {
              role: "user",
              content: "First partially imported prompt",
              __openclaw: {
                id: sharedId,
                importedFrom: "claude-cli",
                externalId: sharedId,
                seq: 4,
              },
            },
            {
              role: "user",
              content: "Second partially imported prompt",
              __openclaw: {
                id: sharedId,
                importedFrom: "claude-cli",
                externalId: sharedId,
                seq: 5,
              },
            },
          ],
        }),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    await expect(loadHistory()).resolves.toMatchObject({ loaded: true });

    const rendered = chatLog.render(120).join("\n");
    expect(rendered.match(/Native canonical prompt/g)).toHaveLength(1);
    expect(rendered.match(/First imported prompt/g)).toHaveLength(1);
    expect(rendered.match(/Second imported prompt/g)).toHaveLength(1);
    expect(rendered.match(/First partially imported prompt/g)).toHaveLength(1);
    expect(rendered.match(/Second partially imported prompt/g)).toHaveLength(1);
  });

  it("preserves new-session live users without leaking the previous session during a switch", async () => {
    const deferredHistory = createDeferred<unknown>();
    const chatLog = new ChatLog();
    const state = createBaseState({ currentSessionId: "session-main" });
    persistLiveUser(state, {
      text: "Private prompt from previous session",
      messageId: "previous-user",
      runId: "previous-run",
    });
    const { setSession } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn(() => deferredHistory.promise),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    const switching = setSession("agent:main:other");
    persistLiveUser(state, {
      text: "Browser prompt in selected session",
      messageId: "other-user",
      messageSeq: 1,
      runId: "other-run",
    });
    deferredHistory.resolve({
      sessionId: "session-other",
      sessionInfo: { key: "agent:main:other", sessionId: "session-other" },
      messages: [
        {
          role: "assistant",
          content: "Other session reply",
          __openclaw: { id: "other-assistant", seq: 2 },
        },
      ],
    });

    await switching;
    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("Browser prompt in selected session");
    expect(rendered.match(/Browser prompt in selected session/g)).toHaveLength(1);
    expect(rendered).toContain("Other session reply");
    expect(rendered.indexOf("Browser prompt in selected session")).toBeLessThan(
      rendered.indexOf("Other session reply"),
    );
    expect(rendered).not.toContain("Private prompt from previous session");
  });

  it("keeps a recovered authoritative user ahead of its reply at full scrollback", async () => {
    const deferredHistory = createDeferred<unknown>();
    const chatLog = new ChatLog(20);
    const state = createBaseState({ currentSessionId: "session-main" });
    const { loadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn(() => deferredHistory.promise),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    const loading = loadHistory();
    persistLiveUser(state, {
      text: "Browser prompt at the scrollback limit",
      messageId: "scrollback-user",
      messageSeq: 19,
      runId: "scrollback-run",
    });
    deferredHistory.resolve({
      sessionId: "session-main",
      sessionInfo: { key: "agent:main:main", sessionId: "session-main" },
      messages: [
        ...Array.from({ length: 18 }, (_, index) => ({
          role: "user",
          content: `Earlier history ${index + 1}`,
          __openclaw: { id: `history-user-${index + 1}`, seq: index + 1 },
        })),
        {
          role: "assistant",
          content: "Reply at the scrollback limit",
          __openclaw: { id: "scrollback-assistant", seq: 20 },
        },
      ],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = chatLog.render(120).join("\n");
    expect(rendered.match(/Browser prompt at the scrollback limit/g)).toHaveLength(1);
    expect(rendered.indexOf("Browser prompt at the scrollback limit")).toBeLessThan(
      rendered.indexOf("Reply at the scrollback limit"),
    );
    expect(chatLog.children).toHaveLength(20);
  });

  it("discards old live users when a same-key history response rotates the session id", async () => {
    const deferredHistory = createDeferred<unknown>();
    const chatLog = new ChatLog();
    const state = createBaseState({ currentSessionId: "session-before-reset" });
    const { loadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn(() => deferredHistory.promise),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    const loading = loadHistory();
    persistLiveUser(state, {
      text: "Private prompt from before reset",
      messageId: "before-reset-user",
      runId: "before-reset-run",
    });
    deferredHistory.resolve({
      sessionId: "session-after-reset",
      sessionInfo: { key: "agent:main:main", sessionId: "session-after-reset" },
      messages: [{ role: "assistant", content: "Fresh session reply" }],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("Fresh session reply");
    expect(rendered).not.toContain("Private prompt from before reset");
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

  it("retires the previous session run before adopting and finalizing a restored run", async () => {
    vi.useFakeTimers();
    try {
      const previousSessionKey = "agent:main:previous";
      const nextSessionKey = "agent:main:next";
      const previousRunId = "run-previous";
      const nextRunId = "run-next";
      const state = createBaseState({
        currentSessionKey: previousSessionKey,
        currentSessionId: "session-previous",
        historyLoaded: true,
      });
      const chatLog = new ChatLog();
      const addPendingSystem = vi.spyOn(chatLog, "addPendingSystem");
      const tui = { requestRender: vi.fn() } as unknown as import("@earendil-works/pi-tui").TUI;
      const setActivityStatus = vi.fn((status: string) => {
        state.activityStatus = status;
      });
      let loadSelectedHistory: () => Promise<TuiHistoryLoadResult> = async () => ({
        loaded: false,
      });
      const handlers = createEventHandlers({
        chatLog,
        btw: createBtwPresenter(),
        tui,
        state,
        setActivityStatus,
        loadHistory: () => loadSelectedHistory(),
        streamingWatchdogMs: 100,
      });
      handlers.handleChatEvent({
        runId: previousRunId,
        sessionKey: previousSessionKey,
        seq: 1,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "old partial" }] },
      });
      expect(state.activeChatRunId).toBe(previousRunId);

      const actions = createTestSessionActions({
        client: {
          listSessions: vi.fn(),
          loadHistory: vi.fn().mockResolvedValue({
            sessionId: "session-next",
            sessionInfo: {
              key: nextSessionKey,
              sessionId: "session-next",
              updatedAt: 1,
            },
            messages: [],
            inFlightRun: { runId: nextRunId, text: "new partial" },
          }),
        } as unknown as TuiBackend,
        chatLog,
        state,
        tui,
        setActivityStatus,
        invalidateRunOwnership: handlers.dispose,
      });
      loadSelectedHistory = actions.loadHistory;

      await actions.setSession(nextSessionKey);
      expect(state.activeChatRunId).toBe(nextRunId);

      handlers.handleChatEvent({
        runId: nextRunId,
        sessionKey: nextSessionKey,
        seq: 2,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "new final" }] },
      });

      expect(state.activeChatRunId).toBeNull();
      expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
      vi.advanceTimersByTime(101);
      expect(addPendingSystem).not.toHaveBeenCalled();
      handlers.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves run ownership when reloading the same session selection", async () => {
    const sessionKey = "agent:main:main";
    const invalidateRunOwnership = vi.fn();
    const state = createBaseState({ currentSessionKey: sessionKey });
    const { setSession } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn().mockResolvedValue({
          sessionId: "session-main",
          sessionInfo: { key: sessionKey, sessionId: "session-main" },
          messages: [],
        }),
      } as unknown as TuiBackend,
      state,
      invalidateRunOwnership,
    });

    await setSession(sessionKey);

    expect(invalidateRunOwnership).not.toHaveBeenCalled();
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

  it("replaces session-scoped modes when switching to a session without overrides", async () => {
    const state = createBaseState({
      currentSessionKey: "agent:main:source",
      sessionInfo: {
        fastMode: true,
        verboseLevel: "full",
        traceLevel: "raw",
        reasoningLevel: "stream",
      },
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionInfo: {
        key: "agent:main:target",
        sessionId: "session-target",
      },
      messages: [],
    });
    const { setSession } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      state,
    });

    await setSession("agent:main:target");

    expect(state.sessionInfo).toMatchObject({
      fastMode: undefined,
      verboseLevel: undefined,
      traceLevel: undefined,
      reasoningLevel: undefined,
    });
  });

  it("merges a same-session mode patch without clearing untouched modes", () => {
    const state = createBaseState({
      sessionInfo: {
        fastMode: true,
        verboseLevel: "full",
        traceLevel: "off",
        reasoningLevel: "stream",
      },
    });
    const { applySessionInfoFromPatch } = createTestSessionActions({ state });

    applySessionInfoFromPatch({
      ok: true,
      path: "/sessions/patch",
      key: "agent:main:main",
      entry: { traceLevel: "raw" },
    });

    expect(state.sessionInfo).toMatchObject({
      fastMode: true,
      verboseLevel: "full",
      traceLevel: "raw",
      reasoningLevel: "stream",
    });
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
      resolveSessionSelection: vi.fn((raw?: string) => ({
        key: raw ?? "agent:main:main",
        agentId: "main",
      })),
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

  it("adopts a reset mutation's replacement key without reloading gateway history", () => {
    const loadHistory = vi.fn().mockResolvedValue({ messages: [] });
    const addSystem = vi.fn();
    const clearAll = vi.fn();
    const state = createBaseState({
      currentSessionKey: "old",
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

  it("fences pre-reset history and session-info reads when reset commits", async () => {
    const history = createDeferred<unknown>();
    const sessionInfo = createDeferred<unknown>();
    const loadHistory = vi.fn(() => history.promise);
    const listSessions = vi.fn(() => sessionInfo.promise);
    const { chatLog, addUser, clearAll } = createHistoryChatLog();
    const state = createBaseState({
      currentSessionId: "session-before-reset",
      sessionGeneration: 4,
      sessionInfo: { model: "model-before-reset", updatedAt: 10 },
    });
    const {
      applySessionMutationResult,
      loadHistory: readHistory,
      refreshSessionInfo,
    } = createTestSessionActions({
      client: { loadHistory, listSessions } as unknown as TuiBackend,
      chatLog,
      state,
    });

    const staleHistory = readHistory();
    const staleSessionInfo = refreshSessionInfo();
    await vi.waitFor(() => {
      expect(loadHistory).toHaveBeenCalledOnce();
      expect(listSessions).toHaveBeenCalledOnce();
    });

    expect(
      applySessionMutationResult({
        ok: true,
        key: "agent:main:main",
        entry: {
          sessionId: "session-after-reset",
          model: "model-after-reset",
          updatedAt: 20,
        },
      }),
    ).toBe(true);

    history.resolve({
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "session-before-reset",
        model: "stale-history-model",
        updatedAt: 10,
      },
      messages: [{ role: "user", content: "before reset" }],
    });
    sessionInfo.resolve({
      defaults: {},
      sessions: [
        {
          key: "agent:main:main",
          sessionId: "session-before-reset",
          model: "stale-session-info-model",
          updatedAt: 10,
        },
      ],
    });

    await expect(staleHistory).resolves.toEqual({ loaded: false });
    await staleSessionInfo;

    expect(state.sessionGeneration).toBe(5);
    expect(state.currentSessionId).toBe("session-after-reset");
    expect(state.sessionInfo.model).toBe("model-after-reset");
    expect(addUser).not.toHaveBeenCalled();
    expect(clearAll).toHaveBeenCalledOnce();
  });

  it("does not clear the selected session for another session's reset result", () => {
    const addSystem = vi.fn();
    const clearAll = vi.fn();
    const updateHeader = vi.fn();
    const state = createBaseState({
      currentSessionKey: "agent:main:current",
      currentSessionId: "current-session",
      historyLoaded: true,
      sessionInfo: { model: "current-model", modelProvider: "openai" },
    });
    const { applySessionMutationResult } = createTestSessionActions({
      chatLog: { addSystem, clearAll } as unknown as ChatLog,
      state,
      updateHeader,
    });

    const applied = applySessionMutationResult(
      {
        ok: true,
        key: "agent:main:previous",
        entry: {
          sessionId: "stale-reset-session",
          model: "stale-model",
          modelProvider: "anthropic",
        },
      },
      { sessionKey: "agent:main:previous", agentId: "main" },
    );

    expect(applied).toBe(false);
    expect(state.currentSessionKey).toBe("agent:main:current");
    expect(state.currentSessionId).toBe("current-session");
    expect(state.sessionInfo.model).toBe("current-model");
    expect(state.historyLoaded).toBe(true);
    expect(clearAll).not.toHaveBeenCalled();
    expect(addSystem).not.toHaveBeenCalled();
    expect(updateHeader).not.toHaveBeenCalled();
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
      resolveSessionSelection: vi.fn((raw?: string) => ({
        key: raw ?? "agent:main:main",
        agentId: "main",
      })),
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

  it.each([
    {
      name: "successful abort after a session switch",
      initialKey: "agent:main:first",
      nextKey: "agent:main:second",
      aborted: true,
      rejected: false,
    },
    {
      name: "no-active-run abort after a session switch",
      initialKey: "agent:main:first",
      nextKey: "agent:main:second",
      aborted: false,
      rejected: false,
    },
    {
      name: "rejected abort after a session switch",
      initialKey: "agent:main:first",
      nextKey: "agent:main:second",
      aborted: false,
      rejected: true,
    },
    {
      name: "successful global abort after an agent switch",
      initialKey: "global",
      nextKey: "global",
      aborted: true,
      rejected: false,
    },
    {
      name: "no-active-run global abort after an agent switch",
      initialKey: "global",
      nextKey: "global",
      aborted: false,
      rejected: false,
    },
    {
      name: "rejected global abort after an agent switch",
      initialKey: "global",
      nextKey: "global",
      aborted: false,
      rejected: true,
    },
  ])("ignores a $name", async ({ initialKey, nextKey, aborted, rejected }) => {
    const deferred = createDeferred<Awaited<ReturnType<TuiBackend["abortChat"]>>>();
    const abortChat = vi.fn(() => deferred.promise);
    const loadHistory = vi.fn().mockResolvedValue({
      sessionInfo: {
        key: nextKey,
        sessionId: "second-session",
        model: "current-model",
      },
      messages: [],
    });
    const { chatLog, addSystem } = createHistoryChatLog();
    const dropPendingUser = vi.fn();
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      currentSessionKey: initialKey,
      currentAgentId: "main",
      activeChatRunId: "first-active-run",
      pendingSubmit: acceptedSubmit("first-pending-run"),
    });
    const { abortActive, setSession } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory, abortChat } as unknown as TuiBackend,
      chatLog: Object.assign(chatLog, { dropPendingUser }),
      state,
      setActivityStatus,
      resolveSessionSelection: vi.fn((raw?: string) => ({
        key: raw ?? state.currentSessionKey,
        agentId: state.currentAgentId,
      })),
    });

    const pendingAbort = abortActive();
    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: initialKey,
      ...(initialKey === "global" ? { agentId: "main" } : {}),
    });
    if (initialKey === "global") {
      state.currentAgentId = "work";
    }
    await setSession(nextKey);
    state.activeChatRunId = "second-active-run";
    state.pendingSubmit = acceptedSubmit("second-pending-run", "second draft");
    addSystem.mockClear();
    setActivityStatus.mockClear();

    if (rejected) {
      deferred.reject(new Error("stale session abort"));
    } else {
      deferred.resolve({
        ok: true,
        aborted,
        runIds: ["first-active-run", "first-pending-run"],
      });
    }
    await pendingAbort;

    expect(state.currentSessionKey).toBe(nextKey);
    expect(state.currentAgentId).toBe(initialKey === "global" ? "work" : "main");
    expect(state.currentSessionId).toBe("second-session");
    expect(state.activeChatRunId).toBe("second-active-run");
    expect(getPendingSubmitAcceptedRunId(state)).toBe("second-pending-run");
    expect(getPendingSubmitDraft(state)).toEqual({
      runId: "second-pending-run",
      text: "second draft",
    });
    expect(dropPendingUser).not.toHaveBeenCalled();
    expect(addSystem).not.toHaveBeenCalled();
    expect(setActivityStatus).not.toHaveBeenCalled();
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
      addPendingUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      clearAll: vi.fn(),
      clearPendingUsers: vi.fn(),
    };
    const state = createBaseState({ currentSessionId: "session-main" });
    sendPendingUser(state, "optimistic-run", "optimistic prompt");

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as TuiBackend,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    const result = await runLoadHistory();

    expect(chatLog.clearAll).toHaveBeenCalledWith();
    expect(chatLog.addUser).toHaveBeenCalledWith("persisted");
    expect(chatLog.addPendingUser).toHaveBeenCalledWith("optimistic-run", "optimistic prompt");
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("reply");
    expect(result).toEqual({ loaded: true, inFlightRunId: null });
  });

  it("restores attachment-only assistant rows from history without exposing references", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      messages: [
        { role: "assistant", content: [{ type: "image", data: "secret-image" }] },
        {
          role: "assistant",
          content: [{ type: "audio", source: { type: "url", url: "file:///private/audio.mp3" } }],
        },
        { role: "assistant", content: [{ type: "video", url: "file:///private/video.mp4" }] },
        { role: "assistant", content: [{ type: "file", url: "file:///etc/passwd" }] },
      ],
    });
    const chatLog = {
      addSystem: vi.fn(),
      finalizeAssistant: vi.fn(),
      clearAll: vi.fn(),
    };

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
    });

    await runLoadHistory();

    expect(chatLog.finalizeAssistant.mock.calls.map(([text]) => text)).toEqual([
      "Attached image",
      "Attached audio",
      "Attached video",
      "Attached file",
    ]);
  });

  it("releases a pending submit when reconnect history proves it was accepted", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      messages: [
        {
          role: "user",
          content: "persisted",
          timestamp: 2_000,
          __openclaw: {
            id: "accepted-user",
            idempotencyKey: "run-pending:user",
            seq: 1,
          },
        },
      ],
    });
    const chatLog = {
      addSystem: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      clearAll: vi.fn(),
    };
    const state = createBaseState({
      pendingSubmit: acceptedSubmit("run-pending", "persisted"),
    });
    sendPendingUser(state, "run-pending", "persisted");

    const { loadHistory: runLoadHistory } = createTestSessionActions({
      client: { listSessions: vi.fn(), loadHistory } as unknown as TuiBackend,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
      state,
    });

    await runLoadHistory();

    expect(state.pendingSubmit).toBeNull();
  });

  it("releases a pending submit only when its canonical persisted run appears in history", async () => {
    const chatLog = new ChatLog(40);
    const state = createBaseState({
      currentSessionId: "session-main",
      pendingSubmit: acceptedSubmit("run-pending", "persisted"),
    });
    sendPendingUser(state, "run-pending", "persisted");
    const { loadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn().mockResolvedValue({
          sessionId: "session-main",
          sessionInfo: { key: "agent:main:main", sessionId: "session-main" },
          messages: [
            {
              role: "user",
              content: "persisted",
              __openclaw: {
                id: "persisted-pending-user",
                idempotencyKey: "run-pending:user",
                seq: 1,
              },
            },
          ],
        }),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    await expect(loadHistory()).resolves.toMatchObject({ loaded: true });

    expect(state.pendingSubmit).toBeNull();
    expect(chatLog.countPendingUsers()).toBe(0);
    expect(
      chatLog
        .render(120)
        .join("\n")
        .match(/persisted/g),
    ).toHaveLength(1);
  });

  it("preserves a pending submit when another client persists the identical prompt", async () => {
    const chatLog = new ChatLog(40);
    const state = createBaseState({
      currentSessionId: "session-main",
      pendingSubmit: acceptedSubmit("local-run", "continue"),
    });
    sendPendingUser(state, "local-run", "continue");
    const { loadHistory } = createTestSessionActions({
      client: {
        listSessions: vi.fn(),
        loadHistory: vi.fn().mockResolvedValue({
          sessionId: "session-main",
          sessionInfo: { key: "agent:main:main", sessionId: "session-main" },
          messages: [
            {
              role: "user",
              content: "continue",
              timestamp: Date.now(),
              __openclaw: {
                id: "remote-user",
                idempotencyKey: "remote-client-run:user",
                seq: 1,
              },
            },
          ],
        }),
      } as unknown as TuiBackend,
      chatLog,
      state,
    });

    await expect(loadHistory()).resolves.toMatchObject({ loaded: true });

    expect(getPendingSubmitAcceptedRunId(state)).toBe("local-run");
    expect(chatLog.countPendingUsers()).toBe(1);
    expect(
      chatLog
        .render(120)
        .join("\n")
        .match(/continue/g),
    ).toHaveLength(2);
  });

  it("keeps a pending submit when reconnect history has not accepted it", async () => {
    const loadHistory = vi.fn().mockResolvedValue({ sessionId: "session-main", messages: [] });
    const chatLog = {
      addSystem: vi.fn(),
      addUser: vi.fn(),
      addPendingUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      clearAll: vi.fn(),
    };
    const state = createBaseState({
      pendingSubmit: acceptedSubmit("run-pending", "not persisted"),
    });
    sendPendingUser(state, "run-pending", "not persisted");

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
