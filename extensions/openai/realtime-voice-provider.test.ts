import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;
    sent: string[] = [];
    closed = false;
    terminated = false;

    constructor() {
      MockWebSocket.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }

    terminate(): void {
      this.terminated = true;
      this.close(1006, "terminated");
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  session?: {
    input_audio_format?: string;
    output_audio_format?: string;
  };
};

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload: string) => JSON.parse(payload) as SentRealtimeEvent);
}

describe("buildOpenAIRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it("normalizes provider-owned voice settings from raw provider config", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            model: "gpt-realtime-1.5",
            voice: "verse",
            temperature: 0.6,
            silenceDurationMs: 850,
            vadThreshold: 0.35,
          },
        },
      },
    });

    expect(resolved).toEqual({
      model: "gpt-realtime-1.5",
      voice: "verse",
      temperature: 0.6,
      silenceDurationMs: 850,
      vadThreshold: 0.35,
    });
  });

  it("waits for session.updated before draining audio and firing onReady", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onReady = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      instructions: "Be helpful.",
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    await connecting;

    bridge.sendAudio(Buffer.from("before-ready"));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));

    expect(onReady).not.toHaveBeenCalled();
    expect(parseSent(socket).map((event) => event.type)).toEqual(["session.update"]);
    expect(parseSent(socket)[0]?.session).toMatchObject({
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
    });
    expect(bridge.isConnected()).toBe(false);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
    ]);
    expect(bridge.isConnected()).toBe(true);
  });

  it("can request PCM16 24 kHz realtime audio for Chrome command-pair bridges", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    await connecting;

    expect(parseSent(socket)[0]?.session).toMatchObject({
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
    });
  });

  it("settles cleanly when closed before the websocket opens", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onClose,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    bridge.close();

    await expect(connecting).resolves.toBeUndefined();
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
    expect(onClose).toHaveBeenCalledWith("completed");
  });
});
