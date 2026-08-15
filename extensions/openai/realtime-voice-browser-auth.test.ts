// Openai tests cover realtime voice provider plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const {
  FakeWebSocket,
  execFileSyncMock,
  fetchWithSsrFGuardMock,
  isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKeyMock,
} = mocks;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mocks.execFileSyncMock,
  };
});

vi.mock("ws", () => ({
  default: mocks.FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  createNativeBridge,
  beginBridgeConnection,
  openSocket,
  emitServerEvent,
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
  resetTestState,
  restoreTestEnvironment,
  mockRealtimeClientSecretResponse,
  rejectedKeyMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
  createQuicksilverBrowserBrokerFixture,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice browser authentication", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
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

  it.each([
    {
      $name: "environment API key",
      environmentKey: "test-api-key-env",
      profileKey: undefined,
      configuredProfile: false,
      expectedAuthorization: "Bearer test-api-key-env",
      assertion: "environment" as const,
    },
    {
      $name: "API-key profile",
      environmentKey: undefined,
      profileKey: "test-api-key-profile",
      configuredProfile: false,
      expectedAuthorization: "Bearer test-api-key-profile",
      assertion: "profile" as const,
    },
    {
      $name: "environment fallback after an unresolved configured profile",
      environmentKey: "test-api-key-env",
      profileKey: undefined,
      configuredProfile: true,
      expectedAuthorization: "Bearer test-api-key-env",
      assertion: "fallback" as const,
    },
  ])(
    "$name",
    async ({ environmentKey, profileKey, configuredProfile, expectedAuthorization, assertion }) => {
      if (environmentKey) {
        vi.stubEnv("OPENAI_API_KEY", environmentKey);
      }
      resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce(profileKey);
      if (configuredProfile) {
        isProviderAuthProfileConfiguredMock.mockReturnValueOnce(true);
      }
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

      if (assertion === "fallback") {
        expect(resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledTimes(1);
      } else {
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
      }
      if (assertion === "environment") {
        expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      }
      const socket = FakeWebSocket.instances[0];
      const options = socket?.args[1] as { headers?: Record<string, string> } | undefined;
      expect(options?.headers?.Authorization).toBe(expectedAuthorization);
    },
  );

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
    mockRealtimeClientSecretResponse({ expiresAt: 1_765_000_000 });
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
    mockRealtimeClientSecretResponse();
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
    mockRealtimeClientSecretResponse();
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
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
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
    mockRealtimeClientSecretResponse();
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
    emitServerEvent(socket, {
      type: "error",
      error: { message: "Incorrect API key provided: test-api-key-proj-***" },
    });
    emitServerEvent(socket, {
      type: "error",
      error: { message: "Incorrect API key provided: test-api-key-proj-***" },
    });

    await expect(connecting).rejects.toThrow(OPENAI_REALTIME_REJECTED_KEY_MESSAGE);
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    expect(bridge.isConnected()).toBe(false);
  });

  it.each([
    {
      $name: "structured direct error expects normalization",
      event: "structured" as const,
      providerConfig: undefined,
      expectedMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
    },
    {
      $name: "direct handshake error expects normalization",
      event: "handshake" as const,
      providerConfig: undefined,
      expectedMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
    },
    {
      $name: "Azure handshake error expects raw preservation",
      event: "handshake" as const,
      providerConfig: {
        apiKey: "test-api-key-test",
        azureEndpoint: "https://example.openai.azure.com",
        azureDeployment: "realtime-prod",
      },
      expectedMessage: "Unexpected server response: 401",
    },
    {
      $name: "custom-endpoint handshake error expects raw preservation",
      event: "handshake" as const,
      providerConfig: {
        apiKey: "test-api-key-test",
        azureEndpoint: "https://realtime-proxy.example.com",
      },
      expectedMessage: "Unexpected server response: 401",
    },
  ])("$name", async ({ event, providerConfig, expectedMessage }) => {
    const bridge = createNativeBridge(providerConfig ? { providerConfig } : {});
    const { connecting, socket } = beginBridgeConnection(bridge);

    if (event === "structured") {
      openSocket(socket);
      emitServerEvent(socket, {
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_api_key",
          message: "Invalid API key",
        },
      });
    } else {
      socket.emit("error", new Error("Unexpected server response: 401"));
    }

    await expect(connecting).rejects.toThrow(expectedMessage);
    expect(bridge.isConnected()).toBe(false);
  });
});
