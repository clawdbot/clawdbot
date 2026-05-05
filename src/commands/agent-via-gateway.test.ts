import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loggingState } from "../logging/state.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import type { agentCommand as AgentCommand } from "./agent.js";

const loadConfig = vi.hoisted(() => vi.fn());
const callGateway = vi.hoisted(() => vi.fn());
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
  loadConfig.mockReturnValue({
    agents: {
      defaults: {
        timeoutSeconds: 600,
        ...overrides?.agents?.defaults,
      },
    },
    session: {
      store: storePath,
      mainKey: "main",
      ...overrides?.session,
    },
    gateway: overrides?.gateway,
  });
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

vi.mock("../config/config.js", () => ({ getRuntimeConfig: loadConfig, loadConfig }));
vi.mock("../gateway/call.js", () => ({
  callGateway,
  isGatewayTransportError,
  randomIdempotencyKey: () => "idem-1",
}));
vi.mock("./agent.js", () => ({ agentCommand }));

let originalForceConsoleToStderr = false;

beforeEach(() => {
  vi.clearAllMocks();
  originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = false;
});

afterEach(() => {
  loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
});

describe("agentCliCommand", () => {
  it("uses a timer-safe max gateway timeout when --timeout is 0", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555", timeout: "0" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = callGateway.mock.calls[0]?.[0] as { timeoutMs?: number };
      expect(request.timeoutMs).toBe(2_147_000_000);
    });
  });

  it("uses gateway by default", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(callGateway.mock.calls[0]?.[0]?.params).not.toHaveProperty("cleanupBundleMcpOnRunEnd");
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("hello");
    });
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

  it("passes model overrides through gateway requests", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555", model: "ollama/qwen3.5:9b" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(callGateway.mock.calls[0]?.[0]).toMatchObject({
        params: {
          model: "ollama/qwen3.5:9b",
        },
      });
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

  it("falls back to embedded agent when gateway fails", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(createGatewayClosedError());
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(agentCommand.mock.calls[0]?.[0]).toMatchObject({
        resultMetaOverrides: {
          transport: "embedded",
          fallbackFrom: "gateway",
        },
      });
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("EMBEDDED FALLBACK: Gateway agent failed"),
      );
      expect(runtime.log).toHaveBeenCalledWith("local");
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
      expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("EMBEDDED FALLBACK"));
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
      const fallbackOpts = agentCommand.mock.calls[0]?.[0] as {
        sessionId?: string;
        sessionKey?: string;
        runId?: string;
        resultMetaOverrides?: unknown;
      };
      expect(fallbackOpts.sessionId).toMatch(/^gateway-fallback-/);
      expect(fallbackOpts.sessionId).not.toBe("locked-session");
      expect(fallbackOpts.sessionKey).toBe(`agent:main:explicit:${fallbackOpts.sessionId}`);
      expect(fallbackOpts.runId).toBe(fallbackOpts.sessionId);
      expect(fallbackOpts.resultMetaOverrides).toMatchObject({
        transport: "embedded",
        fallbackFrom: "gateway",
        fallbackReason: "gateway_timeout",
        fallbackSessionId: fallbackOpts.sessionId,
        fallbackSessionKey: fallbackOpts.sessionKey,
      });
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Gateway agent timed out; running embedded agent with fresh session",
        ),
      );
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
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

      const fallbackOpts = agentCommand.mock.calls[0]?.[0] as {
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
      expect(agentCommand.mock.calls[0]?.[0]).toMatchObject({
        resultMetaOverrides: {
          transport: "embedded",
          fallbackFrom: "gateway",
        },
      });
      expect(jsonRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("EMBEDDED FALLBACK: Gateway agent failed"),
      );
      expect(loggingState.forceConsoleToStderr).toBe(true);
      expect(jsonRuntime.log).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(jsonRuntime.log.mock.calls[0]?.[0]));
      expect(payload).toMatchObject({
        payloads: [{ text: "local" }],
        meta: {
          durationMs: 1,
          transport: "embedded",
          fallbackFrom: "gateway",
        },
      });
      expect(result).toMatchObject({
        meta: {
          durationMs: 1,
          transport: "embedded",
          fallbackFrom: "gateway",
        },
      });
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
      expect(agentCommand.mock.calls[0]?.[0]).toMatchObject({
        cleanupBundleMcpOnRunEnd: true,
        cleanupCliLiveSessionOnRunEnd: true,
      });
      expect(agentCommand.mock.calls[0]?.[0]).not.toHaveProperty("resultMetaOverrides");
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("forces bundle MCP cleanup on embedded fallback", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(createGatewayClosedError());
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(agentCommand.mock.calls[0]?.[0]).toMatchObject({
        cleanupBundleMcpOnRunEnd: true,
        cleanupCliLiveSessionOnRunEnd: true,
      });
    });
  });
});
