import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHandlers } from "./tui-event-handlers.js";
import type { AgentEvent, BtwEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

type MockFn = ReturnType<typeof vi.fn>;
type HandlerChatLog = {
  startTool: (...args: unknown[]) => void;
  updateToolResult: (...args: unknown[]) => void;
  addSystem: (...args: unknown[]) => void;
  updateAssistant: (...args: unknown[]) => void;
  finalizeAssistant: (...args: unknown[]) => void;
  dropAssistant: (...args: unknown[]) => void;
};
type HandlerBtwPresenter = {
  showResult: (...args: unknown[]) => void;
  clear: (...args: unknown[]) => void;
};
type HandlerTui = { requestRender: (...args: unknown[]) => void };
type MockChatLog = {
  startTool: MockFn;
  updateToolResult: MockFn;
  addSystem: MockFn;
  updateAssistant: MockFn;
  finalizeAssistant: MockFn;
  dropAssistant: MockFn;
};
type MockBtwPresenter = {
  showResult: MockFn;
  clear: MockFn;
};
type MockTui = { requestRender: MockFn };

function createMockChatLog(): MockChatLog & HandlerChatLog {
  return {
    startTool: vi.fn(),
    updateToolResult: vi.fn(),
    addSystem: vi.fn(),
    updateAssistant: vi.fn(),
    finalizeAssistant: vi.fn(),
    dropAssistant: vi.fn(),
  } as unknown as MockChatLog & HandlerChatLog;
}

function createMockBtwPresenter(): MockBtwPresenter & HandlerBtwPresenter {
  return {
    showResult: vi.fn(),
    clear: vi.fn(),
  } as unknown as MockBtwPresenter & HandlerBtwPresenter;
}

describe("tui-event-handlers: handleAgentEvent", () => {
  const makeState = (overrides?: Partial<TuiStateAccess>): TuiStateAccess => ({
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: "session-1",
    activeChatRunId: "run-1",
    pendingOptimisticUserMessage: false,
    historyLoaded: true,
    sessionInfo: { verboseLevel: "on" },
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

  const makeContext = (state: TuiStateAccess) => {
    const chatLog = createMockChatLog();
    const btw = createMockBtwPresenter();
    const tui = { requestRender: vi.fn() } as unknown as MockTui & HandlerTui;
    const setActivityStatus = vi.fn();
    const loadHistory = vi.fn();
    const localRunIds = new Set<string>();
    const localBtwRunIds = new Set<string>();
    const noteLocalRunId = (runId: string) => {
      localRunIds.add(runId);
    };
    const forgetLocalRunId = localRunIds.delete.bind(localRunIds);
    const isLocalRunId = localRunIds.has.bind(localRunIds);
    const clearLocalRunIds = localRunIds.clear.bind(localRunIds);
    const noteLocalBtwRunId = (runId: string) => {
      localBtwRunIds.add(runId);
    };
    const forgetLocalBtwRunId = localBtwRunIds.delete.bind(localBtwRunIds);
    const isLocalBtwRunId = localBtwRunIds.has.bind(localBtwRunIds);
    const clearLocalBtwRunIds = localBtwRunIds.clear.bind(localBtwRunIds);

    return {
      chatLog,
      btw,
      tui,
      state,
      setActivityStatus,
      loadHistory,
      noteLocalRunId,
      noteLocalBtwRunId,
      forgetLocalRunId,
      isLocalRunId,
      clearLocalRunIds,
      forgetLocalBtwRunId,
      isLocalBtwRunId,
      clearLocalBtwRunIds,
    };
  };

  const createHandlersHarness = (params?: {
    state?: Partial<TuiStateAccess>;
    chatLog?: HandlerChatLog;
    btw?: HandlerBtwPresenter;
    localMode?: boolean;
  }) => {
    const state = makeState(params?.state);
    const context = makeContext(state);
    const chatLog = (params?.chatLog ?? context.chatLog) as MockChatLog & HandlerChatLog;
    const handlers = createEventHandlers({
      chatLog,
      btw: (params?.btw ?? context.btw) as MockBtwPresenter & HandlerBtwPresenter,
      tui: context.tui,
      state,
      localMode: params?.localMode,
      setActivityStatus: context.setActivityStatus,
      loadHistory: context.loadHistory,
      noteLocalRunId: context.noteLocalRunId,
      isLocalRunId: context.isLocalRunId,
      forgetLocalRunId: context.forgetLocalRunId,
      isLocalBtwRunId: context.isLocalBtwRunId,
      forgetLocalBtwRunId: context.forgetLocalBtwRunId,
      clearLocalBtwRunIds: context.clearLocalBtwRunIds,
    });
    return {
      ...context,
      state,
      chatLog,
      btw: (params?.btw ?? context.btw) as MockBtwPresenter & HandlerBtwPresenter,
      ...handlers,
    };
  };

  it("processes tool events when runId matches activeChatRunId (even if sessionId differs)", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: { currentSessionId: "session-xyz", activeChatRunId: "run-123" },
    });

    const evt: AgentEvent = {
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "start",
        toolCallId: "tc1",
        name: "exec",
        args: { command: "echo hi" },
      },
    };

    handleAgentEvent(evt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", { command: "echo hi" });
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("ignores tool events when runId does not match activeChatRunId", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-1" },
    });

    const evt: AgentEvent = {
      runId: "run-2",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec" },
    };

    handleAgentEvent(evt);

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(chatLog.updateToolResult).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("processes lifecycle events when runId matches activeChatRunId", () => {
    const chatLog = createMockChatLog();
    const { tui, setActivityStatus, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-9" },
      chatLog,
    });

    const evt: AgentEvent = {
      runId: "run-9",
      stream: "lifecycle",
      data: { phase: "start" },
    };

    handleAgentEvent(evt);

    expect(setActivityStatus).toHaveBeenCalledWith("running");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("captures runId from chat events when activeChatRunId is unset", () => {
    const { state, chatLog, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    const chatEvt: ChatEvent = {
      runId: "run-42",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    };

    handleChatEvent(chatEvt);

    expect(state.activeChatRunId).toBe("run-42");

    const agentEvt: AgentEvent = {
      runId: "run-42",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec" },
    };

    handleAgentEvent(agentEvt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", undefined);
  });

  it("accepts chat events when session key is an alias of the active canonical key", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: {
        currentSessionKey: "agent:main:main",
        activeChatRunId: null,
      },
    });

    handleChatEvent({
      runId: "run-alias",
      sessionKey: "main",
      state: "delta",
      message: { content: "hello" },
    });

    expect(state.activeChatRunId).toBe("run-alias");
    expect(chatLog.updateAssistant).toHaveBeenCalledWith("hello", "run-alias");
  });

  it("renders BTW results separately without disturbing the active run", () => {
    const { state, btw, setActivityStatus, loadHistory, tui, handleBtwEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-main" },
      });

    const evt: BtwEvent = {
      kind: "btw",
      runId: "run-btw",
      sessionKey: state.currentSessionKey,
      question: "what changed?",
      text: "nothing important",
    };

    handleBtwEvent(evt);

    expect(state.activeChatRunId).toBe("run-main");
    expect(btw.showResult).toHaveBeenCalledWith({
      question: "what changed?",
      text: "nothing important",
      isError: undefined,
    });
    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("keeps a local BTW result visible when its empty final chat event arrives", () => {
    const { state, btw, loadHistory, noteLocalBtwRunId, handleBtwEvent, handleChatEvent } =
      createHandlersHarness({
        state: { activeChatRunId: null },
      });

    noteLocalBtwRunId("run-btw");
    handleBtwEvent({
      kind: "btw",
      runId: "run-btw",
      sessionKey: state.currentSessionKey,
      question: "what changed?",
      text: "nothing important",
    } satisfies BtwEvent);

    handleChatEvent({
      runId: "run-btw",
      sessionKey: state.currentSessionKey,
      state: "final",
    } satisfies ChatEvent);

    expect(loadHistory).not.toHaveBeenCalled();
    expect(btw.showResult).toHaveBeenCalledWith({
      question: "what changed?",
      text: "nothing important",
      isError: undefined,
    });
  });

  it("does not cross-match canonical session keys from different agents", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: {
        currentAgentId: "alpha",
        currentSessionKey: "agent:alpha:main",
        activeChatRunId: null,
      },
    });

    handleChatEvent({
      runId: "run-other-agent",
      sessionKey: "agent:beta:main",
      state: "delta",
      message: { content: "should be ignored" },
    });

    expect(chatLog.updateAssistant).not.toHaveBeenCalled();
  });

  it("clears run mapping when the session changes", () => {
    const { state, chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-old",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    });

    state.currentSessionKey = "agent:main:other";
    state.activeChatRunId = null;
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-old",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc2", name: "exec" },
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("accepts tool events after chat final for the same run", () => {
    const { state, chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-final",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }] },
    });

    handleAgentEvent({
      runId: "run-final",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-final", name: "session_status" },
    });

    expect(chatLog.startTool).toHaveBeenCalledWith("tc-final", "session_status", undefined);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("ignores lifecycle updates for non-active runs in the same session", () => {
    const { state, tui, setActivityStatus, handleChatEvent, handleAgentEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-active" },
      });

    handleChatEvent({
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    });
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-other",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("suppresses tool events when verbose is off", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-123",
        sessionInfo: { verboseLevel: "off" },
      },
    });

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-off", name: "session_status" },
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("omits tool output when verbose is on (non-full)", () => {
    const { chatLog, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-123",
        sessionInfo: { verboseLevel: "on" },
      },
    });

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "update",
        toolCallId: "tc-on",
        name: "session_status",
        partialResult: { content: [{ type: "text", text: "secret" }] },
      },
    });

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "result",
        toolCallId: "tc-on",
        name: "session_status",
        result: { content: [{ type: "text", text: "secret" }] },
        isError: false,
      },
    });

    expect(chatLog.updateToolResult).toHaveBeenCalledTimes(1);
    expect(chatLog.updateToolResult).toHaveBeenCalledWith(
      "tc-on",
      { content: [] },
      { isError: false },
    );
  });

  it("refreshes history after a non-local chat final", () => {
    const { state, loadHistory, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "external-run",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }] },
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("binds optimistic pending messages to the first gateway run id and skips history reload", () => {
    const { state, loadHistory, isLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null, pendingOptimisticUserMessage: true },
    });

    handleChatEvent({
      runId: "run-gateway",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }] },
    });

    expect(state.pendingOptimisticUserMessage).toBe(false);
    expect(state.activeChatRunId).toBeNull();
    expect(isLocalRunId("run-gateway")).toBe(false);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  function createConcurrentRunHarness(localContent = "partial") {
    const { state, chatLog, setActivityStatus, loadHistory, handleChatEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-active" },
      });

    handleChatEvent({
      runId: "run-active",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: localContent },
    });

    return { state, chatLog, setActivityStatus, loadHistory, handleChatEvent };
  }

  it("does not reload history or clear active run when another run final arrives mid-stream", () => {
    const { state, chatLog, setActivityStatus, loadHistory, handleChatEvent } =
      createConcurrentRunHarness("partial");

    loadHistory.mockClear();
    setActivityStatus.mockClear();

    handleChatEvent({
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "other final" }] },
    });

    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");

    handleChatEvent({
      runId: "run-active",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "continued" },
    });

    expect(chatLog.updateAssistant).toHaveBeenLastCalledWith("continued", "run-active");
  });

  it("suppresses non-local empty final placeholders during concurrent runs", () => {
    const { state, chatLog, loadHistory, handleChatEvent } =
      createConcurrentRunHarness("local stream");

    loadHistory.mockClear();
    chatLog.finalizeAssistant.mockClear();
    chatLog.dropAssistant.mockClear();

    handleChatEvent({
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [] },
    });

    expect(chatLog.finalizeAssistant).not.toHaveBeenCalledWith("(no output)", "run-other");
    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-other");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
  });

  it("renders final error text when chat final has no content but includes event errorMessage", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-error-envelope",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [] },
      errorMessage: '401 {"error":{"message":"Missing scopes: model.request"}}',
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    const [rendered] = chatLog.finalizeAssistant.mock.calls[0] ?? [];
    expect(String(rendered)).toContain("HTTP 401");
    expect(String(rendered)).toContain("Missing scopes: model.request");
    expect(chatLog.dropAssistant).not.toHaveBeenCalledWith("run-error-envelope");
  });

  it("shows a concise /auth hint for local auth failures", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      localMode: true,
      state: {
        activeChatRunId: null,
        sessionInfo: { modelProvider: "openai-codex" },
      },
    });

    handleChatEvent({
      runId: "run-auth-error",
      sessionKey: "agent:main:main",
      state: "error",
      errorMessage:
        "Authentication failed with an HTML 403 response from the provider. Re-authenticate and verify your provider account access.",
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith(
      "auth or provider access failed for openai-codex. Run /auth openai-codex to refresh credentials; if you already re-authed, switch models/providers because this account may still be blocked for inference.",
    );
  });

  it("drops streaming assistant when chat final has no message", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-silent",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    });
    chatLog.dropAssistant.mockClear();
    chatLog.finalizeAssistant.mockClear();

    handleChatEvent({
      runId: "run-silent",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-silent");
    expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
  });

  it("reloads history when a local run ends without a displayable final message", () => {
    const { state, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-local-silent" },
    });

    noteLocalRunId("run-local-silent");

    handleChatEvent({
      runId: "run-local-silent",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("does not reload history for local run with empty final when another run is active (#53115)", () => {
    const { state, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-main" },
    });

    noteLocalRunId("run-local-empty");

    handleChatEvent({
      runId: "run-local-empty",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(state.activeChatRunId).toBe("run-main");
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("flushes deferred history reload after the newer local run finishes", () => {
    const { state, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-main" },
    });

    noteLocalRunId("run-local-empty");
    handleChatEvent({
      runId: "run-local-empty",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    noteLocalRunId("run-main");
    handleChatEvent({
      runId: "run-main",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }] },
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});

describe("tui-event-handlers: streaming watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeState = (overrides?: Partial<TuiStateAccess>): TuiStateAccess => ({
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: "session-1",
    activeChatRunId: null,
    pendingOptimisticUserMessage: false,
    historyLoaded: true,
    sessionInfo: { verboseLevel: "on" },
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

  const createHarness = (options?: { streamingWatchdogMs?: number }) => {
    const state = makeState();
    const chatLog = createMockChatLog();
    const btw = createMockBtwPresenter();
    const tui = { requestRender: vi.fn() } as unknown as MockTui & HandlerTui;
    const setActivityStatus = vi.fn();
    const handlers = createEventHandlers({
      chatLog,
      btw,
      tui,
      state,
      setActivityStatus,
      streamingWatchdogMs: options?.streamingWatchdogMs,
    });
    return { state, chatLog, tui, setActivityStatus, handlers };
  };

  it("resets activityStatus to idle when no stream delta arrives for the watchdog window", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-stuck",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    } satisfies ChatEvent);

    expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");
    expect(state.activeChatRunId).toBe("run-stuck");

    vi.advanceTimersByTime(5_001);

    expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
    expect(state.activeChatRunId).toBeNull();
    expect(chatLog.addSystem).toHaveBeenCalledWith(expect.stringContaining("streaming watchdog"));

    handlers.dispose?.();
  });

  it("refreshes the watchdog window on each new stream delta", () => {
    const { state, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-flow",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "first" },
    } satisfies ChatEvent);

    vi.advanceTimersByTime(3_000);

    handlers.handleChatEvent({
      runId: "run-flow",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "second" },
    } satisfies ChatEvent);

    vi.advanceTimersByTime(3_000);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBe("run-flow");

    vi.advanceTimersByTime(2_500);

    expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
    expect(state.activeChatRunId).toBeNull();

    handlers.dispose?.();
  });

  it("cancels the watchdog when the run finalizes normally", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-normal",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hi" },
    } satisfies ChatEvent);
    handlers.handleChatEvent({
      runId: "run-normal",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    } satisfies ChatEvent);

    vi.advanceTimersByTime(10_000);

    const statusCalls = setActivityStatus.mock.calls.map((c) => c[0]);
    expect(statusCalls.filter((s) => s === "idle").length).toBe(1);
    expect(chatLog.addSystem).not.toHaveBeenCalledWith(
      expect.stringContaining("streaming watchdog"),
    );
    expect(state.activeChatRunId).toBeNull();

    handlers.dispose?.();
  });

  it("is disabled when streamingWatchdogMs is 0", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 0,
    });

    handlers.handleChatEvent({
      runId: "run-no-watchdog",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hi" },
    } satisfies ChatEvent);

    vi.advanceTimersByTime(60_000);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(chatLog.addSystem).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-no-watchdog");

    handlers.dispose?.();
  });

  it("does not let an older run steal the active run watchdog", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-old",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "old" },
    } satisfies ChatEvent);

    vi.advanceTimersByTime(5_001);
    expect(state.activeChatRunId).toBeNull();

    handlers.handleChatEvent({
      runId: "run-new",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "new" },
    } satisfies ChatEvent);
    expect(state.activeChatRunId).toBe("run-new");

    vi.advanceTimersByTime(3_000);

    handlers.handleChatEvent({
      runId: "run-old",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "old again" },
    } satisfies ChatEvent);

    vi.advanceTimersByTime(2_001);

    expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
    expect(state.activeChatRunId).toBeNull();
    expect(chatLog.addSystem).toHaveBeenCalledTimes(2);

    handlers.dispose?.();
  });

  it("dispose clears a pending watchdog without firing it", () => {
    const { setActivityStatus, chatLog, handlers, state } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-dispose",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hi" },
    } satisfies ChatEvent);

    handlers.dispose?.();
    vi.advanceTimersByTime(10_000);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(chatLog.addSystem).not.toHaveBeenCalled();
  });
});
