// Openai tests cover realtime voice provider plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const {
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

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...actual,
    isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
    resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
  };
});
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  requireRecord,
  requireFetchJsonBody,
  createRealtimeTool,
  createUnreadableToolName,
  createMalformedToolName,
  createTestJwt,
  resetTestState,
  restoreTestEnvironment,
  readInternalRealtimeVoiceProviderApi,
  mockRealtimeClientSecretResponse,
  createQuicksilverBrowserBrokerFixture,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice provider routing", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
  });

  it("declares realtime Talk capabilities for catalog selection", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();

    expect(provider.defaultModel).toBe("gpt-realtime-2.1");
    expect(provider.capabilities).toMatchObject({
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
      supportsVideoFrames: true,
    });
  });

  it("advertises continuing realtime tool results", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "test-api-key-test" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    expect(bridge.supportsToolResultContinuation).toBe(true);
    expect(bridge.supportsToolResultSuppression).toBe(true);
  });

  it.each([
    {
      $name: "browser capability projection",
      surface: "browser" as const,
      expected: {
        transports: ["webrtc", "gateway-relay"],
        handlesAgentConsult: true,
        supportsToolCalls: false,
        supportsVideoFrames: false,
      },
    },
    {
      $name: "gateway-relay capability projection",
      surface: "gateway-relay" as const,
      expected: {
        transports: ["webrtc", "gateway-relay"],
        handlesAgentConsult: true,
        supportsToolCalls: false,
      },
    },
  ])("$name", ({ surface, expected }) => {
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    const resolveCapabilities =
      surface === "browser"
        ? internalApi.resolveBrowserSessionCapabilities
        : internalApi.resolveGatewayRelayCapabilities;

    expect(
      resolveCapabilities({
        providerConfig: { model: "gpt-realtime-2.1" },
        model: "gpt-live-1-codex",
      }),
    ).toMatchObject(expected);
    expect(
      resolveCapabilities({
        providerConfig: { model: "gpt-realtime-2.1" },
        model: "gpt-live-1-mini",
      }),
    ).not.toHaveProperty("handlesAgentConsult");
  });

  it("omits unsupported OpenAI tool names from browser sessions", async () => {
    mockRealtimeClientSecretResponse();
    const provider = buildOpenAIRealtimeVoiceProvider();
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }

    await provider.createBrowserSession({
      providerConfig: { apiKey: "test-api-key-test" },
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
      includeExternalCliAuth: false,
    });
  });

  it("checks Platform API-key profiles in the requested agent scope", () => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ agentDir }: { agentDir?: string }) => agentDir?.includes("voice-agent") === true,
    );
    const provider = buildOpenAIRealtimeVoiceProvider();
    const cfg = {
      agents: { list: [{ id: "main" }, { id: "voice-agent" }] },
    } as never;

    expect(
      provider.isConfigured({
        agentId: "voice-agent",
        cfg,
        providerConfig: {},
      }),
    ).toBe(true);
    expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith({
      provider: "openai",
      cfg,
      agentDir: expect.stringContaining("voice-agent"),
      profileTypes: ["api_key"],
      includeExternalCliAuth: false,
    });
  });

  it("routes gpt-live Platform sessions through the native quicksilver broker", async () => {
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const request = {
      providerConfig: { apiKey: "test-api-key-platform" },
      model: "gpt-live-1",
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    };

    await expect(provider.createBrowserSession?.(request)).resolves.toMatchObject({
      offerUrl: "/plugins/openai/realtime/calls",
    });
    expect(createBrowserSession).toHaveBeenCalledWith(expect.objectContaining(request), {
      type: "api-key",
      token: "test-api-key-platform",
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      $name: "provider | gpt-live-1-mini | ChatGPT OAuth | standard endpoint | not ready",
      surface: "provider" as const,
      providerConfig: { model: "gpt-live-1-mini" },
      agentId: "main",
      expected: false,
      expectAgentDir: false,
    },
    {
      $name: "gateway-relay | gpt-live-1-mini | ChatGPT OAuth | standard endpoint | not ready",
      surface: "gateway-relay" as const,
      providerConfig: { model: "gpt-live-1-mini" },
      agentId: "main",
      expected: false,
      expectAgentDir: false,
    },
    {
      $name: "gateway-relay | gpt-live-1-mini | ChatGPT OAuth | Azure endpoint | not ready",
      surface: "gateway-relay" as const,
      providerConfig: {
        model: "gpt-live-1-mini",
        azureEndpoint: "https://example.openai.azure.com",
        azureDeployment: "gpt-live",
      },
      agentId: "main",
      expected: false,
      expectAgentDir: false,
    },
    {
      $name: "browser | gpt-live-1-mini | ChatGPT OAuth | standard endpoint | not ready",
      surface: "browser" as const,
      providerConfig: { model: "gpt-live-1-mini" },
      agentId: "main",
      expected: false,
      expectAgentDir: false,
    },
    {
      $name:
        "gateway-relay | gpt-realtime-2.1 | Platform API key | standard endpoint | not applicable",
      surface: "gateway-relay" as const,
      providerConfig: { model: "gpt-realtime-2.1", apiKey: "test-api-key-platform" },
      agentId: "main",
      expected: undefined,
      expectAgentDir: false,
    },
    {
      $name:
        "gateway-relay | gpt-realtime-2.1 | Platform API key | Azure endpoint | not applicable",
      surface: "gateway-relay" as const,
      providerConfig: {
        model: "gpt-realtime-2.1",
        apiKey: "test-api-key-platform",
        azureEndpoint: "https://example.openai.azure.com",
      },
      agentId: "main",
      expected: undefined,
      expectAgentDir: false,
    },
    {
      $name:
        "gateway-relay | gpt-live-1-codex | Platform API key + OAuth | Azure endpoint | not ready",
      surface: "gateway-relay" as const,
      providerConfig: {
        model: "gpt-live-1-codex",
        apiKey: "test-api-key-platform",
        azureEndpoint: "https://example.openai.azure.com",
      },
      agentId: "main",
      expected: false,
      expectAgentDir: false,
    },
    {
      $name:
        "gateway-relay | gpt-live-1-mini | Platform API key + OAuth | standard endpoint | not ready",
      surface: "gateway-relay" as const,
      providerConfig: { model: "gpt-live-1-mini", apiKey: "test-api-key-platform" },
      agentId: "main",
      expected: false,
      expectAgentDir: false,
    },
    {
      $name: "browser | gpt-live-1-mini | Platform API key + OAuth | standard endpoint | not ready",
      surface: "browser" as const,
      providerConfig: { model: "gpt-live-1-mini", apiKey: "test-api-key-platform" },
      agentId: "main",
      expected: false,
      expectAgentDir: false,
    },
    {
      $name: "gateway-relay | gpt-live-1-codex | ChatGPT OAuth | standard endpoint | ready",
      surface: "gateway-relay" as const,
      providerConfig: { model: "gpt-live-1-codex" },
      agentId: "main",
      expected: true,
      expectAgentDir: false,
    },
    {
      $name:
        "gateway-relay | gpt-live-1-codex | voice-agent ChatGPT OAuth | standard endpoint | ready",
      surface: "gateway-relay" as const,
      providerConfig: { model: "gpt-live-1-codex" },
      agentId: "voice-agent",
      expected: true,
      expectAgentDir: true,
    },
    {
      $name: "browser | gpt-live-1-codex | ChatGPT OAuth | standard endpoint | ready",
      surface: "browser" as const,
      providerConfig: { model: "gpt-live-1-codex" },
      agentId: "main",
      expected: true,
      expectAgentDir: false,
    },
  ])("$name", ({ surface, providerConfig, agentId, expected, expectAgentDir }) => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") === true,
    );
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const cfg = { agents: { defaults: {} } } as never;
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    const readiness =
      surface === "provider"
        ? provider.isConfigured({ cfg, providerConfig })
        : surface === "browser"
          ? internalApi.isBrowserSessionConfigured({ cfg, providerConfig, agentId })
          : internalApi.isGatewayRelayConfigured({ cfg, providerConfig, agentId });

    expect(readiness).toBe(expected);
    if (expectAgentDir) {
      expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: expect.stringContaining("voice-agent"),
          profileTypes: ["oauth"],
        }),
      );
    }
  });

  it("routes an explicit unlisted gpt-live alias through the broker", async () => {
    const oauthToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") ? oauthToken : undefined,
    );
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const cfg = { agents: { defaults: {} } } as never;
    const request = {
      cfg,
      providerConfig: {},
      model: "gpt-live-1-mini",
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    };

    await provider.createBrowserSession?.(request);
    expect(createBrowserSession).toHaveBeenCalledWith(expect.objectContaining(request), {
      type: "oauth",
      token: oauthToken,
      accountId: "account-123",
    });
    expect(resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        profileTypes: ["oauth"],
        includeExternalCliAuth: false,
      }),
    );
  });

  it("rejects forced consult routing for prefix-routed gpt-live sessions", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);

    expect(
      internalApi.validateGatewayRelayLaunch({
        providerConfig: { model: "gpt-live-future-alias" },
        autoRespondToAudio: false,
      }),
    ).toContain("cannot use forced agent consult routing");
    expect(
      internalApi.validateGatewayRelayLaunch({
        providerConfig: { model: "gpt-realtime-2.1" },
        autoRespondToAudio: false,
      }),
    ).toBeUndefined();
  });

  it("prefers ChatGPT OAuth over Platform auth for gpt-live", async () => {
    const oauthToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") ? oauthToken : undefined,
    );
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });

    await provider.createBrowserSession?.({
      providerConfig: { apiKey: "test-api-key-platform" },
      model: "gpt-live-1-codex",
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    } as never);

    expect(createBrowserSession).toHaveBeenCalledWith(expect.any(Object), {
      type: "oauth",
      token: oauthToken,
      accountId: "account-123",
    });
  });

  it("does not advertise GA Gateway control for OAuth-only browser auth", () => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") === true,
    );
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    expect(
      readInternalRealtimeVoiceProviderApi(provider).resolveBrowserSessionCapabilities({
        cfg: {},
        providerConfig: {},
        model: "gpt-realtime-2.1",
      }),
    ).not.toHaveProperty("supportsGatewayControl");
  });

  it("advertises GA Gateway control from the requested agent's Platform auth", () => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ agentDir, profileTypes }: { agentDir?: string; profileTypes?: readonly string[] }) =>
        agentDir === "/tmp/openclaw-molty-agent" && profileTypes?.includes("api_key") === true,
    );
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const cfg = {
      agents: {
        list: [
          { id: "helper", agentDir: "/tmp/openclaw-helper-agent" },
          { id: "molty", agentDir: "/tmp/openclaw-molty-agent" },
        ],
      },
    } as never;
    const resolveCapabilities =
      readInternalRealtimeVoiceProviderApi(provider).resolveBrowserSessionCapabilities;

    expect(
      resolveCapabilities({
        cfg,
        providerConfig: {},
        agentId: "molty",
        model: "gpt-realtime-2.1",
      }),
    ).toMatchObject({ supportsGatewayControl: true });
    expect(
      resolveCapabilities({
        cfg,
        providerConfig: {},
        model: "gpt-realtime-2.1",
      }),
    ).not.toHaveProperty("supportsGatewayControl");
  });

  it("uses ChatGPT OAuth as the browser-only fallback for GA realtime", async () => {
    const oauthToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") ? oauthToken : undefined,
    );
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") === true,
    );
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture({
      session: { clientSecret: "broker-token" },
    });
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const cfg = { agents: { defaults: {} } } as never;
    const request = {
      cfg,
      providerConfig: {},
      model: "gpt-realtime-2.1",
      voice: "cedar",
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
    };

    expect(provider.isConfigured({ cfg, providerConfig: {} })).toBe(false);
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isBrowserSessionConfigured({
        cfg,
        providerConfig: { model: "gpt-realtime-2.1" },
        agentId: "main",
      }),
    ).toBe(true);
    await expect(provider.createBrowserSession?.(request)).resolves.toMatchObject({
      clientSecret: "broker-token",
      offerUrl: "/plugins/openai/realtime/calls",
    });
    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-realtime-2.1", voice: "cedar" }),
      { type: "oauth", token: oauthToken, accountId: "account-123" },
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("passes configured gpt-live model and voice to the native broker", async () => {
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });

    await provider.createBrowserSession?.({
      providerConfig: {
        apiKey: "test-api-key-platform",
        model: "gpt-live-1",
        speakerVoice: "cedar",
      },
      instructions: "Always address the caller as Captain.",
      agentId: "voice-agent",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    } as never);

    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-live-1", voice: "cedar" }),
      { type: "api-key", token: "test-api-key-platform" },
    );
    const quicksilverRequest = requireRecord(
      createBrowserSession.mock.calls[0]?.[0],
      "quicksilver request",
    );
    expect(quicksilverRequest.instructions).toMatch(/^You are OpenClaw's realtime voice layer\./);
    expect(quicksilverRequest.instructions).toContain(
      "Context on the commentary channel is silent background",
    );
    expect(quicksilverRequest.instructions).toContain(
      "Context on the speakable channel is your answer",
    );
    expect(quicksilverRequest.instructions).toMatch(/Always address the caller as Captain\.$/);
  });

  it("explains both gpt-live authentication options when neither is available", async () => {
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });

    await expect(
      provider.createBrowserSession?.({
        providerConfig: {},
        model: "gpt-live-1",
      }),
    ).rejects.toThrow(
      "GPT-Live Talk requires either an OpenAI Platform API key or a ChatGPT OAuth subscription profile",
    );
    expect(createBrowserSession).not.toHaveBeenCalled();
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
});
