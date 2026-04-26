import { describe, expect, it, vi } from "vitest";
import { createCommandHandlers } from "./tui-command-handlers.js";

type LoadHistoryMock = ReturnType<typeof vi.fn> & (() => Promise<void>);
type RunAuthFlow = NonNullable<Parameters<typeof createCommandHandlers>[0]["runAuthFlow"]>;
type SelectableOverlay = {
  onSelect?: (item: { value: string; label?: string; description?: string }) => void;
};
type SetActivityStatusMock = ReturnType<typeof vi.fn> & ((text: string) => void);
type SetSessionMock = ReturnType<typeof vi.fn> & ((key: string) => Promise<void>);

async function flushAsyncSelect() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createHarness(params?: {
  sendChat?: ReturnType<typeof vi.fn>;
  getGatewayStatus?: ReturnType<typeof vi.fn>;
  patchSession?: ReturnType<typeof vi.fn>;
  resetSession?: ReturnType<typeof vi.fn>;
  runAuthFlow?: RunAuthFlow;
  setSession?: SetSessionMock;
  loadHistory?: LoadHistoryMock;
  refreshSessionInfo?: ReturnType<typeof vi.fn>;
  applySessionInfoFromPatch?: ReturnType<typeof vi.fn>;
  setActivityStatus?: SetActivityStatusMock;
  isConnected?: boolean;
  activeChatRunId?: string | null;
  pendingOptimisticUserMessage?: boolean;
  opts?: { local?: boolean };
}) {
  const sendChat = params?.sendChat ?? vi.fn().mockResolvedValue({ runId: "r1" });
  const getGatewayStatus = params?.getGatewayStatus ?? vi.fn().mockResolvedValue({});
  const patchSession = params?.patchSession ?? vi.fn().mockResolvedValue({});
  const resetSession = params?.resetSession ?? vi.fn().mockResolvedValue({ ok: true });
  const setSession = params?.setSession ?? (vi.fn().mockResolvedValue(undefined) as SetSessionMock);
  const addUser = vi.fn();
  const addSystem = vi.fn();
  const requestRender = vi.fn();
  const noteLocalRunId = vi.fn();
  const noteLocalBtwRunId = vi.fn();
  const loadHistory =
    params?.loadHistory ?? (vi.fn().mockResolvedValue(undefined) as LoadHistoryMock);
  const refreshSessionInfo = params?.refreshSessionInfo ?? vi.fn().mockResolvedValue(undefined);
  const applySessionInfoFromPatch = params?.applySessionInfoFromPatch ?? vi.fn();
  const setActivityStatus = params?.setActivityStatus ?? (vi.fn() as SetActivityStatusMock);
  const openOverlay = vi.fn();
  const closeOverlay = vi.fn();
  const requestExit = vi.fn();
  const runAuthFlow: RunAuthFlow | undefined =
    params?.runAuthFlow ??
    (params?.opts?.local
      ? (vi.fn().mockResolvedValue({ exitCode: 0, signal: null }) as unknown as RunAuthFlow)
      : undefined);
  const state = {
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    activeChatRunId: params?.activeChatRunId ?? null,
    pendingOptimisticUserMessage: params?.pendingOptimisticUserMessage ?? false,
    isConnected: params?.isConnected ?? true,
    sessionInfo: {},
  };

  const { handleCommand } = createCommandHandlers({
    client: { sendChat, getGatewayStatus, patchSession, resetSession } as never,
    chatLog: { addUser, addSystem } as never,
    tui: { requestRender } as never,
    opts: params?.opts ?? {},
    state: state as never,
    deliverDefault: false,
    openOverlay,
    closeOverlay,
    refreshSessionInfo: refreshSessionInfo as never,
    loadHistory,
    setSession,
    refreshAgents: vi.fn(),
    abortActive: vi.fn(),
    setActivityStatus,
    formatSessionKey: vi.fn(),
    applySessionInfoFromPatch: applySessionInfoFromPatch as never,
    noteLocalRunId,
    noteLocalBtwRunId,
    forgetLocalRunId: vi.fn(),
    forgetLocalBtwRunId: vi.fn(),
    runAuthFlow,
    requestExit,
  });

  return {
    handleCommand,
    getGatewayStatus,
    sendChat,
    openOverlay,
    closeOverlay,
    patchSession,
    resetSession,
    setSession,
    addUser,
    addSystem,
    requestRender,
    loadHistory,
    refreshSessionInfo,
    applySessionInfoFromPatch,
    runAuthFlow,
    setActivityStatus,
    noteLocalRunId,
    noteLocalBtwRunId,
    requestExit,
    state,
  };
}

describe("tui command handlers", () => {
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
    expect(renderOrders.some((order) => order > sendingOrder)).toBe(true);

    resolveSend({ runId: "r1" });
    await pending;
    expect(setActivityStatus).toHaveBeenCalledWith("waiting");
  });

  it("forwards unknown slash commands to the gateway", async () => {
    const { handleCommand, sendChat, addUser, addSystem, requestRender } = createHarness();

    await handleCommand("/unregistered-command");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenCalledWith("/unregistered-command");
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/unregistered-command",
      }),
    );
    expect(requestRender).toHaveBeenCalled();
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
    const selector = openOverlay.mock.calls[0]?.[0] as SelectableOverlay | undefined;
    selector?.onSelect?.({ value: "detail", label: "detail" });
    await flushAsyncSelect();

    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/context detail",
      }),
    );
    expect(closeOverlay).toHaveBeenCalledTimes(1);
  });

  it("forwards /context list directly", async () => {
    const { handleCommand, sendChat, openOverlay } = createHarness();

    await handleCommand("/context list");

    expect(openOverlay).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/context list",
      }),
    );
  });

  it("forwards /context help directly", async () => {
    const { handleCommand, sendChat, openOverlay } = createHarness();

    await handleCommand("/context help");

    expect(openOverlay).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/context help",
      }),
    );
  });

  it("forwards /status to the shared gateway command path", async () => {
    const { handleCommand, sendChat, addUser, addSystem } = createHarness();

    await handleCommand("/status");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenCalledWith("/status");
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/status",
      }),
    );
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

  it("leaves a Crestodian breadcrumb after switching agents", async () => {
    const { handleCommand, addSystem, setSession, state } = createHarness();

    await handleCommand("/agent Work");

    expect(state.currentAgentId).toBe("work");
    expect(setSession).toHaveBeenCalledWith("");
    expect(addSystem).toHaveBeenCalledWith("agent set to work; use /crestodian to return");
  });

  it("defers local run binding until gateway events provide a real run id", async () => {
    const { handleCommand, noteLocalRunId, state } = createHarness();

    await handleCommand("/context detail");

    expect(noteLocalRunId).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBeNull();
    expect(state.pendingOptimisticUserMessage).toBe(true);
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
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "/btw what changed?",
      }),
    );
  });

  it("creates unique session for /new and resets shared session for /reset", async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const setSessionMock = vi.fn().mockResolvedValue(undefined) as SetSessionMock;
    const { handleCommand, resetSession } = createHarness({
      loadHistory,
      setSession: setSessionMock,
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    // /new creates a unique session key (isolates TUI client) (#39217)
    expect(setSessionMock).toHaveBeenCalledTimes(1);
    expect(setSessionMock).toHaveBeenCalledWith(
      expect.stringMatching(/^tui-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    );
    // /reset still resets the shared session
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(resetSession).toHaveBeenCalledWith("agent:main:main", "reset");
    expect(loadHistory).toHaveBeenCalledTimes(1); // /reset calls loadHistory directly; /new does so indirectly via setSession
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
    const setSession = vi.fn().mockRejectedValue(new Error("\u001b[31mboom\u001b[0m"));
    const resetSession = vi.fn().mockRejectedValue(new Error("\u001b[31mboom\u001b[0m"));
    const { handleCommand, addSystem } = createHarness({
      setSession,
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

  it("runs /auth through the local auth flow and refreshes session info", async () => {
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const runAuthFlow = vi.fn().mockResolvedValue({ exitCode: 0, signal: null });
    const { handleCommand, addSystem, setActivityStatus } = createHarness({
      opts: { local: true },
      refreshSessionInfo,
      runAuthFlow,
    });

    await handleCommand("/auth openai-codex");

    expect(runAuthFlow).toHaveBeenCalledWith({ provider: "openai-codex" });
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
    expect(addSystem).toHaveBeenCalledWith(
      "opening auth flow for openai-codex; TUI will resume when it exits",
    );
    expect(addSystem).toHaveBeenCalledWith("auth flow finished for openai-codex");
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

    await handleCommand("/auth openai-codex");

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
});
