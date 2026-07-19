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

  it("starts audio-only, toggles local camera, and reports camera-off tool calls", async () => {
    const audioStop = vi.fn();
    const videoStop = vi.fn();
    const audioTrack = { stop: audioStop } as unknown as MediaStreamTrack;
    const videoTrack = Object.assign(new EventTarget(), {
      stop: videoStop,
      readyState: "live",
    }) as unknown as MediaStreamTrack;
    const audio = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const camera = {
      getVideoTracks: () => [videoTrack],
      getTracks: () => [videoTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(camera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

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
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instance;
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(peer?.addTrack).toHaveBeenCalledWith(audioTrack, audio);
    expect(onVideoStream).not.toHaveBeenCalled();

    await transport.setVideoEnabled(true);
    expect(onVideoStream).toHaveBeenCalledWith(camera);
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
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toContain("tool.result");
    for (const [payload] of peer?.channel.send.mock.calls ?? []) {
      expect(new TextEncoder().encode(String(payload)).length).toBeLessThanOrEqual(512);
    }

    await transport.setVideoEnabled(false);
    expect(onVideoStream).toHaveBeenLastCalledWith(null);
    expect(videoStop).toHaveBeenCalledOnce();
    expect(audioStop).not.toHaveBeenCalled();

    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item-camera-off",
          call_id: "call-camera-off",
          name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
          arguments: "{}",
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(sentRealtimeEvents()).toContainEqual({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-camera-off",
          output: JSON.stringify({ ok: false, error: "camera is off" }),
        },
      }),
    );
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());

    transport.stop();
    expect(audioStop).toHaveBeenCalledOnce();
  });

  it("clears ended camera state and reacquires on the next enable", async () => {
    const audioTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const firstVideoTrack = Object.assign(new EventTarget(), {
      stop: vi.fn(),
      readyState: "live",
    }) as unknown as MediaStreamTrack;
    const secondVideoTrack = Object.assign(new EventTarget(), {
      stop: vi.fn(),
      readyState: "live",
    }) as unknown as MediaStreamTrack;
    const audio = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const firstCamera = {
      getVideoTracks: () => [firstVideoTrack],
      getTracks: () => [firstVideoTrack],
    } as unknown as MediaStream;
    const secondCamera = {
      getVideoTracks: () => [secondVideoTrack],
      getTracks: () => [secondVideoTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockResolvedValueOnce(firstCamera)
      .mockResolvedValueOnce(secondCamera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const onVideoStream = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      { provider: "openai", transport: "webrtc", clientSecret: "test-client-secret" },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: { onVideoStream },
      },
    );

    await transport.start();
    await transport.setVideoEnabled(true);
    firstVideoTrack.dispatchEvent(new Event("ended"));

    expect(onVideoStream).toHaveBeenLastCalledWith(null);
    await transport.setVideoEnabled(true);
    expect(getUserMedia).toHaveBeenNthCalledWith(3, { video: true });
    expect(onVideoStream).toHaveBeenLastCalledWith(secondCamera);

    transport.stop();
  });

  it("keeps voice alive when lazy camera acquisition fails", async () => {
    const audioStop = vi.fn();
    const audioTrack = { stop: audioStop } as unknown as MediaStreamTrack;
    const audio = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const onStatus = vi.fn();
    const onVideoStream = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      { provider: "openai", transport: "webrtc", clientSecret: "test-client-secret" },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: { onStatus, onVideoStream },
      },
    );

    await transport.start();
    await expect(transport.setVideoEnabled(true)).rejects.toThrow("Camera access is blocked");

    expect(audioStop).not.toHaveBeenCalled();
    expect(onVideoStream).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    transport.stop();
    expect(audioStop).toHaveBeenCalledOnce();
  });

  it("releases acquired media when stopped during the camera prompt", async () => {
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
      },
    );

    await transport.start();
    const enabling = transport.setVideoEnabled(true);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    transport.stop();
    expect(audioStop).toHaveBeenCalledOnce();
    resolveCamera(camera);

    await expect(enabling).resolves.toBeUndefined();
    expect(videoStop).toHaveBeenCalledOnce();
  });

  it("switches an active camera and updates the capture stream", async () => {
    const audioTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const frontStop = vi.fn();
    const frontTrack = Object.assign(new EventTarget(), {
      stop: frontStop,
      readyState: "live",
      getSettings: () => ({ deviceId: "front" }),
    }) as unknown as MediaStreamTrack;
    const backTrack = Object.assign(new EventTarget(), {
      stop: vi.fn(),
      readyState: "live",
      getSettings: () => ({ deviceId: "back" }),
    }) as unknown as MediaStreamTrack;
    const audio = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const frontCamera = {
      getVideoTracks: () => [frontTrack],
      getTracks: () => [frontTrack],
    } as unknown as MediaStream;
    const backCamera = {
      getVideoTracks: () => [backTrack],
      getTracks: () => [backTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockResolvedValueOnce(frontCamera)
      .mockResolvedValueOnce(backCamera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const onVideoStream = vi.fn();
    const context = {
      client: {} as never,
      sessionKey: "main",
      callbacks: { onVideoStream },
      videoDeviceId: "front",
    };
    const transport = new WebRtcSdpRealtimeTalkTransport(
      { provider: "openai", transport: "webrtc", clientSecret: "test-client-secret" },
      context,
    );

    await transport.start();
    await transport.setVideoEnabled(true);
    await transport.switchCamera("back");

    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: { deviceId: { exact: "front" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      video: { deviceId: { exact: "back" } },
    });
    expect(frontStop).toHaveBeenCalledOnce();
    expect(onVideoStream).toHaveBeenLastCalledWith(backCamera);

    transport.stop();
  });

  it("restores the previous camera when a live switch fails", async () => {
    const audioTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const firstFrontTrack = Object.assign(new EventTarget(), {
      stop: vi.fn(),
      readyState: "live",
      getSettings: () => ({ deviceId: "front" }),
    }) as unknown as MediaStreamTrack;
    const restoredFrontTrack = Object.assign(new EventTarget(), {
      stop: vi.fn(),
      readyState: "live",
      getSettings: () => ({ deviceId: "front" }),
    }) as unknown as MediaStreamTrack;
    const audio = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const firstFrontCamera = {
      getVideoTracks: () => [firstFrontTrack],
      getTracks: () => [firstFrontTrack],
    } as unknown as MediaStream;
    const restoredFrontCamera = {
      getVideoTracks: () => [restoredFrontTrack],
      getTracks: () => [restoredFrontTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockResolvedValueOnce(firstFrontCamera)
      .mockRejectedValueOnce(new DOMException("missing", "OverconstrainedError"))
      .mockResolvedValueOnce(restoredFrontCamera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const onVideoStream = vi.fn();
    const context = {
      client: {} as never,
      sessionKey: "main",
      callbacks: { onVideoStream },
      videoDeviceId: "front",
    };
    const transport = new WebRtcSdpRealtimeTalkTransport(
      { provider: "openai", transport: "webrtc", clientSecret: "test-client-secret" },
      context,
    );

    await transport.start();
    await transport.setVideoEnabled(true);
    await expect(transport.switchCamera("missing")).rejects.toThrow(
      "The selected camera is unavailable",
    );

    expect(getUserMedia).toHaveBeenNthCalledWith(4, {
      video: { deviceId: { exact: "front" } },
    });
    expect(context.videoDeviceId).toBe("front");
    expect(onVideoStream).toHaveBeenLastCalledWith(restoredFrontCamera);

    transport.stop();
  });
});
