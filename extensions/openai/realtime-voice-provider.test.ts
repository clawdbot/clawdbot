import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket, fetchWithSsrFGuardMock } = vi.hoisted(() => {
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
    args: unknown[];

    constructor(...args: unknown[]) {
      this.args = args;
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

  return { FakeWebSocket: MockWebSocket, fetchWithSsrFGuardMock: vi.fn() };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  item_id?: string;
  content_index?: number;
  audio_end_ms?: number;
  session?: {
    input_audio_format?: string;
    output_audio_format?: string;
  };
};

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload: string) => JSON.parse(payload) as SentRealtimeEvent);
}

function createJsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("buildOpenAIRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    fetchWithSsrFGuardMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds OpenClaw attribution headers to native realtime websocket requests", () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void bridge.connect();
    bridge.close();

    const socket = FakeWebSocket.instances[0];
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers).toMatchObject({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });

  it("returns browser-safe OpenClaw attribution headers for native WebRTC offers", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: createJsonResponse({
        client_secret: { value: "client-secret-123" },
        expires_at: 1_765_000_000,
      }),
      release: vi.fn(async () => undefined),
    });
    const provider = buildOpenAIRealtimeVoiceProvider();
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }

    const session = await provider.createBrowserSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      instructions: "Be concise.",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/realtime/client_secrets",
        init: expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test", // pragma: allowlist secret
            "Content-Type": "application/json",
            originator: "openclaw",
            version: "2026.3.22",
            "User-Agent": "openclaw/2026.3.22",
          }),
        }),
      }),
    );
    expect(session).toMatchObject({
      provider: "openai",
      transport: "webrtc-sdp",
      clientSecret: "client-secret-123",
      offerUrl: "https://api.openai.com/v1/realtime/calls",
      offerHeaders: {
        originator: "openclaw",
        version: "2026.3.22",
      },
    });
    expect((session as { offerHeaders?: Record<string, string> }).offerHeaders).not.toHaveProperty(
      "User-Agent",
    );
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

  it("truncates externally interrupted playback after an immediate mark acknowledgement", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    let bridge: ReturnType<typeof provider.createBridge>;
    bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio,
      onClearAudio,
      onMark: () => bridge.acknowledgeMark(),
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    await connecting;
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

    bridge.setMediaTimestamp(1000);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.created", response: { id: "resp_1" } })),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.audio.delta",
          item_id: "item_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );
    bridge.setMediaTimestamp(1240);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).toHaveBeenCalledTimes(1);
    expect(parseSent(socket)).toContainEqual({ type: "response.cancel" });
    expect(parseSent(socket)).toContainEqual({
      type: "conversation.item.truncate",
      item_id: "item_1",
      content_index: 0,
      audio_end_ms: 240,
    });
  });
});
