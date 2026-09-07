import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIRealtimeGaWebRtcBridge } from "./realtime-ga-webrtc-bridge.js";
import { openAIRealtimeHost } from "./realtime-host.js";
import type { OpenAIQuicksilverAudioPeer } from "./realtime-quicksilver-peer.runtime.js";
import type { OpenAIRealtimeVoiceBridgeConfig } from "./realtime-voice-session-policy.js";

const mocks = vi.hoisted(() => ({ createPeer: vi.fn() }));
vi.mock("./realtime-quicksilver-peer.runtime.js", () => ({
  OpenAIQuicksilverAudioPeer: { create: mocks.createPeer },
}));
const auth = { type: "oauth" as const, token: "oauth-fixture", accountId: "account-fixture" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function harness(overrides: Partial<OpenAIRealtimeVoiceBridgeConfig> = {}) {
  let callbacks!: Parameters<typeof OpenAIQuicksilverAudioPeer.create>[0];
  let open = false;
  const peer = {
    createOffer: vi.fn(async () => "v=offer\r\n"),
    applyAnswer: vi.fn(async () => {
      open = true;
      callbacks.gaDataChannel?.onOpen();
      callbacks.gaDataChannel?.onMessage(JSON.stringify({ type: "session.created" }));
    }),
    sendAudio: vi.fn(),
    sendControl: vi.fn(),
    discardInboundAudio: vi.fn(),
    isControlOpen: () => open,
    close: vi.fn(() => {
      open = false;
    }),
  };
  mocks.createPeer.mockImplementation(async (params) => {
    callbacks = params;
    return peer;
  });
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("v=answer\r\n", {
        status: 201,
        headers: { Location: "/v1/realtime/calls/call_fixture" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const cfg: OpenAIRealtimeVoiceBridgeConfig = {
    providerConfig: {},
    model: "gpt-realtime-2.1",
    voice: "cedar",
    audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    autoRespondToAudio: false,
    instructions: "Use the selected agent.",
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    onTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onReady: vi.fn(),
    onClose: vi.fn(),
    logger: { warn: vi.fn() },
    ...overrides,
  };
  const bridge = new OpenAIRealtimeGaWebRtcBridge(cfg, openAIRealtimeHost, auth);
  const event = (value: unknown) => callbacks.gaDataChannel?.onMessage(JSON.stringify(value));
  const audio = () => callbacks.callbacks.onAudio(Buffer.alloc(960));
  const sent = () => peer.sendControl.mock.calls.map(([message]) => JSON.parse(message));
  return { cfg, bridge, peer, event, audio, sent, fetchMock };
}
function response(h: ReturnType<typeof harness>, id = "response-1") {
  h.event({ type: "response.created", response: { id } });
  h.event({
    type: "response.output_item.added",
    response_id: id,
    item: { id: "item-1", type: "message" },
  });
  h.event({ type: "response.content_part.added", response_id: id, part: { type: "audio" } });
  h.event({ type: "output_audio_buffer.started", response_id: id });
}
function done(h: ReturnType<typeof harness>, id = "response-1", output: unknown[] = []) {
  h.event({ type: "response.done", response: { id, status: "completed", output } });
}
beforeEach(() => {
  mocks.createPeer.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GA Gateway WebRTC owner", () => {
  it.each([
    {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: { invalid: true },
    },
    { type: "response.done", response: { id: "bad", output: {} } },
    { type: "response.output_audio_transcript.done", response_id: 7, transcript: "invalid" },
  ])("rejects malformed control data before delivering callbacks", async (event) => {
    const h = harness();
    await h.bridge.connect();
    h.event(event);
    expect(h.cfg.onTranscript).not.toHaveBeenCalled();
    expect(h.cfg.onToolCall).not.toHaveBeenCalled();
    expect(h.cfg.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Invalid OpenAI Realtime control event" }),
    );
    expect(h.peer.close).toHaveBeenCalledOnce();
  });

  it("does not deliver a transcript after its observer cancels the response", async () => {
    const h = harness();
    h.cfg.onEvent = (event) => {
      if (event.type === "response.output_audio_transcript.done") {
        h.bridge.handleBargeIn({ force: true });
      }
    };
    await h.bridge.connect();
    h.bridge.sendUserMessage("Readback", { mode: "readback" });
    response(h);
    h.event({
      type: "response.output_audio_transcript.done",
      response_id: "response-1",
      transcript: "cancelled",
    });
    expect(h.cfg.onTranscript).not.toHaveBeenCalled();
    h.bridge.close();
  });
  it("keeps valid long playback alive after generation is done until its buffer drains", async () => {
    const h = harness();
    await h.bridge.connect();
    vi.useFakeTimers();
    h.bridge.sendUserMessage("A long answer", { mode: "readback" });
    response(h);
    done(h);
    await vi.advanceTimersByTimeAsync(11_000);
    h.audio();
    expect(h.bridge.isConnected()).toBe(true);
    expect(h.cfg.onAudio).toHaveBeenCalledOnce();
    expect(h.cfg.onResponseDone).not.toHaveBeenCalled();
    h.event({ type: "output_audio_buffer.stopped", response_id: "response-1" });
    expect(h.cfg.onResponseDone).toHaveBeenCalledOnce();
    h.bridge.close();
  });

  it("rejects startup when the readiness consumer throws and retires media/call", async () => {
    const h = harness({
      onReady: () => {
        throw new Error("consumer refused readiness");
      },
    });
    await expect(h.bridge.connect()).rejects.toThrow("consumer refused readiness");
    expect(h.bridge.isConnected()).toBe(false);
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.cfg.onClose).toHaveBeenCalledExactlyOnceWith("error");
  });

  it("suppresses a prebuilt automatic policy at creation without mutating its owner", async () => {
    const { buildOpenAIRealtimeGaSessionPolicy } =
      await import("./realtime-voice-session-policy.js");
    const policy = buildOpenAIRealtimeGaSessionPolicy({
      model: "gpt-realtime-2.1",
      voice: "cedar",
      noiseReduction: null,
      autoRespondToAudio: true,
    });
    const h = harness({ gaSessionPolicy: policy });
    await h.bridge.connect();
    expect(h.fetchMock.mock.calls[0]?.[1]?.body).toContain('"create_response":false');
    expect(policy.audio.input.turn_detection.create_response).toBe(true);
    h.bridge.close();
  });

  it("cancels before response.created and suppresses late tool output", async () => {
    const h = harness();
    await h.bridge.connect();
    h.bridge.sendUserMessage("old", { mode: "readback" });
    h.bridge.handleBargeIn({ force: true });
    response(h);
    h.audio();
    h.event({
      type: "response.output_audio_transcript.done",
      response_id: "response-1",
      transcript: "late",
    });
    done(h, "response-1", [
      { type: "function_call", call_id: "rogue", name: "consult", arguments: "{}" },
    ]);
    h.event({ type: "output_audio_buffer.cleared", response_id: "response-1" });
    expect(h.cfg.onAudio).not.toHaveBeenCalled();
    expect(h.cfg.onTranscript).not.toHaveBeenCalled();
    expect(h.cfg.onToolCall).not.toHaveBeenCalled();
    expect(h.cfg.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    h.bridge.close();
  });

  it("fails immediately on redacted startup control error and retires the allocated call", async () => {
    const h = harness();
    h.peer.applyAnswer.mockImplementationOnce(async () => {
      h.event({
        type: "error",
        error: { type: "server_error", message: "denied oauth-fixture account-fixture" },
      });
    });
    await expect(h.bridge.connect()).rejects.toThrow("denied [REDACTED] [REDACTED]");
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(h.cfg.onReady).not.toHaveBeenCalled();
  });

  it("reports failed remote retirement without delivering stale call callbacks", async () => {
    const h = harness();
    await h.bridge.connect();
    h.fetchMock.mockResolvedValueOnce(new Response("sensitive provider detail", { status: 503 }));
    h.bridge.close();
    await vi.waitFor(() => expect(h.cfg.logger.warn).toHaveBeenCalledOnce());
    expect(h.cfg.logger.warn).toHaveBeenCalledWith(
      "OpenAI Realtime remote call retirement failed; local media/control closed",
    );
    expect(h.cfg.onError).not.toHaveBeenCalled();
    expect(h.cfg.onClose).toHaveBeenCalledExactlyOnceWith("completed");
  });

  it("creates OAuth multipart with complete strict policy before accepting microphone frames", async () => {
    const h = harness();
    h.bridge.sendAudio(Buffer.alloc(960));
    const connect = h.bridge.connect();
    expect(h.peer.sendAudio).not.toHaveBeenCalled();
    await connect;
    expect(h.fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.openai.com/v1/realtime/calls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-fixture",
          "chatgpt-account-id": "account-fixture",
        }),
        body: expect.stringContaining('"create_response":false'),
      }),
    );
    const body = h.fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toContain('"model":"gpt-realtime-2.1"');
    expect(body).toContain('"voice":"cedar"');
    expect(body).toContain('"transcription":{"model":"gpt-4o-mini-transcribe"}');
    expect(body).toContain('"instructions":"Use the selected agent."');
    expect(h.peer.sendAudio).toHaveBeenCalledOnce();
    expect(h.sent()).toEqual([]);
    h.bridge.close();
  });
  it("forwards final user speech and isolates readback with no tools/conversation", async () => {
    const h = harness();
    await h.bridge.connect();
    h.event({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-1",
      transcript: "Ask my agent",
    });
    expect(h.cfg.onTranscript).toHaveBeenCalledWith("user", "Ask my agent", true);
    h.bridge.sendUserMessage("The agent says hello", { mode: "readback" });
    expect(h.sent()).toEqual([
      expect.objectContaining({
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["audio"],
          tools: [],
          tool_choice: "none",
          instructions: expect.stringContaining("supplied text"),
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "The agent says hello" }],
            },
          ],
        },
      }),
    ]);
    h.audio();
    expect(h.cfg.onAudio).not.toHaveBeenCalled();
    response(h);
    h.audio();
    expect(h.cfg.onAudio).toHaveBeenCalledWith(Buffer.alloc(960), undefined);
    done(h, "response-1", [
      { type: "function_call", call_id: "rogue", name: "tool", arguments: "{}" },
    ]);
    expect(h.cfg.onResponseDone).not.toHaveBeenCalled();
    h.event({ type: "output_audio_buffer.stopped", response_id: "response-1" });
    expect(h.cfg.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(h.cfg.onToolCall).not.toHaveBeenCalled();
    h.bridge.close();
  });
  it("waits for matching drain and rejects stale audio/transcript/tools after cancellation", async () => {
    const h = harness();
    await h.bridge.connect();
    h.bridge.sendUserMessage("old", { mode: "readback" });
    response(h);
    h.audio();
    h.bridge.sendUserMessage("queued old answer", { mode: "readback" });
    h.bridge.handleBargeIn({ force: true });
    const types = h.sent().map((event) => event.type);
    expect(types.indexOf("response.cancel")).toBeLessThan(
      types.indexOf("output_audio_buffer.clear"),
    );
    expect(h.cfg.onClearAudio).toHaveBeenCalledExactlyOnceWith("barge-in");
    h.event({
      type: "response.output_audio_transcript.done",
      response_id: "response-1",
      transcript: "stale",
    });
    h.audio();
    expect(h.cfg.onAudio).toHaveBeenCalledTimes(1);
    expect(h.cfg.onTranscript).not.toHaveBeenCalled();
    done(h);
    h.event({ type: "output_audio_buffer.stopped", response_id: "unrelated" });
    expect(h.cfg.onResponseDone).not.toHaveBeenCalled();
    h.event({ type: "output_audio_buffer.cleared", response_id: "response-1" });
    expect(h.cfg.onResponseDone).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(h.sent().filter((event) => event.type === "response.create")).toHaveLength(1);
    h.bridge.sendUserMessage("new answer", { mode: "readback" });
    response(h, "response-2");
    h.event({
      type: "response.output_audio_transcript.done",
      response_id: "response-1",
      transcript: "late old",
    });
    done(h, "response-1", [
      { type: "function_call", call_id: "old", name: "tool", arguments: "{}" },
    ]);
    expect(h.cfg.onToolCall).not.toHaveBeenCalled();
    expect(h.cfg.onTranscript).not.toHaveBeenCalled();
    h.bridge.close();
    h.audio();
    h.event({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "late user",
    });
    expect(h.cfg.onAudio).toHaveBeenCalledTimes(1);
    expect(h.cfg.onTranscript).not.toHaveBeenCalled();
  });
  it("uses the completed tool boundary and suppresses tool-result response", async () => {
    const h = harness();
    await h.bridge.connect();
    h.bridge.sendUserMessage("consult", { toolChoice: { type: "function", name: "consult" } });
    h.event({ type: "response.created", response: { id: "tool-response" } });
    done(h, "tool-response", [
      {
        type: "function_call",
        call_id: "call-1",
        name: "consult",
        arguments: '{"question":"hello"}',
      },
    ]);
    expect(h.cfg.onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", args: { question: "hello" } }),
    );
    const creates = h.sent().filter((event) => event.type === "response.create").length;
    h.bridge.submitToolResult("call-1", { text: "answer" }, { suppressResponse: true });
    expect(h.sent().at(-1)).toMatchObject({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-1" },
    });
    expect(h.sent().filter((event) => event.type === "response.create")).toHaveLength(creates);
    h.bridge.close();
  });
  it("preserves automatic normal GA mode and refuses unsolicited strict output", async () => {
    const normal = harness({ autoRespondToAudio: undefined });
    await normal.bridge.connect();
    expect(normal.fetchMock.mock.calls[0]?.[1]?.body).toContain('"create_response":true');
    response(normal);
    normal.audio();
    expect(normal.cfg.onAudio).toHaveBeenCalledOnce();
    normal.bridge.close();
    const strict = harness();
    await strict.bridge.connect();
    response(strict);
    strict.audio();
    expect(strict.cfg.onAudio).not.toHaveBeenCalled();
    expect(strict.cfg.onError).toHaveBeenCalledOnce();
    expect(strict.peer.close).toHaveBeenCalledOnce();
  });
  it.each(["peer", "offer", "answer"])(
    "closes during %s creation and fences late completion",
    async (stage) => {
      const h = harness();
      const gate = deferred<void>();
      if (stage === "peer") {
        mocks.createPeer.mockImplementationOnce(async () => {
          await gate.promise;
          return h.peer;
        });
      }
      if (stage === "offer") {
        h.peer.createOffer.mockImplementationOnce(async () => {
          await gate.promise;
          return "v=offer";
        });
      }
      if (stage === "answer") {
        h.peer.applyAnswer.mockImplementationOnce(async () => {
          await gate.promise;
        });
      }
      const connect = h.bridge.connect();
      await vi.waitFor(() =>
        expect(
          stage === "peer"
            ? mocks.createPeer
            : stage === "offer"
              ? h.peer.createOffer
              : h.peer.applyAnswer,
        ).toHaveBeenCalled(),
      );
      h.bridge.close();
      await connect;
      gate.resolve();
      await vi.waitFor(() => expect(h.peer.close).toHaveBeenCalled());
      expect(h.cfg.onReady).not.toHaveBeenCalled();
      expect(h.cfg.onClose).toHaveBeenCalledExactlyOnceWith("completed");
      if (stage !== "answer") {
        expect(h.fetchMock).not.toHaveBeenCalled();
      }
    },
  );
  it("retires late successful headers with original OAuth auth without reading SDP", async () => {
    const h = harness();
    const gate = deferred<Response>();
    h.fetchMock.mockImplementationOnce(() => gate.promise);
    const connect = h.bridge.connect();
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledOnce());
    h.bridge.close();
    await connect;
    const cancel = vi.fn();
    gate.resolve(
      new Response(new ReadableStream({ cancel }), {
        status: 201,
        headers: { Location: "/v1/realtime/calls/call_late" },
      }),
    );
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(2));
    expect(h.fetchMock.mock.calls[1]).toEqual([
      "https://api.openai.com/v1/realtime/calls/call_late/hangup",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-fixture",
          "chatgpt-account-id": "account-fixture",
        }),
      }),
    ]);
    expect(cancel).toHaveBeenCalled();
    expect(h.peer.applyAnswer).not.toHaveBeenCalled();
  });
  it("retires after bounded SDP failure with no retry", async () => {
    const h = harness();
    h.fetchMock.mockResolvedValueOnce(
      new Response("x".repeat(256 * 1024 + 1), {
        status: 201,
        headers: { Location: "/v1/realtime/calls/call_large" },
      }),
    );
    await expect(h.bridge.connect()).rejects.toThrow();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(h.cfg.onReady).not.toHaveBeenCalled();
  });
});
