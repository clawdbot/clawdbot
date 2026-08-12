// Openai tests cover realtime voice provider plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

function readInternalRealtimeVoiceProviderApi(provider: object) {
  return Reflect.get(provider, INTERNAL_REALTIME_VOICE_PROVIDER) as {
    isBrowserSessionConfigured: (ctx: {
      cfg?: object;
      providerConfig: Record<string, unknown>;
      agentId?: string;
    }) => boolean;
    isGatewayRelayConfigured: (ctx: {
      cfg?: object;
      providerConfig: Record<string, unknown>;
      agentId?: string;
    }) => boolean | undefined;
    resolveBrowserSessionCapabilities: (ctx: {
      cfg?: object;
      providerConfig: Record<string, unknown>;
      model?: string;
    }) => {
      handlesAgentConsult?: boolean;
      supportsToolCalls?: boolean;
      supportsVideoFrames?: boolean;
      supportsGatewayControl?: boolean;
      transports?: string[];
    };
    resolveGatewayRelayCapabilities: (ctx: {
      cfg?: object;
      providerConfig: Record<string, unknown>;
      model?: string;
    }) => {
      handlesAgentConsult?: boolean;
      supportsToolCalls?: boolean;
      transports?: string[];
    };
    validateGatewayRelayLaunch: (ctx: {
      cfg?: object;
      providerConfig: Record<string, unknown>;
      model?: string;
      autoRespondToAudio?: boolean;
    }) => string | undefined;
    cancelBrowserSession: (request: Record<string, unknown>, session: object) => Promise<void>;
  };
}

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
  createJsonResponse,
  requireRecord,
  requireFetchJsonBody,
  createRealtimeTool,
  createUnreadableToolName,
  createMalformedToolName,
  createTestJwt,
} = createOpenAIRealtimeTestSupport({ FakeWebSocket, fetchWithSsrFGuardMock });

describe("OpenAI realtime voice provider routing", () => {
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

  it("advertises quicksilver capabilities only for curated /v1/live models", () => {
    const quicksilverBroker = {
      capabilities: {
        transports: ["webrtc" as const],
        handlesAgentConsult: true as const,
        supportsToolCalls: false,
        supportsVideoFrames: false,
      },
      createBrowserSession: vi.fn(),
      cancelBrowserSession: vi.fn(),
    };
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: quicksilverBroker,
    });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);

    expect(
      internalApi.resolveBrowserSessionCapabilities({
        providerConfig: { model: "gpt-realtime-2.1" },
        model: "gpt-live-1-codex",
      }),
    ).toMatchObject({
      transports: ["webrtc", "gateway-relay"],
      handlesAgentConsult: true,
      supportsToolCalls: false,
      supportsVideoFrames: false,
    });
    expect(
      internalApi.resolveGatewayRelayCapabilities({
        providerConfig: { model: "gpt-realtime-2.1" },
        model: "gpt-live-1-codex",
      }),
    ).toMatchObject({
      transports: ["webrtc", "gateway-relay"],
      handlesAgentConsult: true,
      supportsToolCalls: false,
    });
    expect(
      internalApi.resolveBrowserSessionCapabilities({
        providerConfig: { model: "gpt-realtime-2.1" },
        model: "gpt-live-1-mini",
      }),
    ).not.toHaveProperty("handlesAgentConsult");
    expect(
      internalApi.resolveGatewayRelayCapabilities({
        providerConfig: { model: "gpt-realtime-2.1" },
        model: "gpt-live-1-mini",
      }),
    ).not.toHaveProperty("handlesAgentConsult");
  });

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

  it("routes gpt-live Platform sessions through the native quicksilver broker", async () => {
    const createBrowserSession = vi.fn(async (_request: unknown, _auth: unknown) => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "quicksilver-token",
      offerUrl: "/plugins/openai/realtime/calls",
    }));
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: {
        capabilities: {
          transports: ["webrtc" as const],
          handlesAgentConsult: true as const,
          supportsToolCalls: false,
          supportsVideoFrames: false,
        },
        createBrowserSession,
        cancelBrowserSession: vi.fn(),
      },
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

  it("routes an explicit unlisted gpt-live alias without advertising it as ready", async () => {
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
    const createBrowserSession = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "quicksilver-token",
      offerUrl: "/plugins/openai/realtime/calls",
    }));
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: {
        capabilities: {
          transports: ["webrtc" as const],
          handlesAgentConsult: true as const,
          supportsToolCalls: false,
          supportsVideoFrames: false,
        },
        createBrowserSession,
        cancelBrowserSession: vi.fn(),
      },
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

    expect(provider.isConfigured({ cfg, providerConfig: { model: "gpt-live-1-mini" } })).toBe(
      false,
    );
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isGatewayRelayConfigured({
        cfg,
        providerConfig: { model: "gpt-live-1-mini" },
        agentId: "main",
      }),
    ).toBe(false);
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isGatewayRelayConfigured({
        cfg,
        providerConfig: {
          model: "gpt-live-1-mini",
          azureEndpoint: "https://example.openai.azure.com",
          azureDeployment: "gpt-live",
        },
        agentId: "main",
      }),
    ).toBe(false);
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isBrowserSessionConfigured({
        cfg,
        providerConfig: { model: "gpt-live-1-mini" },
        agentId: "main",
      }),
    ).toBe(false);
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isGatewayRelayConfigured({
        cfg,
        providerConfig: { model: "gpt-realtime-2.1", apiKey: "test-api-key-platform" },
        agentId: "main",
      }),
    ).toBeUndefined();
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isGatewayRelayConfigured({
        cfg,
        providerConfig: {
          model: "gpt-realtime-2.1",
          apiKey: "test-api-key-platform",
          azureEndpoint: "https://example.openai.azure.com",
        },
        agentId: "main",
      }),
    ).toBeUndefined();
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isGatewayRelayConfigured({
        cfg,
        providerConfig: {
          model: "gpt-live-1-codex",
          apiKey: "test-api-key-platform",
          azureEndpoint: "https://example.openai.azure.com",
        },
        agentId: "main",
      }),
    ).toBe(false);
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isGatewayRelayConfigured({
        cfg,
        providerConfig: { model: "gpt-live-1-mini", apiKey: "test-api-key-platform" },
        agentId: "main",
      }),
    ).toBe(false);
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isBrowserSessionConfigured({
        cfg,
        providerConfig: { model: "gpt-live-1-mini", apiKey: "test-api-key-platform" },
        agentId: "main",
      }),
    ).toBe(false);
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isGatewayRelayConfigured({
        cfg,
        providerConfig: { model: "gpt-live-1-codex" },
        agentId: "main",
      }),
    ).toBe(true);
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isGatewayRelayConfigured({
        cfg,
        providerConfig: { model: "gpt-live-1-codex" },
        agentId: "voice-agent",
      }),
    ).toBe(true);
    expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: expect.stringContaining("voice-agent"),
        profileTypes: ["oauth"],
      }),
    );
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isBrowserSessionConfigured({
        cfg,
        providerConfig: { model: "gpt-live-1-codex" },
        agentId: "main",
      }),
    ).toBe(true);
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
    const createBrowserSession = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "quicksilver-token",
      offerUrl: "/plugins/openai/realtime/calls",
    }));
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: {
        capabilities: { handlesAgentConsult: true as const },
        createBrowserSession,
        cancelBrowserSession: vi.fn(),
      },
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
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: {
        capabilities: { handlesAgentConsult: true as const },
        createBrowserSession: vi.fn(),
        cancelBrowserSession: vi.fn(async () => undefined),
      },
    });
    expect(
      readInternalRealtimeVoiceProviderApi(provider).resolveBrowserSessionCapabilities({
        cfg: {},
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
    const createBrowserSession = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "broker-token",
      offerUrl: "/plugins/openai/realtime/calls",
    }));
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: {
        capabilities: { handlesAgentConsult: true as const },
        createBrowserSession,
        cancelBrowserSession: vi.fn(),
      },
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
    const createBrowserSession = vi.fn(async (_request: unknown, _auth: unknown) => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "quicksilver-token",
      offerUrl: "/plugins/openai/realtime/calls",
    }));
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: {
        capabilities: {
          transports: ["webrtc" as const],
          handlesAgentConsult: true as const,
          supportsToolCalls: false,
          supportsVideoFrames: false,
        },
        createBrowserSession,
        cancelBrowserSession: vi.fn(),
      },
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
    const createBrowserSession = vi.fn();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: {
        capabilities: {
          transports: ["webrtc" as const],
          handlesAgentConsult: true as const,
          supportsToolCalls: false,
          supportsVideoFrames: false,
        },
        createBrowserSession,
        cancelBrowserSession: vi.fn(),
      },
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
