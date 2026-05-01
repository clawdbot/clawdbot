import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  resolveVoiceCallConfig: vi.fn(),
  resolveTwilioAuthToken: vi.fn(),
  validateProviderConfig: vi.fn(),
  managerInitialize: vi.fn(),
  managerGetCall: vi.fn(),
  webhookStart: vi.fn(),
  webhookStop: vi.fn(),
  webhookSetRealtimeHandler: vi.fn(),
  webhookGetRealtimeHandler: vi.fn(),
  webhookGetMediaStreamHandler: vi.fn(),
  webhookCtorArgs: [] as unknown[][],
  realtimeHandlerCtorArgs: [] as unknown[][],
  realtimeHandlerRegisterToolHandler: vi.fn(),
  realtimeHandlerSetPublicUrl: vi.fn(),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  getActiveMemorySearchManager: vi.fn(),
  memorySearch: vi.fn(),
  startTunnel: vi.fn(),
  setupTailscaleExposure: vi.fn(),
  cleanupTailscaleExposure: vi.fn(),
}));

vi.mock("./config.js", () => ({
  resolveVoiceCallConfig: mocks.resolveVoiceCallConfig,
  resolveTwilioAuthToken: mocks.resolveTwilioAuthToken,
  validateProviderConfig: mocks.validateProviderConfig,
}));

vi.mock("./manager.js", () => ({
  CallManager: class {
    initialize = mocks.managerInitialize;
    getCall = mocks.managerGetCall;
  },
}));

vi.mock("./webhook.js", () => ({
  VoiceCallWebhookServer: class {
    constructor(...args: unknown[]) {
      mocks.webhookCtorArgs.push(args);
    }
    start = mocks.webhookStart;
    stop = mocks.webhookStop;
    setRealtimeHandler = mocks.webhookSetRealtimeHandler;
    getRealtimeHandler = mocks.webhookGetRealtimeHandler;
    getMediaStreamHandler = mocks.webhookGetMediaStreamHandler;
  },
}));

vi.mock("./realtime-voice.runtime.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
}));

vi.mock("./webhook/realtime-handler.js", () => ({
  RealtimeCallHandler: class {
    constructor(...args: unknown[]) {
      mocks.realtimeHandlerCtorArgs.push(args);
    }
    registerToolHandler = mocks.realtimeHandlerRegisterToolHandler;
    setPublicUrl = mocks.realtimeHandlerSetPublicUrl;
  },
}));

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: mocks.getActiveMemorySearchManager,
}));

vi.mock("./tunnel.js", () => ({
  startTunnel: mocks.startTunnel,
}));

vi.mock("./webhook/tailscale.js", () => ({
  setupTailscaleExposure: mocks.setupTailscaleExposure,
  cleanupTailscaleExposure: mocks.cleanupTailscaleExposure,
}));

import { createVoiceCallRuntime } from "./runtime.js";

function createBaseConfig(): VoiceCallConfig {
  return createVoiceCallBaseConfig({ tunnelProvider: "ngrok" });
}

function createExternalProviderConfig(params: {
  provider: "twilio" | "telnyx" | "plivo";
  publicUrl?: string;
}): VoiceCallConfig {
  const config = createVoiceCallBaseConfig({
    provider: params.provider,
    tunnelProvider: "none",
  });
  config.twilio = {
    accountSid: "AC123",
    authToken: "secret",
  };
  config.telnyx = {
    apiKey: "key",
    connectionId: "conn",
    publicKey: "pub",
  };
  config.plivo = {
    authId: "MA123",
    authToken: "secret",
  };
  if (params.publicUrl) {
    config.publicUrl = params.publicUrl;
  }
  return config;
}

describe("createVoiceCallRuntime lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveVoiceCallConfig.mockImplementation((cfg: VoiceCallConfig) => cfg);
    mocks.resolveTwilioAuthToken.mockImplementation(
      (cfg: VoiceCallConfig) => cfg.twilio?.authToken,
    );
    mocks.validateProviderConfig.mockReturnValue({ valid: true, errors: [] });
    mocks.managerInitialize.mockResolvedValue(undefined);
    mocks.managerGetCall.mockReset();
    mocks.webhookStart.mockResolvedValue("http://127.0.0.1:3334/voice/webhook");
    mocks.webhookStop.mockResolvedValue(undefined);
    mocks.webhookSetRealtimeHandler.mockReset();
    mocks.webhookGetRealtimeHandler.mockReturnValue({
      setPublicUrl: mocks.realtimeHandlerSetPublicUrl,
    });
    mocks.webhookGetMediaStreamHandler.mockReturnValue(undefined);
    mocks.webhookCtorArgs.length = 0;
    mocks.realtimeHandlerCtorArgs.length = 0;
    mocks.realtimeHandlerRegisterToolHandler.mockReset();
    mocks.realtimeHandlerSetPublicUrl.mockReset();
    mocks.resolveConfiguredRealtimeVoiceProvider.mockResolvedValue({
      provider: { id: "openai" },
      providerConfig: { model: "gpt-realtime" },
    });
    mocks.getActiveMemorySearchManager.mockReset();
    mocks.memorySearch.mockReset();
    mocks.getActiveMemorySearchManager.mockResolvedValue({
      manager: {
        search: mocks.memorySearch,
      },
    });
    mocks.memorySearch.mockResolvedValue([]);
    mocks.startTunnel.mockResolvedValue(null);
    mocks.setupTailscaleExposure.mockResolvedValue(null);
    mocks.cleanupTailscaleExposure.mockResolvedValue(undefined);
  });

  it("cleans up tunnel, tailscale, and webhook server when init fails after start", async () => {
    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example/voice/webhook",
      provider: "ngrok",
      stop: tunnelStop,
    });
    mocks.managerInitialize.mockRejectedValue(new Error("init failed"));

    await expect(
      createVoiceCallRuntime({
        config: createBaseConfig(),
        coreConfig: {},
        agentRuntime: {} as never,
      }),
    ).rejects.toThrow("init failed");

    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("returns an idempotent stop handler", async () => {
    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example/voice/webhook",
      provider: "ngrok",
      stop: tunnelStop,
    });

    const runtime = await createVoiceCallRuntime({
      config: createBaseConfig(),
      coreConfig: {} as CoreConfig,
      agentRuntime: {} as never,
    });

    await runtime.stop();
    await runtime.stop();

    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("passes fullConfig to the webhook server for streaming provider resolution", async () => {
    const coreConfig = { messages: { tts: { provider: "openai" } } } as CoreConfig;
    const fullConfig = {
      plugins: {
        entries: {
          openai: { enabled: true },
        },
      },
    } as OpenClawConfig;

    await createVoiceCallRuntime({
      config: createBaseConfig(),
      coreConfig,
      fullConfig,
      agentRuntime: {} as never,
    });

    expect(mocks.webhookCtorArgs[0]?.[3]).toBe(coreConfig);
    expect(mocks.webhookCtorArgs[0]?.[4]).toBe(fullConfig);
  });

  it.each(["twilio", "telnyx", "plivo"] as const)(
    "fails closed when %s falls back to a local-only webhook",
    async (provider) => {
      await expect(
        createVoiceCallRuntime({
          config: createExternalProviderConfig({ provider }),
          coreConfig: {} as CoreConfig,
          agentRuntime: {} as never,
        }),
      ).rejects.toThrow(`${provider} requires a publicly reachable webhook URL`);
      expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "http://127.0.0.1:3334/voice/webhook",
    "http://[::1]:3334/voice/webhook",
    "http://[fd00::1]/voice/webhook",
  ])("fails closed when Twilio publicUrl %s points at a local-only webhook", async (publicUrl) => {
    await expect(
      createVoiceCallRuntime({
        config: createExternalProviderConfig({
          provider: "twilio",
          publicUrl,
        }),
        coreConfig: {} as CoreConfig,
        agentRuntime: {} as never,
      }),
    ).rejects.toThrow("twilio requires a publicly reachable webhook URL");
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicit public URL for external voice providers", async () => {
    const runtime = await createVoiceCallRuntime({
      config: createExternalProviderConfig({
        provider: "twilio",
        publicUrl: "https://voice.example.com/voice/webhook",
      }),
      coreConfig: {} as CoreConfig,
      agentRuntime: {} as never,
    });

    expect(runtime.webhookUrl).toBe("https://voice.example.com/voice/webhook");
    expect(runtime.publicUrl).toBe("https://voice.example.com/voice/webhook");

    await runtime.stop();
  });

  it("does not log duplicate webhook and public URLs when they match", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runtime = await createVoiceCallRuntime({
      config: createExternalProviderConfig({
        provider: "twilio",
        publicUrl: "https://voice.example.com/voice/webhook",
      }),
      coreConfig: {} as CoreConfig,
      agentRuntime: {} as never,
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "[voice-call] Webhook URL: https://voice.example.com/voice/webhook",
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "[voice-call] Public URL: https://voice.example.com/voice/webhook",
    );

    await runtime.stop();
  });

  it("wires the shared realtime agent consult tool and handler", async () => {
    const config = createBaseConfig();
    config.inboundPolicy = "allowlist";
    config.realtime.enabled = true;
    config.realtime.tools = [
      {
        type: "function",
        name: "custom_tool",
        description: "Custom tool",
        parameters: { type: "object", properties: {} },
      },
    ];
    const sessionStore: Record<string, unknown> = {};
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [{ text: "Use the shipment status." }],
      meta: {},
    }));
    const agentRuntime = {
      defaults: { provider: "openai", model: "gpt-5.4" },
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: {
        resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
        loadSessionStore: vi.fn(() => sessionStore),
        saveSessionStore: vi.fn(async () => {}),
        resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
      },
      runEmbeddedPiAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      direction: "outbound",
      from: "+15550001234",
      to: "+15550009999",
      transcript: [{ speaker: "user", text: "Can you check shipment status?" }],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as CoreConfig,
      agentRuntime: agentRuntime as never,
    });

    expect(mocks.realtimeHandlerCtorArgs[0]?.[0]).toMatchObject({
      tools: [
        expect.objectContaining({ name: "openclaw_agent_consult" }),
        expect.objectContaining({ name: "custom_tool" }),
      ],
    });
    expect(mocks.realtimeHandlerRegisterToolHandler).toHaveBeenCalledWith(
      "openclaw_agent_consult",
      expect.any(Function),
    );

    const handler = mocks.realtimeHandlerRegisterToolHandler.mock.calls[0]?.[1] as
      | ((
          args: unknown,
          callId: string,
          context?: { partialUserTranscript?: string },
        ) => Promise<unknown>)
      | undefined;
    await expect(
      handler?.({ question: "What should I say?" }, "call-1", {
        partialUserTranscript: "Also check the ETA.",
      }),
    ).resolves.toEqual({
      text: "Use the shipment status.",
    });
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "voice:15550009999",
        messageProvider: "voice",
        lane: "voice",
        provider: "openai",
        model: "gpt-5.4",
        toolsAllow: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
        extraSystemPrompt: expect.stringContaining("one or two bounded read-only queries"),
        prompt: expect.stringContaining("Caller: Can you check shipment status?"),
      }),
    );
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Caller: Also check the ETA."),
      }),
    );
  });

  it("answers realtime consults from fast memory context before starting the full agent", async () => {
    const config = createBaseConfig();
    config.realtime.enabled = true;
    config.realtime.fastContext = {
      enabled: true,
      timeoutMs: 800,
      maxResults: 2,
      sources: ["memory"],
      fallbackToConsult: false,
    };
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [{ text: "slow answer" }],
      meta: {},
    }));
    const sessionStore: Record<string, unknown> = {};
    const agentRuntime = {
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: {
        resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
        loadSessionStore: vi.fn(() => sessionStore),
        saveSessionStore: vi.fn(async () => {}),
        resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
      },
      runEmbeddedPiAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      direction: "inbound",
      from: "+15550001234",
      to: "+15550009999",
      transcript: [],
    });
    mocks.memorySearch.mockResolvedValue([
      {
        source: "memory",
        path: "MEMORY.md",
        startLine: 12,
        endLine: 14,
        score: 0.91,
        snippet: "The caller's basement lights are on.",
      },
    ]);

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as CoreConfig,
      agentRuntime: agentRuntime as never,
    });

    const handler = mocks.realtimeHandlerRegisterToolHandler.mock.calls[0]?.[1] as
      | ((
          args: unknown,
          callId: string,
          context?: { partialUserTranscript?: string },
        ) => Promise<unknown>)
      | undefined;
    await expect(handler?.({ question: "Are the basement lights on?" }, "call-1")).resolves.toEqual(
      {
        text: expect.stringContaining("The caller's basement lights are on."),
      },
    );
    expect(mocks.memorySearch).toHaveBeenCalledWith("Are the basement lights on?", {
      maxResults: 2,
      sessionKey: "voice:15550001234",
      sources: ["memory"],
    });
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });
});
