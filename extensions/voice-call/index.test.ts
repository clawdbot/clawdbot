// Voice Call tests cover index plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";
import type { CallRecord } from "./src/types.js";

let runtimeStub: VoiceCallRuntime;
const callGatewayFromCliMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeStub),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: callGatewayFromCliMock,
}));

import plugin from "./index.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type Registered = {
  methods: Map<string, unknown>;
  methodScopes: Map<string, string | undefined>;
  tools: unknown[];
  service?: Parameters<OpenClawPluginApi["registerService"]>[0];
};
type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};
type RespondCall = [
  ok: boolean,
  payload?: Record<string, unknown>,
  error?: {
    code?: unknown;
    message?: unknown;
  },
];
type RegisterVoiceCall = (api: Record<string, unknown>) => void;
type RegisterCliContext = {
  program: Command;
  config: Record<string, unknown>;
  workspaceDir?: string;
  logger: typeof noopLogger;
};

function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

function createRuntimeStub(callId = "call-1"): VoiceCallRuntime {
  const call = createCallRecord({ callId });
  return {
    config: {
      toNumber: "+15550001234",
      realtime: { enabled: false },
    } as VoiceCallRuntime["config"],
    provider: {} as VoiceCallRuntime["provider"],
    manager: {
      initiateCall: vi.fn(async () => ({ callId, success: true })),
      continueCall: vi.fn(async () => ({
        success: true,
        transcript: "hello",
      })),
      speak: vi.fn(async () => ({ success: true })),
      sendDtmf: vi.fn(async () => ({ success: true })),
      endCall: vi.fn(async () => ({ success: true })),
      getCall: vi.fn((id: string) => (id === callId ? call : undefined)),
      getCallByProviderCallId: vi.fn(() => undefined),
      getCallFromMemoryOrStore: vi.fn(async (id: string) => (id === callId ? call : undefined)),
      getActiveCalls: vi.fn(() => [call]),
      getCallHistory: vi.fn(async () => []),
    } as unknown as VoiceCallRuntime["manager"],
    webhookServer: {
      speakRealtime: vi.fn(() => ({ success: false, error: "No active realtime bridge for call" })),
    } as unknown as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  };
}

function createCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    provider: "mock",
    direction: "outbound",
    state: "active",
    from: "+15550001111",
    to: "+15550001234",
    startedAt: Date.UTC(2026, 4, 2, 9, 0, 0),
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

function createServiceContext(): Parameters<NonNullable<Registered["service"]>["start"]>[0] {
  return {
    config: {},
    stateDir: os.tmpdir(),
    logger: noopLogger,
  } as Parameters<NonNullable<Registered["service"]>["start"]>[0];
}

function setup(
  config: Record<string, unknown>,
  toolContext: Record<string, unknown> = {},
): Registered {
  const methods = new Map<string, unknown>();
  const methodScopes = new Map<string, string | undefined>();
  const tools: unknown[] = [];
  let service: Registered["service"];
  const api = createTestPluginApi({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    source: "test",
    config: {},
    pluginConfig: config,
    runtime: { tts: { textToSpeechTelephony: vi.fn() } } as unknown as OpenClawPluginApi["runtime"],
    logger: noopLogger,
    registerGatewayMethod: (method: string, handler: unknown, opts?: { scope?: string }) => {
      methods.set(method, handler);
      methodScopes.set(method, opts?.scope);
    },
    registerTool: (tool: unknown) =>
      tools.push(
        typeof tool === "function"
          ? (tool as (context: Record<string, unknown>) => unknown)(toolContext)
          : tool,
      ),
    registerCli: () => {},
    registerService: (registeredService) => {
      service = registeredService;
    },
    resolvePath: (p: string) => p,
  });
  plugin.register(api);
  return { methods, methodScopes, tools, service };
}

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function mockCall(source: MockCallSource, callIndex = 0): ReadonlyArray<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

function firstRespondCall(source: MockCallSource): RespondCall {
  return mockCall(source) as unknown as RespondCall;
}

function firstRuntimeConfig(): VoiceCallRuntime["config"] | undefined {
  const options = mockCall(vi.mocked(createVoiceCallRuntime))[0] as
    | { config?: VoiceCallRuntime["config"] }
    | undefined;
  return options?.config;
}

function expectWarningIncludes(text: string): void {
  expect(noopLogger.warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(text);
}

function expectRedactedVoiceCallStatus(value: unknown): void {
  expect(value).toEqual({
    callId: "call-1",
    provider: "mock",
    direction: "outbound",
    state: "active",
    startedAt: Date.UTC(2026, 4, 2, 9, 0, 0),
  });
  expect(value).not.toHaveProperty("from");
  expect(value).not.toHaveProperty("to");
  expect(value).not.toHaveProperty("sessionKey");
  expect(value).not.toHaveProperty("transcript");
  expect(value).not.toHaveProperty("processedEventIds");
  expect(value).not.toHaveProperty("metadata");
}

async function registerVoiceCallCli(
  program: Command,
  pluginConfig: Record<string, unknown> = { provider: "mock" },
) {
  const { register } = plugin as unknown as {
    register: RegisterVoiceCall;
  };
  register({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    source: "test",
    config: {},
    pluginConfig,
    runtime: { tts: { textToSpeechTelephony: vi.fn() } },
    logger: noopLogger,
    registerGatewayMethod: () => {},
    registerTool: () => {},
    registerCli: (fn: (ctx: RegisterCliContext) => void) =>
      fn({
        program,
        config: {},
        workspaceDir: undefined,
        logger: noopLogger,
      }),
    registerService: () => {},
    resolvePath: (p: string) => p,
  });
}

describe("voice-call plugin", () => {
  beforeEach(() => {
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
    noopLogger.debug.mockClear();
    runtimeStub = createRuntimeStub();
    callGatewayFromCliMock.mockReset();
    callGatewayFromCliMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:18789"));
    vi.mocked(createVoiceCallRuntime).mockReset();
    vi.mocked(createVoiceCallRuntime).mockImplementation(async () => runtimeStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.voice-call.runtime")];
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.voice-call.runtimePromise")
    ];
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.voice-call.runtimeStopPromise")
    ];
  });

  it("defaults canonical plugin config to an enabled mock runtime", async () => {
    const { service } = setup({});

    await service?.start(createServiceContext());

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    expect(firstRuntimeConfig()).toMatchObject({
      enabled: true,
      provider: "mock",
    });
  });

  it.each([
    ["provider log", { enabled: true, provider: "log" }],
    [
      "twilio.from",
      {
        enabled: true,
        provider: "mock",
        twilio: { from: "+15550001234" },
      },
    ],
  ])("rejects legacy %s config instead of normalizing it at runtime", (_label, config) => {
    expect(() => setup(config)).toThrow();
    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  });

  it("reuses a started runtime across plugin registration contexts", async () => {
    const first = setup({ provider: "mock" });
    const second = setup({ provider: "mock" });

    await first.service?.start(createServiceContext());
    const handler = second.methods.get("voicecall.initiate") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({ params: { message: "Hi" }, respond });

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { callId: "call-1", initiated: true });
  });

  it("does not block service startup while runtime exposure initializes", async () => {
    let resolveRuntime: ((runtime: VoiceCallRuntime) => void) | undefined;
    vi.mocked(createVoiceCallRuntime).mockReturnValueOnce(
      new Promise<VoiceCallRuntime>((resolve) => {
        resolveRuntime = resolve;
      }),
    );
    const { service, methods } = setup({ provider: "mock" });

    if (!service) {
      throw new Error("expected voice-call service");
    }
    expect(service.start(createServiceContext())).toBeUndefined();
    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);

    resolveRuntime?.(runtimeStub);
    const handler = methods.get("voicecall.initiate") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({ params: { message: "Hi" }, respond });

    expect(respond).toHaveBeenCalledWith(true, { callId: "call-1", initiated: true });
  });

  it("does not start the webhook runtime for CLI-only plugin loading", async () => {
    vi.stubEnv("OPENCLAW_CLI", "1");
    const { service } = setup({ provider: "mock" });

    await service?.start(createServiceContext());

    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  });

  it("still starts the webhook runtime for gateway CLI processes", async () => {
    const previousArgv = process.argv;
    vi.stubEnv("OPENCLAW_CLI", "1");
    process.argv = ["node", "openclaw", "gateway", "run"];
    const { service } = setup({ provider: "mock" });

    try {
      await service?.start(createServiceContext());
      expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = previousArgv;
    }
  });

  it("creates a fresh shared runtime after service stop", async () => {
    const first = setup({ provider: "mock" });
    await first.service?.start(createServiceContext());
    await first.service?.stop?.(createServiceContext());

    runtimeStub = createRuntimeStub("call-2");
    const second = setup({ provider: "mock" });
    const handler = second.methods.get("voicecall.initiate") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({ params: { message: "Hi" }, respond });

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledWith(true, { callId: "call-2", initiated: true });
  });

  it("does not log a startup error when provider setup is incomplete", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_FROM_NUMBER", "");
    const { service } = setup({ provider: "twilio" });

    await service?.start(createServiceContext());

    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
    expect(
      noopLogger.error.mock.calls.some(([message]) =>
        String(message).includes("Failed to start runtime"),
      ),
    ).toBe(false);
    expectWarningIncludes("Runtime not started; setup incomplete");
    expectWarningIncludes("TWILIO_ACCOUNT_SID");
  });

  it("registers Twilio configs with SecretRef auth tokens", async () => {
    const authToken = envRef("TWILIO_AUTH_TOKEN");
    const { service } = setup({
      enabled: true,
      provider: "twilio",
      fromNumber: "+15550001234",
      twilio: {
        accountSid: "AC123",
        authToken,
      },
    });

    await service?.start(createServiceContext());

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    expect(firstRuntimeConfig()?.twilio?.authToken).toEqual(authToken);
  });

  it("still reports missing provider setup when a command needs the runtime", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_FROM_NUMBER", "");
    const { methods } = setup({ provider: "twilio" });
    const handler = methods.get("voicecall.initiate") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { message: "Hi", to: "+15550001234" }, respond });

    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
    const [ok, payload, error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(String(error?.message)).toContain("TWILIO_ACCOUNT_SID");
  });

  it("initiates a call via voicecall.initiate", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.initiate") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({ params: { message: "Hi" }, respond });
    expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalled();
    const [ok, payload] = firstRespondCall(respond);
    expect(ok).toBe(true);
    expect(payload?.callId).toBe("call-1");
  });

  it("registers voice call gateway methods with least-privilege scopes", () => {
    const { methodScopes } = setup({ provider: "mock" });

    for (const method of [
      "voicecall.initiate",
      "voicecall.start",
      "voicecall.continue",
      "voicecall.continue.start",
      "voicecall.speak",
      "voicecall.dtmf",
      "voicecall.end",
    ]) {
      expect(methodScopes.get(method)).toBe("operator.write");
    }
    expect(methodScopes.get("voicecall.continue.result")).toBe("operator.read");
    expect(methodScopes.get("voicecall.status")).toBe("operator.read");
  });

  it("preserves mode on legacy voicecall.start", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.start") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({
      params: {
        dtmfSequence: "ww123456#",
        message: "Hi",
        mode: "conversation",
        to: "+15550001234",
      },
      respond,
    });
    expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith("+15550001234", undefined, {
      dtmfSequence: "ww123456#",
      message: "Hi",
      mode: "conversation",
    });
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("preserves explicit session keys on voicecall.start", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.start") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({
      params: {
        mode: "conversation",
        requesterSessionKey: "agent:main:discord:channel:general",
        sessionKey: "voice:google-meet:meet-1",
        to: "+15550001234",
      },
      respond,
    });
    expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith(
      "+15550001234",
      "voice:google-meet:meet-1",
      {
        dtmfSequence: undefined,
        message: undefined,
        mode: "conversation",
        requesterSessionKey: "agent:main:discord:channel:general",
      },
    );
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("accepts per-call agent routing only from plugin runtime", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.start") as
      | ((ctx: {
          params: Record<string, unknown>;
          client?: { internal?: { pluginRuntimeOwnerId?: string } };
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: { to: "+15550001234", agentId: "support" },
      client: { internal: { pluginRuntimeOwnerId: "google-meet" } },
      respond,
    });

    expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith(
      "+15550001234",
      undefined,
      expect.objectContaining({ agentId: "support" }),
    );
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("rejects external per-call agent routing", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.start") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { to: "+15550001234", agentId: "spoofed" }, respond });

    expect(runtimeStub.manager["initiateCall"]).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)[2]?.code).toBe("INVALID_REQUEST");
  });

  it("returns redacted call status", async () => {
    const call = createCallRecord({
      metadata: { requesterSessionKey: "agent:main:discord:channel:general" },
      processedEventIds: ["evt-1"],
      sessionKey: "agent:main:voice:call-1",
      transcript: [
        {
          timestamp: Date.UTC(2026, 4, 2, 9, 1, 0),
          speaker: "user",
          text: "private call transcript",
          isFinal: true,
        },
      ],
    });
    runtimeStub.manager.getCall = vi.fn(() => call);
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.status") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({ params: { callId: "call-1" }, respond });
    const [ok, payload] = firstRespondCall(respond);
    expect(ok).toBe(true);
    expect(payload?.found).toBe(true);
    expectRedactedVoiceCallStatus(payload?.call);
  });

  it("returns redacted active call status list", async () => {
    const call = createCallRecord({
      metadata: { requesterSessionKey: "agent:main:discord:channel:general" },
      processedEventIds: ["evt-1"],
      sessionKey: "agent:main:voice:call-1",
      transcript: [
        {
          timestamp: Date.UTC(2026, 4, 2, 9, 1, 0),
          speaker: "user",
          text: "private call transcript",
          isFinal: true,
        },
      ],
    });
    runtimeStub.manager.getActiveCalls = vi.fn(() => [call]);
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.status") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: {}, respond });

    const [ok, payload] = firstRespondCall(respond);
    expect(ok).toBe(true);
    expect(payload?.found).toBe(true);
    const calls = (payload?.calls as unknown[] | undefined) ?? [];
    expect(calls).toHaveLength(1);
    expectRedactedVoiceCallStatus(calls[0]);
  });

  it("sends DTMF via voicecall.dtmf", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.dtmf") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { callId: "call-1", digits: "ww123#" }, respond });

    expect(runtimeStub.manager["sendDtmf"]).toHaveBeenCalledWith("call-1", "ww123#");
    expect(firstRespondCall(respond)).toEqual([true, { success: true }]);
  });

  it("normalizes provider call ids before speaking", async () => {
    runtimeStub.manager.getCall = vi.fn(() => undefined);
    runtimeStub.manager.getCallByProviderCallId = vi.fn(() =>
      createCallRecord({
        callId: "call-1",
        providerCallId: "CA123",
      }),
    );
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.speak") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { callId: "CA123", message: "hello" }, respond });

    expect(runtimeStub.manager["speak"]).toHaveBeenCalledWith("call-1", "hello");
    expect(firstRespondCall(respond)).toEqual([true, { success: true }]);
  });

  it("does not fall back to one-shot TwiML speak when realtime-only speech is requested", async () => {
    runtimeStub.config.realtime.enabled = true;
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.speak") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: { allowTwimlFallback: false, callId: "call-1", message: "hello" },
      respond,
    });

    expect(runtimeStub.webhookServer["speakRealtime"]).toHaveBeenCalledWith("call-1", "hello");
    expect(runtimeStub.manager["speak"]).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)).toEqual([
      true,
      { success: false, error: "No active realtime bridge for call" },
    ]);
  });

  it("reports ended call history when speaking to a stale call", async () => {
    runtimeStub.manager.getCall = vi.fn(() => undefined);
    runtimeStub.manager.getCallByProviderCallId = vi.fn(() => undefined);
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () =>
      createCallRecord({
        callId: "call-1",
        providerCallId: "CA123",
        state: "completed",
        endReason: "completed",
        endedAt: Date.UTC(2026, 4, 2, 9, 18, 23),
      }),
    );
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.speak") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { callId: "CA123", message: "hello" }, respond });

    const [ok, , error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(error?.message).toContain("call is not active");
    expect(error?.message).toContain("last state=completed");
    expect(error?.message).toContain("endReason=completed");
    expect(runtimeStub.manager["speak"]).not.toHaveBeenCalled();
  });

  it("reports stale call history with invalid ended timestamps", async () => {
    runtimeStub.manager.getCall = vi.fn(() => undefined);
    runtimeStub.manager.getCallByProviderCallId = vi.fn(() => undefined);
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () =>
      createCallRecord({
        callId: "call-1",
        providerCallId: "CA123",
        state: "completed",
        endReason: "completed",
        endedAt: Number.POSITIVE_INFINITY,
      }),
    );
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.speak") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { callId: "CA123", message: "hello" }, respond });

    const [ok, , error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(error?.message).toContain("call is not active");
    expect(error?.message).toContain("last state=completed");
    expect(error?.message).toContain("endReason=completed");
    expect(error?.message).not.toContain("endedAt=");
  });

  it("freezes the invoking agent on tool-created calls", async () => {
    const { tools } = setup({ provider: "mock" }, { agentId: "support" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };

    await tool.execute("id", {
      action: "initiate_call",
      to: "+15550001234",
      message: "Hello",
    });

    expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith(
      "+15550001234",
      undefined,
      expect.objectContaining({ agentId: "support", message: "Hello" }),
    );
  });

  it("tool get_status returns json payload", async () => {
    const call = createCallRecord({
      metadata: { requesterSessionKey: "agent:main:discord:channel:general" },
      processedEventIds: ["evt-1"],
      sessionKey: "agent:main:voice:call-1",
      transcript: [
        {
          timestamp: Date.UTC(2026, 4, 2, 9, 1, 0),
          speaker: "user",
          text: "private call transcript",
          isFinal: true,
        },
      ],
    });
    runtimeStub.manager.getCall = vi.fn(() => call);
    const { tools } = setup({ provider: "mock" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute("id", {
      action: "get_status",
      callId: "call-1",
    })) as { details: { found?: boolean; call?: unknown } };
    expect(result.details.found).toBe(true);
    expectRedactedVoiceCallStatus(result.details.call);
  });

  it("tool get_status uses the manager's persisted fallback", async () => {
    const completed = createCallRecord({
      callId: "call-1",
      providerCallId: "CA123",
      state: "completed",
      endReason: "completed",
      endedAt: Date.UTC(2026, 4, 2, 9, 18, 23),
    });
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () => completed);
    const { tools } = setup({ provider: "mock" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute("id", {
      action: "get_status",
      callId: "call-1",
    })) as { details: { found?: boolean; call?: { state?: string } } };
    expect(runtimeStub.manager["getCallFromMemoryOrStore"]).toHaveBeenCalledWith("call-1");
    expect(result.details.found).toBe(true);
    expect(result.details.call?.state).toBe("completed");
  });

  it("tool get_status reports found:false when the call is neither active nor persisted", async () => {
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () => undefined);
    const { tools } = setup({ provider: "mock" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute("id", {
      action: "get_status",
      callId: "call-1",
    })) as { details: { found?: boolean } };
    expect(result.details.found).toBe(false);
  });

  it("tool send_dtmf returns json payload", async () => {
    const { tools } = setup({ provider: "mock" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute("id", {
      action: "send_dtmf",
      callId: "call-1",
      digits: "ww123#",
    })) as { details: { success?: boolean } };
    expect(runtimeStub.manager["sendDtmf"]).toHaveBeenCalledWith("call-1", "ww123#");
    expect(result.details.success).toBe(true);
  });

  it("legacy tool status without sid returns error payload", async () => {
    const { tools } = setup({ provider: "mock" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute("id", { mode: "status" })) as {
      details: { error?: unknown };
    };
    expect(String(result.details.error)).toContain("sid required");
  });

  it("CLI rejects invalid numeric options", async () => {
    const program = new Command();
    await registerVoiceCallCli(program);

    await expect(
      program.parseAsync(["voicecall", "expose", "--port", "nope", "--mode", "off"], {
        from: "user",
      }),
    ).rejects.toThrow(/Invalid numeric value for --port/);
    await expect(
      program.parseAsync(["voicecall", "expose", "--port", "Infinity", "--mode", "off"], {
        from: "user",
      }),
    ).rejects.toThrow(/Invalid numeric value for --port/);
    await expect(
      program.parseAsync(["voicecall", "expose", "--port", "3334.9", "--mode", "off"], {
        from: "user",
      }),
    ).rejects.toThrow(/Invalid numeric value for --port/);

    const tmpFile = path.join(os.tmpdir(), `voicecall-invalid-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpFile, "{}\n", "utf8");
    try {
      await expect(
        program.parseAsync(["voicecall", "latency", "--file", tmpFile, "--last", "later"], {
          from: "user",
        }),
      ).rejects.toThrow(/Invalid numeric value for --last/);
      await expect(
        program.parseAsync(["voicecall", "latency", "--file", tmpFile, "--last", "Infinity"], {
          from: "user",
        }),
      ).rejects.toThrow(/Invalid numeric value for --last/);
      await expect(
        program.parseAsync(["voicecall", "latency", "--file", tmpFile, "--last", "1.5"], {
          from: "user",
        }),
      ).rejects.toThrow(/Invalid numeric value for --last/);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("CLI latency summarizes turn metrics from JSONL", async () => {
    const program = new Command();
    const tmpFile = path.join(os.tmpdir(), `voicecall-latency-${Date.now()}.jsonl`);
    fs.writeFileSync(
      tmpFile,
      [
        JSON.stringify({ metadata: { lastTurnLatencyMs: 100, lastTurnListenWaitMs: 70 } }),
        JSON.stringify({ metadata: { lastTurnLatencyMs: 200, lastTurnListenWaitMs: 110 } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const stdout = captureStdout();

    try {
      await registerVoiceCallCli(program);

      await program.parseAsync(["voicecall", "latency", "--file", tmpFile, "--last", "10"], {
        from: "user",
      });

      const printed = stdout.output();
      expect(printed).toContain('"recordsScanned": 2');
      expect(printed).toContain('"p50Ms": 100');
      expect(printed).toContain('"p95Ms": 200');
    } finally {
      stdout.restore();
      fs.unlinkSync(tmpFile);
    }
  });

  it("CLI start prints JSON", async () => {
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program);

    try {
      await program.parseAsync(["voicecall", "start", "--to", "+1", "--message", "Hello"], {
        from: "user",
      });
      expect(stdout.output()).toContain('"callId": "call-1"');
    } finally {
      stdout.restore();
    }
  });

  it("CLI start delegates to the running gateway runtime", async () => {
    callGatewayFromCliMock.mockResolvedValueOnce({ callId: "gateway-call", initiated: true });
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program);

    try {
      await program.parseAsync(["voicecall", "start", "--to", "+1", "--message", "Hello"], {
        from: "user",
      });
      expect(callGatewayFromCliMock).toHaveBeenCalledWith(
        "voicecall.start",
        { json: true, timeout: "35000" },
        { to: "+1", message: "Hello", mode: "conversation" },
        { progress: false },
      );
      expect(createVoiceCallRuntime).not.toHaveBeenCalled();
      expect(stdout.output()).toContain('"callId": "gateway-call"');
    } finally {
      stdout.restore();
    }
  });

  it("responds with protocol errors for delegated gateway failures", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.start") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: {}, respond });

    const [ok, payload, error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.code).toBe("INVALID_REQUEST");
    expect(error?.message).toBe("to required");
  });

  it("starts and polls delegated gateway continue operations", async () => {
    callGatewayFromCliMock
      .mockResolvedValueOnce({
        operationId: "op-1",
        status: "pending",
        pollTimeoutMs: 180000,
      })
      .mockResolvedValueOnce({
        operationId: "op-1",
        status: "completed",
        result: { success: true, transcript: "gateway hello" },
      });
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program, {
      provider: "mock",
      transcriptTimeoutMs: 120000,
      tts: { timeoutMs: 30000 },
    });

    try {
      await program.parseAsync(
        ["voicecall", "continue", "--call-id", "call-1", "--message", "Hello"],
        {
          from: "user",
        },
      );
      expect(callGatewayFromCliMock).toHaveBeenCalledWith(
        "voicecall.continue.start",
        { json: true, timeout: "35000" },
        { callId: "call-1", message: "Hello" },
        { progress: false },
      );
      expect(callGatewayFromCliMock).toHaveBeenCalledWith(
        "voicecall.continue.result",
        { json: true, timeout: "5000" },
        { operationId: "op-1" },
        { progress: false },
      );
      expect(createVoiceCallRuntime).not.toHaveBeenCalled();
      expect(stdout.output()).toContain('"transcript": "gateway hello"');
    } finally {
      stdout.restore();
    }
  });

  it("gateway continue operations return pending then completed results", async () => {
    let finishContinue: ((value: { success: true; transcript: string }) => void) | undefined;
    const continuePromise = new Promise<{ success: true; transcript: string }>((resolve) => {
      finishContinue = resolve;
    });
    runtimeStub.manager.continueCall = vi.fn(
      async () => await continuePromise,
    ) as VoiceCallRuntime["manager"]["continueCall"];
    const { methods } = setup({
      provider: "mock",
      transcriptTimeoutMs: 120000,
      tts: { timeoutMs: 30000 },
    });
    const start = methods.get("voicecall.continue.start") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const result = methods.get("voicecall.continue.result") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const startRespond = vi.fn();

    await start?.({
      params: { callId: "call-1", message: "Hello" },
      respond: startRespond,
    });
    const startPayload = firstRespondCall(startRespond)[1] as
      | { operationId?: string; pollTimeoutMs?: number; status?: string }
      | undefined;
    expect(startPayload?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    );
    expect(startPayload?.status).toBe("pending");
    expect(startPayload?.pollTimeoutMs).toBe(180000);
    expect(runtimeStub.manager["continueCall"]).toHaveBeenCalledWith("call-1", "Hello");

    const pendingRespond = vi.fn();
    await result?.({
      params: { operationId: startPayload?.operationId },
      respond: pendingRespond,
    });
    const pendingCall = firstRespondCall(pendingRespond);
    expect(pendingCall[0]).toBe(true);
    expect((pendingCall[1] as { status?: unknown } | undefined)?.status).toBe("pending");

    finishContinue?.({ success: true, transcript: "gateway hello" });
    await continuePromise;
    await Promise.resolve();

    const completedRespond = vi.fn();
    await result?.({
      params: { operationId: startPayload?.operationId },
      respond: completedRespond,
    });
    const completedCall = firstRespondCall(completedRespond);
    const completedPayload = completedCall[1] as { status?: unknown; result?: unknown } | undefined;
    expect(completedCall[0]).toBe(true);
    expect(completedPayload?.status).toBe("completed");
    expect(completedPayload?.result).toEqual({ success: true, transcript: "gateway hello" });
  });

  it("CLI setup prints human-readable checks by default", async () => {
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program, {
      provider: "twilio",
      fromNumber: "+15550001234",
      publicUrl: "https://voice.example.com/voice/webhook",
      twilio: {
        accountSid: "AC123",
        authToken: "token",
      },
    });

    try {
      await program.parseAsync(["voicecall", "setup"], { from: "user" });
      expect(stdout.output()).toContain("Voice Call setup: OK");
      expect(stdout.output()).toContain("OK provider: Provider configured: twilio");
    } finally {
      stdout.restore();
    }
  });

  it("CLI setup preserves JSON output with --json", async () => {
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program, {
      provider: "twilio",
      fromNumber: "+15550001234",
      twilio: {
        accountSid: "AC123",
        authToken: "token",
      },
    });

    try {
      await program.parseAsync(["voicecall", "setup", "--json"], { from: "user" });
      const parsed = JSON.parse(stdout.output()) as {
        ok?: boolean;
        checks?: Array<{ id: string; ok: boolean }>;
      };
      expect(parsed.ok).toBe(false);
      const webhookExposure = parsed.checks?.find((check) => check.id === "webhook-exposure");
      expect(webhookExposure?.ok).toBe(false);
    } finally {
      stdout.restore();
    }
  });

  it.each([
    "http://127.0.0.1:3334/voice/webhook",
    "http://[::1]:3334/voice/webhook",
    "http://[fd00::1]/voice/webhook",
  ])("CLI setup rejects local public webhook URL %s for Twilio", async (publicUrl) => {
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program, {
      provider: "twilio",
      fromNumber: "+15550001234",
      publicUrl,
      twilio: {
        accountSid: "AC123",
        authToken: "token",
      },
    });

    try {
      await program.parseAsync(["voicecall", "setup", "--json"], { from: "user" });
      const parsed = JSON.parse(stdout.output()) as {
        ok?: boolean;
        checks?: Array<{ id: string; ok: boolean; message: string }>;
      };
      expect(parsed.ok).toBe(false);
      const webhookExposure = parsed.checks?.find((check) => check.id === "webhook-exposure");
      expect(webhookExposure?.ok).toBe(false);
      expect(webhookExposure?.message).toContain("local/private");
    } finally {
      stdout.restore();
    }
  });

  it("CLI status lists active calls without a call id", async () => {
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program);

    try {
      await program.parseAsync(["voicecall", "status", "--json"], { from: "user" });
      const parsed = JSON.parse(stdout.output()) as {
        calls?: Array<{ callId?: string }>;
      };
      expect(parsed.calls).toHaveLength(1);
      expect(parsed.calls?.[0]?.callId).toBe("call-1");
    } finally {
      stdout.restore();
    }
  });

  it("CLI status lists active calls through the running gateway runtime", async () => {
    callGatewayFromCliMock.mockResolvedValueOnce({
      found: true,
      calls: [{ callId: "gateway-call" }],
    });
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program);

    try {
      await program.parseAsync(["voicecall", "status", "--json"], { from: "user" });
      const parsed = JSON.parse(stdout.output()) as {
        calls?: Array<{ callId?: string }>;
      };
      expect(callGatewayFromCliMock).toHaveBeenCalledWith(
        "voicecall.status",
        { json: true, timeout: "5000" },
        undefined,
        { progress: false },
      );
      expect(createVoiceCallRuntime).not.toHaveBeenCalled();
      expect(parsed.calls).toHaveLength(1);
      expect(parsed.calls?.[0]?.callId).toBe("gateway-call");
    } finally {
      stdout.restore();
    }
  });

  it("CLI smoke dry-runs a live call unless --yes is passed", async () => {
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program, {
      provider: "twilio",
      fromNumber: "+15550001234",
      publicUrl: "https://voice.example.com/voice/webhook",
      twilio: {
        accountSid: "AC123",
        authToken: "token",
      },
    });

    try {
      await program.parseAsync(["voicecall", "smoke", "--to", "+15550009999"], {
        from: "user",
      });
      expect(stdout.output()).toContain("live-call: dry run for +15550009999");
      expect(runtimeStub.manager["initiateCall"]).not.toHaveBeenCalled();
    } finally {
      stdout.restore();
    }
  });

  it("CLI smoke can place a live notify call with --yes", async () => {
    const program = new Command();
    const stdout = captureStdout();
    await registerVoiceCallCli(program, {
      provider: "twilio",
      fromNumber: "+15550001234",
      publicUrl: "https://voice.example.com/voice/webhook",
      twilio: {
        accountSid: "AC123",
        authToken: "token",
      },
    });

    try {
      await program.parseAsync(["voicecall", "smoke", "--to", "+15550009999", "--yes"], {
        from: "user",
      });
      expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith("+15550009999", undefined, {
        message: "OpenClaw voice call smoke test.",
        mode: "notify",
      });
      expect(stdout.output()).toContain("live-call: started call-1");
    } finally {
      stdout.restore();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
