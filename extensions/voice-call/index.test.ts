import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.ts";
import type { OpenClawPluginApi } from "./api.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";

let runtimeStub: VoiceCallRuntime;

vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeStub),
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
  tools: unknown[];
  service?: Parameters<OpenClawPluginApi["registerService"]>[0];
};
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
  return {
    config: { toNumber: "+15550001234" } as VoiceCallRuntime["config"],
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
      getCall: vi.fn((id: string) => (id === callId ? { callId } : undefined)),
      getCallByProviderCallId: vi.fn(() => undefined),
    } as unknown as VoiceCallRuntime["manager"],
    webhookServer: {} as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  };
}

function createServiceContext(): Parameters<NonNullable<Registered["service"]>["start"]>[0] {
  return {
    config: {},
    stateDir: os.tmpdir(),
    logger: noopLogger,
  } as Parameters<NonNullable<Registered["service"]>["start"]>[0];
}

function setup(config: Record<string, unknown>): Registered {
  const methods = new Map<string, unknown>();
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
    registerGatewayMethod: (method: string, handler: unknown) => methods.set(method, handler),
    registerTool: (tool: unknown) => tools.push(tool),
    registerCli: () => {},
    registerService: (registeredService) => {
      service = registeredService;
    },
    resolvePath: (p: string) => p,
  });
  plugin.register(api);
  return { methods, tools, service };
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
    expect(runtimeStub.manager.initiateCall).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { callId: "call-1", initiated: true });
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
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Runtime not started; setup incomplete"),
    );
    expect(noopLogger.warn).toHaveBeenCalledWith(expect.stringContaining("TWILIO_ACCOUNT_SID"));
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
    expect(respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({
        error: expect.stringContaining("TWILIO_ACCOUNT_SID"),
      }),
    );
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
    expect(runtimeStub.manager.initiateCall).toHaveBeenCalled();
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.callId).toBe("call-1");
  });

  it("returns call status", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.status") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();
    await handler?.({ params: { callId: "call-1" }, respond });
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.found).toBe(true);
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

    expect(runtimeStub.manager.sendDtmf).toHaveBeenCalledWith("call-1", "ww123#");
    expect(respond.mock.calls[0]).toEqual([true, { success: true }]);
  });

  it("normalizes legacy config through runtime creation and warns to run doctor", async () => {
    const { methods } = setup({
      enabled: true,
      provider: "log",
      twilio: {
        from: "+15550001234",
      },
      streaming: {
        enabled: true,
        sttProvider: "openai",
        openaiApiKey: "sk-test", // pragma: allowlist secret
      },
    });
    const handler = methods.get("voicecall.status") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { callId: "call-1" }, respond });

    expect(vi.mocked(createVoiceCallRuntime)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createVoiceCallRuntime).mock.calls[0]?.[0]?.config).toMatchObject({
      enabled: true,
      provider: "mock",
      fromNumber: "+15550001234",
      streaming: {
        enabled: true,
        provider: "openai",
        providers: {
          openai: {
            apiKey: "sk-test",
          },
        },
      },
    });
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Run "openclaw doctor --fix"'),
    );
  });

  it("tool get_status returns json payload", async () => {
    const { tools } = setup({ provider: "mock" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute("id", {
      action: "get_status",
      callId: "call-1",
    })) as { details: { found?: boolean } };
    expect(result.details.found).toBe(true);
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
    expect(runtimeStub.manager.sendDtmf).toHaveBeenCalledWith("call-1", "ww123#");
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
      expect(parsed.checks).toContainEqual(
        expect.objectContaining({ id: "webhook-exposure", ok: false }),
      );
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
      expect(runtimeStub.manager.initiateCall).not.toHaveBeenCalled();
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
      expect(runtimeStub.manager.initiateCall).toHaveBeenCalledWith("+15550009999", undefined, {
        message: "OpenClaw voice call smoke test.",
        mode: "notify",
      });
      expect(stdout.output()).toContain("live-call: started call-1");
    } finally {
      stdout.restore();
    }
  });
});
