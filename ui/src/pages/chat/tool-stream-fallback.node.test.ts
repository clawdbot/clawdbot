// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { prunePersistedAssistantStreamSegments } from "./stream-segment-pruning.ts";
import type { FallbackStatus } from "./tool-stream-contract.ts";
import { handleSessionOperationEvent } from "./tool-stream-status.ts";
import {
  agentEvent,
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

function expectCompactionCompleteAndRetained(host: ReturnType<typeof createHost>, itemId?: string) {
  expect(host.compactionStatus).toEqual({
    ...(itemId ? { itemId } : {}),
    phase: "complete",
    runId: "run-1",
    startedAt: TOOL_STREAM_TEST_NOW,
    completedAt: TOOL_STREAM_TEST_NOW,
  });
  const status = host.compactionStatus;
  vi.advanceTimersByTime(5_000);
  expect(host.compactionStatus).toBe(status);
  expect(host.compactionClearTimer).toBeNull();
}

function requireFallbackStatus(host: ReturnType<typeof createHost>): FallbackStatus {
  if (!host.fallbackStatus) {
    throw new Error("expected fallback status");
  }
  return host.fallbackStatus;
}

describe("app-tool-stream fallback lifecycle handling", () => {
  const globalWithWindow = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
  };
  let installedTestWindow = false;

  beforeAll(() => {
    if (!globalWithWindow.window) {
      globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
      installedTestWindow = true;
    }
  });

  afterAll(() => {
    if (installedTestWindow) {
      Reflect.deleteProperty(globalWithWindow, "window");
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

  it.each([
    ["main", "agent:main:main", "main", null],
    ["agent:work:thread", "agent:work:thread", "work", "openai/gpt-5-mini"],
    ["global", "global", "work", null],
    ["agent:work:main", "global", "work", null],
  ])(
    "refreshes canonical selection after status changes for %s",
    async (key, target, agentId, override) => {
      const row = {
        key,
        kind: "direct" as const,
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        modelOverrideSource: null,
      };
      const result: SessionsListResult = {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [row],
      };
      const pendingPatch = createDeferred<unknown>();
      const request = vi.fn(async (method: string) =>
        method === "sessions.patch" ? pendingPatch.promise : result,
      );
      const sessions = createSessionCapability({
        snapshot: {
          client: { request } as unknown as GatewayBrowserClient,
          phase: "connected",
          hello: null,
          assistantAgentId: agentId,
          sessionKey: key,
        },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      });
      const host = createHost({
        sessionKey: key,
        assistantAgentId: agentId,
        agentsList: { defaultId: "main", scope: target === "global" ? "global" : "per-sender" },
        sessions,
      });
      const event = {
        ...agentEvent(
          "run-1",
          1,
          "tool",
          {
            phase: "result",
            name: "session_status",
            toolCallId: "status-1",
            result: {
              details: { changedModel: true, sessionKey: target, agentId, modelOverride: override },
            },
          },
          key,
        ),
        agentId,
      };
      handleAgentEvent(host, event);
      await waitForFast(() =>
        expect(sessions.state.result?.sessions[0]?.model).toBe("gpt-5.6-sol"),
      );
      expect(request).toHaveBeenCalledWith("sessions.list", expect.objectContaining({ agentId }));
      expect(sessions.state.modelOverrides).toEqual({});

      // Replaying an old tool result reads today's row, without replacing a newer UI intent.
      result.sessions = [{ ...row, model: "gpt-5-mini" }];
      const patch = sessions.patch(key, { model: "openai/gpt-5.6-luna" });
      handleAgentEvent(
        createHost({
          sessionKey: key,
          assistantAgentId: agentId,
          agentsList: { defaultId: "main", scope: target === "global" ? "global" : "per-sender" },
          sessions,
        }),
        event,
      );
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2),
      );
      await waitForFast(() => expect(sessions.state.loading).toBe(false));
      expect(sessions.state.result?.sessions[0]?.model).toBe("gpt-5-mini");
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5.6-luna");
      pendingPatch.resolve({ ok: true, key, entry: {} });
      await patch;
      expect(sessions.state.modelOverrides).toEqual({});
      sessions.dispose();
    },
  );

  it.each([
    { changedModel: true, sessionKey: "global" },
    { changedModel: false, sessionKey: "global", agentId: "work" },
    { changedModel: true, sessionKey: "agent:work:other", agentId: "work" },
    { changedModel: true, sessionKey: "global", agentId: "main" },
  ])("does not refresh an unrelated/read-only status result (%j)", (details) => {
    const host = createHost({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });
    handleAgentEvent(host, {
      ...agentEvent(
        "run-1",
        1,
        "tool",
        {
          phase: "result",
          name: "session_status",
          toolCallId: "status-1",
          result: { details },
        },
        "global",
      ),
      agentId: "work",
    });
    expect(host.sessions.refreshReplacement).not.toHaveBeenCalled();
    expect(host.sessions.state.modelOverrides).toEqual({});
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

  it.each(["run-1", "run-2", undefined])(
    "replaces only the commentary owned by persisted run %s",
    (runId) => {
      const state = createHost({
        chatStreamSegments: [
          { itemId: "shared-item", runId: "run-1", text: "First run", ts: 1 },
          { itemId: "shared-item", runId: "run-2", text: "Second run", ts: 2 },
        ],
      });
      const originalSegments = [...state.chatStreamSegments];
      const persisted = {
        role: "assistant",
        content: "Completed progress",
        __openclaw: { id: "persisted-commentary", seq: 3, ...(runId ? { runId } : {}) },
        openclawStreamFallback: { itemId: "shared-item", source: "segment" },
      };
      prunePersistedAssistantStreamSegments(state, persisted);
      expect(state.chatStreamSegments).toEqual(
        runId ? originalSegments.filter((segment) => segment.runId !== runId) : [],
      );
      if (runId) {
        state.chatMessages = [persisted];
        handleAgentEvent(
          state,
          agentEvent(runId, 4, "item", {
            kind: "preamble",
            itemId: "shared-item",
            progressText: "Completed progress",
          }),
        );
        expect(state.chatStreamSegments).toEqual(
          originalSegments.filter((segment) => segment.runId !== runId),
        );
      }
    },
  );

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

  it.each([
    { phase: "start" },
    { phase: "end", completed: true },
    { phase: "end", completed: false },
    { phase: "end", completed: true, willRetry: true },
  ])("keeps newer compaction active after stale $phase event %j", (staleData) => {
    useToolStreamFakeTimers();
    const host = createHost();
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "compaction", { phase: "start", itemId: "compact-1" }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 3, "compaction", { phase: "start", itemId: "compact-2" }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "compaction", { ...staleData, itemId: "compact-1" }),
    );
    expect(host.compactionStatus).toMatchObject({ phase: "active", itemId: "compact-2" });

    handleAgentEvent(
      host,
      agentEvent("run-1", 4, "compaction", {
        phase: "end",
        completed: true,
        itemId: "compact-2",
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 3, "compaction", { phase: "start", itemId: "compact-2" }),
    );
    expectCompactionCompleteAndRetained(host, "compact-2");

    handleAgentEvent(
      host,
      agentEvent("run-2", 1, "compaction", { phase: "start", itemId: "compact-3" }),
    );
    expect(host.compactionStatus).toMatchObject({
      phase: "active",
      runId: "run-2",
      itemId: "compact-3",
    });
    vi.advanceTimersByTime(5 * 60_000);
    expect(host.compactionStatus).toBeNull();
  });

  it("keeps compaction in retry-pending state until the matching lifecycle end", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "compaction", { phase: "start", itemId: "compact-1" }),
    );

    expect(host.compactionStatus).toEqual({
      itemId: "compact-1",
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
      itemId: "compact-1",
      phase: "retrying",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });
    expect(host.compactionClearTimer).not.toBeNull();

    handleAgentEvent(host, agentEvent("run-2", 3, "lifecycle", { phase: "end" }));
    handleAgentEvent(host, agentEvent("run-1", 1, "lifecycle", { phase: "end" }));

    expect(host.compactionStatus).toEqual({
      itemId: "compact-1",
      phase: "retrying",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });

    handleAgentEvent(host, agentEvent("run-1", 4, "lifecycle", { phase: "end" }));

    expectCompactionCompleteAndRetained(host, "compact-1");

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
      agentsList: { defaultId: "main", scope: "global" },
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

    expectCompactionCompleteAndRetained(host);

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
