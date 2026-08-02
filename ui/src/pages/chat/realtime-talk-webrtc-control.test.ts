// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME } from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

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

function createOpenAiTransport(
  client: Record<string, unknown>,
  callbacks: Record<string, unknown> = {},
): WebRtcSdpRealtimeTalkTransport {
  return new WebRtcSdpRealtimeTalkTransport(
    {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "client-secret-123",
    },
    {
      client: client as never,
      sessionKey: "main",
      callbacks: callbacks as never,
    },
  );
}

function dispatchControlToolCall(
  peer: FakePeerConnection | undefined,
  args: { text: string; mode: "status" | "steer" },
): void {
  peer?.channel.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id: "item-control",
        call_id: "call-control",
        name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
        arguments: JSON.stringify(args),
      }),
    }),
  );
}

describe("WebRtcSdpRealtimeTalkTransport control tool", () => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits semantic realtime control tool results through the OpenAI data channel", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "steer",
          sessionKey: "main",
          active: true,
          queued: true,
          message: "Got it. I steered the active run.",
          speak: true,
          show: true,
          suppress: false,
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createOpenAiTransport({
      addEventListener: vi.fn(() => () => undefined),
      request,
    });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    dispatchControlToolCall(peer, { text: "revísalo en WebUI", mode: "steer" });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", {
        sessionKey: "main",
        text: "revísalo en WebUI",
        mode: "steer",
      }),
    );
    const sent =
      peer?.channel.send.mock.calls.map(([payload]) => JSON.parse(String(payload))) ?? [];
    expect(sent).toContainEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-control",
        output: expect.stringContaining('"mode":"steer"'),
      },
    });
    transport.stop();
  });

  it("surfaces OpenAI tool-result send failures without an unhandled rejection", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "status",
          sessionKey: "main",
          active: true,
          message: "Still working.",
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createOpenAiTransport({ request }, { onStatus, onTalkEvent });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    peer?.channel.send.mockImplementation(() => {
      throw new Error("OpenAI data channel rejected the tool result");
    });
    dispatchControlToolCall(peer, { text: "status", mode: "status" });

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "OpenAI data channel rejected the tool result",
      ),
    );
    expect(
      onTalkEvent.mock.calls.some(
        ([event]) =>
          (event.type === "tool.progress" || event.type === "tool.error") && event.final === true,
      ),
    ).toBe(false);
    transport.stop();
  });

  it("silently disposes a provisional OpenAI transport", async () => {
    const onTalkEvent = vi.fn();
    const transport = createOpenAiTransport({}, { onTalkEvent });
    await transport.start();
    onTalkEvent.mockClear();

    transport.stop({ emitClosed: false });

    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances[0]?.connectionState).toBe("closed");
  });

  it("stops an assistant turn event when its transcript callback closes the transport", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transportRef: { current?: WebRtcSdpRealtimeTalkTransport } = {};
    const onTranscript = vi.fn(() => transportRef.current?.stop());
    const transport = createOpenAiTransport({}, { onStatus, onTalkEvent, onTranscript });
    transportRef.current = transport;
    await transport.start();
    onStatus.mockClear();
    onTalkEvent.mockClear();

    FakePeerConnection.instances[0]?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "turn.done",
          turn: { id: "assistant-final", role: "assistant", transcript: "finished" },
        }),
      }),
    );

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
  });
});
