import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";
import { formatHealthCheckFailure } from "./health-format.js";
import type { HealthSummary } from "./health.js";
import { formatHealthChannelLines, healthCommand } from "./health.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const defaultSessions: HealthSummary["sessions"] = {
  path: "/tmp/sessions.json",
  count: 0,
  recent: [],
};

const createMainAgentSummary = (sessions = defaultSessions) => ({
  agentId: "main",
  isDefault: true,
  heartbeat: {
    enabled: true,
    every: "1m",
    everyMs: 60_000,
    prompt: "hi",
    target: "last",
    ackMaxChars: 160,
  },
  sessions,
});

const createHealthSummary = (params: {
  channels: HealthSummary["channels"];
  channelOrder: string[];
  channelLabels: HealthSummary["channelLabels"];
  sessions?: HealthSummary["sessions"];
}): HealthSummary => {
  const sessions = params.sessions ?? defaultSessions;
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 5,
    channels: params.channels,
    channelOrder: params.channelOrder,
    channelLabels: params.channelLabels,
    heartbeatSeconds: 60,
    defaultAgentId: "main",
    agents: [createMainAgentSummary(sessions)],
    sessions,
  };
};

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

function requireFirstRuntimeLog(): string {
  const [call] = runtime.log.mock.calls;
  if (!call) {
    throw new Error("expected health command log output");
  }
  const [message] = call;
  if (message === undefined) {
    throw new Error("expected health command log output");
  }
  return String(message);
}

function requireFirstGatewayRequest(): Record<string, unknown> {
  const [call] = callGatewayMock.mock.calls;
  if (!call) {
    throw new Error("expected gateway call");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected gateway request");
  }
  return request as Record<string, unknown>;
}

describe("healthCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("outputs JSON from gateway", async () => {
    const agentSessions = {
      path: "/tmp/sessions.json",
      count: 1,
      recent: [{ key: "+1555", updatedAt: Date.now(), age: 0 }],
    };
    const snapshot = createHealthSummary({
      channels: {
        whatsapp: { accountId: "default", linked: true, authAgeMs: 5000 },
        telegram: {
          accountId: "default",
          configured: true,
          probe: { ok: true, elapsedMs: 1 },
        },
        discord: { accountId: "default", configured: false },
      },
      channelOrder: ["whatsapp", "telegram", "discord"],
      channelLabels: {
        whatsapp: "WhatsApp",
        telegram: "Telegram",
        discord: "Discord",
      },
      sessions: agentSessions,
    });
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: true, timeoutMs: 5000, config: {} }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    const parsed = JSON.parse(requireFirstRuntimeLog()) as HealthSummary;
    expect(parsed.channels.whatsapp?.linked).toBe(true);
    expect(parsed.channels.telegram?.configured).toBe(true);
    expect(parsed.sessions.count).toBe(1);
  });

  it("passes explicit gateway credentials through to the gateway call", async () => {
    const snapshot = createHealthSummary({
      channels: {},
      channelOrder: [],
      channelLabels: {},
    });
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand(
      {
        json: true,
        timeoutMs: 5000,
        config: {},
        token: "setup-token",
        password: "setup-password",
      },
      runtime as never,
    );

    expect(callGatewayMock).toHaveBeenCalledOnce();
    const gatewayRequest = requireFirstGatewayRequest();
    expect(gatewayRequest.method).toBe("health");
    expect(gatewayRequest.token).toBe("setup-token");
    expect(gatewayRequest.password).toBe("setup-password");
  });

  it("prints degraded model-pricing health without failing the command", async () => {
    const snapshot = createHealthSummary({
      channels: {},
      channelOrder: [],
      channelLabels: {},
    });
    snapshot.modelPricing = {
      state: "degraded",
      sources: [
        {
          source: "openrouter",
          state: "degraded",
          lastFailureAt: Date.now(),
          detail: "OpenRouter pricing fetch failed: TypeError: fetch failed",
        },
      ],
      detail: "OpenRouter pricing fetch failed: TypeError: fetch failed",
      lastFailureAt: Date.now(),
    };
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: false, timeoutMs: 5000, config: {} }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(stripAnsi(runtime.log.mock.calls.flat().join("\n"))).toContain(
      "Model pricing: warning (optional pricing refresh degraded) (OpenRouter pricing fetch failed: TypeError: fetch failed)",
    );
  });

  it("formats per-account probe timings", () => {
    const summary = createHealthSummary({
      channels: {
        telegram: {
          accountId: "main",
          configured: true,
          probe: { ok: true, elapsedMs: 196, bot: { username: "pinguini_ugi_bot" } },
          accounts: {
            main: {
              accountId: "main",
              configured: true,
              probe: { ok: true, elapsedMs: 196, bot: { username: "pinguini_ugi_bot" } },
            },
            flurry: {
              accountId: "flurry",
              configured: true,
              probe: { ok: true, elapsedMs: 190, bot: { username: "flurry_ugi_bot" } },
            },
            poe: {
              accountId: "poe",
              configured: true,
              probe: { ok: true, elapsedMs: 188, bot: { username: "poe_ugi_bot" } },
            },
          },
        },
      },
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
    });

    const lines = formatHealthChannelLines(summary, { accountMode: "all" });
    expect(lines).toStrictEqual([
      "Telegram: ok (@pinguini_ugi_bot:main:196ms, @flurry_ugi_bot:flurry:190ms, @poe_ugi_bot:poe:188ms)",
    ]);
  });

  it("formats statusState without inferring from linked", () => {
    const summary = createHealthSummary({
      channels: {
        whatsapp: {
          accountId: "default",
          statusState: "unstable",
          configured: true,
        },
      },
      channelOrder: ["whatsapp"],
      channelLabels: { whatsapp: "WhatsApp" },
    });

    const lines = formatHealthChannelLines(summary, { accountMode: "default" });
    expect(lines).toStrictEqual(["WhatsApp: auth stabilizing"]);
  });

  it("formats iMessage probe failures as failed health lines", () => {
    const summary = createHealthSummary({
      channels: {
        imessage: {
          accountId: "default",
          configured: true,
          probe: {
            ok: false,
            error:
              "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
          },
        },
      },
      channelOrder: ["imessage"],
      channelLabels: { imessage: "iMessage" },
    });

    const lines = formatHealthChannelLines(summary, { accountMode: "default" });
    expect(lines).toContain(
      "iMessage: failed (unknown) - imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    );
  });
});

describe("formatHealthCheckFailure", () => {
  it("keeps non-rich output stable", () => {
    const err = new Error("gateway closed (1006 abnormal closure): no close reason");
    expect(formatHealthCheckFailure(err, { rich: false })).toBe(
      `Health check failed: ${String(err)}`,
    );
  });

  it("formats gateway connection details as indented key/value lines", () => {
    const err = new Error(
      [
        "gateway closed (1006 abnormal closure (no close frame)): no close reason",
        "Gateway target: ws://127.0.0.1:19001",
        "Source: local loopback",
        "Config: /Users/steipete/.openclaw-dev/openclaw.json",
        "Bind: loopback",
      ].join("\n"),
    );

    expect(stripAnsi(formatHealthCheckFailure(err, { rich: true }))).toBe(
      [
        "Health check failed: gateway closed (1006 abnormal closure (no close frame)): no close reason",
        "  Gateway target: ws://127.0.0.1:19001",
        "  Source: local loopback",
        "  Config: /Users/steipete/.openclaw-dev/openclaw.json",
        "  Bind: loopback",
      ].join("\n"),
    );
  });
});
