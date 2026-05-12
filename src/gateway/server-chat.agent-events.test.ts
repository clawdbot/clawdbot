import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { formatChannelProgressDraftLine } from "../plugin-sdk/channel-streaming.js";

const persistGatewaySessionLifecycleEventMock = vi.fn();

vi.mock("./server-chat.persist-session-lifecycle.runtime.js", () => ({
  persistGatewaySessionLifecycleEvent: (...args: unknown[]) =>
    persistGatewaySessionLifecycleEventMock(...args),
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

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/sessions.json",
    store: {},
    entry: undefined,
    canonicalKey: "session-1",
    legacyKey: undefined,
  })),
}));

import { getRuntimeConfig } from "../config/io.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { loadGatewaySessionRow } from "./server-chat.load-gateway-session-row.runtime.js";
import { loadSessionEntry } from "./session-utils.js";

describe("agent event handler", () => {
  beforeEach(() => {
    vi.mocked(getRuntimeConfig).mockReturnValue({});
    vi.mocked(resolveHeartbeatVisibility).mockReturnValue({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
    vi.mocked(loadSessionEntry).mockReset().mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      store: {},
      entry: undefined,
      canonicalKey: "session-1",
      legacyKey: undefined,
    });
    vi.mocked(loadGatewaySessionRow).mockReset().mockReturnValue(null);
    persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(undefined);
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAgentRunContextForTest();
  });

  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
    lifecycleErrorRetryGraceMs?: number;
    isChatSendRunActive?: (runId: string) => boolean;
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const clearAgentRunContext = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();

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
      loadGatewaySessionRowForSnapshot: loadGatewaySessionRow,
      lifecycleErrorRetryGraceMs: params?.lifecycleErrorRetryGraceMs,
      isChatSendRunActive: params?.isChatSendRunActive,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      clearAgentRunContext,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      sessionEventSubscribers,
      handler,
    };
  }

  function emitRun1AssistantText(
    harness: ReturnType<typeof createHarness>,
    text: string,
  ): ReturnType<typeof createHarness> {
    harness.chatRunState.registry.add("run-1", {
      sessionKey: "session-1",
      clientRunId: "client-1",
    });
    harness.handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text },
    });
    return harness;
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
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

  function emitLifecycleEnd(
    handler: ReturnType<typeof createHarness>["handler"],
    runId: string,
    seq = 2,
  ) {
    handler({
      runId,
      seq,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });
  }

  function emitFallbackLifecycle(params: {
    handler: ReturnType<typeof createHarness>["handler"];
    runId: string;
    seq?: number;
    sessionKey?: string;
  }) {
    params.handler({
      runId: params.runId,
      seq: params.seq ?? 1,
      stream: "lifecycle",
      ts: Date.now(),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      data: { ...FALLBACK_LIFECYCLE_DATA },
    });
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
    registerAgentRunContext("run-heartbeat-true", { sessionKey: "session-1", isHeartbeat: true });
    registerAgentRunContext("run-heartbeat-false", { sessionKey: "session-2", isHeartbeat: false });

    // 1. isHeartbeat: true
    harness.handler({
      runId: "run-heartbeat-true",
      seq: 1,
      stream: "assistant",
      ts: 100,
      data: { text: "hello" },
    });

    const agentPayload1 = harness.broadcast.mock.calls.find(
      ([event]) => event === "agent",
    )?.[1] as Record<string, unknown>;
    expect(agentPayload1).toBeDefined();
    expect(agentPayload1.isHeartbeat).toBe(true);

    // sessionKey is required for nodeSendToSession to be called
    harness.chatRunState.registry.add("run-heartbeat-true", {
      sessionKey: "session-1",
      clientRunId: "run-heartbeat-true",
    });
    harness.handler({
      runId: "run-heartbeat-true",
      seq: 2,
      stream: "assistant",
      ts: 100,
      data: { text: "hello" },
    });

    const nodeSendPayload1 = harness.nodeSendToSession.mock.calls.find(
      ([, event]) => event === "agent",
    )?.[2] as Record<string, unknown>;
    expect(nodeSendPayload1).toBeDefined();
    expect(nodeSendPayload1.isHeartbeat).toBe(true);

    harness.broadcast.mockClear();
    harness.nodeSendToSession.mockClear();

    // 2. isHeartbeat: false
    harness.chatRunState.registry.add("run-heartbeat-false", {
      sessionKey: "session-2",
      clientRunId: "run-heartbeat-false",
    });
    harness.handler({
      runId: "run-heartbeat-false",
      seq: 1,
      stream: "assistant",
      ts: 101,
      data: { text: "hello" },
    });

    const agentPayload2 = harness.broadcast.mock.calls.find(
      ([event]) => event === "agent",
    )?.[1] as Record<string, unknown>;
    expect(agentPayload2).toBeDefined();
    expect(agentPayload2.isHeartbeat).toBe(false);

    const nodeSendPayload2 = harness.nodeSendToSession.mock.calls.find(
      ([, event]) => event === "agent",
    )?.[2] as Record<string, unknown>;
    expect(nodeSendPayload2).toBeDefined();
    expect(nodeSendPayload2.isHeartbeat).toBe(false);

    harness.broadcast.mockClear();
    harness.nodeSendToSession.mockClear();

    // 3. isHeartbeat: undefined (absent)
    harness.chatRunState.registry.add("run-normal", {
      sessionKey: "session-3",
      clientRunId: "run-normal",
    });
    harness.handler({
      runId: "run-normal",
      seq: 1,
      stream: "assistant",
      ts: 102,
      data: { text: "hello" },
    });

    const normalBroadcast = harness.broadcast.mock.calls.find(
      ([event]) => event === "agent",
    )?.[1] as Record<string, unknown>;
    expect(normalBroadcast).toBeDefined();
    expect("isHeartbeat" in normalBroadcast).toBe(false);

    const normalNodeSend = harness.nodeSendToSession.mock.calls.find(
      ([, event]) => event === "agent",
    )?.[2] as Record<string, unknown>;
    expect(normalNodeSend).toBeDefined();
    expect("isHeartbeat" in normalNodeSend).toBe(false);
  });

  it("emits chat delta for assistant text-only events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello world",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
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
      chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });

      handler({
        runId: "run-2",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text: replyText },
      });
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
    chatRunState.registry.add("run-3", { sessionKey: "session-3", clientRunId: "client-3" });

    for (const text of ["NO", "NO_", "NO_RE", "NO_REPLY"]) {
      handler({
        runId: "run-3",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text },
      });
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
      chatRunState.registry.add("run-control", {
        sessionKey: "session-control",
        clientRunId: "client-control",
      });

      for (const text of fragments) {
        handler({
          runId: "run-control",
          seq: 1,
          stream: "assistant",
          ts: Date.now(),
          data: { text },
        });
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
    chatRunState.registry.add("run-4", { sessionKey: "session-4", clientRunId: "client-4" });

    handler({
      runId: "run-4",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "No" },
    });
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
    chatRunState.registry.add("run-4b", { sessionKey: "session-4b", clientRunId: "client-4b" });

    handler({
      runId: "run-4b",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLYThe user" },
    });
    handler({
      runId: "run-4b",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLYThe user is saying hello" },
    });
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
    chatRunState.registry.add("run-flush", {
      sessionKey: "session-flush",
      clientRunId: "client-flush",
    });

    handler({
      runId: "run-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello" },
    });

    now = 10_100;
    handler({
      runId: "run-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    emitLifecycleEnd(handler, "run-flush");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const firstPayload = chatCalls[0]?.[1] as { state?: string };
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const thirdPayload = chatCalls[2]?.[1] as { state?: string };
    expect(firstPayload.state).toBe("delta");
    expect(secondPayload.state).toBe("delta");
    expect(secondPayload.message?.content?.[0]?.text).toBe("Hello world");
    expect(thirdPayload.state).toBe("final");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("preserves pre-tool assistant text when later segments stream as non-prefix snapshots", () => {
    let now = 10_500;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-segmented", {
      sessionKey: "session-segmented",
      clientRunId: "client-segmented",
    });

    handler({
      runId: "run-segmented",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool call", delta: "Before tool call" },
    });

    now = 10_700;
    handler({
      runId: "run-segmented",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "After tool call", delta: "\nAfter tool call" },
    });

    emitLifecycleEnd(handler, "run-segmented", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const finalPayload = chatCalls[2]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(secondPayload.state).toBe("delta");
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
    chatRunState.registry.add("run-segmented-flush", {
      sessionKey: "session-segmented-flush",
      clientRunId: "client-segmented-flush",
    });

    handler({
      runId: "run-segmented-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool call", delta: "Before tool call" },
    });

    now = 10_860;
    handler({
      runId: "run-segmented-flush",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "After tool call", delta: "\nAfter tool call" },
    });

    emitLifecycleEnd(handler, "run-segmented-flush", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const flushPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const finalPayload = chatCalls[2]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(flushPayload.state).toBe("delta");
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
    chatRunState.registry.add("run-no-dup-flush", {
      sessionKey: "session-no-dup-flush",
      clientRunId: "client-no-dup-flush",
    });

    handler({
      runId: "run-no-dup-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello" },
    });

    now = 11_200;
    handler({
      runId: "run-no-dup-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

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

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2_500 });
    chatRunState.registry.add("run-cleanup", {
      sessionKey: "session-cleanup",
      clientRunId: "client-cleanup",
    });

    handler({
      runId: "run-cleanup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    handler({
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("drops stale events that arrive after lifecycle completion", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_500,
    });
    chatRunState.registry.add("run-stale-tail", {
      sessionKey: "session-stale-tail",
      clientRunId: "client-stale-tail",
    });

    handler({
      runId: "run-stale-tail",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    emitLifecycleEnd(handler, "run-stale-tail");
    const errorCallsBeforeStaleEvent = broadcast.mock.calls.filter(
      ([event, payload]) =>
        event === "agent" && (payload as { stream?: string }).stream === "error",
    ).length;
    const sessionChatCallsBeforeStaleEvent = sessionChatCalls(nodeSendToSession).length;

    handler({
      runId: "run-stale-tail",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "late tail" },
    });

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

    chatRunState.registry.add("run-tool-flush", {
      sessionKey: "session-tool-flush",
      clientRunId: "client-tool-flush",
    });
    registerAgentRunContext("run-tool-flush", {
      sessionKey: "session-tool-flush",
      verboseLevel: "off",
    });
    toolEventRecipients.add("run-tool-flush", "conn-1");

    handler({
      runId: "run-tool-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool" },
    });

    // Throttled assistant update (within 150ms window).
    now = 12_050;
    handler({
      runId: "run-tool-flush",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool expanded" },
    });

    handler({
      runId: "run-tool-flush",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "tool-flush-1" },
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const flushedPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(flushedPayload.state).toBe("delta");
    expect(flushedPayload.message?.content?.[0]?.text).toBe("Before tool expanded");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(2);

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const flushCallOrder = broadcast.mock.invocationCallOrder[1] ?? 0;
    const toolCallOrder = broadcastToConnIds.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(flushCallOrder).toBeLessThan(toolCallOrder);
    nowSpy.mockRestore();
    resetAgentRunContextForTest();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    handler({
      runId: "run-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    resetAgentRunContextForTest();
  });

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    handler({
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t2" },
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("uses newer session verbose state for in-flight tool events", () => {
    const { nodeSendToSession, handler } = createHarness({
      now: 1_000,
      resolveSessionKeyForRun: () => "session-1",
    });
    vi.mocked(loadSessionEntry).mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      store: {},
      entry: { sessionId: "session-1", verboseLevel: "on", updatedAt: 1_500 },
      canonicalKey: "session-1",
      legacyKey: undefined,
    });

    registerAgentRunContext("run-tool-toggle", {
      sessionKey: "session-1",
      verboseLevel: "off",
    });

    handler({
      runId: "run-tool-toggle",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t-toggle" },
    });

    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(1);
    const payload = requireRecord(nodeToolCalls[0]?.[2], "node tool payload");
    expect(payload.stream).toBe("tool");
    expectRecordFields(requireRecord(payload.data, "node tool payload data"), {
      phase: "start",
      name: "read",
    });
    resetAgentRunContextForTest();
  });

  it("keeps one-shot run verbose over older session state", () => {
    const { nodeSendToSession, handler } = createHarness({
      now: 2_000,
      resolveSessionKeyForRun: () => "session-1",
    });
    vi.mocked(loadSessionEntry).mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      store: {},
      entry: { sessionId: "session-1", verboseLevel: "off", updatedAt: 1_500 },
      canonicalKey: "session-1",
      legacyKey: undefined,
    });

    registerAgentRunContext("run-tool-inline", {
      sessionKey: "session-1",
      verboseLevel: "on",
    });

    handler({
      runId: "run-tool-inline",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t-inline" },
    });

    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(1);
    resetAgentRunContextForTest();
  });

  it("mirrors tool events to session subscribers so late-joining operator UIs can render them", () => {
    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-1",
      kind: "direct",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      lastThreadId: 42,
      fastMode: true,
      verboseLevel: "on",
      updatedAt: 1_200,
    });

    registerAgentRunContext("run-session-tool", { sessionKey: "session-1", verboseLevel: "off" });
    sessionEventSubscribers.subscribe("conn-session");

    handler({
      runId: "run-session-tool",
      seq: 1,
      stream: "tool",
      ts: 1_234,
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-session-1",
        args: { command: "echo hi" },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(requireMockArg(broadcastToConnIds, 0, 0, "session tool event")).toBe("session.tool");
    const sessionToolPayload = requireMockPayload(broadcastToConnIds, 0, 1, "session tool payload");
    expectRecordFields(sessionToolPayload, {
      runId: "run-session-tool",
      sessionKey: "session-1",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      lastThreadId: 42,
      fastMode: true,
      verboseLevel: "on",
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
    resetAgentRunContextForTest();
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

    handler({
      runId: "run-heartbeat-tool",
      seq: 1,
      stream: "tool",
      ts: 1_234,
      data: {
        phase: "start",
        name: "read",
        toolCallId: "tool-heartbeat-1",
        args: { path: "HEARTBEAT.md" },
      },
    });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("hydrates run-scoped tool events with session ownership metadata", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-1",
      kind: "direct",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      lastThreadId: 42,
      fastMode: true,
      verboseLevel: "on",
      updatedAt: 1_200,
    });

    registerAgentRunContext("run-tool-owner", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-owner", "conn-run");

    handler({
      runId: "run-tool-owner",
      seq: 1,
      stream: "tool",
      ts: 1_234,
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-run-1",
        args: { command: "echo hi" },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(requireMockArg(broadcastToConnIds, 0, 0, "run tool event")).toBe("agent");
    const runToolPayload = requireMockPayload(broadcastToConnIds, 0, 1, "run tool payload");
    expectRecordFields(runToolPayload, {
      runId: "run-tool-owner",
      sessionKey: "session-1",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      lastThreadId: 42,
      fastMode: true,
      verboseLevel: "on",
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
    resetAgentRunContextForTest();
  });

  it("projects tool-search bridge calls like native channel verbose tool events", () => {
    const { nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-search-node", {
      sessionKey: "session-1",
      verboseLevel: "on",
    });

    handler({
      runId: "run-tool-search-node",
      seq: 1,
      stream: "tool",
      ts: 1_234,
      data: {
        phase: "start",
        name: "tool_search_code",
        toolCallId: "tool-search-node-1",
        args: {
          code: 'return await openclaw.tools.call("openclaw:core:exec", { command: "echo hi" });',
        },
      },
    });

    const payload = requireMockArg(nodeSendToSession, 0, 2, "node tool-search payload") as {
      stream?: string;
      data?: { name?: string; args?: Record<string, unknown> };
    };
    expect(payload.stream).toBe("tool");
    expect(payload.data).toMatchObject({
      phase: "start",
      name: "exec",
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
    resetAgentRunContextForTest();
  });

  it("hydrates node session tool events with session ownership metadata", () => {
    const { nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-1",
      kind: "direct",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      lastThreadId: 42,
      fastMode: true,
      verboseLevel: "on",
      updatedAt: 1_200,
    });

    registerAgentRunContext("run-tool-node", { sessionKey: "session-1", verboseLevel: "on" });

    handler({
      runId: "run-tool-node",
      seq: 1,
      stream: "tool",
      ts: 1_234,
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-node-1",
        args: { command: "echo hi" },
      },
    });

    expect(requireMockArg(nodeSendToSession, 0, 0, "node tool session")).toBe("session-1");
    expect(requireMockArg(nodeSendToSession, 0, 1, "node tool event")).toBe("agent");
    const nodeToolPayload = requireMockPayload(nodeSendToSession, 0, 2, "node tool payload");
    expectRecordFields(nodeToolPayload, {
      runId: "run-tool-node",
      sessionKey: "session-1",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      lastThreadId: 42,
      fastMode: true,
      verboseLevel: "on",
      stream: "tool",
      ts: 1_234,
    });
    expectRecordFields(requireRecord(nodeToolPayload.data, "node tool payload data"), {
      phase: "start",
      name: "exec",
      toolCallId: "tool-node-1",
      args: { command: "echo hi" },
    });
    resetAgentRunContextForTest();
  });

  it("broadcasts terminal session status to session subscribers on lifecycle end", () => {
    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-finished",
    });

    sessionEventSubscribers.subscribe("conn-session");
    registerAgentRunContext("run-finished", {
      sessionKey: "session-finished",
      verboseLevel: "off",
    });

    handler({
      runId: "run-finished",
      seq: 1,
      stream: "lifecycle",
      ts: 1_000,
      data: {
        phase: "start",
        startedAt: 900,
      },
    });
    handler({
      runId: "run-finished",
      seq: 2,
      stream: "lifecycle",
      ts: 1_800,
      data: {
        phase: "end",
        startedAt: 900,
        endedAt: 1_700,
      },
    });

    const sessionsChangedCalls = broadcastToConnIds.mock.calls.filter(
      ([event]) => event === "sessions.changed",
    );
    expect(sessionsChangedCalls).toHaveLength(2);
    expectPayloadFields(sessionsChangedCalls[1]?.[1], {
      sessionKey: "session-finished",
      phase: "end",
      status: "done",
      startedAt: 900,
      endedAt: 1_700,
      runtimeMs: 800,
      updatedAt: 1_700,
      abortedLastRun: false,
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
    resetAgentRunContextForTest();
  });

  it("keeps aborted chat run markers through terminal lifecycle cleanup", () => {
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-aborted", {
      sessionKey: "session-aborted",
      clientRunId: "client-aborted",
    });
    chatRunState.abortedRuns.set("client-aborted", 1_000);

    handler({
      runId: "run-aborted",
      seq: 2,
      stream: "lifecycle",
      ts: 1_500,
      data: { phase: "end", aborted: true, stopReason: "rpc" },
    });

    expect(chatRunState.abortedRuns.has("client-aborted")).toBe(true);
    expect(chatRunState.registry.peek("run-aborted")).toBeUndefined();
    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
  });

  it("keeps live session setting metadata at the top level for lifecycle updates", () => {
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-finished",
      kind: "direct",
      updatedAt: 1_650,
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      fastMode: true,
      sendPolicy: "deny",
      verboseLevel: "on",
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

    handler({
      runId: "run-finished",
      seq: 2,
      stream: "lifecycle",
      ts: 1_800,
      data: {
        phase: "end",
        startedAt: 900,
        endedAt: 1_700,
      },
    });

    expect(requireMockArg(broadcastToConnIds, 0, 0, "sessions changed event")).toBe(
      "sessions.changed",
    );
    expectPayloadFields(requireMockArg(broadcastToConnIds, 0, 1, "sessions changed payload"), {
      sessionKey: "session-finished",
      phase: "end",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      fastMode: true,
      sendPolicy: "deny",
      verboseLevel: "on",
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

  it("keeps tool output for Control UI recipients when verbose is on", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

    handler({
      runId: "run-tool-on",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t3",
        result: { content: [{ type: "text", text: "secret" }] },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = requireMockArg(broadcastToConnIds, 0, 1, "tool output payload") as {
      data?: Record<string, unknown>;
    };
    expect(payload.data?.result).toEqual({ content: [{ type: "text", text: "secret" }] });
    expect(payload.data?.partialResult).toEqual({ content: [{ type: "text", text: "partial" }] });
    resetAgentRunContextForTest();
  });

  it("keeps tool output when verbose is full", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

    const result = { content: [{ type: "text", text: "secret" }] };
    handler({
      runId: "run-tool-full",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t4",
        result,
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = requireMockArg(broadcastToConnIds, 0, 1, "full tool output payload") as {
      data?: Record<string, unknown>;
    };
    expect(payload.data?.result).toEqual(result);
    resetAgentRunContextForTest();
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
    chatRunState.registry.add("run-fallback-internal", {
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });

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

  it("keeps chat-linked run remapping alive across per-attempt lifecycle errors", () => {
    vi.useFakeTimers();
    const { broadcast, chatRunState, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
      lifecycleErrorRetryGraceMs: 100,
    });
    chatRunState.registry.add("run-fallback-retry", {
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });

    handler({
      runId: "run-fallback-retry",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "draft" },
    });
    handler({
      runId: "run-fallback-retry",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "error", error: "provider failed" },
    });

    expect(chatRunState.registry.peek("run-fallback-retry")).toEqual({
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

    handler({
      runId: "run-terminal-error",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "partial" },
    });
    handler({
      runId: "run-terminal-error",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "error", error: "still broken" },
    });

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

  it("adds detected errorKind to chat lifecycle error payloads", () => {
    const { broadcast, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-detected-error",
      lifecycleErrorRetryGraceMs: 0,
    });
    registerAgentRunContext("run-detected-error", { sessionKey: "session-detected-error" });

    handler({
      runId: "run-detected-error",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: {
        phase: "error",
        error: Object.assign(new Error("Too many requests"), { code: 429 }),
      },
    });

    const payload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      errorKind?: string;
      errorMessage?: string;
    };
    expect(payload.state).toBe("error");
    expect(payload.errorKind).toBe("rate_limit");
    expect(payload.errorMessage).toContain("Too many requests");

    const nodePayload = sessionChatCalls(nodeSendToSession).at(-1)?.[2] as {
      errorKind?: string;
    };
    expect(nodePayload.errorKind).toBe("rate_limit");
  });

  it("suppresses delayed lifecycle chat errors for active chat.send runs while still cleaning up", () => {
    vi.useFakeTimers();
    const { broadcast, clearAgentRunContext, agentRunSeq, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-chat-send",
      lifecycleErrorRetryGraceMs: 100,
      isChatSendRunActive: (runId) => runId === "run-chat-send",
    });
    registerAgentRunContext("run-chat-send", { sessionKey: "session-chat-send" });

    handler({
      runId: "run-chat-send",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "partial" },
    });
    handler({
      runId: "run-chat-send",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "error", error: "chat.send failed" },
    });

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
    chatRunState.registry.add("run-chat-send", {
      sessionKey: "session-chat-send",
      clientRunId: "run-chat-send",
    });
    registerAgentRunContext("run-chat-send", { sessionKey: "session-chat-send" });

    handler({
      runId: "run-chat-send",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "error", error: "chat.send failed" },
    });

    vi.advanceTimersByTime(100);

    const chatErrors = chatBroadcastCalls(broadcast).filter(
      ([, payload]) => (payload as { state?: string }).state === "error",
    );
    expect(chatErrors).toHaveLength(1);
    expectPayloadFields(chatErrors[0]?.[1], {
      runId: "run-chat-send",
      sessionKey: "session-chat-send",
      state: "error",
      errorMessage: "chat.send failed",
    });
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

    handler({
      runId: "run-hidden",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Reply from quietchat" },
    });
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

  it("remaps chat-linked tool runId for non-full verbose payloads", () => {
    const { broadcastToConnIds, chatRunState, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-remap",
    });

    chatRunState.registry.add("run-tool-internal", {
      sessionKey: "session-tool-remap",
      clientRunId: "run-tool-client",
    });
    registerAgentRunContext("run-tool-internal", {
      sessionKey: "session-tool-remap",
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-tool-internal", "conn-1");

    handler({
      runId: "run-tool-internal",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "tool-remap-1",
        result: { content: [{ type: "text", text: "secret" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = requireMockArg(broadcastToConnIds, 0, 1, "remapped tool payload") as {
      runId?: string;
    };
    expect(payload.runId).toBe("run-tool-client");
    resetAgentRunContextForTest();
  });

  it("suppresses heartbeat ack-like chat output when showOk is false", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-heartbeat", {
      sessionKey: "session-heartbeat",
      clientRunId: "client-heartbeat",
    });
    registerAgentRunContext("run-heartbeat", {
      sessionKey: "session-heartbeat",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    handler({
      runId: "run-heartbeat",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "HEARTBEAT_OK Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      },
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
      agents: { defaults: { heartbeat: { ackMaxChars: 10 } } },
    });

    const { broadcast, chatRunState, handler } = createHarness({ now: 3_000 });
    chatRunState.registry.add("run-heartbeat-alert", {
      sessionKey: "session-heartbeat-alert",
      clientRunId: "client-heartbeat-alert",
    });
    registerAgentRunContext("run-heartbeat-alert", {
      sessionKey: "session-heartbeat-alert",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    handler({
      runId: "run-heartbeat-alert",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "HEARTBEAT_OK Disk usage crossed 95 percent on /data and needs cleanup now.",
      },
    });

    emitLifecycleEnd(handler, "run-heartbeat-alert");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe(
      "Disk usage crossed 95 percent on /data and needs cleanup now.",
    );
  });

  describe("spawnedBy enrichment in chat and agent broadcasts", () => {
    it("includes spawnedBy in chat delta broadcasts for subagent sessions", () => {
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key: "agent:coder:subagent:abc",
        kind: "direct",
        updatedAt: null,
        spawnedBy: "agent:conductor:task:parent-1",
      });

      const { broadcast, nodeSendToSession, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:abc",
      });

      chatRunState.registry.add("run-sub-1", {
        sessionKey: "agent:coder:subagent:abc",
        clientRunId: "client-sub-1",
      });

      handler({
        runId: "run-sub-1",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "hello from subagent" },
      });

      const chatCalls = chatBroadcastCalls(broadcast);
      expect(chatCalls.length).toBeGreaterThanOrEqual(1);
      const [, payload] = chatCalls[0];
      expectPayloadFields(payload, {
        sessionKey: "agent:coder:subagent:abc",
        spawnedBy: "agent:conductor:task:parent-1",
        state: "delta",
      });

      const nodeCalls = sessionChatCalls(nodeSendToSession);
      expect(nodeCalls.length).toBeGreaterThanOrEqual(1);
      expectPayloadFields(nodeCalls[0]?.[2], {
        spawnedBy: "agent:conductor:task:parent-1",
      });
    });

    it("includes spawnedBy in chat final broadcasts for subagent sessions", () => {
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key: "agent:coder:subagent:abc",
        kind: "direct",
        updatedAt: null,
        spawnedBy: "agent:conductor:task:parent-1",
      });

      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:abc",
      });

      chatRunState.registry.add("run-sub-final", {
        sessionKey: "agent:coder:subagent:abc",
        clientRunId: "client-sub-final",
      });

      handler({
        runId: "run-sub-final",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "done" },
      });

      handler({
        runId: "run-sub-final",
        seq: 2,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      });

      const chatCalls = chatBroadcastCalls(broadcast);
      const finalCall = requireCall(
        chatCalls.find(([, p]) => p.state === "final"),
        "final chat call",
      );
      expectPayloadFields(finalCall[1], {
        sessionKey: "agent:coder:subagent:abc",
        spawnedBy: "agent:conductor:task:parent-1",
        state: "final",
      });
    });

    it("omits spawnedBy from chat broadcasts for non-subagent sessions", () => {
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key: "agent:main:main",
        kind: "direct",
        updatedAt: null,
      });

      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:main:main",
      });

      chatRunState.registry.add("run-main", {
        sessionKey: "agent:main:main",
        clientRunId: "client-main",
      });

      handler({
        runId: "run-main",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "hello from main" },
      });

      const chatCalls = chatBroadcastCalls(broadcast);
      expect(chatCalls.length).toBeGreaterThanOrEqual(1);
      expect(chatCalls[0][1]).not.toHaveProperty("spawnedBy");
    });

    it("skips session row load entirely for session keys that cannot carry lineage", () => {
      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:main:main",
      });

      chatRunState.registry.add("run-no-lineage", {
        sessionKey: "agent:main:main",
        clientRunId: "client-no-lineage",
      });

      for (let seq = 1; seq <= 5; seq++) {
        handler({
          runId: "run-no-lineage",
          seq,
          stream: "assistant",
          ts: Date.now() + seq * 200,
          data: { text: `message ${seq}` },
        });
      }

      // The chat delta path invokes resolveSpawnedBy only. Non-subagent,
      // non-acp keys cannot carry spawnedBy (see supportsSpawnLineage in
      // sessions-patch.ts), so resolveSpawnedBy must short-circuit without
      // ever calling loadGatewaySessionRow on this hot path.
      expect(loadGatewaySessionRow).not.toHaveBeenCalled();

      const chatCalls = chatBroadcastCalls(broadcast);
      expect(chatCalls.length).toBeGreaterThanOrEqual(1);
      expect(chatCalls[0][1]).not.toHaveProperty("spawnedBy");
    });

    it("includes spawnedBy in non-tool agent event broadcasts for subagent sessions", () => {
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key: "agent:coder:subagent:xyz",
        kind: "direct",
        updatedAt: null,
        spawnedBy: "agent:conductor:task:parent-2",
      });

      const { broadcast, handler } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:xyz",
      });

      registerAgentRunContext("run-agent-sub", { sessionKey: "agent:coder:subagent:xyz" });

      handler({
        runId: "run-agent-sub",
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "start" },
      });

      const agentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
      expect(agentCalls.length).toBeGreaterThanOrEqual(1);
      expectPayloadFields(agentCalls[0]?.[1], {
        sessionKey: "agent:coder:subagent:xyz",
        spawnedBy: "agent:conductor:task:parent-2",
      });

      resetAgentRunContextForTest();
    });

    it("includes spawnedBy in chat error final broadcasts for subagent sessions", () => {
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key: "agent:coder:subagent:err",
        kind: "direct",
        updatedAt: null,
        spawnedBy: "agent:conductor:task:parent-err",
      });

      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:err",
        lifecycleErrorRetryGraceMs: 0,
      });

      chatRunState.registry.add("run-sub-err", {
        sessionKey: "agent:coder:subagent:err",
        clientRunId: "client-sub-err",
      });

      handler({
        runId: "run-sub-err",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "partial" },
      });

      handler({
        runId: "run-sub-err",
        seq: 2,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "error", error: "provider failed" },
      });

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

      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key: "agent:coder:subagent:flush",
        kind: "direct",
        updatedAt: null,
        spawnedBy: "agent:conductor:task:parent-flush",
      });

      const { broadcast, chatRunState, toolEventRecipients, handler } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:flush",
      });

      chatRunState.registry.add("run-sub-flush", {
        sessionKey: "agent:coder:subagent:flush",
        clientRunId: "client-sub-flush",
      });
      registerAgentRunContext("run-sub-flush", {
        sessionKey: "agent:coder:subagent:flush",
        verboseLevel: "off",
      });
      toolEventRecipients.add("run-sub-flush", "conn-flush");

      handler({
        runId: "run-sub-flush",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "before tool" },
      });

      now = 20_050;
      handler({
        runId: "run-sub-flush",
        seq: 2,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "before tool expanded" },
      });

      handler({
        runId: "run-sub-flush",
        seq: 3,
        stream: "tool",
        ts: Date.now(),
        data: { phase: "start", name: "exec", toolCallId: "tool-flush-sub" },
      });

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
      resetAgentRunContextForTest();
    });

    it("includes spawnedBy in seq gap error broadcasts for subagent sessions", () => {
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key: "agent:coder:subagent:gap",
        kind: "direct",
        updatedAt: null,
        spawnedBy: "agent:conductor:task:parent-gap",
      });

      const { broadcast, handler } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:gap",
      });

      registerAgentRunContext("run-sub-gap", { sessionKey: "agent:coder:subagent:gap" });

      handler({
        runId: "run-sub-gap",
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "start" },
      });

      handler({
        runId: "run-sub-gap",
        seq: 5,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "skipped seq" },
      });

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

      resetAgentRunContextForTest();
    });

    it("caches spawnedBy lookup so repeated events for the same subagent session only load the row once", () => {
      vi.mocked(loadGatewaySessionRow).mockClear();
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key: "agent:coder:subagent:cache-test",
        kind: "direct",
        updatedAt: null,
        spawnedBy: "agent:conductor:task:parent-cache",
      });

      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:cache-test",
      });

      chatRunState.registry.add("run-cache", {
        sessionKey: "agent:coder:subagent:cache-test",
        clientRunId: "client-cache",
      });

      // Fire multiple events for the same session
      handler({
        runId: "run-cache",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "chunk 1" },
      });
      handler({
        runId: "run-cache",
        seq: 2,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "chunk 2" },
      });
      handler({
        runId: "run-cache",
        seq: 3,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      });

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
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key: "agent:coder:subagent:no-lineage",
        kind: "direct",
        updatedAt: null,
        // no spawnedBy field
      });

      const { broadcast, handler, chatRunState } = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:no-lineage",
      });

      chatRunState.registry.add("run-null", {
        sessionKey: "agent:coder:subagent:no-lineage",
        clientRunId: "client-null",
      });

      handler({
        runId: "run-null",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "chunk 1" },
      });
      handler({
        runId: "run-null",
        seq: 2,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "chunk 2" },
      });

      // null result is cached — only one DB call despite two events
      expect(loadGatewaySessionRow).toHaveBeenCalledTimes(1);

      const chatCalls = chatBroadcastCalls(broadcast);
      for (const [, payload] of chatCalls) {
        expect(payload).not.toHaveProperty("spawnedBy");
      }
    });
  });
});
