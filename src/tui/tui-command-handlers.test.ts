import { describe, expect, it, vi } from "vitest";
import { createCommandHandlers } from "./tui-command-handlers.js";
import {
  TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
  TUI_SESSION_PICKER_LIMIT,
} from "./tui-session-list-policy.js";

type LoadHistoryMock = ReturnType<typeof vi.fn> & (() => Promise<void>);
type RunAuthFlow = NonNullable<Parameters<typeof createCommandHandlers>[0]["runAuthFlow"]>;
type AbortActiveMock = ReturnType<typeof vi.fn> &
  ((params?: { preferActive?: boolean }) => Promise<void>);
type SelectableOverlay = {
  items?: Array<{ value: string; label?: string; description?: string }>;
  onSelect?: (item: { value: string; label?: string; description?: string }) => void;
};
type SetActivityStatusMock = ReturnType<typeof vi.fn> & ((text: string) => void);
type SetSessionMock = ReturnType<typeof vi.fn> & ((key: string) => Promise<void>);
type SetEmptySessionMock = ReturnType<typeof vi.fn> & ((key: string) => Promise<void>);
type ConsumeCompletedRunMock = ReturnType<typeof vi.fn> & ((runId: string) => boolean);
type FlushPendingHistoryRefreshMock = ReturnType<typeof vi.fn> & (() => void);

async function flushAsyncSelect() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function expectSendChatFields(
  sendChat: ReturnType<typeof vi.fn>,
  expected: { message: string; agentId?: string; sessionId?: string; sessionKey?: string },
) {
  const calls = sendChat.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected gateway sendChat call");
  }
  const payload = call[0] as {
    message?: unknown;
    agentId?: unknown;
    sessionId?: unknown;
    sessionKey?: unknown;
  };
  expect(payload.message).toBe(expected.message);
  if (expected.agentId !== undefined) {
    expect(payload.agentId).toBe(expected.agentId);
  }
  if (expected.sessionId !== undefined) {
    expect(payload.sessionId).toBe(expected.sessionId);
  }
  if (expected.sessionKey !== undefined) {
    expect(payload.sessionKey).toBe(expected.sessionKey);
  }
}

type MockWithCalls = { mock: { calls: unknown[][] } };

function firstMockArg(mock: MockWithCalls, label: string) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function createHarness(params?: {
  sendChat?: ReturnType<typeof vi.fn>;
  getGatewayStatus?: ReturnType<typeof vi.fn>;
  listSessions?: ReturnType<typeof vi.fn>;
  listModels?: ReturnType<typeof vi.fn>;
  patchSession?: ReturnType<typeof vi.fn>;
  resetSession?: ReturnType<typeof vi.fn>;
  runGoalCommand?: ReturnType<typeof vi.fn>;
  runAuthFlow?: RunAuthFlow;
  setSession?: SetSessionMock;
  setEmptySession?: SetEmptySessionMock;
  loadHistory?: LoadHistoryMock;
  refreshSessionInfo?: ReturnType<typeof vi.fn>;
  applySessionInfoFromPatch?: ReturnType<typeof vi.fn>;
  applySessionMutationResult?: ReturnType<typeof vi.fn>;
  setActivityStatus?: SetActivityStatusMock;
  isConnected?: boolean;
  activeChatRunId?: string | null;
  pendingOptimisticUserMessage?: boolean;
  pendingChatRunId?: string | null;
  activityStatus?: string;
  opts?: { local?: boolean };
  currentSessionId?: string | null;
  currentAgentId?: string;
  currentSessionKey?: string;
  abortActive?: AbortActiveMock;
  consumeCompletedRunForPendingSend?: ConsumeCompletedRunMock;
  flushPendingHistoryRefreshIfIdle?: FlushPendingHistoryRefreshMock;
}) {
  const sendChat = params?.sendChat ?? vi.fn().mockResolvedValue({ runId: "r1" });
  const getGatewayStatus = params?.getGatewayStatus ?? vi.fn().mockResolvedValue({});
  const listSessions = params?.listSessions ?? vi.fn().mockResolvedValue({ sessions: [] });
  const listModels = params?.listModels ?? vi.fn().mockResolvedValue([]);
  const patchSession = params?.patchSession ?? vi.fn().mockResolvedValue({});
  const resetSession = params?.resetSession ?? vi.fn().mockResolvedValue({ ok: true });
  const runGoalCommand = params?.runGoalCommand ?? vi.fn().mockResolvedValue({ text: "Goal" });
  const setSession = params?.setSession ?? (vi.fn().mockResolvedValue(undefined) as SetSessionMock);
  const setEmptySession =
    params?.setEmptySession ?? (vi.fn().mockResolvedValue(undefined) as SetEmptySessionMock);
  const addUser = vi.fn();
  const addSystem = vi.fn();
  const clearTools = vi.fn();
  const reserveAssistantSlot = vi.fn();
  const requestRender = vi.fn();
  const noteLocalRunId = vi.fn();
  const noteLocalBtwRunId = vi.fn();
  const loadHistory =
    params?.loadHistory ?? (vi.fn().mockResolvedValue(undefined) as LoadHistoryMock);
  const refreshSessionInfo = params?.refreshSessionInfo ?? vi.fn().mockResolvedValue(undefined);
  const applySessionInfoFromPatch = params?.applySessionInfoFromPatch ?? vi.fn();
  const applySessionMutationResult = params?.applySessionMutationResult ?? vi.fn();
  const setActivityStatus = params?.setActivityStatus ?? (vi.fn() as SetActivityStatusMock);
  const forgetLocalRunId = vi.fn();
  const openOverlay = vi.fn();
  const closeOverlay = vi.fn();
  const requestExit = vi.fn();
  const abortActive =
    params?.abortActive ?? (vi.fn().mockResolvedValue(undefined) as AbortActiveMock);
  const runAuthFlow: RunAuthFlow | undefined =
    params?.runAuthFlow ??
    (params?.opts?.local
      ? (vi.fn().mockResolvedValue({ exitCode: 0, signal: null }) as unknown as RunAuthFlow)
      : undefined);
  const state = {
    currentAgentId: params?.currentAgentId ?? "main",
    currentSessionKey: params?.currentSessionKey ?? "agent:main:main",
    currentSessionId: params?.currentSessionId ?? null,
    activeChatRunId: params?.activeChatRunId ?? null,
    pendingOptimisticUserMessage: params?.pendingOptimisticUserMessage ?? false,
    pendingChatRunId: params?.pendingChatRunId ?? null,
    activityStatus: params?.activityStatus ?? "idle",
    isConnected: params?.isConnected ?? true,
    sessionInfo: {},
  };

  const { handleCommand, openSessionSelector } = createCommandHandlers({
    client: {
      sendChat,
      getGatewayStatus,
      listSessions,
      listModels,
      patchSession,
      resetSession,
      runGoalCommand,
    } as never,
    chatLog: { addUser, addSystem, clearTools, reserveAssistantSlot } as never,
    tui: { requestRender } as never,
    opts: params?.opts ?? {},
    state: state as never,
    deliverDefault: false,
    openOverlay,
    closeOverlay,
    refreshSessionInfo: refreshSessionInfo as never,
    loadHistory,
    setSession,
    setEmptySession,
    refreshAgents: vi.fn(),
    abortActive,
    setActivityStatus,
    formatSessionKey: vi.fn(),
    applySessionInfoFromPatch: applySessionInfoFromPatch as never,
    applySessionMutationResult: applySessionMutationResult as never,
    noteLocalRunId,
    noteLocalBtwRunId,
    forgetLocalRunId,
    forgetLocalBtwRunId: vi.fn(),
    consumeCompletedRunForPendingSend: params?.consumeCompletedRunForPendingSend,
    flushPendingHistoryRefreshIfIdle: params?.flushPendingHistoryRefreshIfIdle,
    runAuthFlow,
    requestExit,
  });

  return {
    handleCommand,
    getGatewayStatus,
    listSessions,
    listModels,
    sendChat,
    openSessionSelector,
    openOverlay,
    closeOverlay,
    patchSession,
    resetSession,
    runGoalCommand,
    setSession,
    setEmptySession,
    addUser,
    addSystem,
    clearTools,
    reserveAssistantSlot,
    requestRender,
    loadHistory,
    refreshSessionInfo,
    applySessionInfoFromPatch,
    applySessionMutationResult,
    runAuthFlow,
    setActivityStatus,
    noteLocalRunId,
    noteLocalBtwRunId,
    forgetLocalRunId,
    requestExit,
    abortActive,
    state,
  };
}

describe("tui command handlers", () => {
  it("bounds session picker hydration to recent TUI sessions", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          key: "agent:main:main",
          displayName: "main",
          updatedAt: Date.now(),
        },
      ],
    });
    const { openSessionSelector } = createHarness({ listSessions });

    await openSessionSelector();

    expect(listSessions).toHaveBeenCalledWith({
      limit: TUI_SESSION_PICKER_LIMIT,
      activeMinutes: TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: true,
      includeLastMessage: true,
      agentId: "main",
    });
  });

  it("renders the sending indicator before chat.send resolves", async () => {
    let resolveSend: (value: { runId: string }) => void = () => {
      throw new Error("sendChat promise resolver was not initialized");
    };
    const sendPromise = new Promise<{ runId: string }>((resolve) => {
      resolveSend = (value) => resolve(value);
    });
    const sendChat = vi.fn(() => sendPromise);
    const setActivityStatus = vi.fn();

    const { handleCommand, requestRender } = createHarness({
      sendChat,
      setActivityStatus,
    });

    const pending = handleCommand("/context detail");
    await Promise.resolve();

    expect(setActivityStatus).toHaveBeenCalledWith("sending");
    const sendingOrder = setActivityStatus.mock.invocationCallOrder[0] ?? 0;
    const renderOrders = requestRender.mock.invocationCallOrder;
    expect(renderOrders.filter((order) => order > sendingOrder)).not.toEqual([]);

    resolveSend({ runId: "r1" });
    await pending;
    expect(setActivityStatus).toHaveBeenCalledWith("waiting");
  });

  it("forwards unknown slash commands to the gateway", async () => {
    const { handleCommand, sendChat, addUser, addSystem, requestRender } = createHarness();

    await handleCommand("/unregistered-command");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenCalledWith("/unregistered-command");
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/unregistered-command",
    });
    expect(requestRender).toHaveBeenCalled();
  });

  it("passes the current backing session id when sending to the gateway", async () => {
    const { handleCommand, sendChat } = createHarness({
      currentSessionId: "session-before-relaunch",
    });

    await handleCommand("/status");

    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      sessionId: "session-before-relaunch",
      message: "/status",
    });
  });

  it("starts local goals and sends the objective to the model", async () => {
    const runGoalCommand = vi.fn().mockResolvedValue({ text: "Goal started: ship" });
    const { handleCommand, sendChat, addSystem, refreshSessionInfo, addUser } = createHarness({
      opts: { local: true },
      runGoalCommand,
    });

    await handleCommand("/goal start ship");

    expect(runGoalCommand).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
      command: "/goal start ship",
    });
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "ship",
    });
    expect(addUser).toHaveBeenCalledWith("ship");
    expect(addSystem).toHaveBeenCalledWith("Goal started: ship");
    expect(refreshSessionInfo).toHaveBeenCalled();
  });

  it("wraps command-prefixed local goal objectives before sending", async () => {
    const slashRunGoalCommand = vi.fn().mockResolvedValue({ text: "Goal started" });
    const slashHarness = createHarness({
      opts: { local: true },
      runGoalCommand: slashRunGoalCommand,
    });

    await slashHarness.handleCommand("/goal start /status");
    const slashPrompt = `Pursue this goal exactly as written from this JSON string: "\\/status"`;
    expectSendChatFields(slashHarness.sendChat, {
      sessionKey: "agent:main:main",
      message: slashPrompt,
    });
    expect(slashHarness.addUser).toHaveBeenCalledWith(slashPrompt);

    const bangRunGoalCommand = vi.fn().mockResolvedValue({ text: "Goal started" });
    const bangHarness = createHarness({
      opts: { local: true },
      runGoalCommand: bangRunGoalCommand,
    });

    await bangHarness.handleCommand("/goal start !npm test");
    const bangPrompt = `Pursue this goal exactly as written from this JSON string: "!npm test"`;
    expectSendChatFields(bangHarness.sendChat, {
      sessionKey: "agent:main:main",
      message: bangPrompt,
    });
    expect(bangHarness.addUser).toHaveBeenCalledWith(bangPrompt);
  });

  it("keeps local goal status as a control command", async () => {
    const runGoalCommand = vi.fn().mockResolvedValue({ text: "Goal: ship" });
    const { handleCommand, sendChat, addSystem } = createHarness({
      opts: { local: true },
      runGoalCommand,
    });

    await handleCommand("/goal status");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("Goal: ship");
  });

  it("wraps command-prefixed local goal resume notes before sending", async () => {
    const runGoalCommand = vi.fn().mockResolvedValue({ text: "Goal resumed: ship" });
    const { handleCommand, sendChat, addUser } = createHarness({
      opts: { local: true },
      runGoalCommand,
    });

    await handleCommand("/goal resume /fast off");

    const prompt = `Continue pursuing the current goal. Interpret this JSON string as the resume note: "\\/fast off"`;
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: prompt,
    });
    expect(addUser).toHaveBeenCalledWith(prompt);
  });

  it("passes the selected agent for local global goal commands", async () => {
    const runGoalCommand = vi.fn().mockResolvedValue({ text: "Goal started: ship" });
    const { handleCommand } = createHarness({
      opts: { local: true },
      currentAgentId: "work",
      currentSessionKey: "global",
      runGoalCommand,
    });

    await handleCommand("/goal start ship");

    expect(runGoalCommand).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "work",
      command: "/goal start ship",
    });
  });

  it("passes the selected agent when sending global chat", async () => {
    const { handleCommand, sendChat } = createHarness({
      currentAgentId: "work",
      currentSessionKey: "global",
    });

    await handleCommand("hello");

    expectSendChatFields(sendChat, {
      sessionKey: "global",
      agentId: "work",
      message: "hello",
    });
  });

  it("forwards goal commands to the gateway outside local mode", async () => {
    const { handleCommand, sendChat, runGoalCommand } = createHarness();

    await handleCommand("/goal status");

    expect(runGoalCommand).not.toHaveBeenCalled();
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/goal status",
    });
  });

  it("opens a context mode selector for /context without sending immediately", async () => {
    const { handleCommand, sendChat, openOverlay } = createHarness();

    await handleCommand("/context");

    expect(sendChat).not.toHaveBeenCalled();
    expect(openOverlay).toHaveBeenCalledTimes(1);
  });

  it("sends the selected context mode through the gateway command path", async () => {
    const { handleCommand, sendChat, openOverlay, closeOverlay } = createHarness();

    await handleCommand("/context");
    const selector = firstMockArg(openOverlay, "openOverlay") as SelectableOverlay;
    selector?.onSelect?.({ value: "detail", label: "detail" });
    await flushAsyncSelect();

    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/context detail",
    });
    expect(closeOverlay).toHaveBeenCalledTimes(1);
  });

  it("forwards /context list directly", async () => {
    const { handleCommand, sendChat, openOverlay } = createHarness();

    await handleCommand("/context list");

    expect(openOverlay).not.toHaveBeenCalled();
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/context list",
    });
  });

  it("forwards /context help directly", async () => {
    const { handleCommand, sendChat, openOverlay } = createHarness();

    await handleCommand("/context help");

    expect(openOverlay).not.toHaveBeenCalled();
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/context help",
    });
  });

  it("forwards /status to the shared gateway command path", async () => {
    const { handleCommand, sendChat, addUser, addSystem } = createHarness();

    await handleCommand("/status");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenCalledWith("/status");
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/status",
    });
  });

  it("keeps gateway diagnostics on /gateway-status", async () => {
    const { handleCommand, getGatewayStatus, addSystem, addUser, sendChat } = createHarness({
      getGatewayStatus: vi.fn().mockResolvedValue({
        runtimeVersion: "1.2.3",
        sessions: { count: 2, defaults: { model: "gpt-5.4", contextTokens: 200000 } },
      }),
    });

    await handleCommand("/gateway-status");

    expect(getGatewayStatus).toHaveBeenCalledTimes(1);
    expect(addUser).not.toHaveBeenCalled();
    expect(sendChat).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("Gateway status");
    expect(addSystem).toHaveBeenCalledWith("Version: 1.2.3");
  });

  it("returns to Crestodian with an optional request", async () => {
    const { handleCommand, addSystem, requestExit, sendChat } = createHarness();

    await handleCommand("/crestodian restart gateway");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("returning to Crestodian with request: restart gateway");
    expect(requestExit).toHaveBeenCalledWith({
      exitReason: "return-to-crestodian",
      crestodianMessage: "restart gateway",
    });
  });

  it("handles /exit without sending through the gateway", async () => {
    const { handleCommand, requestExit, sendChat, addUser, addSystem } = createHarness();

    await handleCommand("/exit");

    expect(requestExit).toHaveBeenCalledTimes(1);
    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).not.toHaveBeenCalled();
  });

  it("leaves a Crestodian breadcrumb after switching agents", async () => {
    const { handleCommand, addSystem, setSession, state } = createHarness();

    await handleCommand("/agent Work");

    expect(state.currentAgentId).toBe("work");
    expect(setSession).toHaveBeenCalledWith("");
    expect(addSystem).toHaveBeenCalledWith("agent set to work; use /crestodian to return");
  });

  it("marks the generated runId as local before gateway events arrive", async () => {
    const { handleCommand, sendChat, noteLocalRunId, state } = createHarness();

    await handleCommand("/context detail");

    const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(noteLocalRunId).toHaveBeenCalledWith(sentRunId);
    expect(state.activeChatRunId).toBeNull();
    expect(state.pendingOptimisticUserMessage).toBe(true);
  });

  it("tracks the in-flight runId so escape can abort during the wait", async () => {
    const sendChat = vi.fn().mockImplementation(async (opts: { runId: string }) => ({
      runId: opts.runId,
    }));
    const { handleCommand, state } = createHarness({ sendChat });

    await handleCommand("hello");

    const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(typeof sentRunId).toBe("string");
    expect(sentRunId.length).toBeGreaterThan(0);
    expect(state.activeChatRunId).toBeNull();
    expect(state.pendingChatRunId).toBe(sentRunId);
  });

  it("does not reintroduce the pending runId when an early event already consumed it", async () => {
    const sendChat = vi.fn();
    const { handleCommand, state } = createHarness({ sendChat });
    sendChat.mockImplementation(async (opts: { runId: string }) => {
      state.pendingOptimisticUserMessage = false;
      return { runId: opts.runId };
    });

    await handleCommand("hello");

    expect(state.pendingChatRunId).toBeNull();
    expect(state.pendingOptimisticUserMessage).toBe(false);
  });

  it("tracks the backend-accepted runId when it differs from the generated runId", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "run-accepted" });
    const { handleCommand, state, noteLocalRunId, forgetLocalRunId } = createHarness({ sendChat });

    await handleCommand("hello");

    const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(state.pendingChatRunId).toBe("run-accepted");
    expect(forgetLocalRunId).toHaveBeenCalledWith(sentRunId);
    expect(noteLocalRunId).toHaveBeenCalledWith("run-accepted");
  });

  it("does not reintroduce a backend-accepted runId after an early terminal event", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "run-accepted" });
    const consumeCompletedRunForPendingSend = vi.fn((runId: string) => runId === "run-accepted");
    const flushPendingHistoryRefreshIfIdle = vi.fn();
    const { handleCommand, state, noteLocalRunId, forgetLocalRunId, setActivityStatus } =
      createHarness({
        sendChat,
        consumeCompletedRunForPendingSend,
        flushPendingHistoryRefreshIfIdle,
      });

    await handleCommand("hello");

    const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(consumeCompletedRunForPendingSend).toHaveBeenCalledWith("run-accepted");
    expect(forgetLocalRunId).toHaveBeenCalledWith(sentRunId);
    expect(noteLocalRunId).not.toHaveBeenCalledWith("run-accepted");
    expect(state.pendingChatRunId).toBeNull();
    expect(state.pendingOptimisticUserMessage).toBe(false);
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(flushPendingHistoryRefreshIfIdle).toHaveBeenCalledTimes(1);
  });

  it("clears the pending runId if sendChat fails", async () => {
    const sendChat = vi.fn().mockRejectedValue(new Error("boom"));
    const { handleCommand, state } = createHarness({ sendChat });

    await handleCommand("hello");

    expect(state.pendingChatRunId).toBeNull();
    expect(state.pendingOptimisticUserMessage).toBe(false);
  });

  it("sends /btw without hijacking the active main run", async () => {
    const setActivityStatus = vi.fn();
    const { handleCommand, sendChat, addUser, noteLocalRunId, noteLocalBtwRunId, state } =
      createHarness({
        activeChatRunId: "run-main",
        setActivityStatus,
      });

    await handleCommand("/btw what changed?");

    expect(addUser).not.toHaveBeenCalled();
    expect(noteLocalRunId).not.toHaveBeenCalled();
    expect(noteLocalBtwRunId).toHaveBeenCalledTimes(1);
    expect(state.activeChatRunId).toBe("run-main");
    expect(setActivityStatus).not.toHaveBeenCalledWith("sending");
    expect(setActivityStatus).not.toHaveBeenCalledWith("waiting");
    expectSendChatFields(sendChat, { message: "/btw what changed?" });
  });

  it("sends /side without hijacking the active main run", async () => {
    const { handleCommand, sendChat, addUser, noteLocalRunId, noteLocalBtwRunId, state } =
      createHarness({
        activeChatRunId: "run-main",
      });

    await handleCommand("/side what changed?");

    expect(addUser).not.toHaveBeenCalled();
    expect(noteLocalRunId).not.toHaveBeenCalled();
    expect(noteLocalBtwRunId).toHaveBeenCalledTimes(1);
    expect(state.activeChatRunId).toBe("run-main");
    expectSendChatFields(sendChat, { message: "/side what changed?" });
  });

  it("creates unique session for /new and resets shared session for /reset", async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const setSessionMock = vi.fn().mockResolvedValue(undefined) as SetSessionMock;
    const setEmptySessionMock = vi.fn().mockResolvedValue(undefined) as SetEmptySessionMock;
    const applySessionMutationResult = vi.fn().mockReturnValue(true);
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const resetResult = {
      ok: true as const,
      key: "agent:main:main",
      entry: { sessionId: "reset-session" },
    };
    const { handleCommand, resetSession } = createHarness({
      loadHistory,
      setSession: setSessionMock,
      setEmptySession: setEmptySessionMock,
      applySessionMutationResult,
      refreshSessionInfo,
      resetSession: vi.fn().mockResolvedValue(resetResult),
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    // /new creates a unique session key (isolates TUI client) (#39217)
    expect(setSessionMock).not.toHaveBeenCalled();
    expect(setEmptySessionMock).toHaveBeenCalledTimes(1);
    const newSessionKey = firstMockArg(setEmptySessionMock, "setEmptySession") as
      | string
      | undefined;
    if (!newSessionKey) {
      throw new Error("expected /new to set a TUI session key");
    }
    expect(newSessionKey.startsWith("tui-")).toBe(true);
    const uuidParts: string[] = newSessionKey.slice("tui-".length).split("-");
    expect(uuidParts.map((part) => part.length)).toEqual([8, 4, 4, 4, 12]);
    expect(uuidParts.every((part) => /^[0-9a-f]+$/.test(part))).toBe(true);
    // /reset still resets the shared session
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(resetSession).toHaveBeenCalledWith("agent:main:main", "reset", undefined);
    expect(applySessionMutationResult).toHaveBeenCalledWith(resetResult);
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("reloads history after /reset when the backend does not return a session entry", async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const applySessionMutationResult = vi.fn().mockReturnValue(false);
    const { handleCommand } = createHarness({
      loadHistory,
      applySessionMutationResult,
      resetSession: vi.fn().mockResolvedValue({ ok: true }),
    });

    await handleCommand("/reset");

    expect(applySessionMutationResult).toHaveBeenCalledWith({ ok: true });
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("scopes /reset for the selected global agent", async () => {
    const { handleCommand, resetSession } = createHarness({
      currentSessionKey: "global",
      currentAgentId: "work",
    });

    await handleCommand("/reset");

    expect(resetSession).toHaveBeenCalledWith("global", "reset", { agentId: "work" });
  });

  it("scopes selected global session patches to the selected agent", async () => {
    const patchSession = vi.fn().mockResolvedValue({ fastMode: true });
    const { handleCommand } = createHarness({
      currentSessionKey: "global",
      currentAgentId: "work",
      patchSession,
    });

    await handleCommand("/fast on");

    expect(patchSession).toHaveBeenCalledWith({
      key: "global",
      agentId: "work",
      fastMode: true,
    });
  });

  it("hides tools locally for /verbose off without reloading history", async () => {
    const patchResult = { entry: { verboseLevel: "off" } };
    const patchSession = vi.fn().mockResolvedValue(patchResult);
    const applySessionInfoFromPatch = vi.fn();
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const { handleCommand, clearTools } = createHarness({
      patchSession,
      applySessionInfoFromPatch,
      loadHistory,
      refreshSessionInfo,
    });

    await handleCommand("/verbose off");

    expect(patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      verboseLevel: "off",
    });
    expect(applySessionInfoFromPatch).toHaveBeenCalledWith(patchResult);
    expect(clearTools).toHaveBeenCalledTimes(1);
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("reloads history for /verbose on so prior tool output becomes visible", async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const { handleCommand, clearTools } = createHarness({
      loadHistory,
      refreshSessionInfo,
    });

    await handleCommand("/verbose on");

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(refreshSessionInfo).not.toHaveBeenCalled();
    expect(clearTools).not.toHaveBeenCalled();
  });

  it("refreshes session info for /trace without reloading history", async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const { handleCommand } = createHarness({
      loadHistory,
      refreshSessionInfo,
    });

    await handleCommand("/trace on");

    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("reports send failures and marks activity status as error", async () => {
    const setActivityStatus = vi.fn();
    const { handleCommand, addSystem, state } = createHarness({
      sendChat: vi.fn().mockRejectedValue(new Error("gateway down")),
      setActivityStatus,
    });

    await handleCommand("/context detail");

    expect(addSystem).toHaveBeenCalledWith("send failed: Error: gateway down");
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
    expect(state.pendingOptimisticUserMessage).toBe(false);
  });

  it("sanitizes control sequences in /new and /reset failures", async () => {
    const setEmptySession = vi.fn().mockRejectedValue(new Error("\u001b[31mboom\u001b[0m"));
    const resetSession = vi.fn().mockRejectedValue(new Error("\u001b[31mboom\u001b[0m"));
    const { handleCommand, addSystem } = createHarness({
      setEmptySession,
      resetSession,
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    expect(addSystem).toHaveBeenNthCalledWith(1, "new session failed: Error: boom");
    expect(addSystem).toHaveBeenNthCalledWith(2, "reset failed: Error: boom");
  });

  it("reports disconnected status and skips gateway send when offline", async () => {
    const { handleCommand, sendChat, addUser, addSystem, setActivityStatus } = createHarness({
      isConnected: false,
    });

    await handleCommand("/context detail");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("not connected to gateway — message not sent");
    expect(setActivityStatus).toHaveBeenLastCalledWith("disconnected");
  });

  it("sends local prompts while a run is active so queue policy can handle them", async () => {
    const {
      handleCommand,
      sendChat,
      addUser,
      addSystem,
      reserveAssistantSlot,
      requestRender,
      state,
    } = createHarness({
      opts: { local: true },
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("/context detail");

    expect(sendChat).toHaveBeenCalledTimes(1);
    expectSendChatFields(sendChat, {
      message: "/context detail",
      sessionKey: "agent:main:main",
    });
    expect(reserveAssistantSlot).toHaveBeenCalledWith("run-active");
    const reserveCallOrder = reserveAssistantSlot.mock.invocationCallOrder[0];
    const addUserCallOrder = addUser.mock.invocationCallOrder[0];
    expect(reserveCallOrder).toBeLessThan(addUserCallOrder);
    expect(addUser).toHaveBeenCalledWith("/context detail");
    expect(addSystem).not.toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
    expect(requestRender).toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
    expect(state.pendingChatRunId).toEqual(expect.any(String));
  });

  it("blocks gateway slash prompts while a run is active", async () => {
    const { handleCommand, sendChat, addUser, addSystem } = createHarness({
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("/context detail");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
  });

  it("routes slash stop to the abort path instead of queueing a chat send", async () => {
    const abortActive = vi.fn().mockResolvedValue(undefined);
    const { handleCommand, sendChat, addUser } = createHarness({
      activeChatRunId: "run-active",
      activityStatus: "streaming",
      abortActive,
    });

    await handleCommand("/stop");

    expect(abortActive).toHaveBeenCalledWith({ preferActive: true });
    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
  });

  it("sends slash stop to the backend when there is no tracked run", async () => {
    const abortActive = vi.fn().mockResolvedValue(undefined);
    const { handleCommand, sendChat, addUser } = createHarness({ abortActive });

    await handleCommand("/stop");

    expect(abortActive).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledTimes(1);
    expectSendChatFields(sendChat, {
      message: "/stop",
      sessionKey: "agent:main:main",
    });
    expect(addUser).toHaveBeenCalledWith("/stop");
  });

  it("sends broad stop-like text as a normal prompt when idle", async () => {
    const abortActive = vi.fn().mockResolvedValue(undefined);
    const { handleCommand, sendChat, addUser } = createHarness({ abortActive });

    await handleCommand("do not do that");

    expect(abortActive).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(addUser).toHaveBeenCalledWith("do not do that");
  });

  it("rejects normal sends while a queued submit is pending registration", async () => {
    const { handleCommand, sendChat, addUser, addSystem } = createHarness({
      activeChatRunId: "run-active",
      pendingChatRunId: "run-queued",
      activityStatus: "waiting",
    });

    await handleCommand("/context detail");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
  });

  it("allows local sends to queue while the current run is finishing", async () => {
    const { handleCommand, sendChat, addUser, addSystem } = createHarness({
      opts: { local: true },
      activeChatRunId: "run-active",
      activityStatus: "finishing context",
    });

    await handleCommand("/context detail");

    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(addUser).toHaveBeenCalledWith("/context detail");
    expect(addSystem).not.toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
  });

  it("blocks gateway sends while the current run is finishing", async () => {
    const { handleCommand, sendChat, addUser, addSystem } = createHarness({
      activeChatRunId: "run-active",
      activityStatus: "finishing context",
    });

    await handleCommand("/context detail");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
  });

  it("runs /auth through the local auth flow and refreshes session info", async () => {
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const runAuthFlow = vi.fn().mockResolvedValue({ exitCode: 0, signal: null });
    const { handleCommand, addSystem, setActivityStatus } = createHarness({
      opts: { local: true },
      refreshSessionInfo,
      runAuthFlow,
    });

    await handleCommand("/auth openai");

    expect(runAuthFlow).toHaveBeenCalledWith({ provider: "openai" });
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
    expect(addSystem).toHaveBeenCalledWith(
      "opening auth flow for openai; TUI will resume when it exits",
    );
    expect(addSystem).toHaveBeenCalledWith("auth flow finished for openai");
    expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
  });

  it("rejects /auth in non-local mode", async () => {
    const { handleCommand, addSystem } = createHarness();

    await handleCommand("/auth");

    expect(addSystem).toHaveBeenCalledWith("auth login is only available in local embedded mode");
  });

  it("blocks /auth while an optimistic run is still pending", async () => {
    const runAuthFlow = vi.fn().mockResolvedValue({ exitCode: 0, signal: null });
    const { handleCommand, addSystem } = createHarness({
      opts: { local: true },
      pendingOptimisticUserMessage: true,
      runAuthFlow,
    });

    await handleCommand("/auth openai");

    expect(runAuthFlow).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("abort the current run before /auth");
  });

  it("rejects invalid /activation values before patching the session", async () => {
    const { handleCommand, patchSession, addSystem } = createHarness();

    await handleCommand("/activation sometimes");

    expect(patchSession).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("usage: /activation <mention|always>");
  });

  it("patches the session for valid /activation values", async () => {
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const applySessionInfoFromPatch = vi.fn();
    const patchSession = vi.fn().mockResolvedValue({ groupActivation: "always" });
    const { handleCommand, addSystem } = createHarness({
      patchSession,
      refreshSessionInfo,
      applySessionInfoFromPatch,
    });

    await handleCommand("/activation always");

    expect(patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      groupActivation: "always",
    });
    expect(addSystem).toHaveBeenCalledWith("activation set to always");
    expect(applySessionInfoFromPatch).toHaveBeenCalledWith({ groupActivation: "always" });
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
  });

  it("uses canonical model refs in the model selector", async () => {
    const listModels = vi.fn().mockResolvedValue([
      {
        provider: "openrouter",
        id: "openrouter/auto",
        name: "OpenRouter Auto",
      },
    ]);
    const patchSession = vi.fn().mockResolvedValue({ model: "openrouter/auto" });
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const applySessionInfoFromPatch = vi.fn();
    const { handleCommand, openOverlay, closeOverlay } = createHarness({
      listModels,
      patchSession,
      refreshSessionInfo,
      applySessionInfoFromPatch,
    });

    await handleCommand("/model");

    const selector = firstMockArg(openOverlay, "openOverlay") as SelectableOverlay;
    expect(selector?.items?.[0]?.value).toBe("openrouter/auto");
    expect(selector?.items?.[0]?.label).toBe("openrouter/auto");

    selector?.onSelect?.({ value: "openrouter/auto", label: "openrouter/auto" });
    await flushAsyncSelect();

    expect(patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      model: "openrouter/auto",
    });
    expect(applySessionInfoFromPatch).toHaveBeenCalledWith({ model: "openrouter/auto" });
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
    expect(closeOverlay).toHaveBeenCalledTimes(1);
  });
});
