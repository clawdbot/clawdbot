// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentEvent,
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import {
  handleAgentEvent,
  handleSessionOperationEvent,
  type FallbackStatus,
} from "./tool-stream.ts";

function expectCompactionCompleteAndAutoClears(host: ReturnType<typeof createHost>) {
  expect(host.compactionStatus).toEqual({
    phase: "complete",
    runId: "run-1",
    startedAt: TOOL_STREAM_TEST_NOW,
    completedAt: TOOL_STREAM_TEST_NOW,
  });
  const clearTimer = host.compactionClearTimer as unknown as {
    hasRef?: unknown;
    ref?: unknown;
    unref?: unknown;
  };
  expect(typeof clearTimer.hasRef).toBe("function");
  expect(typeof clearTimer.ref).toBe("function");
  expect(typeof clearTimer.unref).toBe("function");

  vi.advanceTimersByTime(5_000);
  expect(host.compactionStatus).toBeNull();
  expect(host.compactionClearTimer).toBeNull();
}

function requireFallbackStatus(host: ReturnType<typeof createHost>): FallbackStatus {
  if (!host.fallbackStatus) {
    throw new Error("expected fallback status");
  }
  return host.fallbackStatus;
}

describe("app-tool-stream fallback lifecycle handling", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  beforeAll(() => {
    const globalWithWindow = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis;
    };
    if (!globalWithWindow.window) {
      globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
    }
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts session-scoped fallback lifecycle events when no run is active", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
        reasonSummary: "rate limit",
      },
    });

    const fallbackStatus = requireFallbackStatus(host);
    expect(fallbackStatus.selected).toBe("fireworks/accounts/fireworks/routers/kimi-k2p5-turbo");
    expect(fallbackStatus.active).toBe("deepinfra/moonshotai/Kimi-K2.5");
    expect(fallbackStatus.reason).toBe("rate limit");
    vi.useRealTimers();
  });

  it("rejects idle fallback lifecycle events for other sessions", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:other:main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus).toBeNull();
    vi.useRealTimers();
  });

  it("auto-clears fallback status after toast duration", () => {
    useToolStreamFakeTimers();
    const requestUpdate = vi.fn();
    const host = createHost({ requestUpdate });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    let fallbackStatus = requireFallbackStatus(host);
    expect(fallbackStatus.phase).toBe("active");
    expect(fallbackStatus.selected).toBe("fireworks/accounts/fireworks/routers/kimi-k2p5-turbo");
    expect(fallbackStatus.active).toBe("deepinfra/moonshotai/Kimi-K2.5");
    vi.advanceTimersByTime(7_999);
    fallbackStatus = requireFallbackStatus(host);
    expect(fallbackStatus.phase).toBe("active");
    expect(fallbackStatus.selected).toBe("fireworks/accounts/fireworks/routers/kimi-k2p5-turbo");
    expect(fallbackStatus.active).toBe("deepinfra/moonshotai/Kimi-K2.5");
    expect(requestUpdate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.fallbackStatus).toBeNull();
    expect(requestUpdate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("builds previous fallback label from provider + model on fallback_cleared", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback_cleared",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "fireworks",
        activeModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        previousActiveProvider: "deepinfra",
        previousActiveModel: "moonshotai/Kimi-K2.5",
      },
    });

    const fallbackStatus = requireFallbackStatus(host);
    expect(fallbackStatus.phase).toBe("cleared");
    expect(fallbackStatus.previous).toBe("deepinfra/moonshotai/Kimi-K2.5");
    vi.useRealTimers();
  });

  it("updates the chat model cache from session_status model changes", () => {
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        name: "session_status",
        toolCallId: "status-1",
        result: {
          details: {
            ok: true,
            sessionKey: "main",
            changedModel: true,
            modelProvider: "anthropic",
            model: "claude-sonnet-4-6",
            modelOverride: "anthropic/claude-sonnet-4-6",
          },
        },
      },
    });

    expect(host.sessions.state.modelOverrides.main).toBe("anthropic/claude-sonnet-4-6");
  });

  it("clears the chat model cache from session_status default resets", () => {
    const host = createHost();
    host.sessions.setModelOverride("main", "anthropic/claude-sonnet-4-6");

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        name: "session_status",
        toolCallId: "status-1",
        result: {
          details: {
            ok: true,
            sessionKey: "main",
            changedModel: true,
            modelProvider: "openai",
            model: "gpt-5.4",
            modelOverride: null,
          },
        },
      },
    });

    expect(host.sessions.state.modelOverrides.main).toBeNull();
  });

  it("tags stream segments with the tool they precede without resetting elapsed time", () => {
    useToolStreamFakeTimers();
    const host = createHost({
      chatRunId: "run-1",
      chatStream: "visible text before tool",
      chatStreamStartedAt: TOOL_STREAM_TEST_NOW - 10,
    });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "call_1",
      },
    });

    expect(host.chatStreamSegments).toEqual([
      {
        text: "visible text before tool",
        ts: TOOL_STREAM_TEST_NOW - 10,
        runId: "run-1",
        toolCallId: "call_1",
      },
    ]);
    expect(host.chatStream).toBeNull();
    vi.useRealTimers();
  });

  it("stores keyed preamble item progress as stream segments", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-1",
        progressText: "Checking",
      },
    });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-1",
        progressText: "Checking the app-server stream",
      },
    });

    expect(host.chatStreamSegments).toEqual([
      {
        text: "Checking the app-server stream",
        ts: TOOL_STREAM_TEST_NOW,
        runId: "run-1",
        itemId: "msg-preamble-1",
      },
    ]);
    expect(host.chatStream).toBeNull();
    vi.useRealTimers();
  });

  it.each([
    { progressText: "Another run's commentary", name: "replace" },
    { progressText: "", name: "clear" },
  ])("does not let another run $name the active preamble", ({ progressText }) => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-1",
        progressText: "The active run's commentary",
      },
    });
    handleAgentEvent(host, {
      runId: "run-2",
      seq: 2,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: { kind: "preamble", itemId: "msg-preamble-1", progressText },
    });

    expect(host.chatStreamSegments).toEqual([
      {
        text: "The active run's commentary",
        ts: TOOL_STREAM_TEST_NOW,
        runId: "run-1",
        itemId: "msg-preamble-1",
      },
    ]);
  });

  it("does not insert another run's preamble into the active transcript", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1" });

    handleAgentEvent(host, {
      runId: "run-2",
      seq: 1,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-2",
        progressText: "Another run's commentary",
      },
    });

    expect(host.chatStreamSegments).toEqual([]);
  });

  it("accepts a session-scoped preamble while no run is active", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-1",
        progressText: "An already active session's commentary",
      },
    });

    expect(host.chatStreamSegments).toEqual([
      {
        text: "An already active session's commentary",
        ts: TOOL_STREAM_TEST_NOW,
        runId: "run-1",
        itemId: "msg-preamble-1",
      },
    ]);
  });

  it("clears keyed preamble item progress on empty updates", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-1",
        progressText: "Checking",
      },
    });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-1",
        progressText: "",
      },
    });

    expect(host.chatStreamSegments).toEqual([]);
    vi.useRealTimers();
  });

  it("normalizes silent and directive-only keyed preamble progress", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-1",
        progressText: "Checking [[reply_to_current]]",
      },
    });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-2",
        progressText: "[[reply_to_current]]",
      },
    });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 3,
      stream: "item",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "msg-preamble-1",
        progressText: "**NO_REPLY",
      },
    });

    expect(host.chatStreamSegments).toEqual([]);
    vi.useRealTimers();
  });

  it("ignores selected-global tool events from another agent", () => {
    const host = createHost({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });

    handleAgentEvent(host, {
      runId: "run-main-global",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "global",
      agentId: "main",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-main-global",
      },
    });

    expect(host.toolStreamOrder).toHaveLength(0);
  });

  it("ignores selected-global lifecycle and fallback events from another agent", () => {
    const host = createHost({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });

    handleAgentEvent(host, {
      runId: "run-main-global",
      seq: 1,
      stream: "compaction",
      ts: Date.now(),
      sessionKey: "global",
      agentId: "main",
      data: { phase: "start" },
    });
    handleAgentEvent(host, {
      runId: "run-main-global",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "global",
      agentId: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });
    handleAgentEvent(host, {
      runId: "run-main-global",
      seq: 3,
      stream: "fallback",
      ts: Date.now(),
      sessionKey: "global",
      agentId: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.compactionStatus).toBeNull();
    expect(host.fallbackStatus).toBeNull();
  });

  it("keeps compaction in retry-pending state until the matching lifecycle end", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(host, agentEvent("run-1", 1, "compaction", { phase: "start" }));

    expect(host.compactionStatus).toEqual({
      phase: "active",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });

    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "compaction", {
        phase: "end",
        willRetry: true,
        completed: true,
      }),
    );

    expect(host.compactionStatus).toEqual({
      phase: "retrying",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });
    expect(host.compactionClearTimer).not.toBeNull();

    handleAgentEvent(host, agentEvent("run-2", 3, "lifecycle", { phase: "end" }));

    expect(host.compactionStatus).toEqual({
      phase: "retrying",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });

    handleAgentEvent(host, agentEvent("run-1", 4, "lifecycle", { phase: "end" }));

    expectCompactionCompleteAndAutoClears(host);

    vi.useRealTimers();
  });

  it("auto-clears active compaction after the stale timeout", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(host, agentEvent("run-1", 1, "compaction", { phase: "start" }));

    expect(host.compactionStatus).toEqual({
      phase: "active",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(host.compactionStatus).toEqual({
      phase: "active",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });

    vi.advanceTimersByTime(1);

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();

    vi.useRealTimers();
  });

  it("shows manual session operation compaction progress while idle", () => {
    useToolStreamFakeTimers();
    const host = createHost({
      sessionKey: "main",
      hello: {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
          },
        },
      },
    });

    handleSessionOperationEvent(host, {
      operationId: "operation-1",
      operation: "compact",
      phase: "start",
      sessionKey: "agent:main:main",
      ts: TOOL_STREAM_TEST_NOW,
    });

    expect(host.compactionStatus).toEqual({
      phase: "active",
      runId: "operation-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });

    handleSessionOperationEvent(host, {
      operationId: "operation-1",
      operation: "compact",
      phase: "end",
      sessionKey: "agent:main:main",
      ts: TOOL_STREAM_TEST_NOW,
      completed: true,
    });

    expect(host.compactionStatus).toEqual({
      phase: "complete",
      runId: "operation-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: TOOL_STREAM_TEST_NOW,
    });

    vi.useRealTimers();
  });

  it("ignores manual session operation compaction for other sessions", () => {
    useToolStreamFakeTimers();
    const host = createHost({ sessionKey: "agent:main:main" });

    handleSessionOperationEvent(host, {
      operationId: "operation-1",
      operation: "compact",
      phase: "start",
      sessionKey: "agent:other:main",
      ts: TOOL_STREAM_TEST_NOW,
    });

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();

    vi.useRealTimers();
  });

  it("ignores selected-global session operation compaction for another agent", () => {
    useToolStreamFakeTimers();
    const host = createHost({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });

    handleSessionOperationEvent(host, {
      operationId: "operation-main",
      operation: "compact",
      phase: "start",
      sessionKey: "global",
      agentId: "main",
      ts: TOOL_STREAM_TEST_NOW,
    });

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();

    vi.useRealTimers();
  });

  it("accepts canonical global live events for selected agent main aliases", () => {
    useToolStreamFakeTimers();
    const host = createHost({
      sessionKey: "agent:work:main",
      agentsList: { defaultId: "main" },
    });

    handleAgentEvent(host, {
      runId: "run-work",
      seq: 1,
      stream: "compaction",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "global",
      agentId: "work",
      data: { phase: "start" },
    });

    expect(host.compactionStatus).toEqual({
      phase: "active",
      runId: "run-work",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });

    handleAgentEvent(host, {
      runId: "run-main",
      seq: 2,
      stream: "fallback",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "global",
      agentId: "main",
      data: {
        phase: "fallback_started",
        selectedProvider: "openai",
        selectedModel: "gpt-5",
      },
    });

    expect(host.fallbackStatus).toBeNull();

    vi.useRealTimers();
  });

  it("ignores stale manual session operation completion after a newer start", () => {
    useToolStreamFakeTimers();
    const host = createHost({ sessionKey: "agent:main:main" });

    handleSessionOperationEvent(host, {
      operationId: "operation-1",
      operation: "compact",
      phase: "start",
      sessionKey: "agent:main:main",
      ts: TOOL_STREAM_TEST_NOW,
    });
    handleSessionOperationEvent(host, {
      operationId: "operation-2",
      operation: "compact",
      phase: "start",
      sessionKey: "agent:main:main",
      ts: TOOL_STREAM_TEST_NOW,
    });
    handleSessionOperationEvent(host, {
      operationId: "operation-1",
      operation: "compact",
      phase: "end",
      sessionKey: "agent:main:main",
      ts: TOOL_STREAM_TEST_NOW,
      completed: true,
    });

    expect(host.compactionStatus).toEqual({
      phase: "active",
      runId: "operation-2",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });
    vi.advanceTimersByTime(5 * 60_000);
    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();

    vi.useRealTimers();
  });

  it("treats lifecycle error as terminal for retry-pending compaction", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(host, agentEvent("run-1", 1, "compaction", { phase: "start" }));

    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "compaction", {
        phase: "end",
        willRetry: true,
        completed: true,
      }),
    );

    expect(host.compactionStatus).toEqual({
      phase: "retrying",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });

    handleAgentEvent(host, agentEvent("run-1", 3, "lifecycle", { phase: "error", error: "boom" }));

    expectCompactionCompleteAndAutoClears(host);

    vi.useRealTimers();
  });

  it("does not surface retrying or complete when retry compaction failed", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(host, agentEvent("run-1", 1, "compaction", { phase: "start" }));

    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "compaction", {
        phase: "end",
        willRetry: true,
        completed: false,
      }),
    );

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();

    handleAgentEvent(host, agentEvent("run-1", 3, "lifecycle", { phase: "error", error: "boom" }));

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();

    vi.useRealTimers();
  });
});
