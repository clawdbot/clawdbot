// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentEvent, type FallbackStatus, type ToolStreamEntry } from "./app-tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];
type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;
type MutableHost = ToolStreamHost & {
  compactionStatus?: unknown;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
};
const TOOL_STREAM_TEST_NOW = new Date("2026-05-09T00:00:00.000Z").getTime();

function createHost(overrides?: Partial<MutableHost>): MutableHost {
  return {
    sessionKey: "main",
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    chatModelOverrides: {},
    compactionStatus: null,
    compactionClearTimer: null,
    fallbackStatus: null,
    fallbackClearTimer: null,
    ...overrides,
  };
}

function agentEvent(
  runId: string,
  seq: number,
  stream: AgentEvent["stream"],
  data: AgentEvent["data"],
  sessionKey = "main",
): AgentEvent {
  return {
    runId,
    seq,
    stream,
    ts: Date.now(),
    sessionKey,
    data,
  };
}

function expectCompactionCompleteAndAutoClears(host: MutableHost) {
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

function requireFallbackStatus(host: MutableHost): FallbackStatus {
  if (!host.fallbackStatus) {
    throw new Error("expected fallback status");
  }
  return host.fallbackStatus;
}

function useToolStreamFakeTimers(): void {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(TOOL_STREAM_TEST_NOW);
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
    vi.advanceTimersByTime(1);
    expect(host.fallbackStatus).toBeNull();
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

    expect(host.chatModelOverrides?.main).toEqual({
      kind: "qualified",
      value: "anthropic/claude-sonnet-4-6",
    });
  });

  it("clears the chat model cache from session_status default resets", () => {
    const host = createHost({
      chatModelOverrides: {
        main: { kind: "qualified", value: "anthropic/claude-sonnet-4-6" },
      },
    });

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

    expect(host.chatModelOverrides?.main).toBeNull();
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
    expect(host.compactionClearTimer).toBeNull();

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
