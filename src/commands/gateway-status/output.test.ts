import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { GatewayStatusProbedTarget } from "./probe-run.js";

const mocks = vi.hoisted(() => ({
  writeRuntimeJson: vi.fn(),
}));

vi.mock("../../runtime.js", () => ({
  writeRuntimeJson: (...args: unknown[]) => mocks.writeRuntimeJson(...args),
}));

vi.mock("../../terminal/theme.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../terminal/theme.js")>("../../terminal/theme.js");
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

const { buildGatewayStatusWarnings, writeGatewayStatusJson, writeGatewayStatusText } =
  await import("./output.js");

function createRuntimeCapture(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  } as unknown as RuntimeEnv;
}

function requireRuntimeJsonPayload(runtime: RuntimeEnv, index = 0): unknown {
  const call = mocks.writeRuntimeJson.mock.calls[index];
  if (!call) {
    throw new Error(`expected writeRuntimeJson call ${index}`);
  }
  expect(call[0]).toBe(runtime);
  return call[1];
}

function createProbe(
  capability: GatewayProbeResult["auth"]["capability"],
  params: {
    ok: boolean;
    connectLatencyMs: number | null;
    error?: string | null;
  },
): GatewayProbeResult {
  return {
    ok: params.ok,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: params.connectLatencyMs,
    error: params.error ?? null,
    close: null,
    auth: {
      role: "operator",
      scopes: capability === "admin_capable" ? ["operator.admin"] : ["operator.read"],
      capability,
    },
    server: {
      version: "2026.4.24",
      connId: "conn-test",
    },
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

function createTarget(id: string, probe: GatewayProbeResult): GatewayStatusProbedTarget {
  return {
    target: {
      id,
      kind: "explicit",
      url: probe.url,
      active: true,
    },
    probe,
    configSummary: null,
    self: null,
    authDiagnostics: [],
  };
}

describe("gateway status output", () => {
  beforeEach(() => {
    mocks.writeRuntimeJson.mockReset();
  });

  it("warns with diagnostic next steps when no probes or Bonjour discovery find a gateway", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [
        createTarget(
          "localLoopback",
          createProbe("unknown", {
            ok: false,
            connectLatencyMs: null,
            error: "connection refused",
          }),
        ),
      ],
      sshTarget: null,
      sshTunnelStarted: false,
      sshTunnelError: null,
      discoveryCount: 0,
    });

    expect(warnings.find((entry) => entry.code === "no_gateway_reachable")).toStrictEqual({
      code: "no_gateway_reachable",
      message:
        "No gateway answered any probe and Bonjour discovery returned no local gateways. Run `openclaw gateway status --deep --require-rpc` to inspect service state, config paths, listener owners, and logs; include `ss -ltnp` or `lsof -nP -iTCP:<port> -sTCP:LISTEN` for the configured port when filing a report.",
      targetIds: ["localLoopback"],
    });
  });

  it("derives summary capability from reachable probes only in json output", () => {
    const runtime = createRuntimeCapture();
    writeGatewayStatusJson({
      runtime,
      startedAt: Date.now() - 50,
      overallTimeoutMs: 5_000,
      discoveryTimeoutMs: 500,
      network: {
        localLoopbackUrl: "ws://127.0.0.1:18789",
        localTailnetUrl: null,
        tailnetIPv4: null,
      },
      discovery: [],
      probed: [
        createTarget(
          "unreachable-before-connect",
          createProbe("admin_capable", {
            ok: false,
            connectLatencyMs: null,
            error: "timeout",
          }),
        ),
        createTarget(
          "reachable-read",
          createProbe("read_only", {
            ok: true,
            connectLatencyMs: 20,
          }),
        ),
      ],
      warnings: [],
      primaryTargetId: "reachable-read",
    });

    expect(mocks.writeRuntimeJson).toHaveBeenCalledOnce();
    const payload = requireRuntimeJsonPayload(runtime) as { ok?: unknown; capability?: unknown };
    expect(payload?.ok).toBe(true);
    expect(payload?.capability).toBe("read_only");
  });

  it("derives summary capability from reachable probes only in text output", () => {
    const runtime = createRuntimeCapture();
    writeGatewayStatusText({
      runtime,
      rich: false,
      overallTimeoutMs: 5_000,
      discovery: [],
      probed: [
        createTarget(
          "unreachable-before-connect",
          createProbe("admin_capable", {
            ok: false,
            connectLatencyMs: null,
            error: "timeout",
          }),
        ),
        createTarget(
          "reachable-read",
          createProbe("read_only", {
            ok: false,
            connectLatencyMs: 20,
            error: "missing scope: operator.read",
          }),
        ),
      ],
      warnings: [],
    });

    expect(runtime.log).toHaveBeenCalledWith("Capability: read-only");
  });

  it("reports post-connect detail failures as reachable but degraded in json output", () => {
    const runtime = createRuntimeCapture();
    writeGatewayStatusJson({
      runtime,
      startedAt: Date.now() - 50,
      overallTimeoutMs: 5_000,
      discoveryTimeoutMs: 500,
      network: {
        localLoopbackUrl: "ws://127.0.0.1:18789",
        localTailnetUrl: null,
        tailnetIPv4: null,
      },
      discovery: [],
      probed: [
        createTarget(
          "detail-timeout",
          createProbe("read_only", {
            ok: false,
            connectLatencyMs: 40,
            error: "timeout",
          }),
        ),
      ],
      warnings: [
        {
          code: "probe_detail_failed",
          message:
            "Gateway accepted the WebSocket connection, but follow-up read diagnostics failed: timeout",
          targetIds: ["detail-timeout"],
        },
      ],
      primaryTargetId: "detail-timeout",
    });

    expect(mocks.writeRuntimeJson).toHaveBeenCalledOnce();
    const payload = requireRuntimeJsonPayload(runtime);
    expect(payload).toStrictEqual({
      ok: true,
      degraded: true,
      capability: "read_only",
      ts: expect.any(Number),
      durationMs: expect.any(Number),
      timeoutMs: 5_000,
      primaryTargetId: "detail-timeout",
      warnings: [
        {
          code: "probe_detail_failed",
          message:
            "Gateway accepted the WebSocket connection, but follow-up read diagnostics failed: timeout",
          targetIds: ["detail-timeout"],
        },
      ],
      network: {
        localLoopbackUrl: "ws://127.0.0.1:18789",
        localTailnetUrl: null,
        tailnetIPv4: null,
      },
      discovery: {
        timeoutMs: 500,
        count: 0,
        beacons: [],
      },
      targets: [
        {
          id: "detail-timeout",
          kind: "explicit",
          url: "ws://127.0.0.1:18789",
          active: true,
          tunnel: null,
          connect: {
            ok: true,
            rpcOk: false,
            scopeLimited: false,
            latencyMs: 40,
            error: "timeout",
            close: null,
          },
          auth: {
            role: "operator",
            scopes: ["operator.read"],
            capability: "read_only",
          },
          self: null,
          config: null,
          health: null,
          summary: null,
          presence: null,
        },
      ],
    });
  });
});
