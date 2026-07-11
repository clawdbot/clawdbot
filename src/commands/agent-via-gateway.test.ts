// Agent via gateway tests cover gateway-backed agent command dispatch and session loading.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loggingState } from "../logging/state.js";
import type { RuntimeEnv } from "../runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import { agentCliCommand, agentViaGatewayTesting } from "./agent-via-gateway.js";
import type { agentCommand as AgentCommand } from "./agent.js";

const loadConfig = vi.hoisted(() => vi.fn());
const loadConfigWithShellEnvFallback = vi.hoisted(() => vi.fn());
const loadRuntimeConfig = vi.hoisted(() => vi.fn());
const callGateway = vi.hoisted(() => vi.fn());
const isGatewayCredentialsRequiredError = vi.hoisted(() =>
  vi.fn(
    (value: unknown) => value instanceof Error && value.name === "GatewayCredentialsRequiredError",
  ),
);
const isGatewayExplicitAuthRequiredError = vi.hoisted(() =>
  vi.fn(
    (value: unknown) => value instanceof Error && value.name === "GatewayExplicitAuthRequiredError",
  ),
);
const isGatewayTransportError = vi.hoisted(() =>
  vi.fn((value: unknown) => {
    if (!(value instanceof Error) || value.name !== "GatewayTransportError") {
      return false;
    }
    const kind = (value as { kind?: unknown }).kind;
    return kind === "closed" || kind === "timeout";
  }),
);
const agentCommand = vi.hoisted(() => vi.fn());
const agentModuleLoadCount = vi.hoisted(() => vi.fn());
const loadAgentSessionModuleMock = vi.hoisted(() => vi.fn());

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const jsonRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  writeStdout: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
};

function mockConfig(storePath: string, overrides?: Partial<OpenClawConfig>) {
  const config = {
    agents: {
      defaults: {
        timeoutSeconds: 600,
        ...overrides?.agents?.defaults,
      },
      ...(overrides?.agents?.list ? { list: overrides.agents.list } : {}),
    },
    session: {
      store: storePath,
      mainKey: "main",
      ...overrides?.session,
    },
    gateway: overrides?.gateway,
  };
  loadConfig.mockReturnValue(config);
  loadConfigWithShellEnvFallback.mockResolvedValue(config);
  loadRuntimeConfig.mockReturnValue(config);
}

async function withTempStore(
  fn: (ctx: { dir: string; store: string }) => Promise<void>,
  overrides?: Partial<OpenClawConfig>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
  const store = path.join(dir, "sessions.json");
  mockConfig(store, overrides);
  try {
    await fn({ dir, store });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mockGatewaySuccessReply(text = "hello") {
  callGateway.mockResolvedValue({
    runId: "idem-1",
    status: "ok",
    result: {
      payloads: [{ text }],
      meta: { stub: true },
    },
  });
}

function mockLocalAgentReply(text = "local") {
  agentCommand.mockImplementationOnce(async (_opts, rt) => {
    rt?.log?.(text);
    return {
      payloads: [{ text }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    } as unknown as Awaited<ReturnType<typeof AgentCommand>>;
  });
}

function requireFirstCallArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (arg === undefined) {
    throw new Error(`expected ${label} call`);
  }
  return arg;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} object`);
  }
  return value as Record<string, unknown>;
}

function createSignalProcess() {
  type SignalName = "SIGINT" | "SIGTERM";
  const listeners = new Map<SignalName, Set<() => void>>();
  const processLike = {
    on(signal: SignalName, handler: () => void) {
      const current = listeners.get(signal) ?? new Set<() => void>();
      current.add(handler);
      listeners.set(signal, current);
      return processLike;
    },
    off(signal: SignalName, handler: () => void) {
      listeners.get(signal)?.delete(handler);
      return processLike;
    },
  };
  return {
    processLike,
    emit(signal: SignalName) {
      for (const handler of listeners.get(signal) ?? []) {
        handler();
      }
    },
    listenerCount(signal: SignalName) {
      return listeners.get(signal)?.size ?? 0;
    },
  };
}

async function waitForAgentCommandCall(expectedCalls = 1) {
  await vi.waitFor(() => expect(agentCommand).toHaveBeenCalledTimes(expectedCalls));
}

async function waitForGatewayCall(expectedCalls = 1) {
  await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(expectedCalls));
}

function mockMessages(mock: unknown): string[] {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  return calls.map(([message]) => String(message));
}

function createGatewayTimeoutError() {
  const err = new Error("gateway timeout after 90000ms");
  err.name = "GatewayTransportError";
  return Object.assign(err, {
    kind: "timeout",
    timeoutMs: 90_000,
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
  });
}

function createGatewayClosedError() {
  const err = new Error("gateway closed before response");
  err.name = "GatewayTransportError";
  return Object.assign(err, {
    kind: "closed",
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
  });
}

function createGatewayNormalCloseError() {
  const err = new Error("gateway closed (1000 normal closure): no close reason");
  err.name = "GatewayTransportError";
  return Object.assign(err, {
    kind: "closed",
    code: 1000,
    reason: "no close reason",
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
  });
}

vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: loadConfig,
  readGatewayDispatchConfigWithShellEnvFallback: loadConfigWithShellEnvFallback,
}));
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: loadRuntimeConfig,
  loadConfig: loadRuntimeConfig,
}));
vi.mock("../gateway/call.js", () => ({
  callGateway,
  isGatewayCredentialsRequiredError,
  isGatewayExplicitAuthRequiredError,
  isGatewayTransportError,
  randomIdempotencyKey: () => "idem-1",
}));
vi.mock("./agent.js", () => {
  agentModuleLoadCount();
  return { agentCommand };
});

let originalForceConsoleToStderr = false;
let zeroTimeoutGatewayRequestMs: number | undefined;

function resetAgentCliCommandMocksForTest() {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
  agentViaGatewayTesting.resetLazyImportsForTests();
  agentViaGatewayTesting.setGatewayAbortRetryDelaysMsForTests([0, 0, 0, 0]);
  loadAgentSessionModuleMock.mockImplementation(async () => await import("./agent/session.js"));
  agentViaGatewayTesting.setAgentSessionModuleLoaderForTests(loadAgentSessionModuleMock);
  originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = false;
}

beforeEach(() => {
  resetAgentCliCommandMocksForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  agentViaGatewayTesting.setGatewayAbortRetryDelaysMsForTests();
  loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
});

describe("agentCliCommand", () => {
  beforeAll(async () => {
    const restoreForceConsoleToStderr = loggingState.forceConsoleToStderr;
    resetAgentCliCommandMocksForTest();
    try {
      await withTempStore(async () => {
        mockGatewaySuccessReply();

        await agentCliCommand({ message: "hi", to: "+1555", timeout: "0" }, runtime);

        expect(callGateway).toHaveBeenCalledTimes(1);
        const request = requireFirstCallArg(callGateway, "gateway") as { timeoutMs?: number };
        zeroTimeoutGatewayRequestMs = request.timeoutMs;
      });
    } finally {
      agentViaGatewayTesting.setGatewayAbortRetryDelaysMsForTests();
      loggingState.forceConsoleToStderr = restoreForceConsoleToStderr;
    }
  });

  it("uses a timer-safe max gateway timeout when --timeout is 0", () => {
    expect(zeroTimeoutGatewayRequestMs).toBe(2_147_000_000);
  });

  it("clamps oversized gateway timeout seconds", () => {
    expect(agentViaGatewayTesting.resolveGatewayAgentTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("rejects partial gateway timeout values", async () => {
    await withTempStore(async () => {
      await expect(
        agentCliCommand({ message: "hi", to: "+1555", timeout: "10s" }, runtime),
      ).rejects.toThrow("Invalid --timeout");
      expect(callGateway).not.toHaveBeenCalled();
    });
  });

  it("uses owner authority with the configured local gateway by default", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = requireRecord(requireFirstCallArg(callGateway, "gateway"), "gateway request");
      expect(request.clientName).toBe("cli");
      expect(request.mode).toBe("cli");
      expect(request.scopes).toEqual(["operator.admin"]);
      expect(request.params).toHaveProperty("cleanupBundleMcpOnRunEnd", true);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(agentModuleLoadCount).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("hello");
    });
  });

  it.each([
    {
      label: "configured remote gateway",
      overrides: {
        gateway: {
          mode: "remote" as const,
          remote: { url: "wss://gateway.example" },
        },
      },
    },
    {
      label: "gateway URL override",
      gatewayUrl: "wss://gateway-override.example",
    },
  ])("keeps ordinary $label runs least-privilege", async ({ gatewayUrl, overrides }) => {
    if (gatewayUrl) {
      vi.stubEnv("OPENCLAW_GATEWAY_URL", gatewayUrl);
    }
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = requireRecord(requireFirstCallArg(callGateway, "gateway"), "gateway request");
      expect(request.clientName).toBe("cli");
      expect(request.mode).toBe("cli");
      expect(request).not.toHaveProperty("scopes");
    }, overrides);
  });

  it("reads a UTF-8 message file for gateway dispatch", async () => {
    await withTempStore(async ({ dir }) => {
      const messageFile = path.join(dir, "task.md");
      const messageBody = 'first line\n```json\n{"ok":true}\n```\nsecond line\n';
      fs.writeFileSync(messageFile, `\uFEFF${messageBody}`, "utf8");
      mockGatewaySuccessReply();

      await agentCliCommand({ messageFile, sessionKey: "agent:main:incident-42" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = requireRecord(requireFirstCallArg(callGateway, "gateway"), "gateway request");
      const params = requireRecord(request.params, "gateway request params");
      expect(params.message).toBe(messageBody);
    });
  });

  it("reads a UTF-8 message file for local embedded dispatch", async () => {
    await withTempStore(async ({ dir }) => {
      const messageFile = path.join(dir, "task.md");
      const messageBody = 'first line\n```json\n{"ok":true}\n```\nsecond line\n';
      fs.writeFileSync(messageFile, `\uFEFF${messageBody}`, "utf8");
      mockLocalAgentReply();

      await agentCliCommand(
        { messageFile, sessionKey: "agent:main:incident-42", local: true },
        runtime,
      );

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const opts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      expect(opts.message).toBe(messageBody);
      expect(opts).not.toHaveProperty("messageFile");
    });
  });

  it("rejects inline and file messages together", async () => {
    await expect(
      agentCliCommand(
        { message: "inline", messageFile: "task.md", sessionKey: "agent:main:incident-42" },
        runtime,
      ),
    ).rejects.toThrow("Use either --message or --message-file, not both");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("reports missing message files before dispatch", async () => {
    await withTempStore(async ({ dir }) => {
      const messageFile = path.join(dir, "missing.md");

      await expect(
        agentCliCommand({ messageFile, sessionKey: "agent:main:incident-42" }, runtime),
      ).rejects.toThrow("Message file not found");
      expect(callGateway).not.toHaveBeenCalled();
    });
  });

  it("rejects message files that are not valid UTF-8", async () => {
    await withTempStore(async ({ dir }) => {
      const messageFile = path.join(dir, "task.bin");
      fs.writeFileSync(messageFile, Buffer.from([0xff]));

      await expect(
        agentCliCommand({ messageFile, sessionKey: "agent:main:incident-42" }, runtime),
      ).rejects.toThrow("Message file must be valid UTF-8");
      expect(callGateway).not.toHaveBeenCalled();
    });
  });

  it.each(["/new", "/RESET", "/reset check status"] as const)(
    "uses backend admin authority for %s gateway commands",
    async (message) => {
      await withTempStore(async () => {
        mockGatewaySuccessReply();

        await agentCliCommand({ message, sessionKey: "agent:main:main" }, runtime);

        expect(callGateway).toHaveBeenCalledTimes(1);
        const request = requireRecord(
          requireFirstCallArg(callGateway, "gateway"),
          "gateway request",
        );
        expect(request.clientName).toBe("gateway-client");
        expect(request.mode).toBe("backend");
        expect(request.scopes).toEqual(["operator.admin"]);
        const params = requireRecord(request.params, "gateway request params");
        expect(params.message).toBe(message);
      });
    },
  );

  it("uses an explicit session key as the gateway session selector", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", sessionKey: "agent:main:incident-42" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = requireRecord(requireFirstCallArg(callGateway, "gateway"), "gateway request");
      const params = requireRecord(request.params, "gateway request params");
      expect(params.sessionKey).toBe("agent:main:incident-42");
      expect(params.sessionId).toBeUndefined();
      expect(params.to).toBeUndefined();
      expect(request.config).toBe(loadConfig.mock.results[0]?.value);
      expect(loadConfig).toHaveBeenCalledWith();
      expect(agentCommand).not.toHaveBeenCalled();
      expect(loadAgentSessionModuleMock).not.toHaveBeenCalled();
    });
  });

  it("uses an agent-scoped --to value as the gateway session selector", async () => {
    await withTempStore(async () => {
      const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: sessionKey }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = requireRecord(requireFirstCallArg(callGateway, "gateway"), "gateway request");
      const params = requireRecord(request.params, "gateway request params");
      expect(params.sessionKey).toBe(sessionKey);
      expect(params.to).toBeUndefined();
      expect(agentCommand).not.toHaveBeenCalled();
      expect(loadAgentSessionModuleMock).not.toHaveBeenCalled();
    });
  });

  it("defers explicit recipient session routing to the Gateway", async () => {
    await withTempStore(
      async () => {
        mockGatewaySuccessReply();

        await agentCliCommand(
          {
            message: "hi",
            agent: "ops",
            channel: "whatsapp",
            to: "+15551234567",
          },
          runtime,
        );

        const request = requireRecord(
          requireFirstCallArg(callGateway, "gateway"),
          "gateway request",
        );
        const params = requireRecord(request.params, "gateway request params");
        expect(params).toMatchObject({
          agentId: "ops",
          channel: "whatsapp",
          to: "+15551234567",
        });
        expect(params.sessionKey).toBeUndefined();
      },
      {
        agents: { list: [{ id: "main" }, { id: "ops" }] },
        session: { dmScope: "per-channel-peer" },
      },
    );
  });

  it("retries gateway dispatch with shell env fallback only when credentials need it", async () => {
    await withTempStore(async ({ store }) => {
      const fastConfig = {
        agents: { defaults: { timeoutSeconds: 600 } },
        session: { store, mainKey: "main" },
      };
      const shellEnvConfig = {
        ...fastConfig,
        gateway: { auth: { mode: "token" as const } },
      };
      loadConfig.mockReset();
      loadConfig.mockReturnValueOnce(fastConfig);
      loadConfigWithShellEnvFallback.mockReset();
      loadConfigWithShellEnvFallback.mockResolvedValueOnce(shellEnvConfig);
      const authError = new Error("gateway agent requires credentials");
      authError.name = "GatewayCredentialsRequiredError";
      callGateway.mockRejectedValueOnce(authError);
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", sessionKey: "agent:main:incident-42" }, runtime);

      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(loadConfig).toHaveBeenCalledWith();
      expect(loadConfigWithShellEnvFallback).toHaveBeenCalledTimes(1);
      expect(loadConfigWithShellEnvFallback).toHaveBeenCalledWith();
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(requireRecord(callGateway.mock.calls[0]?.[0], "first gateway request").config).toBe(
        fastConfig,
      );
      expect(requireRecord(callGateway.mock.calls[1]?.[0], "second gateway request").config).toBe(
        shellEnvConfig,
      );
    });
  });

  it("retries gateway dispatch with shell env fallback for env URL auth", async () => {
    await withTempStore(async ({ store }) => {
      const fastConfig = {
        agents: { defaults: { timeoutSeconds: 600 } },
        session: { store, mainKey: "main" },
      };
      loadConfig.mockReset();
      loadConfig.mockReturnValueOnce(fastConfig);
      loadConfigWithShellEnvFallback.mockReset();
      loadConfigWithShellEnvFallback.mockResolvedValueOnce(fastConfig);
      const authError = new Error("gateway url override requires explicit credentials");
      authError.name = "GatewayExplicitAuthRequiredError";
      callGateway.mockRejectedValueOnce(authError);
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", sessionKey: "agent:main:incident-42" }, runtime);

      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(loadConfig).toHaveBeenCalledWith();
      expect(loadConfigWithShellEnvFallback).toHaveBeenCalledTimes(1);
      expect(loadConfigWithShellEnvFallback).toHaveBeenCalledWith();
      expect(callGateway).toHaveBeenCalledTimes(2);
    });
  });

  it("scopes legacy explicit session keys to the requested agent", async () => {
    await withTempStore(
      async () => {
        mockGatewaySuccessReply();

        await agentCliCommand({ message: "hi", agent: "ops", sessionKey: "incident-42" }, runtime);

        expect(callGateway).toHaveBeenCalledTimes(1);
        const request = requireRecord(
          requireFirstCallArg(callGateway, "gateway"),
          "gateway request",
        );
        const params = requireRecord(request.params, "gateway request params");
        expect(params.agentId).toBe("ops");
        expect(params.sessionKey).toBe("agent:ops:incident-42");
      },
      { agents: { list: [{ id: "main" }, { id: "ops" }] } },
    );
  });

  it("accepts agent-prefixed session keys when only casing differs from --agent", async () => {
    await withTempStore(
      async () => {
        mockGatewaySuccessReply();

        await agentCliCommand(
          { message: "hi", agent: "OPS", sessionKey: "agent:OPS:incident-42" },
          runtime,
        );

        expect(callGateway).toHaveBeenCalledTimes(1);
        const request = requireRecord(
          requireFirstCallArg(callGateway, "gateway"),
          "gateway request",
        );
        const params = requireRecord(request.params, "gateway request params");
        expect(params.agentId).toBe("ops");
        expect(params.sessionKey).toBe("agent:OPS:incident-42");
      },
      { agents: { list: [{ id: "main" }, { id: "ops" }] } },
    );
  });

  it("scopes legacy explicit session keys to the default agent when no agent is requested", async () => {
    await withTempStore(
      async () => {
        mockGatewaySuccessReply();

        await agentCliCommand({ message: "hi", sessionKey: "incident-42" }, runtime);

        expect(callGateway).toHaveBeenCalledTimes(1);
        const request = requireRecord(
          requireFirstCallArg(callGateway, "gateway"),
          "gateway request",
        );
        const params = requireRecord(request.params, "gateway request params");
        expect(params.agentId).toBeUndefined();
        expect(params.sessionKey).toBe("agent:ops:incident-42");
      },
      { agents: { list: [{ id: "ops", default: true }, { id: "main" }] } },
    );
  });

  it("prefers explicit session keys when a session id is also supplied", async () => {
    await withTempStore(
      async ({ store }) => {
        fs.writeFileSync(
          store,
          JSON.stringify({
            "agent:main:main": { sessionId: "existing-main-session", updatedAt: 1 },
          }),
        );
        mockGatewaySuccessReply();

        await agentCliCommand(
          {
            message: "hi",
            sessionId: "existing-main-session",
            sessionKey: "agent:ops:incident-42",
          },
          runtime,
        );

        expect(callGateway).toHaveBeenCalledTimes(1);
        const request = requireRecord(
          requireFirstCallArg(callGateway, "gateway"),
          "gateway request",
        );
        const params = requireRecord(request.params, "gateway request params");
        expect(params.sessionId).toBe("existing-main-session");
        expect(params.sessionKey).toBe("agent:ops:incident-42");
      },
      { agents: { list: [{ id: "main" }, { id: "ops" }] } },
    );
  });

  it("scopes legacy global session keys to the requested agent before gateway dispatch", async () => {
    await withTempStore(
      async () => {
        mockGatewaySuccessReply();

        await agentCliCommand({ message: "hi", agent: "ops", sessionKey: "global" }, runtime);

        expect(callGateway).toHaveBeenCalledTimes(1);
        const request = requireRecord(
          requireFirstCallArg(callGateway, "gateway"),
          "gateway request",
        );
        const params = requireRecord(request.params, "gateway request params");
        expect(params.agentId).toBe("ops");
        expect(params.sessionKey).toBe("agent:ops:global");
      },
      { agents: { list: [{ id: "main" }, { id: "ops" }] } },
    );
  });

  it("preserves unscoped global session keys when no agent is requested", async () => {
    await withTempStore(
      async () => {
        mockGatewaySuccessReply();

        await agentCliCommand({ message: "hi", sessionKey: "global" }, runtime);

        expect(callGateway).toHaveBeenCalledTimes(1);
        const request = requireRecord(
          requireFirstCallArg(callGateway, "gateway"),
          "gateway request",
        );
        const params = requireRecord(request.params, "gateway request params");
        expect(params.agentId).toBeUndefined();
        expect(params.sessionKey).toBe("global");
      },
      { agents: { list: [{ id: "ops", default: true }, { id: "main" }] } },
    );
  });

  it("preserves unscoped unknown session keys when no agent is requested", async () => {
    await withTempStore(
      async () => {
        mockGatewaySuccessReply();

        await agentCliCommand({ message: "hi", sessionKey: "unknown" }, runtime);

        expect(callGateway).toHaveBeenCalledTimes(1);
        const request = requireRecord(
          requireFirstCallArg(callGateway, "gateway"),
          "gateway request",
        );
        const params = requireRecord(request.params, "gateway request params");
        expect(params.agentId).toBeUndefined();
        expect(params.sessionKey).toBe("unknown");
      },
      { agents: { list: [{ id: "ops", default: true }, { id: "main" }] } },
    );
  });

  it("does not treat lazy channel deps as the process signal source", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();
      const deps = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === "process") {
              return async () => undefined;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime, deps);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it("exits for successful gateway runs when SIGTERM arrives before return", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      mockGatewaySuccessReply();
      const signalRuntime: RuntimeEnv = {
        log: vi.fn(() => {
          signals.emit("SIGTERM");
        }),
        error: vi.fn(),
        exit: vi.fn(),
      };

      const result = await agentCliCommand({ message: "hi", to: "+1555" }, signalRuntime, {
        process: signals.processLike,
      });

      expect(result).toBeUndefined();
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(signalRuntime.log).toHaveBeenCalledWith("hello");
      expect(signalRuntime.exit).toHaveBeenCalledWith(143);
    });
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)(
    "aborts an accepted gateway run using the accepted session key when %s interrupts the CLI",
    async (signalName, exitCode) => {
      await withTempStore(async () => {
        const signals = createSignalProcess();
        let sameConnectionAbort:
          | { method: string; params: unknown; opts?: { timeoutMs?: number | null } }
          | undefined;
        callGateway.mockImplementation(async (requestValue: unknown) => {
          const request = requireRecord(requestValue, "gateway request");
          if (request.method === "agent") {
            const onAccepted = request.onAccepted as ((payload: unknown) => void) | undefined;
            const onSignalAbort = request.onSignalAbort as
              | ((
                  request: (
                    method: string,
                    params?: unknown,
                    opts?: { timeoutMs?: number | null },
                  ) => Promise<unknown>,
                ) => Promise<void>)
              | undefined;
            const signal = request.signal as AbortSignal | undefined;
            onAccepted?.({
              status: "accepted",
              runId: "run-signal",
              sessionKey: "agent:main:explicit:reset-run",
            });
            return await new Promise((_, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  void (async () => {
                    await onSignalAbort?.(async (method, params, opts) => {
                      sameConnectionAbort = { method, params, opts };
                      return { ok: true, aborted: true, runIds: ["run-signal"] };
                    });
                    const err = new Error("gateway request aborted for agent");
                    err.name = "AbortError";
                    reject(err);
                  })();
                },
                { once: true },
              );
            });
          }
          throw new Error(`unexpected gateway method ${String(request.method)}`);
        });

        const run = agentCliCommand({ message: "hi", to: "+1555" }, runtime, {
          process: signals.processLike,
        });
        await waitForGatewayCall();
        signals.emit(signalName);
        expect(signals.listenerCount("SIGTERM")).toBe(0);
        expect(signals.listenerCount("SIGINT")).toBe(0);

        await run;
        expect(callGateway).toHaveBeenCalledTimes(1);
        expect(runtime.exit).toHaveBeenCalledWith(exitCode);
        expect(sameConnectionAbort?.method).toBe("chat.abort");
        expect(sameConnectionAbort?.opts).toEqual({ timeoutMs: 2_000 });
        expect(sameConnectionAbort?.params).toEqual({
          sessionKey: "agent:main:explicit:reset-run",
          runId: "run-signal",
        });
      });
    },
  );

  it("aborts a gateway run by idempotency key before the accepted ack", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      let sameConnectionAbort:
        | { method: string; params: unknown; opts?: { timeoutMs?: number | null } }
        | undefined;
      callGateway.mockImplementation(async (requestValue: unknown) => {
        const request = requireRecord(requestValue, "gateway request");
        if (request.method === "agent") {
          const params = requireRecord(request.params, "gateway agent params");
          expect(params.idempotencyKey).toBe("pre-accepted-run");
          const onSignalAbort = request.onSignalAbort as
            | ((
                request: (
                  method: string,
                  params?: unknown,
                  opts?: { timeoutMs?: number | null },
                ) => Promise<unknown>,
              ) => Promise<void>)
            | undefined;
          const signal = request.signal as AbortSignal | undefined;
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                void (async () => {
                  await onSignalAbort?.(async (method, paramsResult, opts) => {
                    sameConnectionAbort = { method, params: paramsResult, opts };
                    return { ok: true, aborted: true, runIds: ["pre-accepted-run"] };
                  });
                  const err = new Error("gateway request aborted before accepted ack");
                  err.name = "AbortError";
                  reject(err);
                })();
              },
              { once: true },
            );
          });
        }
        throw new Error(`unexpected gateway method ${String(request.method)}`);
      });

      const run = agentCliCommand(
        { message: "hi", sessionId: "pre-session", runId: "pre-accepted-run" },
        runtime,
        {
          process: signals.processLike,
        },
      );
      await waitForGatewayCall();
      signals.emit("SIGTERM");

      await run;
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(runtime.exit).toHaveBeenCalledWith(143);
      expect(sameConnectionAbort?.method).toBe("chat.abort");
      expect(sameConnectionAbort?.opts).toEqual({ timeoutMs: 2_000 });
      expect(sameConnectionAbort?.params).toEqual({
        sessionKey: "agent:main:explicit:pre-session",
        runId: "pre-accepted-run",
      });
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(signals.listenerCount("SIGINT")).toBe(0);
    });
  });

  it("aborts deferred recipient routing by idempotency key before the accepted ack", async () => {
    await withTempStore(
      async () => {
        const signals = createSignalProcess();
        let sameConnectionAbort:
          | { method: string; params: unknown; opts?: { timeoutMs?: number | null } }
          | undefined;
        callGateway.mockImplementation(async (requestValue: unknown) => {
          const request = requireRecord(requestValue, "gateway request");
          if (request.method === "agent") {
            const params = requireRecord(request.params, "gateway agent params");
            expect(params).toMatchObject({
              agentId: "ops",
              channel: "whatsapp",
              to: "+15551234567",
              idempotencyKey: "recipient-pre-accepted-run",
            });
            expect(params.sessionKey).toBeUndefined();
            const onSignalAbort = request.onSignalAbort as
              | ((
                  request: (
                    method: string,
                    params?: unknown,
                    opts?: { timeoutMs?: number | null },
                  ) => Promise<unknown>,
                ) => Promise<void>)
              | undefined;
            const signal = request.signal as AbortSignal | undefined;
            return await new Promise((_, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  void (async () => {
                    await onSignalAbort?.(async (method, paramsResult, opts) => {
                      sameConnectionAbort = { method, params: paramsResult, opts };
                      return {
                        ok: true,
                        aborted: true,
                        runIds: ["recipient-pre-accepted-run"],
                      };
                    });
                    const err = new Error("gateway recipient routing aborted before accepted ack");
                    err.name = "AbortError";
                    reject(err);
                  })();
                },
                { once: true },
              );
            });
          }
          throw new Error(`unexpected gateway method ${String(request.method)}`);
        });

        const run = agentCliCommand(
          {
            message: "hi",
            agent: "ops",
            channel: "whatsapp",
            to: "+15551234567",
            runId: "recipient-pre-accepted-run",
          },
          runtime,
          { process: signals.processLike },
        );
        await waitForGatewayCall();
        signals.emit("SIGTERM");

        await run;
        expect(runtime.exit).toHaveBeenCalledWith(143);
        expect(sameConnectionAbort?.method).toBe("chat.abort");
        expect(sameConnectionAbort?.params).toEqual({
          sessionKey: "agent:ops:main",
          runId: "recipient-pre-accepted-run",
        });
      },
      {
        agents: { list: [{ id: "main" }, { id: "ops" }] },
        session: { dmScope: "per-channel-peer" },
      },
    );
  });

  it("skips fallback abort when SIGTERM interrupts before the gateway request starts", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      callGateway.mockImplementation(async (requestValue: unknown) => {
        const request = requireRecord(requestValue, "gateway request");
        if (request.method === "agent") {
          const signal = request.signal as AbortSignal | undefined;
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                const err = new Error("gateway request aborted before start");
                err.name = "AbortError";
                reject(err);
              },
              { once: true },
            );
          });
        }
        throw new Error(`unexpected gateway method ${String(request.method)}`);
      });

      const run = agentCliCommand({ message: "hi", to: "+1555" }, runtime, {
        process: signals.processLike,
      });
      await waitForGatewayCall();
      signals.emit("SIGTERM");

      await run;
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(runtime.exit).toHaveBeenCalledWith(143);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(signals.listenerCount("SIGINT")).toBe(0);
    });
  });

  it("retries same-connection abort before falling back to a new Gateway call", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      const sameConnectionAborts: Array<{
        method: string;
        params: unknown;
        opts?: { timeoutMs?: number | null };
      }> = [];
      callGateway.mockImplementation(async (requestValue: unknown) => {
        const request = requireRecord(requestValue, "gateway request");
        if (request.method === "agent") {
          const params = requireRecord(request.params, "gateway agent params");
          expect(params.idempotencyKey).toBe("pre-accepted-run");
          const onSignalAbort = request.onSignalAbort as
            | ((
                request: (
                  method: string,
                  params?: unknown,
                  opts?: { timeoutMs?: number | null },
                ) => Promise<unknown>,
              ) => Promise<void>)
            | undefined;
          const signal = request.signal as AbortSignal | undefined;
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                void (async () => {
                  await onSignalAbort?.(async (method, paramsValue, opts) => {
                    sameConnectionAborts.push({ method, params: paramsValue, opts });
                    return sameConnectionAborts.length < 3
                      ? { ok: true, aborted: false, runIds: [] }
                      : { ok: true, aborted: true, runIds: ["pre-accepted-run"] };
                  });
                  const err = new Error("gateway request aborted before registration");
                  err.name = "AbortError";
                  reject(err);
                })();
              },
              { once: true },
            );
          });
        }
        throw new Error(`unexpected gateway method ${String(request.method)}`);
      });

      const run = agentCliCommand(
        { message: "hi", to: "+1555", runId: "pre-accepted-run" },
        runtime,
        {
          process: signals.processLike,
        },
      );
      await waitForGatewayCall();
      signals.emit("SIGTERM");

      await run;
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(runtime.exit).toHaveBeenCalledWith(143);
      expect(sameConnectionAborts).toHaveLength(3);
      expect(sameConnectionAborts.at(-1)).toEqual({
        method: "chat.abort",
        opts: { timeoutMs: 2_000 },
        params: {
          sessionKey: "agent:main:main",
          runId: "pre-accepted-run",
        },
      });
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(signals.listenerCount("SIGINT")).toBe(0);
    });
  });

  it("falls back to a new Gateway call when the same-connection abort is not confirmed", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      const sameConnectionAborts: Array<{
        method: string;
        params: unknown;
        opts?: { timeoutMs?: number | null };
      }> = [];
      let fallbackAbort: Record<string, unknown> | undefined;
      callGateway.mockImplementation(async (requestValue: unknown) => {
        const request = requireRecord(requestValue, "gateway request");
        if (request.method === "agent") {
          const params = requireRecord(request.params, "gateway agent params");
          expect(params.idempotencyKey).toBe("pre-accepted-run");
          const onSignalAbort = request.onSignalAbort as
            | ((
                request: (
                  method: string,
                  params?: unknown,
                  opts?: { timeoutMs?: number | null },
                ) => Promise<unknown>,
              ) => Promise<void>)
            | undefined;
          const signal = request.signal as AbortSignal | undefined;
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                void (async () => {
                  await onSignalAbort?.(async (method, paramsLocal, opts) => {
                    sameConnectionAborts.push({ method, params: paramsLocal, opts });
                    return { ok: true, aborted: false, runIds: [] };
                  });
                  const err = new Error("gateway request aborted before registration");
                  err.name = "AbortError";
                  reject(err);
                })();
              },
              { once: true },
            );
          });
        }
        if (request.method === "chat.abort") {
          fallbackAbort = request;
          return { ok: true, aborted: true, runIds: ["pre-accepted-run"] };
        }
        throw new Error(`unexpected gateway method ${String(request.method)}`);
      });

      const run = agentCliCommand(
        { message: "hi", to: "+1555", runId: "pre-accepted-run" },
        runtime,
        {
          process: signals.processLike,
        },
      );
      await waitForGatewayCall();
      signals.emit("SIGTERM");

      await run;
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(runtime.exit).toHaveBeenCalledWith(143);
      expect(sameConnectionAborts).toHaveLength(5);
      expect(sameConnectionAborts.at(-1)).toEqual({
        method: "chat.abort",
        opts: { timeoutMs: 2_000 },
        params: {
          sessionKey: "agent:main:main",
          runId: "pre-accepted-run",
        },
      });
      expect(fallbackAbort?.method).toBe("chat.abort");
      expect(fallbackAbort?.timeoutMs).toBe(2_000);
      expect(fallbackAbort?.config).toBe(loadConfig.mock.results[0]?.value);
      expect(fallbackAbort?.params).toEqual({
        sessionKey: "agent:main:main",
        runId: "pre-accepted-run",
      });
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(signals.listenerCount("SIGINT")).toBe(0);
    });
  });

  it("preserves backend admin authority when SIGTERM aborts a model override run", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      let sameConnectionAbort:
        | { method: string; params: unknown; opts?: { timeoutMs?: number | null } }
        | undefined;
      callGateway.mockImplementation(async (requestValue: unknown) => {
        const request = requireRecord(requestValue, "gateway request");
        if (request.method === "agent") {
          expect(request.clientName).toBe("gateway-client");
          expect(request.mode).toBe("backend");
          expect(request.scopes).toEqual(["operator.admin"]);
          const onAccepted = request.onAccepted as ((payload: unknown) => void) | undefined;
          const onSignalAbort = request.onSignalAbort as
            | ((
                request: (
                  method: string,
                  params?: unknown,
                  opts?: { timeoutMs?: number | null },
                ) => Promise<unknown>,
              ) => Promise<void>)
            | undefined;
          const signal = request.signal as AbortSignal | undefined;
          onAccepted?.({ status: "accepted", runId: "run-model-sigterm" });
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                void (async () => {
                  await onSignalAbort?.(async (method, params, opts) => {
                    sameConnectionAbort = { method, params, opts };
                    return { ok: true, aborted: true, runIds: ["run-model-sigterm"] };
                  });
                  const err = new Error("gateway request aborted for model override agent");
                  err.name = "AbortError";
                  reject(err);
                })();
              },
              { once: true },
            );
          });
        }
        throw new Error(`unexpected gateway method ${String(request.method)}`);
      });

      const run = agentCliCommand(
        { message: "hi", to: "+1555", model: "ollama/qwen3.5:9b" },
        runtime,
        {
          process: signals.processLike,
        },
      );
      await waitForGatewayCall();
      signals.emit("SIGTERM");

      await run;
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(runtime.exit).toHaveBeenCalledWith(143);
      expect(sameConnectionAbort?.method).toBe("chat.abort");
      expect(sameConnectionAbort?.opts).toEqual({ timeoutMs: 2_000 });
      expect(sameConnectionAbort?.params).toEqual({
        sessionKey: "agent:main:main",
        runId: "run-model-sigterm",
      });
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(signals.listenerCount("SIGINT")).toBe(0);
    });
  });

  it("preserves backend admin authority for model override fallback aborts", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      const sameConnectionAborts: Array<{
        method: string;
        params: unknown;
        opts?: { timeoutMs?: number | null };
      }> = [];
      let fallbackAbort: Record<string, unknown> | undefined;
      callGateway.mockImplementation(async (requestValue: unknown) => {
        const request = requireRecord(requestValue, "gateway request");
        if (request.method === "agent") {
          expect(request.clientName).toBe("gateway-client");
          expect(request.mode).toBe("backend");
          expect(request.scopes).toEqual(["operator.admin"]);
          const onAccepted = request.onAccepted as ((payload: unknown) => void) | undefined;
          const onSignalAbort = request.onSignalAbort as
            | ((
                request: (
                  method: string,
                  params?: unknown,
                  opts?: { timeoutMs?: number | null },
                ) => Promise<unknown>,
              ) => Promise<void>)
            | undefined;
          const signal = request.signal as AbortSignal | undefined;
          onAccepted?.({ status: "accepted", runId: "run-model-fallback" });
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                void (async () => {
                  await onSignalAbort?.(async (method, params, opts) => {
                    sameConnectionAborts.push({ method, params, opts });
                    return { ok: true, aborted: false, runIds: [] };
                  });
                  const err = new Error("gateway request aborted for model override agent");
                  err.name = "AbortError";
                  reject(err);
                })();
              },
              { once: true },
            );
          });
        }
        if (request.method === "chat.abort") {
          fallbackAbort = request;
          return { ok: true, aborted: true, runIds: ["run-model-fallback"] };
        }
        throw new Error(`unexpected gateway method ${String(request.method)}`);
      });

      const run = agentCliCommand(
        { message: "hi", to: "+1555", model: "ollama/qwen3.5:9b" },
        runtime,
        {
          process: signals.processLike,
        },
      );
      await waitForGatewayCall();
      signals.emit("SIGTERM");

      await run;
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(runtime.exit).toHaveBeenCalledWith(143);
      expect(sameConnectionAborts).toHaveLength(5);
      expect(fallbackAbort?.method).toBe("chat.abort");
      expect(fallbackAbort?.timeoutMs).toBe(2_000);
      expect(fallbackAbort?.clientName).toBe("gateway-client");
      expect(fallbackAbort?.mode).toBe("backend");
      expect(fallbackAbort?.scopes).toEqual(["operator.admin"]);
      expect(fallbackAbort?.config).toBe(loadConfig.mock.results[0]?.value);
      expect(fallbackAbort?.params).toEqual({
        sessionKey: "agent:main:main",
        runId: "run-model-fallback",
      });
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(signals.listenerCount("SIGINT")).toBe(0);
    });
  });

  it("passes SIGTERM abort signals into local agent runs", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      agentCommand.mockImplementationOnce(async (opts: { abortSignal?: AbortSignal }) => {
        expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
        return await new Promise((_, reject) => {
          opts.abortSignal?.addEventListener(
            "abort",
            () => {
              const err = new Error("local agent aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
      });

      const run = agentCliCommand({ message: "hi", to: "+1555", local: true }, runtime, {
        process: signals.processLike,
      });
      await waitForAgentCommandCall();
      signals.emit("SIGTERM");

      await run;
      expect(callGateway).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(143);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(signals.listenerCount("SIGINT")).toBe(0);
    });
  });

  it("exits for local runs that resolve after SIGTERM aborts them", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      agentCommand.mockImplementationOnce(async (opts: { abortSignal?: AbortSignal }) => {
        return await new Promise((resolve) => {
          opts.abortSignal?.addEventListener(
            "abort",
            () => {
              resolve({
                payloads: [],
                meta: { aborted: true },
              } as unknown as Awaited<ReturnType<typeof AgentCommand>>);
            },
            { once: true },
          );
        });
      });

      const run = agentCliCommand({ message: "hi", to: "+1555", local: true }, runtime, {
        process: signals.processLike,
      });
      await waitForAgentCommandCall();
      signals.emit("SIGTERM");

      await expect(run).resolves.toBeUndefined();
      expect(callGateway).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(143);
    });
  });

  it("exits for embedded fallback runs that resolve after SIGTERM aborts them", async () => {
    await withTempStore(async () => {
      const signals = createSignalProcess();
      callGateway.mockRejectedValueOnce(createGatewayClosedError());
      let resolveFallback: ((value: Awaited<ReturnType<typeof AgentCommand>>) => void) | undefined;
      agentCommand.mockImplementationOnce(async (_opts: { abortSignal?: AbortSignal }) => {
        return await new Promise((resolve) => {
          resolveFallback = resolve;
        });
      });

      const run = agentCliCommand({ message: "hi", to: "+1555" }, runtime, {
        process: signals.processLike,
      });
      await waitForAgentCommandCall();
      signals.emit("SIGTERM");
      resolveFallback?.({
        payloads: [],
        meta: { aborted: true },
      } as unknown as Awaited<ReturnType<typeof AgentCommand>>);

      await expect(run).resolves.toBeUndefined();
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(runtime.exit).toHaveBeenCalledWith(143);
    });
  });

  it("does not route abort errors through embedded gateway fallback classification", async () => {
    await withTempStore(async () => {
      const err = new Error("gateway request aborted for agent");
      err.name = "AbortError";
      callGateway.mockRejectedValueOnce(err);

      await expect(agentCliCommand({ message: "hi", to: "+1555" }, runtime)).rejects.toThrow(
        "gateway request aborted for agent",
      );

      expect(isGatewayTransportError).not.toHaveBeenCalled();
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it("aborts while waiting for a transient gateway retry", async () => {
    vi.useFakeTimers();
    try {
      await withTempStore(async () => {
        const signals = createSignalProcess();
        callGateway.mockRejectedValueOnce(createGatewayNormalCloseError());

        const run = agentCliCommand({ message: "hi", to: "+1555" }, runtime, {
          process: signals.processLike,
        });
        for (
          let attempt = 0;
          attempt < 10 && mockMessages(runtime.error).length === 0;
          attempt += 1
        ) {
          await Promise.resolve();
        }
        signals.emit("SIGTERM");

        await expect(run).resolves.toBeUndefined();
        expect(callGateway).toHaveBeenCalledTimes(1);
        expect(agentCommand).not.toHaveBeenCalled();
        expect(runtime.exit).toHaveBeenCalledWith(143);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays silent when the gateway returns an intentional empty reply", async () => {
    await withTempStore(async () => {
      callGateway.mockResolvedValue({
        runId: "idem-1",
        status: "ok",
        summary: "completed",
        result: {
          payloads: [],
          meta: { stub: true },
        },
      });

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(runtime.log).not.toHaveBeenCalled();
    });
  });

  it("logs non-ok gateway summaries when payloads are empty", async () => {
    await withTempStore(async () => {
      callGateway.mockResolvedValue({
        runId: "idem-1",
        status: "timeout",
        summary: "aborted",
        result: {
          payloads: [],
          meta: { aborted: true },
        },
      });

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(runtime.log).toHaveBeenCalledWith("aborted");
    });
  });

  it("surfaces duplicate in-flight gateway runs without pretending a reply arrived", async () => {
    await withTempStore(async () => {
      callGateway.mockResolvedValue({
        runId: "idem-1",
        status: "in_flight",
        sessionKey: "agent:main:main",
      });

      await agentCliCommand({ message: "hi", to: "+1555", runId: "idem-1" }, runtime);

      expect(runtime.error).toHaveBeenCalledWith(
        "Agent run idem-1 is already in flight; not starting a duplicate run.",
      );
      expect(runtime.log).not.toHaveBeenCalledWith("No reply from agent.");
    });
  });

  it("passes model overrides through gateway requests", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555", model: "ollama/qwen3.5:9b" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = requireRecord(requireFirstCallArg(callGateway, "gateway"), "gateway request");
      expect(request.clientName).toBe("gateway-client");
      expect(request.mode).toBe("backend");
      expect(request.scopes).toEqual(["operator.admin"]);
      const params = requireRecord(request.params, "gateway request params");
      expect(params.model).toBe("ollama/qwen3.5:9b");
    });
  });

  it("routes diagnostics to stderr before JSON gateway execution", async () => {
    await withTempStore(async () => {
      const response = {
        runId: "idem-1",
        status: "ok",
        result: {
          payloads: [{ text: "hello" }],
          meta: { stub: true },
        },
      };
      callGateway.mockImplementationOnce(async () => {
        expect(loggingState.forceConsoleToStderr).toBe(true);
        return response;
      });

      await agentCliCommand({ message: "hi", to: "+1555", json: true }, jsonRuntime);

      expect(jsonRuntime.writeJson).toHaveBeenCalledWith(response, 2);
      expect(jsonRuntime.log).not.toHaveBeenCalled();
    });
  });

  it("promotes gateway deliveryStatus to the top-level JSON response", async () => {
    await withTempStore(async () => {
      const deliveryStatus = {
        requested: true,
        attempted: true,
        status: "sent",
        succeeded: true,
        resultCount: 1,
      };
      const response = {
        runId: "idem-1",
        status: "ok",
        result: {
          payloads: [{ text: "hello" }],
          meta: { stub: true },
          deliveryStatus,
        },
      };
      callGateway.mockResolvedValue(response);

      await agentCliCommand({ message: "hi", to: "+1555", json: true, deliver: true }, jsonRuntime);

      expect(jsonRuntime.writeJson).toHaveBeenCalledWith(
        {
          ...response,
          deliveryStatus,
        },
        2,
      );
      expect(jsonRuntime.log).not.toHaveBeenCalled();
    });
  });

  it("falls back to embedded agent when gateway fails", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(createGatewayClosedError());
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const fallbackOpts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      const resultMetaOverrides = requireRecord(
        fallbackOpts.resultMetaOverrides,
        "fallback metadata",
      );
      expect(resultMetaOverrides.transport).toBe("embedded");
      expect(resultMetaOverrides.fallbackFrom).toBe("gateway");
      expect(
        mockMessages(runtime.error).some((message) =>
          message.includes("EMBEDDED FALLBACK: Gateway agent failed"),
        ),
      ).toBe(true);
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("retries transient normal gateway closes before embedded fallback", async () => {
    vi.useFakeTimers();
    try {
      await withTempStore(async () => {
        callGateway
          .mockRejectedValueOnce(createGatewayNormalCloseError())
          .mockRejectedValueOnce(createGatewayNormalCloseError())
          .mockResolvedValue({
            runId: "idem-1",
            status: "ok",
            result: {
              payloads: [{ text: "remote" }],
              meta: { stub: true },
            },
          });

        const command = agentCliCommand({ message: "hi", to: "+1555" }, runtime);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(2_000);
        await command;

        expect(callGateway).toHaveBeenCalledTimes(3);
        const idempotencyKeys = callGateway.mock.calls.map(
          ([call]) => (call as { params?: { idempotencyKey?: unknown } }).params?.idempotencyKey,
        );
        expect(new Set(idempotencyKeys).size).toBe(1);
        expect(agentCommand).not.toHaveBeenCalled();
        expect(
          mockMessages(runtime.error).filter((message) =>
            message.includes("Gateway agent connection closed during handshake"),
          ),
        ).toHaveLength(2);
        expect(runtime.log).toHaveBeenCalledWith("remote");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves explicit session keys for embedded fallback when the gateway closes", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(createGatewayClosedError());
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", sessionKey: "agent:main:incident-42" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const fallbackOpts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      expect(fallbackOpts.sessionKey).toBe("agent:main:incident-42");
      expect(fallbackOpts.resultMetaOverrides).toMatchObject({
        transport: "embedded",
        fallbackFrom: "gateway",
      });
    });
  });

  it("propagates harness-owned session rejection from embedded gateway fallback", async () => {
    await withTempStore(async () => {
      const sessionKey = "agent:main:harness:codex:supervision:missing-fallback";
      callGateway.mockRejectedValue(createGatewayClosedError());
      agentCommand.mockRejectedValueOnce(new Error(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE));

      await expect(agentCliCommand({ message: "hi", sessionKey }, runtime)).rejects.toThrow(
        AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
      );

      expect(callGateway).toHaveBeenCalledOnce();
      expect(agentCommand).toHaveBeenCalledOnce();
      expect(
        requireRecord(requireFirstCallArg(agentCommand, "embedded agent"), "options"),
      ).toMatchObject({ sessionKey });
    });
  });

  it("does not fall back to embedded agent for gateway request errors", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(
        Object.assign(new Error("missing scope: operator.admin"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
        }),
      );

      await expect(agentCliCommand({ message: "hi", to: "+1555" }, runtime)).rejects.toThrow(
        "missing scope: operator.admin",
      );

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(
        mockMessages(runtime.error).some((message) => message.includes("EMBEDDED FALLBACK")),
      ).toBe(false);
    });
  });

  it("uses a fresh embedded session when gateway agent times out", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(createGatewayTimeoutError());
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "hi",
          sessionId: "locked-session",
          runId: "locked-run",
        },
        runtime,
      );

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const fallbackOpts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      const fallbackSessionId = String(fallbackOpts.sessionId);
      const fallbackSessionKey = String(fallbackOpts.sessionKey);
      expect(fallbackSessionId).toMatch(/^gateway-fallback-/);
      expect(fallbackSessionId).not.toBe("locked-session");
      expect(fallbackSessionKey).toBe(`agent:main:explicit:${fallbackSessionId}`);
      expect(fallbackOpts.runId).toBe(fallbackSessionId);
      const resultMetaOverrides = requireRecord(
        fallbackOpts.resultMetaOverrides,
        "fallback metadata",
      );
      expect(resultMetaOverrides.transport).toBe("embedded");
      expect(resultMetaOverrides.fallbackFrom).toBe("gateway");
      expect(resultMetaOverrides.fallbackReason).toBe("gateway_timeout");
      expect(resultMetaOverrides.fallbackSessionId).toBe(fallbackSessionId);
      expect(resultMetaOverrides.fallbackSessionKey).toBe(fallbackSessionKey);
      expect(
        mockMessages(runtime.error).some((message) =>
          message.includes("Gateway agent timed out; running embedded agent with fresh session"),
        ),
      ).toBe(true);
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("uses the explicit session key agent for timeout fallback sessions", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(createGatewayTimeoutError());
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", sessionKey: "agent:ops:incident-42" }, runtime);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const fallbackOpts = requireFirstCallArg(agentCommand, "embedded agent") as {
        sessionId?: string;
        sessionKey?: string;
      };
      expect(fallbackOpts.sessionId).toMatch(/^gateway-fallback-/);
      expect(fallbackOpts.sessionKey).toBe(`agent:ops:explicit:${fallbackOpts.sessionId}`);
    });
  });

  it("uses the default-scoped legacy session key agent for timeout fallback sessions", async () => {
    await withTempStore(
      async () => {
        callGateway.mockRejectedValue(createGatewayTimeoutError());
        mockLocalAgentReply();

        await agentCliCommand({ message: "hi", sessionKey: "incident-42" }, runtime);

        expect(agentCommand).toHaveBeenCalledTimes(1);
        const fallbackOpts = requireFirstCallArg(agentCommand, "embedded agent") as {
          sessionId?: string;
          sessionKey?: string;
        };
        expect(fallbackOpts.sessionId).toMatch(/^gateway-fallback-/);
        expect(fallbackOpts.sessionKey).toBe(`agent:ops:explicit:${fallbackOpts.sessionId}`);
        expect(loadConfig.mock.calls).toEqual([[], []]);
      },
      { agents: { list: [{ id: "ops", default: true }, { id: "main" }] } },
    );
  });

  it("uses the default agent for timeout fallback with unscoped global session keys", async () => {
    await withTempStore(
      async () => {
        callGateway.mockRejectedValue(createGatewayTimeoutError());
        mockLocalAgentReply();

        await agentCliCommand({ message: "hi", sessionKey: "global" }, runtime);

        expect(agentCommand).toHaveBeenCalledTimes(1);
        const fallbackOpts = requireFirstCallArg(agentCommand, "embedded agent") as {
          sessionId?: string;
          sessionKey?: string;
        };
        expect(fallbackOpts.sessionId).toMatch(/^gateway-fallback-/);
        expect(fallbackOpts.sessionKey).toBe(`agent:ops:explicit:${fallbackOpts.sessionId}`);
      },
      { agents: { list: [{ id: "ops", default: true }, { id: "main" }] } },
    );
  });

  it("keeps timeout fallback from replacing the routed conversation session key", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(createGatewayTimeoutError());
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "hi",
          to: "+1555",
        },
        runtime,
      );

      const fallbackOpts = requireFirstCallArg(agentCommand, "embedded agent") as {
        sessionId?: string;
        sessionKey?: string;
        to?: string;
      };
      expect(fallbackOpts.to).toBe("+1555");
      expect(fallbackOpts.sessionId).toMatch(/^gateway-fallback-/);
      expect(fallbackOpts.sessionKey).toBe(`agent:main:explicit:${fallbackOpts.sessionId}`);
      expect(fallbackOpts.sessionKey).not.toBe("agent:main:+1555");
    });
  });

  it("passes fallback metadata into JSON embedded fallback output", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(createGatewayClosedError());
      agentCommand.mockImplementationOnce(async (opts, rt) => {
        expect(loggingState.forceConsoleToStderr).toBe(true);
        const resultMetaOverrides = (
          opts as {
            resultMetaOverrides?: { transport?: string; fallbackFrom?: string };
          }
        ).resultMetaOverrides;
        const meta = {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
          ...resultMetaOverrides,
        };
        rt?.log?.(
          JSON.stringify(
            {
              payloads: [{ text: "local" }],
              meta,
            },
            null,
            2,
          ),
        );
        return {
          payloads: [{ text: "local" }],
          meta,
        } as unknown as Awaited<ReturnType<typeof AgentCommand>>;
      });

      const result = await agentCliCommand({ message: "hi", to: "+1555", json: true }, jsonRuntime);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const fallbackOpts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      const resultMetaOverrides = requireRecord(
        fallbackOpts.resultMetaOverrides,
        "fallback metadata",
      );
      expect(resultMetaOverrides.transport).toBe("embedded");
      expect(resultMetaOverrides.fallbackFrom).toBe("gateway");
      expect(
        mockMessages(jsonRuntime.error).some((message) =>
          message.includes("EMBEDDED FALLBACK: Gateway agent failed"),
        ),
      ).toBe(true);
      expect(loggingState.forceConsoleToStderr).toBe(true);
      expect(jsonRuntime.log).toHaveBeenCalledTimes(1);
      const jsonPayload = requireFirstCallArg(jsonRuntime.log, "json runtime log");
      const payload = requireRecord(JSON.parse(String(jsonPayload)), "json log payload");
      expect(payload.payloads).toEqual([{ text: "local" }]);
      const payloadMeta = requireRecord(payload.meta, "json log metadata");
      expect(payloadMeta.durationMs).toBe(1);
      expect(payloadMeta.transport).toBe("embedded");
      expect(payloadMeta.fallbackFrom).toBe("gateway");
      const resultRecord = requireRecord(result, "command result");
      const resultMeta = requireRecord(resultRecord.meta, "command result metadata");
      expect(resultMeta.durationMs).toBe(1);
      expect(resultMeta.transport).toBe("embedded");
      expect(resultMeta.fallbackFrom).toBe("gateway");
    });
  });

  it("skips gateway when --local is set", async () => {
    await withTempStore(async () => {
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "hi",
          to: "+1555",
          local: true,
        },
        runtime,
      );

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const localOpts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      expect(localOpts.cleanupBundleMcpOnRunEnd).toBe(true);
      expect(localOpts.cleanupCliLiveSessionOnRunEnd).toBe(true);
      expect(localOpts.oneShotCliRun).toBe(true);
      expect(localOpts).not.toHaveProperty("resultMetaOverrides");
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("preserves inline message whitespace for local embedded runs", async () => {
    await withTempStore(async () => {
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "  keep spaces  ",
          to: "+1555",
          local: true,
        },
        runtime,
      );

      const localOpts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      expect(localOpts.message).toBe("  keep spaces  ");
    });
  });

  it("passes explicit session keys to local embedded runs", async () => {
    await withTempStore(async () => {
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "hi",
          sessionKey: "agent:main:incident-42",
          local: true,
        },
        runtime,
      );

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const localOpts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      expect(localOpts.sessionKey).toBe("agent:main:incident-42");
    });
  });

  it("propagates harness-owned session rejection from --local dispatch", async () => {
    await withTempStore(async () => {
      const sessionKey = "agent:main:harness:codex:supervision:missing-local";
      agentCommand.mockRejectedValueOnce(new Error(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE));

      await expect(
        agentCliCommand({ message: "hi", sessionKey, local: true }, runtime),
      ).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledOnce();
      expect(
        requireRecord(requireFirstCallArg(agentCommand, "embedded agent"), "options"),
      ).toMatchObject({ sessionKey });
    });
  });

  it("scopes legacy explicit session keys before local embedded runs", async () => {
    await withTempStore(async () => {
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "hi",
          agent: "ops",
          sessionKey: "incident-42",
          local: true,
        },
        runtime,
      );

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const localOpts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      expect(localOpts.agentId).toBe("ops");
      expect(localOpts.sessionKey).toBe("agent:ops:incident-42");
      expect(loadRuntimeConfig).toHaveBeenCalledWith();
    });
  });

  it("rejects malformed agent-prefixed session keys before gateway or local fallback", async () => {
    await withTempStore(async () => {
      await expect(
        agentCliCommand({ message: "hi", sessionKey: "agent:main" }, runtime),
      ).rejects.toThrow(
        'Invalid --session-key "agent:main". Agent-prefixed session keys must use agent:<agent-id>:<session-key>.',
      );

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it("rejects explicit session keys whose agent does not match --agent", async () => {
    await withTempStore(async () => {
      await expect(
        agentCliCommand(
          { message: "hi", agent: "ops", sessionKey: "agent:main:incident-42" },
          runtime,
        ),
      ).rejects.toThrow('Agent id "ops" does not match session key agent "main".');

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it("forces bundle MCP cleanup on embedded fallback", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(createGatewayClosedError());
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const fallbackOpts = requireRecord(
        requireFirstCallArg(agentCommand, "embedded agent"),
        "embedded agent options",
      );
      expect(fallbackOpts.cleanupBundleMcpOnRunEnd).toBe(true);
      expect(fallbackOpts.cleanupCliLiveSessionOnRunEnd).toBe(true);
      expect(fallbackOpts.oneShotCliRun).toBe(false);
    });
  });

  for (const message of [
    "/compact",
    "/compact Keep recent decisions.",
    "/compact:Keep recent decisions.",
    "/COMPACT",
    "  /Compact  ",
  ]) {
    it(`rejects ${JSON.stringify(message)} from the CLI before any gateway or embedded turn`, async () => {
      await withTempStore(async () => {
        callGateway.mockRejectedValue(createGatewayTimeoutError());

        await agentCliCommand(
          { message, sessionId: "locked-session", runId: "locked-run", timeout: "0" },
          runtime,
        );
      });

      // The slash-command handler rejects CLI senders, so a /compact turn would
      // otherwise fall through to a normal turn and exit 0 without compacting.
      // It must fail loudly before touching the gateway or a fresh embedded session.
      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      const errorMessages = mockMessages(runtime.error);
      expect(errorMessages.some((m) => m.includes("openclaw sessions compact"))).toBe(true);
      expect(errorMessages.some((m) => m.includes("EMBEDDED FALLBACK"))).toBe(false);
    });
  }

  it("rejects /compact from --message-file before any gateway or embedded turn", async () => {
    await withTempStore(async ({ dir }) => {
      const messageFile = path.join(dir, "compact.md");
      fs.writeFileSync(messageFile, "/compact:Keep recent decisions.", "utf8");
      callGateway.mockRejectedValue(createGatewayTimeoutError());

      await agentCliCommand(
        { messageFile, sessionId: "locked-session", runId: "locked-run", timeout: "0" },
        runtime,
      );
    });

    expect(callGateway).not.toHaveBeenCalled();
    expect(agentCommand).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    const errorMessages = mockMessages(runtime.error);
    expect(errorMessages.some((m) => m.includes("openclaw sessions compact"))).toBe(true);
    expect(errorMessages.some((m) => m.includes("EMBEDDED FALLBACK"))).toBe(false);
  });

  it("does not mistake a /compacting-prefixed message for the /compact control command", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand(
        { message: "/compacting the report, please", to: "+15555550123", timeout: "0" },
        runtime,
      );
    });

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(1);
  });
});
