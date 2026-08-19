// Covers TUI event handler routing for keyboard and backend events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import {
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import { getPendingSubmitAcceptedRunId, type TuiPendingSubmit } from "./tui-submit-state.js";
import type {
  AgentEvent,
  BtwEvent,
  ChatEvent,
  SessionChangedEvent,
  SessionMessageEvent,
  TuiHistoryLoadResult,
  TuiStateAccess,
} from "./tui-types.js";

type MockFn = ReturnType<typeof vi.fn>;
type HandlerChatLog = {
  addLiveUser: (...args: unknown[]) => void;
  startTool: (...args: unknown[]) => void;
  updateToolResult: (...args: unknown[]) => void;
  addSystem: (...args: unknown[]) => void;
  addPendingSystem: (...args: unknown[]) => void;
  dismissPendingSystem: (...args: unknown[]) => void;
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
  addLiveUser: MockFn;
  startTool: MockFn;
  updateToolResult: MockFn;
  addSystem: MockFn;
  addPendingSystem: MockFn;
  dismissPendingSystem: MockFn;
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
    addLiveUser: vi.fn(),
    startTool: vi.fn(),
    updateToolResult: vi.fn(),
    addSystem: vi.fn(),
    addPendingSystem: vi.fn(),
    dismissPendingSystem: vi.fn(),
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

function requireFinalizedAssistantText(chatLog: MockChatLog, index = 0): string {
  const call = chatLog.finalizeAssistant.mock.calls.at(index);
  if (!call) {
    throw new Error(`expected finalizeAssistant call ${index}`);
  }
  return String(call[0]);
}

function sendingSubmit(runId: string, draftText = "pending"): TuiPendingSubmit {
  return { phase: "sending", runId, draftText };
}

function acceptedSubmit(runId: string, draftText: string | null = "pending"): TuiPendingSubmit {
  return { phase: "accepted", runId, draftText };
}

function makeTuiState(overrides: Partial<TuiStateAccess> = {}): TuiStateAccess {
  return {
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: "session-1",
    activeChatRunId: null,
    pendingSubmit: null,
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
  };
}

type ChatEventOverrides = Partial<ChatEvent> & { stopReason?: unknown };

function makeChatEvent(state: TuiStateAccess, overrides: ChatEventOverrides = {}): ChatEvent {
  return {
    runId: "run-1",
    sessionKey: state.currentSessionKey,
    state: "delta",
    ...overrides,
  };
}

function makeFinalChatEvent(
  state: TuiStateAccess,
  runId: string,
  overrides: ChatEventOverrides = {},
): ChatEvent {
  return makeChatEvent(state, {
    runId,
    state: "final",
    message: { content: [{ type: "text", text: "done" }] },
    ...overrides,
  });
}

function makeAgentEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    runId: "run-1",
    stream: "lifecycle",
    data: { phase: "start" },
    ...overrides,
  };
}

function makeSessionChangedEvent(
  state: TuiStateAccess,
  overrides: Partial<SessionChangedEvent> = {},
): SessionChangedEvent {
  return {
    sessionKey: state.currentSessionKey,
    ...overrides,
  };
}

function makeSessionMessageEvent(
  state: TuiStateAccess,
  overrides: Partial<SessionMessageEvent> = {},
): SessionMessageEvent {
  return {
    sessionKey: state.currentSessionKey,
    ...overrides,
  };
}

describe("tui-event-handlers: handleAgentEvent", () => {
  const makeState = (overrides?: Partial<TuiStateAccess>): TuiStateAccess =>
    makeTuiState({ activeChatRunId: "run-1", ...overrides });

  const makeContext = (state: TuiStateAccess) => {
    const chatLog = createMockChatLog();
    const btw = createMockBtwPresenter();
    const tui = { requestRender: vi.fn() } as unknown as MockTui & HandlerTui;
    const setActivityStatus = vi.fn();
    const loadHistory = vi.fn<() => Promise<TuiHistoryLoadResult>>(async () => ({
      loaded: true,
      runOutcome: { state: "completed" },
    }));
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
    refreshSessionInfo?: () => Promise<void>;
  }) => {
    const state = makeState(params?.state);
    const context = makeContext(state);
    const chatLog = (params?.chatLog ?? context.chatLog) as MockChatLog & HandlerChatLog;
    const rawHandlers = createEventHandlers({
      chatLog,
      btw: (params?.btw ?? context.btw) as MockBtwPresenter & HandlerBtwPresenter,
      tui: context.tui,
      state,
      localMode: params?.localMode,
      setActivityStatus: context.setActivityStatus,
      refreshSessionInfo: params?.refreshSessionInfo,
      loadHistory: context.loadHistory,
      noteLocalRunId: context.noteLocalRunId,
      isLocalRunId: context.isLocalRunId,
      forgetLocalRunId: context.forgetLocalRunId,
      clearLocalRunIds: context.clearLocalRunIds,
      isLocalBtwRunId: context.isLocalBtwRunId,
      forgetLocalBtwRunId: context.forgetLocalBtwRunId,
      clearLocalBtwRunIds: context.clearLocalBtwRunIds,
    });
    const handlers = {
      ...rawHandlers,
      handleChatEvent: (event: ChatEventOverrides) =>
        rawHandlers.handleChatEvent(makeChatEvent(state, event)),
      handleAgentEvent: (event: Partial<AgentEvent>) =>
        rawHandlers.handleAgentEvent(makeAgentEvent(event)),
      handleSessionsChangedEvent: (event: Partial<SessionChangedEvent> = {}) =>
        rawHandlers.handleSessionsChangedEvent(makeSessionChangedEvent(state, event)),
      handleSessionMessageEvent: (event: Partial<SessionMessageEvent> = {}) =>
        rawHandlers.handleSessionMessageEvent(makeSessionMessageEvent(state, event)),
    };
    return {
      ...context,
      state,
      chatLog,
      btw: (params?.btw ?? context.btw) as MockBtwPresenter & HandlerBtwPresenter,
      ...handlers,
    };
  };

  it("recovers a missed final from authoritative history after an event gap", async () => {
    const { state, loadHistory, reconcileHistoryAfterGap, setActivityStatus } =
      createHandlersHarness({ state: { activeChatRunId: "run-gap" } });

    reconcileHistoryAfterGap();

    expect(state.sessionProjection?.hasTransportGap).toBe(true);
    await vi.waitFor(() => expect(state.activeChatRunId).toBeNull());
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it("preserves an in-flight run when gap-recovery history reports it is still active", async () => {
    const { state, loadHistory, reconcileHistoryAfterGap, setActivityStatus } =
      createHandlersHarness({ state: { activeChatRunId: "run-gap" } });
    loadHistory.mockResolvedValue({
      loaded: true,
      runOutcome: { state: "active", runId: "run-gap" },
    });

    reconcileHistoryAfterGap();

    await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    expect(state.activeChatRunId).toBe("run-gap");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it("reloads the selected session after an event gap while no run is active", async () => {
    const { state, loadHistory, reconcileHistoryAfterGap } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    reconcileHistoryAfterGap();

    await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    expect(state.activeChatRunId).toBeNull();
  });

  it("invalidates old global-agent run ownership before accepting new-agent events", () => {
    const { state, chatLog, handleAgentEvent, dispose } = createHandlersHarness({
      state: {
        currentSessionKey: "global",
        currentAgentId: "work",
        activeChatRunId: "run-work",
      },
    });
    handleAgentEvent({
      runId: "run-work",
      sessionKey: "global",
      agentId: "work",
    });

    state.currentAgentId = "main";
    dispose();
    state.activeChatRunId = null;
    handleAgentEvent({
      runId: "run-work",
      sessionKey: "global",
      agentId: "work",
      stream: "tool",
      data: { phase: "start", toolCallId: "stale-tool", name: "exec", args: {} },
    });

    expect(state.activeChatRunId).toBeNull();
    expect(chatLog.startTool).not.toHaveBeenCalled();
  });

  it("renders one reconnect interruption and ignores repeated or late terminal output", () => {
    const { state, reconnectStreamingWatchdog, handleChatEvent, chatLog, setActivityStatus } =
      createHandlersHarness({
        state: { activeChatRunId: "run-stale", activityStatus: "streaming" },
      });

    reconnectStreamingWatchdog({ state: "interrupted" });
    reconnectStreamingWatchdog({ state: "interrupted" });
    handleChatEvent({
      runId: "run-stale",
      message: { role: "assistant", content: "late stale output" },
    });

    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(chatLog.addSystem).toHaveBeenCalledTimes(1);
    expect(chatLog.addSystem).toHaveBeenCalledWith("run aborted");
    expect(chatLog.updateAssistant).not.toHaveBeenCalled();
  });

  it("renders a reconnect failure through the terminal error presenter", () => {
    const { state, reconnectStreamingWatchdog, chatLog, setActivityStatus } = createHandlersHarness(
      {
        state: { activeChatRunId: "run-failed", activityStatus: "streaming" },
      },
    );

    reconnectStreamingWatchdog({ state: "failed", errorMessage: "provider failed" });

    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("error");
    expect(chatLog.addSystem).toHaveBeenCalledWith("run error: provider failed");
  });

  it.each([
    { name: "completed", outcome: { state: "completed" } as const },
    { name: "active", outcome: { state: "active", runId: "run-current" } as const },
  ])("reconciles a $name reconnect outcome without an interruption", ({ outcome }) => {
    const { state, reconnectStreamingWatchdog, handleChatEvent, chatLog, setActivityStatus } =
      createHandlersHarness({
        state: { activeChatRunId: "run-current", activityStatus: "streaming" },
      });
    handleChatEvent({ runId: "run-current", message: { content: "partial" } });
    chatLog.addSystem.mockClear();
    setActivityStatus.mockClear();

    reconnectStreamingWatchdog(outcome);

    expect(chatLog.addSystem).not.toHaveBeenCalledWith("run aborted");
    expect(state.activeChatRunId).toBe(outcome.state === "active" ? "run-current" : null);
    expect(setActivityStatus).toHaveBeenLastCalledWith(
      outcome.state === "active" ? "streaming" : "idle",
    );
  });

  it("processes tool events when runId matches activeChatRunId (even if sessionId differs)", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: { currentSessionId: "session-xyz", activeChatRunId: "run-123" },
    });

    const evt = makeAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "start",
        toolCallId: "tc1",
        name: "exec",
        args: { command: "echo hi" },
      },
    });

    handleAgentEvent(evt);

    expect(chatLog.startTool).toHaveBeenCalledWith(
      "tc1",
      "exec",
      { command: "echo hi" },
      "run-123",
    );
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("ignores tool events when runId does not match activeChatRunId", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-1" },
    });

    const evt = makeAgentEvent({
      runId: "run-2",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec" },
    });

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

    const evt = makeAgentEvent({
      runId: "run-9",
    });

    handleAgentEvent(evt);

    expect(setActivityStatus).toHaveBeenCalledWith("running");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("shows running for a system-injected run that never went through submit", () => {
    const { state, tui, setActivityStatus, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleAgentEvent({
      runId: "run-bridge",
      sessionKey: state.currentSessionKey,
    });

    expect(setActivityStatus).toHaveBeenCalledWith("running");
    expect(state.activeChatRunId).toBe("run-bridge");
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("does not adopt a system-injected lifecycle start from another session", () => {
    const { state, tui, setActivityStatus, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleAgentEvent({
      runId: "run-other",
      sessionKey: "agent:other:other",
    });

    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBeNull();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("does not let a system-injected run steal a concurrent active run", () => {
    const { state, setActivityStatus, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-user" },
    });

    handleAgentEvent({
      runId: "run-bridge",
      sessionKey: state.currentSessionKey,
    });
    handleAgentEvent({
      runId: "run-bridge",
      sessionKey: state.currentSessionKey,
      data: { phase: "finishing" },
    });
    handleAgentEvent({
      runId: "run-bridge",
      sessionKey: state.currentSessionKey,
      data: { phase: "end" },
    });

    expect(state.activeChatRunId).toBe("run-user");
    expect(setActivityStatus).not.toHaveBeenCalledWith("running");
    expect(setActivityStatus).not.toHaveBeenCalledWith("finishing context");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it("promotes a remaining system-injected run when the active run finishes", () => {
    const { state, setActivityStatus, handleAgentEvent, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-user" },
    });

    handleAgentEvent({
      runId: "run-bridge",
      sessionKey: state.currentSessionKey,
    });
    handleChatEvent({
      runId: "run-user",
      state: "final",
      message: { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    });

    expect(state.activeChatRunId).toBe("run-bridge");
    expect(setActivityStatus).toHaveBeenLastCalledWith("running");
  });

  it.each([
    {
      name: "the authoritative top-level stop reason",
      topLevelStopReason: "error",
      messageStopReason: "stop",
    },
    {
      name: "a legacy nested message stop reason",
      topLevelStopReason: undefined,
      messageStopReason: "error",
    },
  ])(
    "marks a completed response as failed using $name",
    ({ topLevelStopReason, messageStopReason }) => {
      const { state, chatLog, setActivityStatus, handleChatEvent } = createHandlersHarness({
        state: { activeChatRunId: "run-provider-error" },
      });

      handleChatEvent({
        runId: "run-provider-error",
        state: "final",
        ...(topLevelStopReason ? { stopReason: topLevelStopReason } : {}),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Provider response." }],
          stopReason: messageStopReason,
        },
      });

      expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
        "Provider response.",
        "run-provider-error",
      );
      expect(state.activeChatRunId).toBeNull();
      expect(setActivityStatus).toHaveBeenCalledWith("error");
      expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    },
  );

  it("renders terminal lifecycle errors after retry grace and clears the active run", () => {
    vi.useFakeTimers();
    const { state, chatLog, tui, setActivityStatus, loadHistory, handleAgentEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-error" },
      });

    handleAgentEvent({
      runId: "run-error",
      data: { phase: "error", endedAt: Date.now(), error: "provider exploded" },
    });

    expect(chatLog.addSystem).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-error");
    expect(setActivityStatus).toHaveBeenCalledWith("error");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15_000);

    expect(chatLog.dismissPendingSystem).toHaveBeenCalledWith("run-error");
    expect(chatLog.addSystem).toHaveBeenCalledWith("run error: provider exploded");
    expect(state.activeChatRunId).toBeNull();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("finalizes the authoritative buffered reply when a local run is aborted", () => {
    const {
      state,
      chatLog,
      loadHistory,
      noteLocalRunId,
      isLocalRunId,
      setActivityStatus,
      handleChatEvent,
    } = createHandlersHarness({
      state: { activeChatRunId: "run-aborted-partial" },
    });
    noteLocalRunId("run-aborted-partial");

    handleChatEvent({
      runId: "run-aborted-partial",
      seq: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Already visible" }],
      },
    });

    handleChatEvent({
      runId: "run-aborted-partial",
      seq: 2,
      state: "aborted",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Already visible and the throttled tail" }],
      },
    });

    expect(chatLog.updateAssistant).toHaveBeenCalledWith("Already visible", "run-aborted-partial");
    expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Already visible and the throttled tail",
      "run-aborted-partial",
    );
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
    expect(chatLog.dropAssistant).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(isLocalRunId("run-aborted-partial")).toBe(false);
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenLastCalledWith("aborted");
  });

  it("finalizes streamed partial text when an abort has no assistant payload", () => {
    const { state, chatLog, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-aborted-stream" },
    });
    noteLocalRunId("run-aborted-stream");

    handleChatEvent({
      runId: "run-aborted-stream",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Keep the streamed partial" }],
      },
    });

    handleChatEvent({
      runId: "run-aborted-stream",
      state: "aborted",
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Keep the streamed partial",
      "run-aborted-stream",
    );
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBeNull();
  });

  it.each([
    { name: "the authoritative abort reply", streamText: undefined, finalText: "(no output)" },
    { name: "a streamed partial reply", streamText: "(no output)", finalText: undefined },
  ])("preserves literal empty-placeholder text from $name", ({ streamText, finalText }) => {
    const { state, chatLog, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-aborted-literal" },
    });
    noteLocalRunId("run-aborted-literal");

    if (streamText !== undefined) {
      handleChatEvent({
        runId: "run-aborted-literal",
        message: {
          role: "assistant",
          content: [{ type: "text", text: streamText }],
        },
      });
    }

    handleChatEvent({
      runId: "run-aborted-literal",
      state: "aborted",
      ...(finalText === undefined
        ? {}
        : {
            message: {
              role: "assistant",
              content: [{ type: "text", text: finalText }],
            },
          }),
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "(no output)",
      "run-aborted-literal",
    );
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBeNull();
  });

  it.each([
    { name: "missing", message: undefined },
    { name: "empty", message: { role: "assistant", content: [] } },
    {
      name: "thinking-only",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hidden reasoning" }],
      },
    },
    {
      name: "non-text",
      message: {
        role: "assistant",
        content: [{ type: "image", source: { type: "base64", data: "image-data" } }],
      },
    },
  ])("does not create a placeholder for a $name aborted reply", ({ message }) => {
    const { state, chatLog, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-aborted-empty" },
    });
    noteLocalRunId("run-aborted-empty");

    handleChatEvent({
      runId: "run-aborted-empty",
      state: "aborted",
      message,
    });

    expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBeNull();
  });

  it("appends the tool-error summary to the abort line when present", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-validation-loop" },
    });

    handleChatEvent({
      runId: "run-validation-loop",
      state: "aborted",
      errorMessage: "edit tool validation failed: edits: must have required properties edits",
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith(
      "run aborted: edit tool validation failed: edits: must have required properties edits",
    );
  });

  it("sanitizes untrusted abort diagnostics before rendering", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-hostile" },
    });

    handleChatEvent({
      runId: "run-hostile",
      state: "aborted",
      errorMessage: "edit failed\u001b[31m\nsecret",
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith("run aborted: edit failed secret");
  });

  it("keeps truncated abort diagnostics on a UTF-16 boundary", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-emoji" },
    });

    const prefix = `${"word ".repeat(31)}abc`;
    handleChatEvent({
      runId: "run-emoji",
      state: "aborted",
      errorMessage: `${prefix}🚀tail`,
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith(`run aborted: ${prefix}…`);
  });

  it("falls back to a bare abort line when there is no summary", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-plain" },
    });

    handleChatEvent({
      runId: "run-plain",
      state: "aborted",
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith("run aborted");
  });

  it("deduplicates delayed chat errors after terminal lifecycle errors", () => {
    vi.useFakeTimers();
    const { state, chatLog, tui, handleAgentEvent, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-error" },
    });

    handleAgentEvent({
      runId: "run-error",
      data: { phase: "error", endedAt: Date.now(), error: "provider exploded" },
    });
    vi.advanceTimersByTime(15_000);

    handleChatEvent({
      runId: "run-error",
      state: "error",
      errorMessage: "provider exploded",
    });

    expect(chatLog.addSystem).toHaveBeenCalledTimes(1);
    expect(chatLog.addSystem).toHaveBeenCalledWith("run error: provider exploded");
    expect(state.activeChatRunId).toBeNull();
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("cancels pending terminal lifecycle errors when a retry starts", () => {
    vi.useFakeTimers();
    const { state, chatLog, setActivityStatus, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-retry" },
    });

    handleAgentEvent({
      runId: "run-retry",
      data: { phase: "error", endedAt: Date.now(), error: "provider exploded" },
    });

    handleAgentEvent({
      runId: "run-retry",
      data: { phase: "start", startedAt: Date.now() },
    });

    vi.advanceTimersByTime(15_000);

    expect(chatLog.addSystem).not.toHaveBeenCalledWith("run error: provider exploded");
    expect(state.activeChatRunId).toBe("run-retry");
    expect(setActivityStatus).toHaveBeenCalledWith("running");
    vi.useRealTimers();
  });

  it("keeps retryable lifecycle errors active until a terminal lifecycle event arrives", () => {
    const { state, chatLog, setActivityStatus, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-retryable" },
    });

    handleAgentEvent({
      runId: "run-retryable",
      data: { phase: "error", error: "primary model timed out" },
    });

    expect(chatLog.addSystem).not.toHaveBeenCalledWith("run error: primary model timed out");
    expect(state.activeChatRunId).toBe("run-retryable");
    expect(setActivityStatus).toHaveBeenCalledWith("error");
  });

  it("updates the displayed model from fallback lifecycle steps", () => {
    const { state, tui, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-fallback",
        sessionInfo: {
          verboseLevel: "on",
          modelProvider: "llamaforge",
          model: "qwen/qwen3.5-9b",
        },
      },
    });

    handleAgentEvent({
      runId: "run-fallback",
      data: {
        phase: "fallback_step",
        fallbackStepFinalOutcome: "next_fallback",
        fallbackStepFromModel: "openai/gpt-5.5",
        fallbackStepToModel: "openrouter/meta-llama/llama-3.1-70b",
      },
    });

    expect(state.sessionInfo.modelProvider).toBe("openrouter");
    expect(state.sessionInfo.model).toBe("meta-llama/llama-3.1-70b");
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("accepts fallback model updates for the pending run before chat registration", () => {
    const { state, tui, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: null,
        pendingSubmit: acceptedSubmit("run-pending"),
        sessionInfo: {
          verboseLevel: "on",
          modelProvider: "llamaforge",
          model: "qwen/qwen3.5-9b",
        },
      },
    });

    handleAgentEvent({
      runId: "run-pending",
      data: {
        phase: "fallback_step",
        fallbackStepFinalOutcome: "succeeded",
        fallbackStepFromModel: "openrouter/meta-llama/llama-3.1-70b",
        fallbackStepToModel: "nvidia/deepseek-ai/deepseek-v3.2",
      },
    });

    expect(state.sessionInfo.modelProvider).toBe("nvidia");
    expect(state.sessionInfo.model).toBe("deepseek-ai/deepseek-v3.2");
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("shows finishing context for a pending run before chat registration", () => {
    const { state, tui, setActivityStatus, handleAgentEvent, isLocalRunId } = createHandlersHarness(
      {
        state: {
          activeChatRunId: null,
          pendingSubmit: acceptedSubmit("run-pending"),
        },
      },
    );

    handleAgentEvent({
      runId: "run-pending",
      data: { phase: "finishing" },
    });

    expect(state.activeChatRunId).toBe("run-pending");
    expect(state.pendingSubmit).toBeNull();
    expect(isLocalRunId("run-pending")).toBe(true);
    expect(setActivityStatus).toHaveBeenCalledWith("finishing context");
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("does not claim another client's lifecycle event as the pending local run", () => {
    const { state, handleAgentEvent, isLocalRunId } = createHandlersHarness({
      state: {
        activeChatRunId: null,
        pendingSubmit: acceptedSubmit("run-pending"),
      },
    });

    handleAgentEvent({
      runId: "run-remote",
    });

    expect(state.activeChatRunId).toBeNull();
    expect(state.pendingSubmit?.runId).toBe("run-pending");
    expect(isLocalRunId("run-remote")).toBe(false);
  });

  it("does not reload history after lifecycle binds a gateway pending run", () => {
    const { state, chatLog, loadHistory, handleAgentEvent, handleChatEvent, isLocalRunId } =
      createHandlersHarness({
        state: {
          activeChatRunId: null,
          pendingSubmit: acceptedSubmit("run-pending"),
        },
      });

    handleAgentEvent({
      runId: "run-pending",
    });

    handleChatEvent(makeFinalChatEvent(state, "run-pending"));

    expect(state.pendingSubmit).toBeNull();
    expect(isLocalRunId("run-pending")).toBe(false);
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending");
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("preserves a pending local run when the session key catches up before the first event", () => {
    const { state, chatLog, loadHistory, noteLocalRunId, handleChatEvent, isLocalRunId } =
      createHandlersHarness({
        state: {
          currentSessionKey: "agent:main:initial",
          activeChatRunId: null,
          pendingSubmit: acceptedSubmit("run-pending"),
        },
      });
    noteLocalRunId("run-pending");
    state.currentSessionKey = "agent:main:restored";

    handleChatEvent(
      makeFinalChatEvent(state, "run-pending", { sessionKey: "agent:main:restored" }),
    );

    expect(state.pendingSubmit).toBeNull();
    expect(isLocalRunId("run-pending")).toBe(false);
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending");
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("shows finishing context for a known run after assistant final", () => {
    const { state, tui, setActivityStatus, handleChatEvent, handleAgentEvent } =
      createHandlersHarness({
        localMode: true,
        state: { activeChatRunId: null },
      });

    handleChatEvent(makeFinalChatEvent(state, "run-final"));
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-final",
      data: { phase: "finishing" },
    });

    expect(setActivityStatus).toHaveBeenCalledWith("finishing context");
    expect(tui.requestRender).toHaveBeenCalled();

    setActivityStatus.mockClear();
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-final",
      data: { phase: "end" },
    });

    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("keeps a local run finishing until its authoritative chat final", () => {
    const { state, tui, setActivityStatus, handleChatEvent, handleAgentEvent } =
      createHandlersHarness({
        localMode: true,
        state: {
          activeChatRunId: null,
          pendingSubmit: acceptedSubmit("run-local"),
        },
      });

    handleAgentEvent({
      runId: "run-local",
      data: { phase: "finishing" },
    });
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-local",
      data: { phase: "end" },
    });

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(tui.requestRender).toHaveBeenCalledWith(true);

    handleChatEvent(makeFinalChatEvent(state, "run-local"));

    expect(setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it("force-renders when terminal lifecycle end clears an active status", () => {
    const { tui, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-9" },
    });

    handleAgentEvent({
      runId: "run-9",
      data: { phase: "end" },
    });

    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("does not let delayed finalized-run lifecycle clobber a newer active run", () => {
    const { state, tui, setActivityStatus, handleChatEvent, handleAgentEvent } =
      createHandlersHarness({
        state: { activeChatRunId: null },
      });

    handleChatEvent({
      runId: "run-old",
      state: "final",
      message: { content: [{ type: "text", text: "old done" }] },
    });
    handleChatEvent({
      runId: "run-new",
      message: { content: "new running" },
    });
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-old",
      data: { phase: "finishing" },
    });
    handleAgentEvent({
      runId: "run-old",
      data: { phase: "end" },
    });

    expect(state.activeChatRunId).toBe("run-new");
    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("ignores fallback model updates for unrelated runs", () => {
    const { state, tui, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-active",
        sessionInfo: { verboseLevel: "on", modelProvider: "openai", model: "gpt-5.5" },
      },
    });

    handleAgentEvent({
      runId: "run-other",
      data: { phase: "fallback_step", fallbackStepToModel: "openrouter/other-model" },
    });

    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.model).toBe("gpt-5.5");
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("captures runId from chat events when activeChatRunId is unset", () => {
    const { state, chatLog, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    const chatEvt = makeChatEvent(state, {
      runId: "run-42",
      message: { content: "hello" },
    });

    handleChatEvent(chatEvt);

    expect(state.activeChatRunId).toBe("run-42");

    const agentEvt = makeAgentEvent({
      runId: "run-42",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec" },
    });

    handleAgentEvent(agentEvt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", undefined, "run-42");
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
      message: { content: "hello" },
    });

    expect(state.activeChatRunId).toBe("run-alias");
    expect(chatLog.updateAssistant).toHaveBeenCalledWith("hello", "run-alias");
  });

  it("protects concurrent lifecycle-confirmed streams from an orphan delta flood", () => {
    const { state, chatLog, setActivityStatus, handleAgentEvent, handleChatEvent } =
      createHandlersHarness({
        state: { activeChatRunId: null },
      });

    handleChatEvent({
      runId: "run-first",
      message: { content: [{ type: "text", text: "first live response" }] },
    });
    handleAgentEvent({
      runId: "run-second",
      sessionKey: state.currentSessionKey,
    });
    handleChatEvent({
      runId: "run-second",
      message: { content: [{ type: "text", text: "second live response" }] },
    });

    for (let index = 0; index < 500; index += 1) {
      handleChatEvent({
        runId: `run-orphan-${index}`,
        message: { content: [{ type: "text", text: `orphan ${index}` }] },
      });
    }

    expect(state.activeChatRunId).toBe("run-first");
    handleChatEvent({
      runId: "run-second",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(state.activeChatRunId).toBe("run-first");
    handleChatEvent({
      runId: "run-first",
      state: "final",
      message: { role: "assistant", content: [] },
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("second live response", "run-second");
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("first live response", "run-first");
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it("promotes the confirmed concurrent run instead of a newer orphan delta", () => {
    const {
      state,
      chatLog,
      loadHistory,
      setActivityStatus,
      handleAgentEvent,
      handleChatEvent,
      handleSessionMessageEvent,
      handleSessionsChangedEvent,
    } = createHandlersHarness({ state: { activeChatRunId: null } });

    handleChatEvent({
      runId: "run-first",
      message: { content: [{ type: "text", text: "first live response" }] },
    });
    handleAgentEvent({
      runId: "run-second",
      sessionKey: state.currentSessionKey,
    });
    handleChatEvent({
      runId: "run-second",
      message: { content: [{ type: "text", text: "second live response" }] },
    });

    for (let index = 0; index < 500; index += 1) {
      handleChatEvent({
        runId: `run-orphan-${index}`,
        message: { content: [{ type: "text", text: `orphan ${index}` }] },
      });
    }

    handleSessionMessageEvent(makeSessionMessageEvent(state, { updatedAt: 200 }));
    expect(loadHistory).not.toHaveBeenCalled();

    handleChatEvent({
      runId: "run-first",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(state.activeChatRunId).toBe("run-second");

    handleChatEvent({
      runId: "run-second",
      state: "final",
      message: { role: "assistant", content: [] },
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("first live response", "run-first");
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("second live response", "run-second");
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");

    for (const runId of ["run-first", "run-second"]) {
      handleSessionsChangedEvent({
        runId,
        phase: "end",
      });
    }
    expect(loadHistory).toHaveBeenCalledTimes(1);

    const displayedDeltaCount = chatLog.updateAssistant.mock.calls.length;
    handleChatEvent({
      runId: "run-orphan-499",
      message: { content: [{ type: "text", text: "late orphan" }] },
    });
    expect(state.activeChatRunId).toBeNull();
    expect(chatLog.updateAssistant).toHaveBeenCalledTimes(displayedDeltaCount);

    handleChatEvent({
      runId: "run-never-seen-orphan",
      message: { content: [{ type: "text", text: "untracked late orphan" }] },
    });
    expect(state.activeChatRunId).toBeNull();
    expect(chatLog.updateAssistant).toHaveBeenCalledTimes(displayedDeltaCount);
  });

  it("keeps a lifecycle-less concurrent response when a confirmed owner finishes", () => {
    const { state, chatLog, setActivityStatus, handleAgentEvent, handleChatEvent } =
      createHandlersHarness({ state: { activeChatRunId: null } });

    handleAgentEvent({
      runId: "run-confirmed",
      sessionKey: state.currentSessionKey,
    });
    handleChatEvent({
      runId: "run-confirmed",
      message: { content: [{ type: "text", text: "confirmed response" }] },
    });
    handleChatEvent({
      runId: "run-without-lifecycle",
      seq: 1,
      message: { content: [{ type: "text", text: "older peer response" }] },
    });

    handleChatEvent({
      runId: "run-confirmed",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(state.activeChatRunId).toBe("run-without-lifecycle");

    handleChatEvent({
      runId: "run-without-lifecycle",
      seq: 2,
      state: "final",
      message: { role: "assistant", content: [] },
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "older peer response",
      "run-without-lifecycle",
    );
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it("preserves a sequenced lifecycle-less peer behind a confirmed run handoff", () => {
    const { state, chatLog, setActivityStatus, handleAgentEvent, handleChatEvent } =
      createHandlersHarness({ state: { activeChatRunId: null } });

    handleChatEvent({
      runId: "run-first",
      message: { content: [{ type: "text", text: "first live response" }] },
    });
    handleAgentEvent({
      runId: "run-confirmed",
      sessionKey: state.currentSessionKey,
    });
    handleChatEvent({
      runId: "run-confirmed",
      message: { content: [{ type: "text", text: "confirmed response" }] },
    });
    handleChatEvent({
      runId: "run-without-lifecycle",
      seq: 1,
      message: { content: [{ type: "text", text: "older peer response" }] },
    });
    handleChatEvent({
      runId: "run-orphan",
      message: { content: [{ type: "text", text: "unconfirmed orphan" }] },
    });

    handleChatEvent({
      runId: "run-first",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(["run-confirmed", "run-without-lifecycle"]).toContain(state.activeChatRunId);

    for (const runId of ["run-confirmed", "run-without-lifecycle"]) {
      handleChatEvent({
        runId,
        ...(runId === "run-without-lifecycle" ? { seq: 2 } : {}),
        state: "final",
        message: { role: "assistant", content: [] },
      });
    }

    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "older peer response",
      "run-without-lifecycle",
    );
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it.each([
    {
      provider: "Matrix",
      selectedSessionKey: "agent:main:matrix:channel:!MixedRoom:example.org",
      otherSessionKey: "agent:main:matrix:channel:!mixedroom:example.org",
    },
    {
      provider: "Signal",
      selectedSessionKey: "agent:main:signal:group:AbC123=",
      otherSessionKey: "agent:main:signal:group:abc123=",
    },
  ])(
    "isolates case-distinct $provider session events across every TUI event surface",
    ({ selectedSessionKey, otherSessionKey }) => {
      const {
        state,
        chatLog,
        btw,
        loadHistory,
        handleChatEvent,
        handleAgentEvent,
        handleBtwEvent,
        handleSessionsChangedEvent,
        handleSessionMessageEvent,
      } = createHandlersHarness({
        state: {
          activeChatRunId: null,
          currentSessionKey: selectedSessionKey,
          currentSessionId: "selected-session",
          sessionInfo: { verboseLevel: "on", updatedAt: 100 },
        },
      });

      handleChatEvent({
        runId: "run-other-session",
        sessionKey: otherSessionKey,
        message: { content: "message from another conversation" },
      });
      handleAgentEvent({
        runId: "run-other-lifecycle",
        sessionKey: otherSessionKey,
      });
      handleBtwEvent({
        kind: "btw",
        runId: "run-other-btw",
        sessionKey: otherSessionKey,
        question: "other conversation?",
        text: "private answer",
      } satisfies BtwEvent);
      handleSessionsChangedEvent({
        sessionKey: otherSessionKey,
        reason: "reset",
        sessionId: "other-session",
        updatedAt: 200,
      });
      handleSessionMessageEvent({
        sessionKey: otherSessionKey,
        agentId: "main",
        sessionId: "other-session",
        updatedAt: 200,
      });

      expect(chatLog.updateAssistant).not.toHaveBeenCalled();
      expect(btw.showResult).not.toHaveBeenCalled();
      expect(loadHistory).not.toHaveBeenCalled();
      expect(state.activeChatRunId).toBeNull();
      expect(state.currentSessionKey).toBe(selectedSessionKey);
      expect(state.currentSessionId).toBe("selected-session");
      expect(state.sessionInfo.updatedAt).toBe(100);
    },
  );

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
    const { state, btw, loadHistory, noteLocalBtwRunId, tui, handleBtwEvent, handleChatEvent } =
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
    tui.requestRender.mockClear();

    handleChatEvent({
      runId: "run-btw",
      state: "final",
    });

    expect(loadHistory).not.toHaveBeenCalled();
    expect(btw.showResult).toHaveBeenCalledWith({
      question: "what changed?",
      text: "nothing important",
      isError: undefined,
    });
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("clears stale streaming for a local BTW empty final without hiding the result", () => {
    const {
      state,
      btw,
      loadHistory,
      setActivityStatus,
      noteLocalBtwRunId,
      handleBtwEvent,
      handleChatEvent,
    } = createHandlersHarness({
      state: { activeChatRunId: null, activityStatus: "streaming" },
    });

    noteLocalBtwRunId("run-btw");
    handleBtwEvent({
      kind: "btw",
      runId: "run-btw",
      sessionKey: state.currentSessionKey,
      question: "what changed?",
      text: "nothing important",
    } satisfies BtwEvent);
    setActivityStatus.mockClear();

    handleChatEvent({
      runId: "run-btw",
      state: "final",
    });

    expect(state.activeChatRunId).toBeNull();
    expect(state.activityStatus).toBe("idle");
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
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
      message: { content: "should be ignored" },
    });

    expect(chatLog.updateAssistant).not.toHaveBeenCalled();
  });

  it("ignores selected-global chat events from other agents", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: {
        agentDefaultId: "main",
        currentAgentId: "work",
        currentSessionKey: "global",
        activeChatRunId: null,
      },
    });

    handleChatEvent({
      runId: "run-main-global",
      agentId: "main",
      message: { content: "wrong agent" },
    });
    handleChatEvent({
      runId: "run-legacy-default-global",
      message: { content: "legacy default" },
    });

    expect(chatLog.updateAssistant).not.toHaveBeenCalled();
  });

  it("ignores selected-global BTW events from other agents", () => {
    const { btw, handleBtwEvent } = createHandlersHarness({
      state: {
        agentDefaultId: "main",
        currentAgentId: "work",
        currentSessionKey: "global",
      },
    });

    handleBtwEvent({
      kind: "btw",
      runId: "btw-main-global",
      sessionKey: "global",
      agentId: "main",
      question: "status?",
      text: "wrong agent",
    });

    expect(btw.showResult).not.toHaveBeenCalled();
  });

  it("clears run mapping when the session changes", () => {
    const { state, chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-old",
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

  it("reloads the current session and clears stale run state after sessions.changed reset", () => {
    const refreshSessionInfo = vi.fn<() => Promise<void>>(async () => undefined);
    const {
      state,
      chatLog,
      btw,
      tui,
      loadHistory,
      setActivityStatus,
      noteLocalRunId,
      isLocalRunId,
      handleChatEvent,
      handleAgentEvent,
      handleSessionsChangedEvent,
    } = createHandlersHarness({
      state: {
        activeChatRunId: null,
        currentSessionId: "session-before",
        sessionInfo: { verboseLevel: "on", updatedAt: 100 },
      },
      refreshSessionInfo,
    });

    handleChatEvent(makeFinalChatEvent(state, "run-old"));
    noteLocalRunId("run-local");
    state.activeChatRunId = "run-stale";
    state.pendingSubmit = acceptedSubmit("run-pending");
    state.activityStatus = "streaming";
    loadHistory.mockClear();
    refreshSessionInfo.mockClear();
    chatLog.startTool.mockClear();
    btw.clear.mockClear();
    tui.requestRender.mockClear();
    setActivityStatus.mockClear();

    handleSessionsChangedEvent({
      sessionKey: "main",
      reason: "reset",
      sessionId: "session-after",
      updatedAt: 200,
    });

    expect(state.activeChatRunId).toBeNull();
    expect(state.pendingSubmit).toBeNull();
    expect(state.activityStatus).toBe("idle");
    expect(state.currentSessionId).toBe("session-after");
    expect(state.sessionProjection?.scope.sessionId).toBe("session-after");
    expect(state.sessionProjection?.runs).toEqual({});
    expect(state.sessionInfo.updatedAt).toBe(200);
    expect(isLocalRunId("run-local")).toBe(false);
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(btw.clear).toHaveBeenCalledTimes(1);
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(refreshSessionInfo).not.toHaveBeenCalled();
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    handleAgentEvent({
      runId: "run-old",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-old", name: "exec" },
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
  });

  it("reloads the selected session for an identity-only legacy batch invalidation", () => {
    const { state, loadHistory, handleSessionsChangedEvent } = createHandlersHarness({
      state: { activeChatRunId: null, currentSessionId: "session-1" },
    });

    handleSessionsChangedEvent({
      agentId: state.currentAgentId,
      sessionId: "session-1",
      phase: "message",
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(state.activeChatRunId).toBeNull();
  });

  it("preserves an active response during legacy batch history recovery", () => {
    const pendingSubmit = acceptedSubmit("run-pending");
    const { state, chatLog, btw, loadHistory, setActivityStatus, handleSessionsChangedEvent } =
      createHandlersHarness({
        state: {
          activeChatRunId: "run-active",
          activityStatus: "streaming",
          currentSessionId: "session-1",
          pendingSubmit,
        },
      });

    handleSessionsChangedEvent({
      agentId: state.currentAgentId,
      sessionId: "session-1",
      phase: "message",
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(state.activeChatRunId).toBe("run-active");
    expect(state.activityStatus).toBe("streaming");
    expect(state.pendingSubmit).toBe(pendingSubmit);
    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(chatLog.dropAssistant).not.toHaveBeenCalled();
    expect(btw.clear).not.toHaveBeenCalled();
  });

  it("ignores a legacy batch invalidation for a different session incarnation", () => {
    const { state, loadHistory, handleSessionsChangedEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-active", currentSessionId: "session-current" },
    });

    handleSessionsChangedEvent({
      agentId: state.currentAgentId,
      sessionId: "session-other",
      phase: "message",
    });

    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.currentSessionId).toBe("session-current");
    expect(state.activeChatRunId).toBe("run-active");
  });

  it("ignores another agent's identity-only global batch invalidation", () => {
    const { state, loadHistory, handleSessionsChangedEvent } = createHandlersHarness({
      state: {
        agentDefaultId: "main",
        currentAgentId: "work",
        currentSessionKey: "global",
        currentSessionId: "session-work",
        activeChatRunId: "run-active",
      },
    });

    handleSessionsChangedEvent({
      sessionKey: "global",
      agentId: "main",
      sessionId: "session-work",
      phase: "message",
    });

    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
  });

  it.each([
    { name: "a persisted message identity", identity: { messageId: "message-1" } },
    { name: "a persisted message sequence", identity: { messageSeq: 7 } },
    { name: "a concrete message", identity: { message: { role: "user", content: "hello" } } },
    { name: "a run identity", identity: { runId: "run-message" } },
    { name: "a client run identity", identity: { clientRunId: "run-message" } },
  ])("does not reload an ordinary message-phase event with $name", ({ identity }) => {
    const { state, loadHistory, handleSessionsChangedEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-active", currentSessionId: "session-1" },
    });

    handleSessionsChangedEvent({
      agentId: state.currentAgentId,
      sessionId: "session-1",
      phase: "message",
      ...identity,
    });

    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
  });

  it("ignores sessions.changed reset events for other sessions", () => {
    const { state, loadHistory, setActivityStatus, handleSessionsChangedEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-current", activityStatus: "streaming" },
      });

    handleSessionsChangedEvent({
      sessionKey: "agent:other:main",
      reason: "reset",
    });

    expect(state.activeChatRunId).toBe("run-current");
    expect(state.activityStatus).toBe("streaming");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it("ignores selected-global sessions.changed reset events from other agents", () => {
    const { state, loadHistory, setActivityStatus, handleSessionsChangedEvent } =
      createHandlersHarness({
        state: {
          agentDefaultId: "main",
          currentAgentId: "work",
          currentSessionKey: "global",
          activeChatRunId: "run-current",
          activityStatus: "streaming",
        },
      });

    handleSessionsChangedEvent({
      sessionKey: "global",
      agentId: "main",
      reason: "reset",
      sessionId: "session-other-agent",
      updatedAt: 300,
    });

    expect(state.activeChatRunId).toBe("run-current");
    expect(state.activityStatus).toBe("streaming");
    expect(state.currentSessionId).not.toBe("session-other-agent");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it("accepts tool events after chat final for the same run", () => {
    const { state, chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent(makeFinalChatEvent(state, "run-final"));

    handleAgentEvent({
      runId: "run-final",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-final", name: "session_status" },
    });

    expect(chatLog.startTool).toHaveBeenCalledWith(
      "tc-final",
      "session_status",
      undefined,
      "run-final",
    );
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("ignores lifecycle updates for non-active runs in the same session", () => {
    const { tui, setActivityStatus, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-active" },
    });

    handleChatEvent({
      runId: "run-other",
      message: { content: "hello" },
    });
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-other",
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

  it("does not reload history on final with displayable text for external runs (#87922)", () => {
    const { state, chatLog, loadHistory, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    // Simulate an external (non-local) run delivering a final event with text.
    // loadHistory() must NOT be called because it does clearAll() + rebuild
    // from server data, and the server may not have persisted this message
    // yet, causing the just-rendered message to vanish.
    handleChatEvent({
      runId: "run-external",
      state: "final",
      message: { content: [{ type: "text", text: "assistant reply" }] },
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
      expect.stringContaining("assistant reply"),
      "run-external",
    );
    expect(state.sessionProjection?.entries[0]?.message).toMatchObject({
      role: "assistant",
      content: "assistant reply",
    });
    reduceTuiSessionProjection(state, {
      type: "snapshotLoaded",
      messages: [],
      scope: readTuiSessionProjectionScope(state),
    });
    expect(state.sessionProjection?.entries[0]?.message).toMatchObject({
      role: "assistant",
      content: "assistant reply",
    });
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("finalizes an attachment-only assistant reply instead of dropping it", () => {
    const { chatLog, loadHistory, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-external-image",
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "image",
            data: "secret-image",
            url: "file:///Users/operator/private/image.png",
          },
        ],
      },
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("Attached image", "run-external-image");
    expect(chatLog.dropAssistant).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it.each(["input_text", "output_text"] as const)(
    "does not preserve canonical %s as an attachment in the optimistic projection",
    (type) => {
      const { state, chatLog, handleChatEvent } = createHandlersHarness({
        state: { activeChatRunId: null },
      });

      handleChatEvent({
        runId: `run-${type}`,
        state: "final",
        message: { role: "assistant", content: [{ type, text: "One visible reply." }] },
      });

      expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("One visible reply.", `run-${type}`);
      expect(state.sessionProjection?.entries[0]?.message).toMatchObject({
        role: "assistant",
        content: "One visible reply.",
      });
    },
  );

  it("preserves the assembled delta-only final across an older history snapshot", () => {
    const { state, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-streamed-final" },
    });
    const sessionKey = state.currentSessionKey;
    handleChatEvent({
      runId: "run-streamed-final",
      sessionKey,
      seq: 1,
      message: { role: "assistant", content: "Assembled streamed reply." },
    });
    handleChatEvent({
      runId: "run-streamed-final",
      sessionKey,
      seq: 2,
      state: "final",
      message: { role: "assistant", content: [] },
    });

    reduceTuiSessionProjection(state, {
      type: "snapshotLoaded",
      messages: [],
      scope: readTuiSessionProjectionScope(state),
    });

    expect(state.sessionProjection?.entries[0]?.message).toMatchObject({
      role: "assistant",
      content: "Assembled streamed reply.",
    });
  });

  it("reloads history on final when external run has no message", () => {
    const { chatLog, loadHistory, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    // When the final event has no message, the reload is needed to sync
    // with server state since there is no local content to preserve.
    handleChatEvent({
      runId: "run-external-empty",
      state: "final",
    });

    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-external-empty");
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("forces render when a command final only adds system text", () => {
    const { chatLog, tui, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-command" },
    });

    handleChatEvent({
      runId: "run-command",
      state: "final",
      message: {
        command: true,
        content: [{ type: "text", text: "/status done" }],
      },
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith("/status done");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("binds optimistic pending messages to the first gateway run id and skips history reload", () => {
    const { state, loadHistory, noteLocalRunId, isLocalRunId, handleChatEvent } =
      createHandlersHarness({
        state: { activeChatRunId: null, pendingSubmit: sendingSubmit("run-gateway") },
      });
    noteLocalRunId("run-gateway");

    handleChatEvent(makeFinalChatEvent(state, "run-gateway"));

    expect(state.pendingSubmit).toBeNull();
    expect(state.activeChatRunId).toBeNull();
    expect(isLocalRunId("run-gateway")).toBe(false);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("keeps pending user text after run binding until history catches up", () => {
    const pendingUsers = new Map([["run-gateway", "queued hello"]]);
    const chatLog = {
      ...createMockChatLog(),
      countPendingUsers: () => pendingUsers.size,
      render: (_width: number) => Array.from(pendingUsers.values()),
    };
    const { state, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      chatLog: chatLog as unknown as HandlerChatLog,
      state: {
        activeChatRunId: null,
        pendingSubmit: sendingSubmit("run-gateway", "queued hello"),
      },
    });
    noteLocalRunId("run-gateway");

    handleChatEvent({
      runId: "run-gateway",
      message: { content: "working" },
    });

    expect(state.pendingSubmit).toBeNull();
    expect(chatLog.countPendingUsers()).toBe(1);
    expect(chatLog.render(120).join("\n")).toContain("queued hello");
  });

  it("does not bind unknown gateway run ids while an optimistic message is pending", () => {
    const { state, loadHistory, isLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null, pendingSubmit: sendingSubmit("run-pending") },
    });

    handleChatEvent(makeFinalChatEvent(state, "run-unknown"));

    expect(state.pendingSubmit).toEqual(sendingSubmit("run-pending"));
    expect(state.activeChatRunId).toBeNull();
    expect(isLocalRunId("run-unknown")).toBe(false);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("binds a pending run final to the optimistic message even while another run is active", () => {
    const { state, chatLog, loadHistory, isLocalRunId, handleChatEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-active",
        pendingSubmit: acceptedSubmit("run-pending"),
      },
    });

    handleChatEvent(makeFinalChatEvent(state, "run-pending"));

    expect(state.pendingSubmit).toBeNull();
    expect(state.activeChatRunId).toBe("run-active");
    expect(isLocalRunId("run-pending")).toBe(false);
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending");
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("does not let unrelated same-session events claim a pending optimistic run", () => {
    const { state, chatLog, loadHistory, noteLocalRunId, isLocalRunId, handleChatEvent } =
      createHandlersHarness({
        state: {
          activeChatRunId: null,
          pendingSubmit: acceptedSubmit("run-pending"),
        },
      });
    noteLocalRunId("run-pending");

    handleChatEvent({
      runId: "run-other",
      state: "final",
      message: { content: [{ type: "text", text: "other done" }] },
    });

    expect(getPendingSubmitAcceptedRunId(state)).toBe("run-pending");
    expect(isLocalRunId("run-other")).toBe(false);
    expect(loadHistory).not.toHaveBeenCalled();

    handleChatEvent(makeFinalChatEvent(state, "run-pending"));

    expect(state.pendingSubmit).toBeNull();
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending");
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("does not let the active local run claim a queued optimistic run", () => {
    const { state, loadHistory, noteLocalRunId, isLocalRunId, handleChatEvent } =
      createHandlersHarness({
        state: {
          activeChatRunId: "run-active",
          pendingSubmit: acceptedSubmit("run-pending"),
        },
      });
    noteLocalRunId("run-active");
    noteLocalRunId("run-pending");

    handleChatEvent({
      runId: "run-active",
      state: "final",
      message: { content: [{ type: "text", text: "active done" }] },
    });

    expect(getPendingSubmitAcceptedRunId(state)).toBe("run-pending");
    expect(isLocalRunId("run-active")).toBe(false);
    expect(isLocalRunId("run-pending")).toBe(true);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("binds an early final before submit acceptance is recorded", () => {
    const { state, chatLog, loadHistory, noteLocalRunId, isLocalRunId, handleChatEvent } =
      createHandlersHarness({
        state: {
          activeChatRunId: "run-active",
          pendingSubmit: sendingSubmit("run-early-final"),
        },
      });
    noteLocalRunId("run-early-final");

    handleChatEvent(makeFinalChatEvent(state, "run-early-final"));

    expect(state.pendingSubmit).toBeNull();
    expect(state.activeChatRunId).toBe("run-active");
    expect(isLocalRunId("run-early-final")).toBe(false);
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("done", "run-early-final");
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("clears the accepted pending submit when its event arrives", () => {
    const { state, handleChatEvent } = createHandlersHarness({
      state: {
        activeChatRunId: null,
        pendingSubmit: acceptedSubmit("run-pending"),
      },
    });

    handleChatEvent({
      runId: "run-pending",
      message: { content: "hi" },
    });

    expect(state.pendingSubmit).toBeNull();
    expect(state.activeChatRunId).toBe("run-pending");
  });

  function createConcurrentRunHarness(localContent = "partial") {
    const { state, chatLog, setActivityStatus, loadHistory, handleChatEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-active" },
      });

    handleChatEvent({
      runId: "run-active",
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
      state: "final",
      message: { content: [{ type: "text", text: "other final" }] },
    });

    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");

    handleChatEvent({
      runId: "run-active",
      message: { content: "continued" },
    });

    expect(chatLog.updateAssistant).toHaveBeenLastCalledWith("continued", "run-active");
  });

  it("clears stale streaming when an orphan final arrives and no tracked run remains", () => {
    const { state, setActivityStatus, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-stale", activityStatus: "streaming" },
    });

    handleChatEvent(makeFinalChatEvent(state, "run-orphan"));

    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it("clears stale streaming when a duplicate final arrives after inactive /btw terminal cleanup", () => {
    const { state, setActivityStatus, noteLocalBtwRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null, activityStatus: "streaming" },
    });

    handleChatEvent(makeFinalChatEvent(state, "run-finalized"));

    noteLocalBtwRunId("run-btw-error");
    handleChatEvent({
      runId: "run-btw-error",
      message: { content: "background status update" },
    });
    handleChatEvent({
      runId: "run-btw-error",
      state: "error",
      errorMessage: "background failure",
    });

    expect(state.activeChatRunId).toBeNull();
    expect(state.activityStatus).toBe("streaming");
    setActivityStatus.mockClear();

    handleChatEvent(makeFinalChatEvent(state, "run-finalized"));

    expect(state.activeChatRunId).toBeNull();
    expect(state.activityStatus).toBe("idle");
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it("flushes deferred history reload after stale streaming clear makes the TUI idle", () => {
    const { state, loadHistory, noteLocalRunId, setActivityStatus, handleChatEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-stale", activityStatus: "streaming" },
      });

    noteLocalRunId("run-local-empty");
    loadHistory.mockImplementation(async () => {
      expect(state.activeChatRunId).toBeNull();
      expect(state.activityStatus).toBe("idle");
      return { loaded: true, runOutcome: { state: "completed" } };
    });

    handleChatEvent({
      runId: "run-local-empty",
      state: "final",
    });

    expect(state.activeChatRunId).toBeNull();
    expect(state.activityStatus).toBe("idle");
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("does not surface inactive orphan final failures as the global status", () => {
    const { state, setActivityStatus, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-stale", activityStatus: "streaming" },
    });

    handleChatEvent({
      runId: "run-orphan-error",
      state: "final",
      message: { content: [{ type: "text", text: "failed" }], stopReason: "error" },
    });

    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(setActivityStatus).not.toHaveBeenCalledWith("error");
  });

  it("does not clear global streaming for inactive local /btw aborted or error events", () => {
    const { state, setActivityStatus, noteLocalBtwRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null, activityStatus: "streaming" },
    });

    for (const terminalState of ["aborted", "error"] as const) {
      const runId = `run-btw-${terminalState}`;
      state.activeChatRunId = null;
      state.activityStatus = "streaming";
      setActivityStatus.mockClear();
      noteLocalBtwRunId(runId);

      handleChatEvent({
        runId,
        state: terminalState,
        errorMessage: terminalState === "error" ? "boom" : undefined,
      });

      expect(state.activeChatRunId).toBeNull();
      expect(state.activityStatus).toBe("streaming");
      expect(setActivityStatus).not.toHaveBeenCalled();
    }
  });

  it("does not force idle for an inactive final while another tracked run is active", () => {
    const { state, setActivityStatus, handleChatEvent } = createConcurrentRunHarness("partial");
    state.activityStatus = "streaming";
    setActivityStatus.mockClear();

    handleChatEvent({
      runId: "run-other",
      state: "final",
      message: { content: [{ type: "text", text: "other final" }] },
    });

    expect(state.activeChatRunId).toBe("run-active");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it("suppresses non-local empty final placeholders during concurrent runs", () => {
    const { state, chatLog, loadHistory, handleChatEvent } =
      createConcurrentRunHarness("local stream");

    loadHistory.mockClear();
    chatLog.finalizeAssistant.mockClear();
    chatLog.dropAssistant.mockClear();

    handleChatEvent({
      runId: "run-other",
      state: "final",
      message: { content: [] },
    });

    expect(chatLog.finalizeAssistant).not.toHaveBeenCalledWith("(no output)", "run-other");
    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-other");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
  });

  it("renders final error text when chat final has no content but includes event errorMessage", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-error-envelope",
      state: "final",
      message: { content: [] },
      errorMessage: '401 {"error":{"message":"Missing scopes: model.request"}}',
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    const rendered = requireFinalizedAssistantText(chatLog);
    expect(rendered).toContain("HTTP 401");
    expect(rendered).toContain("Missing scopes: model.request");
    expect(chatLog.dropAssistant).not.toHaveBeenCalledWith("run-error-envelope");
  });

  it("renders malformed streaming fragment text when chat final only has event errorMessage", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-malformed-final",
      state: "final",
      message: { content: [] },
      errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "LLM streaming response contained a malformed fragment. Please try again.",
      "run-malformed-final",
    );
  });

  it("renders malformed streaming fragment text for chat error events without reloading", () => {
    const { chatLog, loadHistory, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-malformed-error",
      state: "error",
      errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith(
      "run error: LLM streaming response contained a malformed fragment. Please try again.",
    );
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("restores a terminal error when another run delays a history reload", async () => {
    const { state, chatLog, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-error" },
    });
    handleChatEvent({
      runId: "run-other",
      message: { content: "still running" },
    });
    noteLocalRunId("run-local-empty");
    handleChatEvent({
      runId: "run-local-empty",
      state: "final",
    });
    handleChatEvent({
      runId: "run-error",
      state: "error",
      errorMessage: "provider exploded",
    });

    expect(state.activeChatRunId).toBe("run-other");
    expect(loadHistory).not.toHaveBeenCalled();

    handleChatEvent(makeFinalChatEvent(state, "run-other"));

    await vi.waitFor(() => expect(chatLog.addSystem).toHaveBeenCalledTimes(2));
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(chatLog.addSystem).toHaveBeenLastCalledWith("run error: provider exploded");
  });

  it("shows a concise /auth hint for local auth failures", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      localMode: true,
      state: {
        activeChatRunId: null,
        sessionInfo: { modelProvider: "openai" },
      },
    });

    handleChatEvent({
      runId: "run-auth-error",
      state: "error",
      errorMessage:
        "Authentication failed with an HTML 403 response from the provider. Re-authenticate and verify your provider account access.",
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith(
      "auth or provider access failed for openai. Run /auth openai to refresh credentials; if you already re-authed, switch models/providers because this account may still be blocked for inference.",
    );
  });

  it("preserves backend billing and usage-limit errors in local mode", () => {
    const backendError =
      '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}';
    const { chatLog, handleChatEvent } = createHandlersHarness({
      localMode: true,
      state: {
        activeChatRunId: null,
        sessionInfo: { modelProvider: "xai" },
      },
    });

    handleChatEvent({
      runId: "run-xai-spending-limit",
      state: "error",
      errorMessage: backendError,
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith(`run error: ${backendError}`);
  });

  it("surfaces a late provider error without replaying a completed assistant reply", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-source-reply" },
    });

    handleChatEvent({
      runId: "run-source-reply",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Source reply delivered." }],
      },
    });
    handleChatEvent({
      runId: "run-source-reply",
      state: "error",
      errorMessage: "raw provider failure",
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Source reply delivered.",
      "run-source-reply",
    );
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run error: raw provider failure");
    expect(state.activeChatRunId).toBeNull();
  });

  it("renders a duplicated post-final provider diagnostic only once", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-source-reply" },
    });

    handleChatEvent({
      runId: "run-source-reply",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Delivered once." }] },
    });
    const error = makeChatEvent(state, {
      runId: "run-source-reply",
      state: "error",
      errorMessage: "late provider failure",
    });

    handleChatEvent(error);
    handleChatEvent(error);

    expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Delivered once.",
      "run-source-reply",
    );
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run error: late provider failure");
    expect(state.activeChatRunId).toBeNull();
  });

  it("ignores blank late errors and renders a padded provider diagnostic exactly once", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-source-reply" },
    });

    handleChatEvent({
      runId: "run-source-reply",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Delivered once." }] },
    });
    handleChatEvent({
      runId: "run-source-reply",
      state: "error",
      errorMessage: "  \t  ",
    });
    const error = makeChatEvent(state, {
      runId: "run-source-reply",
      state: "error",
      errorMessage: "  actionable provider failure  ",
    });

    handleChatEvent(error);
    handleChatEvent(error);

    expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Delivered once.",
      "run-source-reply",
    );
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith(
      "run error: actionable provider failure",
    );
    expect(state.activeChatRunId).toBeNull();
  });

  it.each([
    {
      name: "canonical persisted assistant identities",
      sourceMetadata: { id: "message-tool-source-reply", seq: 7 },
      finalMetadata: { id: "automatic-final-reply", seq: 8 },
    },
    {
      name: "legacy assistant replies without transcript metadata",
      sourceMetadata: undefined,
      finalMetadata: undefined,
    },
  ])(
    "keeps and deduplicates distinct same-run finals with $name",
    ({ sourceMetadata, finalMetadata }) => {
      const { state, chatLog, handleChatEvent } = createHandlersHarness({
        state: { activeChatRunId: "run-message-tool" },
      });
      const sourceReply = {
        role: "assistant",
        content: [{ type: "text", text: "Visible progress from the targetless message tool." }],
        ...(sourceMetadata ? { __openclaw: sourceMetadata } : {}),
      };
      const automaticReply = {
        role: "assistant",
        content: [{ type: "text", text: "Visible automatic final reply." }],
        ...(finalMetadata ? { __openclaw: finalMetadata } : {}),
      };
      const sourceEvent = makeChatEvent(state, {
        runId: "run-message-tool",
        state: "final",
        message: sourceReply,
      });
      const finalEvent = makeChatEvent(state, {
        runId: "run-message-tool",
        state: "final",
        message: automaticReply,
      });

      handleChatEvent(sourceEvent);
      handleChatEvent(finalEvent);
      handleChatEvent(finalEvent);

      expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(2);
      expect(chatLog.finalizeAssistant).toHaveBeenNthCalledWith(
        1,
        "Visible progress from the targetless message tool.",
        "run-message-tool",
      );
      expect(chatLog.finalizeAssistant).toHaveBeenNthCalledWith(
        2,
        "Visible automatic final reply.",
        "run-message-tool",
      );
      expect(state.activeChatRunId).toBeNull();
    },
  );

  it("keeps a newer response streaming when a completed run fails afterward", () => {
    const { state, chatLog, setActivityStatus, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-completed" },
    });

    handleChatEvent({
      runId: "run-completed",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Delivered once." }] },
    });
    handleChatEvent({
      runId: "run-newer",
      message: { content: "Newer response" },
    });
    setActivityStatus.mockClear();

    handleChatEvent({
      runId: "run-completed",
      state: "error",
      errorMessage: "late provider failure",
    });

    expect(state.activeChatRunId).toBe("run-newer");
    expect(chatLog.updateAssistant).toHaveBeenLastCalledWith("Newer response", "run-newer");
    expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Delivered once.",
      "run-completed",
    );
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run error: late provider failure");
    expect(setActivityStatus).not.toHaveBeenCalledWith("error");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it("does not duplicate an aborted run when its terminal event is replayed", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-abort-replay" },
    });
    const aborted = makeChatEvent(state, {
      runId: "run-abort-replay",
      state: "aborted",
      errorMessage: "cancelled by user",
    });

    handleChatEvent(aborted);
    handleChatEvent(aborted);

    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted: cancelled by user");
    expect(state.activeChatRunId).toBeNull();
  });

  it("ignores an attachment final that arrives after the run was aborted", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-abort-late-final" },
    });
    const message = {
      role: "assistant",
      content: [{ type: "image", data: "secret-image" }],
    };

    handleChatEvent({
      runId: "run-abort-late-final",
      seq: 1,
      state: "aborted",
      errorMessage: "cancelled by user",
      message,
    });
    handleChatEvent({
      runId: "run-abort-late-final",
      seq: 2,
      state: "final",
      message,
    });

    expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted: cancelled by user");
    expect(state.sessionProjection?.runs["run-abort-late-final"]?.status).toBe("aborted");
  });

  it.each([
    {
      name: "abort",
      terminal: { state: "aborted" as const, errorMessage: "cancelled by user" },
      expectedStatus: "aborted",
    },
    {
      name: "error",
      terminal: { state: "error" as const, errorMessage: "provider failed" },
      expectedStatus: "error",
    },
  ])(
    "renders a text-bearing recovered final after a message-less $name",
    ({ terminal, expectedStatus }) => {
      const runId = `run-recovered-${expectedStatus}`;
      const { state, chatLog, handleChatEvent } = createHandlersHarness({
        state: { activeChatRunId: runId },
      });

      handleChatEvent({
        runId,
        seq: 1,
        ...terminal,
      });
      handleChatEvent({
        runId,
        seq: 2,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "Recovered reply." }] },
      });

      expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("Recovered reply.", runId);
      expect(state.sessionProjection?.runs[runId]?.status).toBe(expectedStatus);
    },
  );

  it("drops streaming assistant when chat final has no message", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-silent",
      message: { content: "hello" },
    });
    chatLog.dropAssistant.mockClear();
    chatLog.finalizeAssistant.mockClear();

    handleChatEvent({
      runId: "run-silent",
      state: "final",
    });

    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-silent");
    expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
  });

  it("renders a late displayable final after an earlier empty final for the same run", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-source-reply" },
    });

    handleChatEvent({
      runId: "run-source-reply",
      state: "final",
    });
    chatLog.dropAssistant.mockClear();
    chatLog.finalizeAssistant.mockClear();

    handleChatEvent({
      runId: "run-source-reply",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hey Shakker. I’m here." }],
      },
    });

    expect(chatLog.dropAssistant).not.toHaveBeenCalled();
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "Hey Shakker. I’m here.",
      "run-source-reply",
    );
  });

  it("ignores duplicate empty final envelopes after a run already finalized empty", () => {
    const { chatLog, loadHistory, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-empty-replay" },
    });

    handleChatEvent({
      runId: "run-empty-replay",
      state: "final",
    });
    chatLog.dropAssistant.mockClear();
    chatLog.finalizeAssistant.mockClear();
    loadHistory.mockClear();

    handleChatEvent({
      runId: "run-empty-replay",
      state: "final",
      message: {
        role: "assistant",
        content: [],
      },
    });

    expect(chatLog.dropAssistant).not.toHaveBeenCalled();
    expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("reloads history when a local run ends without a displayable final message", () => {
    const { loadHistory, noteLocalRunId, tui, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-local-silent" },
    });

    noteLocalRunId("run-local-silent");

    handleChatEvent({
      runId: "run-local-silent",
      state: "final",
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("does not reload history for local run with empty final when another run is active (#53115)", () => {
    const { state, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-main" },
    });

    noteLocalRunId("run-local-empty");

    handleChatEvent({
      runId: "run-local-empty",
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
      state: "final",
    });

    noteLocalRunId("run-main");
    handleChatEvent(makeFinalChatEvent(state, "run-main"));

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  describe("session.message history reload", () => {
    it.each([
      {
        name: "prefers canonical persisted identity over a conflicting event envelope",
        initialSessionId: "session-1",
        metadata: { id: "persisted-user", idempotencyKey: "persisted-run:user", seq: 7 },
        envelope: { messageId: "envelope-user", clientRunId: "envelope-run", messageSeq: 99 },
        expected: { messageId: "persisted-user", runId: "persisted-run" },
      },
      {
        name: "uses the envelope when canonical transcript identity is absent",
        initialSessionId: "session-1",
        metadata: undefined,
        envelope: { messageId: "envelope-user", clientRunId: "envelope-run", messageSeq: 99 },
        expected: { messageId: "envelope-user", runId: "envelope-run" },
      },
      {
        name: "binds the first session identity without dropping the live canonical prompt",
        initialSessionId: null,
        metadata: { id: "persisted-user", idempotencyKey: "persisted-run:user", seq: 7 },
        envelope: { messageId: "envelope-user", clientRunId: "envelope-run", messageSeq: 99 },
        expected: { messageId: "persisted-user", runId: "persisted-run" },
      },
    ])("$name", ({ initialSessionId, metadata, envelope, expected }) => {
      const { state, chatLog, handleSessionMessageEvent } = createHandlersHarness({
        state: { activeChatRunId: "run-existing", currentSessionId: initialSessionId },
      });

      handleSessionMessageEvent({
        ...(initialSessionId === null ? { sessionId: "first-persisted-session" } : {}),
        ...envelope,
        message: {
          role: "user",
          content: [{ type: "text", text: "Canonical cross-client prompt." }],
          ...(metadata ? { __openclaw: metadata } : {}),
        },
      });

      expect(chatLog.addLiveUser).toHaveBeenCalledExactlyOnceWith(
        "Canonical cross-client prompt.",
        expected,
      );
      expect(state.sessionProjection?.entries).toHaveLength(1);
      expect(state.sessionProjection?.entries[0]?.identity).toMatchObject({
        id: expected.messageId,
        runId: expected.runId,
        sequence: metadata?.seq ?? envelope.messageSeq,
      });
      if (initialSessionId === null) {
        expect(state.sessionProjection?.scope.sessionId).toBe("first-persisted-session");
      }
    });

    it.each([
      { name: "persists a canonical imported sequence", persistedSequence: 7, expectedEntries: 1 },
      {
        name: "rejects an envelope-only imported sequence",
        persistedSequence: null,
        expectedEntries: 0,
      },
    ])("$name", ({ persistedSequence, expectedEntries }) => {
      const { state, chatLog, handleSessionMessageEvent } = createHandlersHarness();

      handleSessionMessageEvent({
        messageId: "native-or-provider-local-id",
        messageSeq: 99,
        message: {
          role: "user",
          content: "Partially imported prompt.",
          __openclaw: {
            id: "provider-local-id",
            importedFrom: "claude-cli",
            ...(persistedSequence === null ? {} : { seq: persistedSequence }),
          },
        },
      });

      expect(state.sessionProjection?.entries ?? []).toHaveLength(expectedEntries);
      expect(chatLog.addLiveUser).toHaveBeenCalledTimes(expectedEntries);
    });

    it.each([
      { identity: "transcript metadata", includeMessageMetadata: true },
      { identity: "gateway event envelope", includeMessageMetadata: false },
    ])(
      "renders another client's $identity user turn before its active stream",
      ({ includeMessageMetadata }) => {
        const { state, chatLog, loadHistory, handleChatEvent, handleSessionMessageEvent } =
          createHandlersHarness({ state: { activeChatRunId: null } });
        const runId = "shared-session-web-run";
        handleChatEvent({
          runId,
          seq: 1,
          message: { content: [{ type: "text", text: "Already streaming." }] },
        });

        handleSessionMessageEvent({
          ...(includeMessageMetadata ? {} : { clientRunId: runId }),
          messageId: "shared-session-user",
          messageSeq: 1,
          message: {
            ...(includeMessageMetadata
              ? {
                  __openclaw: {
                    id: "shared-session-user",
                    idempotencyKey: `${runId}:user`,
                    seq: 1,
                  },
                }
              : {}),
            content: [{ type: "text", text: "Sent from the other client." }],
            role: "user",
          },
        });

        expect(chatLog.addLiveUser).toHaveBeenCalledWith("Sent from the other client.", {
          messageId: "shared-session-user",
          runId,
        });
        expect(state.activeChatRunId).toBe(runId);
        expect(loadHistory).not.toHaveBeenCalled();
      },
    );

    it("reloads the current session when another client appends a message", () => {
      const { state, loadHistory, handleSessionMessageEvent } = createHandlersHarness({
        state: {
          activeChatRunId: null,
          currentSessionId: "session-before",
          sessionInfo: { verboseLevel: "on", updatedAt: 100 },
        },
      });

      handleSessionMessageEvent({
        sessionId: "session-after",
        updatedAt: 200,
      });

      expect(state.currentSessionId).toBe("session-after");
      expect(state.sessionInfo.updatedAt).toBe(200);
      expect(loadHistory).toHaveBeenCalledTimes(1);
    });

    it("accepts the canonical session's unscoped alias", () => {
      const { loadHistory, handleSessionMessageEvent } = createHandlersHarness({
        state: { activeChatRunId: null, currentSessionKey: "agent:main:main" },
      });

      handleSessionMessageEvent({ sessionKey: "main" } satisfies SessionMessageEvent);

      expect(loadHistory).toHaveBeenCalledTimes(1);
    });

    it("ignores an unscoped alias owned by a different agent", () => {
      const { state, loadHistory, handleSessionMessageEvent } = createHandlersHarness({
        state: {
          activeChatRunId: null,
          currentAgentId: "work",
          currentSessionId: "session-work",
          currentSessionKey: "agent:work:main",
          sessionInfo: { verboseLevel: "on", updatedAt: 100 },
        },
      });

      handleSessionMessageEvent({
        sessionKey: "main",
        agentId: "main",
        sessionId: "session-default-agent",
        updatedAt: 200,
      });

      expect(state.currentSessionId).toBe("session-work");
      expect(state.sessionInfo.updatedAt).toBe(100);
      expect(loadHistory).not.toHaveBeenCalled();
    });

    it("does not assign an unqualified default-agent alias to another agent", () => {
      const { state, loadHistory, handleSessionMessageEvent } = createHandlersHarness({
        state: {
          activeChatRunId: null,
          currentAgentId: "work",
          currentSessionId: "session-work",
          currentSessionKey: "agent:work:main",
        },
      });

      handleSessionMessageEvent({
        sessionKey: "main",
        sessionId: "session-default-agent",
      });

      expect(state.currentSessionId).toBe("session-work");
      expect(loadHistory).not.toHaveBeenCalled();
    });

    it("ignores messages for another session without changing selected metadata", () => {
      const { state, loadHistory, tui, handleSessionMessageEvent } = createHandlersHarness({
        state: {
          activeChatRunId: null,
          currentAgentId: "work",
          currentSessionId: "session-before",
          currentSessionKey: "agent:work:main",
          sessionInfo: { verboseLevel: "on", updatedAt: 100 },
        },
      });

      handleSessionMessageEvent({
        sessionKey: "agent:work:other",
        agentId: "work",
        sessionId: "other-session",
        updatedAt: 200,
      });

      expect(state.currentSessionId).toBe("session-before");
      expect(state.sessionInfo.updatedAt).toBe(100);
      expect(loadHistory).not.toHaveBeenCalled();
      expect(tui.requestRender).not.toHaveBeenCalled();
    });

    it("does not let an older transcript snapshot replace newer session metadata", () => {
      const { state, loadHistory, handleSessionMessageEvent } = createHandlersHarness({
        state: {
          activeChatRunId: null,
          currentSessionId: "session-current",
          sessionInfo: { verboseLevel: "on", updatedAt: 200 },
        },
      });

      handleSessionMessageEvent({
        sessionId: "session-stale",
        updatedAt: 100,
      });

      expect(state.currentSessionId).toBe("session-current");
      expect(state.sessionInfo.updatedAt).toBe(200);
      expect(loadHistory).toHaveBeenCalledTimes(1);
    });

    it("reloads a global session only for its selected agent", () => {
      const { loadHistory, handleSessionMessageEvent } = createHandlersHarness({
        state: {
          agentDefaultId: "main",
          activeChatRunId: null,
          currentAgentId: "work",
          currentSessionKey: "global",
          sessionScope: "global",
        },
      });

      handleSessionMessageEvent({
        sessionKey: "global",
        agentId: "main",
      });
      expect(loadHistory).not.toHaveBeenCalled();

      handleSessionMessageEvent({
        sessionKey: "global",
        agentId: "work",
      });
      expect(loadHistory).toHaveBeenCalledTimes(1);
    });

    it("coalesces a burst of transcript updates into one follow-up reload", async () => {
      let resolveFirstHistory: ((result: TuiHistoryLoadResult) => void) | undefined;
      const { state, loadHistory, handleSessionMessageEvent } = createHandlersHarness({
        state: { activeChatRunId: null },
      });
      loadHistory.mockImplementationOnce(
        () =>
          new Promise<TuiHistoryLoadResult>((resolve) => {
            resolveFirstHistory = resolve;
          }),
      );

      for (let index = 0; index < 250; index += 1) {
        handleSessionMessageEvent({
          updatedAt: index,
        });
      }

      expect(loadHistory).toHaveBeenCalledTimes(1);
      expect(state.sessionInfo.updatedAt).toBe(249);

      resolveFirstHistory?.({
        loaded: true,
        runOutcome: { state: "completed" },
      });
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    });

    it("refreshes after a local final when terminal persistence arrives first", () => {
      const {
        state,
        chatLog,
        loadHistory,
        handleChatEvent,
        handleSessionsChangedEvent,
        handleSessionMessageEvent,
      } = createHandlersHarness({ state: { activeChatRunId: "run-active" } });

      handleSessionMessageEvent(makeSessionMessageEvent(state));
      handleSessionsChangedEvent({
        runId: "run-active",
        phase: "end",
      });
      expect(loadHistory).not.toHaveBeenCalled();

      handleChatEvent({
        runId: "run-active",
        state: "final",
        message: { content: [{ type: "text", text: "keep this visible" }] },
      });

      expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("keep this visible", "run-active");
      expect(loadHistory).toHaveBeenCalledTimes(1);
    });

    it("does not reload until an optimistic submit is resolved", () => {
      const { state, loadHistory, handleSessionMessageEvent, flushPendingHistoryRefreshIfIdle } =
        createHandlersHarness({
          state: { activeChatRunId: null, pendingSubmit: sendingSubmit("run-pending") },
        });

      handleSessionMessageEvent(makeSessionMessageEvent(state));
      expect(loadHistory).not.toHaveBeenCalled();

      state.pendingSubmit = null;
      flushPendingHistoryRefreshIfIdle();

      expect(loadHistory).toHaveBeenCalledTimes(1);
    });
  });

  describe("sessions.changed history reload", () => {
    const startRun = (
      state: TuiStateAccess,
      handleChatEvent: ReturnType<typeof createHandlersHarness>["handleChatEvent"],
      runId: string,
    ) => {
      handleChatEvent({
        runId,
        message: { content: [{ type: "text", text: "typing" }] },
      });
    };

    const changeSession = (
      state: TuiStateAccess,
      handleSessionsChangedEvent: ReturnType<
        typeof createHandlersHarness
      >["handleSessionsChangedEvent"],
      sessionId = state.currentSessionId,
    ) => {
      handleSessionsChangedEvent({
        reason: "new",
        sessionId: sessionId ?? undefined,
        updatedAt: 200,
      });
    };

    const finishPersistence = (
      state: TuiStateAccess,
      handleSessionsChangedEvent: ReturnType<
        typeof createHandlersHarness
      >["handleSessionsChangedEvent"],
      runId: string,
    ) => {
      handleSessionsChangedEvent({
        phase: "end",
        runId,
      });
    };

    const deferNextHistoryLoad = (loadHistory: MockFn) => {
      let resolveHistory: (result: TuiHistoryLoadResult) => void = () => {};
      const result = new Promise<TuiHistoryLoadResult>((resolve) => {
        resolveHistory = resolve;
      });
      loadHistory.mockReturnValueOnce(result);
      return (loaded: boolean, inFlightRunId: string | null = null) =>
        resolveHistory(
          loaded
            ? {
                loaded: true,
                runOutcome: inFlightRunId
                  ? { state: "active", runId: inFlightRunId }
                  : { state: "completed" },
              }
            : { loaded: false },
        );
    };

    it("waits for terminal persistence before rebuilding an active external run", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ state: { activeChatRunId: "run-active" } });
      startRun(state, handleChatEvent, "run-active");
      chatLog.finalizeAssistant.mockClear();
      loadHistory.mockClear();

      changeSession(state, handleSessionsChangedEvent);
      expect(loadHistory).not.toHaveBeenCalled();

      handleChatEvent({
        runId: "run-active",
        state: "final",
        message: { content: [{ type: "text", text: "reply" }] },
      });
      expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);

      finishPersistence(state, handleSessionsChangedEvent, "run-active");
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(state.activeChatRunId).toBeNull());
      expect(state.activityStatus).toBe("idle");

      handleChatEvent({
        runId: "run-active",
        state: "final",
        message: { content: [{ type: "text", text: "reply" }] },
      });
      expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    });

    it("suppresses a final that arrives while persisted history is rebuilding", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ state: { activeChatRunId: "run-active" } });
      const resolveHistory = deferNextHistoryLoad(loadHistory);
      startRun(state, handleChatEvent, "run-active");
      chatLog.finalizeAssistant.mockClear();
      changeSession(state, handleSessionsChangedEvent);
      finishPersistence(state, handleSessionsChangedEvent, "run-active");

      handleChatEvent({
        runId: "run-active",
        state: "final",
        message: { content: [{ type: "text", text: "history-owned" }] },
      });
      expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();

      resolveHistory(true);
      await Promise.resolve();
      expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
    });

    it("replays a deferred final when the history rebuild fails", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ state: { activeChatRunId: "run-active" } });
      const resolveHistory = deferNextHistoryLoad(loadHistory);
      startRun(state, handleChatEvent, "run-active");
      chatLog.finalizeAssistant.mockClear();
      changeSession(state, handleSessionsChangedEvent);
      finishPersistence(state, handleSessionsChangedEvent, "run-active");
      handleChatEvent({
        runId: "run-active",
        state: "final",
        message: { content: [{ type: "text", text: "fallback reply" }] },
      });

      resolveHistory(false);
      await vi.waitFor(() =>
        expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("fallback reply", "run-active"),
      );
    });

    it("terminates a persisted run when history fails before its final arrives", async () => {
      const {
        state,
        chatLog,
        loadHistory,
        setActivityStatus,
        handleChatEvent,
        handleSessionsChangedEvent,
      } = createHandlersHarness({ state: { activeChatRunId: "run-active" } });
      const resolveHistory = deferNextHistoryLoad(loadHistory);
      startRun(state, handleChatEvent, "run-active");
      chatLog.finalizeAssistant.mockClear();
      changeSession(state, handleSessionsChangedEvent);
      finishPersistence(state, handleSessionsChangedEvent, "run-active");

      resolveHistory(false);
      await vi.waitFor(() => expect(state.activeChatRunId).toBeNull());
      expect(setActivityStatus).toHaveBeenCalledWith("idle");

      handleChatEvent({
        runId: "run-active",
        state: "final",
        message: { content: [{ type: "text", text: "late fallback" }] },
      });
      expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("late fallback", "run-active");
    });

    it("uses an already-observed persistence barrier for a recently finalized run", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ state: { activeChatRunId: "run-done" } });
      handleChatEvent(makeFinalChatEvent(state, "run-done"));
      finishPersistence(state, handleSessionsChangedEvent, "run-done");
      loadHistory.mockClear();

      changeSession(state, handleSessionsChangedEvent);
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
      expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    });

    it("preserves finalized-run dedupe across a delayed session reload", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ state: { activeChatRunId: "run-done" } });
      handleChatEvent(makeFinalChatEvent(state, "run-done"));
      finishPersistence(state, handleSessionsChangedEvent, "run-done");
      loadHistory.mockClear();
      now.mockReturnValue(12_000);

      changeSession(state, handleSessionsChangedEvent);
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
      handleChatEvent(makeFinalChatEvent(state, "run-done"));

      expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
      now.mockRestore();
    });

    it("keeps a later terminal reload queued behind the current rebuild", async () => {
      const { state, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ state: { activeChatRunId: "run-a" } });
      const resolveFirstHistory = deferNextHistoryLoad(loadHistory);
      startRun(state, handleChatEvent, "run-a");
      startRun(state, handleChatEvent, "run-b");
      changeSession(state, handleSessionsChangedEvent);

      finishPersistence(state, handleSessionsChangedEvent, "run-a");
      finishPersistence(state, handleSessionsChangedEvent, "run-b");
      expect(loadHistory).toHaveBeenCalledTimes(1);

      resolveFirstHistory(true);
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    });

    it("preserves immediate reload behavior when new replaces a known session", () => {
      const { state, loadHistory, setActivityStatus, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({
          state: {
            activeChatRunId: "run-old",
            currentSessionId: "session-old",
            activityStatus: "streaming",
          },
        });
      startRun(state, handleChatEvent, "run-old");
      loadHistory.mockClear();

      changeSession(state, handleSessionsChangedEvent, "session-new");

      expect(loadHistory).toHaveBeenCalledTimes(1);
      expect(state.currentSessionId).toBe("session-new");
      expect(state.activeChatRunId).toBeNull();
      expect(setActivityStatus).toHaveBeenCalledWith("idle");
    });

    it("preserves an in-flight run adopted by reset history", async () => {
      const { state, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({
          state: { activeChatRunId: "run-reset", activityStatus: "streaming" },
        });
      startRun(state, handleChatEvent, "run-reset");
      loadHistory.mockImplementationOnce(async () => {
        state.activeChatRunId = "run-reset";
        state.activityStatus = "streaming";
        return {
          loaded: true as const,
          runOutcome: { state: "active" as const, runId: "run-reset" },
        };
      });

      handleSessionsChangedEvent({
        reason: "reset",
        sessionId: state.currentSessionId ?? undefined,
      });

      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
      expect(state.activeChatRunId).toBe("run-reset");
      expect(state.activityStatus).toBe("streaming");
    });

    it("preserves finalized-run dedupe after reset history reload", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ state: { activeChatRunId: "run-reset" } });
      handleChatEvent(makeFinalChatEvent(state, "run-reset"));
      chatLog.finalizeAssistant.mockClear();
      loadHistory.mockClear();

      handleSessionsChangedEvent({
        reason: "reset",
        sessionId: state.currentSessionId ?? undefined,
      });
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
      handleChatEvent(makeFinalChatEvent(state, "run-reset"));

      expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
    });

    it("preserves displayed-run dedupe when reset history fails", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ state: { activeChatRunId: "run-reset" } });
      const resolveHistory = deferNextHistoryLoad(loadHistory);
      handleChatEvent(makeFinalChatEvent(state, "run-reset"));
      chatLog.finalizeAssistant.mockClear();

      handleSessionsChangedEvent({
        reason: "reset",
        sessionId: state.currentSessionId ?? undefined,
      });
      resolveHistory(false);
      await Promise.resolve();
      handleChatEvent(makeFinalChatEvent(state, "run-reset"));

      expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
    });

    it("gates late run events while reset history is rebuilding", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ state: { activeChatRunId: "run-reset" } });
      startRun(state, handleChatEvent, "run-reset");
      chatLog.finalizeAssistant.mockClear();
      loadHistory.mockClear();

      handleSessionsChangedEvent({
        reason: "reset",
        sessionId: state.currentSessionId ?? undefined,
      });
      handleChatEvent({
        runId: "run-reset",
        state: "final",
        message: { content: [{ type: "text", text: "stale after reset" }] },
      });

      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
      expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
      expect(state.activeChatRunId).toBeNull();
    });
  });
});

describe("tui-event-handlers: streaming watchdog", () => {
  const expectedTimeoutMessage =
    "This response is taking longer than expected. Still waiting for the current run.";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createHarness = (options?: { streamingWatchdogMs?: number }) => {
    const state = makeTuiState();
    const chatLog = createMockChatLog();
    const btw = createMockBtwPresenter();
    const tui = { requestRender: vi.fn() } as unknown as MockTui & HandlerTui;
    const setActivityStatus = vi.fn();
    const loadHistory = vi.fn();
    const localRunIds = new Set<string>();
    const noteLocalRunId = (runId: string) => {
      localRunIds.add(runId);
    };
    const rawHandlers = createEventHandlers({
      chatLog,
      btw,
      tui,
      state,
      setActivityStatus,
      loadHistory,
      noteLocalRunId,
      isLocalRunId: localRunIds.has.bind(localRunIds),
      forgetLocalRunId: localRunIds.delete.bind(localRunIds),
      streamingWatchdogMs: options?.streamingWatchdogMs,
    });
    const handlers = {
      ...rawHandlers,
      handleChatEvent: (event: ChatEventOverrides) =>
        rawHandlers.handleChatEvent(makeChatEvent(state, event)),
      handleAgentEvent: (event: Partial<AgentEvent>) =>
        rawHandlers.handleAgentEvent(makeAgentEvent(event)),
    };
    return { state, chatLog, tui, setActivityStatus, loadHistory, noteLocalRunId, handlers };
  };

  it("keeps the active run busy when no stream delta arrives for the watchdog window", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-stuck",
      message: { content: "hello" },
    });

    expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");
    expect(state.activeChatRunId).toBe("run-stuck");

    vi.advanceTimersByTime(5_001);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBe("run-stuck");
    expect(chatLog.addPendingSystem).toHaveBeenCalledWith("run-stuck", expectedTimeoutMessage);

    handlers.dispose?.();
  });

  it("keeps deferred history reload pending while the watchdog waits on the active run", () => {
    const { state, loadHistory, noteLocalRunId, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-stuck",
      message: { content: "hello" },
    });

    noteLocalRunId("run-local-empty");
    handlers.handleChatEvent({
      runId: "run-local-empty",
      state: "final",
    });

    expect(loadHistory).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_001);

    expect(state.activeChatRunId).toBe("run-stuck");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(loadHistory).not.toHaveBeenCalled();

    handlers.dispose?.();
  });

  it("refreshes the watchdog window on each new stream delta", () => {
    const { state, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-flow",
      message: { content: "first" },
    });

    vi.advanceTimersByTime(3_000);

    handlers.handleChatEvent({
      runId: "run-flow",
      message: { content: "second" },
    });

    vi.advanceTimersByTime(3_000);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBe("run-flow");

    vi.advanceTimersByTime(2_500);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBe("run-flow");

    handlers.dispose?.();
  });

  it("rearms the watchdog on active-run tool events even when tool verbosity is off", () => {
    const { state, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });
    state.sessionInfo.verboseLevel = "off";

    handlers.handleChatEvent({
      runId: "run-tools",
      message: { content: "first" },
    });

    vi.advanceTimersByTime(3_000);

    handlers.handleAgentEvent({
      runId: "run-tools",
      stream: "tool",
      data: { phase: "start", toolCallId: "tool-1", name: "read" },
    });

    vi.advanceTimersByTime(3_000);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBe("run-tools");

    vi.advanceTimersByTime(2_001);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBe("run-tools");

    handlers.dispose?.();
  });

  it("pauses the watchdog while disconnected and rearms it on reconnect without clearing the active run", () => {
    const { state, setActivityStatus, loadHistory, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-reconnect",
      message: { content: "hello" },
    });

    handlers.pauseStreamingWatchdog();
    vi.advanceTimersByTime(10_000);

    expect(state.activeChatRunId).toBe("run-reconnect");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");

    handlers.reconnectStreamingWatchdog();

    expect(setActivityStatus).toHaveBeenCalledWith("streaming");
    expect(state.activeChatRunId).toBe("run-reconnect");

    vi.advanceTimersByTime(5_001);

    expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
    expect(state.activeChatRunId).toBeNull();
    expect(loadHistory).toHaveBeenCalledTimes(1);

    handlers.dispose?.();
  });

  it("reloads history only once when reconnect recovery and deferred history refresh overlap", () => {
    const { loadHistory, noteLocalRunId, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-reconnect",
      message: { content: "hello" },
    });

    noteLocalRunId("run-local-empty");
    handlers.handleChatEvent({
      runId: "run-local-empty",
      state: "final",
    });

    handlers.pauseStreamingWatchdog();
    handlers.reconnectStreamingWatchdog();
    vi.advanceTimersByTime(5_001);

    expect(loadHistory).toHaveBeenCalledTimes(1);

    handlers.dispose?.();
  });

  it("keeps an untracked reconnect run visible until history resolves it", () => {
    const { state, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });
    state.activeChatRunId = "run-stale";
    state.activityStatus = "streaming";

    handlers.reconnectStreamingWatchdog();

    expect(state.activeChatRunId).toBe("run-stale");
    expect(state.activityStatus).toBe("streaming");
    expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");

    handlers.dispose?.();
  });

  it("keeps reconnect recovery armed when only terminal lifecycle arrives after reconnect", () => {
    const { state, chatLog, setActivityStatus, loadHistory, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-lifecycle-only",
      message: { content: "hello" },
    });

    handlers.pauseStreamingWatchdog();
    handlers.reconnectStreamingWatchdog();

    handlers.handleAgentEvent({
      runId: "run-lifecycle-only",
      data: { phase: "end" },
    });

    vi.advanceTimersByTime(5_001);

    expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
    expect(state.activeChatRunId).toBeNull();
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(chatLog.addPendingSystem).not.toHaveBeenCalled();

    handlers.dispose?.();
  });

  it("cancels the watchdog when the run finalizes normally", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-normal",
      message: { content: "hi" },
    });
    handlers.handleChatEvent({
      runId: "run-normal",
      state: "final",
      message: { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    });

    vi.advanceTimersByTime(10_000);

    const statusCalls = setActivityStatus.mock.calls.map((c) => c[0]);
    expect(statusCalls.filter((s) => s === "idle").length).toBe(1);
    expect(chatLog.addPendingSystem).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBeNull();

    handlers.dispose?.();
  });

  it("is disabled when streamingWatchdogMs is 0", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 0,
    });

    handlers.handleChatEvent({
      runId: "run-no-watchdog",
      message: { content: "hi" },
    });

    vi.advanceTimersByTime(60_000);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(chatLog.addPendingSystem).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-no-watchdog");

    handlers.dispose?.();
  });

  it("does not let another run replace a watchdog-noticed active run", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-old",
      message: { content: "old" },
    });

    vi.advanceTimersByTime(5_001);
    expect(state.activeChatRunId).toBe("run-old");
    expect(chatLog.addPendingSystem).toHaveBeenCalledWith("run-old", expectedTimeoutMessage);

    handlers.handleChatEvent({
      runId: "run-new",
      message: { content: "new" },
    });
    expect(state.activeChatRunId).toBe("run-old");

    vi.advanceTimersByTime(3_000);

    handlers.handleChatEvent({
      runId: "run-old",
      message: { content: "old again" },
    });

    vi.advanceTimersByTime(2_001);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBe("run-old");
    expect(chatLog.addPendingSystem).toHaveBeenCalledTimes(1);

    handlers.dispose?.();
  });

  it("dispose clears a pending watchdog without firing it", () => {
    const { setActivityStatus, chatLog, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-dispose",
      message: { content: "hi" },
    });

    handlers.dispose?.();
    vi.advanceTimersByTime(10_000);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(chatLog.addPendingSystem).not.toHaveBeenCalled();
  });

  it("dismisses the watchdog notice when a delta arrives after the watchdog fires", () => {
    const { chatLog, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-late",
      message: { content: "starting" },
    });

    vi.advanceTimersByTime(5_001);
    expect(chatLog.addPendingSystem).toHaveBeenCalledWith("run-late", expectedTimeoutMessage);

    handlers.handleChatEvent({
      runId: "run-late",
      message: { content: "actually here" },
    });

    expect(chatLog.dismissPendingSystem).toHaveBeenCalledWith("run-late");

    handlers.dispose?.();
  });

  it("dismisses the watchdog notice when the final arrives after the watchdog fires", () => {
    const { chatLog, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });

    handlers.handleChatEvent({
      runId: "run-final-late",
      message: { content: "starting" },
    });

    vi.advanceTimersByTime(5_001);
    expect(chatLog.addPendingSystem).toHaveBeenCalledWith("run-final-late", expectedTimeoutMessage);

    handlers.handleChatEvent({
      runId: "run-final-late",
      state: "final",
      message: { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    });

    expect(chatLog.dismissPendingSystem).toHaveBeenCalledWith("run-final-late");

    handlers.dispose?.();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
