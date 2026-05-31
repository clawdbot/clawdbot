import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setActiveEmbeddedRun,
  testing as embeddedRunTesting,
} from "../agents/embedded-agent-runner/runs.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../talk/provider-types.js";
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
      callId: "call-1",
    });
    return {
      abortController,
      broadcast,
      nodeSendToSession,
      removeChatRun,
      agentDeltaSentAt,
      bufferedAgentEvents,
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

    const audioPayload = findEventPayload(events, (payload) => payload.type === "audio");
    expectRecordFields(audioPayload, {
      relaySessionId: session.relaySessionId,
      type: "audio",
      audioBase64: Buffer.from("audio-out").toString("base64"),
    });
    expectRecordFields(audioPayload.talkEvent, { type: "output.audio.delta" });

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
    submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { status: "working" },
      options: { willContinue: true },
    });
    submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    submitTalkRealtimeRelayToolResult({
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
    submitTalkRealtimeRelayToolResult({
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

    submitTalkRealtimeRelayToolResult({
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

  it("clears linked agent consult runs after the final tool result", () => {
    const { abortController, broadcast, session } = createAbortableRelayRunFixture();

    submitTalkRealtimeRelayToolResult({
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

  it("submits a final provider result when voice cancel aborts an active relay run", async () => {
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
      { suppressResponse: true },
    );
    expect(abortController.signal.aborted).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted" }),
    );

    submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { error: "aborted" },
    });
    expect(bridge.submitToolResult).toHaveBeenCalledTimes(1);
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
