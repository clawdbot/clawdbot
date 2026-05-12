import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const {
  FakeWebSocket,
  execFileSyncMock,
  fetchWithSsrFGuardMock,
  isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKeyMock,
} = vi.hoisted(() => {
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
    execFileSyncMock: vi.fn(),
    fetchWithSsrFGuardMock: vi.fn(),
    isProviderAuthProfileConfiguredMock: vi.fn(),
    resolveProviderAuthProfileApiKeyMock: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: resolveProviderAuthProfileApiKeyMock,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  item_id?: string;
  content_index?: number;
  audio_end_ms?: number;
  session?: {
    type?: string;
    model?: string;
    modalities?: string[];
    instructions?: string;
    voice?: string;
    input_audio_format?: string;
    output_audio_format?: string;
    input_audio_transcription?: Record<string, unknown>;
    turn_detection?: {
      create_response?: boolean;
    };
    output_modalities?: string[];
    audio?: {
      input?: {
        format?: Record<string, unknown>;
        noise_reduction?: Record<string, unknown>;
        transcription?: Record<string, unknown>;
        turn_detection?: {
          create_response?: boolean;
          interrupt_response?: boolean;
        };
      };
      output?: {
        format?: Record<string, unknown>;
        voice?: string;
      };
    };
    item?: unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isRecord(value), `${label} must be an object`).toBe(true);
  return value as Record<string, unknown>;
}

function requireNestedRecord(
  value: unknown,
  path: readonly string[],
  label = path.join("."),
): Record<string, unknown> {
  let current = requireRecord(value, label);
  for (const key of path) {
    current = requireRecord(current[key], `${label}.${key}`);
  }
  return current;
}

function expectRecordFields(
  value: unknown,
  label: string,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function requireFetchRequest(callIndex = 0): Record<string, unknown> {
  return requireRecord(fetchWithSsrFGuardMock.mock.calls[callIndex]?.[0], "fetch request");
}

function requireFetchInit(callIndex = 0): Record<string, unknown> {
  return requireRecord(requireFetchRequest(callIndex).init, "fetch init");
}

function requireFetchHeaders(callIndex = 0): Record<string, unknown> {
  return requireRecord(requireFetchInit(callIndex).headers, "fetch headers");
}

function requireFetchJsonBody(callIndex = 0): Record<string, unknown> {
  const body = requireFetchInit(callIndex).body;
  expect(typeof body, "fetch body must be a JSON string").toBe("string");
  return requireRecord(JSON.parse(body as string), "fetch JSON body");
}

function requireSession(socket: FakeWebSocketInstance, index = 0): Record<string, unknown> {
  return requireRecord(parseSent(socket)[index]?.session, "session");
}

function hasSentEventType(socket: FakeWebSocketInstance, type: string): boolean {
  return parseSent(socket).some((event) => event.type === type);
}

describe("buildOpenAIRealtimeVoiceProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubEnv("OPENAI_API_KEY", "");
    execFileSyncMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReturnValue(false);
    resolveProviderAuthProfileApiKeyMock.mockReset();
    resolveProviderAuthProfileApiKeyMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("declares realtime Talk capabilities for catalog selection", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();

    expect(provider.defaultModel).toBe("gpt-realtime-2");
    expect(provider.capabilities).toEqual({
      transports: ["webrtc", "gateway-relay"],
      inputAudioFormats: [
        { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
        { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      ],
      outputAudioFormats: [
        { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
        { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      ],
      supportsBrowserSession: true,
      supportsBargeIn: true,
      supportsToolCalls: true,
    });
  });

  it("advertises continuing realtime tool results", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    expect(bridge.supportsToolResultContinuation).toBe(true);
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
    expectRecordFields(options?.headers, "websocket headers", {
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
    expect(options?.headers).not.toHaveProperty("OpenAI-Beta");
  });

  it("mints an ephemeral Realtime secret for native websocket bridges when using Codex OAuth", async () => {
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("oauth-token");
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: createJsonResponse({
        client_secret: { value: "ephemeral-realtime-secret" },
      }),
      release: vi.fn(async () => undefined),
    });
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: { model: "gpt-realtime-2" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    bridge.close();

    expect(resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledWith({
      provider: "openai-codex",
      cfg: {},
    });
    const request = requireFetchRequest();
    expectRecordFields(request, "fetch request", {
      url: "https://api.openai.com/v1/realtime/client_secrets",
      auditContext: "openai-realtime-bridge-session",
    });
    expectRecordFields(requireFetchInit(), "fetch init", { method: "POST" });
    expectRecordFields(requireFetchHeaders(), "fetch headers", {
      Authorization: "Bearer oauth-token", // pragma: allowlist secret
      "Content-Type": "application/json",
    });
    const body = requireFetchJsonBody();
    const bodySession = requireRecord(body.session, "fetch session");
    expectRecordFields(bodySession, "fetch session", {
      type: "realtime",
      model: "gpt-realtime-2",
    });
    expectRecordFields(
      requireNestedRecord(bodySession, ["audio", "output"]),
      "fetch session output",
      {
        voice: "alloy",
      },
    );
    const socket = FakeWebSocket.instances[0];
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer ephemeral-realtime-secret");
    expect(options?.headers).not.toHaveProperty("OpenAI-Beta");
  });

  it("does not fall back to Codex OAuth for custom realtime endpoints", async () => {
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("oauth-token");
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: {
        azureEndpoint: "https://example.openai.azure.com",
        model: "gpt-realtime-2",
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow("OpenAI API key missing");

    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("does not open a native websocket after slow OAuth resolution times out", async () => {
    vi.useFakeTimers();
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("oauth-token");
    let resolveClientSecret: (value: {
      response: Response;
      release: () => Promise<void>;
    }) => void = () => {};
    fetchWithSsrFGuardMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClientSecret = resolve;
      }),
    );
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: { model: "gpt-realtime-2" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const connecting = expect(bridge.connect()).rejects.toThrow(
      "OpenAI realtime connection timeout",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await connecting;

    resolveClientSecret({
      response: createJsonResponse({
        client_secret: { value: "ephemeral-realtime-secret" },
      }),
      release: vi.fn(async () => undefined),
    });
    await vi.runAllTimersAsync();

    expect(FakeWebSocket.instances).toHaveLength(0);
    bridge.close();
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
      voice: " Marin ",
    });

    expectRecordFields(requireFetchRequest(), "fetch request", {
      url: "https://api.openai.com/v1/realtime/client_secrets",
    });
    expectRecordFields(requireFetchInit(), "fetch init", { method: "POST" });
    expectRecordFields(requireFetchHeaders(), "fetch headers", {
      Authorization: "Bearer sk-test", // pragma: allowlist secret
      "Content-Type": "application/json",
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
    const body = requireFetchJsonBody();
    const bodySession = requireRecord(body.session, "fetch session");
    expect(bodySession.model).toBe("gpt-realtime-2");
    expect(requireNestedRecord(bodySession, ["audio", "input"])).toEqual({
      noise_reduction: { type: "near_field" },
      turn_detection: {
        type: "server_vad",
        create_response: true,
        interrupt_response: true,
      },
      transcription: { model: "gpt-4o-mini-transcribe" },
    });
    expect(requireNestedRecord(bodySession, ["audio", "output"])).toEqual({ voice: "marin" });
    expect(bodySession).not.toHaveProperty("temperature");
    expectRecordFields(session, "browser session", {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "client-secret-123",
      offerUrl: "https://api.openai.com/v1/realtime/calls",
      model: "gpt-realtime-2",
    });
    // originator, version, and User-Agent are server-side attribution headers; they
    // must not be forwarded to the browser so that the browser's direct SDP POST to
    // api.openai.com passes the CORS preflight (only authorization,content-type
    // allowed — #76435). All three are filtered, leaving no browser offer headers.
    expect((session as { offerHeaders?: Record<string, string> }).offerHeaders).toBeUndefined();
  });

  it("resolves keychain OPENAI_API_KEY refs before creating browser sessions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_BROWSER_TEST");
    execFileSyncMock.mockReturnValueOnce("sk-browser-env\n"); // pragma: allowlist secret
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: createJsonResponse({
        client_secret: { value: "client-secret-123" },
      }),
      release: vi.fn(async () => undefined),
    });
    const provider = buildOpenAIRealtimeVoiceProvider();
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }

    await provider.createBrowserSession({
      providerConfig: {},
      instructions: "Be concise.",
    });

    expect(execFileSyncMock.mock.calls.at(0)?.[0]).toBe("/usr/bin/security");
    expect(execFileSyncMock.mock.calls.at(0)?.[1]).toEqual([
      "find-generic-password",
      "-s",
      "openclaw",
      "-a",
      "OPENAI_REALTIME_BROWSER_TEST",
      "-w",
    ]);
    expectRecordFields(execFileSyncMock.mock.calls.at(0)?.[2], "security command options", {
      encoding: "utf8",
      timeout: 5000,
    });
    expectRecordFields(requireFetchHeaders(), "fetch headers", {
      Authorization: "Bearer sk-browser-env", // pragma: allowlist secret
    });
  });

  it("resolves and caches keychain OPENAI_API_KEY refs before creating bridges", () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_BRIDGE_TEST");
    execFileSyncMock.mockReturnValue("sk-bridge-env\n"); // pragma: allowlist secret
    const provider = buildOpenAIRealtimeVoiceProvider();

    const first = provider.createBridge({
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    const second = provider.createBridge({
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    void first.connect();
    void second.connect();
    first.close();
    second.close();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    for (const socket of FakeWebSocket.instances) {
      const options = socket.args[1] as { headers?: Record<string, string> } | undefined;
      expectRecordFields(options?.headers, "websocket headers", {
        Authorization: "Bearer sk-bridge-env", // pragma: allowlist secret
      });
    }
  });

  it("does not resolve keychain refs during configured checks", () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_CONFIGURED_TEST");
    const provider = buildOpenAIRealtimeVoiceProvider();

    expect(provider.isConfigured({ providerConfig: {} })).toBe(true);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("treats OpenAI Codex OAuth profiles as configured for browser realtime sessions", () => {
    isProviderAuthProfileConfiguredMock.mockReturnValue(true);
    const provider = buildOpenAIRealtimeVoiceProvider();
    const cfg = { agents: { defaults: {} } } as never;

    expect(provider.isConfigured({ cfg, providerConfig: {} })).toBe(true);
    expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith({
      provider: "openai-codex",
      cfg,
    });
  });

  it("does not use Codex OAuth to configure Azure realtime sessions", () => {
    isProviderAuthProfileConfiguredMock.mockReturnValue(true);
    const provider = buildOpenAIRealtimeVoiceProvider();
    const cfg = { agents: { defaults: {} } } as never;

    expect(
      provider.isConfigured({
        cfg,
        providerConfig: {
          azureEndpoint: "https://example.openai.azure.com",
          azureDeployment: "realtime",
        },
      }),
    ).toBe(false);
    expect(isProviderAuthProfileConfiguredMock).not.toHaveBeenCalled();
  });

  it("uses OpenAI Codex OAuth to mint browser realtime client secrets when no API key is set", async () => {
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("oauth-realtime-token");
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: createJsonResponse({
        client_secret: { value: "client-secret-123" },
      }),
      release: vi.fn(async () => undefined),
    });
    const provider = buildOpenAIRealtimeVoiceProvider();
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }
    const cfg = { agents: { defaults: {} } } as never;

    await provider.createBrowserSession({
      cfg,
      providerConfig: {},
      instructions: "Be concise.",
    });

    expect(resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledWith({
      provider: "openai-codex",
      cfg,
    });
    expectRecordFields(requireFetchHeaders(), "fetch headers", {
      Authorization: "Bearer oauth-realtime-token", // pragma: allowlist secret
    });
  });

  it("fails closed when keychain refs cannot be resolved", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_MISSING_TEST");
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("keychain unavailable");
    });
    const provider = buildOpenAIRealtimeVoiceProvider();

    const bridge = provider.createBridge({
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow("OpenAI API key or Codex OAuth missing");
  });

  it("normalizes provider-owned voice settings from raw provider config", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            model: "gpt-realtime-2",
            voice: " Verse ",
            temperature: 0.6,
            silenceDurationMs: 850,
            vadThreshold: 0.35,
            reasoningEffort: "low",
          },
        },
      },
    });

    expect(resolved).toEqual({
      model: "gpt-realtime-2",
      voice: "verse",
      temperature: 0.6,
      silenceDurationMs: 850,
      vadThreshold: 0.35,
      reasoningEffort: "low",
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
    let connectResolved = false;
    void connecting.then(() => {
      connectResolved = true;
    });
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    await Promise.resolve();

    bridge.sendAudio(Buffer.from("before-ready"));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));

    expect(connectResolved).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(parseSent(socket).map((event) => event.type)).toEqual(["session.update"]);
    const session = requireSession(socket);
    expectRecordFields(session, "session", {
      type: "realtime",
      model: "gpt-realtime-2",
      output_modalities: ["audio"],
    });
    const inputAudio = requireNestedRecord(session, ["audio", "input"]);
    expectRecordFields(inputAudio, "session audio input", {
      format: { type: "audio/pcmu" },
      noise_reduction: { type: "near_field" },
      transcription: { model: "gpt-4o-mini-transcribe" },
    });
    expect(requireNestedRecord(session, ["audio", "output"])).toEqual({
      format: { type: "audio/pcmu" },
      voice: "alloy",
    });
    expect(session).not.toHaveProperty("temperature");
    expect(bridge.isConnected()).toBe(false);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    expect(connectResolved).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
    ]);
    expect(bridge.isConnected()).toBe(true);
  });

  it("keeps Azure deployment bridges on deployment-compatible session payloads", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "sk-test", // pragma: allowlist secret
        azureEndpoint: "https://example.openai.azure.com/",
        azureDeployment: "realtime-prod",
        azureApiVersion: "2024-10-01-preview",
        voice: "verse",
      },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions: "Be helpful.",
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    expect(socket.args[0]).toBe(
      "wss://example.openai.azure.com/openai/realtime?api-version=2024-10-01-preview&deployment=realtime-prod",
    );

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    await Promise.resolve();

    const session = requireSession(socket);
    expectRecordFields(session, "session", {
      modalities: ["text", "audio"],
      instructions: "Be helpful.",
      voice: "verse",
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      temperature: 0.8,
    });
    expectRecordFields(
      requireRecord(session.turn_detection, "session turn detection"),
      "turn detection",
      {
        create_response: true,
      },
    );
    expect(session).not.toHaveProperty("type");
    expect(session).not.toHaveProperty("audio");

    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
  });

  it("rejects connection when session configuration fails before readiness", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
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
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: { message: "invalid realtime session" },
        }),
      ),
    );

    await expect(connecting).rejects.toThrow("invalid realtime session");
    expect(bridge.isConnected()).toBe(false);
  });

  it("rejects connection when the socket closes before session readiness", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
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
    socket.close(1006, "session closed");

    await expect(connecting).rejects.toThrow("OpenAI realtime connection closed before ready");
    expect(bridge.isConnected()).toBe(false);
  });

  it("can disable automatic audio turn responses for agent-routed voice loops", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      autoRespondToAudio: false,
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
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    expectRecordFields(
      requireNestedRecord(requireSession(socket), ["audio", "input", "turn_detection"]),
      "turn detection",
      {
        create_response: false,
        interrupt_response: false,
      },
    );
  });

  it("can disable realtime response interruption while keeping audio responses enabled", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      autoRespondToAudio: true,
      interruptResponseOnInputAudio: false,
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
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    expectRecordFields(
      requireNestedRecord(requireSession(socket), ["audio", "input", "turn_detection"]),
      "turn detection",
      {
        create_response: true,
        interrupt_response: false,
      },
    );
  });

  it("does not locally clear playback on speech-start events when input interruption is disabled", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      autoRespondToAudio: true,
      interruptResponseOnInputAudio: false,
      onAudio,
      onClearAudio,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

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
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })),
    );

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).not.toHaveBeenCalled();
    expect(parseSent(socket)).not.toContainEqual({ type: "response.cancel" });
    expect(hasSentEventType(socket, "conversation.item.truncate")).toBe(false);
  });

  it("keeps assistant playback active on server VAD when automatic audio responses are disabled", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      autoRespondToAudio: false,
      onAudio,
      onClearAudio,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

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
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })),
    );

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).not.toHaveBeenCalled();
    expect(parseSent(socket)).not.toContainEqual({ type: "response.cancel" });
    expect(hasSentEventType(socket, "conversation.item.truncate")).toBe(false);
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
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    const session = requireSession(socket);
    expect(requireNestedRecord(session, ["audio", "input", "format"])).toEqual({
      type: "audio/pcm",
      rate: 24000,
    });
    expect(requireNestedRecord(session, ["audio", "output", "format"])).toEqual({
      type: "audio/pcm",
      rate: 24000,
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
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

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
    bridge.setMediaTimestamp(1300);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).toHaveBeenCalledTimes(1);
    expect(parseSent(socket)).toContainEqual({ type: "response.cancel" });
    expect(parseSent(socket)).toContainEqual({
      type: "conversation.item.truncate",
      item_id: "item_1",
      content_index: 0,
      audio_end_ms: 300,
    });
  });

  it("forwards current realtime output audio events", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio,
      onClearAudio: vi.fn(),
      onTranscript,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    const audio = Buffer.from("assistant audio");
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          item_id: "item_1",
          delta: audio.toString("base64"),
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio_transcript.done",
          transcript: "hello from current realtime events",
        }),
      ),
    );

    expect(onAudio).toHaveBeenCalledWith(audio);
    expect(onTranscript).toHaveBeenCalledWith(
      "assistant",
      "hello from current realtime events",
      true,
    );
  });

  it("forwards Codex-compatible legacy realtime audio and transcript events", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio,
      onClearAudio: vi.fn(),
      onTranscript,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    const audio = Buffer.from("legacy assistant audio");
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.output_audio.delta",
          data: audio.toString("base64"),
          sample_rate: 24000,
          channels: 1,
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.input_transcript.delta",
          delta: "partial user",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.output_transcript.delta",
          delta: "partial assistant",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_text.done",
          text: "final assistant text",
        }),
      ),
    );

    expect(onAudio).toHaveBeenCalledWith(audio);
    expect(onTranscript).toHaveBeenCalledWith("user", "partial user", false);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "partial assistant", false);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "final assistant text", true);
  });

  it("emits tool calls from realtime conversation item done events", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const onEvent = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
      onEvent,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.done",
          item: {
            id: "item_tool_1",
            type: "function_call",
            name: "openclaw_agent_consult",
            call_id: "call_1",
            arguments: JSON.stringify({ question: "delegate this" }),
          },
        }),
      ),
    );

    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_tool_1",
      callId: "call_1",
      name: "openclaw_agent_consult",
      args: { question: "delegate this" },
    });
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.done",
      detail: "function_call name=openclaw_agent_consult",
    });
  });

  it("deduplicates tool calls reported by arguments done and item done events", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

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
          type: "conversation.item.done",
          item: {
            id: "item_tool_1",
            type: "function_call",
            name: "openclaw_agent_consult",
            call_id: "call_1",
            arguments: JSON.stringify({ question: "delegate this" }),
          },
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

  it("creates an explicit user item and response for manual speech", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onEvent = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onEvent,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    bridge.triggerGreeting?.("Say exactly: hello from explicit speech.");

    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Say exactly: hello from explicit speech.",
            },
          ],
        },
      },
      {
        type: "response.create",
      },
    ]);
    expect(JSON.stringify(parseSent(socket).at(-1))).not.toContain("output_modalities");
    expect(onEvent).toHaveBeenCalledWith({ direction: "client", type: "conversation.item.create" });
    expect(onEvent).toHaveBeenCalledWith({ direction: "client", type: "response.create" });
  });

  it("defers manual response.create while a realtime response is active", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
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
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.created", response: { id: "resp_1" } })),
    );

    bridge.submitToolResult("call_1", { text: "done" });

    expect(parseSent(socket).slice(-1)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ text: "done" }),
        },
      },
    ]);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expect(parseSent(socket).slice(-1)).toEqual([{ type: "response.create" }]);
  });

  it("does not request a realtime response for continuing tool results", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
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
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    bridge.submitToolResult("call_1", { status: "working" }, { willContinue: true });

    expect(parseSent(socket).slice(-1)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ status: "working" }),
        },
      },
    ]);
    expect(parseSent(socket)).not.toContainEqual({ type: "response.create" });

    bridge.submitToolResult("call_1", { text: "done" });

    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ text: "done" }),
        },
      },
      { type: "response.create" },
    ]);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.created", response: { id: "resp_2" } })),
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
  });

  it("does not request a realtime response for suppressed tool results", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
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
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    bridge.submitToolResult("call_1", { status: "already_delivered" }, { suppressResponse: true });

    expect(parseSent(socket).slice(-1)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ status: "already_delivered" }),
        },
      },
    ]);
    expect(parseSent(socket)).not.toContainEqual({ type: "response.create" });
  });

  it("does not flush deferred response.create while a tool result is still continuing", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onError = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    bridge.submitToolResult("call_1", { status: "working" }, { willContinue: true });
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: {
            message: "Conversation already has an active response in progress: resp_1",
          },
        }),
      ),
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).some((event) => event.type === "response.create")).toBe(false);

    bridge.submitToolResult("call_1", { text: "done" });

    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ text: "done" }),
        },
      },
      { type: "response.create" },
    ]);
  });

  it("drains deferred response.create after response.cancelled", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
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
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.created", response: { id: "resp_1" } })),
    );

    bridge.submitToolResult("call_1", { text: "done" });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.cancelled" })));

    expect(parseSent(socket).slice(-1)).toEqual([{ type: "response.create" }]);
  });

  it("does not send duplicate response.cancel while cancellation is pending", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onEvent = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onEvent,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.created", response: { id: "resp_1" } })),
    );
    bridge.setMediaTimestamp(1000);
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
    bridge.setMediaTimestamp(1300);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(parseSent(socket).filter((event) => event.type === "response.cancel")).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "response.cancel",
      detail: "reason=barge-in",
    });
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "conversation.item.truncate",
      detail: "reason=barge-in audioEndMs=300",
    });
  });

  it("ignores zero-length playback barge-in without clearing audio", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio,
      onEvent,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
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

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onClearAudio).not.toHaveBeenCalled();
    expect(parseSent(socket)).not.toContainEqual({ type: "response.cancel" });
    expect(parseSent(socket).some((event) => event.type === "conversation.item.truncate")).toBe(
      false,
    );
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "conversation.item.truncate.skipped",
      detail: "reason=barge-in audioEndMs=0 minAudioEndMs=250",
    });
  });

  it("force-cancels zero-length playback barge-in for agent handoff fallback", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio,
      onEvent,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
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

    bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true });

    expect(parseSent(socket)).toContainEqual({ type: "response.cancel" });
    expect(hasSentEventType(socket, "conversation.item.truncate")).toBe(true);
    expect(onClearAudio).toHaveBeenCalled();
    expect(
      onEvent.mock.calls.some(
        ([event]) => isRecord(event) && event.type === "conversation.item.truncate.skipped",
      ),
    ).toBe(false);
  });

  it("allows immediate playback barge-in when the minimum audio window is zero", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "sk-test", // pragma: allowlist secret
        minBargeInAudioEndMs: 0,
      },
      onAudio: vi.fn(),
      onClearAudio,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
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

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onClearAudio).toHaveBeenCalledTimes(1);
    expect(parseSent(socket)).toContainEqual({ type: "response.cancel" });
    expect(parseSent(socket)).toContainEqual({
      type: "conversation.item.truncate",
      item_id: "item_1",
      content_index: 0,
      audio_end_ms: 0,
    });
  });

  it("drains deferred response.create after a no-active-response cancellation error", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onError = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.created", response: { id: "resp_1" } })),
    );

    bridge.submitToolResult("call_1", { text: "done" });
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: {
            message: "Cancellation failed: no active response found",
          },
        }),
      ),
    );

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).slice(-1)).toEqual([{ type: "response.create" }]);
  });

  it("resets deferred response guards after websocket reconnect", async () => {
    vi.useFakeTimers();
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
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
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.created", response: { id: "resp_1" } })),
    );
    bridge.submitToolResult("call_1", { text: "done" });

    expect(parseSent(socket).slice(-1)[0]?.type).toBe("conversation.item.create");

    socket.emit("close", 1006, Buffer.from("transient drop"));
    await vi.advanceTimersByTimeAsync(1000);
    const reconnectedSocket = FakeWebSocket.instances[1];
    if (!reconnectedSocket) {
      throw new Error("expected bridge to reconnect");
    }

    reconnectedSocket.readyState = FakeWebSocket.OPEN;
    reconnectedSocket.emit("open");
    reconnectedSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    bridge.sendUserMessage?.("Say hello after reconnect.");

    expect(parseSent(reconnectedSocket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello after reconnect." }],
        },
      },
      { type: "response.create" },
    ]);
  });

  it("turns active-response errors into a deferred response.create retry", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onError = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
    });
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    bridge.submitToolResult("call_1", { text: "done" });
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: {
            message: "Conversation already has an active response in progress: resp_1",
          },
        }),
      ),
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).slice(-1)).toEqual([{ type: "response.create" }]);
  });
});
