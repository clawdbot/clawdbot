// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../src/talk/describe-view-tool.js";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

class FakePeerConnection extends EventTarget {
  static instance: FakePeerConnection | undefined;

  connectionState: RTCPeerConnectionState = "new";
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  readonly sctp = { maxMessageSize: 512 };
  localDescription: RTCSessionDescriptionInit | null = null;

  constructor() {
    super();
    FakePeerConnection.instance = this;
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

  async setRemoteDescription(): Promise<void> {}

  close(): void {
    this.connectionState = "closed";
  }
}

function sentRealtimeEvents(): Array<Record<string, unknown>> {
  return (
    FakePeerConnection.instance?.channel.send.mock.calls.map(
      ([payload]) => JSON.parse(String(payload)) as Record<string, unknown>,
    ) ?? []
  );
}

describe("OpenAI Realtime Video Talk", () => {
  beforeEach(() => {
    FakePeerConnection.instance = undefined;
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps camera local, bounds the frame event, and releases both tracks", async () => {
    const audioStop = vi.fn();
    const videoStop = vi.fn();
    const audioTrack = { stop: audioStop } as unknown as MediaStreamTrack;
    const videoTrack = { stop: videoStop } as unknown as MediaStreamTrack;
    const audio = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const camera = {
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    class TestMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getAudioTracks() {
        return [audioTrack];
      }
      getVideoTracks() {
        return [videoTrack];
      }
      getTracks() {
        return this.tracks;
      }
    }
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(camera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaStream", TestMediaStream);

    const originalCreateElement = document.createElement.bind(document);
    let videoReadyState: number = HTMLMediaElement.HAVE_METADATA;
    let captureVideo: HTMLVideoElement | undefined;
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (element instanceof HTMLVideoElement) {
        captureVideo = element;
        Object.defineProperties(element, {
          readyState: { configurable: true, get: () => videoReadyState },
          videoWidth: { configurable: true, value: 1280 },
          videoHeight: { configurable: true, value: 720 },
        });
        vi.spyOn(element, "play").mockResolvedValue(undefined);
      }
      return element;
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValueOnce(`data:image/jpeg;base64,${"x".repeat(512)}`)
      .mockReturnValueOnce("data:image/jpeg;base64,camera-frame");
    const onVideoStream = vi.fn();
    const onTalkEvent = vi.fn();
    const onStatus = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "test-client-secret",
      },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: { onStatus, onTalkEvent, onVideoStream },
        videoEnabled: true,
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instance;
    const combined = onVideoStream.mock.calls[0]?.[0] as MediaStream;
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item-camera",
          call_id: "call-camera",
          name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
          arguments: "{}",
        }),
      }),
    );
    await Promise.resolve();
    expect(sentRealtimeEvents()).not.toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({ content: expect.any(Array) }),
      }),
    );
    videoReadyState = HTMLMediaElement.HAVE_CURRENT_DATA;
    captureVideo?.dispatchEvent(new Event("loadeddata"));

    await vi.waitFor(() =>
      expect(sentRealtimeEvents()).toContainEqual({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/jpeg;base64,camera-frame" }],
        },
      }),
    );
    expect(sentRealtimeEvents()).toContainEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-camera",
        output: JSON.stringify({ ok: true, frameAttached: true }),
      },
    });
    expect(sentRealtimeEvents()).toContainEqual({ type: "response.create" });
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true });
    expect(peer?.addTrack).toHaveBeenCalledOnce();
    expect(peer?.addTrack).toHaveBeenCalledWith(audioTrack, combined);
    expect(combined).toBeInstanceOf(TestMediaStream);
    expect(onVideoStream).toHaveBeenCalledWith(combined);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toContain("tool.result");
    for (const [payload] of peer?.channel.send.mock.calls ?? []) {
      expect(new TextEncoder().encode(String(payload)).length).toBeLessThanOrEqual(512);
    }

    peer!.connectionState = "failed";
    peer!.dispatchEvent(new Event("connectionstatechange"));
    expect(onStatus).toHaveBeenLastCalledWith("error", "Realtime connection closed");
    expect(onVideoStream).toHaveBeenLastCalledWith(null);
    expect(audioStop).toHaveBeenCalledOnce();
    expect(videoStop).toHaveBeenCalledOnce();
  });

  it("releases the microphone when stopped during the camera prompt", async () => {
    const audioStop = vi.fn();
    const videoStop = vi.fn();
    const audio = {
      getAudioTracks: () => [{} as MediaStreamTrack],
      getTracks: () => [{ stop: audioStop }],
    } as unknown as MediaStream;
    const camera = {
      getVideoTracks: () => [{} as MediaStreamTrack],
      getTracks: () => [{ stop: videoStop }],
    } as unknown as MediaStream;
    let resolveCamera: (stream: MediaStream) => void = () => undefined;
    const cameraPending = new Promise<MediaStream>((resolve) => {
      resolveCamera = resolve;
    });
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockReturnValueOnce(cameraPending);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "test-client-secret",
      },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: {},
        videoEnabled: true,
      },
    );

    const starting = transport.start();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    transport.stop();
    expect(audioStop).toHaveBeenCalledOnce();
    resolveCamera(camera);

    await expect(starting).resolves.toBeUndefined();
    expect(videoStop).toHaveBeenCalledOnce();
  });
});
