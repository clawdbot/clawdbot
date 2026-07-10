/**
 * Tests talk realtime relay event forwarding and connection cleanup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setActiveEmbeddedRun,
  testing as embeddedRunTesting,
} from "../agents/embedded-agent-runner/runs.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../talk/provider-types.js";
import {
  cancelTalkRealtimeRelayTurn,
  clearTalkRealtimeRelaySessionsForTest,
  createTalkRealtimeRelaySession,
  registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "./talk-realtime-relay.js";

describe("talk realtime gateway relay", () => {
  afterEach(() => {
    clearTalkRealtimeRelaySessionsForTest();
    vi.useRealTimers();
    embeddedRunTesting.resetActiveEmbeddedRuns();
  });

  function createIdleRelayProvider(): RealtimeVoiceProviderPlugin {
    return {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => ({
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      }),
    };
  }

  function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((accept) => {
      resolve = accept;
    });
    return { promise, resolve };
  }

  async function createSuppressionUnsupportedForcedConsultFixture(
    nativeCallIds: string[],
    options: {
      firstSubmission?: Promise<void>;
      supportsToolResultContinuation?: boolean;
    } = {},
  ) {
    vi.useFakeTimers();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const submitToolResult = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
    if (options.firstSubmission) {
      submitToolResult.mockReturnValueOnce(options.firstSubmission);
    }
    const sendUserMessage = vi.fn();
    const bridge = {
      supportsToolResultContinuation: options.supportsToolResultContinuation ?? false,
      supportsToolResultSuppression: false,
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage,
      handleBargeIn: vi.fn(),
      submitToolResult,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
          events.push({ event, payload, connIds: [...connIds] });
        },
      } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();
    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    await vi.advanceTimersByTimeAsync(250);
    const forcedToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.forced === true,
    );
    for (const callId of nativeCallIds) {
      bridgeRequest?.onToolCall?.({
        itemId: `item-${callId}`,
        callId,
        name: "openclaw_agent_consult",
        args: { question: "Can you check this?" },
      });
    }
    return {
      bridgeRequest,
      callId: String(forcedToolCall.callId),
      events,
      sendUserMessage,
      session,
      submitToolResult,
    };
  }

  it("rejects session creation when relay expiry would exceed Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    expect(() =>
      createTalkRealtimeRelaySession({
        context: {} as never,
        connId: "conn-1",
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
      }),
    ).toThrow("Realtime relay session expiry is outside the supported Date range");
  });

  function createAbortableRelayRunFixture(provider = createIdleRelayProvider()) {
    const abortController = new AbortController();
    const broadcastToConnIds = vi.fn();
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const removeChatRun = vi.fn(() => ({ sessionKey: "main", clientRunId: "run-1" }));
    const chatRunBuffers = new Map([["run-1", "partial answer"]]);
    const chatDeltaSentAt = new Map<string, number>();
    const chatDeltaLastBroadcastLen = new Map<string, number>();
    const chatDeltaLastBroadcastText = new Map<string, string>();
    const agentDeltaSentAt = new Map([["run-1:assistant", Date.now()]]);
    const bufferedAgentEvents = new Map([
      [
        "run-1:assistant",
        {
          payload: {
            runId: "run-1",
            seq: 1,
            stream: "assistant",
            ts: Date.now(),
            data: { text: "pending", delta: "pending" },
          },
        },
      ],
    ]);
    const context = {
      broadcastToConnIds,
      broadcast,
      nodeSendToSession,
      chatAbortControllers: new Map([
        [
          "run-1",
          {
            controller: abortController,
            sessionId: "run-1",
            sessionKey: "main",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      chatRunBuffers,
      chatDeltaSentAt,
      chatDeltaLastBroadcastLen,
      chatDeltaLastBroadcastText,
      agentDeltaSentAt,
      bufferedAgentEvents,
      chatAbortedRuns: new Map(),
      clearChatRunState: (runId: string) => {
        chatRunBuffers.delete(runId);
        chatDeltaSentAt.delete(runId);
        chatDeltaLastBroadcastLen.delete(runId);
        chatDeltaLastBroadcastText.delete(runId);
        for (const key of [runId, `${runId}:assistant`, `${runId}:thinking`]) {
          agentDeltaSentAt.delete(key);
          bufferedAgentEvents.delete(key);
        }
      },
      removeChatRun,
      agentRunSeq: new Map(),
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
      callId: "call-1",
    });
    return {
      abortController,
      broadcast,
      nodeSendToSession,
      removeChatRun,
      agentDeltaSentAt,
      bufferedAgentEvents,
      broadcastToConnIds,
      session,
    };
  }

  function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
    if (!record || typeof record !== "object") {
      throw new Error("Expected record");
    }
    const actual = record as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(actual[key]).toEqual(value);
    }
    return actual;
  }

  function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
    const call = mock.mock.calls[callIndex];
    if (!call) {
      throw new Error(`Expected mock call ${callIndex}`);
    }
    return call[argIndex];
  }

  function findEventPayload(
    events: Array<{ payload: unknown }>,
    predicate: (payload: Record<string, unknown>) => boolean,
  ) {
    const event = events.find((entry) => {
      const payload = entry.payload;
      return (
        typeof payload === "object" &&
        payload !== null &&
        predicate(payload as Record<string, unknown>)
      );
    });
    if (!event) {
      throw new Error("Expected matching relay event");
    }
    return event.payload as Record<string, unknown>;
  }

  function expectChatAbortPayload(mock: ReturnType<typeof vi.fn>, stopReason: string) {
    expect(mockCallArg(mock)).toBe("chat");
    expectRecordFields(mockCallArg(mock, 0, 1), {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      stopReason,
    });
  }

  function expectNodeAbortPayload(mock: ReturnType<typeof vi.fn>) {
    expect(mockCallArg(mock)).toBe("main");
    expect(mockCallArg(mock, 0, 1)).toBe("chat");
    expectRecordFields(mockCallArg(mock, 0, 2), { runId: "run-1", state: "aborted" });
  }

  it("bridges browser audio, transcripts, and tool results through a backend provider", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => {
        bridgeRequest?.onReady?.();
        bridgeRequest?.onAudio(Buffer.from("audio-out"));
        bridgeRequest?.onTranscript?.("user", "hello", true);
        bridgeRequest?.onTranscript?.("assistant", "hi there", true);
        bridgeRequest?.onToolCall?.({
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "hello" },
        });
      }),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{
      event: string;
      payload: unknown;
      connIds: string[];
      opts?: { dropIfSlow?: boolean };
    }> = [];
    const context = {
      broadcastToConnIds: (
        event: string,
        payload: unknown,
        connIds: ReadonlySet<string>,
        opts?: { dropIfSlow?: boolean },
      ) => {
        events.push({ event, payload, connIds: [...connIds], opts });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: { model: "provider-model" },
      instructions: "be brief",
      tools: [],
      model: "browser-model",
      voice: "voice-a",
    });
    await Promise.resolve();

    const sessionFields = expectRecordFields(session, {
      provider: "relay-test",
      transport: "gateway-relay",
      model: "browser-model",
      voice: "voice-a",
    });
    expectRecordFields(sessionFields.audio, {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    });
    expectRecordFields(bridgeRequest, {
      providerConfig: { model: "provider-model" },
      audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      instructions: "be brief",
      autoRespondToAudio: true,
      interruptResponseOnInputAudio: true,
    });

    const readyPayload = findEventPayload(events, (payload) => payload.type === "ready");
    expectRecordFields(readyPayload, {
      relaySessionId: session.relaySessionId,
      type: "ready",
    });
    expectRecordFields(readyPayload.talkEvent, {
      sessionId: session.relaySessionId,
      type: "session.ready",
      seq: 1,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "relay-test",
    });
    const readyEvent = events.find((entry) => entry.payload === readyPayload);
    expectRecordFields(readyEvent, { event: "talk.event", connIds: ["conn-1"] });
    expectRecordFields(readyEvent?.opts, { dropIfSlow: false });

    const audioPayload = findEventPayload(events, (payload) => payload.type === "audio");
    expectRecordFields(audioPayload, {
      relaySessionId: session.relaySessionId,
      type: "audio",
      audioBase64: Buffer.from("audio-out").toString("base64"),
    });
    expectRecordFields(audioPayload.talkEvent, { type: "output.audio.delta" });
    const audioEvent = events.find((entry) => entry.payload === audioPayload);
    expectRecordFields(audioEvent?.opts, { dropIfSlow: true });

    const userTranscript = findEventPayload(
      events,
      (payload) => payload.type === "transcript" && payload.role === "user",
    );
    expectRecordFields(userTranscript, {
      relaySessionId: session.relaySessionId,
      type: "transcript",
      role: "user",
      text: "hello",
      final: true,
    });
    expectRecordFields(userTranscript.talkEvent, { type: "transcript.done", final: true });

    const assistantTranscript = findEventPayload(
      events,
      (payload) => payload.type === "transcript" && payload.role === "assistant",
    );
    expectRecordFields(assistantTranscript, {
      relaySessionId: session.relaySessionId,
      type: "transcript",
      role: "assistant",
      text: "hi there",
      final: true,
    });
    expectRecordFields(assistantTranscript.talkEvent, {
      type: "output.text.done",
      final: true,
      payload: { text: "hi there" },
    });

    const toolCallPayload = findEventPayload(events, (payload) => payload.type === "toolCall");
    expectRecordFields(toolCallPayload, {
      relaySessionId: session.relaySessionId,
      type: "toolCall",
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "hello" },
    });
    expectRecordFields(toolCallPayload.talkEvent, {
      type: "tool.call",
      itemId: "item-1",
      callId: "call-1",
    });

    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
      timestamp: 123,
    });
    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { status: "working" },
      options: { willContinue: true },
    });
    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-2",
      result: { status: "already_delivered" },
      options: { suppressResponse: true },
    });
    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });

    expect(bridge.sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(bridge.sendUserMessage).not.toHaveBeenCalledWith("hello");
    expect(bridge.setMediaTimestamp).toHaveBeenCalledWith(123);
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      1,
      "call-1",
      {
        status: "working",
        tool: "openclaw_agent_consult",
        message:
          "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
      },
      { willContinue: true },
    );
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      2,
      "call-1",
      { status: "working" },
      { willContinue: true },
    );
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(3, "call-1", { ok: true }, undefined);
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      4,
      "call-2",
      { status: "already_delivered" },
      { suppressResponse: true },
    );
    expect(bridge.handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
    expect(bridge.close).toHaveBeenCalled();
    const inputAudioPayload = findEventPayload(
      events,
      (payload) =>
        payload.type === "inputAudio" && payload.byteLength === Buffer.from("audio-in").byteLength,
    );
    expectRecordFields(inputAudioPayload, {
      relaySessionId: session.relaySessionId,
      type: "inputAudio",
      byteLength: Buffer.from("audio-in").byteLength,
    });
    expectRecordFields(inputAudioPayload.talkEvent, { type: "input.audio.delta" });

    const clearPayload = findEventPayload(events, (payload) => payload.type === "clear");
    expectRecordFields(clearPayload, {
      relaySessionId: session.relaySessionId,
      type: "clear",
    });
    expectRecordFields(clearPayload.talkEvent, {
      type: "turn.cancelled",
      payload: { reason: "barge-in" },
      final: true,
    });

    const toolResultPayloads = events
      .map((entry) => entry.payload)
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolResult" &&
          (payload as Record<string, unknown>).callId === "call-1",
      );
    expect(toolResultPayloads).toHaveLength(3);
    expectRecordFields(toolResultPayloads[0], {
      relaySessionId: session.relaySessionId,
      type: "toolResult",
      callId: "call-1",
    });
    expectRecordFields(toolResultPayloads[0]?.talkEvent, {
      type: "tool.progress",
      callId: "call-1",
      payload: { name: "openclaw_agent_consult", status: "working" },
    });
    expectRecordFields(toolResultPayloads[1], {
      relaySessionId: session.relaySessionId,
      type: "toolResult",
      callId: "call-1",
    });
    expectRecordFields(toolResultPayloads[1]?.talkEvent, {
      type: "tool.result",
      callId: "call-1",
      final: false,
    });
    expectRecordFields(toolResultPayloads[2], {
      relaySessionId: session.relaySessionId,
      type: "toolResult",
      callId: "call-1",
    });
    expectRecordFields(toolResultPayloads[2]?.talkEvent, {
      type: "tool.result",
      callId: "call-1",
      final: true,
    });

    const closePayload = findEventPayload(events, (payload) => payload.type === "close");
    expectRecordFields(closePayload, {
      relaySessionId: session.relaySessionId,
      type: "close",
      reason: "completed",
    });
    expectRecordFields(closePayload.talkEvent, { type: "session.closed", final: true });
  });

  it("emits generic issue details when relay connect fails", async () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: () => ({
        connect: vi.fn(async () => {
          throw new Error("OpenAI API key rejected with 401");
        }),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => false),
      }),
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      model: "gpt-realtime-2",
    });
    await Promise.resolve();

    const errorPayload = findEventPayload(events, (payload) => payload.type === "error");
    expectRecordFields(errorPayload, {
      relaySessionId: session.relaySessionId,
      type: "error",
      message: "OpenAI API key rejected with 401",
      code: "realtime_unavailable",
      provider: "openai",
      model: "gpt-realtime-2",
      transport: "gateway-relay",
      phase: "connect",
    });
    expectRecordFields(errorPayload.talkEvent, {
      type: "session.error",
      final: true,
    });
    expectRecordFields((errorPayload.talkEvent as Record<string, unknown>).payload, {
      code: "realtime_unavailable",
      provider: "openai",
      model: "gpt-realtime-2",
      transport: "gateway-relay",
      phase: "connect",
    });
  });

  it("emits an issue when the provider closes before ready", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      model: "gpt-realtime-2",
    });

    bridgeRequest?.onClose?.("error");

    const errorPayload = findEventPayload(events, (payload) => payload.type === "error");
    expectRecordFields(errorPayload, {
      relaySessionId: session.relaySessionId,
      type: "error",
      code: "realtime_unavailable",
      provider: "openai",
      model: "gpt-realtime-2",
      transport: "gateway-relay",
      phase: "connect",
    });
    const closePayload = findEventPayload(events, (payload) => payload.type === "close");
    expectRecordFields(closePayload, {
      relaySessionId: session.relaySessionId,
      type: "close",
      reason: "error",
    });
  });

  it("does not replace provider errors with pre-ready close issues", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      model: "gpt-realtime-2",
    });

    bridgeRequest?.onError?.(new Error("OpenAI API key rejected with 401"));
    bridgeRequest?.onClose?.("error");

    const errorPayloads = events
      .map((entry) => entry.payload)
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "error",
      );
    expect(errorPayloads).toHaveLength(1);
    expectRecordFields(errorPayloads[0], {
      type: "error",
      code: "realtime_unavailable",
      provider: "openai",
      model: "gpt-realtime-2",
      transport: "gateway-relay",
      phase: "connect",
    });
  });

  it("does not route assistant echo transcripts back into the realtime model", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    bridgeRequest?.onTranscript?.(
      "assistant",
      "I am checking the latest status for you now.",
      true,
    );
    bridgeRequest?.onTranscript?.("user", "checking the latest status for you now", true);

    expect(bridge.sendUserMessage).not.toHaveBeenCalled();
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall"
        );
      }),
    ).toBe(false);
  });

  it("leaves provider-direct audio replies to server VAD unless forced consult routing is configured", async () => {
    vi.useFakeTimers();

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
    });
    await Promise.resolve();

    bridgeRequest?.onTranscript?.("user", "Can you answer directly?", true);
    expect(bridge.sendUserMessage).not.toHaveBeenCalled();
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).forced === true
        );
      }),
    ).toBe(false);

    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });
  });

  it("forces an agent consult when configured and realtime transcript finalizes without a provider tool call", async () => {
    vi.useFakeTimers();

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();

    expectRecordFields(bridgeRequest, { autoRespondToAudio: false });

    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    expect(bridge.sendUserMessage).not.toHaveBeenCalledWith("Can you check this?");

    await vi.advanceTimersByTimeAsync(250);

    const forcedToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.forced === true,
    );
    expectRecordFields(forcedToolCall, {
      relaySessionId: session.relaySessionId,
      type: "toolCall",
      name: "openclaw_agent_consult",
      forced: true,
    });
    expectRecordFields(forcedToolCall.args, {
      question: "Can you check this?",
      responseStyle: "Reply in a concise spoken tone.",
    });
    expectRecordFields(forcedToolCall.talkEvent, { type: "tool.call" });
    expectRecordFields((forcedToolCall.talkEvent as Record<string, unknown>).payload, {
      forced: true,
    });
    expect(bridge.handleBargeIn).toHaveBeenCalledWith({
      audioPlaybackActive: true,
      force: true,
    });

    const callId = String(forcedToolCall.callId);
    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId,
      result: { status: "working" },
      options: { willContinue: true },
    });
    expect(bridge.sendUserMessage).toHaveBeenLastCalledWith(
      "Briefly tell the person that you are checking with OpenClaw. Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer.",
    );

    bridgeRequest?.onToolCall?.({
      itemId: "native-item",
      callId: "native-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-call",
      {
        status: "working",
        tool: "openclaw_agent_consult",
        message:
          "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
      },
      { willContinue: true },
    );

    const forcedAcceptance = createDeferredVoid();
    bridge.submitToolResult.mockImplementationOnce(() => forcedAcceptance.promise);
    const forcedSubmission = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId,
      result: { result: "Here is the checked answer." },
    });
    expect(bridge.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Here is the checked answer."),
    );
    forcedAcceptance.resolve();
    await forcedSubmission;
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-call",
      {
        status: "already_delivered",
        message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
      },
      { suppressResponse: true },
    );
    expect(bridge.sendUserMessage).toHaveBeenLastCalledWith(
      [
        "OpenClaw finished checking. Speak this result naturally and concisely.",
        "Do not mention tool calls, JSON, or internal routing.",
        "",
        "Here is the checked answer.",
      ].join("\n"),
    );
    expect(
      bridge.submitToolResult.mock.invocationCallOrder[
        bridge.submitToolResult.mock.invocationCallOrder.length - 1
      ],
    ).toBeLessThan(
      bridge.sendUserMessage.mock.invocationCallOrder[
        bridge.sendUserMessage.mock.invocationCallOrder.length - 1
      ] ?? 0,
    );
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).callId === "native-call"
        );
      }),
    ).toBe(false);

    bridgeRequest?.onToolCall?.({
      itemId: "native-other-item",
      callId: "native-other-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check something else?" },
    });
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-other-call",
      {
        status: "working",
        tool: "openclaw_agent_consult",
        message:
          "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
      },
      { willContinue: true },
    );
    const nativeOtherToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.callId === "native-other-call",
    );
    expectRecordFields(nativeOtherToolCall, {
      relaySessionId: session.relaySessionId,
      type: "toolCall",
      callId: "native-other-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check something else?" },
    });
    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });
  });

  it("uses the actual forced result when one native call cannot suppress responses", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"]);
    const accepted = createDeferredVoid();
    fixture.submitToolResult.mockReturnValueOnce(accepted.promise);

    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });
    const duplicate = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "duplicate" },
    });
    expect(duplicate).toBe(submission);
    expect(fixture.submitToolResult).toHaveBeenCalledTimes(1);
    expect(fixture.submitToolResult).toHaveBeenCalledWith(
      "native-call",
      { result: "checked" },
      undefined,
    );
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();

    accepted.resolve();
    await submission;
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    expect(
      fixture.events.filter(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      ),
    ).toHaveLength(1);
  });

  it("classifies forced interim and terminal results only from willContinue", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"]);

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { phase: "checking" },
      options: { willContinue: true },
    });
    expect(fixture.submitToolResult).not.toHaveBeenCalled();

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { status: "working" },
    });
    expect(fixture.submitToolResult).toHaveBeenCalledWith(
      "native-call",
      { status: "working" },
      undefined,
    );
    const finalStates = fixture.events
      .filter(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      )
      .map((entry) => (entry.payload as { talkEvent?: { final?: boolean } }).talkEvent?.final);
    expect(finalStates).toEqual([false, true]);
  });

  it("waits for every native forced result when response suppression is unsupported", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture([
      "native-1",
      "native-2",
    ]);
    const first = createDeferredVoid();
    const second = createDeferredVoid();
    fixture.submitToolResult.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });

    first.resolve();
    await Promise.resolve();
    expect(
      fixture.events.some(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      ),
    ).toBe(false);
    second.resolve();
    await submission;
    expect(fixture.submitToolResult).toHaveBeenCalledTimes(2);
  });

  it("drains native calls that join while a forced terminal result is pending", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-1"]);
    const first = createDeferredVoid();
    fixture.submitToolResult.mockReturnValueOnce(first.promise).mockReturnValueOnce(undefined);
    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });

    fixture.bridgeRequest?.onToolCall?.({
      itemId: "late-item",
      callId: "native-2",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual(["native-1"]);

    first.resolve();
    await submission;
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "native-1",
      "native-2",
    ]);
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    expect(
      fixture.events.filter(
        (entry) =>
          (entry.payload as { type?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === "native-2",
      ),
    ).toHaveLength(0);
  });

  it("keeps a suppression-unsupported forced result retryable after rejection", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"]);
    fixture.submitToolResult.mockRejectedValueOnce(new Error("native result rejected"));
    const rejected = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "checked" },
    });
    await expect(rejected).rejects.toThrow("native result rejected");
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "checked" },
    });
    expect(fixture.submitToolResult).toHaveBeenCalledTimes(2);
  });

  it("retries only rejected native forced results after partial acceptance", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture([
      "native-1",
      "native-2",
    ]);
    fixture.submitToolResult
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second native rejected"));
    const firstAttempt = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "checked" },
    });
    await expect(firstAttempt).rejects.toThrow("second native rejected");

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "checked" },
    });
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "native-1",
      "native-2",
      "native-2",
    ]);
  });

  it("uses the speech path without native calls even when suppression is unsupported", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture([]);
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });

    expect(fixture.submitToolResult).not.toHaveBeenCalled();
    expect(fixture.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("checked"));
  });

  it("satisfies late native forced calls without suppression or duplicate speech", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture([]);
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { result: "checked" },
    });
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);

    fixture.bridgeRequest?.onToolCall?.({
      itemId: "late-item",
      callId: "late-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    expect(fixture.submitToolResult).toHaveBeenCalledWith(
      "late-call",
      {
        status: "already_delivered",
        message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
      },
      undefined,
    );
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects direct suppressed results when the provider does not support them", () => {
    const submitToolResult = vi.fn();
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult,
      supportsToolResultSuppression: false,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    expect(() =>
      submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { ok: true },
        options: { suppressResponse: true },
      }),
    ).toThrow("Realtime provider does not support suppressed tool results");
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("does not force a duplicate consult after native consult or cancellation", async () => {
    vi.useFakeTimers();

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const nativeSession = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();
    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    bridgeRequest?.onToolCall?.({
      itemId: "native-item",
      callId: "native-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this for me?" },
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).forced === true
        );
      }),
    ).toBe(false);
    stopTalkRealtimeRelaySession({
      relaySessionId: nativeSession.relaySessionId,
      connId: "conn-1",
    });

    const unicodeSession = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();
    bridgeRequest?.onTranscript?.("user", "проверь статус", true);
    bridgeRequest?.onToolCall?.({
      itemId: "unicode-native-item",
      callId: "unicode-native-call",
      name: "openclaw_agent_consult",
      args: { question: "проверь статус" },
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).forced === true
        );
      }),
    ).toBe(false);
    stopTalkRealtimeRelaySession({
      relaySessionId: unicodeSession.relaySessionId,
      connId: "conn-1",
    });

    const cancelledSession = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();
    bridgeRequest?.onTranscript?.("user", "Cancel this consult", true);
    cancelTalkRealtimeRelayTurn({
      relaySessionId: cancelledSession.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(
      events.some((entry) => {
        const payload = entry.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === "toolCall" &&
          (payload as Record<string, unknown>).forced === true
        );
      }),
    ).toBe(false);
    stopTalkRealtimeRelaySession({
      relaySessionId: cancelledSession.relaySessionId,
      connId: "conn-1",
    });
  });

  it("rejects relay control from a different connection", () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => ({
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      }),
    };
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-2",
        audioBase64: Buffer.from("audio").toString("base64"),
      }),
    ).toThrow("Unknown realtime relay session");
  });

  it("correlates output audio with the active relay turn", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const events: Array<{
      event: string;
      payload: { talkEvent?: { type?: string; turnId?: string } };
    }> = [];
    const context = {
      broadcastToConnIds: (
        event: string,
        payload: { talkEvent?: { type?: string; turnId?: string } },
      ) => {
        events.push({ event, payload });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio").toString("base64"),
    });
    bridgeRequest?.onAudio(Buffer.from("reply"));

    expect(
      events.some(
        (entry) =>
          entry.payload.talkEvent?.type === "output.audio.delta" &&
          entry.payload.talkEvent.turnId === "turn-1",
      ),
    ).toBe(true);
  });

  it("aborts linked agent consult runs when the relay turn is cancelled", () => {
    const {
      abortController,
      broadcast,
      nodeSendToSession,
      removeChatRun,
      agentDeltaSentAt,
      bufferedAgentEvents,
      session,
    } = createAbortableRelayRunFixture();
    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(removeChatRun).toHaveBeenCalledWith("run-1", "run-1", "main");
    expect(agentDeltaSentAt.has("run-1:assistant")).toBe(false);
    expect(bufferedAgentEvents.has("run-1:assistant")).toBe(false);
    expectChatAbortPayload(broadcast, "barge-in");
    expectNodeAbortPayload(nodeSendToSession);
  });

  it("terminally satisfies a late normal result after turn cancellation without a new turn", async () => {
    const submitToolResult = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    const startedTurns = () =>
      broadcastToConnIds.mock.calls.filter(
        (call) => (call[1] as { talkEvent?: { type?: string } }).talkEvent?.type === "turn.started",
      ).length;
    const beforeLateResult = startedTurns();

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { error: "aborted" },
    });

    expect(startedTurns()).toBe(beforeLateResult);
    expect(submitToolResult).toHaveBeenCalledWith(
      "call-1",
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
      { suppressResponse: true },
    );
    expect(
      broadcastToConnIds.mock.calls.filter(
        (call) =>
          (call[1] as { type?: string; callId?: string }).type === "toolResult" &&
          (call[1] as { callId?: string }).callId === "call-1",
      ),
    ).toHaveLength(0);
  });

  it("clears linked agent consult runs after the final tool result", () => {
    const { abortController, broadcast, session } = createAbortableRelayRunFixture();

    void submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });

    expect(abortController.signal.aborted).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted" }),
    );
  });

  it("serializes a final consult result behind async working acceptance", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const working = createDeferredVoid();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(working.promise)
      .mockReturnValueOnce(undefined);
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return {
          supportsToolResultContinuation: true,
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult,
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const events: Array<{ payload: Record<string, unknown> }> = [];
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: (_event: string, payload: unknown) => {
          events.push({ payload: payload as Record<string, unknown> });
        },
      } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    bridgeRequest?.onToolCall?.({
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: { question: "check" },
    });
    const finalSubmission = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "done" },
    });

    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(
      events.map((entry) => (entry.payload.talkEvent as { type?: string } | undefined)?.type),
    ).toContain("tool.call");
    expect(
      events.map((entry) => (entry.payload.talkEvent as { type?: string } | undefined)?.type),
    ).not.toContain("tool.progress");

    working.resolve();
    await finalSubmission;
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ status: "working" }),
      { answer: "done" },
    ]);
    const talkTypes = events
      .map((entry) => (entry.payload.talkEvent as { type?: string } | undefined)?.type)
      .filter(Boolean);
    expect(talkTypes.indexOf("tool.call")).toBeLessThan(talkTypes.indexOf("tool.progress"));
    expect(talkTypes.indexOf("tool.progress")).toBeLessThan(talkTypes.indexOf("tool.result"));
  });

  it("serializes concurrent client interims and a final result in submission order", async () => {
    const firstAccepted = createDeferredVoid();
    const secondAccepted = createDeferredVoid();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(firstAccepted.promise)
      .mockReturnValueOnce(secondAccepted.promise)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    const firstInterim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "first" },
      options: { willContinue: true },
    });
    const secondInterim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "second" },
      options: { willContinue: true },
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "done" },
    });
    expect(submitToolResult).toHaveBeenCalledTimes(1);

    firstAccepted.resolve();
    await vi.waitFor(() => expect(submitToolResult).toHaveBeenCalledTimes(2));
    expect(submitToolResult).not.toHaveBeenCalledWith("call-1", { answer: "done" }, undefined);

    secondAccepted.resolve();
    await Promise.all([firstInterim, secondInterim, final]);
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { phase: "first" },
      { phase: "second" },
      { answer: "done" },
    ]);
  });

  it("submits an ordinary final after an interim rejection", async () => {
    let rejectInterim: ((error: Error) => void) | undefined;
    const rejectedInterim = new Promise<void>((_resolve, reject) => {
      rejectInterim = reject;
    });
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(rejectedInterim)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    const interim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "checking" },
      options: { willContinue: true },
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "done" },
    });

    rejectInterim?.(new Error("interim rejected"));
    await expect(interim).rejects.toThrow("interim rejected");
    await final;
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { phase: "checking" },
      { answer: "done" },
    ]);
  });

  it("supersedes queued interims and a stale final with canonical cancellation", async () => {
    const interimAccepted = createDeferredVoid();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(interimAccepted.promise)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
    const firstInterim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "first" },
      options: { willContinue: true },
    });
    const secondInterim = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { phase: "second" },
      options: { willContinue: true },
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "stale" },
    });
    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    const cancellation = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { error: "aborted" },
    });

    interimAccepted.resolve();
    await Promise.all([firstInterim, secondInterim, final, cancellation]);
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { phase: "first" },
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
    expect(submitToolResult.mock.calls[1]?.[2]).toEqual({ suppressResponse: true });
    expect(
      broadcastToConnIds.mock.calls.some(
        (call) =>
          (call[1] as { type?: string; callId?: string }).type === "toolResult" &&
          (call[1] as { callId?: string }).callId === "call-1",
      ),
    ).toBe(false);
  });

  it("terminally cancels a final queued behind working acceptance without a second client result", async () => {
    const workingAccepted = createDeferredVoid();
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(workingAccepted.promise)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult,
      supportsToolResultSuppression: false,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
    const working = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { status: "working" },
      options: { willContinue: true },
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "stale" },
    });

    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    workingAccepted.resolve();
    await Promise.all([working, final]);

    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { status: "working" },
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
    expect(submitToolResult.mock.calls[1]?.[2]).toBeUndefined();
    expect(
      broadcastToConnIds.mock.calls.some(
        (call) =>
          (call[1] as { type?: string; callId?: string }).type === "toolResult" &&
          (call[1] as { callId?: string }).callId === "call-1",
      ),
    ).toBe(false);

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { error: "late abort" },
    });
    expect(submitToolResult).toHaveBeenCalledTimes(2);
  });

  it("supersedes a rejected in-flight final with canonical cancellation", async () => {
    let rejectFinal: ((error: Error) => void) | undefined;
    const rejectedFinal = new Promise<void>((_resolve, reject) => {
      rejectFinal = reject;
    });
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockReturnValueOnce(rejectedFinal)
      .mockReturnValueOnce(undefined);
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const { session } = createAbortableRelayRunFixture(provider);
    const staleFinal = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { answer: "stale" },
    });
    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    const cancellation = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { error: "aborted" },
    });

    rejectFinal?.(new Error("stale final rejected"));
    await expect(staleFinal).rejects.toThrow("stale final rejected");
    await cancellation;
    expect(submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { answer: "stale" },
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
  });

  it("waits for provider acceptance before broadcasting and clearing a final tool result", async () => {
    const deferred = createDeferredVoid();
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(() => deferred.promise),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const { abortController, broadcast, broadcastToConnIds, session } =
      createAbortableRelayRunFixture(provider);

    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    if (!submission) {
      throw new Error("Expected asynchronous provider submission");
    }
    const duplicate = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: "duplicate" },
    });
    const followUp = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { status: "working" },
      options: { willContinue: true },
    });

    expect(duplicate).toBe(submission);
    expect(followUp).toBe(submission);
    expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
    expect(
      broadcastToConnIds.mock.calls.some(
        (call) => (call[1] as { type?: string }).type === "toolResult",
      ),
    ).toBe(false);

    deferred.resolve();
    await submission;

    const toolResultEvents = () =>
      broadcastToConnIds.mock.calls.filter(
        (call) => (call[1] as { type?: string }).type === "toolResult",
      );
    expect(toolResultEvents()).toHaveLength(1);
    expect(
      submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { ok: "already completed" },
      }),
    ).toBeUndefined();
    expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
    expect(toolResultEvents()).toHaveLength(1);
    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    expect(abortController.signal.aborted).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted" }),
    );
  });

  it("keeps linked run state and omits success events when provider submission rejects", async () => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(() => Promise.reject(new Error("provider rejected tool result"))),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const { abortController, broadcastToConnIds, session } =
      createAbortableRelayRunFixture(provider);

    const submission = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    if (!submission) {
      throw new Error("Expected asynchronous provider submission");
    }
    await expect(submission).rejects.toThrow("provider rejected tool result");
    expect(
      broadcastToConnIds.mock.calls.some(
        (call) => (call[1] as { type?: string }).type === "toolResult",
      ),
    ).toBe(false);

    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    expect(abortController.signal.aborted).toBe(true);
  });

  it("allows a final tool result to retry after provider rejection", async () => {
    let attempt = 0;
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(() => {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error("temporary rejection")) : undefined;
      }),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);

    const rejected = submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: false },
    });
    await expect(rejected).rejects.toThrow("temporary rejection");

    expect(
      submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { ok: true },
      }),
    ).toBeUndefined();
    expect(bridge.submitToolResult).toHaveBeenCalledTimes(2);
    expect(
      broadcastToConnIds.mock.calls.filter(
        (call) => (call[1] as { type?: string }).type === "toolResult",
      ),
    ).toHaveLength(1);
  });

  it("returns structured relay steering status and emits Talk progress", async () => {
    const provider = createIdleRelayProvider();
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      sessionKey: "agent:main:main",
    });

    await expect(
      steerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        sessionKey: "agent:other:main",
        text: "status",
        mode: "status",
      }),
    ).rejects.toThrow("Realtime relay steering session key does not match the relay session");

    const result = await steerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "agent:main:main",
      text: "status",
      mode: "status",
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "status",
      sessionKey: "agent:main:main",
      active: false,
    });
    const progressPayload = findEventPayload(events, (payload) => payload.type === "toolProgress");
    expectRecordFields(progressPayload, {
      relaySessionId: session.relaySessionId,
      type: "toolProgress",
    });
    expectRecordFields(progressPayload.talkEvent, {
      type: "tool.progress",
      final: true,
    });
  });

  it.each([
    {
      supportsSuppression: undefined,
      expectedOptions: { suppressResponse: true },
      expectedSuppress: false,
    },
    { supportsSuppression: false, expectedOptions: undefined, expectedSuppress: true },
  ])(
    "submits a final provider result when voice cancel aborts an active relay run ($supportsSuppression)",
    async ({ supportsSuppression, expectedOptions, expectedSuppress }) => {
      const abortEmbeddedRun = vi.fn();
      setActiveEmbeddedRun(
        "embedded-session-1",
        {
          queueMessage: vi.fn(async () => undefined),
          isStreaming: () => true,
          isCompacting: () => false,
          abort: abortEmbeddedRun,
        },
        "main",
      );
      const bridge = {
        supportsToolResultSuppression: supportsSuppression,
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      };
      const provider: RealtimeVoiceProviderPlugin = {
        id: "relay-test",
        label: "Relay Test",
        isConfigured: () => true,
        createBridge: () => bridge,
      };
      const { abortController, broadcast, session } = createAbortableRelayRunFixture(provider);

      const result = await steerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        text: "cancel that",
        mode: "cancel",
      });
      cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        reason: "barge-in",
      });

      expect(result).toMatchObject({
        ok: true,
        mode: "cancel",
        suppress: expectedSuppress,
        providerResult: {
          status: "cancelled",
          message: "Cancelled the active OpenClaw run.",
        },
      });
      expect(abortEmbeddedRun).toHaveBeenCalledTimes(1);
      expect(bridge.submitToolResult).toHaveBeenCalledWith(
        "call-1",
        {
          status: "cancelled",
          message: "Cancelled the active OpenClaw run.",
        },
        expectedOptions,
      );
      expect(abortController.signal.aborted).toBe(false);
      expect(broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId: "run-1", state: "aborted" }),
      );

      void submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { error: "aborted" },
      });
      expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
    },
  );

  it("finalizes accepted cancel calls independently when another provider result rejects", async () => {
    setActiveEmbeddedRun(
      "embedded-session-1",
      {
        queueMessage: vi.fn(async () => undefined),
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      },
      "main",
    );
    const submitToolResult = vi
      .fn<RealtimeVoiceBridge["submitToolResult"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second cancel rejected"));
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
      callId: "call-2",
    });

    await expect(
      steerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        text: "cancel that",
        mode: "cancel",
      }),
    ).rejects.toThrow("second cancel rejected");

    expect(
      broadcastToConnIds.mock.calls.filter(
        (call) =>
          (call[1] as { type?: string; callId?: string }).type === "toolResult" &&
          (call[1] as { callId?: string }).callId === "call-1",
      ),
    ).toHaveLength(1);
    expect(
      submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        callId: "call-1",
        result: { late: true },
      }),
    ).toBeUndefined();
    expect(submitToolResult).toHaveBeenCalledTimes(2);

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-2",
      result: { retry: true },
    });
    expect(submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "call-1",
      "call-2",
      "call-2",
    ]);
  });

  it("does not broadcast steering progress after the relay closes during provider acceptance", async () => {
    setActiveEmbeddedRun(
      "embedded-session-1",
      {
        queueMessage: vi.fn(async () => undefined),
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      },
      "main",
    );
    const accepted = createDeferredVoid();
    const submitToolResult = vi.fn(() => accepted.promise);
    const provider = createIdleRelayProvider();
    provider.createBridge = () => ({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult,
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    const { broadcastToConnIds, session } = createAbortableRelayRunFixture(provider);

    const steering = steerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      text: "cancel that",
      mode: "cancel",
    });
    await vi.waitFor(() => expect(submitToolResult).toHaveBeenCalledTimes(1));
    stopTalkRealtimeRelaySession({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
    });
    accepted.resolve();
    await steering;

    expect(
      broadcastToConnIds.mock.calls.filter(
        (call) => (call[1] as { type?: string }).type === "toolProgress",
      ),
    ).toHaveLength(0);
  });

  it("does not submit cancel results for synthetic forced-consult calls", async () => {
    vi.useFakeTimers();

    const abortEmbeddedRun = vi.fn();
    setActiveEmbeddedRun(
      "embedded-session-1",
      {
        queueMessage: vi.fn(async () => undefined),
        isStreaming: () => true,
        isCompacting: () => false,
        abort: abortEmbeddedRun,
      },
      "main",
    );

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();

    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    await vi.advanceTimersByTimeAsync(250);
    const forcedToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.forced === true,
    );
    const callId = String(forcedToolCall.callId);
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
      callId,
    });

    const result = await steerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      text: "cancel that",
      mode: "cancel",
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "cancel",
      providerResult: {
        status: "cancelled",
        message: "Cancelled the active OpenClaw run.",
      },
    });
    expect(abortEmbeddedRun).toHaveBeenCalledTimes(1);
    expect(bridge.submitToolResult).not.toHaveBeenCalled();
    const toolResult = findEventPayload(
      events,
      (payload) => payload.type === "toolResult" && payload.callId === callId,
    );
    expectRecordFields(toolResult, {
      relaySessionId: session.relaySessionId,
      type: "toolResult",
      callId,
    });
  });

  it("terminally cancels late forced working even when willContinue is set", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-1"]);
    cancelTalkRealtimeRelayTurn({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    const startedTurns = () =>
      fixture.events.filter(
        (entry) =>
          (entry.payload as { talkEvent?: { type?: string } }).talkEvent?.type === "turn.started",
      ).length;
    const beforeLateCalls = startedTurns();

    fixture.bridgeRequest?.onToolCall?.({
      itemId: "late-native-item",
      callId: "native-2",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { status: "working" },
      options: { willContinue: true },
    });

    expect(startedTurns()).toBe(beforeLateCalls);
    expect(fixture.submitToolResult.mock.calls.map((call) => call[0])).toEqual([
      "native-2",
      "native-1",
    ]);
    for (const call of fixture.submitToolResult.mock.calls) {
      expect(call[1]).toEqual({
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      });
      expect(call[2]).toBeUndefined();
    }
    expect(
      fixture.events.filter(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolCall" &&
          (entry.payload as { callId?: string }).callId === "native-2",
      ),
    ).toHaveLength(0);
    const terminal = findEventPayload(
      fixture.events,
      (payload) =>
        payload.type === "toolResult" &&
        payload.callId === fixture.callId &&
        (payload.talkEvent as { final?: boolean } | undefined)?.final === true,
    );
    expectRecordFields((terminal.talkEvent as Record<string, unknown>).payload, {
      result: {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
      forced: true,
    });
  });

  it("terminally cancels a forced final queued behind native working acceptance", async () => {
    const workingAccepted = createDeferredVoid();
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"], {
      firstSubmission: workingAccepted.promise,
      supportsToolResultContinuation: true,
    });
    const final = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "stale" },
    });

    cancelTalkRealtimeRelayTurn({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    workingAccepted.resolve();
    await final;

    expect(fixture.submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ status: "working" }),
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
    expect(fixture.submitToolResult.mock.calls[1]?.[2]).toBeUndefined();
    expect(
      fixture.events.some(
        (entry) =>
          (entry.payload as { type?: string; callId?: string }).type === "toolResult" &&
          (entry.payload as { callId?: string }).callId === fixture.callId,
      ),
    ).toBe(false);
  });

  it("supersedes a rejected forced final with canonical cancellation", async () => {
    const fixture = await createSuppressionUnsupportedForcedConsultFixture(["native-call"]);
    let rejectFinal: ((error: Error) => void) | undefined;
    const rejectedFinal = new Promise<void>((_resolve, reject) => {
      rejectFinal = reject;
    });
    fixture.submitToolResult.mockReturnValueOnce(rejectedFinal).mockReturnValueOnce(undefined);
    const staleFinal = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { answer: "stale" },
    });
    cancelTalkRealtimeRelayTurn({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    const cancellation = submitTalkRealtimeRelayToolResult({
      relaySessionId: fixture.session.relaySessionId,
      connId: "conn-1",
      callId: fixture.callId,
      result: { status: "working" },
      options: { willContinue: true },
    });

    rejectFinal?.(new Error("forced final rejected"));
    await expect(staleFinal).rejects.toThrow("forced final rejected");
    await cancellation;
    expect(fixture.submitToolResult.mock.calls.map((call) => call[1])).toEqual([
      { answer: "stale" },
      {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      },
    ]);
  });

  it("keeps a forced consult deliverable when async provider cancellation rejects", async () => {
    vi.useFakeTimers();
    setActiveEmbeddedRun(
      "embedded-session-1",
      {
        queueMessage: vi.fn(async () => undefined),
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      },
      "main",
    );

    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    let rejectNextSubmission = false;
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(() => {
        if (!rejectNextSubmission) {
          return undefined;
        }
        rejectNextSubmission = false;
        return Promise.reject(new Error("provider cancellation rejected"));
      }),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
          events.push({ event, payload, connIds: [...connIds] });
        },
      } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "be brief",
      tools: [],
      forceAgentConsultOnFinalTranscript: true,
    });
    await Promise.resolve();

    bridgeRequest?.onTranscript?.("user", "Can you check this?", true);
    await vi.advanceTimersByTimeAsync(250);
    const forcedToolCall = findEventPayload(
      events,
      (payload) => payload.type === "toolCall" && payload.forced === true,
    );
    const callId = String(forcedToolCall.callId);
    bridgeRequest?.onToolCall?.({
      itemId: "native-item",
      callId: "native-call",
      name: "openclaw_agent_consult",
      args: { question: "Can you check this?" },
    });
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
      callId,
    });

    rejectNextSubmission = true;
    await expect(
      steerTalkRealtimeRelayAgentRun({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        text: "cancel that",
        mode: "cancel",
      }),
    ).rejects.toThrow("provider cancellation rejected");

    await submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId,
      result: { result: "Here is the checked answer." },
    });
    expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
      "native-call",
      {
        status: "already_delivered",
        message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
      },
      { suppressResponse: true },
    );
    expect(bridge.sendUserMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Here is the checked answer."),
    );
  });

  it("does not duplicate control-like transcripts when the linked relay run is already gone", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const context = {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "stale-run",
      callId: "call-1",
    });

    bridgeRequest?.onTranscript?.("user", "status", true);

    expect(bridge.sendUserMessage).not.toHaveBeenCalled();
    expect(bridge.submitToolResult).not.toHaveBeenCalled();
  });

  it("aborts linked agent consult runs when the relay session closes", () => {
    const {
      abortController,
      broadcast,
      nodeSendToSession,
      agentDeltaSentAt,
      bufferedAgentEvents,
      session,
    } = createAbortableRelayRunFixture();
    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });

    expect(abortController.signal.aborted).toBe(true);
    expect(agentDeltaSentAt.has("run-1:assistant")).toBe(false);
    expect(bufferedAgentEvents.has("run-1:assistant")).toBe(false);
    expectChatAbortPayload(broadcast, "relay-closed");
    expectNodeAbortPayload(nodeSendToSession);
  });

  it("aborts linked agent consult runs when the provider closes the relay", () => {
    const abortController = new AbortController();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const removeChatRun = vi.fn(() => ({ sessionKey: "main", clientRunId: "run-1" }));
    const chatRunBuffers = new Map([["run-1", "partial answer"]]);
    const chatDeltaSentAt = new Map<string, number>();
    const chatDeltaLastBroadcastLen = new Map<string, number>();
    const chatDeltaLastBroadcastText = new Map<string, string>();
    const agentDeltaSentAt = new Map([["run-1:assistant", Date.now()]]);
    const bufferedAgentEvents = new Map([
      [
        "run-1:assistant",
        {
          payload: {
            runId: "run-1",
            seq: 1,
            stream: "assistant",
            ts: Date.now(),
            data: { text: "pending", delta: "pending" },
          },
        },
      ],
    ]);
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const context = {
      broadcastToConnIds: vi.fn(),
      broadcast,
      nodeSendToSession,
      chatAbortControllers: new Map([
        [
          "run-1",
          {
            controller: abortController,
            sessionId: "run-1",
            sessionKey: "main",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      chatRunBuffers,
      chatDeltaSentAt,
      chatDeltaLastBroadcastLen,
      chatDeltaLastBroadcastText,
      agentDeltaSentAt,
      bufferedAgentEvents,
      chatAbortedRuns: new Map(),
      clearChatRunState: (runId: string) => {
        chatRunBuffers.delete(runId);
        chatDeltaSentAt.delete(runId);
        chatDeltaLastBroadcastLen.delete(runId);
        chatDeltaLastBroadcastText.delete(runId);
        for (const key of [runId, `${runId}:assistant`, `${runId}:thinking`]) {
          agentDeltaSentAt.delete(key);
          bufferedAgentEvents.delete(key);
        }
      },
      removeChatRun,
      agentRunSeq: new Map(),
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
    });
    bridgeRequest?.onClose?.("error");

    expect(abortController.signal.aborted).toBe(true);
    expect(agentDeltaSentAt.has("run-1:assistant")).toBe(false);
    expect(bufferedAgentEvents.has("run-1:assistant")).toBe(false);
    expectChatAbortPayload(broadcast, "relay-closed");
    expectNodeAbortPayload(nodeSendToSession);
  });

  it("caps active relay sessions per browser connection", () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => ({
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      }),
    };
    const createSession = (connId: string) =>
      createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn() } as never,
        connId,
        provider,
        providerConfig: {},
        instructions: "brief",
        tools: [],
      });

    createSession("conn-1");
    createSession("conn-1");

    expect(() => createSession("conn-1")).toThrow(
      "Too many active realtime relay sessions for this connection",
    );
    const session = expectRecordFields(createSession("conn-2"), {
      provider: "relay-test",
      transport: "gateway-relay",
    });
    expectRecordFields(session.audio, {
      inputEncoding: "pcm16",
      outputEncoding: "pcm16",
    });
  });
});
