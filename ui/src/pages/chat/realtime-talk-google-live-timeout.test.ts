// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import { prepareRealtimeTalkTestInput } from "./realtime-talk-input.test-support.ts";
import type {
  RealtimeTalkCallbacks,
  RealtimeTalkJsonPcmWebSocketSessionResult,
} from "./realtime-talk-shared.ts";

const SETUP_TIMEOUT_MS = 30_000;
const sockets: FakeGoogleLiveWebSocket[] = [];
const audioContexts: FakeAudioContext[] = [];
let stopInputTrack: ReturnType<typeof vi.fn>;

class FakeGoogleLiveWebSocket extends EventTarget {
  static OPEN = 1;

  readyState = FakeGoogleLiveWebSocket.OPEN;
  binaryType: BinaryType = "blob";

  constructor(readonly url: string) {
    super();
    sockets.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.dispatchEvent(new Event("open"));
  }

  emitMessage(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  emitClose(): void {
    this.dispatchEvent(new Event("close"));
  }

  emitError(): void {
    this.dispatchEvent(new Event("error"));
  }
}

class FakeAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;
  readonly close = vi.fn(async () => undefined);

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 24_000;
    audioContexts.push(this);
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

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      disconnect() {},
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
    };
  }
}

function createSession(): RealtimeTalkJsonPcmWebSocketSessionResult {
  return {
    provider: "google",
    transport: "provider-websocket",
    protocol: "google-live-bidi",
    clientSecret: ["auth_tokens", "browser-timeout-test"].join("/"),
    websocketUrl:
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 16_000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24_000,
    },
  };
}

async function createTransport(callbacks: RealtimeTalkCallbacks = {}) {
  return new GoogleLiveRealtimeTalkTransport(createSession(), {
    input: await prepareRealtimeTalkTestInput(),
    callbacks,
    client: { request: vi.fn(), addEventListener: vi.fn() } as never,
    sessionKey: "main",
  });
}

function latestSocket(): FakeGoogleLiveWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("missing Google Live WebSocket");
  }
  return socket;
}

async function beginTransport(transport: GoogleLiveRealtimeTalkTransport): Promise<{
  start: Promise<"ready" | "cancelled">;
  socket: FakeGoogleLiveWebSocket;
}> {
  const start = transport.start();
  await vi.advanceTimersByTimeAsync(0);
  return { start, socket: latestSocket() };
}

describe("Google Live setup timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    audioContexts.length = 0;
    stopInputTrack = vi.fn();
    vi.stubGlobal("WebSocket", FakeGoogleLiveWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const inputTrack = Object.assign(new EventTarget(), { stop: stopInputTrack });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [inputTrack],
        })),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("releases browser resources when the WebSocket never opens", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ onStatus, onTalkEvent });

    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    socket.readyState = 0;
    const rejected = expect(start).rejects.toThrow("Realtime connection timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(audioContexts).toHaveLength(2);
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
    expect(socket.readyState).toBe(3);
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out an open socket that never completes Google setup", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });

    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    socket.emitOpen();
    const rejected = expect(start).rejects.toThrow("Realtime connection timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
  });

  it("does not publish provisional terminal callbacks when setup times out", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn(() => {
      throw new Error("talk callback must remain provisional");
    });
    const transport = await createTransport({ onStatus, onTalkEvent });

    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    onStatus.mockImplementation(() => {
      throw new Error("status callback must remain provisional");
    });
    socket.readyState = 0;
    const rejected = expect(start).rejects.toThrow("Realtime connection timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
    expect(socket.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["close", "Realtime connection closed"],
    ["error", "Realtime connection failed"],
  ] as const)("rejects startup when the WebSocket emits %s", async (event, detail) => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });
    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    const rejected = expect(start).rejects.toThrow(detail);

    if (event === "close") {
      socket.emitClose();
    } else {
      socket.emitError();
    }

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when the socket closes after setup but before activation", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });
    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    socket.emitOpen();
    socket.emitMessage({ setupComplete: {} });
    await Promise.resolve();
    const rejected = expect(start).rejects.toThrow("Realtime connection closed");

    socket.emitClose();

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases resources when a readiness callback throws during activation", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });
    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    onStatus.mockImplementation(() => {
      throw new Error("consumer failed");
    });
    socket.emitOpen();
    socket.emitMessage({ setupComplete: {} });
    await expect(start).resolves.toBe("ready");

    expect(() => transport.activate()).toThrow("consumer failed");
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
  });

  it("reclaims the meter when an input-level callback cancels activation", async () => {
    let stopDuringActivation: () => void = () => undefined;
    const onInputLevel = vi.fn(() => stopDuringActivation());
    const transport = await createTransport({ onInputLevel });
    stopDuringActivation = () => transport.stop({ emitClosed: false });
    const { start, socket } = await beginTransport(transport);
    socket.emitOpen();
    socket.emitMessage({ setupComplete: {} });
    await expect(start).resolves.toBe("ready");

    expect(() => transport.activate()).toThrow("Google Live transport activation cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
  });

  it("clears the deadline after Google setup completes", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });

    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    socket.emitOpen();
    socket.emitMessage({ setupComplete: {} });
    await expect(start).resolves.toBe("ready");
    expect(onStatus).not.toHaveBeenCalled();
    transport.activate();
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).toHaveBeenCalledExactlyOnceWith("listening");
    transport.stop();
  });

  it("clears the deadline when the transport stops", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });

    const { start } = await beginTransport(transport);
    onStatus.mockClear();
    transport.stop();
    await expect(start).resolves.toBe("cancelled");
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
