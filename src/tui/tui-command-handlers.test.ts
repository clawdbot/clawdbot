// Covers TUI slash command handlers and backend call wiring.

import type { OverlayHandle } from "@earendil-works/pi-tui";
import { expectDefined } from "@openclaw/normalization-core";
import type { Result } from "@openclaw/normalization-core/result";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionProjection,
  type SessionProjectionState,
} from "../../packages/gateway-client/src/session-projection.js";
import { createCommandHandlers } from "./tui-command-handlers.js";
import {
  TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
  TUI_SESSION_PICKER_LIMIT,
} from "./tui-session-list-policy.js";
import {
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import {
  getPendingSubmitAcceptedRunId,
  getPendingSubmitDraft,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";
import type { SessionInfo } from "./tui-types.js";

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
type ConsumeCompletedRunMock = ReturnType<typeof vi.fn> & ((runId: string) => boolean);
type FlushPendingHistoryRefreshMock = ReturnType<typeof vi.fn> & (() => void);
type RefreshAgentsMock = ReturnType<typeof vi.fn> & (() => Promise<Result<void, string>>);

function createOverlayHandle(): OverlayHandle {
  return {
    hide: vi.fn(),
    setHidden: vi.fn(),
    isHidden: vi.fn(() => false),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => true),
  };
}

async function flushAsyncSelect() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  createSession?: ReturnType<typeof vi.fn>;
  resetSession?: ReturnType<typeof vi.fn>;
  runGoalCommand?: ReturnType<typeof vi.fn>;
  runAuthFlow?: RunAuthFlow;
  setSession?: SetSessionMock;
  loadHistory?: LoadHistoryMock;
  refreshSessionInfo?: ReturnType<typeof vi.fn>;
  applySessionInfoFromPatch?: ReturnType<typeof vi.fn>;
  applySessionMutationResult?: ReturnType<typeof vi.fn>;
  setActivityStatus?: SetActivityStatusMock;
  isConnected?: boolean;
  activeChatRunId?: string | null;
  pendingSubmit?: TuiPendingSubmit | null;
  activityStatus?: string;
  opts?: { local?: boolean };
  currentSessionId?: string | null;
  sessionGeneration?: number;
  currentAgentId?: string;
  currentSessionKey?: string;
  sessionProjection?: SessionProjectionState;
  sessionInfo?: SessionInfo;
  abortActive?: AbortActiveMock;
  consumeCompletedRunForPendingSend?: ConsumeCompletedRunMock;
  isRunObserved?: (runId: string) => boolean;
  flushPendingHistoryRefreshIfIdle?: FlushPendingHistoryRefreshMock;
  refreshAgents?: RefreshAgentsMock;
  agentDefaultId?: string;
  agents?: Array<{ id: string; kind?: "agent" | "system"; name?: string }>;
}) {
  const sendChat =
    params?.sendChat ??
    vi.fn().mockImplementation(async (opts: { runId?: string }) => ({ runId: opts.runId ?? "r1" }));
  const getGatewayStatus = params?.getGatewayStatus ?? vi.fn().mockResolvedValue({});
  const listSessions = params?.listSessions ?? vi.fn().mockResolvedValue({ sessions: [] });
  const listModels = params?.listModels ?? vi.fn().mockResolvedValue([]);
  const patchSession = params?.patchSession ?? vi.fn().mockResolvedValue({});
  const createSession =
    params?.createSession ??
    vi.fn().mockImplementation(async (opts: { key: string }) => ({
      ok: true,
      key: `agent:main:${opts.key}`,
    }));
  const resetSession = params?.resetSession ?? vi.fn().mockResolvedValue({ ok: true });
  const runGoalCommand = params?.runGoalCommand ?? vi.fn().mockResolvedValue({ text: "Goal" });
  const setSession = params?.setSession ?? (vi.fn().mockResolvedValue(undefined) as SetSessionMock);
  const addUser = vi.fn();
  const addPendingUser = vi.fn();
  const dropPendingUser = vi.fn();
  const rekeyPendingUser = vi.fn();
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
  const forgetLocalBtwRunId = vi.fn();
  const overlayHandle = createOverlayHandle();
  const openOverlay = vi.fn(() => overlayHandle);
  const closeOverlay = vi.fn();
  const requestExit = vi.fn();
  const abortActive =
    params?.abortActive ?? (vi.fn().mockResolvedValue(undefined) as AbortActiveMock);
  const refreshAgents =
    params?.refreshAgents ??
    (vi.fn().mockResolvedValue({ ok: true, value: undefined }) as RefreshAgentsMock);
  const runAuthFlow: RunAuthFlow | undefined =
    params?.runAuthFlow ??
    (params?.opts?.local
      ? (vi.fn().mockResolvedValue({ exitCode: 0, signal: null }) as unknown as RunAuthFlow)
      : undefined);
  const state = {
    agentDefaultId: params?.agentDefaultId ?? "main",
    agents: params?.agents ?? [],
    currentAgentId: params?.currentAgentId ?? "main",
    currentSessionKey: params?.currentSessionKey ?? "agent:main:main",
    currentSessionId: params?.currentSessionId ?? null,
    sessionGeneration: params?.sessionGeneration ?? 0,
    sessionProjection: params?.sessionProjection,
    activeChatRunId: params?.activeChatRunId ?? null,
    pendingSubmit: params?.pendingSubmit ?? null,
    activityStatus: params?.activityStatus ?? "idle",
    isConnected: params?.isConnected ?? true,
    sessionInfo: params?.sessionInfo ?? {},
  };

  const { handleCommand, sendMessage, openSessionSelector } = createCommandHandlers({
    client: {
      sendChat,
      getGatewayStatus,
      listSessions,
      listModels,
      patchSession,
      createSession,
      resetSession,
      runGoalCommand,
    } as never,
    chatLog: {
      addUser,
      addPendingUser,
      dropPendingUser,
      rekeyPendingUser,
      addSystem,
      clearTools,
      reserveAssistantSlot,
    } as never,
    tui: { requestRender } as never,
    opts: params?.opts ?? {},
    state: state as never,
    deliverDefault: false,
    openOverlay,
    closeOverlay,
    refreshSessionInfo: refreshSessionInfo as never,
    loadHistory,
    setSession,
    refreshAgents,
    abortActive,
    setActivityStatus,
    formatSessionKey: vi.fn(),
    applySessionInfoFromPatch: applySessionInfoFromPatch as never,
    applySessionMutationResult: applySessionMutationResult as never,
    noteLocalRunId,
    noteLocalBtwRunId,
    forgetLocalRunId,
    forgetLocalBtwRunId,
    consumeCompletedRunForPendingSend: params?.consumeCompletedRunForPendingSend,
    isRunObserved: params?.isRunObserved,
    flushPendingHistoryRefreshIfIdle: params?.flushPendingHistoryRefreshIfIdle,
    runAuthFlow,
    requestExit,
  });

  return {
    handleCommand,
    sendMessage,
    getGatewayStatus,
    listSessions,
    listModels,
    sendChat,
    openSessionSelector,
    openOverlay,
    overlayHandle,
    closeOverlay,
    patchSession,
    createSession,
    resetSession,
    runGoalCommand,
    setSession,
    addUser,
    addPendingUser,
    dropPendingUser,
    rekeyPendingUser,
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
    forgetLocalBtwRunId,
    requestExit,
    abortActive,
    refreshAgents,
    state,
  };
}

describe("tui command handlers", () => {
  it("does not open the agent picker from a cached roster after refresh failure", async () => {
    const refreshAgents = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "gateway unavailable" }) as RefreshAgentsMock;
    const { handleCommand, openOverlay, requestRender } = createHarness({
      refreshAgents,
      agents: [{ id: "cached", name: "Cached Agent" }],
    });

    await handleCommand("/agents");

    expect(refreshAgents).toHaveBeenCalledTimes(1);
    expect(openOverlay).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalled();
  });

  it("opens the agent picker only after a successful refresh", async () => {
    const refreshAgents = vi
      .fn()
      .mockResolvedValue({ ok: true, value: undefined }) as RefreshAgentsMock;
    const { handleCommand, openOverlay } = createHarness({
      refreshAgents,
      agentDefaultId: "team-lead",
      agents: [
        { id: "team-lead", name: "Lead Agent" },
        { id: "system-agent", kind: "system", name: "System Agent" },
      ],
    });

    await handleCommand("/agents");

    expect(refreshAgents).toHaveBeenCalledTimes(1);
    expect(openOverlay).toHaveBeenCalledTimes(1);
    const selector = firstMockArg(openOverlay, "openOverlay") as SelectableOverlay;
    expect(selector.items).toEqual([
      {
        value: "team-lead",
        label: "team-lead (Lead Agent)",
        description: "default",
      },
    ]);
  });

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
    const { handleCommand, sendChat, addPendingUser, addSystem, requestRender } = createHarness();

    await handleCommand("/unregistered-command");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "/unregistered-command");
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/unregistered-command",
    });
    expect(requestRender).toHaveBeenCalled();
  });

  it("projects the canonical pending user before chat.send is acknowledged", async () => {
    const deferred = createDeferred<{ runId: string }>();
    const sendChat = vi.fn(() => deferred.promise);
    const harness = createHarness({ sendChat });

    const sending = harness.handleCommand("hello");
    const provisionalRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;

    expect(harness.state.sessionProjection?.scope).toEqual({
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(harness.state.sessionProjection?.entries).toEqual([
      expect.objectContaining({
        pending: true,
        pendingRunId: provisionalRunId,
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          __openclaw: { idempotencyKey: `${provisionalRunId}:user` },
        },
      }),
    ]);

    deferred.resolve({ runId: provisionalRunId });
    await sending;
  });

  it("re-keys the optimistic pending row to the gateway-accepted runId in place", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r-accepted" });
    const harness = createHarness({ sendChat });

    await harness.handleCommand("hello");

    const localRunId = harness.addPendingUser.mock.calls[0]?.[0];
    expect(localRunId).toEqual(expect.any(String));
    expect(localRunId).not.toBe("r-accepted");
    // Re-key happens in place (no drop/re-add) so the row keeps its position.
    expect(harness.rekeyPendingUser).toHaveBeenCalledWith(localRunId, "r-accepted");
    expect(harness.addPendingUser).toHaveBeenCalledTimes(1);
    expect(harness.dropPendingUser).not.toHaveBeenCalled();
    expect(harness.state.sessionProjection?.entries).toEqual([
      expect.objectContaining({
        pending: true,
        pendingRunId: "r-accepted",
        message: expect.objectContaining({
          role: "user",
          __openclaw: { idempotencyKey: `${localRunId}:user` },
        }),
      }),
    ]);
    expect(getPendingSubmitDraft(harness.state)).toEqual({
      runId: "r-accepted",
      text: "hello",
    });
  });

  it("retires only the provisional viewport when a persisted turn arrives before its ACK", async () => {
    const deferred = createDeferred<{ runId: string }>();
    const sendChat = vi.fn(() => deferred.promise);
    const harness = createHarness({ sendChat });
    const sending = harness.handleCommand("hello");
    const provisionalRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    const acceptedMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      __openclaw: {
        id: "accepted-user",
        seq: 1,
        idempotencyKey: "accepted-run:user",
      },
    };
    const sameTextPeer = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      __openclaw: {
        id: "peer-user",
        seq: 2,
        idempotencyKey: "peer-run:user",
      },
    };
    for (const message of [acceptedMessage, sameTextPeer]) {
      reduceTuiSessionProjection(harness.state as never, {
        type: "messagePersisted",
        message,
        scope: readTuiSessionProjectionScope(harness.state),
      });
    }

    deferred.resolve({ runId: "accepted-run" });
    await sending;

    expect(harness.state.sessionProjection?.messages).toEqual([acceptedMessage, sameTextPeer]);
    expect(harness.state.sessionProjection?.entries.every((entry) => !entry.pending)).toBe(true);
    expect(harness.dropPendingUser).toHaveBeenCalledExactlyOnceWith(provisionalRunId);
    expect(harness.rekeyPendingUser).not.toHaveBeenCalled();
    expect(harness.noteLocalRunId).toHaveBeenCalledWith("accepted-run");
    expect(getPendingSubmitAcceptedRunId(harness.state)).toBe("accepted-run");
  });

  it("does not re-arm the submit draft when the accepted run already emitted events", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r-accepted" });
    const isRunObserved = vi.fn((runId: string) => runId === "r-accepted");
    const harness = createHarness({ sendChat, isRunObserved });

    await harness.handleCommand("hello");

    // The accepted run already registered, so the draft must not be re-armed —
    // otherwise a later abort would drop a row whose reply already rendered.
    expect(harness.rekeyPendingUser).toHaveBeenCalledWith(expect.any(String), "r-accepted");
    expect(getPendingSubmitDraft(harness.state)).toBeNull();
  });

  it("clears the submit draft when the accepted run already completed", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r-accepted" });
    const consumeCompletedRunForPendingSend = vi
      .fn()
      .mockReturnValue(true) as ConsumeCompletedRunMock;
    const harness = createHarness({ sendChat, consumeCompletedRunForPendingSend });

    await harness.handleCommand("hello");

    expect(harness.addPendingUser).toHaveBeenCalledTimes(1);
    expect(harness.dropPendingUser).not.toHaveBeenCalled();
    expect(harness.state.pendingSubmit).toBeNull();
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

  it.each(["/status", "/compact", "/commands", "/context", "/context detail"])(
    "keeps unsupported shared command %s out of local model prompts",
    async (command) => {
      const { handleCommand, sendChat, addPendingUser, addSystem } = createHarness({
        opts: { local: true },
      });

      await handleCommand(command);

      expect(sendChat).not.toHaveBeenCalled();
      expect(addPendingUser).not.toHaveBeenCalled();
      expect(addSystem).toHaveBeenCalledWith(
        expect.stringMatching(/not available in local embedded mode; message not sent$/),
      );
    },
  );

  it("preserves local side prompts and unknown slash text", async () => {
    const emptySide = createHarness({ opts: { local: true } });
    await emptySide.handleCommand("/side");
    expect(emptySide.sendChat).not.toHaveBeenCalled();
    expect(emptySide.addSystem).toHaveBeenCalledWith("Usage: /btw [side question]");

    const side = createHarness({ opts: { local: true } });
    await side.handleCommand("/side check this");
    expectSendChatFields(side.sendChat, {
      sessionKey: "agent:main:main",
      message: "/side check this",
    });

    const unknown = createHarness({ opts: { local: true } });
    await unknown.handleCommand("/not-a-real-command");
    expectSendChatFields(unknown.sendChat, {
      sessionKey: "agent:main:main",
      message: "/not-a-real-command",
    });
  });

  it("starts local goals and sends the objective to the model", async () => {
    const runGoalCommand = vi.fn().mockResolvedValue({ text: "Goal started: ship" });
    const { handleCommand, sendChat, addSystem, refreshSessionInfo, addPendingUser } =
      createHarness({
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
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "ship");
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
    expect(slashHarness.addPendingUser).toHaveBeenCalledWith(expect.any(String), slashPrompt);

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
    expect(bangHarness.addPendingUser).toHaveBeenCalledWith(expect.any(String), bangPrompt);
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
    const { handleCommand, sendChat, addPendingUser } = createHarness({
      opts: { local: true },
      runGoalCommand,
    });

    await handleCommand("/goal resume /fast off");

    const prompt = `Continue pursuing the current goal. Interpret this JSON string as the resume note: "\\/fast off"`;
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: prompt,
    });
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), prompt);
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
    const { handleCommand, sendChat, openOverlay, closeOverlay, overlayHandle } = createHarness();

    await handleCommand("/context");
    const selector = firstMockArg(openOverlay, "openOverlay") as SelectableOverlay;
    selector?.onSelect?.({ value: "detail", label: "detail" });
    await flushAsyncSelect();

    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/context detail",
    });
    expect(closeOverlay).toHaveBeenCalledTimes(1);
    expect(closeOverlay).toHaveBeenCalledWith(overlayHandle);
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
    const { handleCommand, sendChat, addPendingUser, addSystem } = createHarness();

    await handleCommand("/status");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "/status");
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

  it("returns to OpenClaw with an optional request", async () => {
    const { handleCommand, addSystem, requestExit, sendChat } = createHarness();

    await handleCommand("/openclaw restart gateway");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("returning to OpenClaw with request: restart gateway");
    expect(requestExit).toHaveBeenCalledWith({
      exitReason: "return-to-system-agent",
      systemAgentMessage: "restart gateway",
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

  it("leaves a OpenClaw breadcrumb after switching agents", async () => {
    const { handleCommand, addSystem, setSession, state } = createHarness();

    await handleCommand("/agent Work");

    expect(state.currentAgentId).toBe("work");
    expect(setSession).toHaveBeenCalledWith("");
    expect(addSystem).toHaveBeenCalledWith("agent set to work; use /openclaw to return");
  });

  it("marks the generated runId as local before gateway events arrive", async () => {
    const { handleCommand, sendChat, noteLocalRunId, state } = createHarness();

    await handleCommand("/context detail");

    const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(noteLocalRunId).toHaveBeenCalledWith(sentRunId);
    expect(state.activeChatRunId).toBeNull();
    expect(getPendingSubmitAcceptedRunId(state)).toBe(sentRunId);
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
    expect(getPendingSubmitAcceptedRunId(state)).toBe(sentRunId);
  });

  it("does not reintroduce the pending runId when an early event already consumed it", async () => {
    const sendChat = vi.fn();
    const { handleCommand, state } = createHarness({ sendChat });
    sendChat.mockImplementation(async (opts: { runId: string }) => {
      state.pendingSubmit = null;
      return { runId: opts.runId };
    });

    await handleCommand("hello");

    expect(state.pendingSubmit).toBeNull();
  });

  it("tracks the backend-accepted runId when it differs from the generated runId", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "run-accepted" });
    const { handleCommand, state, noteLocalRunId, forgetLocalRunId } = createHarness({ sendChat });

    await handleCommand("hello");

    const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(getPendingSubmitAcceptedRunId(state)).toBe("run-accepted");
    expect(forgetLocalRunId).toHaveBeenCalledWith(sentRunId);
    expect(noteLocalRunId).toHaveBeenCalledWith("run-accepted");
  });

  it("cleans a delayed ACK without mutating the newly selected viewport", async () => {
    const deferred = createDeferred<{ runId: string; status: string }>();
    const harness = createHarness({ sendChat: vi.fn(() => deferred.promise) });
    const sending = harness.handleCommand("old session prompt");
    const provisionalRunId = (firstMockArg(harness.sendChat, "sendChat") as { runId: string })
      .runId;
    const nextProjection = createSessionProjection(
      { sessionKey: "agent:main:second", agentId: "main" },
      [
        {
          role: "user",
          content: [{ type: "text", text: "new session prompt" }],
          __openclaw: { id: "new-user", seq: 1 },
        },
      ],
    );
    harness.state.currentSessionKey = "agent:main:second";
    harness.state.sessionProjection = nextProjection;
    harness.state.activeChatRunId = "new-active";
    harness.state.pendingSubmit = {
      phase: "accepted",
      runId: "new-pending",
      draftText: "new draft",
    };
    harness.state.activityStatus = "streaming";

    deferred.resolve({ runId: "old-accepted", status: "error" });
    await sending;

    expect(harness.state.sessionProjection).toBe(nextProjection);
    expect(harness.state.activeChatRunId).toBe("new-active");
    expect(harness.state.pendingSubmit).toEqual({
      phase: "accepted",
      runId: "new-pending",
      draftText: "new draft",
    });
    expect(harness.loadHistory).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
    expect(harness.setActivityStatus).toHaveBeenCalledExactlyOnceWith("sending");
    expect(harness.forgetLocalRunId).toHaveBeenCalledWith(provisionalRunId);
    expect(harness.forgetLocalRunId).toHaveBeenCalledWith("old-accepted");
  });

  it("ignores a delayed ACK after the selected session is replaced in place", async () => {
    const deferred = createDeferred<{ runId: string; status: string }>();
    const harness = createHarness({
      currentSessionId: "session-old",
      sendChat: vi.fn(() => deferred.promise),
    });
    const sending = harness.handleCommand("old incarnation prompt");
    harness.state.currentSessionId = "session-new";
    harness.state.activeChatRunId = "new-active";
    harness.state.pendingSubmit = {
      phase: "accepted",
      runId: "new-pending",
      draftText: null,
    };

    deferred.resolve({ runId: "old-accepted", status: "error" });
    await sending;

    expect(harness.state.currentSessionId).toBe("session-new");
    expect(harness.state.activeChatRunId).toBe("new-active");
    expect(harness.state.pendingSubmit?.runId).toBe("new-pending");
    expect(harness.loadHistory).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it("allows a first send to bind a previously unknown session incarnation", async () => {
    const deferred = createDeferred<{ runId: string }>();
    const harness = createHarness({
      currentSessionId: null,
      sendChat: vi.fn(() => deferred.promise),
    });
    const sending = harness.handleCommand("first session prompt");
    const provisionalRunId = (firstMockArg(harness.sendChat, "sendChat") as { runId: string })
      .runId;
    harness.state.currentSessionId = "session-created";
    deferred.resolve({ runId: provisionalRunId });

    await sending;

    expect(harness.state.currentSessionId).toBe("session-created");
    expect(getPendingSubmitAcceptedRunId(harness.state)).toEqual(expect.any(String));
  });

  it("rejects a delayed ACK when an unknown session is replaced before binding", async () => {
    const deferred = createDeferred<{ runId: string }>();
    const harness = createHarness({
      currentSessionId: null,
      sessionGeneration: 0,
      sendChat: vi.fn(() => deferred.promise),
    });
    const sending = harness.handleCommand("old unbound prompt");
    harness.state.currentSessionId = "replacement-session";
    harness.state.sessionGeneration = 1;
    harness.state.pendingSubmit = {
      phase: "accepted",
      runId: "replacement-pending",
      draftText: null,
    };
    deferred.resolve({ runId: "old-accepted" });

    await sending;

    expect(harness.state.pendingSubmit?.runId).toBe("replacement-pending");
    expect(harness.loadHistory).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it("accepts a delayed ACK after returning to the exact original session incarnation", async () => {
    const deferred = createDeferred<{ runId: string }>();
    const harness = createHarness({
      currentSessionKey: "agent:main:a",
      currentSessionId: "session-a",
      sessionGeneration: 3,
      sendChat: vi.fn(() => deferred.promise),
    });
    const sending = harness.handleCommand("original prompt");
    const provisionalRunId = (firstMockArg(harness.sendChat, "sendChat") as { runId: string })
      .runId;
    harness.state.currentSessionKey = "agent:main:b";
    harness.state.currentSessionId = "session-b";
    harness.state.currentSessionKey = "agent:main:a";
    harness.state.currentSessionId = "session-a";
    deferred.resolve({ runId: provisionalRunId });

    await sending;

    expect(getPendingSubmitAcceptedRunId(harness.state)).toBe(provisionalRunId);
    expect(harness.setActivityStatus).toHaveBeenLastCalledWith("waiting");
  });

  it("cleans a delayed send rejection without reporting it in a new session", async () => {
    const deferred = createDeferred<never>();
    const harness = createHarness({ sendChat: vi.fn(() => deferred.promise) });
    const sending = harness.handleCommand("old session prompt");
    const provisionalRunId = (firstMockArg(harness.sendChat, "sendChat") as { runId: string })
      .runId;
    const nextProjection = createSessionProjection({
      sessionKey: "agent:work:second",
      agentId: "work",
    });
    harness.state.currentAgentId = "work";
    harness.state.currentSessionKey = "agent:work:second";
    harness.state.sessionProjection = nextProjection;
    harness.state.pendingSubmit = {
      phase: "accepted",
      runId: "new-pending",
      draftText: null,
    };

    deferred.reject(new Error("old gateway failure"));
    await sending;

    expect(harness.state.sessionProjection).toBe(nextProjection);
    expect(harness.state.pendingSubmit?.runId).toBe("new-pending");
    expect(harness.addSystem).not.toHaveBeenCalled();
    expect(harness.dropPendingUser).not.toHaveBeenCalled();
    expect(harness.forgetLocalRunId).toHaveBeenCalledWith(provisionalRunId);
  });

  it("clears optimistic state when chat send returns a terminal timeout ack", async () => {
    const sendChat = vi.fn().mockImplementation(async (opts: { runId: string }) => ({
      runId: opts.runId,
      status: "timeout",
    }));
    const historyReload = { clearSystemMessages: undefined as (() => void) | undefined };
    const loadHistory = vi.fn().mockImplementation(async () => {
      historyReload.clearSystemMessages?.();
    }) as LoadHistoryMock;
    const { handleCommand, state, dropPendingUser, addSystem, setActivityStatus } = createHarness({
      sendChat,
      loadHistory,
    });
    historyReload.clearSystemMessages = () => addSystem.mockClear();

    await handleCommand("hello");

    const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(dropPendingUser).toHaveBeenCalledWith(sentRunId);
    expect(state.pendingSubmit).toBeNull();
    expect(state.sessionProjection?.entries).toEqual([]);
    expect(addSystem).toHaveBeenCalledWith(
      "send failed: Chat failed before the run started; try again.",
    );
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("reports failure when chat send returns a terminal error ack", async () => {
    const sendChat = vi.fn().mockImplementation(async (opts: { runId: string }) => ({
      runId: opts.runId,
      status: "error",
    }));
    const loadHistory = vi.fn().mockResolvedValue(undefined) as LoadHistoryMock;
    const { handleCommand, state, dropPendingUser, addSystem, setActivityStatus } = createHarness({
      sendChat,
      loadHistory,
    });

    await handleCommand("hello");

    const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(dropPendingUser).toHaveBeenCalledWith(sentRunId);
    expect(addSystem).toHaveBeenCalledWith(
      "send failed: Chat failed before the run started; try again.",
    );
    expect(state.pendingSubmit).toBeNull();
    expect(state.sessionProjection?.entries).toEqual([]);
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("removes the accepted canonical pending turn after a re-keyed terminal failure", async () => {
    const sendChat = vi.fn().mockResolvedValue({
      runId: "accepted-failed-run",
      status: "error",
    });
    const harness = createHarness({ sendChat });

    await harness.handleCommand("hello");

    const provisionalRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(harness.rekeyPendingUser).toHaveBeenCalledWith(provisionalRunId, "accepted-failed-run");
    expect(harness.dropPendingUser).toHaveBeenCalledWith("accepted-failed-run");
    expect(harness.state.sessionProjection?.entries).toEqual([]);
    expect(harness.state.pendingSubmit).toBeNull();
  });

  it("refreshes history without waiting when chat send returns a terminal ok ack", async () => {
    const sendChat = vi.fn().mockImplementation(async (opts: { runId: string }) => ({
      runId: opts.runId,
      status: "ok",
    }));
    const loadHistory = vi.fn().mockResolvedValue(undefined) as LoadHistoryMock;
    const { handleCommand, state, dropPendingUser, setActivityStatus } = createHarness({
      sendChat,
      loadHistory,
    });

    await handleCommand("hello");

    expect(dropPendingUser).not.toHaveBeenCalled();
    expect(state.pendingSubmit).toBeNull();
    expect(state.sessionProjection?.entries).toHaveLength(1);
    expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["/btw", "timeout", undefined],
    ["/side", "error", "run-accepted-side-error"],
  ])(
    "clears local BTW tracking and reports failure when %s receives a terminal %s ack",
    async (command, status, acceptedRunId) => {
      const sendChat = vi.fn().mockImplementation(async (opts: { runId: string }) => ({
        runId: acceptedRunId ?? opts.runId,
        status,
      }));
      const {
        handleCommand,
        sendChat: sendChatMock,
        forgetLocalBtwRunId,
        addSystem,
        state,
      } = createHarness({
        sendChat,
        activeChatRunId: "run-main",
      });

      await handleCommand(`${command} check terminal ack`);

      const sentRunId = (firstMockArg(sendChatMock, "sendChat") as { runId: string }).runId;
      expect(forgetLocalBtwRunId).toHaveBeenCalledWith(sentRunId);
      if (acceptedRunId) {
        expect(forgetLocalBtwRunId).toHaveBeenCalledWith(acceptedRunId);
      }
      expect(addSystem).toHaveBeenCalledWith(
        "btw failed: Chat failed before the run started; try again.",
      );
      expect(state.activeChatRunId).toBe("run-main");
      expect(state.pendingSubmit).toBeNull();
    },
  );

  it("clears local BTW tracking when a detached send receives a terminal ok ack", async () => {
    const sendChat = vi.fn().mockImplementation(async () => ({
      runId: "run-accepted-btw",
      status: "ok",
    }));
    const {
      handleCommand,
      sendChat: sendChatMock,
      forgetLocalBtwRunId,
      addSystem,
      state,
    } = createHarness({
      sendChat,
      activeChatRunId: "run-main",
    });

    await handleCommand("/side finish detached");

    const sentRunId = (firstMockArg(sendChatMock, "sendChat") as { runId: string }).runId;
    expect(forgetLocalBtwRunId).toHaveBeenCalledWith(sentRunId);
    expect(forgetLocalBtwRunId).toHaveBeenCalledWith("run-accepted-btw");
    expect(addSystem).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-main");
    expect(state.pendingSubmit).toBeNull();
  });

  it("tracks the backend-accepted runId for a detached non-terminal ack", async () => {
    const sendChat = vi.fn().mockImplementation(async () => ({
      runId: "run-accepted-btw",
      status: "in_flight",
    }));
    const {
      handleCommand,
      sendChat: sendChatMock,
      noteLocalBtwRunId,
      forgetLocalBtwRunId,
      addSystem,
      state,
    } = createHarness({
      sendChat,
      activeChatRunId: "run-main",
    });

    await handleCommand("/btw continue detached");

    const sentRunId = (firstMockArg(sendChatMock, "sendChat") as { runId: string }).runId;
    expect(noteLocalBtwRunId).toHaveBeenCalledWith(sentRunId);
    expect(forgetLocalBtwRunId).toHaveBeenCalledWith(sentRunId);
    expect(noteLocalBtwRunId).toHaveBeenCalledWith("run-accepted-btw");
    expect(addSystem).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-main");
    expect(state.pendingSubmit).toBeNull();
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
    expect(state.pendingSubmit).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(flushPendingHistoryRefreshIfIdle).toHaveBeenCalledTimes(1);
  });

  it("clears the pending runId if sendChat fails", async () => {
    const sendChat = vi.fn().mockRejectedValue(new Error("boom"));
    const {
      handleCommand,
      sendChat: sendChatMock,
      dropPendingUser,
      state,
    } = createHarness({
      sendChat,
    });

    await handleCommand("hello");

    const sentRunId = (firstMockArg(sendChatMock, "sendChat") as { runId: string }).runId;
    expect(dropPendingUser).toHaveBeenCalledWith(sentRunId);
    expect(state.pendingSubmit).toBeNull();
    expect(state.sessionProjection?.entries).toEqual([]);
  });

  it("keeps a same-text persisted peer when the local send fails", async () => {
    const peerMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      __openclaw: {
        id: "peer-user",
        seq: 4,
        idempotencyKey: "peer-run:user",
      },
    };
    const sessionProjection = createSessionProjection(
      { sessionKey: "agent:main:main", agentId: "main" },
      [peerMessage],
    );
    const harness = createHarness({
      sendChat: vi.fn().mockRejectedValue(new Error("local send failed")),
      sessionProjection,
    });

    await harness.handleCommand("hello");

    expect(harness.state.sessionProjection?.messages).toEqual([peerMessage]);
    expect(harness.state.sessionProjection?.entries[0]).toMatchObject({
      pending: false,
      pendingRunId: null,
    });
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
    expect(state.sessionProjection).toBeUndefined();
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
    const createSessionMock = vi.fn().mockResolvedValue({
      ok: true,
      key: "agent:main:tui-canonical",
    });
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
      createSession: createSessionMock,
      currentSessionId: "old-session",
      applySessionMutationResult,
      refreshSessionInfo,
      resetSession: vi.fn().mockResolvedValue(resetResult),
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    // /new creates a unique session key (isolates TUI client) (#39217)
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const createOptions = firstMockArg(createSessionMock, "createSession") as
      | { key?: string; agentId?: string; parentSessionKey?: string; succeedsParent?: boolean }
      | undefined;
    if (!createOptions?.key) {
      throw new Error("expected /new to create a TUI session key");
    }
    expect(createOptions.agentId).toBe("main");
    expect(createOptions.parentSessionKey).toBe("agent:main:main");
    expect(createOptions.succeedsParent).toBe(true);
    expect(createOptions.key.startsWith("tui-")).toBe(true);
    const uuidParts: string[] = createOptions.key.slice("tui-".length).split("-");
    expect(uuidParts.map((part) => part.length)).toEqual([8, 4, 4, 4, 12]);
    expect(uuidParts.every((part) => /^[0-9a-f]+$/.test(part))).toBe(true);
    expect(setSessionMock).toHaveBeenCalledWith("agent:main:tui-canonical");
    // /reset still resets the shared session
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(resetSession).toHaveBeenCalledWith("agent:main:main", "reset", undefined);
    expect(applySessionMutationResult).toHaveBeenCalledWith(resetResult, {
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("reports a reset after adopting the backend's replacement session key", async () => {
    const resetResult = {
      ok: true as const,
      key: "agent:main:replacement",
      entry: { sessionId: "replacement-session" },
    };
    const applySessionMutationResult = vi.fn((result: typeof resetResult) => {
      harness.state.currentSessionKey = result.key;
      harness.state.currentSessionId = result.entry.sessionId;
      return true;
    });
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({
      applySessionMutationResult,
      refreshSessionInfo,
      resetSession: vi.fn().mockResolvedValue(resetResult),
    });

    await harness.handleCommand("/reset");

    expect(applySessionMutationResult).toHaveBeenCalledExactlyOnceWith(resetResult, {
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(refreshSessionInfo).toHaveBeenCalledOnce();
    expect(harness.state.currentSessionKey).toBe("agent:main:replacement");
    expect(harness.state.currentSessionId).toBe("replacement-session");
    expect(harness.addSystem).toHaveBeenCalledWith("session agent:main:replacement reset");
  });

  it.each([
    {
      name: "omits an unknown parent for the first session",
      currentSessionKey: "agent:main:main",
      currentAgentId: "main",
      currentSessionId: null,
      expectedParent: undefined,
    },
    {
      name: "attributes a global session to the selected agent",
      currentSessionKey: "global",
      currentAgentId: "work",
      currentSessionId: "global-session",
      expectedParent: "global",
    },
  ])("$name", async ({ currentSessionKey, currentAgentId, currentSessionId, expectedParent }) => {
    const createSession = vi.fn().mockResolvedValue({ ok: true, key: "agent:work:tui-next" });
    const { handleCommand } = createHarness({
      createSession,
      currentSessionKey,
      currentAgentId,
      currentSessionId,
    });

    await handleCommand("/new");

    expect(createSession).toHaveBeenCalledWith({
      key: expect.stringMatching(/^tui-/),
      agentId: currentAgentId,
      ...(expectedParent ? { parentSessionKey: expectedParent, succeedsParent: true } : {}),
    });
  });

  it.each([
    {
      activeChatRunId: "active-run",
      pendingSubmit: null,
      activityStatus: "running",
    },
    {
      activeChatRunId: null,
      pendingSubmit: {
        phase: "accepted" as const,
        runId: "pending-run",
        draftText: null,
      },
      activityStatus: "sending",
    },
    {
      activeChatRunId: null,
      pendingSubmit: {
        phase: "sending" as const,
        runId: "pending-run",
        draftText: "pending",
      },
      activityStatus: "sending",
    },
    {
      activeChatRunId: null,
      pendingSubmit: null,
      activityStatus: "finishing context",
    },
  ])("blocks /new while the current session lifecycle is unfinished", async (runState) => {
    const createSession = vi.fn();
    const { handleCommand, addSystem } = createHarness({ createSession, ...runState });

    await handleCommand("/new");

    expect(createSession).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("abort the current run before /new");
  });

  it.each([
    {
      activeChatRunId: "active-run",
      pendingSubmit: null,
      activityStatus: "running",
    },
    {
      activeChatRunId: null,
      pendingSubmit: {
        phase: "accepted" as const,
        runId: "pending-run",
        draftText: null,
      },
      activityStatus: "sending",
    },
    {
      activeChatRunId: null,
      pendingSubmit: {
        phase: "sending" as const,
        runId: "pending-run",
        draftText: "pending",
      },
      activityStatus: "sending",
    },
    {
      activeChatRunId: null,
      pendingSubmit: null,
      activityStatus: "finishing context",
    },
  ])("blocks /reset while the current session lifecycle is unfinished", async (runState) => {
    const resetSession = vi.fn();
    const { handleCommand, addSystem } = createHarness({ resetSession, ...runState });

    await handleCommand("/reset");

    expect(resetSession).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("abort the current run before /reset");
  });

  it("serializes input until /new adopts the created session", async () => {
    let resolveCreate: ((value: { ok: true; key: string }) => void) | undefined;
    const createSession = vi.fn().mockImplementation(
      () =>
        new Promise<{ ok: true; key: string }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { handleCommand, sendMessage, sendChat, addSystem } = createHarness({ createSession });

    const creating = handleCommand("/new");
    await Promise.resolve();
    await sendMessage("must not reach parent");
    await handleCommand("/new");

    expect(sendChat).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(addSystem).toHaveBeenCalledWith("session change in progress; message not sent");
    expect(addSystem).toHaveBeenCalledWith("session change in progress; wait for /new to finish");

    if (!resolveCreate) {
      throw new Error("expected pending session creation");
    }
    resolveCreate({ ok: true, key: "agent:main:tui-created" });
    await creating;
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

    expect(applySessionMutationResult).toHaveBeenCalledWith(
      { ok: true },
      { sessionKey: "agent:main:main", agentId: "main" },
    );
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("clears the canonical transcript exactly once through the session mutation owner", async () => {
    const sessionProjection = createSessionProjection(
      { sessionKey: "agent:main:main", agentId: "main" },
      [
        {
          role: "user",
          content: [{ type: "text", text: "before reset" }],
          __openclaw: { id: "before-reset", seq: 1 },
        },
      ],
    );
    const resetResult = {
      ok: true as const,
      key: "agent:main:main",
      entry: { sessionId: "reset-session" },
    };
    const applySessionMutationResult = vi.fn(() => {
      reduceTuiSessionProjection(harness.state as never, {
        type: "sessionReset",
        scope: readTuiSessionProjectionScope(harness.state),
      });
      return true;
    });
    const harness = createHarness({
      resetSession: vi.fn().mockResolvedValue(resetResult),
      applySessionMutationResult,
      sessionProjection,
    });

    await harness.handleCommand("/reset");

    expect(applySessionMutationResult).toHaveBeenCalledExactlyOnceWith(resetResult, {
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(harness.state.sessionProjection?.messages).toEqual([]);
    expect(harness.state.sessionProjection?.entries).toEqual([]);
    expect(harness.loadHistory).not.toHaveBeenCalled();
  });

  it("preserves the canonical transcript when the selected session reset fails", async () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "preserve failed reset" }],
      __openclaw: { id: "before-failed-reset", seq: 1 },
    };
    const sessionProjection = createSessionProjection(
      { sessionKey: "agent:main:main", agentId: "main" },
      [message],
    );
    const harness = createHarness({
      resetSession: vi.fn().mockRejectedValue(new Error("reset unavailable")),
      sessionProjection,
    });

    await harness.handleCommand("/reset");

    expect(harness.state.sessionProjection?.messages).toEqual([message]);
    expect(harness.applySessionMutationResult).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith("reset failed: reset unavailable");
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

  it.each([
    "/model openai/gpt-5.6-luna",
    "/think medium",
    "/verbose off",
    "/verbose full",
    "/trace on",
    "/fast on",
    "/reasoning on",
    "/usage reset",
    "/usage full",
    "/elevated ask",
    "/activation always",
  ])("ignores a stale %s result after switching sessions", async (command) => {
    const deferred = createDeferred<{
      ok: true;
      path: string;
      key: string;
      entry: Record<string, unknown>;
    }>();
    const harness = createHarness({
      currentSessionKey: "agent:main:first",
      sessionInfo: { responseUsage: "tokens", effectiveResponseUsage: "tokens" },
      patchSession: vi.fn(() => deferred.promise),
    });

    const pending = harness.handleCommand(command);
    expect(harness.patchSession).toHaveBeenCalledWith(
      expect.objectContaining({ key: "agent:main:first" }),
    );
    harness.state.currentSessionKey = "agent:main:second";
    deferred.resolve({
      ok: true,
      path: "/sessions/patch",
      key: "agent:main:first",
      entry: { model: "stale-model" },
    });
    await pending;

    expect(harness.state.currentSessionKey).toBe("agent:main:second");
    expect(harness.state.sessionInfo.responseUsage).toBe("tokens");
    expect(harness.state.sessionInfo.effectiveResponseUsage).toBe("tokens");
    expect(harness.applySessionInfoFromPatch).not.toHaveBeenCalled();
    expect(harness.refreshSessionInfo).not.toHaveBeenCalled();
    expect(harness.loadHistory).not.toHaveBeenCalled();
    expect(harness.clearTools).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it.each(["/model openai/gpt-5.6-luna", "/usage reset"])(
    "ignores a stale global-agent %s result",
    async (command) => {
      const deferred = createDeferred<{
        ok: true;
        path: string;
        key: string;
        entry: Record<string, unknown>;
      }>();
      const harness = createHarness({
        currentSessionKey: "global",
        currentAgentId: "main",
        sessionInfo: { responseUsage: "tokens", effectiveResponseUsage: "tokens" },
        patchSession: vi.fn(() => deferred.promise),
      });

      const pending = harness.handleCommand(command);
      expect(harness.patchSession).toHaveBeenCalledWith(
        expect.objectContaining({ key: "global", agentId: "main" }),
      );
      harness.state.currentAgentId = "work";
      deferred.resolve({
        ok: true,
        path: "/sessions/patch",
        key: "global",
        entry: { model: "main-agent-model" },
      });
      await pending;

      expect(harness.state.currentSessionKey).toBe("global");
      expect(harness.state.currentAgentId).toBe("work");
      expect(harness.state.sessionInfo.responseUsage).toBe("tokens");
      expect(harness.applySessionInfoFromPatch).not.toHaveBeenCalled();
      expect(harness.refreshSessionInfo).not.toHaveBeenCalled();
      expect(harness.addSystem).not.toHaveBeenCalled();
    },
  );

  it("applies a model patch after its selected session becomes canonical", async () => {
    const deferred = createDeferred<{
      ok: true;
      path: string;
      key: string;
      entry: Record<string, unknown>;
    }>();
    const harness = createHarness({
      currentSessionKey: "main",
      patchSession: vi.fn(() => deferred.promise),
    });

    const pending = harness.handleCommand("/model openai/gpt-5.6-luna");
    harness.state.currentSessionKey = "agent:main:main";
    const result = {
      ok: true as const,
      path: "/sessions/patch",
      key: "agent:main:main",
      entry: { model: "gpt-5.6-luna" },
    };
    deferred.resolve(result);
    await pending;

    expect(harness.applySessionInfoFromPatch).toHaveBeenCalledWith(result);
    expect(harness.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(harness.addSystem).toHaveBeenCalledWith("model set to openai/gpt-5.6-luna");
  });

  it("ignores a rejected model patch after switching sessions", async () => {
    const deferred = createDeferred<never>();
    const harness = createHarness({
      currentSessionKey: "agent:main:first",
      patchSession: vi.fn(() => deferred.promise),
    });

    const pending = harness.handleCommand("/model openai/gpt-5.6-luna");
    harness.state.currentSessionKey = "agent:main:second";
    deferred.reject(new Error("stale model patch"));
    await pending;

    expect(harness.applySessionInfoFromPatch).not.toHaveBeenCalled();
    expect(harness.refreshSessionInfo).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it.each([
    { name: "another session", initialKey: "agent:main:first", nextKey: "agent:main:second" },
    { name: "another global agent", initialKey: "global", nextKey: "global" },
  ])("ignores a stale reset after selecting $name", async ({ initialKey, nextKey }) => {
    const deferred = createDeferred<{
      ok: true;
      key: string;
      entry: { sessionId: string };
    }>();
    const harness = createHarness({
      currentSessionKey: initialKey,
      currentAgentId: "main",
      resetSession: vi.fn(() => deferred.promise),
      applySessionMutationResult: vi.fn().mockReturnValue(true),
    });

    const pending = harness.handleCommand("/reset");
    expect(harness.resetSession).toHaveBeenCalledWith(
      initialKey,
      "reset",
      initialKey === "global" ? { agentId: "main" } : undefined,
    );
    harness.state.currentSessionKey = nextKey;
    if (initialKey === "global") {
      harness.state.currentAgentId = "work";
    }
    harness.state.currentSessionId = "second-session";
    deferred.resolve({
      ok: true,
      key: initialKey,
      entry: { sessionId: "stale-reset-session" },
    });
    await pending;

    expect(harness.state.currentSessionKey).toBe(nextKey);
    expect(harness.state.currentSessionId).toBe("second-session");
    expect(harness.applySessionMutationResult).not.toHaveBeenCalled();
    expect(harness.refreshSessionInfo).not.toHaveBeenCalled();
    expect(harness.loadHistory).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it("ignores a rejected global reset after switching agents", async () => {
    const deferred = createDeferred<never>();
    const harness = createHarness({
      currentSessionKey: "global",
      currentAgentId: "main",
      resetSession: vi.fn(() => deferred.promise),
    });

    const pending = harness.handleCommand("/reset");
    harness.state.currentAgentId = "work";
    deferred.reject(new Error("stale global reset"));
    await pending;

    expect(harness.applySessionMutationResult).not.toHaveBeenCalled();
    expect(harness.refreshSessionInfo).not.toHaveBeenCalled();
    expect(harness.loadHistory).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it("uses the effective runtime for the no-arg /think usage", async () => {
    const codex = createHarness({
      sessionInfo: {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "codex", source: "model" },
      },
    });
    await codex.handleCommand("/think");
    expect(codex.addSystem).toHaveBeenCalledWith(expect.not.stringContaining("ultra"));

    const openclaw = createHarness({
      sessionInfo: {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "session-key" },
      },
    });
    await openclaw.handleCommand("/think");
    expect(openclaw.addSystem).toHaveBeenCalledWith(expect.stringContaining("ultra"));
  });

  it.each([
    { command: "verbose", usage: "usage: /verbose <on|off|full>" },
    { command: "reasoning", usage: "usage: /reasoning <on|off|stream>" },
  ])("shows the complete canonical no-argument /$command usage", async ({ command, usage }) => {
    const { handleCommand, addSystem, patchSession } = createHarness();

    await handleCommand(`/${command}`);

    expect(addSystem).toHaveBeenCalledWith(usage);
    expect(patchSession).not.toHaveBeenCalled();
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

  it("reloads history for /verbose full so prior full tool output becomes visible", async () => {
    const patchResult = { entry: { verboseLevel: "full" } };
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

    await handleCommand("/verbose full");

    expect(patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      verboseLevel: "full",
    });
    expect(applySessionInfoFromPatch).toHaveBeenCalledWith(patchResult);
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

    expect(addSystem).toHaveBeenCalledWith("send failed: gateway down");
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
    expect(state.pendingSubmit).toBeNull();
  });

  it("redacts secrets and preserves nested causes in displayed send failures", async () => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const cause = new Error(`\u001b[31mAuthorization: Bearer ${secret}\u001b[0m`);
    const { handleCommand, addSystem } = createHarness({
      sendChat: vi.fn().mockRejectedValue(new Error("gateway down", { cause })),
    });

    await handleCommand("/context detail");

    const message = addSystem.mock.calls.at(-1)?.[0];
    expect(message).toContain("send failed: gateway down");
    expect(message).toContain("Authorization: Bearer");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("\u001b");
  });

  it("sanitizes control sequences in /new and /reset failures", async () => {
    const createSession = vi.fn().mockRejectedValue(new Error("\u001b[31mboom\u001b[0m"));
    const resetSession = vi.fn().mockRejectedValue(new Error("\u001b[31mboom\u001b[0m"));
    const { handleCommand, addSystem } = createHarness({
      createSession,
      resetSession,
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    expect(addSystem).toHaveBeenNthCalledWith(1, "new session failed: boom");
    expect(addSystem).toHaveBeenNthCalledWith(2, "reset failed: boom");
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
      addPendingUser,
      addSystem,
      reserveAssistantSlot,
      requestRender,
      state,
    } = createHarness({
      opts: { local: true },
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("continue here");

    expect(sendChat).toHaveBeenCalledTimes(1);
    expectSendChatFields(sendChat, {
      message: "continue here",
      sessionKey: "agent:main:main",
    });
    expect(reserveAssistantSlot).toHaveBeenCalledWith("run-active");
    const reserveCallOrder = reserveAssistantSlot.mock.invocationCallOrder[0];
    const addPendingUserCallOrder = expectDefined(
      addPendingUser.mock.invocationCallOrder[0],
      "addPendingUser.mock.invocationCallOrder[0] test invariant",
    );
    expect(reserveCallOrder).toBeLessThan(addPendingUserCallOrder);
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "continue here");
    expect(addSystem).not.toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
    expect(requestRender).toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
    expect(getPendingSubmitAcceptedRunId(state)).toEqual(expect.any(String));
  });

  it("forwards gateway slash prompts while a run is active", async () => {
    const { handleCommand, sendChat, addPendingUser, addSystem } = createHarness({
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("/context detail");

    expectSendChatFields(sendChat, { message: "/context detail" });
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "/context detail");
    expect(addSystem).not.toHaveBeenCalledWith(
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

  it("routes slash stop to session abort when there is no tracked run", async () => {
    const abortActive = vi.fn().mockResolvedValue(undefined);
    const { handleCommand, sendChat, addPendingUser } = createHarness({ abortActive });

    await handleCommand("/stop");

    expect(abortActive).toHaveBeenCalledWith({ preferActive: true });
    expect(sendChat).not.toHaveBeenCalled();
    expect(addPendingUser).not.toHaveBeenCalled();
  });

  it("sends broad stop-like text as a normal prompt when idle", async () => {
    const abortActive = vi.fn().mockResolvedValue(undefined);
    const { handleCommand, sendChat, addPendingUser } = createHarness({ abortActive });

    await handleCommand("do not do that");

    expect(abortActive).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "do not do that");
  });

  it("rejects normal sends while a queued submit is pending registration", async () => {
    const { handleCommand, sendChat, addUser, addSystem } = createHarness({
      activeChatRunId: "run-active",
      pendingSubmit: {
        phase: "accepted",
        runId: "run-queued",
        draftText: "queued",
      },
      activityStatus: "waiting",
    });

    await handleCommand("/context detail");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
      { coalesceConsecutive: true },
    );
  });

  it("allows local sends to queue while the current run is finishing", async () => {
    const { handleCommand, sendChat, addPendingUser, addSystem } = createHarness({
      opts: { local: true },
      activeChatRunId: "run-active",
      activityStatus: "finishing context",
    });

    await handleCommand("continue after compaction");

    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "continue after compaction");
    expect(addSystem).not.toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
  });

  it("forwards gateway sends while the current run is finishing", async () => {
    const { handleCommand, sendChat, addPendingUser, addSystem } = createHarness({
      activeChatRunId: "run-active",
      activityStatus: "finishing context",
    });

    await handleCommand("/context detail");

    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "/context detail");
    expect(addSystem).not.toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
  });

  it("forwards gateway sends while a run is active so Gateway owns queue policy", async () => {
    const { handleCommand, sendChat, addPendingUser, addSystem } = createHarness({
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("follow up question");

    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "follow up question");
    expect(addSystem).not.toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
  });

  it("blocks sends while optimistic user message admission is pending", async () => {
    const { handleCommand, sendChat, addSystem } = createHarness({
      activeChatRunId: "run-active",
      pendingSubmit: {
        phase: "sending",
        runId: "run-pending",
        draftText: "pending",
      },
      activityStatus: "sending",
    });

    await handleCommand("another message");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
      { coalesceConsecutive: true },
    );
  });

  it("preserves activeChatRunId when a queued followup send fails", async () => {
    const sendChat = vi.fn().mockRejectedValue(new Error("network error"));
    const { handleCommand, addSystem, state } = createHarness({
      sendChat,
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("queued followup");

    expect(addSystem).toHaveBeenCalledWith(expect.stringContaining("send failed"));
    expect(state.activeChatRunId).toBe("run-active");
  });

  it("does not restore a queued run that completes before the followup send fails", async () => {
    let rejectSend: (error: Error) => void = () => {
      throw new Error("sendChat promise rejector was not initialized");
    };
    const sendChat = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const { handleCommand, state } = createHarness({
      sendChat,
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    const pendingSend = handleCommand("queued followup");
    await Promise.resolve();
    state.activeChatRunId = null;
    rejectSend(new Error("network error"));
    await pendingSend;

    expect(state.activeChatRunId).toBeNull();
  });

  it("clears activeChatRunId when a non-queued send fails", async () => {
    const sendChat = vi.fn().mockRejectedValue(new Error("network error"));
    const { handleCommand, state } = createHarness({
      sendChat,
    });

    await handleCommand("some message");

    expect(state.activeChatRunId).toBeNull();
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
      pendingSubmit: {
        phase: "sending",
        runId: "run-pending",
        draftText: "pending",
      },
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

  it("patches and reports auto fast mode", async () => {
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const applySessionInfoFromPatch = vi.fn();
    const patchSession = vi.fn().mockResolvedValue({ fastMode: "auto" });
    const {
      handleCommand,
      patchSession: patch,
      addSystem,
      state,
    } = createHarness({
      patchSession,
      refreshSessionInfo,
      applySessionInfoFromPatch,
    });

    await handleCommand("/fast auto");

    expect(patch).toHaveBeenCalledWith({
      key: "agent:main:main",
      fastMode: "auto",
    });
    expect(addSystem).toHaveBeenCalledWith("fast mode set to auto");
    expect(applySessionInfoFromPatch).toHaveBeenCalledWith({ fastMode: "auto" });
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);

    (state.sessionInfo as { fastMode?: "auto" }).fastMode = "auto";
    await handleCommand("/fast status");
    expect(addSystem).toHaveBeenCalledWith("fast mode: auto");
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

  it.each(["codex", "openclaw"])(
    "forwards model/runtime transactions through the server directive path for %s",
    async (runtime) => {
      const sendChat = vi.fn().mockResolvedValue({ status: "ok" });
      const patchSession = vi.fn();
      const command = `/model openai/gpt-5.6-luna --runtime ${runtime} continue with this model`;
      const { handleCommand } = createHarness({ sendChat, patchSession });

      await handleCommand(command);

      expectSendChatFields(sendChat, {
        message: command,
        sessionKey: "agent:main:main",
      });
      expect(patchSession).not.toHaveBeenCalled();
    },
  );

  it("shows resolved canonical model ref after /model alias, not raw alias string", async () => {
    // When the user types `/model gpt4` (a bare alias), the gateway resolves it
    // server-side and returns the canonical ref in result.resolved. The TUI must
    // display the canonical ref, not the raw alias, so the user knows which model
    // was actually applied.
    const patchSession = vi.fn().mockResolvedValue({
      ok: true,
      path: "/sessions/patch",
      key: "agent:main:main",
      entry: {},
      resolved: { modelProvider: "openai", model: "gpt-5.5" },
    });
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const applySessionInfoFromPatch = vi.fn();
    const { handleCommand, addSystem } = createHarness({
      patchSession,
      refreshSessionInfo,
      applySessionInfoFromPatch,
    });

    await handleCommand("/model gpt4");

    expect(patchSession).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt4" }));
    // Should show the canonical resolved ref, not the raw alias "gpt4"
    expect(addSystem).toHaveBeenCalledWith("model set to openai/gpt-5.5");
  });

  it("falls back to raw input in /model confirmation when resolved ref unavailable", async () => {
    // Older gateway versions may not return resolved; fall back to raw arg.
    const patchSession = vi.fn().mockResolvedValue({
      ok: true,
      path: "/sessions/patch",
      key: "agent:main:main",
      entry: {},
      // No `resolved` field
    });
    const { handleCommand, addSystem } = createHarness({ patchSession });

    await handleCommand("/model openai/gpt-5.5");

    expect(addSystem).toHaveBeenCalledWith("model set to openai/gpt-5.5");
  });
  it("preserves provider prefix for nested model ids in /model confirmation", async () => {
    // Some providers route to nested model ids that themselves contain a slash
    // (e.g. resolved.model: "moonshotai/kimi-k2.5" with modelProvider: "nvidia").
    // The confirmation must still show the full nvidia/moonshotai/kimi-k2.5 ref,
    // not strip the provider just because the model id already contains a slash.
    const patchSession = vi.fn().mockResolvedValue({
      ok: true,
      path: "/sessions/patch",
      key: "agent:main:main",
      entry: {},
      resolved: { modelProvider: "nvidia", model: "moonshotai/kimi-k2.5" },
    });
    const { handleCommand, addSystem } = createHarness({ patchSession });

    await handleCommand("/model nvidia/moonshotai/kimi-k2.5");

    expect(addSystem).toHaveBeenCalledWith("model set to nvidia/moonshotai/kimi-k2.5");
  });

  it("renders model listing feedback before the backend list resolves", async () => {
    let resolveModels: (
      value: Array<{ provider: string; id: string; name?: string }>,
    ) => void = () => {
      throw new Error("model list promise resolver was not initialized");
    };
    const listModelsPromise = new Promise<Array<{ provider: string; id: string; name?: string }>>(
      (resolve) => {
        resolveModels = (value) => resolve(value);
      },
    );
    const listModels = vi.fn(() => listModelsPromise);
    const { handleCommand, addSystem, openOverlay, requestRender } = createHarness({ listModels });

    const pending = handleCommand("/models");
    await Promise.resolve();

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(addSystem).toHaveBeenCalledWith("loading models...");
    expect(openOverlay).not.toHaveBeenCalled();
    const feedbackOrder = addSystem.mock.invocationCallOrder[0] ?? 0;
    const renderOrders = requestRender.mock.invocationCallOrder;
    expect(renderOrders.filter((order) => order > feedbackOrder)).not.toEqual([]);

    resolveModels([{ provider: "openrouter", id: "openrouter/auto" }]);
    await pending;

    expect(openOverlay).toHaveBeenCalledTimes(1);
  });

  it("does not open a stale model selector after switching sessions", async () => {
    const deferred = createDeferred<Array<{ provider: string; id: string; name?: string }>>();
    const harness = createHarness({
      currentSessionKey: "agent:main:first",
      listModels: vi.fn(() => deferred.promise),
    });

    const pending = harness.handleCommand("/models");
    expect(harness.addSystem).toHaveBeenCalledWith("loading models...");
    harness.addSystem.mockClear();
    harness.state.currentSessionKey = "agent:main:second";
    deferred.resolve([{ provider: "openai", id: "gpt-5.6-luna" }]);
    await pending;

    expect(harness.openOverlay).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it.each([
    { name: "another session", initialKey: "agent:main:first", nextKey: "agent:main:second" },
    { name: "another global agent", initialKey: "global", nextKey: "global" },
  ])("ignores a model-picker result after selecting $name", async ({ initialKey, nextKey }) => {
    const deferred = createDeferred<{
      ok: true;
      path: string;
      key: string;
      entry: Record<string, unknown>;
    }>();
    const harness = createHarness({
      currentSessionKey: initialKey,
      currentAgentId: "main",
      listModels: vi.fn().mockResolvedValue([{ provider: "openai", id: "gpt-5.6-luna" }]),
      patchSession: vi.fn(() => deferred.promise),
    });

    await harness.handleCommand("/models");
    const selector = firstMockArg(harness.openOverlay, "openOverlay") as SelectableOverlay;
    harness.addSystem.mockClear();
    selector.onSelect?.({ value: "openai/gpt-5.6-luna" });
    expect(harness.patchSession).toHaveBeenCalledWith({
      key: initialKey,
      ...(initialKey === "global" ? { agentId: "main" } : {}),
      model: "openai/gpt-5.6-luna",
    });
    harness.state.currentSessionKey = nextKey;
    if (initialKey === "global") {
      harness.state.currentAgentId = "work";
    }
    deferred.resolve({
      ok: true,
      path: "/sessions/patch",
      key: initialKey,
      entry: { model: "stale-model" },
    });
    await flushAsyncSelect();

    expect(harness.state.currentSessionKey).toBe(nextKey);
    expect(harness.applySessionInfoFromPatch).not.toHaveBeenCalled();
    expect(harness.refreshSessionInfo).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it("does not open a stale session selector after switching agents", async () => {
    const deferred = createDeferred<{
      sessions: Array<{ key: string; updatedAt: number }>;
    }>();
    const harness = createHarness({
      currentAgentId: "main",
      listSessions: vi.fn(() => deferred.promise),
    });

    const pending = harness.openSessionSelector();
    harness.state.currentAgentId = "work";
    deferred.resolve({
      sessions: [{ key: "agent:main:main", updatedAt: 1 }],
    });
    await pending;

    expect(harness.openOverlay).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it("/usage reset clears the stale local responseUsage after the gateway patch", async () => {
    // Regression: after /usage reset sends responseUsage: null and the gateway deletes
    // the field, applySessionInfoFromPatch skips absent fields. The command handler must
    // explicitly clear the stale local value so no-arg cycles and subsequent refreshes
    // start from the correct effective mode.
    const patchSession = vi.fn().mockResolvedValue({
      entry: {
        // Gateway returns the updated entry without the responseUsage field (it was deleted).
        sessionId: "sess-reset",
        updatedAt: Date.now(),
      },
    });
    const { handleCommand, addSystem, state } = createHarness({ patchSession });
    const sessionInfo = state.sessionInfo as {
      responseUsage?: string;
      effectiveResponseUsage?: string;
    };
    sessionInfo.responseUsage = "tokens";
    sessionInfo.effectiveResponseUsage = "tokens";

    await handleCommand("/usage reset");

    expect(patchSession).toHaveBeenCalledWith(expect.objectContaining({ responseUsage: null }));
    expect(addSystem).toHaveBeenCalledWith("usage footer: reset to default");
    // Both stale local values must be cleared so the toggle/display is not stale
    // until refreshSessionInfo() repopulates the inherited default.
    expect(sessionInfo.responseUsage).toBeUndefined();
    expect(sessionInfo.effectiveResponseUsage).toBeUndefined();
  });

  it("/usage no-arg toggle cycles from effectiveResponseUsage when the session override is unset", async () => {
    // Regression: when the session has no explicit responseUsage but the config default
    // is "tokens", the toggle should cycle tokens→full, not off→tokens.
    const patchSession = vi.fn().mockResolvedValue({
      entry: { sessionId: "sess-toggle", updatedAt: Date.now(), responseUsage: "full" },
    });
    const { handleCommand, addSystem, state } = createHarness({ patchSession });
    // No raw responseUsage on session, but effective (from config default) is "tokens".
    const sessionInfo = state.sessionInfo as {
      responseUsage?: string;
      effectiveResponseUsage?: string;
    };
    sessionInfo.responseUsage = undefined;
    sessionInfo.effectiveResponseUsage = "tokens";

    await handleCommand("/usage");

    expect(patchSession).toHaveBeenCalledWith(expect.objectContaining({ responseUsage: "full" }));
    expect(addSystem).toHaveBeenCalledWith("usage footer: full");
  });

  it("allows /queue directives to reach gateway during an active run in steer mode", async () => {
    const { handleCommand, sendChat, addPendingUser, addSystem } = createHarness({
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("/queue followup");

    expect(sendChat).toHaveBeenCalledTimes(1);
    expectSendChatFields(sendChat, { message: "/queue followup" });
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "/queue followup");
    expect(addSystem).not.toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
  });

  it("allows bare /queue to reach gateway during an active run", async () => {
    const { handleCommand, sendChat, addSystem } = createHarness({
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("/queue");

    expect(sendChat).toHaveBeenCalledTimes(1);
    expectSendChatFields(sendChat, { message: "/queue" });
    expect(addSystem).not.toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
    );
  });

  it("allows colon-form /queue directives during an active run", async () => {
    const { handleCommand, sendChat } = createHarness({
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("/queue:followup");

    expectSendChatFields(sendChat, { message: "/queue:followup" });
  });

  it("routes /queue directives through the local backend", async () => {
    const { handleCommand, sendChat, addSystem } = createHarness({
      opts: { local: true },
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("/queue followup");

    expectSendChatFields(sendChat, { message: "/queue followup" });
    expect(addSystem).not.toHaveBeenCalledWith("/queue is unavailable in local mode");
  });

  it("blocks /queue while optimistic user message is pending", async () => {
    const { handleCommand, sendChat, addSystem } = createHarness({
      activeChatRunId: "run-active",
      pendingSubmit: {
        phase: "sending",
        runId: "run-pending",
        draftText: "pending",
      },
      activityStatus: "sending",
    });

    await handleCommand("/queue followup");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
      { coalesceConsecutive: true },
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
