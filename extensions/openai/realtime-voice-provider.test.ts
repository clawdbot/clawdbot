// Openai tests cover realtime voice provider plugin behavior.
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import type { RealtimeVoiceBridge, RealtimeVoiceTool } from "openclaw/plugin-sdk/realtime-voice";
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
    deferClose = false;
    deferredClose: (() => void) | undefined;
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
      const emitClose = () => this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
      if (this.deferClose) {
        this.deferredClose = emitClose;
        return;
      }
      emitClose();
    }

    terminate(): void {
      this.terminated = true;
      this.close(1006, "terminated");
    }

    emitDeferredClose(): void {
      const emitClose = this.deferredClose;
      this.deferredClose = undefined;
      emitClose?.();
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
  event_id?: string;
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
    tools?: Array<{ name?: string }>;
    audio?: {
      input?: {
        format?: Record<string, unknown>;
        noise_reduction?: Record<string, unknown> | null;
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

function expectedResponseCreateEvent() {
  return expect.objectContaining({
    type: "response.create",
    event_id: expect.stringMatching(/^openclaw-response-create-/),
  });
}

function expectedResponseCancelEvent() {
  return expect.objectContaining({
    type: "response.cancel",
    event_id: expect.stringMatching(/^openclaw-response-cancel-/),
  });
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

function firstMockCall(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
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

function createRealtimeTool(name: string): RealtimeVoiceTool {
  return {
    type: "function",
    name,
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  };
}

function createUnreadableToolName(): RealtimeVoiceTool {
  return {
    type: "function",
    get name(): string {
      throw new Error("unreadable tool name");
    },
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  };
}

function createMalformedToolName(name: unknown): RealtimeVoiceTool {
  return {
    type: "function",
    name,
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  } as unknown as RealtimeVoiceTool;
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

    expect(provider.defaultModel).toBe("gpt-realtime-2.1");
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
      handlesInputAudioBargeIn: true,
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
    expect(bridge.supportsToolResultSuppression).toBe(true);
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
    const options = socket?.args[1] as
      | { headers?: Record<string, string>; maxPayload?: number }
      | undefined;
    expectRecordFields(options?.headers, "websocket headers", {
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
    expect(options?.headers).not.toHaveProperty("OpenAI-Beta");
    expect(options?.maxPayload).toBe(16 * 1024 * 1024);
  });

  it("requires Platform auth for native realtime websocket bridges", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: { model: "gpt-realtime-2" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI Realtime voice requires an OpenAI Platform API key",
    );

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("uses OPENAI_API_KEY for default GPT realtime bridges", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env"); // pragma: allowlist secret
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

    expect(resolveProviderAuthProfileApiKeyMock.mock.calls).toEqual([
      [{ provider: "openai", cfg: {}, profileTypes: ["api_key"] }],
    ]);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    const socket = FakeWebSocket.instances[0];
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer sk-env");
  });

  it("does not use Codex OAuth profiles for default GPT realtime bridges", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: { model: "gpt-realtime-2" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI Realtime voice requires an OpenAI Platform API key",
    );

    expect(resolveProviderAuthProfileApiKeyMock.mock.calls).toEqual([
      [{ provider: "openai", cfg: {}, profileTypes: ["api_key"] }],
    ]);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("uses OPENAI_API_KEY when a configured API-key profile cannot be resolved", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env"); // pragma: allowlist secret
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce(undefined);
    isProviderAuthProfileConfiguredMock.mockReturnValueOnce(true);
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

    expect(resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledTimes(1);
    const socket = FakeWebSocket.instances[0];
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer sk-env");
  });

  it("uses OpenAI API-key auth profiles", async () => {
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("sk-profile"); // pragma: allowlist secret
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

    expect(resolveProviderAuthProfileApiKeyMock.mock.calls).toEqual([
      [{ provider: "openai", cfg: {}, profileTypes: ["api_key"] }],
    ]);
    const socket = FakeWebSocket.instances[0];
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer sk-profile");
  });

  it("keeps explicit OpenAI realtime API keys as the advanced override", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env"); // pragma: allowlist secret
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("sk-profile"); // pragma: allowlist secret
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: {
        apiKey: "sk-configured", // pragma: allowlist secret
        model: "gpt-realtime-2",
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void bridge.connect();
    bridge.close();

    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalled();
    const socket = FakeWebSocket.instances[0];
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer sk-configured");
  });

  it("requires an API key for custom realtime endpoints", async () => {
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

    await expect(bridge.connect()).rejects.toThrow("OpenAI Realtime voice requires an API key");

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
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
      policy: {
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
        hostnameAllowlist: ["api.openai.com"],
      },
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
    expect(bodySession.model).toBe("gpt-realtime-2.1");
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
      model: "gpt-realtime-2.1",
      expiresAt: 1_765_000_000_000,
    });
    // originator, version, and User-Agent are server-side attribution headers; they
    // must not be forwarded to the browser so that the browser's direct SDP POST to
    // api.openai.com passes the CORS preflight (only authorization,content-type
    // allowed — #76435). All three are filtered, leaving no browser offer headers.
    expect((session as { offerHeaders?: Record<string, string> }).offerHeaders).toBeUndefined();
  });

  it.each(["configured", "profile", "environment"] as const)(
    "explains how auth precedence affects a rejected %s API key",
    async (source) => {
      if (source === "profile") {
        resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("sk-profile"); // pragma: allowlist secret
      } else if (source === "environment") {
        vi.stubEnv("OPENAI_API_KEY", "sk-env"); // pragma: allowlist secret
      }
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: createJsonResponse(
          { error: { message: "Incorrect API key provided: sk-proj-***" } },
          { status: 401 },
        ),
        release: vi.fn(async () => undefined),
      });
      const provider = buildOpenAIRealtimeVoiceProvider();
      if (!provider.createBrowserSession) {
        throw new Error("expected OpenAI realtime provider to support browser sessions");
      }

      await expect(
        provider.createBrowserSession({
          providerConfig:
            source === "configured"
              ? { apiKey: "sk-stale" } // pragma: allowlist secret
              : {},
        }),
      ).rejects.toThrow(
        "OpenAI Realtime rejected the selected API key. Update or remove the active OpenAI API-key source",
      );
    },
  );

  it("omits unsupported OpenAI tool names from browser sessions", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: createJsonResponse({ client_secret: { value: "client-secret-123" } }),
      release: vi.fn(async () => undefined),
    });
    const provider = buildOpenAIRealtimeVoiceProvider();
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }

    await provider.createBrowserSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      tools: [
        createRealtimeTool("1_lookup"),
        createRealtimeTool("calendar.lookup:next"),
        createMalformedToolName(undefined),
        createUnreadableToolName(),
      ],
    });

    const bodySession = requireRecord(requireFetchJsonBody().session, "fetch session");
    const tools = bodySession.tools as Array<{ name?: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["1_lookup"]);
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

    const [securityBinary, securityArgs, securityOptions] = firstMockCall(
      execFileSyncMock,
      "security keychain lookup",
    );
    expect(securityBinary).toBe("/usr/bin/security");
    expect(securityArgs).toEqual([
      "find-generic-password",
      "-s",
      "openclaw",
      "-a",
      "OPENAI_REALTIME_BROWSER_TEST",
      "-w",
    ]);
    expectRecordFields(securityOptions, "security command options", {
      encoding: "utf8",
      timeout: 5000,
    });
    expectRecordFields(requireFetchHeaders(), "fetch headers", {
      Authorization: "Bearer sk-browser-env", // pragma: allowlist secret
    });
  });

  it("resolves and caches keychain OPENAI_API_KEY refs before creating bridges", async () => {
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
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
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

  it("does not treat Codex OAuth profiles as configured for realtime sessions", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const cfg = { agents: { defaults: {} } } as never;

    expect(provider.isConfigured({ cfg, providerConfig: {} })).toBe(false);
    expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith({
      provider: "openai",
      cfg,
      profileTypes: ["api_key"],
    });
  });

  it("treats OpenAI API-key auth profiles as configured for browser realtime sessions", () => {
    isProviderAuthProfileConfiguredMock.mockReturnValue(true);
    const provider = buildOpenAIRealtimeVoiceProvider();
    const cfg = { agents: { defaults: {} } } as never;

    expect(provider.isConfigured({ cfg, providerConfig: {} })).toBe(true);
    expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith({
      provider: "openai",
      cfg,
      profileTypes: ["api_key"],
    });
  });

  it("does not configure Azure realtime sessions without a Platform API key", () => {
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
  });

  it("requires Platform auth before minting browser realtime client secrets", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }
    const cfg = { agents: { defaults: {} } } as never;

    await expect(
      provider.createBrowserSession({
        cfg,
        providerConfig: {},
        instructions: "Be concise.",
      }),
    ).rejects.toThrow("OpenAI Realtime voice requires an OpenAI Platform API key");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("uses OPENAI_API_KEY for default GPT browser sessions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env"); // pragma: allowlist secret
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
      model: "gpt-realtime-2",
      instructions: "Be concise.",
    });

    expectRecordFields(requireFetchHeaders(), "fetch headers", {
      Authorization: "Bearer sk-env", // pragma: allowlist secret
    });
  });

  it("fails closed when keychain refs cannot be resolved", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_MISSING_TEST");
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce(undefined);
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("keychain unavailable");
    });
    const provider = buildOpenAIRealtimeVoiceProvider();

    const bridge = provider.createBridge({
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI Realtime voice requires an OpenAI Platform API key",
    );
    expect(resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a configured API-key profile cannot be resolved", async () => {
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce(undefined);
    isProviderAuthProfileConfiguredMock.mockReturnValueOnce(true);
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI Realtime voice requires an OpenAI Platform API key",
    );
    expect(resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledTimes(1);
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

  it("drops malformed realtime voice numeric settings", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            vadThreshold: 1.5,
            silenceDurationMs: -1,
            prefixPaddingMs: 10.5,
            minBargeInAudioEndMs: 25.5,
          },
        },
      },
    });

    expect(resolved?.vadThreshold).toBeUndefined();
    expect(resolved?.silenceDurationMs).toBeUndefined();
    expect(resolved?.prefixPaddingMs).toBeUndefined();
    expect(resolved?.minBargeInAudioEndMs).toBeUndefined();
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
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
    });
    const inputAudio = requireNestedRecord(session, ["audio", "input"]);
    expectRecordFields(inputAudio, "session audio input", {
      format: { type: "audio/pcmu" },
      noise_reduction: null,
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

  it("suppresses auto responses before draining queued initial greeting audio", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridgeRef: { current?: RealtimeVoiceBridge } = {};
    const onReady = vi.fn(() => {
      bridgeRef.current?.triggerGreeting?.("Say exactly: hello from explicit speech.");
    });
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      instructions: "Be helpful.",
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
    });
    bridgeRef.current = bridge;
    const connecting = bridge.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    await Promise.resolve();

    bridge.sendAudio(Buffer.from("before-ready"));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    const sent = parseSent(socket);
    expect(sent.map((event) => event.type)).toEqual([
      "session.update",
      "conversation.item.create",
      "session.update",
      "response.create",
      "input_audio_buffer.append",
    ]);
    expect(sent[2]).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: false,
              interrupt_response: true,
            },
          },
        },
      },
    });
    expect(sent[4]).toEqual({
      type: "input_audio_buffer.append",
      audio: Buffer.from("before-ready").toString("base64"),
    });
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    expect(onReady).toHaveBeenCalledTimes(1);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });

  it("omits unsupported OpenAI tool names from GA session updates", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      tools: [
        createRealtimeTool("1_lookup"),
        createRealtimeTool("calendar.lookup:next"),
        createRealtimeTool("bad/name"),
        createRealtimeTool("x".repeat(65)),
        createMalformedToolName(null),
        createMalformedToolName(42),
        createUnreadableToolName(),
      ],
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

    const tools = requireSession(socket).tools as Array<{ name?: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["1_lookup", "x".repeat(65)]);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;
  });

  it("rotates realtime bridges on provider max-duration events without reporting an error", async () => {
    vi.useFakeTimers();
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
      onEvent,
    });
    const connecting = bridge.connect();
    const firstSocket = FakeWebSocket.instances[0];
    if (!firstSocket) {
      throw new Error("expected bridge to create a websocket");
    }

    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit("open");
    firstSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: { message: "Your session hit the maximum duration of 60 minutes." },
        }),
      ),
    );

    expect(onError).not.toHaveBeenCalled();
    expect(firstSocket.closed).toBe(true);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "session.rotation",
      detail: "reason=max-duration",
    });
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.reconnect.scheduled",
      detail: "reason=max-duration attempt=1 delayMs=1000",
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const secondSocket = FakeWebSocket.instances[1];
    if (!secondSocket) {
      throw new Error("expected bridge to reconnect");
    }
    secondSocket.readyState = FakeWebSocket.OPEN;
    secondSocket.emit("open");
    secondSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));

    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({
        direction: "server",
        type: "session.rotation.ready",
        detail: "reason=max-duration",
      }),
    );
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({
        direction: "client",
        type: "session.reconnect.ready",
        detail: "reason=max-duration attempt=1",
      }),
    );
    expect(bridge.isConnected()).toBe(true);

    bridge.close();
  });

  it("cancels a pending reconnect and allows a later explicit connect", async () => {
    vi.useFakeTimers();
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

    socket.readyState = FakeWebSocket.CLOSED;
    socket.emit("close", 1006, Buffer.from("transient drop"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    bridge.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();

    const reconnecting = bridge.connect();
    const reconnectedSocket = FakeWebSocket.instances[1];
    if (!reconnectedSocket) {
      throw new Error("expected bridge to reconnect after close");
    }
    reconnectedSocket.readyState = FakeWebSocket.OPEN;
    reconnectedSocket.emit("open");
    reconnectedSocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await reconnecting;

    expect(bridge.isConnected()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
    bridge.close();
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
      tools: [
        createRealtimeTool("1_lookup"),
        createRealtimeTool("calendar.lookup:next"),
        createRealtimeTool("x".repeat(65)),
      ],
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
    const tools = session.tools as Array<{ name?: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["1_lookup"]);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    bridge.triggerGreeting?.("Say hello.");
    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "session.update",
        session: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: false,
          },
        },
      },
      expectedResponseCreateEvent(),
    ]);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));
    expect(parseSent(socket).at(-1)).toEqual({
      type: "session.update",
      session: {
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        },
      },
    });
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

  it("treats pre-ready auth errors as a single startup failure", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
      onClose,
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
          error: { message: "Incorrect API key provided" },
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: { message: "Incorrect API key provided" },
        }),
      ),
    );

    await expect(connecting).rejects.toThrow("Incorrect API key provided");
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    expect(bridge.isConnected()).toBe(false);
  });

  it("keeps a retried connection ready after delayed startup failure close", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onClose,
    });
    const failedConnect = bridge.connect();
    const failedSocket = FakeWebSocket.instances[0];
    if (!failedSocket) {
      throw new Error("expected bridge to create a websocket");
    }
    failedSocket.deferClose = true;

    failedSocket.readyState = FakeWebSocket.OPEN;
    failedSocket.emit("open");
    failedSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: { message: "Incorrect API key provided" },
        }),
      ),
    );

    await expect(failedConnect).rejects.toThrow("Incorrect API key provided");
    expect(failedSocket.deferredClose).toBeDefined();

    const retryConnect = bridge.connect();
    const retrySocket = FakeWebSocket.instances[1];
    if (!retrySocket) {
      throw new Error("expected bridge retry to create a websocket");
    }
    retrySocket.readyState = FakeWebSocket.OPEN;
    retrySocket.emit("open");
    retrySocket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await retryConnect;

    expect(bridge.isConnected()).toBe(true);
    failedSocket.emitDeferredClose();
    expect(bridge.isConnected()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
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

  it("does not report startup timeout shutdown as a clean close", async () => {
    vi.useFakeTimers();
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

    const timeoutAssertion = expect(connecting).rejects.toThrow(
      "OpenAI realtime connection timeout",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await timeoutAssertion;
    expect(socket.terminated).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
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
    expect(hasSentEventType(socket, "response.cancel")).toBe(false);
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
    expect(hasSentEventType(socket, "response.cancel")).toBe(false);
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
    const bridge: ReturnType<typeof provider.createBridge> = provider.createBridge({
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
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 300,
      },
    ]);
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

    const sent = parseSent(socket);
    expect(sent[1]).toEqual({
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
    });
    expectRecordFields(
      requireNestedRecord(sent[2]?.session, ["audio", "input", "turn_detection"]),
      "manual response turn detection",
      {
        create_response: false,
        interrupt_response: true,
      },
    );
    expect(sent[3]).toEqual(expectedResponseCreateEvent());
    expect(JSON.stringify(parseSent(socket).at(-1))).not.toContain("output_modalities");
    expect(onEvent).toHaveBeenCalledWith({ direction: "client", type: "conversation.item.create" });
    expect(onEvent).toHaveBeenCalledWith({ direction: "client", type: "response.create" });

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
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

    void bridge.submitToolResult("call_1", { text: "done" });

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

    expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);
  });

  it("restores automatic audio responses when a manual response is rejected", async () => {
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

    bridge.triggerGreeting?.("Say exactly: hello from explicit speech.");

    const responseCreateEvent = parseSent(socket).findLast(
      (event) => event.type === "response.create",
    );
    if (!responseCreateEvent?.event_id) {
      throw new Error("expected response.create event id");
    }

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-2)?.session, ["audio", "input", "turn_detection"]),
      "suppressed turn detection",
      {
        create_response: false,
        interrupt_response: true,
      },
    );

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: {
            event_id: responseCreateEvent.event_id,
            message: "bad response request",
          },
        }),
      ),
    );

    expect(onError).toHaveBeenCalledWith(new Error("bad response request"));
    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });

  it("keeps automatic audio suppressed for unrelated errors during a manual response", async () => {
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

    bridge.triggerGreeting?.("Say exactly: hello from explicit speech.");
    const sessionUpdatesBeforeError = parseSent(socket).filter(
      (event) => event.type === "session.update",
    );

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: { event_id: "unrelated-audio-event", message: "bad audio append" },
        }),
      ),
    );

    expect(onError).toHaveBeenCalledWith(new Error("bad audio append"));
    expect(parseSent(socket).filter((event) => event.type === "session.update")).toHaveLength(
      sessionUpdatesBeforeError.length,
    );

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });

  it("flushes a queued manual response after the prior request is rejected", async () => {
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

    bridge.triggerGreeting?.("Say exactly: first greeting.");
    const firstResponseCreate = parseSent(socket).findLast(
      (event) => event.type === "response.create",
    );
    if (!firstResponseCreate?.event_id) {
      throw new Error("expected first response.create event id");
    }
    const sessionUpdateCount = parseSent(socket).filter(
      (event) => event.type === "session.update",
    ).length;

    bridge.sendUserMessage?.("Say exactly: queued follow-up.");
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: {
            event_id: firstResponseCreate.event_id,
            message: "bad response request",
          },
        }),
      ),
    );

    const responseCreates = parseSent(socket).filter((event) => event.type === "response.create");
    expect(responseCreates).toHaveLength(2);
    expect(responseCreates[1]).toEqual(expectedResponseCreateEvent());
    expect(responseCreates[1]?.event_id).not.toBe(firstResponseCreate.event_id);
    expect(parseSent(socket).filter((event) => event.type === "session.update")).toHaveLength(
      sessionUpdateCount,
    );
    expect(onError).toHaveBeenCalledWith(new Error("bad response request"));

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
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

    void bridge.submitToolResult("call_1", { status: "working" }, { willContinue: true });

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
    expect(hasSentEventType(socket, "response.create")).toBe(false);

    void bridge.submitToolResult("call_1", { text: "done" });

    expect(parseSent(socket).slice(-3)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ text: "done" }),
        },
      },
      expect.objectContaining({ type: "session.update" }),
      expectedResponseCreateEvent(),
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

    void bridge.submitToolResult(
      "call_1",
      { status: "already_delivered" },
      { suppressResponse: true },
    );

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
    expect(hasSentEventType(socket, "response.create")).toBe(false);
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

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.created", response: { id: "resp_1" } })),
    );
    void bridge.submitToolResult("call_1", { status: "working" }, { willContinue: true });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toEqual([]);

    void bridge.submitToolResult("call_1", { text: "done" });

    expect(parseSent(socket).slice(-3)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ text: "done" }),
        },
      },
      expect.objectContaining({ type: "session.update" }),
      expectedResponseCreateEvent(),
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

    void bridge.submitToolResult("call_1", { text: "done" });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.cancelled" })));

    expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);
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
    expect(hasSentEventType(socket, "response.cancel")).toBe(false);
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

    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 0,
      },
    ]);
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

    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 0,
      },
    ]);
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

    void bridge.submitToolResult("call_1", { text: "done" });
    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    const responseCancelEvent = parseSent(socket).findLast(
      (event) => event.type === "response.cancel",
    );
    if (!responseCancelEvent?.event_id) {
      throw new Error("expected response.cancel event id");
    }
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: {
            event_id: responseCancelEvent.event_id,
            message: "Cancellation failed: no active response found",
          },
        }),
      ),
    );

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);
  });

  it("ignores a stale cancellation error after a newer manual response starts", async () => {
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
    const responseCancelEvent = parseSent(socket).findLast(
      (event) => event.type === "response.cancel",
    );
    if (!responseCancelEvent?.event_id) {
      throw new Error("expected response.cancel event id");
    }
    void bridge.submitToolResult("call_1", { text: "done" });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));
    const sessionUpdateCount = parseSent(socket).filter(
      (event) => event.type === "session.update",
    ).length;

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: {
            event_id: responseCancelEvent.event_id,
            message: "Cancellation failed: no active response found",
          },
        }),
      ),
    );

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).filter((event) => event.type === "session.update")).toHaveLength(
      sessionUpdateCount,
    );
    expect(parseSent(socket).at(-1)).toEqual(expectedResponseCreateEvent());

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));
    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
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
    void bridge.submitToolResult("call_1", { text: "done" });

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

    expect(parseSent(reconnectedSocket).slice(-3)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello after reconnect." }],
        },
      },
      expect.objectContaining({ type: "session.update" }),
      expectedResponseCreateEvent(),
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

    void bridge.submitToolResult("call_1", { text: "done" });
    const responseCreateEvent = parseSent(socket).findLast(
      (event) => event.type === "response.create",
    );
    if (!responseCreateEvent?.event_id) {
      throw new Error("expected response.create event id");
    }
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: {
            event_id: responseCreateEvent.event_id,
            message: "Conversation already has an active response in progress: resp_1",
          },
        }),
      ),
    );
    const afterError = parseSent(socket);
    expect(afterError.filter((event) => event.type === "session.update")).toHaveLength(2);
    expectRecordFields(
      requireNestedRecord(afterError.at(-2)?.session, ["audio", "input", "turn_detection"]),
      "still suppressed turn detection",
      {
        create_response: false,
        interrupt_response: true,
      },
    );

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).slice(-1)).toEqual([expectedResponseCreateEvent()]);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "response.done" })));

    expectRecordFields(
      requireNestedRecord(parseSent(socket).at(-1)?.session, ["audio", "input", "turn_detection"]),
      "restored turn detection",
      {
        create_response: true,
        interrupt_response: true,
      },
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
