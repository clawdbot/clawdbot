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

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...actual,
    isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
    resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
  };
});
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const OPAQUE_REALTIME_MODEL = "gpt-live-test-canary";

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

  it("admits opaque realtime models without publishing them", () => {
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    const providerConfig = {
      apiKey: "test-api-key-platform",
      model: OPAQUE_REALTIME_MODEL,
    };

    expect(provider.models).toContain("gpt-live-1-codex");
    expect(provider.models).not.toContain(OPAQUE_REALTIME_MODEL);
    expect(provider.capabilities).toMatchObject({
      voicesByModel: {
        "gpt-live-1-codex": [
          "arbor",
          "breeze",
          "cove",
          "ember",
          "juniper",
          "maple",
          "sol",
          "spruce",
          "vale",
        ],
      },
    });
    expect(
      internalApi.isGatewayRelayConfigured({
        providerConfig,
        agentId: "main",
      }),
    ).toBe(true);
    expect(
      internalApi.resolveGatewayRelayCapabilities({
        providerConfig,
        model: OPAQUE_REALTIME_MODEL,
      }),
    ).toMatchObject({
      handlesAgentConsult: true,
      supportsToolCalls: false,
      voices: ["marin", "cedar"],
      voiceSelectionPolicy: "allowlist-default",
    });
    expect(
      internalApi.projectPublicProjection({
        providerConfig,
        config: { model: OPAQUE_REALTIME_MODEL },
      }),
    ).toMatchObject({ config: {} });
    expect(
      internalApi.projectPublicProjection({
        providerConfig: { model: "gpt-realtime-2.1" },
        config: { model: "gpt-realtime-2.1" },
      }),
    ).toEqual({ config: { model: "gpt-realtime-2.1" } });
  });

  it("keeps the released route on its catalog voice profile", () => {
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);

    expect(
      internalApi.resolveGatewayRelayCapabilities({
        providerConfig: { model: "gpt-live-1-codex" },
      }),
    ).toMatchObject({
      handlesAgentConsult: true,
      supportsToolCalls: false,
      voices: ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"],
      voiceSelectionPolicy: "allowlist-default",
    });
    expect(
      internalApi.projectPublicProjection({
        providerConfig: { model: "gpt-live-1-codex" },
        config: { model: "gpt-live-1-codex", voice: "spruce" },
      }),
    ).toEqual({ config: { model: "gpt-live-1-codex", voice: "spruce" } });
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
        voices: ["marin", "cedar"],
        voiceSelectionPolicy: "allowlist-default",
      },
    },
    {
      $name: "gateway-relay capability projection",
      surface: "gateway-relay" as const,
      expected: {
        transports: ["webrtc", "gateway-relay"],
        handlesAgentConsult: true,
        supportsToolCalls: false,
        voices: ["marin", "cedar"],
        voiceSelectionPolicy: "allowlist-default",
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
        model: OPAQUE_REALTIME_MODEL,
      }),
    ).toMatchObject(expected);
    expect(
      resolveCapabilities({
        providerConfig: { model: "gpt-realtime-2.1" },
        model: "gpt-live-test-canary-alt",
      }),
    ).toMatchObject(expected);
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
      $name: "provider | released model | ChatGPT OAuth | standard endpoint | Platform-only",
      surface: "provider" as const,
      providerConfig: { model: "gpt-live-1-codex" },
      agentId: "main",
      expected: false,
    },
    {
      $name: "gateway-relay | released model | ChatGPT OAuth | standard endpoint | ready",
      surface: "gateway-relay" as const,
      providerConfig: { model: "gpt-live-1-codex" },
      agentId: "main",
      expected: true,
    },
    {
      $name: "browser | released model | ChatGPT OAuth | standard endpoint | ready",
      surface: "browser" as const,
      providerConfig: { model: "gpt-live-1-codex" },
      agentId: "main",
      expected: true,
    },
    {
      $name: "provider | opaque model | ChatGPT OAuth | standard endpoint | Platform-only",
      surface: "provider" as const,
      providerConfig: { model: OPAQUE_REALTIME_MODEL },
      agentId: "main",
      expected: false,
    },
    {
      $name: "gateway-relay | opaque model | ChatGPT OAuth | Azure endpoint | not ready",
      surface: "gateway-relay" as const,
      providerConfig: {
        model: OPAQUE_REALTIME_MODEL,
        azureEndpoint: "https://example.openai.azure.com",
        azureDeployment: "gpt-live",
      },
      agentId: "main",
      expected: false,
    },
    {
      $name:
        "gateway-relay | gpt-realtime-2.1 | Platform API key | standard endpoint | not applicable",
      surface: "gateway-relay" as const,
      providerConfig: { model: "gpt-realtime-2.1", apiKey: "test-api-key-platform" },
      agentId: "main",
      expected: undefined,
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
    },
    {
      $name: "gateway-relay | opaque model | Platform API key + OAuth | Azure endpoint | not ready",
      surface: "gateway-relay" as const,
      providerConfig: {
        model: OPAQUE_REALTIME_MODEL,
        apiKey: "test-api-key-platform",
        azureEndpoint: "https://example.openai.azure.com",
      },
      agentId: "main",
      expected: false,
    },
    {
      $name: "gateway-relay | opaque model | Platform API key + OAuth | standard endpoint | ready",
      surface: "gateway-relay" as const,
      providerConfig: { model: OPAQUE_REALTIME_MODEL, apiKey: "test-api-key-platform" },
      agentId: "main",
      expected: true,
    },
    {
      $name: "browser | opaque model | Platform API key + OAuth | standard endpoint | ready",
      surface: "browser" as const,
      providerConfig: { model: OPAQUE_REALTIME_MODEL, apiKey: "test-api-key-platform" },
      agentId: "main",
      expected: true,
    },
    {
      $name: "gateway-relay | opaque model | ChatGPT OAuth | standard endpoint | not ready",
      surface: "gateway-relay" as const,
      providerConfig: { model: OPAQUE_REALTIME_MODEL },
      agentId: "main",
      expected: false,
    },
    {
      $name:
        "gateway-relay | opaque model | voice-agent ChatGPT OAuth | standard endpoint | not ready",
      surface: "gateway-relay" as const,
      providerConfig: { model: OPAQUE_REALTIME_MODEL },
      agentId: "voice-agent",
      expected: false,
    },
    {
      $name: "browser | opaque model | ChatGPT OAuth | standard endpoint | not ready",
      surface: "browser" as const,
      providerConfig: { model: OPAQUE_REALTIME_MODEL },
      agentId: "main",
      expected: false,
    },
  ])("$name", ({ surface, providerConfig, agentId, expected }) => {
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
  });

  it("routes an explicit unlisted gpt-live alias through the broker with Platform auth", async () => {
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const cfg = { agents: { defaults: {} } } as never;
    const request = {
      cfg,
      providerConfig: { apiKey: "test-api-key-platform" },
      model: "gpt-live-1-mini",
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    };

    await provider.createBrowserSession?.(request);
    expect(createBrowserSession).toHaveBeenCalledWith(expect.objectContaining(request), {
      type: "api-key",
      token: "test-api-key-platform",
    });
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

  it("prefers Platform auth over ChatGPT OAuth for gpt-live", async () => {
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
      model: OPAQUE_REALTIME_MODEL,
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    } as never);

    expect(createBrowserSession).toHaveBeenCalledWith(expect.any(Object), {
      type: "api-key",
      token: "test-api-key-platform",
    });
    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileTypes: ["oauth"] }),
    );
  });

  it("prefers ChatGPT OAuth for the released route and falls back to Platform auth", async () => {
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
    const request = {
      providerConfig: { apiKey: "test-api-key-platform" },
      model: "gpt-live-1-codex",
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    };

    await provider.createBrowserSession?.(request);
    expect(createBrowserSession).toHaveBeenLastCalledWith(expect.any(Object), {
      type: "oauth",
      token: oauthToken,
      accountId: "account-123",
    });

    resolveProviderAuthProfileApiKeyMock.mockResolvedValue(undefined);
    await provider.createBrowserSession?.(request);
    expect(createBrowserSession).toHaveBeenLastCalledWith(expect.any(Object), {
      type: "api-key",
      token: "test-api-key-platform",
    });
  });

  it.each([
    { name: "OAuth", hostClaim: true, broker: true, auth: "oauth", supported: false },
    { name: "Platform", hostClaim: true, broker: true, auth: "api_key", supported: true },
    { name: "older host", hostClaim: false, broker: true, auth: "oauth", supported: false },
    { name: "missing broker", hostClaim: true, broker: false, auth: "oauth", supported: false },
    { name: "missing auth", hostClaim: true, broker: true, auth: "none", supported: false },
  ])("negotiates native Gateway control with $name", ({ hostClaim, broker, auth, supported }) => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes(auth) === true,
    );
    const fixture = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider(
      broker ? { quicksilverBrowserSessionBroker: fixture.broker } : undefined,
    );
    const capabilities = readInternalRealtimeVoiceProviderApi(
      provider,
    ).resolveBrowserSessionCapabilities({
      cfg: {},
      providerConfig: { model: OPAQUE_REALTIME_MODEL },
      ...(hostClaim ? { clientControl: { owner: "gateway" as const } } : {}),
    });
    expect(capabilities.supportsGatewayControl === true).toBe(supported);
    expect(capabilities.handlesAgentConsult).toBe(true);
    expect(capabilities.supportsToolCalls).toBe(false);
    expect(fixture.createBrowserSession).not.toHaveBeenCalled();
    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalled();
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

  it("gives GA OAuth the same browser session policy as Platform auth", async () => {
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
      instructions: "Use the configured tools when needed.",
      vadThreshold: 0.42,
      prefixPaddingMs: 240,
      silenceDurationMs: 620,
      reasoningEffort: "low",
      tools: [createRealtimeTool("openclaw_agent_consult")],
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
      expect.objectContaining({
        model: "gpt-realtime-2.1",
        voice: "cedar",
        gaSession: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          instructions: "Use the configured tools when needed.",
          audio: {
            input: {
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "server_vad",
                create_response: true,
                interrupt_response: true,
                threshold: 0.42,
                prefix_padding_ms: 240,
                silence_duration_ms: 620,
              },
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
            output: { voice: "cedar" },
          },
          tools: [createRealtimeTool("openclaw_agent_consult")],
          tool_choice: "auto",
          reasoning: { effort: "low" },
        },
      }),
      { type: "oauth", token: oauthToken, accountId: "account-123" },
    );
    const brokerRequest = requireRecord(
      createBrowserSession.mock.calls[0]?.[0],
      "OAuth broker request",
    );
    const gaSession = requireRecord(brokerRequest.gaSession, "OAuth GA session");
    expect(gaSession).not.toHaveProperty("output_modalities");
    expect(gaSession).not.toHaveProperty("initial_items");
    expect(requireRecord(gaSession.audio, "OAuth GA audio").input).not.toHaveProperty("format");
    expect(requireRecord(gaSession.audio, "OAuth GA audio").output).not.toHaveProperty("format");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();

    mockRealtimeClientSecretResponse();
    await provider.createBrowserSession?.({
      ...request,
      providerConfig: { apiKey: "test-api-key-platform" },
    });
    expect(gaSession).toEqual(requireFetchJsonBody().session);
    expect(createBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("passes configured gpt-live model and voice to the native broker", async () => {
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });

    await provider.createBrowserSession?.({
      providerConfig: provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: {
          apiKey: "test-api-key-platform",
          model: "gpt-live-test-canary",
          speakerVoice: "spruce",
        },
      }),
      instructions: "Always address the caller as Captain.",
      agentId: "voice-agent",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    } as never);

    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-live-test-canary", voice: "spruce" }),
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

  it.each([
    { configuredModel: "gpt-live-test-canary", requestedModel: "gpt-realtime-2.1", voice: "marin" },
    {
      configuredModel: "gpt-realtime-2.1",
      requestedModel: "gpt-live-test-canary",
      voice: "spruce",
    },
  ])(
    "preserves the configured voice when $configuredModel is overridden by $requestedModel",
    async ({ configuredModel, requestedModel, voice }) => {
      const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
      const provider = buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: broker,
      });
      const providerConfig = provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: {
          model: configuredModel,
          speakerVoice: voice,
          apiKey: "test-api-key-platform",
        },
      });
      mockRealtimeClientSecretResponse();

      await provider.createBrowserSession?.({
        providerConfig,
        model: requestedModel,
        agentId: "main",
        workspaceDir: "/tmp/openclaw-agent-workspace",
        initialItems: [],
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      } as never);

      if (requestedModel === "gpt-live-test-canary") {
        expect(createBrowserSession).toHaveBeenCalledWith(
          expect.objectContaining({ model: requestedModel, voice }),
          { type: "api-key", token: "test-api-key-platform" },
        );
      } else {
        expect(requireFetchJsonBody()).toMatchObject({
          session: { model: requestedModel, audio: { output: { voice } } },
        });
      }
    },
  );

  it("rejects OAuth-only unlisted gpt-live before broker session creation", async () => {
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth")
          ? createTestJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
            })
          : undefined,
    );
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });

    await expect(
      provider.createBrowserSession?.({
        providerConfig: {},
        model: OPAQUE_REALTIME_MODEL,
      }),
    ).rejects.toThrow("GPT-Live Talk requires an OpenAI Platform API key");
    expect(createBrowserSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "released direct",
      model: "gpt-live-1-codex",
      runAgentConsult: undefined,
      expectedMessage: "OpenAI GPT-Live transport failed",
    },
    {
      name: "unlisted direct",
      model: OPAQUE_REALTIME_MODEL,
      runAgentConsult: undefined,
      expectedMessage: "OpenAI GPT-Live transport failed",
    },
    {
      name: "unlisted gateway",
      model: OPAQUE_REALTIME_MODEL,
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      expectedMessage: "GPT-Live Talk requires an OpenAI Platform API key",
    },
  ])(
    "rejects OAuth-only gpt-live $name startup before provider I/O",
    async ({ model, runAgentConsult, expectedMessage }) => {
      resolveProviderAuthProfileApiKeyMock.mockImplementation(
        async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
          profileTypes?.includes("oauth")
            ? createTestJwt({
                "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
              })
            : undefined,
      );
      const provider = buildOpenAIRealtimeVoiceProvider();
      const bridge = provider.createBridge({
        providerConfig: { model },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        runAgentConsult,
      });

      await expect(bridge.connect()).rejects.toThrow(expectedMessage);
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ profileTypes: ["oauth"] }),
      );
    },
  );

  it.each([
    { model: "gpt-realtime-2", voice: " Verse ", expectedVoice: "verse" },
    { model: "gpt-live-test-canary", voice: " Cedar ", expectedVoice: "cedar" },
  ])("normalizes provider-owned voice settings for $model", ({ model, voice, expectedVoice }) => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            model,
            voice,
            temperature: 0.6,
            silenceDurationMs: 850,
            vadThreshold: 0.35,
            reasoningEffort: "low",
          },
        },
      },
    });

    expect(resolved).toEqual({
      model,
      voice: expectedVoice,
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
