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

async function waitForFakeSocket(): Promise<FakeWebSocketInstance> {
  let socket: FakeWebSocketInstance | undefined;
  await vi.waitFor(() => {
    socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected session to create a websocket");
    }
  });
  if (!socket) {
    throw new Error("expected session to create a websocket");
  }
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

  it("accepts the legacy openai-realtime alias", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    expect(provider.aliases).toContain("openai-realtime");
  });

  it("treats a Codex OAuth profile as configured when no API key is present", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const cfg = { auth: { order: { "openai-codex": ["openai-codex:default"] } } };
    providerAuthMocks.isProviderAuthProfileConfigured.mockReturnValue(true);

    expect(provider.isConfigured({ cfg: cfg as never, providerConfig: {} })).toBe(true);
    expect(providerAuthMocks.isProviderAuthProfileConfigured).toHaveBeenCalledWith({
      provider: "openai-codex",
      cfg,
    });
  });

  it("mints a Codex OAuth client secret for realtime transcription sockets", async () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const release = vi.fn();
    providerAuthMocks.resolveProviderAuthProfileApiKey.mockResolvedValue("oauth-token");
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response(JSON.stringify({ value: "ek-test" }), { status: 200 }),
      release,
    });
    const cfg = { auth: { order: { "openai-codex": ["openai-codex:default"] } } };
    const session = provider.createSession({
      cfg: cfg as never,
      providerConfig: {},
    });

    const connecting = session.connect();
    const socket = await waitForFakeSocket();

    expect(socket.headers?.Authorization).toBe("Bearer ek-test");
    expect(providerAuthMocks.resolveProviderAuthProfileApiKey).toHaveBeenCalledWith({
      provider: "openai-codex",
      cfg,
    });
    const request = mockCallArg(ssrfMocks.fetchWithSsrFGuard);
    expect(request.auditContext).toBe("openai-realtime-transcription-session");
    expect(request.url).toBe("https://api.openai.com/v1/realtime/transcription_sessions");
    const init = request.init as {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    };
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe("Bearer oauth-token");
    expect(init.headers?.["Content-Type"]).toBe("application/json");
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toEqual({
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
    session.close();
  });

  it("waits for the OpenAI session update before draining audio", async () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "sk-test", // pragma: allowlist secret
        language: "en",
        model: "gpt-4o-transcribe",
        prompt: "expect OpenClaw product names",
        silenceDurationMs: 900,
        vadThreshold: 0.45,
      },
    });

    const connecting = session.connect();
    const socket = await waitForFakeSocket();

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    session.sendAudio(Buffer.from("before-ready"));

    expect(session.isConnected()).toBe(false);
    expect(parseSent(socket)).toEqual([
      {
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
      },
    ]);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    expect(session.isConnected()).toBe(true);
    expect(parseSent(socket)).toEqual([
      {
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
      },
      {
        type: "input_audio_buffer.append",
        audio: Buffer.from("before-ready").toString("base64"),
      },
    ]);
    session.close();
  });
});
