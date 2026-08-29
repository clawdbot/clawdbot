import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
// Voice Call tests cover runtime plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  resolveVoiceCallConfig: vi.fn(),
  resolveVoiceCallStreamExposurePaths: vi.fn(),
  resolveTwilioAuthToken: vi.fn(),
  validateProviderConfig: vi.fn(),
  managerInitialize: vi.fn(),
  managerGetCall: vi.fn(),
  managerProcessEvent: vi.fn(),
  asteriskSetRealtimeHandler: vi.fn(),
  asteriskStartEventListener: vi.fn(),
  asteriskStop: vi.fn(),
  webhookStart: vi.fn(),
  webhookStop: vi.fn(),
  webhookSetRealtimeHandler: vi.fn(),
  webhookGetRealtimeHandler: vi.fn(),
  webhookGetMediaStreamHandler: vi.fn(),
  webhookGetStreamDisconnectLifecycle: vi.fn(),
  webhookCtorArgs: [] as unknown[][],
  realtimeHandlerCtorArgs: [] as unknown[][],
  realtimeHandlerRegisterToolHandler: vi.fn(),
  realtimeHandlerSetPublicUrl: vi.fn(),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  resolveRealtimeFastContextConsult: vi.fn(),
  startTunnel: vi.fn(),
  setupTailscaleExposure: vi.fn(),
  cleanupTailscaleExposure: vi.fn(),
}));

vi.mock("./config.js", () => ({
  resolveVoiceCallSessionKey: (params: {
    config: Pick<VoiceCallConfig, "agentId" | "sessionScope">;
    callId: string;
    phone?: string;
    explicitSessionKey?: string;
  }) => {
    const explicit = params.explicitSessionKey?.trim();
    if (explicit) {
      const lower = explicit.toLowerCase();
      return lower === "global" || lower === "unknown" || lower.startsWith("agent:")
        ? explicit
        : `agent:${params.config.agentId?.trim().toLowerCase() || "main"}:${explicit}`;
    }
    const agentId = params.config.agentId?.trim().toLowerCase() || "main";
    const prefix = `agent:${agentId}:voice`;
    if (params.config.sessionScope === "per-call") {
      return `${prefix}:call:${params.callId}`.toLowerCase();
    }
    const normalizedPhone = params.phone?.replace(/\D/g, "");
    return (
      normalizedPhone ? `${prefix}:${normalizedPhone}` : `${prefix}:${params.callId}`
    ).toLowerCase();
  },
  resolveVoiceCallNumberRouteKeyForCall: (call: {
    direction?: "inbound" | "outbound";
    to?: string;
    metadata?: { numberRouteKey?: unknown };
  }) =>
    call.direction === "inbound"
      ? typeof call.metadata?.numberRouteKey === "string"
        ? call.metadata.numberRouteKey
        : call.to
      : undefined,
  resolveVoiceCallEffectiveConfig: (config: VoiceCallConfig, numberRouteKey?: string) => {
    const route = numberRouteKey ? config.numbers[numberRouteKey] : undefined;
    return route ? { config: { ...config, ...route }, numberRouteKey } : { config };
  },
  resolveVoiceCallConfig: mocks.resolveVoiceCallConfig,
  resolveVoiceCallStreamExposurePaths: mocks.resolveVoiceCallStreamExposurePaths,
  resolveTwilioAuthToken: mocks.resolveTwilioAuthToken,
  validateProviderConfig: mocks.validateProviderConfig,
}));

vi.mock("./manager.js", () => ({
  CallManager: class {
    initialize = mocks.managerInitialize;
    getCall = mocks.managerGetCall;
    processEvent = mocks.managerProcessEvent;
  },
}));

vi.mock("./providers/asterisk.js", () => ({
  AsteriskProvider: class {
    readonly name = "asterisk";
    setRealtimeHandler = mocks.asteriskSetRealtimeHandler;
    startEventListener = mocks.asteriskStartEventListener;
    stop = mocks.asteriskStop;
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
    getStreamDisconnectLifecycle = mocks.webhookGetStreamDisconnectLifecycle;
  },
}));

vi.mock("./realtime-voice.runtime.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
}));

vi.mock("./realtime-fast-context.js", () => ({
  resolveRealtimeFastContextConsult: mocks.resolveRealtimeFastContextConsult,
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

type RealtimeConsultToolHandler = (
  args: unknown,
  callId: string,
  context: { partialUserTranscript?: string; abortSignal?: AbortSignal },
) => Promise<unknown>;

function firstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function firstCallParam(calls: readonly unknown[][], label: string) {
  const call = firstMockCall(calls, label);
  return call[0];
}

type MockSessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  [key: string]: unknown;
};

function createMockSessionRuntime(sessionStore: Record<string, unknown>) {
  return {
    resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
    loadSessionStore: vi.fn(() => sessionStore),
    saveSessionStore: vi.fn(async () => {}),
    updateSessionStore: vi.fn(async (_storePath, mutator: (store: never) => unknown) =>
      mutator(sessionStore as never),
    ),
    getSessionEntry: vi.fn(
      ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey] as MockSessionEntry,
    ),
    patchSessionEntry: vi.fn(
      async ({
        sessionKey,
        fallbackEntry,
        update,
      }: {
        sessionKey: string;
        fallbackEntry: MockSessionEntry;
        update: (entry: MockSessionEntry) => Promise<MockSessionEntry> | MockSessionEntry;
      }) => {
        const current = (sessionStore[sessionKey] as MockSessionEntry | undefined) ?? fallbackEntry;
        const patch = await update(current);
        const next = { ...current, ...patch };
        sessionStore[sessionKey] = next;
        return next;
      },
    ),
    resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
  };
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function requireRealtimeConsultToolHandler(): RealtimeConsultToolHandler {
  const registeredToolHandler = firstMockCall(
    mocks.realtimeHandlerRegisterToolHandler.mock.calls,
    "realtime tool handler registration",
  );
  expect(registeredToolHandler[0]).toBe("openclaw_agent_consult");
  if (typeof registeredToolHandler[1] !== "function") {
    throw new Error("expected realtime tool handler callback");
  }
  return registeredToolHandler[1] as RealtimeConsultToolHandler;
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
    mocks.managerProcessEvent.mockReset();
    mocks.asteriskSetRealtimeHandler.mockReset();
    mocks.asteriskStartEventListener.mockReset();
    mocks.asteriskStartEventListener.mockResolvedValue(undefined);
    mocks.asteriskStop.mockReset();
    mocks.asteriskStop.mockResolvedValue(undefined);
    mocks.webhookStart.mockResolvedValue("http://127.0.0.1:3334/voice/webhook");
    mocks.webhookStop.mockResolvedValue(undefined);
    mocks.webhookSetRealtimeHandler.mockReset();
    mocks.webhookGetRealtimeHandler.mockReturnValue({
      setPublicUrl: mocks.realtimeHandlerSetPublicUrl,
    });
    mocks.webhookGetMediaStreamHandler.mockReturnValue(undefined);
    mocks.webhookGetStreamDisconnectLifecycle.mockReturnValue({
      connect: vi.fn(),
      disconnect: vi.fn(),
      retire: vi.fn(),
    });
    mocks.webhookCtorArgs.length = 0;
    mocks.realtimeHandlerCtorArgs.length = 0;
    mocks.realtimeHandlerRegisterToolHandler.mockReset();
    mocks.realtimeHandlerSetPublicUrl.mockReset();
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: { id: "openai" },
      providerConfig: { model: "gpt-realtime" },
    });
    mocks.resolveRealtimeFastContextConsult.mockReset();
    mocks.resolveRealtimeFastContextConsult.mockResolvedValue({ handled: false });
    mocks.resolveVoiceCallStreamExposurePaths.mockReset();
    mocks.resolveVoiceCallStreamExposurePaths.mockReturnValue([
      {
        localPath: "/voice/stream/realtime",
        publicPath: "/voice/stream/realtime",
      },
    ]);
    mocks.startTunnel.mockResolvedValue(null);
    mocks.setupTailscaleExposure.mockResolvedValue(null);
    mocks.cleanupTailscaleExposure.mockResolvedValue(undefined);
  });

  it("cleans up tunnel, tailscale, and webhook server when init fails after start", async () => {
    const config = createBaseConfig();
    config.tunnel.provider = "tailscale-funnel";
    config.tailscale.port = 8443;
    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example:8443/voice/webhook",
      provider: "tailscale-funnel",
      stop: tunnelStop,
    });
    mocks.managerInitialize.mockRejectedValue(new Error("init failed"));

    await expect(
      createVoiceCallRuntime({
        config,
        coreConfig: {},
        agentRuntime: {} as never,
      }),
    ).rejects.toThrow("init failed");

    expect(mocks.startTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "tailscale-funnel",
        tailscalePort: 8443,
        streamPaths: [
          {
            localPath: "/voice/stream/realtime",
            publicPath: "/voice/stream/realtime",
          },
        ],
      }),
    );
    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("returns an idempotent stop handler", async () => {
    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    let releaseWebhookStop: (() => void) | undefined;
    mocks.webhookStop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseWebhookStop = resolve;
        }),
    );
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example/voice/webhook",
      provider: "ngrok",
      stop: tunnelStop,
    });

    const runtime = await createVoiceCallRuntime({
      config: createBaseConfig(),
      coreConfig: {} as OpenClawConfig,
      agentRuntime: {} as never,
    });

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    let stopped = false;
    void secondStop.then(() => {
      stopped = true;
    });

    expect(secondStop).toBe(firstStop);
    await vi.waitFor(() => {
      expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
    });

    expect(stopped).toBe(false);

    releaseWebhookStop?.();
    await firstStop;
    expect(stopped).toBe(true);

    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("wires Asterisk ARI events and AudioSocket into the realtime lifecycle", async () => {
    const config = createVoiceCallBaseConfig({
      provider: "asterisk",
      tunnelProvider: "none",
    });
    config.asterisk = {
      baseUrl: "http://127.0.0.1:8088/ari",
      username: "openclaw",
      password: "ari-secret",
      application: "openclaw",
      endpoint: "PJSIP/{number}@trunk",
      audioSocket: { bind: "127.0.0.1", host: "127.0.0.1", port: 3335 },
    };
    config.realtime.enabled = true;
    config.inboundPolicy = "allowlist";
    config.outbound.defaultMode = "conversation";

    const runtime = await createVoiceCallRuntime({
      config,
      coreConfig: {},
      agentRuntime: {} as never,
    });

    expect(mocks.asteriskSetRealtimeHandler).toHaveBeenCalledTimes(1);
    expect(mocks.asteriskStartEventListener).toHaveBeenCalledTimes(1);

    const eventSink = mocks.asteriskStartEventListener.mock.calls[0]?.[0];
    expect(eventSink).toBeTypeOf("function");
    eventSink?.({ id: "event-1" });
    expect(mocks.managerProcessEvent).toHaveBeenCalledWith({ id: "event-1" });

    await runtime.stop();
    expect(mocks.asteriskStop).toHaveBeenCalledTimes(1);
  });

  it("passes fullConfig to the webhook server for streaming provider resolution", async () => {
    const coreConfig = { tts: { provider: "openai" } } as OpenClawConfig;
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

  it("builds realtime instructions for the agent frozen on each call", async () => {
    const config = createBaseConfig();
    config.realtime.enabled = true;
    config.realtime.agentContext = {
      enabled: true,
      maxChars: 6000,
      includeIdentity: true,
      includeWorkspaceFiles: false,
      files: ["SOUL.md"],
    };
    const fullConfig = {
      agents: { list: [{ id: "operator", default: true }, { id: "support" }] },
    } as OpenClawConfig;
    const resolveAgentIdentity = vi.fn((_cfg: OpenClawConfig, agentId: string) => ({
      name: agentId === "support" ? "Support Voice" : "Main Voice",
    }));

    const runtime = await createVoiceCallRuntime({
      config,
      coreConfig: {} as OpenClawConfig,
      fullConfig,
      agentRuntime: {
        resolveAgentIdentity,
      } as never,
    });

    const resolveCallRegistration = mocks.realtimeHandlerCtorArgs[0]?.[2];
    expect(mocks.realtimeHandlerCtorArgs[0]?.[4]).toBe(
      mocks.webhookGetStreamDisconnectLifecycle.mock.results[0]?.value,
    );
    expect(mocks.resolveConfiguredRealtimeVoiceProvider).not.toHaveBeenCalled();
    if (typeof resolveCallRegistration !== "function") {
      throw new Error("expected per-call realtime registration resolver");
    }
    expect(runtime.config.agentId).toBe("operator");
    const defaultRegistration = resolveCallRegistration({
      callId: "call-default",
      direction: "outbound",
      from: "+15550001111",
      to: "+15550002222",
    });
    expect(defaultRegistration.agentId).toBe("operator");
    expect(defaultRegistration.instructions).toContain("- Agent id: operator");
    expect(resolveAgentIdentity).toHaveBeenCalledWith(fullConfig, "operator");

    const supportRegistration = resolveCallRegistration({
      callId: "call-support",
      agentId: "support",
      direction: "outbound",
      from: "+15550001111",
      to: "+15550002222",
    });
    expect(supportRegistration.agentId).toBe("support");
    expect(supportRegistration.instructions).toContain("- Agent id: support");
    expect(supportRegistration.instructions).toContain("- Name: Support Voice");
    expect(supportRegistration.instructions).not.toContain("Main Voice");

    const unknownRegistration = resolveCallRegistration({
      callId: "call-unknown",
      agentId: "unknown",
      direction: "outbound",
      from: "+15550001111",
      to: "+15550002222",
    });
    expect(unknownRegistration.instructions).not.toContain("OpenClaw agent voice context:");
  });

  it("selects realtime provider readiness from the routed call owner", async () => {
    const config = createBaseConfig();
    config.agentId = "main";
    config.realtime.enabled = true;
    config.numbers["+15550009999"] = { agentId: "support" };
    const fullConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "support" }] },
    } as OpenClawConfig;
    mocks.resolveConfiguredRealtimeVoiceProvider.mockImplementation(
      ({ agentId }: { agentId?: string }) => {
        if (agentId !== "support") {
          throw new Error(`OpenAI realtime is not configured for ${agentId ?? "unknown"}`);
        }
        return {
          provider: { id: "openai-support" },
          providerConfig: { model: "gpt-realtime", owner: agentId },
        };
      },
    );

    await expect(
      createVoiceCallRuntime({
        config,
        coreConfig: {} as OpenClawConfig,
        fullConfig,
        agentRuntime: {} as never,
      }),
    ).resolves.toMatchObject({ config: { agentId: "main" } });
    expect(mocks.resolveConfiguredRealtimeVoiceProvider).not.toHaveBeenCalled();

    const resolveCallRegistration = mocks.realtimeHandlerCtorArgs[0]?.[2];
    if (typeof resolveCallRegistration !== "function") {
      throw new Error("expected per-call realtime registration resolver");
    }
    const registration = resolveCallRegistration({
      callId: "call-support",
      agentId: "support",
      direction: "inbound",
      from: "+15550001234",
      to: "+15550009999",
      metadata: { numberRouteKey: "+15550009999" },
    });

    expect(registration).toMatchObject({
      agentId: "support",
      provider: { id: "openai-support" },
      providerConfig: { model: "gpt-realtime", owner: "support" },
    });
    expect(mocks.resolveConfiguredRealtimeVoiceProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "support" }),
    );
  });

  it.each(["twilio", "telnyx", "plivo"] as const)(
    "fails closed when %s falls back to a local-only webhook",
    async (provider) => {
      await expect(
        createVoiceCallRuntime({
          config: createExternalProviderConfig({ provider }),
          coreConfig: {} as OpenClawConfig,
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
        coreConfig: {} as OpenClawConfig,
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
      coreConfig: {} as OpenClawConfig,
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
      coreConfig: {} as OpenClawConfig,
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

  it("wires realtime consults and keeps outbound calls off inbound number routes", async () => {
    const config = createBaseConfig();
    config.inboundPolicy = "allowlist";
    config.numbers["+15550009999"] = {
      agentId: "inbound-route",
      responseModel: "openai/gpt-5.5",
    };
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
    const runEmbeddedAgent = vi.fn(async () => ({
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
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      agentId: "support",
      direction: "outbound",
      from: "+15550001234",
      to: "+15550009999",
      metadata: { requesterSessionKey: "agent:main:discord:channel:general" },
      transcript: [{ speaker: "user", text: "Can you check shipment status?" }],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as OpenClawConfig,
      agentRuntime: agentRuntime as never,
    });

    const realtimeHandlerOptions = requireRecord(
      mocks.realtimeHandlerCtorArgs[0]?.[0],
      "realtime handler options",
    );
    const tools = realtimeHandlerOptions.tools;
    if (!Array.isArray(tools)) {
      throw new Error("expected realtime handler tools to be an array");
    }
    expect(tools.map((tool) => requireRecord(tool, "realtime tool").name)).toEqual([
      "openclaw_end_call",
      "openclaw_agent_consult",
      "custom_tool",
    ]);
    const handler = requireRealtimeConsultToolHandler();
    await expect(
      handler({ question: "What should I say?" }, "call-1", {
        partialUserTranscript: "Also check the ETA.",
      }),
    ).resolves.toEqual({
      text: "Use the shipment status.",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const consultParams = requireRecord(
      firstCallParam(runEmbeddedAgent.mock.calls as unknown[][], "embedded OpenClaw consult"),
      "embedded OpenClaw consult params",
    );
    expect(consultParams.agentId).toBe("support");
    expect(consultParams.sessionKey).toBe("agent:support:voice:15550009999");
    expect(consultParams.spawnedBy).toBe("agent:main:discord:channel:general");
    expect(consultParams.messageProvider).toBe("voice");
    expect(consultParams.lane).toBe("voice");
    expect(consultParams.provider).toBe("openai");
    expect(consultParams.model).toBe("gpt-5.4");
    expect(consultParams.toolsAllow).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(consultParams.extraSystemPrompt).toContain("one or two bounded read-only queries");
    expect(consultParams.prompt).toContain("Caller: Can you check shipment status?");
    expect(consultParams.prompt).toContain("Caller: Also check the ETA.");
  });

  it("always exposes the built-in end-call tool without allowing configured replacement", async () => {
    const config = createBaseConfig();
    config.realtime.enabled = true;
    config.realtime.toolPolicy = "none";
    config.realtime.tools = [
      {
        type: "function",
        name: "openclaw_end_call",
        description: "Configured replacement",
        parameters: { type: "object", properties: { callId: { type: "string" } } },
      },
      {
        type: "function",
        name: "custom_tool",
        description: "Custom tool",
        parameters: { type: "object", properties: {} },
      },
    ];

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as OpenClawConfig,
      agentRuntime: {} as never,
    });

    const realtimeHandlerOptions = requireRecord(
      mocks.realtimeHandlerCtorArgs[0]?.[0],
      "realtime handler options",
    );
    const tools = realtimeHandlerOptions.tools;
    if (!Array.isArray(tools)) {
      throw new Error("expected realtime handler tools to be an array");
    }
    expect(tools.map((tool) => requireRecord(tool, "realtime tool").name)).toEqual([
      "openclaw_end_call",
      "custom_tool",
    ]);
    const endCallTool = requireRecord(tools[0], "end-call tool");
    expect(endCallTool.description).toContain("final words");
    expect(endCallTool.description).toContain("no further reply");
    expect(requireRecord(endCallTool.parameters, "end-call parameters")).toEqual({
      type: "object",
      properties: {},
    });
    expect(mocks.realtimeHandlerRegisterToolHandler).not.toHaveBeenCalled();
  });

  it("rejects a realtime consult whose lifecycle owner already aborted", async () => {
    const config = createBaseConfig();
    config.realtime.enabled = true;
    const runEmbeddedAgent = vi.fn();
    const sessionStore: Record<string, unknown> = {};
    const agentRuntime = {
      defaults: { provider: "openai", model: "gpt-5.4" },
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-aborted",
      direction: "inbound",
      from: "+15550001234",
      to: "+15550009999",
      transcript: [],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as OpenClawConfig,
      agentRuntime: agentRuntime as never,
    });

    const controller = new AbortController();
    controller.abort(new Error("voice session replaced"));
    const handler = requireRealtimeConsultToolHandler();
    await expect(
      handler({ question: "Check the deployment." }, "call-aborted", {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("voice session replaced");
    expect(mocks.resolveRealtimeFastContextConsult).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("canonicalizes restored legacy per-call keys for realtime consults", async () => {
    const config = createBaseConfig();
    config.inboundPolicy = "allowlist";
    config.realtime.enabled = true;
    config.sessionScope = "per-call";
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: "Per-call consult answer." }],
      meta: {},
    }));
    const sessionStore: Record<string, unknown> = {};
    const agentRuntime = {
      defaults: { provider: "openai", model: "gpt-5.4" },
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      sessionKey: "voice:call:call-1",
      direction: "inbound",
      from: "+15550001234",
      to: "+15550009999",
      transcript: [],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as OpenClawConfig,
      agentRuntime: agentRuntime as never,
    });

    const handler = requireRealtimeConsultToolHandler();
    await expect(handler({ question: "What should I say?" }, "call-1", {})).resolves.toEqual({
      text: "Per-call consult answer.",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const consultParams = requireRecord(
      firstCallParam(
        runEmbeddedAgent.mock.calls as unknown[][],
        "per-call embedded OpenClaw consult",
      ),
      "per-call embedded OpenClaw consult params",
    );
    expect(consultParams.sessionKey).toBe("agent:main:voice:call:call-1");
  });

  it("blocks locked Codex realtime consults before fast context or model dispatch", async () => {
    const config = createBaseConfig();
    config.realtime.enabled = true;
    const sessionStore: Record<string, unknown> = {
      "agent:main:voice:15550001234": {
        sessionId: "locked-codex-session",
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    };
    const runEmbeddedAgent = vi.fn();
    const agentRuntime = {
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-locked",
      direction: "inbound",
      from: "+15550001234",
      to: "+15550009999",
      transcript: [],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as OpenClawConfig,
      agentRuntime: agentRuntime as never,
    });

    const handler = requireRealtimeConsultToolHandler();
    await expect(
      handler({ question: "Continue this session." }, "call-locked", {}),
    ).rejects.toThrow("Model selection is locked for this session.");
    expect(mocks.resolveRealtimeFastContextConsult).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
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
    const runEmbeddedAgent = vi.fn(async () => ({
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
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      direction: "inbound",
      from: "+15550001234",
      to: "+15550009999",
      transcript: [],
    });
    mocks.resolveRealtimeFastContextConsult.mockResolvedValue({
      handled: true,
      result: {
        text: "Fast OpenClaw memory or session context found.\nThe caller's basement lights are on.",
      },
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as OpenClawConfig,
      agentRuntime: agentRuntime as never,
    });

    const handler = requireRealtimeConsultToolHandler();
    const fastContextResult = await handler(
      { question: "Are the basement lights on?" },
      "call-1",
      {},
    );
    const fastContextRecord = requireRecord(fastContextResult, "fast context result");
    expect(fastContextRecord.text).toContain("The caller's basement lights are on.");
    expect(mocks.resolveRealtimeFastContextConsult).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      args: { question: "Are the basement lights on?" },
      config: {
        enabled: true,
        fallbackToConsult: false,
        maxResults: 2,
        sources: ["memory"],
        timeoutMs: 800,
      },
      logger: {
        info: console.log,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
      },
      sessionKey: "agent:main:voice:15550001234",
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("uses the configured realtime consult thinking level when set", async () => {
    const config = createBaseConfig();
    config.inboundPolicy = "allowlist";
    config.realtime.enabled = true;
    config.realtime.consultThinkingLevel = "ultra";
    config.realtime.consultFastMode = true;
    const sessionStore: Record<string, unknown> = {};
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: "Done." }],
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
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      direction: "outbound",
      from: "+15550001234",
      to: "+15550009999",
      transcript: [],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as OpenClawConfig,
      agentRuntime: agentRuntime as never,
    });

    const handler = requireRealtimeConsultToolHandler();
    await expect(handler({ question: "Turn on the lights." }, "call-1", {})).resolves.toEqual({
      text: "Done.",
    });

    expect(agentRuntime.resolveThinkingDefault).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const consultParams = requireRecord(
      firstCallParam(
        runEmbeddedAgent.mock.calls as unknown[][],
        "configured embedded OpenClaw consult",
      ),
      "configured embedded OpenClaw consult params",
    );
    expect(consultParams.thinkLevel).toBe("ultra");
    expect(consultParams.fastMode).toBe(true);
  });
});
