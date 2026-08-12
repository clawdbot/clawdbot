// Openai tests cover realtime voice provider plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const OPENAI_REALTIME_REJECTED_KEY_MESSAGE =
  "OpenAI Realtime rejected the selected API key. Update or remove the active OpenAI API-key source";

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
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  createNativeBridge,
  beginBridgeConnection,
  openSocket,
  createJsonResponse,
  requireRecord,
  requireNestedRecord,
  expectRecordFields,
  firstMockCall,
  requireFetchRequest,
  requireFetchInit,
  requireFetchHeaders,
  requireFetchJsonBody,
  createTestJwt,
} = createOpenAIRealtimeTestSupport({ FakeWebSocket, fetchWithSsrFGuardMock });

describe("OpenAI realtime voice browser authentication", () => {
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
    vi.stubEnv("OPENAI_API_KEY", "test-api-key-env");
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
      [
        {
          provider: "openai",
          cfg: {},
          profileTypes: ["api_key"],
          includeExternalCliAuth: false,
        },
      ],
    ]);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    const socket = FakeWebSocket.instances[0];
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer test-api-key-env");
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
      [
        {
          provider: "openai",
          cfg: {},
          profileTypes: ["api_key"],
          includeExternalCliAuth: false,
        },
      ],
    ]);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("uses OPENAI_API_KEY when a configured API-key profile cannot be resolved", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key-env");
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
    expect(options?.headers?.Authorization).toBe("Bearer test-api-key-env");
  });

  it("uses OpenAI API-key auth profiles", async () => {
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("test-api-key-profile");
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
      [
        {
          provider: "openai",
          cfg: {},
          profileTypes: ["api_key"],
          includeExternalCliAuth: false,
        },
      ],
    ]);
    const socket = FakeWebSocket.instances[0];
    const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer test-api-key-profile");
  });

  it("keeps explicit OpenAI realtime API keys as the advanced override", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key-env");
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("test-api-key-profile");
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: {
        apiKey: "test-api-key-configured",
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
    expect(options?.headers?.Authorization).toBe("Bearer test-api-key-configured");
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
      providerConfig: { apiKey: "test-api-key-test" },
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
      Authorization: "Bearer test-api-key-test",
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
        resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("test-api-key-profile");
      } else if (source === "environment") {
        vi.stubEnv("OPENAI_API_KEY", "test-api-key-env");
      }
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: createJsonResponse(
          { error: { message: "Incorrect API key provided: test-api-key-proj-***" } },
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
          providerConfig: source === "configured" ? { apiKey: "test-api-key-stale" } : {},
        }),
      ).rejects.toThrow(
        "OpenAI Realtime rejected the selected API key. Update or remove the active OpenAI API-key source",
      );
    },
  );

  it("resolves keychain OPENAI_API_KEY refs before creating browser sessions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_BROWSER_TEST");
    execFileSyncMock.mockReturnValueOnce("test-api-key-browser-env\n");
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
      Authorization: "Bearer test-api-key-browser-env",
    });
  });

  it("resolves and caches keychain OPENAI_API_KEY refs before creating bridges", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_BRIDGE_TEST");
    execFileSyncMock.mockReturnValue("test-api-key-bridge-env\n");
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
        Authorization: "Bearer test-api-key-bridge-env",
      });
    }
  });

  it("keeps Platform precedence for GA realtime when OAuth is also available", async () => {
    const oauthToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") ? oauthToken : undefined,
    );
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: createJsonResponse({ client_secret: { value: "client-secret-123" } }),
      release: vi.fn(async () => undefined),
    });
    const provider = buildOpenAIRealtimeVoiceProvider();

    await provider.createBrowserSession?.({
      providerConfig: { apiKey: "test-api-key-platform" },
      model: "gpt-realtime-2.1",
    });

    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileTypes: ["oauth"] }),
    );
    expectRecordFields(requireFetchHeaders(), "fetch headers", {
      Authorization: "Bearer test-api-key-platform",
    });
  });

  it("does not use GA OAuth fallback when a Platform credential source is unresolved", async () => {
    const oauthToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") ? oauthToken : undefined,
    );
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("api_key") === true,
    );
    const createBrowserSession = vi.fn();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: {
        capabilities: { handlesAgentConsult: true as const },
        createBrowserSession,
        cancelBrowserSession: vi.fn(),
      },
    });

    await expect(
      provider.createBrowserSession?.({
        cfg: {} as never,
        providerConfig: {},
        model: "gpt-realtime-2.1",
        agentId: "main",
        workspaceDir: "/tmp/openclaw-agent-workspace",
        initialItems: [],
      } as never),
    ).rejects.toThrow("OpenAI Realtime voice requires an OpenAI Platform API key");
    expect(createBrowserSession).not.toHaveBeenCalled();
    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileTypes: ["oauth"] }),
    );
  });

  it("requires Platform auth for browser sessions", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    await expect(
      provider.createBrowserSession?.({
        providerConfig: {},
      }),
    ).rejects.toThrow("OpenAI Realtime voice requires an OpenAI Platform API key");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("reports an unresolved Platform credential without trying another auth route", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_MISSING_TEST");
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("keychain unavailable");
    });
    const provider = buildOpenAIRealtimeVoiceProvider();

    await expect(
      provider.createBrowserSession?.({
        providerConfig: {},
      }),
    ).rejects.toThrow("OpenAI Realtime voice requires an OpenAI Platform API key");
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
      includeExternalCliAuth: false,
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
    vi.stubEnv("OPENAI_API_KEY", "test-api-key-env");
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
      Authorization: "Bearer test-api-key-env",
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

  it("treats pre-ready auth errors as a single startup failure", async () => {
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = createNativeBridge({ onError, onClose });
    const { connecting, socket } = beginBridgeConnection(bridge);

    openSocket(socket);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: { message: "Incorrect API key provided: test-api-key-proj-***" },
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: { message: "Incorrect API key provided: test-api-key-proj-***" },
        }),
      ),
    );

    await expect(connecting).rejects.toThrow(OPENAI_REALTIME_REJECTED_KEY_MESSAGE);
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    expect(bridge.isConnected()).toBe(false);
  });

  it("normalizes structured direct OpenAI startup auth errors", async () => {
    const bridge = createNativeBridge();
    const { connecting, socket } = beginBridgeConnection(bridge);

    openSocket(socket);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "invalid_api_key",
            message: "Invalid API key",
          },
        }),
      ),
    );

    await expect(connecting).rejects.toThrow(OPENAI_REALTIME_REJECTED_KEY_MESSAGE);
    expect(bridge.isConnected()).toBe(false);
  });

  it("normalizes direct OpenAI socket handshake auth errors", async () => {
    const bridge = createNativeBridge();
    const { connecting, socket } = beginBridgeConnection(bridge);

    socket.emit("error", new Error("Unexpected server response: 401"));

    await expect(connecting).rejects.toThrow(OPENAI_REALTIME_REJECTED_KEY_MESSAGE);
    expect(bridge.isConnected()).toBe(false);
  });

  it.each([
    [
      "Azure deployment",
      {
        apiKey: "test-api-key-test",
        azureEndpoint: "https://example.openai.azure.com",
        azureDeployment: "realtime-prod",
      },
    ],
    [
      "custom endpoint",
      {
        apiKey: "test-api-key-test",
        azureEndpoint: "https://realtime-proxy.example.com",
      },
    ],
  ])("preserves %s startup auth errors", async (_label, providerConfig) => {
    const bridge = createNativeBridge({
      providerConfig,
    });
    const { connecting, socket } = beginBridgeConnection(bridge);

    socket.emit("error", new Error("Unexpected server response: 401"));

    await expect(connecting).rejects.toThrow("Unexpected server response: 401");
    expect(bridge.isConnected()).toBe(false);
  });
});
