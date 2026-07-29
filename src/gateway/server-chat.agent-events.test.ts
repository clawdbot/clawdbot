// Server chat agent-event tests protect event fanout, heartbeat visibility,
// session lifecycle persistence, and subscriber registry behavior.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import { formatChannelProgressDraftLine } from "../channels/streaming.js";
import {
  claimAgentRunContext,
  emitAgentEventForOwner,
  onAgentRuntimeEvent,
  registerAgentRunContext,
  releaseAgentRunContext,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";

const persistGatewaySessionLifecycleEventMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("./server-chat.persist-session-lifecycle.runtime.js", () => ({
  persistGatewaySessionLifecycleEvent: (...args: unknown[]) =>
    persistGatewaySessionLifecycleEventMock(...args),
}));

vi.mock("../logger.js", () => ({
  logError: (...args: unknown[]) => logErrorMock(...args),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: vi.fn(() => ({
    showOk: false,
    showAlerts: true,
    useIndicator: true,
  })),
}));

vi.mock("./server-chat.load-gateway-session-row.runtime.js", () => ({
  loadGatewaySessionRow: vi.fn(),
}));

vi.mock("./session-utils.js", () => {
  const loadSessionEntry = vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/sessions.json",
    store: {},
    entry: undefined,
    canonicalKey: "session-1",
    storeKeys: ["session-1"],
    legacyKey: undefined,
  }));
  return {
    loadSessionEntry,
    loadSessionEntryReadOnly: loadSessionEntry,
  };
});

import { getRuntimeConfig } from "../config/io.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import {
  emitAgentEvent,
  emitAgentEvents,
  registerChatRun,
  registerNamedChatRun,
} from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createChatAbortMarker,
  createSessionMessageSubscriberRegistry,
  createToolEventRecipientRegistry,
  resolveChatErrorKindFromError,
  type AgentEventHandlerOptions,
} from "./server-chat.js";
import { loadGatewaySessionRow } from "./server-chat.load-gateway-session-row.runtime.js";
import { loadSessionEntry } from "./session-utils.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

describe("agent event handler", () => {
  beforeEach(() => {
    resetAgentEventsForTest({ preserveListeners: true });
    vi.mocked(getRuntimeConfig).mockReturnValue({});
    vi.mocked(resolveHeartbeatVisibility).mockReturnValue({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
    vi.mocked(loadSessionEntry)
      .mockReset()
      .mockReturnValue({
        cfg: {},
        storePath: "/tmp/sessions.json",
        store: {},
        entry: undefined,
        canonicalKey: "session-1",
        storeKeys: ["session-1"],
        legacyKey: undefined,
      });
    vi.mocked(loadGatewaySessionRow).mockReset().mockReturnValue(null);
    persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(undefined);
    logErrorMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAgentEventsForTest({ preserveListeners: true });
  });

  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
    lifecycleErrorRetryGraceMs?: number;
    isChatSendRunActive?: (runId: string) => boolean;
    clearTrackedActiveRun?: AgentEventHandlerOptions["clearTrackedActiveRun"];
    markTrackedRunTerminalPersisted?: AgentEventHandlerOptions["markTrackedRunTerminalPersisted"];
    trackTrackedRunTerminalPersistence?: AgentEventHandlerOptions["trackTrackedRunTerminalPersistence"];
    resolveActiveLifecycleGenerationForRun?: (runId: string) => string | undefined;
    updateRunToolErrorSummary?: AgentEventHandlerOptions["updateRunToolErrorSummary"];
    resolveSessionActiveRunState?: AgentEventHandlerOptions["resolveSessionActiveRunState"];
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const clearAgentRunContext = vi.fn();
    const clearTrackedActiveRun =
      vi.fn<NonNullable<AgentEventHandlerOptions["clearTrackedActiveRun"]>>();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext,
      toolEventRecipients,
      sessionEventSubscribers,
      sessionMessageSubscribers,
      loadGatewaySessionRowForSnapshot: loadGatewaySessionRow,
      lifecycleErrorRetryGraceMs: params?.lifecycleErrorRetryGraceMs,
      isChatSendRunActive: params?.isChatSendRunActive,
      clearTrackedActiveRun: params?.clearTrackedActiveRun ?? clearTrackedActiveRun,
      markTrackedRunTerminalPersisted: params?.markTrackedRunTerminalPersisted,
      trackTrackedRunTerminalPersistence: params?.trackTrackedRunTerminalPersistence,
      resolveActiveLifecycleGenerationForRun: params?.resolveActiveLifecycleGenerationForRun,
      updateRunToolErrorSummary: params?.updateRunToolErrorSummary,
      resolveSessionActiveRunState: params?.resolveSessionActiveRunState,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      clearAgentRunContext,
      clearTrackedActiveRun,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      sessionEventSubscribers,
      sessionMessageSubscribers,
      handler,
    };
  }

  function emitRun1AssistantText(
    harness: ReturnType<typeof createHarness>,
    text: string,
    field: "text" | "delta" = "text",
  ): ReturnType<typeof createHarness> {
    registerChatRun(harness.chatRunState, "run-1", "session-1", "client-1");
    emitAgentEvent(harness.handler, "run-1", "assistant", { [field]: text });
    return harness;
  }

  function mockSessionEntry(
    entry: ReturnType<typeof loadSessionEntry>["entry"],
    canonicalKey = "session-1",
  ) {
    vi.mocked(loadSessionEntry).mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      store: {},
      entry,
      canonicalKey,
      storeKeys: [canonicalKey],
      legacyKey: undefined,
    });
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function agentBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "agent");
  }

  function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
  }

  it("carries prepared validation diagnostics into active run state", () => {
    const updateRunToolErrorSummary = vi.fn();
    const { chatRunState, handler } = createHarness({ updateRunToolErrorSummary });
    registerChatRun(chatRunState, "provider-run", "session-1", "client-run");
    emitAgentEvent(
      handler,
      "provider-run",
      "tool",
      {
        phase: "result",
        name: "edit",
        isError: true,
        toolErrorSummary: "edit tool validation failed: edits: must be an array",
      },
      { ts: 1_000 },
    );

    expect(updateRunToolErrorSummary).toHaveBeenCalledWith({
      runId: "provider-run",
      clientRunId: "client-run",
      summary: "edit tool validation failed: edits: must be an array",
    });
  });

  it("records, replaces, dismisses, and clears normalized plan snapshots", () => {
    const { chatRunState, handler } = createHarness();
    registerChatRun(chatRunState, "provider-run", "session-1", "client-run");
    emitAgentEvent(
      handler,
      "provider-run",
      "plan",
      {
        phase: "update",
        explanation: "  Initial plan  ",
        steps: ["Legacy step", { step: "Active step", status: "in_progress" }],
      },
      { ts: 1_000 },
    );
    expect(chatRunState.runs.get("client-run")?.planSnapshot).toEqual({
      explanation: "Initial plan",
      steps: [
        { step: "Legacy step", status: "pending" },
        { step: "Active step", status: "in_progress" },
      ],
    });

    emitAgentEvent(
      handler,
      "provider-run",
      "plan",
      { phase: "update", steps: [{ step: "Replacement", status: "completed" }] },
      { seq: 2, ts: 1_100 },
    );
    expect(chatRunState.runs.get("client-run")?.planSnapshot).toEqual({
      steps: [{ step: "Replacement", status: "completed" }],
    });

    emitAgentEvent(
      handler,
      "provider-run",
      "plan",
      { phase: "update", steps: [] },
      {
        seq: 3,
        ts: 1_200,
      },
    );
    expect(chatRunState.runs.get("client-run")?.planSnapshot).toEqual({ steps: [] });

    chatRunState.getOrCreate("client-run").planSnapshot = {
      steps: [{ step: "Temporary", status: "pending" }],
    };
    chatRunState.clearRun("client-run");
    expect(chatRunState.runs.get("client-run")?.planSnapshot).toBeUndefined();
  });

  it.each([
    { stream: "assistant", data: { text: "Recovered" } },
    { stream: "tool", data: { phase: "start", name: "read" } },
  ] as const)("clears stale validation diagnostics on $stream progress", (progressEvent) => {
    const updateRunToolErrorSummary = vi.fn();
    const { chatRunState, handler } = createHarness({ updateRunToolErrorSummary });
    registerChatRun(chatRunState, "provider-run", "session-1", "client-run");
    emitAgentEvent(
      handler,
      "provider-run",
      "tool",
      {
        phase: "result",
        name: "edit",
        isError: true,
        toolErrorSummary: "edit tool validation failed: invalid arguments",
      },
      { ts: 1_000 },
    );
    emitAgentEvent(handler, "provider-run", progressEvent.stream, progressEvent.data, {
      seq: 2,
      ts: 1_100,
    });

    expect(updateRunToolErrorSummary).toHaveBeenLastCalledWith({
      runId: "provider-run",
      clientRunId: "client-run",
      summary: undefined,
    });
  });

  function sessionAgentCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
  }

  function requireCall<T>(call: T | undefined, label: string): T {
    if (call === undefined) {
      throw new Error(`expected ${label}`);
    }
    return call;
  }

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${label} was not an object`);
    }
    return value as Record<string, unknown>;
  }

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  function expectPayloadFields(value: unknown, fields: Record<string, unknown>) {
    expectRecordFields(requireRecord(value, "event payload"), fields);
  }

  function expectPayloadDataFields(value: unknown, fields: Record<string, unknown>) {
    const payload = requireRecord(value, "event payload");
    expectRecordFields(requireRecord(payload.data, "event payload data"), fields);
  }

  function requireMockCall(mock: ReturnType<typeof vi.fn>, index: number, label: string) {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`missing ${label} call ${index + 1}`);
    }
    return call;
  }

  function requireMockArg(
    mock: ReturnType<typeof vi.fn>,
    index: number,
    argIndex: number,
    label: string,
  ) {
    return requireMockCall(mock, index, label)[argIndex];
  }

  function requireMockPayload(
    mock: ReturnType<typeof vi.fn>,
    index: number,
    payloadIndex: number,
    label: string,
  ) {
    return requireRecord(requireMockArg(mock, index, payloadIndex, label), label);
  }

  const FALLBACK_LIFECYCLE_DATA = {
    phase: "fallback",
    selectedProvider: "fireworks",
    selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
    activeProvider: "deepinfra",
    activeModel: "moonshotai/Kimi-K2.5",
  } as const;

  const SESSION_OWNERSHIP = {
    spawnedBy: "agent:main:main",
    spawnedWorkspaceDir: "/tmp/subagent",
    forkedFromParent: true,
    spawnDepth: 2,
    subagentRole: "orchestrator",
    subagentControlScope: "children",
    lastThreadId: 42,
    fastMode: true,
    verboseLevel: "on",
  } as const;

  const OWNED_SESSION_ROW = {
    key: "session-1",
    kind: "direct" as const,
    ...SESSION_OWNERSHIP,
    updatedAt: 1_200,
  };

  function emitLifecycleEnd(
    handler: ReturnType<typeof createHarness>["handler"],
    runId: string,
    seq = 2,
  ) {
    emitAgentEvent(handler, runId, "lifecycle", { phase: "end" }, { seq });
  }

  function emitFallbackLifecycle(params: {
    handler: ReturnType<typeof createHarness>["handler"];
    runId: string;
    seq?: number;
    sessionKey?: string;
  }) {
    emitAgentEvent(
      params.handler,
      params.runId,
      "lifecycle",
      { ...FALLBACK_LIFECYCLE_DATA },
      {
        seq: params.seq ?? 1,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      },
    );
  }

  function expectSingleAgentBroadcastPayload(broadcast: ReturnType<typeof vi.fn>) {
    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    return broadcastAgentCalls[0]?.[1] as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
      data?: Record<string, unknown>;
    };
  }

  function expectSingleFinalChatPayload(broadcast: ReturnType<typeof vi.fn>) {
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: unknown;
    };
    expect(payload.state).toBe("final");
    return payload;
  }

  it("injects isHeartbeat into agent broadcast payloads when present in run context", () => {
    const harness = createHarness();
    for (const { runId, sessionKey, isHeartbeat, ts, needsUnlinkedEvent } of [
      {
        runId: "run-heartbeat-true",
        sessionKey: "session-1",
        isHeartbeat: true,
        ts: 100,
        needsUnlinkedEvent: true,
      },
      {
        runId: "run-heartbeat-false",
        sessionKey: "session-2",
        isHeartbeat: false,
        ts: 101,
        needsUnlinkedEvent: false,
      },
      {
        runId: "run-normal",
        sessionKey: "session-3",
        isHeartbeat: undefined,
        ts: 102,
        needsUnlinkedEvent: false,
      },
    ] as const) {
      if (isHeartbeat !== undefined) {
        registerAgentRunContext(runId, { sessionKey, isHeartbeat });
      }
      if (needsUnlinkedEvent) {
        emitAgentEvent(harness.handler, runId, "assistant", { text: "hello" }, { ts });
      }
      registerChatRun(harness.chatRunState, runId, sessionKey, runId);
      emitAgentEvent(
        harness.handler,
        runId,
        "assistant",
        { text: "hello" },
        {
          seq: needsUnlinkedEvent ? 2 : 1,
          ts,
        },
      );

      for (const payload of [
        harness.broadcast.mock.calls.find(([event]) => event === "agent")?.[1],
        harness.nodeSendToSession.mock.calls.find(([, event]) => event === "agent")?.[2],
      ]) {
        const record = requireRecord(requireCall(payload, "agent payload"), "agent payload");
        if (isHeartbeat === undefined) {
          expect(record).not.toHaveProperty("isHeartbeat");
        } else {
          expect(record.isHeartbeat).toBe(isHeartbeat);
        }
      }
      harness.broadcast.mockClear();
      harness.nodeSendToSession.mockClear();
    }
  });

  it.each(["text", "delta"] as const)("emits chat delta for assistant %s-only events", (field) => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello world",
      field,
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      deltaText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.deltaText).toBe("Hello world");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("keeps internal context private when it spans delta-only events", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 1_000 });
    registerNamedChatRun(chatRunState, "split-context");

    const deltas = [
      `Visible\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n`,
      "private runtime detail\n",
      `${INTERNAL_RUNTIME_CONTEXT_END}\nAfter`,
    ];
    deltas.forEach((delta, index) => {
      emitAgentEvent(handler, "run-split-context", "assistant", { delta }, { seq: index + 1 });
    });
    emitLifecycleEnd(handler, "run-split-context", 4);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(JSON.stringify(chatCalls)).not.toContain("private runtime detail");
    const finalPayload = chatCalls.at(-1)?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Visible\n\nAfter");
    nowSpy?.mockRestore();
  });

  it("emits the first assistant chat.send timing event to the originating Control UI", () => {
    const { broadcastToConnIds, chatRunState, handler, nowSpy } = createHarness({ now: 1_000 });
    registerChatRun(chatRunState, "run-1", "session-1", "client-1", {
      chatSendTiming: {
        ackedAtMs: 0,
        connId: "conn-control-ui",
        dispatchStartedAtMs: 0,
        receivedAtMs: 0,
      },
    });

    emitAgentEvents(handler, "run-1", [
      ["assistant", { text: "Hello world" }],
      ["assistant", { text: "Hello world again" }],
    ]);

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "chat.send_timing",
      expect.objectContaining({
        phase: "first-assistant-event",
        runId: "client-1",
        sessionKey: "session-1",
        ackToPhaseMs: expect.any(Number),
        dispatchStartedToPhaseMs: expect.any(Number),
        receivedToPhaseMs: expect.any(Number),
      }),
      new Set(["conn-control-ui"]),
      { dropIfSlow: true },
    );
    nowSpy?.mockRestore();
  });

  it("emits first assistant chat.send timing when text first flushes on final", () => {
    const { broadcastToConnIds, chatRunState, handler, nowSpy } = createHarness({ now: 1_000 });
    registerChatRun(chatRunState, "run-final-only", "session-1", "client-final", {
      chatSendTiming: {
        ackedAtMs: 0,
        connId: "conn-control-ui",
        dispatchStartedAtMs: 0,
        receivedAtMs: 0,
      },
    });
    chatRunState.getOrCreate("client-final").buffer = "Final only reply";

    emitAgentEvent(handler, "run-final-only", "lifecycle", { phase: "end" });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "chat.send_timing",
      expect.objectContaining({
        phase: "first-assistant-event",
        runId: "client-final",
        sessionKey: "session-1",
        ackToPhaseMs: expect.any(Number),
        dispatchStartedToPhaseMs: expect.any(Number),
        receivedToPhaseMs: expect.any(Number),
      }),
      new Set(["conn-control-ui"]),
      { dropIfSlow: true },
    );
    nowSpy?.mockRestore();
  });

  it("projects typed run startup status onto the active chat stream", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "startup", {
      agentId: "main",
    });

    emitAgentEvent(handler, "run-startup", "run_status", { phase: "preparing_context" });

    expect(chatBroadcastCalls(broadcast)).toEqual([
      [
        "chat",
        {
          runId: "client-startup",
          sessionKey: "session-startup",
          agentId: "main",
          seq: 1,
          state: "status",
          phase: "preparing_context",
        },
        { dropIfSlow: true, sessionKeys: ["session-startup"] },
      ],
    ]);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    expect(agentBroadcastCalls(broadcast)).toHaveLength(1);
  });

  it("coalesces assistant agent events under the chat delta throttle", () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "agent-throttle");

    for (let i = 0; i < 5; i += 1) {
      now = 10_000 + i * 20;
      emitAgentEvent(
        handler,
        "run-agent-throttle",
        "assistant",
        { text: "x".repeat(i + 1), delta: "x" },
        { seq: i + 1 },
      );
    }

    const agentCalls = agentBroadcastCalls(broadcast);
    expect(agentCalls).toHaveLength(1);
    expect(sessionAgentCalls(nodeSendToSession)).toHaveLength(1);
    expect(chatBroadcastCalls(broadcast)).toHaveLength(1);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    expect(
      (
        expectDefined(agentCalls[0], "agentCalls[0] test invariant")[1] as {
          data?: { text?: string };
        }
      ).data?.text,
    ).toBe("x");
    nowSpy.mockRestore();
  });

  it("flushes coalesced assistant agent text before lifecycle end", () => {
    let now = 20_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "agent-flush");

    emitAgentEvent(handler, "run-agent-flush", "assistant", { text: "Hello", delta: "Hello" });
    now = 20_050;
    emitAgentEvent(
      handler,
      "run-agent-flush",
      "assistant",
      { text: "Hello world", delta: " world" },
      { seq: 2 },
    );
    now = 20_090;
    emitAgentEvent(
      handler,
      "run-agent-flush",
      "assistant",
      { text: "Hello world!", delta: "!" },
      { seq: 3 },
    );
    emitAgentEvent(handler, "run-agent-flush", "lifecycle", { phase: "end" }, { seq: 4 });

    const agentCalls = agentBroadcastCalls(broadcast);
    expect(agentCalls).toHaveLength(3);
    expect(
      (
        expectDefined(agentCalls[0], "agentCalls[0] test invariant")[1] as {
          data?: { text?: string };
        }
      ).data?.text,
    ).toBe("Hello");
    expect(
      (
        expectDefined(agentCalls[1], "agentCalls[1] test invariant")[1] as {
          data?: { delta?: string };
        }
      ).data?.delta,
    ).toBe(" world!");
    expect(
      (
        expectDefined(agentCalls[1], "agentCalls[1] test invariant")[1] as {
          data?: { text?: string };
        }
      ).data?.text,
    ).toBe("Hello world!");
    expect(
      (expectDefined(agentCalls[1], "agentCalls[1] test invariant")[1] as { seq?: number }).seq,
    ).toBe(3);
    expect(
      (
        expectDefined(agentCalls[2], "agentCalls[2] test invariant")[1] as {
          stream?: string;
          data?: { phase?: string };
        }
      ).stream,
    ).toBe("lifecycle");
    expect(
      (
        expectDefined(agentCalls[2], "agentCalls[2] test invariant")[1] as {
          data?: { phase?: string };
        }
      ).data?.phase,
    ).toBe("end");
    expect(sessionAgentCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("flushes pending assistant agent deltas before post-window text", () => {
    let now = 22_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "agent-window");

    emitAgentEvent(handler, "run-agent-window", "assistant", { text: "Hel", delta: "Hel" });
    now = 22_050;
    emitAgentEvent(
      handler,
      "run-agent-window",
      "assistant",
      { text: "Hello", delta: "lo" },
      { seq: 2 },
    );
    now = 22_200;
    emitAgentEvent(
      handler,
      "run-agent-window",
      "assistant",
      { text: "Hello!", delta: "!" },
      { seq: 3 },
    );

    const agentCalls = agentBroadcastCalls(broadcast);
    expect(agentCalls).toHaveLength(3);
    expect(
      (
        expectDefined(agentCalls[0], "agentCalls[0] test invariant")[1] as {
          data?: { delta?: string };
        }
      ).data?.delta,
    ).toBe("Hel");
    expect(
      (
        expectDefined(agentCalls[1], "agentCalls[1] test invariant")[1] as {
          data?: { delta?: string };
        }
      ).data?.delta,
    ).toBe("lo");
    expect(
      (expectDefined(agentCalls[1], "agentCalls[1] test invariant")[1] as { seq?: number }).seq,
    ).toBe(2);
    expect(
      (
        expectDefined(agentCalls[2], "agentCalls[2] test invariant")[1] as {
          data?: { delta?: string };
        }
      ).data?.delta,
    ).toBe("!");
    expect(
      (expectDefined(agentCalls[2], "agentCalls[2] test invariant")[1] as { seq?: number }).seq,
    ).toBe(3);
    expect(sessionAgentCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("flushes older cross-stream agent deltas before immediate text", () => {
    let now = 23_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "agent-cross-stream");

    emitAgentEvent(handler, "run-agent-cross-stream", "thinking", {
      text: "Think",
      delta: "Think",
    });
    now = 23_050;
    emitAgentEvent(
      handler,
      "run-agent-cross-stream",
      "thinking",
      { text: "Thinking", delta: "ing" },
      { seq: 2 },
    );
    now = 23_080;
    emitAgentEvent(
      handler,
      "run-agent-cross-stream",
      "assistant",
      { text: "Answer", delta: "Answer" },
      { seq: 3 },
    );

    const agentCalls = agentBroadcastCalls(broadcast);
    expect(agentCalls.map(([, payload]) => (payload as { seq?: number }).seq)).toEqual([1, 2, 3]);
    expect(agentCalls.map(([, payload]) => (payload as { stream?: string }).stream)).toEqual([
      "thinking",
      "thinking",
      "assistant",
    ]);
    expect(
      (
        expectDefined(agentCalls[1], "agentCalls[1] test invariant")[1] as {
          data?: { delta?: string };
        }
      ).data?.delta,
    ).toBe("ing");
    expect(sessionAgentCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("does not let lifecycle start throttle the first assistant agent event", () => {
    let now = 25_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "agent-start");

    emitAgentEvent(handler, "run-agent-start", "lifecycle", { phase: "start" });
    now = 25_050;
    emitAgentEvent(
      handler,
      "run-agent-start",
      "assistant",
      { text: "Hello", delta: "Hello" },
      { seq: 2 },
    );

    const agentCalls = agentBroadcastCalls(broadcast);
    expect(agentCalls).toHaveLength(2);
    expect(
      (expectDefined(agentCalls[0], "agentCalls[0] test invariant")[1] as { stream?: string })
        .stream,
    ).toBe("lifecycle");
    expect(
      (
        expectDefined(agentCalls[1], "agentCalls[1] test invariant")[1] as {
          data?: { text?: string };
        }
      ).data?.text,
    ).toBe("Hello");
    expect(sessionAgentCalls(nodeSendToSession)).toHaveLength(2);
    nowSpy.mockRestore();
  });

  it("coalesces thinking agent events under the chat delta throttle", () => {
    let now = 27_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "agent-thinking");

    for (let i = 0; i < 5; i += 1) {
      now = 27_000 + i * 20;
      emitAgentEvent(
        handler,
        "run-agent-thinking",
        "thinking",
        { text: "t".repeat(i + 1), delta: "t" },
        { seq: i + 1 },
      );
    }

    const agentCalls = agentBroadcastCalls(broadcast);
    expect(agentCalls).toHaveLength(1);
    expect(sessionAgentCalls(nodeSendToSession)).toHaveLength(1);
    expect(
      (expectDefined(agentCalls[0], "agentCalls[0] test invariant")[1] as { stream?: string })
        .stream,
    ).toBe("thinking");
    expect(
      (
        expectDefined(agentCalls[0], "agentCalls[0] test invariant")[1] as {
          data?: { text?: string };
        }
      ).data?.text,
    ).toBe("t");
    nowSpy.mockRestore();
  });

  it("does not drop non-cumulative assistant agent events while coalescing text", () => {
    let now = 30_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "agent-media");

    emitAgentEvent(handler, "run-agent-media", "assistant", { text: "Look", delta: "Look" });
    now = 30_050;
    emitAgentEvent(
      handler,
      "run-agent-media",
      "assistant",
      { text: "Look", delta: "", mediaUrls: ["https://example.test/image.png"] },
      { seq: 2 },
    );
    now = 30_070;
    emitAgentEvent(
      handler,
      "run-agent-media",
      "assistant",
      { text: "Look elsewhere", delta: "", replace: true },
      { seq: 3 },
    );
    now = 30_090;
    emitAgentEvent(
      handler,
      "run-agent-media",
      "assistant",
      { text: "Look elsewhere now", delta: " now" },
      { seq: 4 },
    );
    emitAgentEvent(handler, "run-agent-media", "lifecycle", { phase: "end" }, { seq: 5 });

    const agentCalls = agentBroadcastCalls(broadcast);
    expect(agentCalls).toHaveLength(5);
    expect(
      (
        expectDefined(agentCalls[1], "agentCalls[1] test invariant")[1] as {
          data?: { mediaUrls?: string[] };
        }
      ).data?.mediaUrls,
    ).toEqual(["https://example.test/image.png"]);
    expect(
      (
        expectDefined(agentCalls[2], "agentCalls[2] test invariant")[1] as {
          data?: { replace?: boolean };
        }
      ).data?.replace,
    ).toBe(true);
    expect(
      (
        expectDefined(agentCalls[3], "agentCalls[3] test invariant")[1] as {
          data?: { text?: string };
        }
      ).data?.text,
    ).toBe("Look elsewhere now");
    expect(sessionAgentCalls(nodeSendToSession)).toHaveLength(5);
    nowSpy.mockRestore();
  });

  it("strips inline directives from assistant chat events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello [[reply_to_current]] world [[audio_as_voice]]",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe("Hello  world ");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("strips internal runtime context from assistant chat events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      [
        "Visible before.",
        "",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "OpenClaw runtime context (internal):",
        "[Internal task completion event]",
        "secret child result",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        "",
        "Visible after.",
      ].join("\n"),
    );

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe("Visible before.\n\nVisible after.");
    expect(payload.message?.content?.[0]?.text).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
    expect(payload.message?.content?.[0]?.text).not.toContain("secret child result");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it.each([" NO_REPLY  ", " ANNOUNCE_SKIP ", " REPLY_SKIP "])(
    "does not emit chat delta for suppressed control text %s",
    (replyText) => {
      const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
        createHarness({ now: 1_000 }),
        replyText,
      );
      expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
      expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);
      nowSpy?.mockRestore();
    },
  );

  it.each(["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "does not include %s text in chat final message",
    (replyText) => {
      const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
        now: 2_000,
      });
      registerNamedChatRun(chatRunState, "2");

      emitAgentEvent(handler, "run-2", "assistant", { text: replyText });
      emitLifecycleEnd(handler, "run-2");

      const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
      expect(payload.message).toBeUndefined();
      expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
      nowSpy?.mockRestore();
    },
  );

  it("suppresses NO_REPLY lead fragments and does not leak NO in final chat message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_100,
    });
    registerNamedChatRun(chatRunState, "3");

    for (const text of ["NO", "NO_", "NO_RE", "NO_REPLY"]) {
      emitAgentEvent(handler, "run-3", "assistant", { text });
    }
    emitLifecycleEnd(handler, "run-3");

    const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(payload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it.each([
    ["ANNOUNCE_SKIP", ["ANN", "ANNOUNCE_", "ANNOUNCE_SKIP"]],
    ["REPLY_SKIP", ["REP", "REPLY_", "REPLY_SKIP"]],
  ] as const)(
    "suppresses %s lead fragments and does not leak the streamed prefix in the final chat message",
    (_replyText, fragments) => {
      const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
        now: 2_150,
      });
      registerNamedChatRun(chatRunState, "control");

      for (const text of fragments) {
        emitAgentEvent(handler, "run-control", "assistant", { text });
      }
      emitLifecycleEnd(handler, "run-control");

      const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
      expect(payload.message).toBeUndefined();
      expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
      nowSpy?.mockRestore();
    },
  );

  it("keeps final short replies like 'No' even when lead-fragment deltas are suppressed", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_200,
    });
    registerNamedChatRun(chatRunState, "4");

    emitAgentEvent(handler, "run-4", "assistant", { text: "No" });
    emitLifecycleEnd(handler, "run-4");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe("No");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("strips a glued leading NO_REPLY token from cumulative chat snapshots", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_250,
    });
    registerNamedChatRun(chatRunState, "4b");

    emitAgentEvents(handler, "run-4b", [
      ["assistant", { text: "NO_REPLYThe user" }],
      ["assistant", { text: "NO_REPLYThe user is saying hello" }],
    ]);
    emitLifecycleEnd(handler, "run-4b");

    const chatCalls = chatBroadcastCalls(broadcast);
    const finalPayload = chatCalls.at(-1)?.[1] as {
      message?: { content?: Array<{ text?: string }> };
      state?: string;
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("The user is saying hello");
    expect(
      chatCalls.every(([, payload]) => {
        const text = (payload as { message?: { content?: Array<{ text?: string }> } }).message
          ?.content?.[0]?.text;
        return !text || !text.includes("NO_REPLY");
      }),
    ).toBe(true);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(chatCalls.length);
    nowSpy?.mockRestore();
  });

  it("flushes buffered text as delta before final when throttle suppresses the latest chunk", () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "flush");

    emitAgentEvent(handler, "run-flush", "assistant", { text: "Hello" });

    now = 10_100;
    emitAgentEvent(handler, "run-flush", "assistant", { text: "Hello world" });

    emitLifecycleEnd(handler, "run-flush");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const firstPayload = chatCalls[0]?.[1] as { state?: string; deltaText?: string };
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      deltaText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const thirdPayload = chatCalls[2]?.[1] as { state?: string };
    expect(firstPayload.state).toBe("delta");
    expect(firstPayload.deltaText).toBe("Hello");
    expect(secondPayload.state).toBe("delta");
    expect(secondPayload.deltaText).toBe(" world");
    expect(secondPayload.message?.content?.[0]?.text).toBe("Hello world");
    expect(thirdPayload.state).toBe("final");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("preserves pre-tool assistant text when later segments stream as non-prefix snapshots", () => {
    let now = 10_500;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "segmented");

    emitAgentEvent(handler, "run-segmented", "assistant", {
      text: "Before tool call",
      delta: "Before tool call",
    });

    now = 10_700;
    emitAgentEvent(
      handler,
      "run-segmented",
      "assistant",
      { text: "After tool call", delta: "\nAfter tool call" },
      { seq: 2 },
    );

    emitLifecycleEnd(handler, "run-segmented", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      deltaText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const finalPayload = chatCalls[2]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(secondPayload.state).toBe("delta");
    expect(secondPayload.deltaText).toBe("\nAfter tool call");
    expect(secondPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("flushes merged segmented text before final when latest segment is throttled", () => {
    let now = 10_800;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "segmented-flush");

    emitAgentEvent(handler, "run-segmented-flush", "assistant", {
      text: "Before tool call",
      delta: "Before tool call",
    });

    now = 10_860;
    emitAgentEvent(
      handler,
      "run-segmented-flush",
      "assistant",
      { text: "After tool call", delta: "\nAfter tool call" },
      { seq: 2 },
    );

    emitLifecycleEnd(handler, "run-segmented-flush", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const flushPayload = chatCalls[1]?.[1] as {
      state?: string;
      deltaText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const finalPayload = chatCalls[2]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(flushPayload.state).toBe("delta");
    expect(flushPayload.deltaText).toBe("\nAfter tool call");
    expect(flushPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("does not flush an extra delta when the latest text already broadcast", () => {
    let now = 11_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "no-dup-flush");

    emitAgentEvent(handler, "run-no-dup-flush", "assistant", { text: "Hello" });

    now = 11_200;
    emitAgentEvent(handler, "run-no-dup-flush", "assistant", { text: "Hello world" });

    emitLifecycleEnd(handler, "run-no-dup-flush");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    expect(chatCalls.map(([, payload]) => (payload as { state?: string }).state)).toEqual([
      "delta",
      "delta",
      "final",
    ]);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("does not emit a delta when a repeated assistant snapshot is unchanged", () => {
    let now = 11_250;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "unchanged-snapshot");

    emitAgentEvent(handler, "run-unchanged-snapshot", "assistant", { text: "Hello world" });

    now = 11_450;
    emitAgentEvent(
      handler,
      "run-unchanged-snapshot",
      "assistant",
      { text: "Hello world" },
      { seq: 2 },
    );

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as { deltaText?: string };
    expect(payload.deltaText).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("marks non-prefix replacement deltas explicitly", () => {
    let now = 11_300;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "replacement");

    emitAgentEvent(handler, "run-replacement", "assistant", { text: "Hello world" });

    now = 11_500;
    emitAgentEvent(handler, "run-replacement", "assistant", { text: "Goodbye world" }, { seq: 2 });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const firstPayload = chatCalls[0]?.[1] as { deltaText?: string };
    const replacementPayload = chatCalls[1]?.[1] as {
      deltaText?: string;
      replace?: boolean;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(firstPayload.deltaText).toBe("Hello world");
    expect(replacementPayload.message?.content?.[0]?.text).toBe("Goodbye world");
    expect(replacementPayload.deltaText).toBe("Goodbye world");
    expect(replacementPayload.replace).toBe(true);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(2);
    nowSpy.mockRestore();
  });

  it("flushes throttled shorter replacement deltas before final", () => {
    let now = 11_700;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "short-replacement-flush");

    emitAgentEvent(handler, "run-short-replacement-flush", "assistant", { text: "Hello world" });

    now = 11_760;
    emitAgentEvent(handler, "run-short-replacement-flush", "assistant", { text: "Hi" }, { seq: 2 });

    emitLifecycleEnd(handler, "run-short-replacement-flush", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const replacementPayload = chatCalls[1]?.[1] as {
      state?: string;
      deltaText?: string;
      replace?: boolean;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(replacementPayload.state).toBe("delta");
    expect(replacementPayload.deltaText).toBe("Hi");
    expect(replacementPayload.replace).toBe(true);
    expect(replacementPayload.message?.content?.[0]?.text).toBe("Hi");
    expect(
      (expectDefined(chatCalls[2], "chatCalls[2] test invariant")[1] as { state?: string }).state,
    ).toBe("final");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2_500 });
    registerNamedChatRun(chatRunState, "cleanup");

    emitAgentEvent(handler, "run-cleanup", "assistant", { text: "done" });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    emitAgentEvent(handler, "run-cleanup", "lifecycle", { phase: "end" }, { seq: 2 });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("drops stale events that arrive after lifecycle completion", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_500,
    });
    registerNamedChatRun(chatRunState, "stale-tail");

    emitAgentEvent(handler, "run-stale-tail", "assistant", { text: "done" });
    emitLifecycleEnd(handler, "run-stale-tail");
    const errorCallsBeforeStaleEvent = broadcast.mock.calls.filter(
      ([event, payload]) =>
        event === "agent" && (payload as { stream?: string }).stream === "error",
    ).length;
    const sessionChatCallsBeforeStaleEvent = sessionChatCalls(nodeSendToSession).length;

    emitAgentEvent(handler, "run-stale-tail", "assistant", { text: "late tail" }, { seq: 3 });

    const errorCalls = broadcast.mock.calls.filter(
      ([event, payload]) =>
        event === "agent" && (payload as { stream?: string }).stream === "error",
    );
    expect(errorCalls).toHaveLength(errorCallsBeforeStaleEvent);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(sessionChatCallsBeforeStaleEvent);
    nowSpy?.mockRestore();
  });

  it("flushes buffered chat delta before tool start events", () => {
    let now = 12_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const {
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      chatRunState,
      toolEventRecipients,
      handler,
    } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-flush",
    });

    registerNamedChatRun(chatRunState, "tool-flush");
    registerAgentRunContext("run-tool-flush", {
      sessionKey: "session-tool-flush",
      verboseLevel: "off",
    });
    toolEventRecipients.add("run-tool-flush", "conn-1");

    emitAgentEvent(handler, "run-tool-flush", "assistant", { text: "Before tool" });

    // Throttled assistant update (within 150ms window).
    now = 12_050;
    emitAgentEvent(
      handler,
      "run-tool-flush",
      "assistant",
      { text: "Before tool expanded" },
      { seq: 2 },
    );

    emitAgentEvent(
      handler,
      "run-tool-flush",
      "tool",
      { phase: "start", name: "read", toolCallId: "tool-flush-1" },
      { seq: 3 },
    );

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const flushedPayload = chatCalls[1]?.[1] as {
      state?: string;
      deltaText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(flushedPayload.state).toBe("delta");
    expect(flushedPayload.deltaText).toBe(" expanded");
    expect(flushedPayload.message?.content?.[0]?.text).toBe("Before tool expanded");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(2);

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const flushCallOrder = broadcast.mock.invocationCallOrder[1] ?? 0;
    const toolCallOrder = broadcastToConnIds.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(flushCallOrder).toBeLessThan(toolCallOrder);
    nowSpy.mockRestore();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    emitAgentEvent(handler, "run-tool", "tool", { phase: "start", name: "read", toolCallId: "t1" });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
  });

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    emitAgentEvent(handler, "run-tool-off", "tool", {
      phase: "start",
      name: "read",
      toolCallId: "t2",
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
  });

  it("uses newer session verbose state for in-flight tool events", () => {
    const { nodeSendToSession, handler } = createHarness({
      now: 1_000,
      resolveSessionKeyForRun: () => "session-1",
    });
    mockSessionEntry({ sessionId: "session-1", verboseLevel: "on", updatedAt: 1_500 });

    registerAgentRunContext("run-tool-toggle", {
      sessionKey: "session-1",
      verboseLevel: "off",
    });

    emitAgentEvent(handler, "run-tool-toggle", "tool", {
      phase: "start",
      name: "read",
      toolCallId: "t-toggle",
    });

    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(1);
    const payload = requireRecord(nodeToolCalls[0]?.[2], "node tool payload");
    expect(payload.stream).toBe("tool");
    expectRecordFields(requireRecord(payload.data, "node tool payload data"), {
      phase: "start",
      name: "read",
    });
  });

  it("keeps one-shot run verbose over older session state", () => {
    const { nodeSendToSession, handler } = createHarness({
      now: 2_000,
      resolveSessionKeyForRun: () => "session-1",
    });
    mockSessionEntry({ sessionId: "session-1", verboseLevel: "off", updatedAt: 1_500 });

    registerAgentRunContext("run-tool-inline", {
      sessionKey: "session-1",
      verboseLevel: "on",
    });

    emitAgentEvent(handler, "run-tool-inline", "tool", {
      phase: "start",
      name: "read",
      toolCallId: "t-inline",
    });

    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(1);
  });

  it("mirrors tool events to session subscribers so late-joining operator UIs can render them", () => {
    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    vi.mocked(loadGatewaySessionRow).mockReturnValue(OWNED_SESSION_ROW);

    registerAgentRunContext("run-session-tool", { sessionKey: "session-1", verboseLevel: "off" });
    sessionEventSubscribers.subscribe("conn-session");

    emitAgentEvent(
      handler,
      "run-session-tool",
      "tool",
      {
        phase: "start",
        name: "exec",
        toolCallId: "tool-session-1",
        args: { command: "echo hi" },
      },
      { ts: 1_234 },
    );

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(requireMockArg(broadcastToConnIds, 0, 0, "session tool event")).toBe("session.tool");
    const sessionToolPayload = requireMockPayload(broadcastToConnIds, 0, 1, "session tool payload");
    expectRecordFields(sessionToolPayload, {
      runId: "run-session-tool",
      sessionKey: "session-1",
      ...SESSION_OWNERSHIP,
      stream: "tool",
      ts: 1_234,
    });
    expectRecordFields(requireRecord(sessionToolPayload.data, "session tool payload data"), {
      phase: "start",
      name: "exec",
      toolCallId: "tool-session-1",
      args: { command: "echo hi" },
    });
    expect(requireMockArg(broadcastToConnIds, 0, 2, "session tool recipients")).toEqual(
      new Set(["conn-session"]),
    );
    expect(requireMockArg(broadcastToConnIds, 0, 3, "session tool options")).toEqual({
      dropIfSlow: true,
    });
  });

  it("loads selected-agent global session snapshots for tool events", () => {
    const { broadcastToConnIds, chatRunState, sessionEventSubscribers, handler } = createHarness();
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "global",
      kind: "global",
      model: "work-model",
      goal: {
        schemaVersion: 1,
        id: "goal-work",
        objective: "ship scoped goals",
        status: "active",
        createdAt: 1_000,
        updatedAt: 1_100,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
      status: "running",
      updatedAt: 1_200,
    });
    registerChatRun(chatRunState, "run-global-tool", "global", "client-global-tool", {
      agentId: "work",
    });
    sessionEventSubscribers.subscribe("conn-session");

    emitAgentEvent(
      handler,
      "run-global-tool",
      "tool",
      { phase: "start", name: "exec", toolCallId: "tool-global-1" },
      { ts: 1_234 },
    );

    expect(loadGatewaySessionRow).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(requireMockArg(broadcastToConnIds, 0, 0, "session tool event")).toBe("session.tool");
    expect(requireMockPayload(broadcastToConnIds, 0, 1, "session tool payload")).toEqual(
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
        model: "work-model",
        goal: expect.objectContaining({
          objective: "ship scoped goals",
          status: "active",
        }),
        status: "running",
      }),
    );
  });

  it("does not duplicate tool events to clients subscribed by run and session", () => {
    const { broadcastToConnIds, sessionEventSubscribers, toolEventRecipients, handler } =
      createHarness({
        resolveSessionKeyForRun: () => "session-dedupe",
      });

    registerAgentRunContext("run-session-dedupe-tool", {
      sessionKey: "session-dedupe",
      verboseLevel: "off",
    });
    toolEventRecipients.add("run-session-dedupe-tool", "conn-overlap");
    toolEventRecipients.add("run-session-dedupe-tool", "conn-run-only");
    sessionEventSubscribers.subscribe("conn-overlap");
    sessionEventSubscribers.subscribe("conn-session-only");

    emitAgentEvent(
      handler,
      "run-session-dedupe-tool",
      "tool",
      {
        phase: "start",
        name: "exec",
        toolCallId: "tool-session-dedupe-1",
        args: { command: "echo hi" },
      },
      { ts: 1_234 },
    );

    expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(requireMockArg(broadcastToConnIds, 0, 0, "run tool event")).toBe("agent");
    expect(requireMockArg(broadcastToConnIds, 0, 2, "run tool recipients")).toEqual(
      new Set(["conn-overlap", "conn-run-only"]),
    );
    expect(requireMockArg(broadcastToConnIds, 1, 0, "session tool event")).toBe("session.tool");
    expect(requireMockArg(broadcastToConnIds, 1, 2, "session tool recipients")).toEqual(
      new Set(["conn-session-only"]),
    );
  });

  it("suppresses heartbeat tool events for Control UI and verbose node subscribers", () => {
    const {
      broadcastToConnIds,
      nodeSendToSession,
      sessionEventSubscribers,
      toolEventRecipients,
      handler,
    } = createHarness({
      resolveSessionKeyForRun: () => "session-heartbeat",
    });

    registerAgentRunContext("run-heartbeat-tool", {
      sessionKey: "session-heartbeat",
      isHeartbeat: true,
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-heartbeat-tool", "conn-run");
    sessionEventSubscribers.subscribe("conn-session");

    emitAgentEvent(
      handler,
      "run-heartbeat-tool",
      "tool",
      {
        phase: "start",
        name: "read",
        toolCallId: "tool-heartbeat-1",
        args: { path: "HEARTBEAT.md" },
      },
      { ts: 1_234 },
    );

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
  });

  it("hydrates run-scoped tool events with session ownership metadata", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    vi.mocked(loadGatewaySessionRow).mockReturnValue(OWNED_SESSION_ROW);

    registerAgentRunContext("run-tool-owner", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-owner", "conn-run");

    emitAgentEvent(
      handler,
      "run-tool-owner",
      "tool",
      {
        phase: "start",
        name: "exec",
        toolCallId: "tool-run-1",
        args: { command: "echo hi" },
      },
      { ts: 1_234 },
    );

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(requireMockArg(broadcastToConnIds, 0, 0, "run tool event")).toBe("agent");
    const runToolPayload = requireMockPayload(broadcastToConnIds, 0, 1, "run tool payload");
    expectRecordFields(runToolPayload, {
      runId: "run-tool-owner",
      sessionKey: "session-1",
      ...SESSION_OWNERSHIP,
      stream: "tool",
      ts: 1_234,
    });
    expectRecordFields(requireRecord(runToolPayload.data, "run tool payload data"), {
      phase: "start",
      name: "exec",
      toolCallId: "tool-run-1",
      args: { command: "echo hi" },
    });
    expect(requireMockArg(broadcastToConnIds, 0, 2, "run tool recipients")).toEqual(
      new Set(["conn-run"]),
    );
    expect(requireMockArg(broadcastToConnIds, 0, 3, "run tool options")).toEqual({
      sessionKeys: ["session-1"],
    });
  });

  it("projects tool-search bridge calls like native channel verbose tool events", () => {
    const { nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-search-node", {
      sessionKey: "session-1",
      verboseLevel: "on",
    });

    emitAgentEvent(
      handler,
      "run-tool-search-node",
      "tool",
      {
        phase: "start",
        name: "tool_search_code",
        toolCallId: "tool-search-node-1",
        args: {
          code: 'return await openclaw.tools.call("openclaw:core:exec", { command: "echo hi" });',
        },
      },
      { ts: 1_234 },
    );

    const payload = requireMockArg(nodeSendToSession, 0, 2, "node tool-search payload") as {
      stream?: string;
      data?: { name?: string; args?: Record<string, unknown> };
    };
    expect(payload.stream).toBe("tool");
    expect(payload.data).toEqual({
      phase: "start",
      name: "exec",
      toolCallId: "tool-search-node-1",
      bridgeToolName: "tool_search_code",
      bridgeTargetToolName: "openclaw:core:exec",
      bridgeVerb: "call",
      args: { command: "echo hi" },
    });
    expect(
      formatChannelProgressDraftLine({
        event: "tool",
        name: payload.data?.name,
        args: payload.data?.args,
      }),
    ).toBe(
      formatChannelProgressDraftLine({
        event: "tool",
        name: "exec",
        args: { command: "echo hi" },
      }),
    );
  });

  it("hydrates node session tool events with session ownership metadata", () => {
    const { nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    vi.mocked(loadGatewaySessionRow).mockReturnValue(OWNED_SESSION_ROW);

    registerAgentRunContext("run-tool-node", { sessionKey: "session-1", verboseLevel: "on" });

    emitAgentEvent(
      handler,
      "run-tool-node",
      "tool",
      {
        phase: "start",
        name: "exec",
        toolCallId: "tool-node-1",
        args: { command: "echo hi" },
      },
      { ts: 1_234 },
    );

    expect(requireMockArg(nodeSendToSession, 0, 0, "node tool session")).toBe("session-1");
    expect(requireMockArg(nodeSendToSession, 0, 1, "node tool event")).toBe("agent");
    const nodeToolPayload = requireMockPayload(nodeSendToSession, 0, 2, "node tool payload");
    expectRecordFields(nodeToolPayload, {
      runId: "run-tool-node",
      sessionKey: "session-1",
      ...SESSION_OWNERSHIP,
      stream: "tool",
      ts: 1_234,
    });
    expectRecordFields(requireRecord(nodeToolPayload.data, "node tool payload data"), {
      phase: "start",
      name: "exec",
      toolCallId: "tool-node-1",
      args: { command: "echo hi" },
    });
  });

  it("broadcasts terminal session status to session subscribers on lifecycle end", async () => {
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-finished",
      kind: "direct",
      updatedAt: 1_700,
      status: "done",
      startedAt: 900,
      endedAt: 1_700,
      runtimeMs: 800,
      abortedLastRun: false,
    });
    const resolveSessionActiveRunState = vi
      .fn<NonNullable<AgentEventHandlerOptions["resolveSessionActiveRunState"]>>()
      .mockReturnValueOnce({ active: true, runIds: ["run-finished"] })
      .mockReturnValue({ active: false, runIds: [] });
    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-finished",
      resolveSessionActiveRunState,
    });

    sessionEventSubscribers.subscribe("conn-session");
    registerAgentRunContext("run-finished", {
      sessionKey: "session-finished",
      verboseLevel: "off",
    });

    emitAgentEvent(
      handler,
      "run-finished",
      "lifecycle",
      {
        phase: "start",
        startedAt: 900,
      },
      { ts: 1_000 },
    );
    emitAgentEvent(
      handler,
      "run-finished",
      "lifecycle",
      {
        phase: "end",
        startedAt: 900,
        endedAt: 1_700,
      },
      { seq: 2, ts: 1_800 },
    );

    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(2);
    });
    const sessionsChangedCalls = broadcastToConnIds.mock.calls.filter(
      ([event]) => event === "sessions.changed",
    );
    expect(sessionsChangedCalls).toHaveLength(2);
    expectPayloadFields(sessionsChangedCalls[0]?.[1], {
      sessionKey: "session-finished",
      phase: "start",
      hasActiveRun: true,
      activeRunIds: ["run-finished"],
    });
    expectPayloadFields(sessionsChangedCalls[1]?.[1], {
      sessionKey: "session-finished",
      phase: "end",
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
      startedAt: 900,
      endedAt: 1_700,
      runtimeMs: 800,
      updatedAt: 1_700,
      abortedLastRun: false,
    });
    expect(resolveSessionActiveRunState).toHaveBeenCalledWith({
      requestedKey: "session-finished",
      canonicalKey: "session-finished",
    });
    const persistParams = requireRecord(
      persistGatewaySessionLifecycleEventMock.mock.calls
        .map((call) => call[0])
        .find((params) => {
          const event = (params as { event?: { data?: { phase?: string } } } | undefined)?.event;
          return event?.data?.phase === "end";
        }),
      "persist lifecycle params",
    );
    expect(persistParams.sessionKey).toBe("session-finished");
    const persistEvent = requireRecord(persistParams.event, "persist lifecycle event");
    expect(persistEvent.runId).toBe("run-finished");
    expect(requireRecord(persistEvent.data, "persist lifecycle event data").phase).toBe("end");
  });

  it("does not project stale pre-reset lifecycle events into session subscriber snapshots", async () => {
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-reset",
      kind: "direct",
      sessionId: "new-session",
      updatedAt: 2_000,
      status: "done",
      startedAt: 1_000,
      endedAt: 1_500,
      runtimeMs: 500,
      abortedLastRun: false,
    });
    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      lifecycleErrorRetryGraceMs: 0,
    });
    sessionEventSubscribers.subscribe("conn-session");

    emitAgentEvent(
      handler,
      "old-run",
      "lifecycle",
      {
        phase: "start",
        startedAt: 2_100,
      },
      { sessionKey: "session-reset", sessionId: "old-session", ts: 2_100 },
    );
    emitAgentEvent(
      handler,
      "old-run",
      "lifecycle",
      {
        phase: "error",
        endedAt: 2_200,
        error: "old run failed",
      },
      { seq: 2, sessionKey: "session-reset", sessionId: "old-session", ts: 2_200 },
    );

    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(2);
    });
    const sessionsChangedCalls = broadcastToConnIds.mock.calls.filter(
      ([event]) => event === "sessions.changed",
    );
    expect(sessionsChangedCalls).toHaveLength(2);
    for (const [, payload] of sessionsChangedCalls) {
      expectPayloadFields(payload, {
        sessionKey: "session-reset",
        sessionId: "new-session",
        status: "done",
        startedAt: 1_000,
        endedAt: 1_500,
        runtimeMs: 500,
        updatedAt: 2_000,
        abortedLastRun: false,
      });
      expectRecordFields(requireRecord(requireRecord(payload, "payload").session, "session"), {
        sessionId: "new-session",
        status: "done",
        startedAt: 1_000,
        endedAt: 1_500,
        runtimeMs: 500,
      });
    }
  });

  it("suppresses late interrupted pre-restart lifecycle events from live projections", () => {
    mockSessionEntry(
      {
        sessionId: "session-recovery",
        updatedAt: 2_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "interrupted-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      "session-recovery",
    );
    const {
      broadcast,
      broadcastToConnIds,
      chatRunState,
      clearAgentRunContext,
      clearTrackedActiveRun,
      handler,
      sessionEventSubscribers,
    } = createHarness({
      resolveSessionKeyForRun: () => "session-recovery",
      lifecycleErrorRetryGraceMs: 0,
    });
    sessionEventSubscribers.subscribe("conn-session");
    registerChatRun(chatRunState, "interrupted-run", "session-recovery", "interrupted-run");

    emitAgentEvent(
      handler,
      "interrupted-run",
      "lifecycle",
      {
        phase: "end",
        aborted: true,
        stopReason: "restart",
        endedAt: 2_100,
      },
      {
        seq: 2,
        lifecycleGeneration: "pre-restart",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_100,
      },
    );

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(
      broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
    ).toHaveLength(0);
    expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
    expect(chatRunState.registry.peek("interrupted-run")).toBeUndefined();
    expect(clearAgentRunContext).toHaveBeenCalledWith("interrupted-run");
    expect(clearTrackedActiveRun).toHaveBeenCalledWith({
      runId: "interrupted-run",
      clientRunId: "interrupted-run",
      sessionKey: "session-recovery",
    });
  });

  it("projects successful completion when a restart marker was persisted before abort", async () => {
    mockSessionEntry(
      {
        sessionId: "session-recovery",
        updatedAt: 2_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "completed-during-marker-write",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      "session-recovery",
    );
    const markTrackedRunTerminalPersisted = vi.fn();
    const trackTrackedRunTerminalPersistence = vi.fn();
    const {
      broadcast,
      broadcastToConnIds,
      chatRunState,
      clearAgentRunContext,
      clearTrackedActiveRun,
      handler,
      sessionEventSubscribers,
    } = createHarness({
      resolveSessionKeyForRun: () => "session-recovery",
      lifecycleErrorRetryGraceMs: 0,
      markTrackedRunTerminalPersisted,
      trackTrackedRunTerminalPersistence,
    });
    sessionEventSubscribers.subscribe("conn-session");
    registerChatRun(
      chatRunState,
      "completed-during-marker-write",
      "session-recovery",
      "completed-during-marker-write",
    );

    emitAgentEvent(
      handler,
      "completed-during-marker-write",
      "lifecycle",
      {
        phase: "end",
        endedAt: 2_100,
      },
      {
        seq: 2,
        lifecycleGeneration: "pre-restart",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_100,
      },
    );

    expect(chatBroadcastCalls(broadcast)).toHaveLength(1);
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledTimes(1);
    expect(trackTrackedRunTerminalPersistence).toHaveBeenCalledWith({
      runId: "completed-during-marker-write",
      clientRunId: "completed-during-marker-write",
      sessionKey: "session-recovery",
      sessionId: "session-recovery",
      observedAt: 2_100,
      persistence: expect.any(Promise),
    });
    await waitForFast(() => {
      expect(markTrackedRunTerminalPersisted).toHaveBeenCalledWith({
        runId: "completed-during-marker-write",
        clientRunId: "completed-during-marker-write",
        sessionKey: "session-recovery",
      });
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(1);
    });
    expect(chatRunState.registry.peek("completed-during-marker-write")).toBeUndefined();
    expect(clearAgentRunContext).toHaveBeenCalledWith("completed-during-marker-write");
    expect(clearTrackedActiveRun).toHaveBeenCalledWith({
      runId: "completed-during-marker-write",
      clientRunId: "completed-during-marker-write",
      sessionKey: "session-recovery",
    });
  });

  it("keeps live session status running while another recovery run remains", async () => {
    const restartRecoveryRuns = [
      {
        runId: "completed-run",
        lifecycleGeneration: "pre-restart",
      },
      {
        runId: "interrupted-run",
        lifecycleGeneration: "pre-restart",
      },
    ];
    mockSessionEntry(
      {
        sessionId: "session-recovery",
        updatedAt: 2_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns,
      },
      "session-recovery",
    );
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-recovery",
      kind: "direct",
      sessionId: "session-recovery",
      updatedAt: 2_000,
      status: "running",
      abortedLastRun: true,
    });
    const { broadcastToConnIds, handler, sessionEventSubscribers } = createHarness({
      resolveSessionKeyForRun: () => "session-recovery",
      lifecycleErrorRetryGraceMs: 0,
    });
    sessionEventSubscribers.subscribe("conn-session");

    emitAgentEvent(
      handler,
      "completed-run",
      "lifecycle",
      {
        phase: "end",
        endedAt: 2_100,
      },
      {
        seq: 2,
        lifecycleGeneration: "pre-restart",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_100,
      },
    );

    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(1);
    });
    const payload = requireRecord(
      requireMockArg(broadcastToConnIds, 0, 1, "sessions changed payload"),
      "sessions changed payload",
    );
    expectPayloadFields(payload, {
      status: "running",
      abortedLastRun: true,
      endedAt: undefined,
      runtimeMs: undefined,
    });
  });

  it("broadcasts canonical state after concurrent recovery completions persist", async () => {
    const restartRecoveryRuns = [
      {
        runId: "run-a",
        lifecycleGeneration: "pre-restart-a",
      },
      {
        runId: "run-b",
        lifecycleGeneration: "pre-restart-b",
      },
    ];
    mockSessionEntry(
      {
        sessionId: "session-recovery",
        updatedAt: 2_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns,
      },
      "session-recovery",
    );
    let currentRow = {
      key: "session-recovery",
      kind: "direct" as const,
      sessionId: "session-recovery",
      updatedAt: 2_000,
      status: "running" as "done" | "running",
      abortedLastRun: true,
    };
    vi.mocked(loadGatewaySessionRow).mockImplementation(() => currentRow);
    let resolveRunA: (() => void) | undefined;
    let resolveRunB: (() => void) | undefined;
    persistGatewaySessionLifecycleEventMock.mockImplementation(
      ({ event }: { event: { runId: string } }) =>
        new Promise<void>((resolve) => {
          if (event.runId === "run-a") {
            resolveRunA = resolve;
          } else {
            resolveRunB = resolve;
          }
        }),
    );
    const { broadcastToConnIds, handler, sessionEventSubscribers } = createHarness({
      resolveSessionKeyForRun: () => "session-recovery",
      lifecycleErrorRetryGraceMs: 0,
    });
    sessionEventSubscribers.subscribe("conn-session");

    for (const [runId, lifecycleGeneration, seq] of [
      ["run-a", "pre-restart-a", 1],
      ["run-b", "pre-restart-b", 2],
    ] as const) {
      handler({
        runId,
        lifecycleGeneration,
        seq,
        stream: "lifecycle",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_100 + seq,
        data: {
          phase: "end",
          endedAt: 2_100 + seq,
        },
      });
    }

    currentRow = { ...currentRow, updatedAt: 2_101 };
    resolveRunA?.();
    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(1);
    });
    expectPayloadFields(requireMockArg(broadcastToConnIds, 0, 1, "run-a session snapshot"), {
      status: "running",
      abortedLastRun: true,
    });

    currentRow = {
      ...currentRow,
      updatedAt: 2_102,
      status: "done",
      abortedLastRun: false,
    };
    resolveRunB?.();
    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(2);
    });
    expectPayloadFields(requireMockArg(broadcastToConnIds, 1, 1, "run-b session snapshot"), {
      status: "done",
      abortedLastRun: false,
    });
  });

  it("reloads canonical state when a restart marker races terminal persistence", async () => {
    mockSessionEntry(
      {
        sessionId: "session-recovery",
        updatedAt: 2_000,
        status: "running",
      },
      "session-recovery",
    );
    let currentRow = {
      key: "session-recovery",
      kind: "direct" as const,
      sessionId: "session-recovery",
      updatedAt: 2_000,
      status: "done" as "done" | "running",
      abortedLastRun: false,
    };
    vi.mocked(loadGatewaySessionRow).mockImplementation(() => currentRow);
    let resolvePersistence: (() => void) | undefined;
    persistGatewaySessionLifecycleEventMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePersistence = resolve;
        }),
    );
    const { broadcastToConnIds, handler, sessionEventSubscribers } = createHarness({
      resolveSessionKeyForRun: () => "session-recovery",
      lifecycleErrorRetryGraceMs: 0,
    });
    sessionEventSubscribers.subscribe("conn-session");

    emitAgentEvent(
      handler,
      "completed-run",
      "lifecycle",
      {
        phase: "end",
        endedAt: 2_100,
      },
      {
        seq: 2,
        lifecycleGeneration: "pre-restart",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_100,
      },
    );

    expect(
      broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
    ).toHaveLength(0);
    currentRow = {
      ...currentRow,
      updatedAt: 2_100,
      status: "running",
      abortedLastRun: true,
    };
    resolvePersistence?.();

    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(1);
    });
    expectPayloadFields(requireMockArg(broadcastToConnIds, 0, 1, "canonical session snapshot"), {
      status: "running",
      abortedLastRun: true,
    });
  });

  it("broadcasts a terminal fallback snapshot when persistence fails", async () => {
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-failed-write",
      kind: "direct",
      sessionId: "session-failed-write",
      updatedAt: 2_000,
      status: "running",
      startedAt: 1_000,
      abortedLastRun: false,
    });
    persistGatewaySessionLifecycleEventMock.mockRejectedValueOnce(
      new Error("disk full sk-abcdefghijklmnopqrstuvwxyz123456"),
    );
    const markTrackedRunTerminalPersisted = vi.fn();
    const { broadcastToConnIds, handler, sessionEventSubscribers } = createHarness({
      resolveSessionKeyForRun: () => "session-failed-write",
      lifecycleErrorRetryGraceMs: 0,
      markTrackedRunTerminalPersisted,
    });
    sessionEventSubscribers.subscribe("conn-session");

    emitAgentEvent(
      handler,
      "run-failed-write",
      "lifecycle",
      {
        phase: "end",
        endedAt: 2_100,
      },
      { seq: 2, sessionKey: "session-failed-write", sessionId: "session-failed-write", ts: 2_100 },
    );

    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(1);
    });
    expectPayloadFields(requireMockArg(broadcastToConnIds, 0, 1, "fallback session snapshot"), {
      status: "done",
      updatedAt: 2_100,
      abortedLastRun: false,
    });
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      "gateway: terminal session persistence failed session=session-failed-write run=run-failed-write error=Error: disk full sk-abc…3456",
    );
    expect(markTrackedRunTerminalPersisted).not.toHaveBeenCalled();
  });

  it("does not clear a same-id retry when an old restart terminal arrives", () => {
    mockSessionEntry(
      {
        sessionId: "session-recovery",
        updatedAt: 2_000,
        status: "running",
        restartRecoveryRuns: [
          {
            runId: "shared-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      "session-recovery",
    );
    registerAgentRunContext("shared-run", {
      sessionKey: "session-recovery",
      sessionId: "session-recovery",
      lifecycleGeneration: "pre-restart",
    });
    const { agentRunSeq, chatRunState, clearAgentRunContext, clearTrackedActiveRun, handler } =
      createHarness({
        resolveSessionKeyForRun: () => "session-recovery",
        lifecycleErrorRetryGraceMs: 0,
        resolveActiveLifecycleGenerationForRun: () => "post-restart",
      });
    agentRunSeq.set("shared-run", 4);
    registerChatRun(chatRunState, "shared-run", "session-recovery", "shared-run");
    chatRunState.getOrCreate("shared-run").buffer = "new retry output";

    emitAgentEvent(
      handler,
      "shared-run",
      "lifecycle",
      {
        phase: "end",
        endedAt: 2_100,
      },
      {
        seq: 3,
        lifecycleGeneration: "pre-restart",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_100,
      },
    );

    expect(chatRunState.registry.peek("shared-run")).toBeDefined();
    expect(chatRunState.runs.get("shared-run")?.buffer).toBe("new retry output");
    expect(agentRunSeq.get("shared-run")).toBe(4);
    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(clearTrackedActiveRun).not.toHaveBeenCalled();
    expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
  });

  it("cancels a deferred old-generation error before a same-id retry", () => {
    vi.useFakeTimers();
    let activeLifecycleGeneration = "pre-restart";
    registerAgentRunContext("shared-run", {
      sessionKey: "session-recovery",
      sessionId: "session-recovery",
      lifecycleGeneration: activeLifecycleGeneration,
    });
    const { chatRunState, clearAgentRunContext, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-recovery",
      lifecycleErrorRetryGraceMs: 100,
      resolveActiveLifecycleGenerationForRun: () => activeLifecycleGeneration,
    });
    registerChatRun(chatRunState, "shared-run", "session-recovery", "shared-run");

    emitAgentEvent(
      handler,
      "shared-run",
      "lifecycle",
      {
        phase: "error",
        error: "retryable provider failure",
        endedAt: 2_000,
      },
      {
        lifecycleGeneration: "pre-restart",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_000,
      },
    );
    expect(vi.getTimerCount()).toBe(1);

    mockSessionEntry(
      {
        sessionId: "session-recovery",
        updatedAt: 2_000,
        status: "running",
        restartRecoveryRuns: [
          {
            runId: "shared-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      "session-recovery",
    );
    activeLifecycleGeneration = "post-restart";
    registerAgentRunContext("shared-run", {
      sessionKey: "session-recovery",
      sessionId: "session-recovery",
      lifecycleGeneration: activeLifecycleGeneration,
    });

    emitAgentEvent(
      handler,
      "shared-run",
      "lifecycle",
      {
        phase: "end",
        endedAt: 2_100,
      },
      {
        seq: 2,
        lifecycleGeneration: "pre-restart",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_100,
      },
    );

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(chatRunState.registry.peek("shared-run")).toBeDefined();
    expect(clearAgentRunContext).not.toHaveBeenCalled();
  });

  it("cancels deferred lifecycle errors when the handler is disposed", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-dispose",
      lifecycleErrorRetryGraceMs: 100,
    });

    emitAgentEvent(
      handler,
      "run-dispose",
      "lifecycle",
      { phase: "error", error: "retryable provider failure" },
      { sessionKey: "session-dispose", ts: 2_000 },
    );
    expect(vi.getTimerCount()).toBe(1);

    handler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);

    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);
  });

  it("clears tracked active runs before terminal sessions.changed broadcasts", async () => {
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-finished",
      kind: "direct",
      updatedAt: 1_650,
      status: "running",
      startedAt: 900,
    });
    const {
      broadcastToConnIds,
      clearTrackedActiveRun,
      chatRunState,
      sessionEventSubscribers,
      handler,
    } = createHarness();
    sessionEventSubscribers.subscribe("conn-session");
    registerChatRun(chatRunState, "provider-run", "session-finished", "client-run");

    emitAgentEvent(
      handler,
      "provider-run",
      "lifecycle",
      {
        phase: "end",
        startedAt: 900,
        endedAt: 1_700,
      },
      { seq: 2, ts: 1_800 },
    );

    expect(clearTrackedActiveRun).toHaveBeenCalledWith({
      runId: "provider-run",
      clientRunId: "client-run",
      sessionKey: "session-finished",
    });
    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(1);
    });
    expect(requireMockArg(broadcastToConnIds, 0, 0, "sessions changed event")).toBe(
      "sessions.changed",
    );
    expect(clearTrackedActiveRun.mock.invocationCallOrder[0]).toBeLessThan(
      broadcastToConnIds.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("keeps chat send retry guards while hiding terminal session projection across session aliases", () => {
    const trackedActiveRuns = new Map<
      string,
      { sessionKey: string; projectSessionActive?: boolean }
    >([
      ["provider-run", { sessionKey: "session-finished" }],
      ["client-run", { sessionKey: "requested-session" }],
    ]);
    const { chatRunState, handler } = createHarness({
      clearTrackedActiveRun: ({ runId, clientRunId }) => {
        for (const candidateRunId of new Set([runId, clientRunId])) {
          const entry = trackedActiveRuns.get(candidateRunId);
          if (entry) {
            entry.projectSessionActive = false;
          }
        }
      },
    });
    registerChatRun(chatRunState, "provider-run", "session-finished", "client-run");

    emitAgentEvent(
      handler,
      "provider-run",
      "lifecycle",
      {
        phase: "end",
        startedAt: 900,
        endedAt: 1_700,
      },
      { seq: 2, ts: 1_800 },
    );

    const providerGuard = trackedActiveRuns.get("provider-run");
    const retryGuard = trackedActiveRuns.get("client-run");
    expect(providerGuard?.projectSessionActive).toBe(false);
    expect(retryGuard).toBeDefined();
    expect(retryGuard?.sessionKey).toBe("requested-session");
    expect(retryGuard?.projectSessionActive).toBe(false);
  });

  it("keeps aborted chat run markers through terminal lifecycle cleanup", () => {
    const { broadcast, chatRunState, handler } = createHarness();
    registerNamedChatRun(chatRunState, "aborted");
    chatRunState.getOrCreate("client-aborted").abortMarker = createChatAbortMarker();

    emitAgentEvent(
      handler,
      "run-aborted",
      "lifecycle",
      { phase: "end", aborted: true, stopReason: "rpc" },
      { seq: 2, ts: 1_500 },
    );

    expect(chatRunState.runs.get("client-aborted")?.abortMarker).toBeDefined();
    expect(chatRunState.registry.peek("run-aborted")).toBeUndefined();
    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
  });

  it("projects lifecycle self-aborts with their validation diagnostic", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerChatRun(
      chatRunState,
      "provider-validation-loop",
      "session-validation-loop",
      "client-validation-loop",
    );

    emitAgentEvent(
      handler,
      "provider-validation-loop",
      "lifecycle",
      {
        phase: "end",
        aborted: true,
        toolErrorSummary: "edit tool validation failed: edits: must be an array",
      },
      { seq: 2, ts: 1_500 },
    );

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    expect(expectDefined(chatCalls[0], "chatCalls[0] test invariant")[1]).toMatchObject({
      runId: "client-validation-loop",
      sessionKey: "session-validation-loop",
      seq: 2,
      state: "aborted",
      stopReason: "aborted",
      errorMessage: "edit tool validation failed: edits: must be an array",
    });
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    expect(chatRunState.registry.peek("provider-validation-loop")).toBeUndefined();
  });

  it.each([
    { stopReason: "rpc", expectedState: "aborted" },
    { stopReason: "timeout", expectedState: "error" },
  ])("preserves $stopReason lifecycle abort classification", ({ stopReason, expectedState }) => {
    const { broadcast, chatRunState, handler } = createHarness();
    registerChatRun(
      chatRunState,
      `provider-${stopReason}`,
      `session-${stopReason}`,
      `client-${stopReason}`,
    );

    emitAgentEvent(
      handler,
      `provider-${stopReason}`,
      "lifecycle",
      { phase: "end", aborted: true, stopReason },
      { seq: 2, ts: 1_500 },
    );

    expect(
      expectDefined(
        chatBroadcastCalls(broadcast)[0],
        "chatBroadcastCalls(broadcast)[0] test invariant",
      )[1],
    ).toMatchObject({
      runId: `client-${stopReason}`,
      state: expectedState,
      stopReason,
    });
  });

  it("does not forward unsafe lifecycle abort diagnostics", () => {
    const { broadcast, chatRunState, handler } = createHarness();
    registerChatRun(
      chatRunState,
      "provider-unsafe-abort",
      "session-unsafe-abort",
      "client-unsafe-abort",
    );

    emitAgentEvent(
      handler,
      "provider-unsafe-abort",
      "lifecycle",
      {
        phase: "end",
        aborted: true,
        stopReason: "aborted",
        toolErrorSummary: "browser failed\nsecret output",
      },
      { seq: 2, ts: 1_500 },
    );

    const payload = expectDefined(
      chatBroadcastCalls(broadcast)[0],
      "chatBroadcastCalls(broadcast)[0] test invariant",
    )[1] as Record<string, unknown>;
    expect(payload.state).toBe("aborted");
    expect(payload).not.toHaveProperty("errorMessage");
  });

  it("preserves timeout terminal precedence for abort-marked lifecycle events", () => {
    const { broadcast, chatRunState, handler } = createHarness();
    registerChatRun(chatRunState, "provider-timeout", "session-timeout", "client-timeout");

    emitAgentEvent(
      handler,
      "provider-timeout",
      "lifecycle",
      {
        phase: "end",
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "agent provider timeout",
      },
      { seq: 2, ts: 1_500 },
    );

    const payload = expectDefined(
      chatBroadcastCalls(broadcast)[0],
      "chatBroadcastCalls(broadcast)[0] test invariant",
    )[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      runId: "client-timeout",
      state: "error",
      stopReason: "timeout",
      errorMessage: "agent provider timeout",
    });
    expect(payload).not.toHaveProperty("message");
  });

  it.each([
    {
      name: "older timestamp",
      marker: () => 1_000,
    },
    {
      name: "same-millisecond older sequence",
      marker: () => ({ abortedAtMs: 2_000, sequence: -1 }),
    },
  ])(
    "ignores stale aborted markers from older same-key runs for fresh chat lifecycle events ($name)",
    ({ marker }) => {
      const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({ now: 2_000 });
      chatRunState.getOrCreate("client-stale-abort").abortMarker = marker();
      registerNamedChatRun(chatRunState, "stale-abort");

      emitAgentEvent(
        handler,
        "run-stale-abort",
        "assistant",
        { text: "Fresh output", delta: "Fresh output" },
        { ts: 2_100 },
      );
      emitAgentEvent(
        handler,
        "run-stale-abort",
        "lifecycle",
        { phase: "end" },
        { seq: 2, ts: 2_200 },
      );

      const chatCalls = chatBroadcastCalls(broadcast);
      expect(chatCalls).toHaveLength(2);
      const deltaPayload = expectDefined(chatCalls[0], "chatCalls[0] test invariant")[1];
      const finalPayload = expectDefined(chatCalls[1], "chatCalls[1] test invariant")[1];
      expect(deltaPayload.state).toBe("delta");
      expect(finalPayload.state).toBe("final");
      expect(sessionChatCalls(nodeSendToSession)).toHaveLength(2);
      expect(chatRunState.runs.get("client-stale-abort")?.abortMarker).toBeDefined();
      expect(chatRunState.registry.peek("run-stale-abort")).toBeUndefined();
    },
  );

  it("honors same-millisecond abort markers from the current same-key run", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({ now: 3_000 });
    registerNamedChatRun(chatRunState, "current-abort");
    chatRunState.getOrCreate("client-current-abort").abortMarker = createChatAbortMarker();

    emitAgentEvent(
      handler,
      "run-current-abort",
      "assistant",
      { text: "Suppressed output", delta: "Suppressed output" },
      { ts: 3_100 },
    );
    emitAgentEvent(
      handler,
      "run-current-abort",
      "lifecycle",
      { phase: "end", aborted: true, stopReason: "rpc" },
      { seq: 2, ts: 3_200 },
    );

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);
    expect(chatRunState.runs.get("client-current-abort")?.abortMarker).toBeDefined();
    expect(chatRunState.registry.peek("run-current-abort")).toBeUndefined();
  });

  it("keeps live session setting metadata at the top level for lifecycle updates", async () => {
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-finished",
      kind: "direct",
      updatedAt: 1_650,
      ...SESSION_OWNERSHIP,
      sendPolicy: "deny",
      responseUsage: "full",
      totalTokens: 42,
      totalTokensFresh: true,
      contextTokens: 21,
      estimatedCostUsd: 0.12,
      lastThreadId: 42,
      status: "running",
      startedAt: 900,
      runtimeMs: 750,
      abortedLastRun: false,
    });

    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-finished",
    });

    sessionEventSubscribers.subscribe("conn-session");
    registerAgentRunContext("run-finished", {
      sessionKey: "session-finished",
      verboseLevel: "off",
    });

    emitAgentEvent(
      handler,
      "run-finished",
      "lifecycle",
      {
        phase: "end",
        startedAt: 900,
        endedAt: 1_700,
      },
      { seq: 2, ts: 1_800 },
    );

    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(1);
    });
    expect(requireMockArg(broadcastToConnIds, 0, 0, "sessions changed event")).toBe(
      "sessions.changed",
    );
    expectPayloadFields(requireMockArg(broadcastToConnIds, 0, 1, "sessions changed payload"), {
      sessionKey: "session-finished",
      phase: "end",
      ...SESSION_OWNERSHIP,
      sendPolicy: "deny",
      responseUsage: "full",
      totalTokens: 42,
      totalTokensFresh: true,
      contextTokens: 21,
      estimatedCostUsd: 0.12,
      lastThreadId: 42,
    });
    expect(requireMockArg(broadcastToConnIds, 0, 2, "sessions changed recipients")).toEqual(
      new Set(["conn-session"]),
    );
    expect(requireMockArg(broadcastToConnIds, 0, 3, "sessions changed options")).toEqual({
      dropIfSlow: true,
    });
  });

  it("omits goal state from unscoped global lifecycle snapshots", async () => {
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "global",
      kind: "global",
      updatedAt: 1_650,
      status: "running",
      goal: {
        schemaVersion: 1,
        id: "goal-default",
        objective: "Wrong agent goal",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
        tokenStart: 0,
        tokensUsed: 42,
        continuationTurns: 0,
      },
    });

    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "global",
    });

    sessionEventSubscribers.subscribe("conn-session");

    emitAgentEvent(
      handler,
      "run-global",
      "lifecycle",
      { phase: "end", endedAt: 1_700 },
      { seq: 2, ts: 1_800 },
    );

    await waitForFast(() => {
      expect(
        broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed"),
      ).toHaveLength(1);
    });
    const payload = requireRecord(
      requireMockArg(broadcastToConnIds, 0, 1, "sessions changed payload"),
      "sessions changed payload",
    );
    expect(payload).not.toHaveProperty("goal");
    expect(requireRecord(payload.session, "nested session")).not.toHaveProperty("goal");
  });

  it.each([
    {
      name: "keeps tool output for Control UI recipients when verbose is on",
      runId: "run-tool-on",
      toolCallId: "t3",
      verboseLevel: "on",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    },
    {
      name: "keeps tool output when verbose is full",
      runId: "run-tool-full",
      toolCallId: "t4",
      verboseLevel: "full",
      partialResult: undefined,
    },
  ] as const)("$name", ({ runId, toolCallId, verboseLevel, partialResult }) => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });
    const result = { content: [{ type: "text", text: "secret" }] };
    registerAgentRunContext(runId, { sessionKey: "session-1", verboseLevel });
    toolEventRecipients.add(runId, "conn-1");
    emitAgentEvent(handler, runId, "tool", {
      phase: "result",
      name: "exec",
      toolCallId,
      result,
      ...(partialResult ? { partialResult } : {}),
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = requireMockArg(broadcastToConnIds, 0, 1, "tool output payload") as {
      data?: Record<string, unknown>;
    };
    expect(payload.data?.result).toEqual(result);
    expect(payload.data?.partialResult).toEqual(partialResult);
  });

  it("broadcasts fallback events to agent subscribers and node session", () => {
    const { broadcast, broadcastToConnIds, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });

    emitFallbackLifecycle({ handler, runId: "run-fallback" });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");
    expect(payload.sessionKey).toBe("session-fallback");
    expect(payload.data?.activeProvider).toBe("deepinfra");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
  });

  it("remaps chat-linked lifecycle runId to client runId", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });
    registerChatRun(
      chatRunState,
      "run-fallback-internal",
      "session-fallback",
      "run-fallback-client",
    );

    emitFallbackLifecycle({ handler, runId: "run-fallback-internal" });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.runId).toBe("run-fallback-client");
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
    const nodePayload = nodeCalls[0]?.[2] as { runId?: string };
    expect(nodePayload.runId).toBe("run-fallback-client");
  });

  it("keeps selected-agent global chat events scoped to the linked agent", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    registerChatRun(chatRunState, "run-global-main", "global", "client-global-main", {
      agentId: "main",
    });

    emitAgentEvent(handler, "run-global-main", "assistant", { text: "main global reply" });

    const chatPayload = chatBroadcastCalls(broadcast)[0]?.[1] as {
      agentId?: string;
      sessionKey?: string;
    };
    expect(chatPayload).toEqual(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "global",
      }),
    );
    const nodeCalls = sessionChatCalls(nodeSendToSession);
    expect(nodeCalls[0]?.[0]).toBe("agent:main:global");
    expect(nodeCalls.map(([sessionKey]) => sessionKey)).toContain("global");
  });

  it("persists selected-agent global lifecycle state with the linked agent", () => {
    const { broadcastToConnIds, chatRunState, handler, sessionEventSubscribers } = createHarness();
    sessionEventSubscribers.subscribe("conn-1");
    registerChatRun(chatRunState, "run-global-work", "global", "client-global-work", {
      agentId: "work",
    });

    emitAgentEvent(handler, "run-global-work", "lifecycle", { phase: "start" });

    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
      }),
    );
    expect(loadGatewaySessionRow).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  it("logs when start session persistence fails", async () => {
    const { chatRunState, handler, sessionEventSubscribers } = createHarness();
    sessionEventSubscribers.subscribe("conn-1");
    registerChatRun(chatRunState, "run-global-work", "global", "client-global-work", {
      agentId: "work",
    });
    persistGatewaySessionLifecycleEventMock.mockRejectedValueOnce(new Error("start disk full"));

    emitAgentEvent(handler, "run-global-work", "lifecycle", { phase: "start" });

    await waitForFast(() => {
      expect(logErrorMock).toHaveBeenCalledTimes(1);
    });
    expect(logErrorMock).toHaveBeenCalledWith(
      "gateway: start session persistence failed session=global run=run-global-work error=Error: start disk full",
    );
  });

  it("routes hidden selected-agent global chat events only to matching subscribers", () => {
    const { broadcastToConnIds, chatRunState, handler, sessionMessageSubscribers } =
      createHarness();
    sessionMessageSubscribers.subscribe("conn-main", "agent:main:global");
    sessionMessageSubscribers.subscribe("conn-work", "agent:work:global");
    registerChatRun(chatRunState, "run-hidden-main", "global", "client-hidden-main", {
      agentId: "main",
    });
    registerAgentRunContext("run-hidden-main", {
      sessionKey: "global",
      isControlUiVisible: false,
    });

    emitAgentEvent(handler, "run-hidden-main", "assistant", { text: "hidden main global reply" });

    const chatCall = broadcastToConnIds.mock.calls.find(([event]) => event === "chat");
    expect(chatCall?.[2]).toEqual(new Set(["conn-main"]));
    expect(chatCall?.[1]).toEqual(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "global",
      }),
    );
  });

  it("routes hidden bare global chat events to the configured default agent subscriber", () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "ops", default: true }] },
    });
    const { broadcastToConnIds, chatRunState, handler, sessionMessageSubscribers } =
      createHarness();
    sessionMessageSubscribers.subscribe("conn-main", "agent:main:global");
    sessionMessageSubscribers.subscribe("conn-ops", "agent:ops:global");
    registerChatRun(chatRunState, "run-hidden-default", "global", "client-hidden-default");
    registerAgentRunContext("run-hidden-default", {
      sessionKey: "global",
      isControlUiVisible: false,
    });

    emitAgentEvent(handler, "run-hidden-default", "assistant", {
      text: "hidden default global reply",
    });

    const chatCall = broadcastToConnIds.mock.calls.find(([event]) => event === "chat");
    expect(chatCall?.[2]).toEqual(new Set(["conn-ops"]));
    expect(chatCall?.[1]).toEqual(
      expect.objectContaining({
        sessionKey: "global",
      }),
    );
  });

  it("keeps chat-linked run remapping alive across per-attempt lifecycle errors", () => {
    vi.useFakeTimers();
    const { broadcast, chatRunState, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
      lifecycleErrorRetryGraceMs: 100,
    });
    registerChatRun(chatRunState, "run-fallback-retry", "session-fallback", "run-fallback-client");

    emitAgentEvents(handler, "run-fallback-retry", [
      ["assistant", { text: "draft" }],
      ["lifecycle", { phase: "error", error: "provider failed" }],
    ]);

    expect(chatRunState.registry.peek("run-fallback-retry")).toMatchObject({
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });
    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(agentRunSeq.get("run-fallback-retry")).toBe(2);

    emitFallbackLifecycle({
      handler,
      runId: "run-fallback-retry",
      seq: 3,
      sessionKey: "session-fallback",
    });
    const agentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    const fallbackPayload = agentCalls.at(-1)?.[1] as {
      runId?: string;
      data?: Record<string, unknown>;
    };
    expect(fallbackPayload.runId).toBe("run-fallback-client");
    expect(fallbackPayload.data?.phase).toBe("fallback");

    vi.advanceTimersByTime(100);

    expect(chatRunState.registry.peek("run-fallback-retry")).toMatchObject({
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });
    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);
    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(agentRunSeq.get("run-fallback-retry")).toBe(3);

    emitLifecycleEnd(handler, "run-fallback-retry", 4);

    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);
    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      runId?: string;
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.runId).toBe("run-fallback-client");
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-fallback-retry");
    expect(agentRunSeq.has("run-fallback-retry")).toBe(false);
  });

  it("defers terminal lifecycle-error cleanup for non-chat-send runs until the retry grace expires", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-terminal-error",
      lifecycleErrorRetryGraceMs: 100,
    });
    registerAgentRunContext("run-terminal-error", { sessionKey: "session-terminal-error" });

    emitAgentEvents(handler, "run-terminal-error", [
      ["assistant", { text: "partial" }],
      ["lifecycle", { phase: "error", error: "still broken" }],
    ]);

    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(agentRunSeq.get("run-terminal-error")).toBe(2);
    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);

    vi.advanceTimersByTime(100);

    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      runId?: string;
    };
    expect(finalPayload.state).toBe("error");
    expect(finalPayload.runId).toBe("run-terminal-error");
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-terminal-error");
    expect(agentRunSeq.has("run-terminal-error")).toBe(false);
  });

  it("finalizes fallback-exhausted lifecycle errors without waiting for retry grace", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-terminal-error",
      lifecycleErrorRetryGraceMs: 100,
    });
    registerAgentRunContext("run-terminal-final-failure", {
      sessionKey: "session-terminal-error",
    });

    emitAgentEvent(handler, "run-terminal-final-failure", "lifecycle", {
      phase: "error",
      error: "LLM request failed: network connection error.",
      fallbackExhaustedFailure: true,
    });

    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      runId?: string;
      errorMessage?: string;
    };
    expect(finalPayload.state).toBe("error");
    expect(finalPayload.runId).toBe("run-terminal-final-failure");
    expect(finalPayload.errorMessage).toContain("network connection error");
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-terminal-final-failure");
    expect(agentRunSeq.has("run-terminal-final-failure")).toBe(false);
    expect(
      persistGatewaySessionLifecycleEventMock.mock.calls.some(
        ([params]) =>
          (params as { event?: { data?: { fallbackExhaustedFailure?: boolean } } }).event?.data
            ?.fallbackExhaustedFailure === true,
      ),
    ).toBe(true);
  });

  it("keeps deferred lifecycle-error cleanup across later non-terminal events", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-terminal-error",
      lifecycleErrorRetryGraceMs: 100,
    });
    registerAgentRunContext("run-terminal-late-tool", {
      sessionKey: "session-terminal-error",
    });

    emitAgentEvents(handler, "run-terminal-late-tool", [
      ["lifecycle", { phase: "start" }],
      ["lifecycle", { phase: "error", error: "request timed out" }],
      ["tool", { phase: "result", name: "exec" }],
    ]);

    vi.advanceTimersByTime(99);

    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(agentRunSeq.get("run-terminal-late-tool")).toBe(3);
    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);

    vi.advanceTimersByTime(1);

    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      runId?: string;
      errorMessage?: string;
    };
    expect(finalPayload.state).toBe("error");
    expect(finalPayload.runId).toBe("run-terminal-late-tool");
    expect(finalPayload.errorMessage).toContain("request timed out");
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-terminal-late-tool");
    expect(agentRunSeq.has("run-terminal-late-tool")).toBe(false);
    expect(
      persistGatewaySessionLifecycleEventMock.mock.calls.some(
        ([params]) =>
          (params as { event?: { data?: { phase?: string } } }).event?.data?.phase === "error",
      ),
    ).toBe(true);
  });

  it("keeps deferred lifecycle-error cleanup across phase-less lifecycle events", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-terminal-error",
      lifecycleErrorRetryGraceMs: 100,
    });
    registerAgentRunContext("run-terminal-late-lifecycle", {
      sessionKey: "session-terminal-error",
    });

    emitAgentEvents(handler, "run-terminal-late-lifecycle", [
      ["lifecycle", { phase: "start" }],
      ["lifecycle", { phase: "error", error: "request timed out" }],
      ["lifecycle", { msg: "status update" }],
    ]);

    vi.advanceTimersByTime(100);

    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      runId?: string;
      errorMessage?: string;
    };
    expect(finalPayload.state).toBe("error");
    expect(finalPayload.runId).toBe("run-terminal-late-lifecycle");
    expect(finalPayload.errorMessage).toContain("request timed out");
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-terminal-late-lifecycle");
    expect(agentRunSeq.has("run-terminal-late-lifecycle")).toBe(false);
  });

  it("cancels deferred lifecycle-error cleanup when the run restarts", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-terminal-retry",
      lifecycleErrorRetryGraceMs: 100,
    });
    registerAgentRunContext("run-terminal-retry", {
      sessionKey: "session-terminal-retry",
    });

    emitAgentEvents(handler, "run-terminal-retry", [
      ["lifecycle", { phase: "start" }],
      ["lifecycle", { phase: "error", error: "attempt failed" }],
      ["lifecycle", { phase: "start" }],
    ]);

    vi.advanceTimersByTime(100);

    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);
    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(agentRunSeq.get("run-terminal-retry")).toBe(3);
    expect(
      persistGatewaySessionLifecycleEventMock.mock.calls.filter(
        ([params]) =>
          (params as { event?: { data?: { phase?: string } } }).event?.data?.phase === "error",
      ),
    ).toHaveLength(0);
  });

  it.each([
    {
      name: "groq tpm 413",
      error: new Error("Request too large: too many tokens per minute (TPM)"),
      expected: "rate_limit",
    },
    {
      name: "quota exceeded",
      error: new Error("quota exceeded"),
      expected: "rate_limit",
    },
    {
      name: "resource_exhausted",
      error: new Error("resource_exhausted"),
      expected: "rate_limit",
    },
    {
      name: "http 429",
      error: Object.assign(new Error("Too many requests"), { code: 429 }),
      expected: "rate_limit",
    },
    {
      name: "fetch failed",
      error: new Error("fetch failed"),
      expected: "timeout",
    },
    {
      name: "socket hang up",
      error: new Error("socket hang up"),
      expected: "timeout",
    },
    {
      name: "etimedout",
      error: Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
      expected: "timeout",
    },
    {
      name: "context overflow",
      error: new Error("context length exceeded"),
      expected: "context_length",
    },
    {
      name: "refusal_policy",
      error: new Error("Unhandled stop reason: refusal_policy"),
      expected: "refusal",
    },
    {
      name: "content_filter",
      error: new Error("content_filter blocked the response"),
      expected: "refusal",
    },
    {
      name: "plain error",
      error: new Error("plain provider failure"),
      expected: undefined,
    },
    {
      name: "http 500 is not a timeout",
      error: Object.assign(new Error("Internal server error"), { status: 500 }),
      expected: undefined,
    },
    {
      name: "rate limit beats timeout text",
      error: new Error("Rate limit exceeded, timeout: 30s"),
      expected: "rate_limit",
    },
    {
      name: "undefined error",
      error: undefined,
      expected: undefined,
    },
  ] as const)("classifies chat errorKind for $name", ({ error, expected }) => {
    expect(resolveChatErrorKindFromError(error)).toBe(expected);
  });

  it("adds classified errorKind to chat lifecycle error payloads", () => {
    const { broadcast, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-detected-error",
      lifecycleErrorRetryGraceMs: 0,
    });
    registerAgentRunContext("run-detected-error", { sessionKey: "session-detected-error" });

    emitAgentEvent(handler, "run-detected-error", "lifecycle", {
      phase: "error",
      error: Object.assign(new Error("Too many requests"), { code: 429 }),
    });

    const payload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      errorKind?: string;
      errorMessage?: string;
    };
    expect(payload.state).toBe("error");
    expect(payload.errorKind).toBe("rate_limit");
    expect(payload.errorMessage).toContain("Too many requests");
    expect(payload).not.toHaveProperty("message");

    const nodePayload = sessionChatCalls(nodeSendToSession).at(-1)?.[2] as {
      errorKind?: string;
    };
    expect(nodePayload.errorKind).toBe("rate_limit");
    expect(nodePayload).not.toHaveProperty("message");
  });

  it("suppresses delayed lifecycle chat errors for active chat.send runs while still cleaning up", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-chat-send",
      lifecycleErrorRetryGraceMs: 100,
      isChatSendRunActive: (runId) => runId === "run-chat-send",
    });
    registerAgentRunContext("run-chat-send", { sessionKey: "session-chat-send" });

    emitAgentEvents(handler, "run-chat-send", [
      ["assistant", { text: "partial" }],
      ["lifecycle", { phase: "error", error: "chat.send failed" }],
    ]);

    vi.advanceTimersByTime(100);

    expect(
      chatBroadcastCalls(broadcast).some(
        ([, payload]) => (payload as { state?: string }).state === "error",
      ),
    ).toBe(false);
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-chat-send");
    expect(agentRunSeq.has("run-chat-send")).toBe(false);
  });

  it("emits lifecycle chat errors for active chat.send runs with a chat run link", () => {
    vi.useFakeTimers();
    const { broadcast, chatRunState, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-chat-send",
      lifecycleErrorRetryGraceMs: 100,
      isChatSendRunActive: (runId) => runId === "run-chat-send",
    });
    registerChatRun(chatRunState, "run-chat-send", "session-chat-send", "run-chat-send");
    registerAgentRunContext("run-chat-send", { sessionKey: "session-chat-send" });

    emitAgentEvent(handler, "run-chat-send", "lifecycle", {
      phase: "error",
      error: "chat.send failed",
    });

    vi.advanceTimersByTime(100);

    const chatErrors = chatBroadcastCalls(broadcast).filter(
      ([, payload]) => (payload as { state?: string }).state === "error",
    );
    expect(chatErrors).toHaveLength(1);
    const errorPayload = chatErrors[0]?.[1] as Record<string, unknown>;
    expectPayloadFields(errorPayload, {
      runId: "run-chat-send",
      sessionKey: "session-chat-send",
      state: "error",
      errorMessage: "chat.send failed",
    });
    expect(errorPayload).not.toHaveProperty("message");
    expect(chatRunState.registry.peek("run-chat-send")).toBeUndefined();
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-chat-send");
    expect(agentRunSeq.has("run-chat-send")).toBe(false);
  });

  it("suppresses live client events but persists lifecycle for non-control-UI-visible runs", () => {
    const { broadcast, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-hidden",
    });
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-hidden",
      isControlUiVisible: false,
      verboseLevel: "off",
    });

    emitAgentEvent(handler, "run-hidden", "assistant", { text: "Reply from quietchat" });
    emitLifecycleEnd(handler, "run-hidden", 2);

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(broadcast.mock.calls.some(([event]) => event === "agent")).toBe(false);
    expect(nodeSendToSession).not.toHaveBeenCalled();
    const persistParams = requireRecord(
      requireMockArg(persistGatewaySessionLifecycleEventMock, 0, 0, "persist lifecycle params"),
      "persist lifecycle params",
    );
    expect(persistParams.sessionKey).toBe("session-hidden");
    const persistEvent = requireRecord(persistParams.event, "persist lifecycle event");
    expect(persistEvent.runId).toBe("run-hidden");
    expect(requireRecord(persistEvent.data, "persist lifecycle event data").phase).toBe("end");
  });

  it("sends non-control-UI-visible live chat only to exact session message subscribers", () => {
    vi.useFakeTimers();
    const { broadcast, broadcastToConnIds, nodeSendToSession, sessionMessageSubscribers, handler } =
      createHarness({
        resolveSessionKeyForRun: () => "session-hidden",
        lifecycleErrorRetryGraceMs: 1,
      });
    sessionMessageSubscribers.subscribe("conn-selected", "session-hidden");
    sessionMessageSubscribers.subscribe("conn-other", "session-other");
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-hidden",
      isControlUiVisible: false,
      verboseLevel: "off",
    });

    emitAgentEvent(handler, "run-hidden", "assistant", {
      text: "visible only to the selected session",
    });
    emitLifecycleEnd(handler, "run-hidden", 2);

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(nodeSendToSession).not.toHaveBeenCalled();
    const chatCalls = broadcastToConnIds.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]?.[2]).toEqual(new Set(["conn-selected"]));
    expectPayloadFields(chatCalls[0]?.[1], {
      runId: "run-hidden",
      sessionKey: "session-hidden",
      state: "delta",
    });
    const finalPayload = requireRecord(chatCalls[1]?.[1], "hidden chat final payload");
    expectPayloadFields(finalPayload, {
      runId: "run-hidden",
      sessionKey: "session-hidden",
      state: "final",
    });
    expect(chatCalls[1]?.[2]).toEqual(new Set(["conn-selected"]));

    const streams = ["tool", "thinking", "approval"] as const;
    const streamCallStart = broadcastToConnIds.mock.calls.length;
    for (const [index, stream] of streams.entries()) {
      handler({
        runId: "run-hidden",
        seq: index + 3,
        stream,
        ts: Date.now(),
        data: { phase: "start", delta: "Inspecting", name: "read" },
      });
    }
    expect(
      broadcastToConnIds.mock.calls
        .slice(streamCallStart)
        .map(([event, payload, recipients]) => [
          event,
          requireRecord(payload, "event").stream,
          recipients,
        ]),
    ).toEqual(streams.map((stream) => ["agent", stream, new Set(["conn-selected"])]));

    broadcastToConnIds.mockClear();
    const claimId = claimAgentRunContext(
      "revoked",
      { isControlUiVisible: false, sessionKey: "session-hidden" },
      { exclusive: true, trackOwner: true },
    )!;
    const stop = onAgentRuntimeEvent(handler);
    emitAgentEventForOwner(
      { runId: "revoked", stream: "lifecycle", data: { phase: "error", error: "retry" } },
      claimId,
    );
    stop();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const persisted = persistGatewaySessionLifecycleEventMock.mock.calls.length;
    releaseAgentRunContext("revoked", claimId);
    vi.advanceTimersByTime(1);
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledTimes(persisted);
  });

  it("mirrors commentary-phase assistant events only to exact session message subscribers", () => {
    const {
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      sessionMessageSubscribers,
      handler,
      nowSpy,
    } = createHarness({
      now: 1_000,
      resolveSessionKeyForRun: () => "session-hidden",
    });
    sessionMessageSubscribers.subscribe("conn-selected", "session-hidden");
    sessionMessageSubscribers.subscribe("conn-other", "session-other");
    registerAgentRunContext("run-hidden-commentary", {
      sessionKey: "session-hidden",
      isControlUiVisible: false,
      verboseLevel: "off",
    });

    emitAgentEvents(handler, "run-hidden-commentary", [
      [
        "assistant",
        {
          text: "I will inspect the files first.",
          delta: "I will inspect the files first.",
          phase: "commentary",
        },
      ],
      [
        "assistant",
        {
          text: "Untagged text frame must not mirror.",
          delta: "Untagged text frame must not mirror.",
        },
      ],
      ["assistant", { delta: "Untagged delta-only stream must not mirror." }],
      ["assistant", { text: "Terminal echo without delta" }],
      ["assistant", { text: "Final answer", delta: "Final answer", phase: "final_answer" }],
      ["assistant", { delta: "Streaming commentary delta.", phase: "commentary" }],
    ]);

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(agentBroadcastCalls(broadcast)).toHaveLength(0);
    expect(nodeSendToSession).not.toHaveBeenCalled();

    const agentCalls = broadcastToConnIds.mock.calls.filter(([event]) => event === "agent");
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0]?.[2]).toEqual(new Set(["conn-selected"]));
    expect(agentCalls[1]?.[2]).toEqual(new Set(["conn-selected"]));
    expectPayloadFields(agentCalls[0]?.[1], {
      runId: "run-hidden-commentary",
      sessionKey: "session-hidden",
      stream: "assistant",
    });
    expectPayloadFields(agentCalls[1]?.[1], {
      runId: "run-hidden-commentary",
      sessionKey: "session-hidden",
      stream: "assistant",
    });
    expectPayloadDataFields(agentCalls[0]?.[1], {
      text: "I will inspect the files first.",
      delta: "I will inspect the files first.",
      phase: "commentary",
    });
    expectPayloadDataFields(agentCalls[1]?.[1], {
      delta: "Streaming commentary delta.",
      phase: "commentary",
    });

    const chatCalls = broadcastToConnIds.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.[2]).toEqual(new Set(["conn-selected"]));
    expectPayloadFields(chatCalls[0]?.[1], {
      runId: "run-hidden-commentary",
      sessionKey: "session-hidden",
      state: "delta",
    });
    nowSpy?.mockRestore();
  });

  it("does not mirror aborted non-control-UI-visible assistant commentary", () => {
    const {
      broadcast,
      broadcastToConnIds,
      chatRunState,
      nodeSendToSession,
      sessionMessageSubscribers,
      handler,
      nowSpy,
    } = createHarness({
      now: 1_000,
      resolveSessionKeyForRun: () => "session-hidden-aborted",
    });
    sessionMessageSubscribers.subscribe("conn-selected", "session-hidden-aborted");
    registerAgentRunContext("run-hidden-commentary-aborted", {
      sessionKey: "session-hidden-aborted",
      isControlUiVisible: false,
      verboseLevel: "off",
    });
    chatRunState.getOrCreate("run-hidden-commentary-aborted").abortMarker = 1_000;

    emitAgentEvent(handler, "run-hidden-commentary-aborted", "assistant", {
      text: "This aborted commentary must not be mirrored.",
      delta: "This aborted commentary must not be mirrored.",
      phase: "commentary",
    });

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(agentBroadcastCalls(broadcast)).toHaveLength(0);
    expect(broadcastToConnIds).not.toHaveBeenCalled();
    expect(nodeSendToSession).not.toHaveBeenCalled();
    nowSpy?.mockRestore();
  });

  it("sends non-control-UI-visible status item events to exact session message subscribers", () => {
    const { broadcast, broadcastToConnIds, nodeSendToSession, sessionMessageSubscribers, handler } =
      createHarness({
        resolveSessionKeyForRun: () => "session-hidden",
      });
    sessionMessageSubscribers.subscribe("conn-selected", "session-hidden");
    sessionMessageSubscribers.subscribe("conn-other", "session-other");
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-hidden",
      isControlUiVisible: false,
      verboseLevel: "off",
    });

    emitAgentEvent(handler, "run-hidden", "item", {
      kind: "status",
      title: "Fast",
      phase: "update",
      summary: "💨Fast: auto-off(8s>=5s)",
    });

    expect(agentBroadcastCalls(broadcast)).toHaveLength(0);
    expect(nodeSendToSession).not.toHaveBeenCalled();
    expect(requireMockArg(broadcastToConnIds, 0, 0, "hidden status item event")).toBe("agent");
    const payload = requireMockPayload(broadcastToConnIds, 0, 1, "hidden status item payload");
    expectPayloadFields(payload, {
      runId: "run-hidden",
      sessionKey: "session-hidden",
      stream: "item",
    });
    expectPayloadDataFields(payload, {
      kind: "status",
      title: "Fast",
      summary: "💨Fast: auto-off(8s>=5s)",
    });
    expect(requireMockArg(broadcastToConnIds, 0, 2, "hidden status item recipients")).toEqual(
      new Set(["conn-selected"]),
    );
  });

  it("uses agent event sessionKey when run-context lookup cannot resolve", () => {
    const { broadcast, handler } = createHarness({
      resolveSessionKeyForRun: () => undefined,
    });

    emitFallbackLifecycle({
      handler,
      runId: "run-fallback-session-key",
      sessionKey: "session-from-event",
    });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.sessionKey).toBe("session-from-event");
  });

  it("remaps chat-linked tool-start runId to the client run before UI delivery", () => {
    const { broadcastToConnIds, chatRunState, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-remap",
    });

    registerChatRun(chatRunState, "run-tool-internal", "session-tool-remap", "run-tool-client");
    registerAgentRunContext("run-tool-internal", {
      sessionKey: "session-tool-remap",
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-tool-internal", "conn-1");

    emitAgentEvent(handler, "run-tool-internal", "tool", {
      phase: "start",
      name: "exec",
      toolCallId: "tool-remap-1",
      args: { command: "true" },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = requireMockArg(broadcastToConnIds, 0, 1, "remapped tool payload") as {
      runId?: string;
    };
    expect(payload.runId).toBe("run-tool-client");
  });

  it("suppresses heartbeat ack-like chat output when showOk is false", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      now: 2_000,
    });
    registerNamedChatRun(chatRunState, "heartbeat");
    registerAgentRunContext("run-heartbeat", {
      sessionKey: "session-heartbeat",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    emitAgentEvent(handler, "run-heartbeat", "assistant", {
      text: "HEARTBEAT_OK Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
    });

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);

    emitLifecycleEnd(handler, "run-heartbeat");

    const finalPayload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(finalPayload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
  });

  it("keeps heartbeat alert text in final chat output when remainder exceeds ackMaxChars", () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      agents: { defaults: { heartbeat: {} } },
    });

    const { broadcast, chatRunState, handler } = createHarness({ now: 3_000 });
    registerNamedChatRun(chatRunState, "heartbeat-alert");
    registerAgentRunContext("run-heartbeat-alert", {
      sessionKey: "session-heartbeat-alert",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    const alert = `Disk usage crossed 95 percent on /data. ${"Cleanup required. ".repeat(20)}`;
    emitAgentEvent(handler, "run-heartbeat-alert", "assistant", {
      text: `HEARTBEAT_OK ${alert}`,
    });

    emitLifecycleEnd(handler, "run-heartbeat-alert");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe(alert.trim());
  });

  describe("spawnedBy enrichment in chat and agent broadcasts", () => {
    function mockSessionLineage(key: string, spawnedBy?: string) {
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key,
        kind: "direct",
        updatedAt: null,
        ...(spawnedBy ? { spawnedBy } : {}),
      });
    }

    it.each([
      {
        name: "includes spawnedBy in chat delta broadcasts for subagent sessions",
        runId: "run-sub-1",
        clientRunId: "client-sub-1",
        events: [["assistant", { text: "hello from subagent" }]],
        state: "delta",
        expectsNodeCopy: true,
      },
      {
        name: "includes spawnedBy in chat final broadcasts for subagent sessions",
        runId: "run-sub-final",
        clientRunId: "client-sub-final",
        events: [
          ["assistant", { text: "done" }],
          ["lifecycle", { phase: "end" }],
        ],
        state: "final",
        expectsNodeCopy: false,
      },
    ] as const)("$name", ({ runId, clientRunId, events, state, expectsNodeCopy }) => {
      mockSessionLineage("agent:coder:subagent:abc", "agent:conductor:task:parent-1");

      const { broadcast, nodeSendToSession, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:abc",
      });
      registerChatRun(chatRunState, runId, "agent:coder:subagent:abc", clientRunId);
      emitAgentEvents(handler, runId, events);

      const payload = requireCall(
        chatBroadcastCalls(broadcast).find(([, candidate]) => candidate.state === state)?.[1],
        `${state} chat payload`,
      );
      expectPayloadFields(payload, {
        sessionKey: "agent:coder:subagent:abc",
        spawnedBy: "agent:conductor:task:parent-1",
        state,
      });
      if (expectsNodeCopy) {
        expectPayloadFields(sessionChatCalls(nodeSendToSession)[0]?.[2], {
          spawnedBy: "agent:conductor:task:parent-1",
        });
      }
    });

    it("marks a yielded final as waiting instead of parent-task completion", () => {
      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:main:main",
      });

      registerChatRun(chatRunState, "run-yielded", "agent:main:main", "client-yielded");
      emitAgentEvent(handler, "run-yielded", "assistant", {
        text: "Waiting for registered continuation work.",
      });
      emitAgentEvent(
        handler,
        "run-yielded",
        "lifecycle",
        {
          phase: "end",
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        },
        { seq: 2 },
      );

      const finalCall = requireCall(
        chatBroadcastCalls(broadcast).find(([, payload]) => payload.state === "final"),
        "yielded final chat call",
      );
      expectPayloadFields(finalCall[1], {
        runId: "client-yielded",
        sessionKey: "agent:main:main",
        state: "final",
        stopReason: "end_turn",
        yielded: true,
      });
    });

    it("does not let stale yield metadata override an aborted lifecycle", () => {
      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:main:main",
      });

      registerChatRun(chatRunState, "run-aborted", "agent:main:main", "client-aborted");
      emitAgentEvent(handler, "run-aborted", "lifecycle", {
        phase: "end",
        aborted: true,
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      });

      const finalCall = requireCall(
        chatBroadcastCalls(broadcast).find(([, payload]) => payload.state === "error"),
        "aborted final chat call",
      );
      expectPayloadFields(finalCall[1], {
        runId: "client-aborted",
        sessionKey: "agent:main:main",
        state: "error",
        stopReason: "end_turn",
      });
      expect(finalCall[1]).not.toHaveProperty("yielded");
    });

    it("omits spawnedBy from chat broadcasts for non-subagent sessions", () => {
      mockSessionLineage("agent:main:main");

      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:main:main",
      });

      registerChatRun(chatRunState, "run-main", "agent:main:main", "client-main");

      emitAgentEvent(handler, "run-main", "assistant", { text: "hello from main" });

      const chatCalls = chatBroadcastCalls(broadcast);
      expect(chatCalls.length).toBeGreaterThanOrEqual(1);
      expect(expectDefined(chatCalls[0], "chatCalls[0] test invariant")[1]).not.toHaveProperty(
        "spawnedBy",
      );
    });

    it("skips session row load entirely for session keys that cannot carry lineage", () => {
      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:main:main",
      });

      registerChatRun(chatRunState, "run-no-lineage", "agent:main:main", "client-no-lineage");

      for (let seq = 1; seq <= 5; seq++) {
        emitAgentEvent(
          handler,
          "run-no-lineage",
          "assistant",
          { text: `message ${seq}` },
          { seq, ts: Date.now() + seq * 200 },
        );
      }

      // The chat delta path invokes resolveSpawnedBy only. Non-subagent,
      // non-acp keys cannot carry spawnedBy (see supportsSpawnLineage in
      // sessions-patch.ts), so resolveSpawnedBy must short-circuit without
      // ever calling loadGatewaySessionRow on this hot path.
      expect(loadGatewaySessionRow).not.toHaveBeenCalled();

      const chatCalls = chatBroadcastCalls(broadcast);
      expect(chatCalls.length).toBeGreaterThanOrEqual(1);
      expect(expectDefined(chatCalls[0], "chatCalls[0] test invariant")[1]).not.toHaveProperty(
        "spawnedBy",
      );
    });

    it("includes spawnedBy in non-tool agent event broadcasts for subagent sessions", () => {
      mockSessionLineage("agent:coder:subagent:xyz", "agent:conductor:task:parent-2");

      const { broadcast, handler } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:xyz",
      });

      registerAgentRunContext("run-agent-sub", { sessionKey: "agent:coder:subagent:xyz" });

      emitAgentEvent(handler, "run-agent-sub", "lifecycle", { phase: "start" });

      const agentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
      expect(agentCalls.length).toBeGreaterThanOrEqual(1);
      expectPayloadFields(agentCalls[0]?.[1], {
        sessionKey: "agent:coder:subagent:xyz",
        spawnedBy: "agent:conductor:task:parent-2",
      });
    });

    it("includes spawnedBy in chat error final broadcasts for subagent sessions", () => {
      mockSessionLineage("agent:coder:subagent:err", "agent:conductor:task:parent-err");

      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:err",
        lifecycleErrorRetryGraceMs: 0,
      });

      registerChatRun(chatRunState, "run-sub-err", "agent:coder:subagent:err", "client-sub-err");

      emitAgentEvents(handler, "run-sub-err", [
        ["assistant", { text: "partial" }],
        ["lifecycle", { phase: "error", error: "provider failed" }],
      ]);

      const chatCalls = chatBroadcastCalls(broadcast);
      const errorCall = requireCall(
        chatCalls.find(([, p]) => p.state === "error"),
        "error chat call",
      );
      expectPayloadFields(errorCall[1], {
        sessionKey: "agent:coder:subagent:err",
        spawnedBy: "agent:conductor:task:parent-err",
        state: "error",
      });
    });

    it("includes spawnedBy in flushed chat delta for subagent sessions", () => {
      let now = 20_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

      mockSessionLineage("agent:coder:subagent:flush", "agent:conductor:task:parent-flush");

      const { broadcast, chatRunState, toolEventRecipients, handler } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:flush",
      });

      registerChatRun(
        chatRunState,
        "run-sub-flush",
        "agent:coder:subagent:flush",
        "client-sub-flush",
      );
      registerAgentRunContext("run-sub-flush", {
        sessionKey: "agent:coder:subagent:flush",
        verboseLevel: "off",
      });
      toolEventRecipients.add("run-sub-flush", "conn-flush");

      emitAgentEvent(handler, "run-sub-flush", "assistant", { text: "before tool" });

      now = 20_050;
      emitAgentEvent(
        handler,
        "run-sub-flush",
        "assistant",
        { text: "before tool expanded" },
        { seq: 2 },
      );

      emitAgentEvent(
        handler,
        "run-sub-flush",
        "tool",
        { phase: "start", name: "exec", toolCallId: "tool-flush-sub" },
        { seq: 3 },
      );

      const chatCalls = chatBroadcastCalls(broadcast);
      const flushedDelta = requireCall(
        chatCalls.find(
          ([, p]) =>
            p.state === "delta" && p.message?.content?.[0]?.text === "before tool expanded",
        ),
        "flushed delta chat call",
      );
      expectPayloadFields(flushedDelta[1], {
        spawnedBy: "agent:conductor:task:parent-flush",
      });

      nowSpy.mockRestore();
    });

    it("includes spawnedBy in seq gap error broadcasts for subagent sessions", () => {
      mockSessionLineage("agent:coder:subagent:gap", "agent:conductor:task:parent-gap");

      const { broadcast, handler } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:gap",
      });

      registerAgentRunContext("run-sub-gap", { sessionKey: "agent:coder:subagent:gap" });

      emitAgentEvents(handler, "run-sub-gap", [
        ["lifecycle", { phase: "start" }],
        ["assistant", { text: "skipped seq" }, { seq: 5 }],
      ]);

      const agentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
      const gapError = requireCall(
        agentCalls.find(([, p]) => p.stream === "error" && p.data?.reason === "seq gap"),
        "seq gap error agent call",
      );
      expectPayloadFields(gapError[1], {
        sessionKey: "agent:coder:subagent:gap",
        spawnedBy: "agent:conductor:task:parent-gap",
      });
      expectPayloadDataFields(gapError[1], { reason: "seq gap", expected: 2, received: 5 });
    });

    it("caches spawnedBy lookup so repeated events for the same subagent session only load the row once", () => {
      vi.mocked(loadGatewaySessionRow).mockClear();
      mockSessionLineage("agent:coder:subagent:cache-test", "agent:conductor:task:parent-cache");

      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:cache-test",
      });

      registerChatRun(chatRunState, "run-cache", "agent:coder:subagent:cache-test", "client-cache");

      emitAgentEvents(handler, "run-cache", [
        ["assistant", { text: "chunk 1" }],
        ["assistant", { text: "chunk 2" }],
        ["lifecycle", { phase: "end" }],
      ]);

      // Key assertion: loadGatewaySessionRow called exactly once despite 3 events
      expect(loadGatewaySessionRow).toHaveBeenCalledTimes(1);
      expect(loadGatewaySessionRow).toHaveBeenCalledWith("agent:coder:subagent:cache-test");

      // All broadcasts still have correct spawnedBy
      const chatCalls = chatBroadcastCalls(broadcast);
      for (const [, payload] of chatCalls) {
        expectPayloadFields(payload, {
          spawnedBy: "agent:conductor:task:parent-cache",
        });
      }
    });

    it("caches null spawnedBy for eligible subagent sessions that lack a spawnedBy value", () => {
      vi.mocked(loadGatewaySessionRow).mockClear();
      mockSessionLineage("agent:coder:subagent:no-lineage");

      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:no-lineage",
      });

      registerChatRun(chatRunState, "run-null", "agent:coder:subagent:no-lineage", "client-null");

      emitAgentEvents(handler, "run-null", [
        ["assistant", { text: "chunk 1" }],
        ["assistant", { text: "chunk 2" }],
      ]);

      // null result is cached — only one DB call despite two events
      expect(loadGatewaySessionRow).toHaveBeenCalledTimes(1);

      const chatCalls = chatBroadcastCalls(broadcast);
      for (const [, payload] of chatCalls) {
        expect(payload).not.toHaveProperty("spawnedBy");
      }
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
