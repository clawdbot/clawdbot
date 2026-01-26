import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let runtimeStub: {
  config: { toNumber?: string };
  manager: {
    initiateCall: ReturnType<typeof vi.fn>;
    continueCall: ReturnType<typeof vi.fn>;
    speak: ReturnType<typeof vi.fn>;
    endCall: ReturnType<typeof vi.fn>;
    getCall: ReturnType<typeof vi.fn>;
    getCallByProviderCallId: ReturnType<typeof vi.fn>;
  };
  stop: ReturnType<typeof vi.fn>;
};

vi.mock("../../extensions/voice-call/src/runtime.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeStub),
}));

import plugin from "../../extensions/voice-call/index.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type Registered = {
  methods: Map<string, (ctx: Record<string, unknown>) => unknown>;
  tools: unknown[];
};

function setup(config: Record<string, unknown>): Registered {
  const methods = new Map<string, (ctx: Record<string, unknown>) => unknown>();
  const tools: unknown[] = [];
  plugin.register({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    source: "test",
    config: {},
    pluginConfig: config,
    runtime: { tts: { textToSpeechTelephony: vi.fn() } },
    logger: noopLogger,
    registerGatewayMethod: (method, handler) => methods.set(method, handler),
    registerTool: (tool) => tools.push(tool),
    registerCli: () => {},
    registerService: () => {},
    resolvePath: (p: string) => p,
  });
  return { methods, tools };
}

describe("voice-call plugin", () => {
  beforeEach(() => {
    runtimeStub = {
      config: { toNumber: "+15550001234" },
      manager: {
        initiateCall: vi.fn(async () => ({ callId: "call-1", success: true })),
        continueCall: vi.fn(async () => ({
          success: true,
          transcript: "hello",
        })),
        speak: vi.fn(async () => ({ success: true })),
        endCall: vi.fn(async () => ({ success: true })),
        getCall: vi.fn((id: string) => (id === "call-1" ? { callId: "call-1" } : undefined)),
        getCallByProviderCallId: vi.fn(() => undefined),
      },
      stop: vi.fn(async () => {}),
    };
  });

  afterEach(() => vi.restoreAllMocks());

  it("registers gateway methods", () => {
    const { methods } = setup({ provider: "mock" });
    expect(methods.has("voicecall.initiate")).toBe(true);
    expect(methods.has("voicecall.continue")).toBe(true);
    expect(methods.has("voicecall.speak")).toBe(true);
    expect(methods.has("voicecall.end")).toBe(true);
    expect(methods.has("voicecall.status")).toBe(true);
    expect(methods.has("voicecall.start")).toBe(true);
  });

  it("initiates a call via voicecall.initiate", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.initiate");
    const respond = vi.fn();
    await handler?.({ params: { message: "Hi" }, respond });
    expect(runtimeStub.manager.initiateCall).toHaveBeenCalled();
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.callId).toBe("call-1");
  });

  it("returns call status", async () => {
    const { methods } = setup({ provider: "mock" });
    const handler = methods.get("voicecall.status");
    const respond = vi.fn();
    await handler?.({ params: { callId: "call-1" }, respond });
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.found).toBe(true);
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

  it("CLI start prints JSON", async () => {
    const { register } = plugin as unknown as {
      register: (api: Record<string, unknown>) => void | Promise<void>;
    };
    const program = new Command();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await register({
      id: "voice-call",
      name: "Voice Call",
      description: "test",
      version: "0",
      source: "test",
      config: {},
      pluginConfig: { provider: "mock" },
      runtime: { tts: { textToSpeechTelephony: vi.fn() } },
      logger: noopLogger,
      registerGatewayMethod: () => {},
      registerTool: () => {},
      registerCli: (
        fn: (ctx: {
          program: Command;
          config: Record<string, unknown>;
          workspaceDir?: string;
          logger: typeof noopLogger;
        }) => void,
      ) =>
        fn({
          program,
          config: {},
          workspaceDir: undefined,
          logger: noopLogger,
        }),
      registerService: () => {},
      resolvePath: (p: string) => p,
    });

    await program.parseAsync(["voicecall", "start", "--to", "+1", "--message", "Hello"], {
      from: "user",
    });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
