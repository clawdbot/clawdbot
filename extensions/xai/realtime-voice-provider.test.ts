// Xai tests cover realtime voice provider plugin behavior.
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS } from "./realtime-voice-config.js";
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
      deferClose = false;
      pendingClose: { code: number; reason: Buffer } | undefined;
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

      emitServer(event: unknown): void {
        this.emit("message", Buffer.from(JSON.stringify(event)));
      }

      open(): void {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open");
      }

      send(payload: string): void {
        this.sent.push(payload);
      }

      close(code?: number, reason?: string): void {
        this.closed = true;
        this.readyState = MockWebSocket.CLOSED;
        const closeEvent = { code: code ?? 1000, reason: Buffer.from(reason ?? "") };
        if (this.deferClose) {
          this.pendingClose = closeEvent;
          return;
        }
        this.emit("close", closeEvent.code, closeEvent.reason);
      }

      terminate(): void {
        this.terminated = true;
        this.close(1006, "terminated");
      }

      flushClose(): void {
        const closeEvent = this.pendingClose;
        this.pendingClose = undefined;
        if (closeEvent) {
          this.emit("close", closeEvent.code, closeEvent.reason);
        }
      }
    }

    return {
      FakeWebSocket: MockWebSocket,
      isProviderAuthProfileConfiguredMock: vi.fn((_params: { agentDir?: string }) => false),
      resolveApiKeyForProviderMock: vi.fn(
        async (_params: { agentDir?: string }): Promise<{ apiKey: string | undefined }> => ({
          apiKey: undefined,
        }),
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
type TestBridgeOptions = Parameters<
  ReturnType<typeof buildXaiRealtimeVoiceProvider>["createBridge"]
>[0];
type TestBridge = ReturnType<ReturnType<typeof buildXaiRealtimeVoiceProvider>["createBridge"]>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  item?: {
    type?: string;
  };
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

function waitForRealtimeState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
}

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

function createTestBridge(options: Partial<TestBridgeOptions> = {}): TestBridge {
  return buildXaiRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    ...options,
  });
}

async function startRealtimeBridge(bridge: TestBridge, index = 0, conversationId?: string) {
  const connecting = bridge.connect();
  await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(index + 1));
  const socket = requireSocket(index);
  socket.open();
  if (conversationId) {
    socket.emitServer({ type: "conversation.created", conversation: { id: conversationId } });
  }
  socket.emitServer({ type: "session.updated" });
  return { connecting, socket };
}

async function openRealtimeBridge(bridge: TestBridge, index = 0, conversationId?: string) {
  const { connecting, socket } = await startRealtimeBridge(bridge, index, conversationId);
  await connecting;
  return socket;
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
    const bridge = createTestBridge();

    expect(bridge.supportsToolResultContinuation).toBe(false);
  });

  it("requires xAI credentials for native realtime websocket bridges", async () => {
    const bridge = createTestBridge({
      cfg: {} as never,
      providerConfig: { model: "grok-voice-latest" },
    });

    await expect(bridge.connect()).rejects.toThrow("xAI credentials missing for realtime voice");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("checks realtime readiness in the selected agent directory", () => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ agentDir }) => agentDir === "/tmp/openclaw-molty-agent",
    );
    const provider = buildXaiRealtimeVoiceProvider();
    const cfg = {
      agents: {
        list: [
          { id: "helper", agentDir: "/tmp/openclaw-helper-agent" },
          { id: "molty", agentDir: "/tmp/openclaw-molty-agent" },
        ],
      },
    } as never;

    expect(provider.isConfigured({ cfg, providerConfig: {}, agentId: "molty" })).toBe(true);
    expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith({
      provider: "xai",
      cfg,
      agentDir: "/tmp/openclaw-molty-agent",
    });
  });

  it("resolves realtime auth from the selected agent directory", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async ({ agentDir }) => ({
      apiKey: agentDir === "/tmp/openclaw-molty-agent" ? "xai-molty" : undefined,
    }));
    const cfg = {
      agents: {
        list: [
          { id: "helper", agentDir: "/tmp/openclaw-helper-agent" },
          { id: "molty", agentDir: "/tmp/openclaw-molty-agent" },
        ],
      },
    } as never;
    const bridge = createTestBridge({
      cfg,
      agentId: "molty",
      providerConfig: {},
    });

    const { connecting, socket } = await startRealtimeBridge(bridge);
    await connecting;
    bridge.close();

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({
      provider: "xai",
      cfg,
      agentDir: "/tmp/openclaw-molty-agent",
    });
    expect((socket.args[1] as { headers?: Record<string, string> }).headers?.Authorization).toBe(
      "Bearer xai-molty",
    );
  });

  it("coalesces concurrent connects and ignores connects after readiness", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge();

    const firstConnect = bridge.connect();
    const secondConnect = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = requireSocket();
    socket.open();
    socket.emitServer({ type: "session.updated" });

    await Promise.all([firstConnect, secondConnect]);
    await bridge.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(bridge.isConnected()).toBe(true);
    bridge.close();
  });

  it("cancels credential resolution without creating a late socket", async () => {
    let resolveCredentials: ((value: { apiKey: string | undefined }) => void) | undefined;
    resolveApiKeyForProviderMock.mockImplementation(
      () =>
        new Promise<{ apiKey: string | undefined }>((resolve) => {
          resolveCredentials = resolve;
        }),
    );
    const onClose = vi.fn();
    const bridge = createTestBridge({
      cfg: {} as never,
      providerConfig: {},
      onClose,
    });

    const connecting = bridge.connect();
    await waitForRealtimeState(() => expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce());
    bridge.close();
    bridge.close();
    await connecting;

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
    expect(FakeWebSocket.instances).toHaveLength(0);

    resolveCredentials?.({ apiKey: "xai-late" }); // pragma: allowlist secret
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(0));
  });

  it("starts the socket timeout after async credential resolution", async () => {
    vi.useFakeTimers();
    let resolveCredentials: ((value: { apiKey: string | undefined }) => void) | undefined;
    resolveApiKeyForProviderMock.mockImplementation(
      () =>
        new Promise<{ apiKey: string | undefined }>((resolve) => {
          resolveCredentials = resolve;
        }),
    );
    const bridge = createTestBridge({
      cfg: {} as never,
      providerConfig: {},
    });

    const connecting = bridge.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(0);

    resolveCredentials?.({ apiKey: "xai-oauth" }); // pragma: allowlist secret
    await vi.advanceTimersByTimeAsync(0);
    const socket = requireSocket();
    socket.open();
    socket.emitServer({ type: "session.updated" });
    await connecting;

    const options = socket.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer xai-oauth");
    bridge.close();
  });

  it("retains the socket timeout after async credential resolution", async () => {
    vi.useFakeTimers();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "xai-oauth" });
    const bridge = createTestBridge({
      cfg: {} as never,
      providerConfig: {},
    });

    const connecting = bridge.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = requireSocket();
    const timeoutAssertion = expect(connecting).rejects.toThrow(
      "xAI realtime voice connection timeout",
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await timeoutAssertion;
    expect(socket.terminated).toBe(true);
    expect(bridge.isConnected()).toBe(false);
  });

  it("starts a replacement immediately after canceling pending credentials", async () => {
    let resolveFirstCredentials: ((value: { apiKey: string | undefined }) => void) | undefined;
    resolveApiKeyForProviderMock
      .mockImplementationOnce(
        () =>
          new Promise<{ apiKey: string | undefined }>((resolve) => {
            resolveFirstCredentials = resolve;
          }),
      )
      .mockResolvedValue({ apiKey: "xai-replacement" }); // pragma: allowlist secret
    const bridge = createTestBridge({
      cfg: {} as never,
      providerConfig: {},
    });

    const canceledConnect = bridge.connect();
    await waitForRealtimeState(() => expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce());
    bridge.close();
    const replacementConnect = bridge.connect();

    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const replacementSocket = requireSocket();
    replacementSocket.open();
    replacementSocket.emitServer({ type: "session.updated" });
    await Promise.all([canceledConnect, replacementConnect]);

    expect(bridge.isConnected()).toBe(true);
    resolveFirstCredentials?.({ apiKey: "xai-late" }); // pragma: allowlist secret
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    bridge.close();
  });

  it("ignores late events from a canceled socket after replacement", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const onAudio = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    const onReady = vi.fn();
    const bridge = createTestBridge({
      onAudio,
      onClose,
      onError,
      onReady,
    });

    const firstConnect = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const staleSocket = requireSocket();
    staleSocket.deferClose = true;
    bridge.close();
    bridge.close();
    await firstConnect;

    const replacementConnect = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const replacementSocket = requireSocket(1);
    replacementSocket.open();
    replacementSocket.emitServer({ type: "session.updated" });
    await replacementConnect;

    staleSocket.emit("open");
    staleSocket.emitServer({ type: "session.updated" });
    staleSocket.emitServer({
      type: "response.output_audio.delta",
      delta: Buffer.from("late audio").toString("base64"),
    });
    staleSocket.emit("error", new Error("late socket error"));
    staleSocket.flushClose();

    expect(bridge.isConnected()).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onAudio).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
    bridge.close();
  });

  it("rejects session readiness after its event callback closes the bridge", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const onClose = vi.fn();
    const onReady = vi.fn();
    const bridgeRef: {
      current?: ReturnType<ReturnType<typeof buildXaiRealtimeVoiceProvider>["createBridge"]>;
    } = {};
    const onEvent = vi.fn((event: { direction: string; type: string }) => {
      if (event.direction === "server" && event.type === "session.updated") {
        bridgeRef.current?.close();
      }
    });
    const bridge = createTestBridge({
      onClose,
      onEvent,
      onReady,
    });
    bridgeRef.current = bridge;

    const connecting = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = requireSocket();
    socket.open();
    socket.emitServer({ type: "session.updated" });
    await connecting;

    expect(bridge.isConnected()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("uses XAI_API_KEY for default Grok realtime bridges", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge({
      cfg: {} as never,
      providerConfig: { model: "grok-voice-latest", voice: "ara" },
      instructions: "Speak briefly.",
    });

    const { socket } = await startRealtimeBridge(bridge);
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
    const bridge = createTestBridge();

    const { socket } = await startRealtimeBridge(bridge);
    bridge.close();

    expect(requireSession(socket).resumption).toBeUndefined();
  });

  it("bounds pending realtime audio by aggregate bytes before session setup", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge();

    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x7f));
    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x7f));
    bridge.sendAudio(Buffer.alloc(1, 0x7f));

    const socket = await openRealtimeBridge(bridge);

    expect(
      parseSent(socket).filter((event) => event.type === "input_audio_buffer.append"),
    ).toHaveLength(2);
    bridge.close();
  });

  it("copies pending realtime audio views without retaining their backing allocation", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge();
    const backing = Buffer.alloc(2 * 1024 * 1024, 0x7f);
    const view = backing.subarray(0, 1);

    bridge.sendAudio(view);
    backing[0] = 0;

    const socket = await openRealtimeBridge(bridge);

    expect(parseSent(socket).filter((event) => event.type === "input_audio_buffer.append")).toEqual(
      [{ type: "input_audio_buffer.append", audio: "fw==" }],
    );
    bridge.close();
  });

  it("drops queued realtime input on close and ignores late input until reconnect", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge();

    bridge.sendAudio(Buffer.from([0x01]));
    bridge.sendUserMessage?.("queued before close");
    void bridge.submitToolResult("call-before-close", { ok: true });
    bridge.close();
    bridge.sendAudio(Buffer.from([0x02]));
    bridge.sendUserMessage?.("late after close");
    void bridge.submitToolResult("call-after-close", { ok: true });

    const socket = await openRealtimeBridge(bridge);

    expect(
      parseSent(socket).filter(
        (event) =>
          event.type === "input_audio_buffer.append" ||
          event.type === "conversation.item.create" ||
          event.type === "response.create",
      ),
    ).toEqual([]);
    bridge.close();
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
    const bridge = createTestBridge({
      audioFormat: { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
    });

    const { socket } = await startRealtimeBridge(bridge);
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
    const cases = [
      {
        options: { vadThreshold: 1, silenceDurationMs: 10_001, prefixPaddingMs: -1 },
        expected: { threshold: 0.85, silence_duration_ms: 500, prefix_padding_ms: 333 },
      },
      {
        options: { vadThreshold: 0.9, silenceDurationMs: 10_000, prefixPaddingMs: 0 },
        expected: { threshold: 0.9, silence_duration_ms: 10_000, prefix_padding_ms: 0 },
      },
    ];

    for (const [index, { options, expected }] of cases.entries()) {
      const bridge = createTestBridge({
        providerConfig: {
          apiKey: "xai-test", // pragma: allowlist secret
          ...options,
        },
      });
      const { socket } = await startRealtimeBridge(bridge, index);
      bridge.close();
      expect(requireSession(socket).turn_detection).toEqual(expect.objectContaining(expected));
    }
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

    const { socket } = await startRealtimeBridge(bridge);
    bridge.close();

    expect(requireSession(socket).reasoning).toEqual({ effort: "none" });
  });

  it("treats xAI input transcription updates as replacements until completed", async () => {
    const onTranscript = vi.fn();
    const bridge = createTestBridge({
      onTranscript,
    });

    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_1",
      transcript: "open",
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_1",
      transcript: "open claw",
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "OpenClaw",
    });
    bridge.close();

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("user", "OpenClaw", true);
  });

  it("forwards standard incremental input-transcription events", async () => {
    const onTranscript = vi.fn();
    const bridge = createTestBridge({
      onTranscript,
    });
    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_speech",
      delta: "open claw",
    });

    expect(onTranscript).toHaveBeenCalledWith("user", "open claw", false);
  });

  it("surfaces input transcription failures and discards their stale replacement text", async () => {
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const bridge = createTestBridge({
      onTranscript,
      onError,
      onEvent,
    });
    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "item_speech",
      transcript: "stale speech",
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item_speech",
      error: { code: "decoder_failure", message: "speech decoder exploded" },
    });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_speech",
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "speech decoder exploded" }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.input_audio_transcription.failed",
      itemId: "item_speech",
      detail: "speech decoder exploded",
    });
  });

  it("buffers assistant transcript deltas and finalizes them when done has no text", async () => {
    const onTranscript = vi.fn();
    const bridge = createTestBridge({
      onTranscript,
    });

    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({ type: "response.created" });
    socket.emitServer({ type: "response.output_audio_transcript.delta", delta: "Hello " });
    socket.emitServer({ type: "response.output_audio_transcript.delta", delta: "OpenClaw" });
    socket.emitServer({ type: "response.output_audio_transcript.done" });
    socket.emitServer({ type: "response.done" });
    bridge.close();

    expect(onTranscript).toHaveBeenNthCalledWith(1, "assistant", "Hello ", false);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "assistant", "OpenClaw", false);
    expect(onTranscript).toHaveBeenNthCalledWith(3, "assistant", "Hello OpenClaw", true);
    expect(onTranscript).toHaveBeenCalledTimes(3);
  });

  it("preserves corrected final text from legacy realtime text events", async () => {
    const onTranscript = vi.fn();
    const bridge = createTestBridge({
      onTranscript,
    });
    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({ type: "response.created" });
    socket.emitServer({ type: "response.text.delta", delta: "draft assistant" });
    socket.emitServer({ type: "response.text.done", text: "corrected assistant" });
    socket.emitServer({ type: "response.done" });

    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "draft assistant", false],
      ["assistant", "corrected assistant", true],
    ]);
  });

  it.each([
    {
      name: "non-array output",
      output: { unexpected: true },
      expectedTranscript: undefined,
    },
    {
      name: "a null output item beside a valid message",
      output: [
        null,
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Valid terminal text" }],
        },
      ],
      expectedTranscript: "Valid terminal text",
    },
    {
      name: "null message content beside a valid part",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [null, { type: "output_audio", transcript: "Valid terminal audio" }],
        },
      ],
      expectedTranscript: "Valid terminal audio",
    },
  ])("continues after malformed terminal output: $name", async ({ output, expectedTranscript }) => {
    const onTranscript = vi.fn();
    const bridge = createTestBridge({ onTranscript });
    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({ type: "response.created" });
    bridge.sendUserMessage?.("Continue after malformed terminal output.");
    socket.emitServer({ type: "response.done", response: { status: "completed", output } });

    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue after malformed terminal output." }],
        },
      },
      { type: "response.create" },
    ]);
    expect(onTranscript.mock.calls).toEqual(
      expectedTranscript ? [["assistant", expectedTranscript, true]] : [],
    );
  });

  it.each([
    {
      name: "lets server VAD own interruption before an audio item exists",
      hasAudio: false,
      timestamp: 1000,
      expectedActions: [],
    },
    {
      name: "cancels and truncates active response audio on barge-in",
      hasAudio: true,
      manual: true,
      timestamp: 1300,
      expectedActions: [
        { type: "response.cancel" },
        {
          type: "conversation.item.truncate",
          item_id: "item_1",
          content_index: 0,
          audio_end_ms: 300,
        },
      ],
    },
    {
      name: "truncates queued playback on server-VAD barge-in without cancelling xAI",
      hasAudio: true,
      timestamp: 1250,
      expectedActions: [
        {
          type: "conversation.item.truncate",
          item_id: "item_1",
          content_index: 0,
          audio_end_ms: 250,
        },
      ],
    },
    {
      name: "clears relay playback on server-VAD barge-in after marks are acknowledged",
      hasAudio: true,
      acknowledged: true,
      timestamp: 1250,
      expectedActions: [],
    },
    {
      name: "does not truncate completed assistant audio on a later user turn",
      hasAudio: true,
      acknowledged: true,
      completed: true,
      timestamp: 2000,
      expectedActions: [],
    },
    {
      name: "keeps completed assistant item state so relay playback cancel can truncate it",
      hasAudio: true,
      acknowledged: true,
      completed: true,
      manual: true,
      timestamp: 1300,
      expectedActions: [
        {
          type: "conversation.item.truncate",
          item_id: "item_1",
          content_index: 0,
          audio_end_ms: 300,
        },
      ],
    },
    {
      name: "lets server VAD interrupt a new response before it produces audio",
      hasAudio: true,
      acknowledged: true,
      completed: true,
      startNewResponse: true,
      timestamp: 1500,
      expectedActions: [],
    },
  ])(
    "$name",
    async ({
      hasAudio,
      acknowledged,
      completed,
      startNewResponse,
      manual,
      timestamp,
      expectedActions,
    }) => {
      vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
      const onAudio = vi.fn();
      const onClearAudio = vi.fn();
      const bridge = createTestBridge({
        audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        onAudio,
        onClearAudio,
      });
      const { socket } = await startRealtimeBridge(bridge);

      socket.emitServer({ type: "response.created", response: { id: "resp_1" } });
      if (hasAudio) {
        bridge.setMediaTimestamp(1000);
        socket.emitServer({
          type: "response.output_audio.delta",
          item_id: "item_1",
          delta: Buffer.from("assistant audio").toString("base64"),
        });
      }
      if (acknowledged) {
        bridge.acknowledgeMark?.();
      }
      if (completed) {
        socket.emitServer({ type: "response.done" });
      }
      if (startNewResponse) {
        socket.emitServer({ type: "response.created", response: { id: "resp_2" } });
      }
      bridge.setMediaTimestamp(timestamp);
      if (manual) {
        bridge.handleBargeIn?.({ audioPlaybackActive: true });
      } else {
        socket.emitServer({ type: "input_audio_buffer.speech_started" });
      }
      bridge.close();

      expect(onAudio).toHaveBeenCalledTimes(hasAudio ? 1 : 0);
      expect(onClearAudio).toHaveBeenCalledTimes(1);
      if (!manual) {
        expect(onClearAudio).toHaveBeenCalledWith("barge-in");
      }
      expect(
        parseSent(socket).filter(
          (event) =>
            event.type === "response.cancel" || event.type === "conversation.item.truncate",
        ),
      ).toEqual(expectedActions);
    },
  );

  it("terminates realtime voice on non-canonical base64 audio", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const onAudio = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    let retry: Promise<void> | undefined;
    const handleError = (error: Error) => {
      onError(error);
      retry = bridge.connect();
    };
    const bridge = createTestBridge({
      onAudio,
      onClose,
      onError: handleError,
    });

    const socket = await openRealtimeBridge(bridge);
    socket.emitServer({ type: "response.output_audio.delta", delta: "ZE==" });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "xAI realtime voice stream returned malformed base64 audio data",
      }),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAudio).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(socket.closed).toBe(true);
    if (!retry) {
      throw new Error("expected synchronous retry from onError");
    }
    await expect(retry).rejects.toThrow(
      "xAI realtime voice stream returned malformed base64 audio data",
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("rejects startup when malformed audio arrives before session.updated", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const onClose = vi.fn();
    const onError = vi.fn();
    const bridge = createTestBridge({
      onClose,
      onError,
    });

    const connection = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.open();
    socket.emitServer({ type: "response.output_audio.delta", delta: "ZE==" });

    await expect(connection).rejects.toThrow(
      "xAI realtime voice stream returned malformed base64 audio data",
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("error");
    expect(socket.closed).toBe(true);
  });

  it("deduplicates repeated function-call arguments done events", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const onToolCall = vi.fn();
    const bridge = createTestBridge({
      onToolCall,
    });

    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({
      type: "response.function_call_arguments.delta",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      delta: JSON.stringify({ question: "delegate this" }),
    });
    socket.emitServer({
      type: "response.function_call_arguments.done",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
    });
    socket.emitServer({
      type: "response.function_call_arguments.done",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      arguments: JSON.stringify({ question: "delegate this" }),
    });
    socket.emitServer({ type: "response.done", response: { status: "completed" } });

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_tool_1",
      callId: "call_1",
      name: "openclaw_agent_consult",
      args: { question: "delegate this" },
    });
  });

  it.each([
    {
      name: "corrected streamed arguments",
      delta: '{"city":"draft"}',
      finalArguments: '{"city":"Paris"}',
      expectedArguments: { city: "Paris" },
    },
    {
      name: "truncated streamed arguments",
      delta: '{"city":',
      finalArguments: '{"city":"Paris"}',
      expectedArguments: { city: "Paris" },
    },
    {
      name: "an explicitly empty completed payload",
      delta: '{"city":"draft"}',
      finalArguments: "",
      expectedArguments: {},
    },
  ])(
    "uses authoritative completed tool arguments for $name",
    async ({ delta, finalArguments, expectedArguments }) => {
      const onToolCall = vi.fn();
      const bridge = createTestBridge({
        onToolCall,
      });
      const socket = await openRealtimeBridge(bridge);

      socket.emitServer({
        type: "response.function_call_arguments.delta",
        item_id: "item_tool_1",
        call_id: "call_1",
        name: "lookup_weather",
        delta,
      });
      socket.emitServer({
        type: "response.function_call_arguments.done",
        item_id: "item_tool_1",
        call_id: "call_1",
        name: "lookup_weather",
        arguments: finalArguments,
      });
      socket.emitServer({ type: "response.done", response: { status: "completed" } });

      expect(onToolCall).toHaveBeenCalledWith({
        itemId: "item_tool_1",
        callId: "call_1",
        name: "lookup_weather",
        args: expectedArguments,
      });
    },
  );

  it.each(["completed arguments", "resumed item replay"] as const)(
    "rejects malformed and non-object tool arguments from %s without retaining pending state",
    async (ingress) => {
      const onEvent = vi.fn();
      const onToolCall = vi.fn();
      const bridge = createTestBridge({
        providerConfig: {
          apiKey: "xai-test", // pragma: allowlist secret
          sessionResumption: ingress === "resumed item replay",
        },
        onEvent,
        onToolCall,
      });
      const socket = await openRealtimeBridge(bridge);

      socket.emitServer({ type: "response.created" });
      const invalidEvents = ["{", "null", "[]", JSON.stringify("text"), "1", "true"].map(
        (rawArgs, index) => {
          const itemId = `item_invalid_${index}`;
          const callId = `call_invalid_${index}`;
          return ingress === "completed arguments"
            ? {
                type: "response.function_call_arguments.done",
                item_id: itemId,
                call_id: callId,
                name: "lookup_weather",
                arguments: rawArgs,
              }
            : {
                type: "conversation.item.created",
                item: {
                  id: itemId,
                  type: "function_call",
                  call_id: callId,
                  name: "lookup_weather",
                  arguments: rawArgs,
                },
              };
        },
      );
      for (const event of invalidEvents) {
        socket.emitServer(event);
      }
      socket.emitServer(invalidEvents[0]);
      socket.emitServer({ type: "response.done", response: { status: "completed" } });

      expect(onToolCall).not.toHaveBeenCalled();
      expect(
        onEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.type === "tool_call.arguments.rejected"),
      ).toEqual([
        {
          direction: "server",
          type: "tool_call.arguments.rejected",
          detail: "reason=malformed-json",
          itemId: "item_invalid_0",
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          direction: "server",
          type: "tool_call.arguments.rejected",
          detail: "reason=non-object-json",
          itemId: `item_invalid_${index + 1}`,
        })),
      ]);
      expect(
        parseSent(socket).filter(
          (event) =>
            event.type === "conversation.item.create" &&
            event.item?.type === "function_call_output",
        ),
      ).toEqual(
        Array.from({ length: 6 }, (_, index) => ({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: `call_invalid_${index}`,
            output: JSON.stringify({ error: "Invalid tool arguments." }),
          },
        })),
      );
      expect(parseSent(socket).filter((event) => event.type === "response.create")).toEqual([
        { type: "response.create" },
      ]);

      socket.emitServer({ type: "response.done" });
      expect(parseSent(socket).filter((event) => event.type === "response.create")).toEqual([
        { type: "response.create" },
      ]);

      socket.emitServer({ type: "response.created" });
      socket.emitServer({ type: "response.done" });
      bridge.sendUserMessage?.("Continue after rejected tool arguments.");
      expect(parseSent(socket).slice(-2)).toEqual([
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Continue after rejected tool arguments." }],
          },
        },
        { type: "response.create" },
      ]);
      bridge.close();
    },
  );

  it("treats rejected tool call arguments as terminal for the same identity", async () => {
    const onToolCall = vi.fn();
    const bridge = createTestBridge({
      onToolCall,
    });
    const socket = await openRealtimeBridge(bridge);

    for (const rawArgs of ['{"city":', JSON.stringify({ city: "Paris" })]) {
      socket.emitServer({
        type: "response.function_call_arguments.done",
        item_id: "item_rejected",
        call_id: "call_rejected",
        name: "lookup_weather",
        arguments: rawArgs,
      });
    }
    socket.emitServer({ type: "response.done", response: { status: "completed" } });

    expect(onToolCall).not.toHaveBeenCalled();
    expect(
      parseSent(socket).filter(
        (event) =>
          event.type === "conversation.item.create" && event.item?.type === "function_call_output",
      ),
    ).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_rejected",
          output: JSON.stringify({ error: "Invalid tool arguments." }),
        },
      },
    ]);
    bridge.close();
  });

  it.each([
    ["undefined", (): undefined => undefined],
    ["function", () => () => undefined],
    ["symbol", () => Symbol("invalid-tool-result")],
    ["bigint", () => ({ value: 1n })],
    [
      "circular",
      () => {
        const result: { self?: unknown } = {};
        result.self = result;
        return result;
      },
    ],
    ["omitted custom serialization", () => ({ toJSON: () => undefined })],
  ] as const)(
    "rejects %s realtime tool results before transport ownership changes",
    async (_label, create) => {
      const onError = vi.fn();
      const bridge = createTestBridge({ onError, onToolCall: vi.fn() });
      const socket = await openRealtimeBridge(bridge);
      socket.emitServer({
        type: "response.function_call_arguments.done",
        item_id: "item_call_1",
        name: "openclaw_agent_consult",
        call_id: "call_1",
        arguments: "{}",
      });

      expect(() => bridge.submitToolResult("call_1", create())).toThrow(/serializ/i);
      expect(onError).not.toHaveBeenCalled();
      expect(
        parseSent(socket).filter((event) => event.type === "conversation.item.create"),
      ).toEqual([]);

      await bridge.submitToolResult("call_1", { recovered: true });

      expect(parseSent(socket).slice(-2)).toEqual([
        {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: "call_1",
            output: JSON.stringify({ recovered: true }),
          },
        },
        { type: "response.create" },
      ]);
      bridge.close();
    },
  );

  it("preserves valid realtime tool results with one canonical serialization", async () => {
    const bridge = createTestBridge({ onToolCall: vi.fn() });
    const socket = await openRealtimeBridge(bridge);
    const customSerialization = vi.fn((key: string) => ({ key }));
    const values: unknown[] = [
      null,
      false,
      0,
      "",
      "text",
      [1],
      { ok: true },
      {
        toJSON: customSerialization,
      },
    ];

    for (const [index, result] of values.entries()) {
      const callId = `call_${index}`;
      socket.emitServer({
        type: "response.function_call_arguments.done",
        item_id: `item_${callId}`,
        name: "openclaw_agent_consult",
        call_id: callId,
        arguments: "{}",
      });
      await bridge.submitToolResult(callId, result, { suppressResponse: true });
    }

    const outputs = parseSent(socket)
      .filter((event) => event.type === "conversation.item.create")
      .map((event) => (event.item as { output: string }).output);
    expect(outputs).toEqual([
      "null",
      "false",
      "0",
      '""',
      '"text"',
      "[1]",
      '{"ok":true}',
      '{"key":""}',
    ]);
    expect(customSerialization).toHaveBeenCalledExactlyOnceWith("");
    bridge.close();
  });

  it("rejects reconnect queue overflow without reporting successful delivery", async () => {
    const onError = vi.fn();
    const bridge = createTestBridge({ onError });

    for (let index = 0; index < 128; index += 1) {
      await bridge.submitToolResult(`call_${index}`, { ok: true });
    }

    expect(() => bridge.submitToolResult("overflow", { ok: true })).toThrow(
      "xAI realtime voice pending tool result queue overflow during reconnect",
    );
    expect(onError).toHaveBeenCalledOnce();
  });

  it("waits for all parallel tool results before sending response.create", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge({
      onToolCall: vi.fn(),
    });

    const socket = await openRealtimeBridge(bridge);

    for (const callId of ["call_1", "call_2"]) {
      socket.emitServer({
        type: "response.function_call_arguments.done",
        item_id: `item_${callId}`,
        name: "openclaw_agent_consult",
        call_id: callId,
        arguments: JSON.stringify({ question: callId }),
      });
    }
    socket.emitServer({ type: "response.done", response: { status: "completed" } });

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
    const bridge = createTestBridge({
      onToolCall: vi.fn(),
    });

    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({
      type: "response.function_call_arguments.done",
      item_id: "item_call_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      arguments: JSON.stringify({ question: "call_1" }),
    });

    await bridge.submitToolResult("call_1", { status: "working" }, { willContinue: true });
    await bridge.submitToolResult("call_1", undefined, { willContinue: true });
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
    const onMark = vi.fn();
    const bridge = createTestBridge({
      onToolCall: vi.fn(),
      onMark,
    });

    const socket = await openRealtimeBridge(bridge);

    socket.emitServer({ type: "response.created" });
    socket.emitServer({
      type: "response.output_audio.delta",
      item_id: "item_audio_1",
      delta: Buffer.from("assistant audio").toString("base64"),
    });
    socket.emitServer({ type: "response.done" });
    socket.emitServer({
      type: "response.function_call_arguments.done",
      item_id: "item_call_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      arguments: JSON.stringify({ question: "call_1" }),
    });

    await bridge.submitToolResult("call_1", { text: "final" });
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toEqual([]);
    const markName = onMark.mock.calls[0]?.[0];
    expect(markName).toMatch(/^audio-/);

    bridge.acknowledgeMark?.("stale-mark");
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toEqual([]);

    bridge.acknowledgeMark?.(markName);
    expect(parseSent(socket).slice(-1)).toEqual([{ type: "response.create" }]);
  });

  it("fails the session when playback marks exceed their ownership bound", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const onAudio = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    const onMark = vi.fn();
    const bridge = createTestBridge({ onAudio, onClose, onError, onMark });
    const socket = await openRealtimeBridge(bridge);
    const delta = Buffer.from("assistant audio").toString("base64");

    socket.emitServer({ type: "response.created" });
    for (let index = 0; index < XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS; index += 1) {
      socket.emitServer({ type: "response.output_audio.delta", delta });
    }
    socket.emitServer({ type: "response.output_audio.delta", delta });

    expect(onAudio).toHaveBeenCalledTimes(XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS);
    expect(onMark).toHaveBeenCalledTimes(XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `xAI realtime voice playback mark limit exceeded (${XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS})`,
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("error");
    expect(socket.closed).toBe(true);

    socket.emitServer({ type: "response.output_audio.delta", delta });
    bridge.close();
    expect(onAudio).toHaveBeenCalledTimes(XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(bridge.connect()).rejects.toThrow(
      `xAI realtime voice playback mark limit exceeded (${XAI_REALTIME_MAX_PENDING_PLAYBACK_MARKS})`,
    );
  });

  it("preserves pending parallel tool calls across resumed reconnects", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onToolCall: vi.fn(),
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_tools");

    for (const callId of ["call_1", "call_2"]) {
      firstSocket.emitServer({
        type: "response.function_call_arguments.done",
        item_id: `item_${callId}`,
        name: "openclaw_agent_consult",
        call_id: callId,
        arguments: JSON.stringify({ question: callId }),
      });
    }
    firstSocket.emitServer({ type: "response.done", response: { status: "completed" } });

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_tools");
    secondSocket.open();
    secondSocket.emitServer({ type: "session.updated" });

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
    const onToolCall = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onToolCall,
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_replay");

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    secondSocket.open();
    secondSocket.emitServer({
      type: "conversation.item.created",
      item: {
        id: "item_replayed_call",
        type: "function_call",
        call_id: "call_replayed",
        name: "openclaw_agent_consult",
        arguments: JSON.stringify({ question: "recover me" }),
      },
    });
    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_replayed_call",
      callId: "call_replayed",
      name: "openclaw_agent_consult",
      args: { question: "recover me" },
    });
    bridge.close();
  });

  it("keeps failed realtime transport sends retryable across reconnect", async () => {
    vi.useFakeTimers();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: ["xai", "test"].join("-") });
    const onEvent = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { sessionResumption: true },
      onEvent,
      onToolCall: vi.fn(),
    });
    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_failed_output");
    firstSocket.emitServer({
      type: "response.function_call_arguments.done",
      item_id: "item_failed_output",
      call_id: "call_failed_output",
      name: "openclaw_agent_consult",
      arguments: "{}",
    });
    const sendError = new Error("realtime transport rejected the output");
    vi.spyOn(firstSocket, "send").mockImplementationOnce(() => {
      throw sendError;
    });

    expect(() => bridge.submitToolResult("call_failed_output", { failed: true })).toThrow(
      sendError,
    );

    firstSocket.close(1006, "connection lost after rejected output");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const resumedSocket = requireSocket(1);
    resumedSocket.open();
    resumedSocket.emitServer({ type: "session.updated" });

    await bridge.submitToolResult("call_failed_output", { recovered: true });

    expect(
      parseSent(resumedSocket).find((event) => event.type === "conversation.item.create"),
    ).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call_failed_output",
        output: JSON.stringify({ recovered: true }),
      },
    });
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.reconnect.blocked" }),
    );
    bridge.close();
  });

  it("fails closed when a tool output was not acknowledged before reconnect", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const onToolCall = vi.fn();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onToolCall,
      onEvent,
      onClose,
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_lost_output");
    firstSocket.emitServer({
      type: "response.function_call_arguments.done",
      item_id: "item_lost_output",
      call_id: "call_lost_output",
      name: "openclaw_agent_consult",
      arguments: JSON.stringify({ question: "recover output" }),
    });
    firstSocket.emitServer({ type: "response.done", response: { status: "completed" } });
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
    const onToolCall = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onToolCall,
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_saved_output");
    firstSocket.emitServer({
      type: "response.function_call_arguments.done",
      item_id: "item_saved_output",
      call_id: "call_saved_output",
      name: "openclaw_agent_consult",
      arguments: JSON.stringify({ question: "saved output" }),
    });
    firstSocket.emitServer({ type: "response.done", response: { status: "completed" } });
    await bridge.submitToolResult("call_saved_output", { text: "saved" });
    firstSocket.emitServer({
      type: "conversation.item.added",
      item: {
        id: "item_saved_result",
        type: "function_call_output",
        call_id: "call_saved_output",
        output: JSON.stringify({ text: "saved" }),
      },
    });

    firstSocket.close(1006, "connection lost after output acknowledgement");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    secondSocket.open();
    secondSocket.emitServer({ type: "session.updated" });
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
      secondSocket.emitServer({ type: "conversation.item.created", item });
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
    const onError = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onError,
      onToolCall: vi.fn(),
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_tool_queue");

    for (const callId of ["call_1", "call_2"]) {
      firstSocket.emitServer({
        type: "response.function_call_arguments.done",
        item_id: `item_${callId}`,
        name: "openclaw_agent_consult",
        call_id: callId,
        arguments: JSON.stringify({ question: callId }),
      });
    }
    firstSocket.emitServer({ type: "response.done", response: { status: "completed" } });

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_tool_queue");
    secondSocket.open();

    onError.mockClear();
    expect(() => bridge.submitToolResult("call_1", { invalid: 1n })).toThrow(/serializ/i);
    expect(onError).toHaveBeenCalledOnce();
    expect(() =>
      bridge.submitToolResult("call_1", undefined, { willContinue: true }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();

    await bridge.submitToolResult("call_1", { text: "first" });
    expect(
      parseSent(secondSocket).filter((event) => event.type === "conversation.item.create"),
    ).toEqual([]);

    secondSocket.emitServer({ type: "session.updated" });
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
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_text_queue");

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_text_queue");
    secondSocket.open();

    bridge.sendUserMessage?.("OpenClaw finished checking.");
    expect(
      parseSent(secondSocket).filter((event) => event.type === "conversation.item.create"),
    ).toEqual([]);

    secondSocket.emitServer({ type: "session.updated" });
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
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onEvent,
      onClose,
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_reconnect");

    firstSocket.close(1006, "connection lost");

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const delayMs = 1000 * 2 ** (attempt - 1);
      await vi.advanceTimersByTimeAsync(delayMs);
      await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(attempt + 1));
      const socket = requireSocket(attempt);
      socket.open();
      socket.close(1006, "session setup failed");
    }

    await waitForRealtimeState(() =>
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
    const onReady = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onReady,
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_ready");

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_ready");
    secondSocket.open();
    secondSocket.emitServer({ type: "session.updated" });
    bridge.close();

    expect(onReady).toHaveBeenCalledOnce();
  });

  it("cancels a pending reconnect and allows a later explicit connect", async () => {
    vi.useFakeTimers();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: ["xai", "test"].join("-") });
    const onError = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { sessionResumption: true },
      onError,
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_close");

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    bridge.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();

    const reconnecting = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(2));
    const reconnectedSocket = requireSocket(1);
    expect(String(reconnectedSocket.args[0])).not.toContain("conversation_id=");
    reconnectedSocket.open();
    reconnectedSocket.emitServer({ type: "session.updated" });
    await reconnecting;

    expect(bridge.isConnected()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
    bridge.close();
  });

  it("lets an explicit connect replace an automatic reconnect wait", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const onError = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onError,
    });

    const firstSocket = await openRealtimeBridge(bridge, 0, "conv_replace_retry");

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    const replacementConnect = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const replacementSocket = requireSocket(1);
    expect(String(replacementSocket.args[0])).toContain("conversation_id=conv_replace_retry");
    replacementSocket.open();
    replacementSocket.emitServer({ type: "session.updated" });
    await replacementConnect;
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(bridge.isConnected()).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    bridge.close();
  });

  it("enables xAI session resumption and reconnects with the created conversation id", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
    });

    const connecting = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(1));
    const firstSocket = requireSocket();
    firstSocket.open();
    expect(requireSession(firstSocket).resumption).toEqual({ enabled: true });
    firstSocket.emitServer({ type: "conversation.created", conversation: { id: "conv_resume" } });
    firstSocket.emitServer({ type: "session.updated" });
    await connecting;

    firstSocket.close(1006, "connection lost");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(2));
    const secondSocket = requireSocket(1);
    expect(String(secondSocket.args[0])).toContain("conversation_id=conv_resume");
    secondSocket.open();
    expect(requireSession(secondSocket).resumption).toEqual({ enabled: true });
    bridge.close();
  });

  it("fails closed instead of reconnecting without a conversation id", async () => {
    vi.useFakeTimers();
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const bridge = createTestBridge({
      providerConfig: { apiKey: "xai-test", sessionResumption: true }, // pragma: allowlist secret
      onEvent,
      onClose,
    });

    const socket = await openRealtimeBridge(bridge);

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
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const bridge = createTestBridge({
      onEvent,
      onClose,
    });

    const socket = await openRealtimeBridge(bridge, 0, "conv_default");

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
    const onClose = vi.fn();
    const bridge = createTestBridge({
      onClose,
    });

    const connecting = bridge.connect();
    await waitForRealtimeState(() => expect(FakeWebSocket.instances.length).toBe(1));
    const socket = requireSocket();
    socket.open();
    socket.emit("error", new Error("bad auth"));

    await expect(connecting).rejects.toThrow("bad auth");
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("forwards configured provider tools in session.update", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-env"); // pragma: allowlist secret
    const bridge = createTestBridge({
      tools: [
        {
          type: "function",
          name: "openclaw_agent_consult",
          description: "Consult OpenClaw",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    const { socket } = await startRealtimeBridge(bridge);
    bridge.close();

    const session = requireSession(socket);
    expect(session.tools).toHaveLength(1);
    expect(session.tool_choice).toBe("auto");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
