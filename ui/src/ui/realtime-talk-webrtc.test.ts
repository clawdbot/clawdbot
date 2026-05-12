// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "./chat/realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./chat/realtime-talk-webrtc.ts";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  close(): void {
    this.connectionState = "closed";
  }
}

function requireTalkEvent(
  onTalkEvent: ReturnType<typeof vi.fn>,
  index: number,
): Record<string, unknown> {
  const call = onTalkEvent.mock.calls[index];
  if (!call) {
    throw new Error(`expected talk event at index ${index}`);
  }
  const [event] = call;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error(`expected talk event record at index ${index}`);
  }
  return event as Record<string, unknown>;
}

describe("WebRtcSdpRealtimeTalkTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    FakePeerConnection.instances = [];
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => stream),
      },
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  });

  it("sends provider offer headers with the WebRTC SDP request", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
        offerUrl: "https://api.openai.com/v1/realtime/calls",
        offerHeaders: {
          originator: "openclaw",
          version: "2026.3.22",
        },
      },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: {},
      },
    );

    await transport.start();

    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: "offer-sdp",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        Authorization: "Bearer client-secret-123",
        "Content-Type": "application/sdp",
      },
    });
    transport.stop();
  });

  it("surfaces realtime provider errors from the OpenAI data channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const onStatus = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: { onStatus },
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "error",
          error: { message: "Realtime model rejected the session" },
        }),
      }),
    );

    expect(onStatus).toHaveBeenCalledWith("error", "Realtime model rejected the session");
    transport.stop();
  });

  it("surfaces speech and response lifecycle status from the OpenAI data channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: { onStatus, onTalkEvent },
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    for (const type of [
      "input_audio_buffer.speech_started",
      "input_audio_buffer.speech_stopped",
      "response.created",
      "response.done",
    ]) {
      peer?.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type }) }));
    }

    expect(onStatus).toHaveBeenCalledWith("listening", "Speech detected");
    expect(onStatus).toHaveBeenCalledWith("thinking", "Processing speech");
    expect(onStatus).toHaveBeenCalledWith("thinking", "Generating response");
    expect(onStatus).toHaveBeenCalledWith("listening", undefined);
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "turn.started",
      "input.audio.committed",
      "turn.ended",
    ]);
    expect(onTalkEvent.mock.calls.map(([event]) => event.turnId)).toEqual([
      "turn-1",
      "turn-1",
      "turn-1",
    ]);
    transport.stop();
  });

  it("emits common Talk transcript events from the OpenAI data channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const onTranscript = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: { onTranscript, onTalkEvent },
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "input-1",
          transcript: "hello",
        }),
      }),
    );
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "response.audio_transcript.done",
          item_id: "response-1",
          transcript: "hi there",
        }),
      }),
    );

    expect(onTranscript).toHaveBeenCalledWith({ role: "user", text: "hello", final: true });
    expect(onTranscript).toHaveBeenCalledWith({
      role: "assistant",
      text: "hi there",
      final: true,
    });
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "transcript.done",
      "output.text.done",
    ]);
    expect(onTalkEvent.mock.calls.map(([event]) => event.turnId)).toEqual(["turn-1", "turn-1"]);
    const userTranscriptEvent = requireTalkEvent(onTalkEvent, 0);
    expect(userTranscriptEvent.itemId).toBe("input-1");
    expect(userTranscriptEvent.payload).toEqual({ role: "user", text: "hello" });
    expect(userTranscriptEvent.sessionId).toBe("main:openai:webrtc");
    expect(userTranscriptEvent.transport).toBe("webrtc");
    const assistantTranscriptEvent = requireTalkEvent(onTalkEvent, 1);
    expect(assistantTranscriptEvent.itemId).toBe("response-1");
    expect(assistantTranscriptEvent.payload).toEqual({ text: "hi there" });
    expect(assistantTranscriptEvent.sessionId).toBe("main:openai:webrtc");
    expect(assistantTranscriptEvent.transport).toBe("webrtc");
    transport.stop();
  });

  it("aborts an in-flight OpenAI tool consult when the transport stops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "chat.abort") {
        expect(params).toEqual({ sessionKey: "main", runId: "run-1" });
        return { ok: true, aborted: true };
      }
      expect(method).toBe("talk.client.toolCall");
      expect(params.callId).toBe("call-1");
      expect(params.name).toBe(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
      return { runId: "run-1" };
    });
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        client: {
          addEventListener: vi.fn(
            (listener: (event: { event: string; payload?: unknown }) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          ),
          request,
        } as never,
        sessionKey: "main",
        callbacks: {},
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          call_id: "call-1",
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          arguments: JSON.stringify({ question: "status?" }),
        }),
      }),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("talk.client.toolCall", {
      sessionKey: "main",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });

    transport.stop();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.abort", { sessionKey: "main", runId: "run-1" }),
    );
    expect(listeners.size).toBe(0);
  });
});
