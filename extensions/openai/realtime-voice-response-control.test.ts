// Openai tests cover realtime voice provider plugin behavior.
import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mocks.execFileSyncMock,
  };
});

vi.mock("ws", () => ({
  default: mocks.FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  parseSent,
  createNativeBridge,
  requireSocket,
  beginBridgeConnection,
  openSocket,
  emitServerEvent,
  emitAssistantPlayback,
  emitSessionUpdated,
  emitCompletedToolCalls,
  connectReadyBridge,
  expectedResponseCreateEvent,
  requireNestedRecord,
  expectRecordFields,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice response control", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
  });

  it("suppresses auto responses before draining queued initial greeting audio", async () => {
    const bridgeRef: { current?: RealtimeVoiceBridge } = {};
    const onReady = vi.fn(() => {
      bridgeRef.current?.triggerGreeting?.("Say exactly: hello from explicit speech.");
    });
    const bridge = createNativeBridge({
      instructions: "Be helpful.",
      onReady,
    });
    bridgeRef.current = bridge;
    const { connecting, socket } = beginBridgeConnection(bridge);

    openSocket(socket);
    await Promise.resolve();

    bridge.sendAudio(Buffer.from("before-ready"));
    emitSessionUpdated(socket);
    await connecting;

    const sent = parseSent(socket);
    expect(sent.map((event) => event.type)).toEqual([
      "session.update",
      "conversation.item.create",
      "session.update",
      "response.create",
      "input_audio_buffer.append",
    ]);
    expect(sent[2]).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: false,
              interrupt_response: true,
            },
          },
        },
      },
    });
    expect(sent[4]).toEqual({
      type: "input_audio_buffer.append",
      audio: Buffer.from("before-ready").toString("base64"),
    });
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledTimes(1);

    emitServerEvent(socket, { type: "response.done" });

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });

  it("creates an explicit user item and response for manual speech", async () => {
    const onEvent = vi.fn();
    const bridge = createNativeBridge({ onEvent });
    const socket = await connectReadyBridge(bridge);

    bridge.triggerGreeting?.("Say exactly: hello from explicit speech.");

    const sent = parseSent(socket);
    expect(sent[1]).toEqual({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Say exactly: hello from explicit speech.",
          },
        ],
      },
    });
    expectRecordFields(
      requireNestedRecord(sent[2]?.session, ["audio", "input", "turn_detection"]),
      "manual response turn detection",
      {
        create_response: false,
        interrupt_response: true,
      },
    );
    expect(sent[3]).toEqual(expectedResponseCreateEvent());
    expect(JSON.stringify(parseSent(socket).at(-1))).not.toContain("output_modalities");
    expect(onEvent).toHaveBeenCalledWith({ direction: "client", type: "conversation.item.create" });
    expect(onEvent).toHaveBeenCalledWith({ direction: "client", type: "response.create" });

    emitServerEvent(socket, { type: "response.done" });

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });

  it("forces one host-selected function on an otherwise automatic response", async () => {
    const bridge = createNativeBridge();
    const socket = await connectReadyBridge(bridge);

    bridge.sendUserMessage?.("Run the deterministic check.", {
      toolChoice: { type: "function", name: "lookup_weather" },
    });

    expect(parseSent(socket).at(-1)).toEqual({
      type: "response.create",
      event_id: expect.stringMatching(/^openclaw-response-create-/),
      response: {
        output_modalities: ["audio"],
        tool_choice: { type: "function", name: "lookup_weather" },
      },
    });
  });

  it("defers manual response.create while a realtime response is active", async () => {
    const bridge = createNativeBridge();
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_1" } });

    bridge.sendUserMessage?.("queued manual response");

    expect(parseSent(socket).slice(-1)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "queued manual response" }],
        },
      },
    ]);

    emitServerEvent(socket, { type: "response.done" });

    expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);
  });

  it("restores automatic audio responses when a manual response is rejected", async () => {
    const onError = vi.fn();
    const bridge = createNativeBridge({ onError });
    const socket = await connectReadyBridge(bridge);

    bridge.triggerGreeting?.("Say exactly: hello from explicit speech.");

    const responseCreateEvent = parseSent(socket).findLast(
      (event) => event.type === "response.create",
    );
    if (!responseCreateEvent?.event_id) {
      throw new Error("expected response.create event id");
    }

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-2)?.session, ["audio", "input", "turn_detection"]),
      "suppressed turn detection",
      {
        create_response: false,
        interrupt_response: true,
      },
    );

    emitServerEvent(socket, {
      type: "error",
      error: {
        event_id: responseCreateEvent.event_id,
        message: "bad response request",
      },
    });

    expect(onError).toHaveBeenCalledWith(new Error("bad response request"));
    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });

  it("keeps automatic audio suppressed for unrelated errors during a manual response", async () => {
    const onError = vi.fn();
    const bridge = createNativeBridge({ onError });
    const socket = await connectReadyBridge(bridge);

    bridge.triggerGreeting?.("Say exactly: hello from explicit speech.");
    const sessionUpdatesBeforeError = parseSent(socket).filter(
      (event) => event.type === "session.update",
    );

    emitServerEvent(socket, {
      type: "error",
      error: { event_id: "unrelated-audio-event", message: "bad audio append" },
    });

    expect(onError).toHaveBeenCalledWith(new Error("bad audio append"));
    expect(parseSent(socket).filter((event) => event.type === "session.update")).toHaveLength(
      sessionUpdatesBeforeError.length,
    );

    emitServerEvent(socket, { type: "response.done" });

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });

  it("flushes a queued manual response after the prior request is rejected", async () => {
    const onError = vi.fn();
    const bridge = createNativeBridge({ onError });
    const socket = await connectReadyBridge(bridge);

    bridge.triggerGreeting?.("Say exactly: first greeting.");
    const firstResponseCreate = parseSent(socket).findLast(
      (event) => event.type === "response.create",
    );
    if (!firstResponseCreate?.event_id) {
      throw new Error("expected first response.create event id");
    }
    const sessionUpdateCount = parseSent(socket).filter(
      (event) => event.type === "session.update",
    ).length;

    bridge.sendUserMessage?.("Say exactly: queued follow-up.");
    emitServerEvent(socket, {
      type: "error",
      error: {
        event_id: firstResponseCreate.event_id,
        message: "bad response request",
      },
    });

    const responseCreates = parseSent(socket).filter((event) => event.type === "response.create");
    expect(responseCreates).toHaveLength(2);
    expect(responseCreates[1]).toEqual(expectedResponseCreateEvent());
    expect(responseCreates[1]?.event_id).not.toBe(firstResponseCreate.event_id);
    expect(parseSent(socket).filter((event) => event.type === "session.update")).toHaveLength(
      sessionUpdateCount,
    );
    expect(onError).toHaveBeenCalledWith(new Error("bad response request"));

    emitServerEvent(socket, { type: "response.done" });

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });

  it("serializes standalone control speech while an agent tool call is pending", async () => {
    const bridge = createNativeBridge({ onToolCall: vi.fn() });
    const socket = await connectReadyBridge(bridge);
    emitCompletedToolCalls(socket);

    for (const text of ["status", "steer", "cancel"]) {
      bridge.sendUserMessage?.(text);
    }
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);

    for (let index = 0; index < 3; index += 1) {
      emitServerEvent(socket, {
        type: "response.created",
        response: { id: `resp_control_${index}` },
      });
      emitServerEvent(socket, {
        type: "response.done",
        response: { id: `resp_control_${index}`, status: "completed", output: [] },
      });
      expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(
        Math.min(index + 2, 3),
      );
    }
  });

  it("drains deferred response.create after response.cancelled", async () => {
    const bridge = createNativeBridge();
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_1" } });

    bridge.sendUserMessage?.("queued after cancellation");
    emitServerEvent(socket, { type: "response.cancelled" });

    expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);
  });

  it("drains deferred response.create after a no-active-response cancellation error", async () => {
    const onError = vi.fn();
    const bridge = createNativeBridge({ onError });
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_1" } });

    bridge.sendUserMessage?.("queued after cancellation error");
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    const responseCancelEvent = parseSent(socket).findLast(
      (event) => event.type === "response.cancel",
    );
    if (!responseCancelEvent?.event_id) {
      throw new Error("expected response.cancel event id");
    }
    emitServerEvent(socket, {
      type: "error",
      error: {
        event_id: responseCancelEvent.event_id,
        message: "Cancellation failed: no active response found",
      },
    });

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);
  });

  it("ignores a stale cancellation error after a newer manual response starts", async () => {
    const onError = vi.fn();
    const bridge = createNativeBridge({ onError });
    const socket = await connectReadyBridge(bridge);
    bridge.setMediaTimestamp(1000);
    // 2016 bytes at the default g711_ulaw/8kHz output format is 252ms of
    // delivered audio, so the barge-in below is above minBargeInAudioEndMs on
    // its own merits. audio_end_ms is clamped to audio the item actually
    // delivered, so a media-clock jump alone no longer carries it over the
    // threshold - and this test needs a real response.cancel as the precondition
    // for its actual subject, the stale cancellation error.
    emitAssistantPlayback(socket, { audio: Buffer.alloc(2016, 0x41) });
    bridge.setMediaTimestamp(1300);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    const responseCancelEvent = parseSent(socket).findLast(
      (event) => event.type === "response.cancel",
    );
    if (!responseCancelEvent?.event_id) {
      throw new Error("expected response.cancel event id");
    }
    bridge.sendUserMessage?.("queued newer response");
    emitServerEvent(socket, { type: "response.done" });
    const sessionUpdateCount = parseSent(socket).filter(
      (event) => event.type === "session.update",
    ).length;

    emitServerEvent(socket, {
      type: "error",
      error: {
        event_id: responseCancelEvent.event_id,
        message: "Cancellation failed: no active response found",
      },
    });

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).filter((event) => event.type === "session.update")).toHaveLength(
      sessionUpdateCount,
    );
    expect(parseSent(socket).at(-1)).toEqual(expectedResponseCreateEvent());

    emitServerEvent(socket, { type: "response.done" });
    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });

  it("resets deferred response guards after websocket reconnect", async () => {
    vi.useFakeTimers();
    const bridge = createNativeBridge();
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_1" } });
    bridge.sendUserMessage?.("queued before reconnect");

    expect(parseSent(socket).slice(-1)[0]?.type).toBe("conversation.item.create");

    socket.emit("close", 1006, Buffer.from("transient drop"));
    await vi.advanceTimersByTimeAsync(1000);
    const reconnectedSocket = requireSocket(1);
    openSocket(reconnectedSocket);
    emitSessionUpdated(reconnectedSocket);
    bridge.sendUserMessage?.("Say hello after reconnect.");

    expect(parseSent(reconnectedSocket).slice(-3)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello after reconnect." }],
        },
      },
      expect.objectContaining({ type: "session.update" }),
      expectedResponseCreateEvent(),
    ]);
  });

  it("turns active-response errors into a deferred response.create retry", async () => {
    const onError = vi.fn();
    const bridge = createNativeBridge({ onError });
    const socket = await connectReadyBridge(bridge);

    bridge.sendUserMessage?.("trigger active-response retry");
    const responseCreateEvent = parseSent(socket).findLast(
      (event) => event.type === "response.create",
    );
    if (!responseCreateEvent?.event_id) {
      throw new Error("expected response.create event id");
    }
    emitServerEvent(socket, {
      type: "error",
      error: {
        event_id: responseCreateEvent.event_id,
        message: "Conversation already has an active response in progress: resp_1",
      },
    });
    const afterError = parseSent(socket);
    expect(afterError.filter((event) => event.type === "session.update")).toHaveLength(2);
    expectRecordFields(
      requireNestedRecord(afterError.at(-2)?.session, ["audio", "input", "turn_detection"]),
      "still suppressed turn detection",
      {
        create_response: false,
        interrupt_response: true,
      },
    );

    emitServerEvent(socket, { type: "response.done" });

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);

    emitServerEvent(socket, { type: "response.done" });

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });
});
