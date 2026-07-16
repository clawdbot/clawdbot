// Xai tests cover realtime voice provider plugin behavior.
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket, isProviderAuthProfileConfiguredMock, resolveApiKeyForProviderMock } =
  vi.hoisted(() => {
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

    return {
      FakeWebSocket: MockWebSocket,
      isProviderAuthProfileConfiguredMock: vi.fn(() => false),
      resolveApiKeyForProviderMock: vi.fn(
        async (): Promise<{ apiKey: string | undefined }> => ({ apiKey: undefined }),
      ),
    };
  });

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: isProviderAuthProfileConfiguredMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  session?: {
    voice?: string;
    model?: string;
    turn_detection?: {
      type?: string;
      threshold?: number;
      silence_duration_ms?: number;
      prefix_padding_ms?: number;
    };
    audio?: {
      input?: { format?: Record<string, unknown>; transcription?: Record<string, unknown> };
      output?: { format?: Record<string, unknown> };
    };
    resumption?: {
      enabled?: boolean;
    };
    reasoning?: {
      effort?: string;
    };
    tools?: unknown[];
    tool_choice?: string;
  };
};

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload: string) => JSON.parse(payload) as SentRealtimeEvent);
}

function requireSocket(index = 0): FakeWebSocketInstance {
  const socket = FakeWebSocket.instances[index];
  if (!socket) {
    throw new Error(`expected xAI realtime socket at index ${index}`);
  }
  return socket;
}

function requireSession(socket: FakeWebSocketInstance, index = 0): Record<string, unknown> {
  const session = parseSent(socket)[index]?.session;
  if (!session || typeof session !== "object") {
    throw new Error("expected session.update payload");
  }
  return session as Record<string, unknown>;
}

describe("buildXaiRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    isProviderAuthProfileConfiguredMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReturnValue(false);
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    delete process.env.XAI_API_KEY;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("declares realtime Talk capabilities for catalog selection", () => {
    const provider = buildXaiRealtimeVoiceProvider();

    expect(provider.defaultModel).toBe("grok-voice-latest");
    expect(provider.capabilities).toEqual({
      transports: ["gateway-relay"],
      inputAudioFormats: [
        { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
        { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      ],
      outputAudioFormats: [
        { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
        { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      ],
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
      supportsSessionResumption: true,
    });
  });

  it("does not advertise continuing realtime tool results", () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    expect(bridge.supportsToolResultContinuation).toBe(false);
  });

  it("requires xAI credentials for native realtime websocket bridges", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: { model: "grok-voice-latest" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow("xAI credentials missing for realtime voice");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("uses XAI_API_KEY for default Grok realtime bridges", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: { model: "grok-voice-latest", voice: "ara" },
      instructions: "Speak briefly.",
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    bridge.close();

    const url = socket.args[0] as string;
    expect(url).toContain("wss://api.x.ai/v1/realtime?model=grok-voice-latest");
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer xai-env");
    expect(options).toEqual(expect.objectContaining({ maxPayload: 16 * 1024 * 1024 }));
    const session = requireSession(socket);
    expect(session.voice).toBe("ara");
    expect(session.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.85,
      prefix_padding_ms: 333,
      silence_duration_ms: 500,
    });
    expect(session.audio).toEqual({
      input: {
        format: { type: "audio/pcmu" },
        transcription: { model: "grok-transcribe" },
      },
      output: { format: { type: "audio/pcmu" } },
    });
  });

  it("does not enable xAI session resumption by default", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    bridge.close();

    expect(requireSession(socket).resumption).toBeUndefined();
  });

  it("rejects generic response modes that xAI server VAD cannot disable", () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const callbacks = { onAudio: vi.fn(), onClearAudio: vi.fn() };

    expect(() =>
      provider.createBridge({
        providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
        autoRespondToAudio: false,
        ...callbacks,
      }),
    ).toThrow('use consultRouting: "provider-direct"');
    expect(() =>
      provider.createBridge({
        providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
        interruptResponseOnInputAudio: false,
        ...callbacks,
      }),
    ).toThrow("requires automatic server-VAD interruption handling");
    expect(() =>
      provider.createBridge({
        providerConfig: {
          apiKey: "xai-test", // pragma: allowlist secret
          interruptResponseOnInputAudio: false,
        },
        ...callbacks,
      }),
    ).toThrow("requires automatic server-VAD interruption handling");
  });

  it("sends nested xAI session.update audio formats for g711 bridges", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      audioFormat: { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    bridge.close();

    const session = requireSession(socket);
    expect(session.audio).toEqual({
      input: {
        format: { type: "audio/pcmu" },
        transcription: { model: "grok-transcribe" },
      },
      output: { format: { type: "audio/pcmu" } },
    });
  });

  it("only forwards xAI VAD values accepted by the realtime API", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const invalidThresholdBridge = provider.createBridge({
      providerConfig: {
        apiKey: "xai-test", // pragma: allowlist secret
        vadThreshold: 1,
        silenceDurationMs: 10_001,
        prefixPaddingMs: -1,
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void invalidThresholdBridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const invalidThresholdSocket = requireSocket();
    invalidThresholdSocket.readyState = FakeWebSocket.OPEN;
    invalidThresholdSocket.emit("open");
    invalidThresholdSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "session.updated" })),
    );
    invalidThresholdBridge.close();

    expect(requireSession(invalidThresholdSocket).turn_detection).toEqual(
      expect.objectContaining({
        threshold: 0.85,
        silence_duration_ms: 500,
        prefix_padding_ms: 333,
      }),
    );

    const validThresholdBridge = provider.createBridge({
      providerConfig: {
        apiKey: "xai-test", // pragma: allowlist secret
        vadThreshold: 0.9,
        silenceDurationMs: 10_000,
        prefixPaddingMs: 0,
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void validThresholdBridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    const validThresholdSocket = requireSocket(1);
    validThresholdSocket.readyState = FakeWebSocket.OPEN;
    validThresholdSocket.emit("open");
    validThresholdSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    validThresholdBridge.close();

    expect(requireSession(validThresholdSocket).turn_detection).toEqual(
      expect.objectContaining({
        threshold: 0.9,
        silence_duration_ms: 10_000,
        prefix_padding_ms: 0,
      }),
    );
  });

  it("only forwards reasoning efforts accepted by the xAI Voice Agent API", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const callbacks = { onAudio: vi.fn(), onClearAudio: vi.fn() };
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "test" });

    expect(() =>
      provider.createBridge({
        providerConfig: {
          reasoningEffort: "low",
        },
        ...callbacks,
      }),
    ).toThrow('reasoningEffort must be "high" or "none"');
    expect(FakeWebSocket.instances).toHaveLength(0);

    const bridge = provider.createBridge({
      providerConfig: {
        reasoningEffort: "none",
      },
      ...callbacks,
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    bridge.close();

    expect(requireSession(socket).reasoning).toEqual({ effort: "none" });
  });

  it("treats xAI input transcription updates as replacements until completed", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.updated",
          item_id: "item_1",
          transcript: "open",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.updated",
          item_id: "item_1",
          transcript: "open claw",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_1",
          transcript: "OpenClaw",
        }),
      ),
    );
    bridge.close();

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("user", "OpenClaw", true);
  });

  it("buffers assistant transcript deltas and finalizes them when done has no text", async () => {
    const provider = buildXaiRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.created" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio_transcript.delta",
          delta: "Hello ",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio_transcript.delta",
          delta: "OpenClaw",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.output_audio_transcript.done" })),
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));
    bridge.close();

    expect(onTranscript).toHaveBeenNthCalledWith(1, "assistant", "Hello ", false);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "assistant", "OpenClaw", false);
    expect(onTranscript).toHaveBeenNthCalledWith(3, "assistant", "Hello OpenClaw", true);
    expect(onTranscript).toHaveBeenCalledTimes(3);
  });

  it("lets server VAD own interruption before an audio item exists", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio,
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_1" },
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })),
    );
    bridge.close();

    const sentTypes = parseSent(socket).map((event) => event.type);
    expect(sentTypes).not.toContain("response.cancel");
    expect(sentTypes).not.toContain("conversation.item.truncate");
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
  });

  it("cancels and truncates active response audio on barge-in", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio,
      onClearAudio,
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_1" },
        }),
      ),
    );
    bridge.setMediaTimestamp(1000);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          item_id: "item_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );
    bridge.setMediaTimestamp(1300);
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    bridge.close();

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).toHaveBeenCalledTimes(1);
    expect(parseSent(socket).slice(-2)).toEqual([
      { type: "response.cancel" },
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 300,
      },
    ]);
  });

  it("truncates queued playback on server-VAD barge-in without cancelling xAI", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio,
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_1" },
        }),
      ),
    );
    bridge.setMediaTimestamp(1000);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          item_id: "item_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );
    bridge.setMediaTimestamp(1250);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })),
    );
    bridge.close();

    const sent = parseSent(socket);
    expect(sent.map((event) => event.type)).not.toContain("response.cancel");
    expect(sent.slice(-1)).toEqual([
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 250,
      },
    ]);
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
  });

  it("clears relay playback on server-VAD barge-in after marks are acknowledged", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio,
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_1" },
        }),
      ),
    );
    bridge.setMediaTimestamp(1000);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          item_id: "item_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );
    bridge.acknowledgeMark?.();
    bridge.setMediaTimestamp(1250);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })),
    );
    bridge.close();

    const sentTypes = parseSent(socket).map((event) => event.type);
    expect(sentTypes).not.toContain("response.cancel");
    expect(sentTypes).not.toContain("conversation.item.truncate");
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
  });

  it("does not truncate completed assistant audio on a later user turn", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio,
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_1" },
        }),
      ),
    );
    bridge.setMediaTimestamp(1000);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          item_id: "item_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );
    bridge.acknowledgeMark?.();
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));
    bridge.setMediaTimestamp(2000);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })),
    );
    bridge.close();

    const sentTypes = parseSent(socket).map((event) => event.type);
    expect(sentTypes).not.toContain("response.cancel");
    expect(sentTypes).not.toContain("conversation.item.truncate");
    expect(onClearAudio).toHaveBeenCalledTimes(1);
  });

  it("keeps completed assistant item state so relay playback cancel can truncate it", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio,
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_1" },
        }),
      ),
    );
    bridge.setMediaTimestamp(1000);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          item_id: "item_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );
    bridge.acknowledgeMark?.();
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));
    bridge.setMediaTimestamp(1300);
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    bridge.close();

    expect(onClearAudio).toHaveBeenCalledTimes(1);
    expect(parseSent(socket).slice(-1)).toEqual([
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 300,
      },
    ]);
  });

  it("lets server VAD interrupt a new response before it produces audio", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio,
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_1" },
        }),
      ),
    );
    bridge.setMediaTimestamp(1000);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          item_id: "item_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );
    bridge.acknowledgeMark?.();
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.created",
          response: { id: "resp_2" },
        }),
      ),
    );
    bridge.setMediaTimestamp(1500);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })),
    );
    bridge.close();

    const sentTypes = parseSent(socket).map((event) => event.type);
    expect(sentTypes).not.toContain("response.cancel");
    expect(sentTypes).not.toContain("conversation.item.truncate");
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
  });

  it("deduplicates repeated function-call arguments done events", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "item_tool_1",
          name: "openclaw_agent_consult",
          call_id: "call_1",
          delta: JSON.stringify({ question: "delegate this" }),
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_tool_1",
          name: "openclaw_agent_consult",
          call_id: "call_1",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_tool_1",
          name: "openclaw_agent_consult",
          call_id: "call_1",
          arguments: JSON.stringify({ question: "delegate this" }),
        }),
      ),
    );

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_tool_1",
      callId: "call_1",
      name: "openclaw_agent_consult",
      args: { question: "delegate this" },
    });
  });

  it("waits for all parallel tool results before sending response.create", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    for (const callId of ["call_1", "call_2"]) {
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "response.function_call_arguments.done",
            item_id: `item_${callId}`,
            name: "openclaw_agent_consult",
            call_id: callId,
            arguments: JSON.stringify({ question: callId }),
          }),
        ),
      );
    }

    await bridge.submitToolResult("call_1", { text: "first" });
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toEqual([]);

    await bridge.submitToolResult("call_2", { text: "second" });
    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_2",
          output: JSON.stringify({ text: "second" }),
        },
      },
      { type: "response.create" },
    ]);
  });

  it("does not send unsupported interim willContinue tool results to xAI", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_call_1",
          name: "openclaw_agent_consult",
          call_id: "call_1",
          arguments: JSON.stringify({ question: "call_1" }),
        }),
      ),
    );

    await bridge.submitToolResult("call_1", { status: "working" }, { willContinue: true });
    expect(parseSent(socket).filter((event) => event.type === "conversation.item.create")).toEqual(
      [],
    );

    await bridge.submitToolResult("call_1", { text: "final" });
    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ text: "final" }),
        },
      },
      { type: "response.create" },
    ]);
  });

  it("defers response.create for tool results until queued playback marks drain", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onMark = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
      onMark,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.created" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          item_id: "item_audio_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        }),
      ),
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_call_1",
          name: "openclaw_agent_consult",
          call_id: "call_1",
          arguments: JSON.stringify({ question: "call_1" }),
        }),
      ),
    );

    await bridge.submitToolResult("call_1", { text: "final" });
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toEqual([]);
    const markName = onMark.mock.calls[0]?.[0];
    expect(markName).toMatch(/^audio-/);

    bridge.acknowledgeMark?.("stale-mark");
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toEqual([]);

    bridge.acknowledgeMark?.(markName);
    expect(parseSent(socket).slice(-1)).toEqual([{ type: "response.create" }]);
  });

  it("preserves pending parallel tool calls across resumed reconnects", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_tools" } }),
      ),
    );
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    for (const callId of ["call_1", "call_2"]) {
      firstSocket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "response.function_call_arguments.done",
            item_id: `item_${callId}`,
            name: "openclaw_agent_consult",
            call_id: callId,
            arguments: JSON.stringify({ question: callId }),
          }),
        ),
      );
    }

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_tools");
    secondSocket.readyState = FakeWebSocket.OPEN;
    secondSocket.emit("open");
    secondSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

    await bridge.submitToolResult("call_1", { text: "first" });
    expect(parseSent(secondSocket).filter((event) => event.type === "response.create")).toEqual([]);

    await bridge.submitToolResult("call_2", { text: "second" });
    expect(parseSent(secondSocket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_2",
          output: JSON.stringify({ text: "second" }),
        },
      },
      { type: "response.create" },
    ]);
    bridge.close();
  });

  it("delivers a tool call first observed in resumed item replay", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_replay" } }),
      ),
    );
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    secondSocket.readyState = FakeWebSocket.OPEN;
    secondSocket.emit("open");
    secondSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.created",
          item: {
            id: "item_replayed_call",
            type: "function_call",
            call_id: "call_replayed",
            name: "openclaw_agent_consult",
            arguments: JSON.stringify({ question: "recover me" }),
          },
        }),
      ),
    );

    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_replayed_call",
      callId: "call_replayed",
      name: "openclaw_agent_consult",
      args: { question: "recover me" },
    });
    bridge.close();
  });

  it("fails closed when a tool output was not acknowledged before reconnect", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
      onEvent,
      onClose,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_lost_output" } }),
      ),
    );
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_lost_output",
          call_id: "call_lost_output",
          name: "openclaw_agent_consult",
          arguments: JSON.stringify({ question: "recover output" }),
        }),
      ),
    );
    await bridge.submitToolResult("call_lost_output", { text: "recovered" });

    firstSocket.close(1006, "output acknowledgement lost");
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.reconnect.blocked",
      detail: "reason=websocket-close unacknowledgedToolResults=1",
    });
    expect(onClose).toHaveBeenCalledWith("error");
    bridge.close();
  });

  it("does not retry a tool output acknowledged by resumed item replay", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_saved_output" } }),
      ),
    );
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "item_saved_output",
          call_id: "call_saved_output",
          name: "openclaw_agent_consult",
          arguments: JSON.stringify({ question: "saved output" }),
        }),
      ),
    );
    await bridge.submitToolResult("call_saved_output", { text: "saved" });
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.added",
          item: {
            id: "item_saved_result",
            type: "function_call_output",
            call_id: "call_saved_output",
            output: JSON.stringify({ text: "saved" }),
          },
        }),
      ),
    );

    firstSocket.close(1006, "connection lost after output acknowledgement");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    secondSocket.readyState = FakeWebSocket.OPEN;
    secondSocket.emit("open");
    secondSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    for (const item of [
      {
        id: "item_saved_output",
        type: "function_call",
        call_id: "call_saved_output",
        name: "openclaw_agent_consult",
        arguments: JSON.stringify({ question: "saved output" }),
      },
      {
        id: "item_saved_result",
        type: "function_call_output",
        call_id: "call_saved_output",
        output: JSON.stringify({ text: "saved" }),
      },
    ]) {
      secondSocket.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "conversation.item.created", item })),
      );
    }

    await vi.advanceTimersByTimeAsync(500);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(
      parseSent(secondSocket).filter((event) => event.type === "conversation.item.create"),
    ).toEqual([]);
    bridge.close();
  });

  it("queues tool results submitted while a resumed session is reconnecting", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_tool_queue" } }),
      ),
    );
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    for (const callId of ["call_1", "call_2"]) {
      firstSocket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "response.function_call_arguments.done",
            item_id: `item_${callId}`,
            name: "openclaw_agent_consult",
            call_id: callId,
            arguments: JSON.stringify({ question: callId }),
          }),
        ),
      );
    }

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_tool_queue");
    secondSocket.readyState = FakeWebSocket.OPEN;
    secondSocket.emit("open");

    await bridge.submitToolResult("call_1", { text: "first" });
    expect(
      parseSent(secondSocket).filter((event) => event.type === "conversation.item.create"),
    ).toEqual([]);

    secondSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    expect(parseSent(secondSocket).filter((event) => event.type === "response.create")).toEqual([]);
    expect(parseSent(secondSocket).slice(-1)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ text: "first" }),
        },
      },
    ]);

    await bridge.submitToolResult("call_2", { text: "second" });
    expect(parseSent(secondSocket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_2",
          output: JSON.stringify({ text: "second" }),
        },
      },
      { type: "response.create" },
    ]);
    bridge.close();
  });

  it("queues text turns submitted while a resumed session is reconnecting", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_text_queue" } }),
      ),
    );
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_text_queue");
    secondSocket.readyState = FakeWebSocket.OPEN;
    secondSocket.emit("open");

    bridge.sendUserMessage?.("OpenClaw finished checking.");
    expect(
      parseSent(secondSocket).filter((event) => event.type === "conversation.item.create"),
    ).toEqual([]);

    secondSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    expect(parseSent(secondSocket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "OpenClaw finished checking." }],
        },
      },
      { type: "response.create" },
    ]);
    bridge.close();
  });

  it("exhausts reconnect attempts when websocket opens without session setup", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onEvent,
      onClose,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_reconnect" } }),
      ),
    );
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    firstSocket.close(1006, "connection lost");

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const delayMs = 1000 * 2 ** (attempt - 1);
      await vi.advanceTimersByTimeAsync(delayMs);
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(attempt + 1));
      const socket = requireSocket(attempt);
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit("open");
      socket.close(1006, "session setup failed");
    }

    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: "reason=websocket-close attempts=5",
      }),
    );
    expect(onClose).toHaveBeenCalledWith("error");
    bridge.close();
  });

  it("does not replay ready callbacks after reconnect", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onReady = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_ready" } }),
      ),
    );
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_ready");
    secondSocket.readyState = FakeWebSocket.OPEN;
    secondSocket.emit("open");
    secondSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    bridge.close();

    expect(onReady).toHaveBeenCalledOnce();
  });

  it("enables xAI session resumption and reconnects with the created conversation id", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    expect(requireSession(firstSocket).resumption).toEqual({ enabled: true });
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_resume" } }),
      ),
    );
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_resume");
    secondSocket.readyState = FakeWebSocket.OPEN;
    secondSocket.emit("open");
    expect(requireSession(secondSocket).resumption).toEqual({ enabled: true });
    bridge.close();
  });

  it("fails closed instead of reconnecting without a conversation id", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onEvent,
      onClose,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.reconnect.blocked",
      detail: "reason=websocket-close missingConversationId=true",
    });
    expect(onClose).toHaveBeenCalledWith("error");
    bridge.close();
  });

  it("fails closed instead of reconnecting when xAI session resumption is disabled", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onEvent,
      onClose,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "conversation.created", conversation: { id: "conv_default" } }),
      ),
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.reconnect.blocked",
      detail: "reason=websocket-close sessionResumption=false",
    });
    expect(onClose).toHaveBeenCalledWith("error");
    bridge.close();
  });

  it("does not retry after startup websocket errors", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onClose,
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("error", new Error("bad auth"));

    await expect(connecting).rejects.toThrow("bad auth");
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("forwards configured provider tools in session.update", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const provider = buildXaiRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      tools: [
        {
          type: "function",
          name: "openclaw_agent_consult",
          description: "Consult OpenClaw",
          parameters: { type: "object", properties: {} },
        },
      ],
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    bridge.close();

    const session = requireSession(socket);
    expect(session.tools).toHaveLength(1);
    expect(session.tool_choice).toBe("auto");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
