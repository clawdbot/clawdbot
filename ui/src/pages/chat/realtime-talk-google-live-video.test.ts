// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../src/talk/describe-view-tool.js";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import type { RealtimeTalkCallbacks } from "./realtime-talk-shared.ts";

class FakeGoogleLiveWebSocket extends EventTarget {
  static OPEN = 1;
  static instance: FakeGoogleLiveWebSocket | undefined;

  readyState = FakeGoogleLiveWebSocket.OPEN;
  readonly sent: unknown[] = [];
  binaryType: BinaryType = "blob";

  constructor(readonly url: string) {
    super();
    FakeGoogleLiveWebSocket.instance = this;
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.dispatchEvent(new Event("open"));
  }

  emitMessage(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

class FakeAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 24_000;
  }

  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }

  createScriptProcessor() {
    return { connect() {}, disconnect() {}, onaudioprocess: null };
  }

  createGain() {
    return { connect() {}, disconnect() {}, gain: { value: 1 } };
  }

  async close(): Promise<void> {}
}

function createTransport(callbacks: RealtimeTalkCallbacks) {
  return new GoogleLiveRealtimeTalkTransport(
    {
      provider: "google",
      transport: "provider-websocket",
      protocol: "google-live-bidi",
      // Fake harness token, assembled so secret scanners do not flag it.
      clientSecret: ["auth_tokens", "browser-video-test"].join("/"),
      websocketUrl:
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 16_000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24_000,
      },
    },
    {
      callbacks,
      client: { request: vi.fn(), addEventListener: vi.fn() } as never,
      sessionKey: "main",
      videoEnabled: true,
    },
  );
}

describe("Google Live Video Talk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeGoogleLiveWebSocket.instance = undefined;
    vi.stubGlobal("WebSocket", FakeGoogleLiveWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("streams bounded camera frames directly and answers describe_view calls", async () => {
    const audioStop = vi.fn();
    const videoStop = vi.fn();
    const audioTrack = { stop: audioStop } as unknown as MediaStreamTrack;
    const videoTrack = {
      stop: videoStop,
      readyState: "live",
      enabled: true,
      muted: false,
    } as unknown as MediaStreamTrack;
    const audio = {
      getAudioTracks: () => [audioTrack],
      getTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const camera = {
      getVideoTracks: () => [videoTrack],
      getTracks: () => [videoTrack],
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
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (element instanceof HTMLVideoElement) {
        Object.defineProperties(element, {
          readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
          videoWidth: { configurable: true, value: 1280 },
          videoHeight: { configurable: true, value: 720 },
        });
        vi.spyOn(element, "play").mockResolvedValue(undefined);
      }
      return element;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValueOnce(`data:image/jpeg;base64,${"x".repeat(600 * 1024)}`)
      .mockReturnValue("data:image/jpeg;base64,gemini-camera-frame");
    const onStatus = vi.fn();
    const onVideoStream = vi.fn();
    const transport = createTransport({ onStatus, onVideoStream });

    await transport.start();
    const ws = FakeGoogleLiveWebSocket.instance;
    if (!ws) {
      throw new Error("missing Google Live WebSocket");
    }
    ws.emitOpen();
    ws.emitMessage({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.sent).toContainEqual({
      realtimeInput: {
        video: { data: "gemini-camera-frame", mimeType: "image/jpeg" },
      },
    });
    for (const message of ws.sent) {
      expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(
        512 * 1024,
      );
    }
    ws.emitMessage({
      toolCall: {
        functionCalls: [
          { id: "call-camera", name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, args: {} },
        ],
      },
    });
    await Promise.resolve();
    expect(ws.sent).toContainEqual({
      toolResponse: {
        functionResponses: [
          {
            id: "call-camera",
            name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
            response: { ok: true, cameraStreamActive: true },
          },
        ],
      },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true });
    expect(onVideoStream).toHaveBeenCalledWith(expect.any(TestMediaStream));
    expect(onStatus).toHaveBeenCalledWith("listening");

    const countVideoMessages = () =>
      ws.sent.filter((message) => JSON.stringify(message).includes('"video"')).length;
    expect(countVideoMessages()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(countVideoMessages()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(countVideoMessages()).toBe(2);

    (videoTrack as { readyState: MediaStreamTrackState }).readyState = "ended";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(countVideoMessages()).toBe(2);
    ws.emitMessage({
      toolCall: {
        functionCalls: [
          { id: "call-ended-camera", name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, args: {} },
        ],
      },
    });
    await Promise.resolve();
    expect(ws.sent).toContainEqual({
      toolResponse: {
        functionResponses: [
          {
            id: "call-ended-camera",
            name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
            response: {
              ok: false,
              cameraStreamActive: false,
              error: "Camera stream is unavailable",
            },
          },
        ],
      },
    });

    const sentBeforeStop = ws.sent.length;
    transport.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ws.sent).toHaveLength(sentBeforeStop);
    expect(onVideoStream).toHaveBeenLastCalledWith(null);
    expect(audioStop).toHaveBeenCalledOnce();
    expect(videoStop).toHaveBeenCalledOnce();
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
    const transport = createTransport({});

    const start = transport.start();
    await Promise.resolve();
    transport.stop();
    resolveCamera(camera);
    await start;

    expect(audioStop).toHaveBeenCalledOnce();
    expect(videoStop).toHaveBeenCalledOnce();
    expect(FakeGoogleLiveWebSocket.instance).toBeUndefined();
  });
});
