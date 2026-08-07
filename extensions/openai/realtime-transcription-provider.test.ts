// Openai tests cover realtime transcription provider plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

const { FakeWebSocket, providerAuthMocks, ssrfMocks } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readonly headers?: Record<string, string>;
    readonly url?: string;
    readyState = 0;
    sent: string[] = [];
    closed = false;

    constructor(url?: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.headers = options?.headers;
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
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  return {
    FakeWebSocket: MockWebSocket,
    providerAuthMocks: {
      isProviderAuthProfileConfigured: vi.fn(),
      resolveProviderAuthProfileApiKey: vi.fn(),
    },
    ssrfMocks: {
      fetchWithSsrFGuard: vi.fn(),
    },
  };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: providerAuthMocks.isProviderAuthProfileConfigured,
  resolveProviderAuthProfileApiKey: providerAuthMocks.resolveProviderAuthProfileApiKey,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  session?: unknown;
};

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload) => JSON.parse(payload) as SentRealtimeEvent);
}

async function waitForFakeSocket(index = 0): Promise<FakeWebSocketInstance> {
  let socket: FakeWebSocketInstance | undefined;
  await vi.waitFor(() => {
    socket = FakeWebSocket.instances[index];
    if (!socket) {
      throw new Error("expected session to create a websocket");
    }
  });
  if (!socket) {
    throw new Error("expected session to create a websocket");
  }
  return socket;
}

function emitJson(socket: FakeWebSocketInstance, event: Record<string, unknown>): void {
  socket.emit("message", Buffer.from(JSON.stringify(event)));
}

async function connectFakeSession(
  session: { connect(): Promise<void> },
  socketIndex = 0,
): Promise<FakeWebSocketInstance> {
  const connecting = session.connect();
  const socket = await waitForFakeSocket(socketIndex);
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  emitJson(socket, { type: "session.updated" });
  await connecting;
  return socket;
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[0] as Record<string, unknown>;
}

describe("buildOpenAIRealtimeTranscriptionProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    providerAuthMocks.isProviderAuthProfileConfigured.mockReset();
    providerAuthMocks.resolveProviderAuthProfileApiKey.mockReset();
    ssrfMocks.fetchWithSsrFGuard.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes OpenAI config defaults", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            apiKey: "sk-test", // pragma: allowlist secret
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
    });
  });

  it("keeps provider-owned transcription settings configurable via raw provider config", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            language: "en",
            model: "gpt-4o-transcribe",
            prompt: "expect OpenClaw product names",
            silenceDurationMs: 900,
            vadThreshold: 0.45,
          },
        },
      },
    });

    expect(resolved).toEqual({
      language: "en",
      model: "gpt-4o-transcribe",
      prompt: "expect OpenClaw product names",
      silenceDurationMs: 900,
      vadThreshold: 0.45,
    });
  });

  it("preserves explicit zero-valued VAD settings", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            silenceDurationMs: 0,
            vadThreshold: 0,
          },
        },
      },
    });

    expect(resolved?.silenceDurationMs).toBe(0);
    expect(resolved?.vadThreshold).toBe(0);
  });

  it("drops malformed VAD timing settings", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            silenceDurationMs: -1,
            vadThreshold: 1.5,
          },
        },
      },
    });

    expect(resolved?.silenceDurationMs).toBeUndefined();
    expect(resolved?.vadThreshold).toBeUndefined();
  });

  it("accepts the legacy openai-realtime alias", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    expect(provider.aliases).toContain("openai-realtime");
  });

  it("treats an OpenAI API-key profile as configured", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const cfg = { auth: { order: { openai: ["openai:default"] } } };
    providerAuthMocks.isProviderAuthProfileConfigured.mockReturnValue(true);

    expect(provider.isConfigured({ cfg: cfg as never, providerConfig: {} })).toBe(true);
    expect(providerAuthMocks.isProviderAuthProfileConfigured).toHaveBeenCalledWith({
      provider: "openai",
      cfg,
      profileTypes: ["api_key"],
    });
  });

  it("does not treat a whitespace-only environment API key as configured", () => {
    vi.stubEnv("OPENAI_API_KEY", "   ");
    const provider = buildOpenAIRealtimeTranscriptionProvider();

    expect(provider.isConfigured({ cfg: {} as never, providerConfig: {} })).toBe(false);
  });

  it("mints an API-key client secret for realtime transcription sockets", async () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const release = vi.fn();
    providerAuthMocks.resolveProviderAuthProfileApiKey.mockResolvedValue("sk-profile"); // pragma: allowlist secret
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response(JSON.stringify({ value: "ek-test" }), { status: 200 }),
      release,
    });
    const cfg = { auth: { order: { openai: ["openai:default"] } } };
    const session = provider.createSession({
      cfg: cfg as never,
      providerConfig: {},
    });

    const connecting = session.connect();
    const socket = await waitForFakeSocket();

    expect(socket.headers?.Authorization).toBe("Bearer ek-test");
    expect(providerAuthMocks.resolveProviderAuthProfileApiKey).toHaveBeenCalledWith({
      provider: "openai",
      cfg,
      profileTypes: ["api_key"],
    });
    const request = mockCallArg(ssrfMocks.fetchWithSsrFGuard);
    expect(request.auditContext).toBe("openai-realtime-transcription-session");
    expect(request.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(request.policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["api.openai.com"],
    });
    const init = request.init as {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    };
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe("Bearer sk-profile");
    expect(init.headers?.["Content-Type"]).toBe("application/json");
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toEqual({
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: { model: "gpt-4o-transcribe" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 800,
            },
          },
        },
      },
    });

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "transcription_session.updated" })));
    await connecting;

    expect(release).toHaveBeenCalled();
    expect(parseSent(socket)[0]).toEqual({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: { model: "gpt-4o-transcribe" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 800,
            },
          },
        },
      },
    });
    session.sendAudio(Buffer.alloc(0));
    session.close();
    expect(parseSent(socket).at(-1)?.type).toBe("session.update");
  });

  it("does not use Codex OAuth for realtime transcription", async () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const cfg = { auth: { order: { openai: ["openai:default"] } } };
    const session = provider.createSession({ cfg: cfg as never, providerConfig: {} });

    await expect(session.connect()).rejects.toThrow(
      "OpenAI Realtime transcription requires an OpenAI Platform API key",
    );
    expect(providerAuthMocks.resolveProviderAuthProfileApiKey).toHaveBeenCalledWith({
      provider: "openai",
      cfg,
      profileTypes: ["api_key"],
    });
    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("prefers an API-key profile over OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env"); // pragma: allowlist secret
    providerAuthMocks.resolveProviderAuthProfileApiKey.mockResolvedValue("sk-profile"); // pragma: allowlist secret
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response(JSON.stringify({ value: "ek-test" }), { status: 200 }),
      release: vi.fn(),
    });
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: {},
    });

    const connecting = session.connect();
    const socket = await waitForFakeSocket();

    expect(socket.headers?.Authorization).toBe("Bearer ek-test");
    const request = mockCallArg(ssrfMocks.fetchWithSsrFGuard);
    const init = request.init as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBe("Bearer sk-profile");

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "transcription_session.updated" })));
    await connecting;
    session.close();
  });

  it("waits for readiness, commits pending audio once on close, and delivers its final", async () => {
    const onTranscript = vi.fn();
    const pendingAudio = Buffer.alloc(800, 1);
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: {
        apiKey: "sk-test", // pragma: allowlist secret
        language: "en",
        model: "gpt-4o-transcribe",
        prompt: "expect OpenClaw product names",
        silenceDurationMs: 900,
        vadThreshold: 0.45,
      },
      onTranscript,
    });

    const connecting = session.connect();
    const socket = await waitForFakeSocket();

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    session.sendAudio(pendingAudio);

    expect(session.isConnected()).toBe(false);
    const expectedSessionUpdate = {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: {
              model: "gpt-4o-transcribe",
              language: "en",
              prompt: "expect OpenClaw product names",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.45,
              prefix_padding_ms: 300,
              silence_duration_ms: 900,
            },
          },
        },
      },
    };
    expect(parseSent(socket)).toEqual([expectedSessionUpdate]);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    expect(session.isConnected()).toBe(true);
    expect(parseSent(socket)).toEqual([
      expectedSessionUpdate,
      {
        type: "input_audio_buffer.append",
        audio: pendingAudio.toString("base64"),
      },
    ]);
    session.close();
    session.close();
    expect(
      parseSent(socket).filter(({ type }) => type === "input_audio_buffer.commit"),
    ).toHaveLength(1);
    emitJson(socket, { type: "input_audio_buffer.committed", item_id: "final-item" });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "final-item",
      transcript: "final caller sentence",
    });
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("final caller sentence");
    socket.close();
  });

  it("never commits audio from a previous websocket generation", async () => {
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
    });
    const previousSocket = await connectFakeSession(session);
    session.sendAudio(Buffer.alloc(800, 1));
    const replacementSocket = await connectFakeSession(session, 1);

    session.close();

    expect(parseSent(previousSocket).at(-1)?.type).toBe("input_audio_buffer.append");
    expect(parseSent(replacementSocket).at(-1)?.type).toBe("session.update");
    replacementSocket.close();
  });

  it.each(["audio append", "final commit"] as const)(
    "reports websocket backpressure during %s exactly once",
    async (phase) => {
      const onError = vi.fn();
      const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
        providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
        onError,
      });
      const socket = await connectFakeSession(session);
      if (phase === "final commit") {
        session.sendAudio(Buffer.alloc(800, 1));
      }
      Object.defineProperty(socket, "bufferedAmount", { value: 1024 * 1024 });
      if (phase === "audio append") {
        session.sendAudio(Buffer.alloc(800, 1));
      }

      session.close();
      session.close();

      expect(onError).toHaveBeenCalledOnce();
      if (phase === "final commit") {
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("final audio commit") }),
        );
      }
      expect(parseSent(socket).at(-1)?.type).toBe(
        phase === "audio append" ? "session.update" : "input_audio_buffer.append",
      );
    },
  );

  it.each([
    [1, 0, false, false],
    [799, 0, false, false],
    [800, 1, false, false],
    [800, 0, true, false],
    [1599, 0, true, false],
    [1600, 1, true, false],
    [1600, 1, true, true],
  ] as const)(
    "commits eligible %i-byte audio once (%i commits, VAD stopped: %s, acknowledged: %s)",
    async (audioBytes, expectedCommits, vadStopped, acknowledged) => {
      const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
        providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      });
      const socket = await connectFakeSession(session);
      if (vadStopped) {
        session.sendAudio(Buffer.alloc(800, 1));
        session.sendAudio(Buffer.alloc(audioBytes - 800, 2));
        emitJson(socket, {
          type: "input_audio_buffer.speech_stopped",
          item_id: "first-turn",
          audio_end_ms: 100,
        });
        if (acknowledged) {
          emitJson(socket, { type: "input_audio_buffer.committed", item_id: "first-turn" });
          emitJson(socket, { type: "input_audio_buffer.committed", item_id: "first-turn" });
        }
      } else {
        session.sendAudio(Buffer.alloc(audioBytes, 1));
      }

      session.close();

      expect(
        parseSent(socket).filter(({ type }) => type === "input_audio_buffer.commit"),
      ).toHaveLength(expectedCommits);
      socket.close();
    },
  );

  it("keeps out-of-order transcription items isolated and emits finals in commit order", async () => {
    const partials: string[] = [];
    const transcripts: string[] = [];
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onPartial: (partial) => partials.push(partial),
      onTranscript: (transcript) => transcripts.push(transcript),
    });

    const socket = await connectFakeSession(session);
    session.sendAudio(Buffer.alloc(800, 1));
    emitJson(socket, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item-2",
      audio_end_ms: 100,
    });
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-2",
      previous_item_id: "item-1",
    });
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-1",
      previous_item_id: null,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      delta: "first partial",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-2",
      delta: "second partial",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: "second final",
    });

    expect(partials).toEqual(["first partial", "second partial"]);
    expect(transcripts).toEqual([]);

    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "first final",
    });

    expect(transcripts).toEqual(["first final", "second final"]);
    session.close();
    expect(parseSent(socket).at(-1)?.type).toBe("input_audio_buffer.append");
  });

  it("reports failed transcription items without blocking later committed turns", async () => {
    const errors: string[] = [];
    const transcripts: string[] = [];
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError: (error) => errors.push(error.message),
      onTranscript: (transcript) => transcripts.push(transcript),
    });

    const socket = await connectFakeSession(session);

    for (const itemId of ["item-1", "item-2"]) {
      emitJson(socket, { type: "input_audio_buffer.committed", item_id: itemId });
    }
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: "second final",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item-1",
      error: { message: "first turn failed" },
    });

    expect(errors).toEqual(["first turn failed"]);
    expect(transcripts).toEqual(["second final"]);
    session.sendAudio(Buffer.alloc(800, 1));
    session.close();
    expect(parseSent(socket).at(-1)?.type).toBe("input_audio_buffer.commit");
  });

  it("releases settled turns from the unresolved item budget", async () => {
    const transcripts: string[] = [];
    const onError = vi.fn();
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);

    for (let index = 0; index < 128; index += 1) {
      const itemId = `item-${index}`;
      emitJson(socket, {
        type: "input_audio_buffer.committed",
        item_id: itemId,
        previous_item_id: index === 0 ? null : `item-${index - 1}`,
      });
      emitJson(socket, {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: itemId,
        transcript: `turn-${index}`,
      });
    }
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-129",
      previous_item_id: "item-128",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-129",
      transcript: "turn-129",
    });
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-128",
      previous_item_id: "item-127",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-128",
      transcript: "turn-128",
    });

    expect(transcripts).toHaveLength(130);
    expect(transcripts.slice(-2)).toEqual(["turn-128", "turn-129"]);
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("fails once when unresolved item correlation exceeds its session bound", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);

    for (let index = 0; index < 64; index += 1) {
      emitJson(socket, {
        type: "input_audio_buffer.committed",
        item_id: `item-${index}`,
        previous_item_id: "missing-predecessor",
      });
      emitJson(socket, {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: `item-${index}`,
        transcript: `turn-${index}`,
      });
    }
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "overflow-item",
      error: { message: "provider failure" },
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 64 unresolved item limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);

    const replacementSocket = await connectFakeSession(session, 1);
    emitJson(replacementSocket, {
      type: "input_audio_buffer.committed",
      item_id: "replacement-item",
      previous_item_id: null,
    });
    emitJson(replacementSocket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "replacement-item",
      transcript: "replacement transcript",
    });

    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("replacement transcript");
    expect(onError).toHaveBeenCalledTimes(1);
    session.close();
    session.close();
  });

  it("fails once when aggregate in-progress transcript text exceeds 256 KiB", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onPartial,
      onTranscript,
    });
    const socket = await connectFakeSession(session);
    const exactLimit = "🙂".repeat((256 * 1024) / 4);

    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      delta: exactLimit,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      delta: "x",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "late transcript",
    });

    expect(onPartial).toHaveBeenCalledExactlyOnceWith(exactLimit);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 256 KiB retained transcript limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    session.close();
  });

  it("accounts for UTF-8 surrogate pairs split across delta frames", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onPartial,
    });
    const socket = await connectFakeSession(session);
    const prefix = "x".repeat(256 * 1024 - 4);

    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      delta: prefix,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      delta: "\ud83d",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      delta: "\ude42",
    });

    expect(onPartial).toHaveBeenLastCalledWith(`${prefix}🙂`);
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("ignores duplicate completion events without double-charging retained text", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const transcripts: string[] = [];
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onPartial,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);
    const secondTranscript = "x".repeat(192 * 1024);

    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-2",
      previous_item_id: "item-1",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: secondTranscript,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-2",
      delta: "late partial",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item-2",
      error: { message: "late failure" },
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: secondTranscript,
    });
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-1",
      previous_item_id: null,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "first",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: "late duplicate",
    });

    expect(transcripts).toEqual(["first", secondTranscript]);
    expect(onPartial).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);

    const replacementSocket = await connectFakeSession(session, 1);
    emitJson(replacementSocket, {
      type: "input_audio_buffer.committed",
      item_id: "item-2",
      previous_item_id: null,
    });
    emitJson(replacementSocket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: "new session",
    });

    expect(transcripts).toEqual(["first", secondTranscript, "new session"]);
    session.close();
  });

  it("tombstones terminal outcomes received before their commit", async () => {
    const errors: string[] = [];
    const partials: string[] = [];
    const transcripts: string[] = [];
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError: (error) => errors.push(error.message),
      onPartial: (partial) => partials.push(partial),
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);

    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-completed",
      transcript: "first",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-completed",
      transcript: "duplicate",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-completed",
      delta: "late partial",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item-completed",
      error: { message: "late failure" },
    });
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-completed",
      previous_item_id: null,
    });

    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item-failed",
      error: { message: "first failure" },
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-failed",
      transcript: "late completion",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-failed",
      delta: "late partial",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item-failed",
      error: { message: "duplicate failure" },
    });
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-failed",
      previous_item_id: null,
    });

    expect(transcripts).toEqual(["first"]);
    expect(errors).toEqual(["first failure"]);
    expect(partials).toEqual([]);
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("keeps active predecessor satisfaction as terminal history grows", async () => {
    const transcripts: string[] = [];
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);

    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "root",
      previous_item_id: null,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "root",
      transcript: "root transcript",
    });
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "waiting",
      previous_item_id: "root",
    });
    for (let index = 0; index < 64; index += 1) {
      emitJson(socket, {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: `uncommitted-${index}`,
        transcript: "",
      });
    }
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "waiting",
      transcript: "waiting transcript",
    });

    expect(transcripts).toEqual(["root transcript", "waiting transcript"]);
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("keeps the first failed terminal outcome when completion arrives late", async () => {
    const errors: string[] = [];
    const transcripts: string[] = [];
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError: (error) => errors.push(error.message),
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);

    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-2",
      previous_item_id: "item-1",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item-2",
      error: { message: "second failed" },
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: "late second",
    });
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-1",
      previous_item_id: null,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "first",
    });

    expect(errors).toEqual(["second failed"]);
    expect(transcripts).toEqual(["first"]);
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("fails before retaining oversized correlation identities", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);

    session.sendAudio(Buffer.alloc(800, 1));
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "i".repeat(1025),
      error: { message: "provider failure" },
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 1024-byte item identity limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    expect(parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
    ]);
    session.close();
  });

  it("fails before retaining an oversized completed transcript", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);

    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "item-1",
      previous_item_id: null,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "x".repeat(256 * 1024 + 1),
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "late transcript",
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 256 KiB retained transcript limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    session.close();
  });
});
