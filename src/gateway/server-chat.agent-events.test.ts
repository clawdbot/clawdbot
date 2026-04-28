import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";

const persistGatewaySessionLifecycleEventMock = vi.fn();

vi.mock("./server-chat.persist-session-lifecycle.runtime.js", () => ({
  persistGatewaySessionLifecycleEvent: (...args: unknown[]) =>
    persistGatewaySessionLifecycleEventMock(...args),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
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

import { getRuntimeConfig } from "../config/io.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { loadGatewaySessionRow } from "./server-chat.load-gateway-session-row.runtime.js";

describe("agent event handler", () => {
  beforeEach(() => {
    vi.mocked(getRuntimeConfig).mockReturnValue({});
    vi.mocked(resolveHeartbeatVisibility).mockReturnValue({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
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
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.tool",
      expect.objectContaining({
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
        data: expect.objectContaining({
          phase: "start",
          name: "exec",
          toolCallId: "tool-session-1",
          args: { command: "echo hi" },
        }),
      }),
      new Set(["conn-session"]),
      { dropIfSlow: true },
    );
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
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
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
        data: expect.objectContaining({
          phase: "start",
          name: "exec",
          toolCallId: "tool-run-1",
          args: { command: "echo hi" },
        }),
      }),
      new Set(["conn-run"]),
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

    expect(nodeSendToSession).toHaveBeenCalledWith(
      "session-1",
      "agent",
      expect.objectContaining({
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
        data: expect.objectContaining({
          phase: "start",
          name: "exec",
          toolCallId: "tool-node-1",
          args: { command: "echo hi" },
        }),
      }),
    );
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
    expect(sessionsChangedCalls[1]?.[1]).toEqual(
      expect.objectContaining({
        sessionKey: "session-finished",
        phase: "end",
        status: "done",
        startedAt: 900,
        endedAt: 1_700,
        runtimeMs: 800,
        updatedAt: 1_700,
        abortedLastRun: false,
      }),
    );
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: "session-finished",
      event: expect.objectContaining({
        runId: "run-finished",
        data: expect.objectContaining({ phase: "end" }),
      }),
    });
    resetAgentRunContextForTest();
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

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
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
      }),
      new Set(["conn-session"]),
      { dropIfSlow: true },
    );
  });

  it("strips tool output when verbose is on", () => {
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
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toBeUndefined();
    expect(payload.data?.partialResult).toBeUndefined();
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
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
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
    expect(chatErrors[0]?.[1]).toMatchObject({
      runId: "run-chat-send",
      sessionKey: "session-chat-send",
      state: "error",
      errorMessage: "chat.send failed",
    });
    expect(chatRunState.registry.peek("run-chat-send")).toBeUndefined();
    expect(clearAgentRunContext).toHaveBeenCalledWith("run-chat-send");
    expect(agentRunSeq.has("run-chat-send")).toBe(false);
  });

  it("suppresses chat and node session events for non-control-UI-visible runs", () => {
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
    expect(nodeSendToSession).not.toHaveBeenCalled();
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
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { runId?: string };
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
});
