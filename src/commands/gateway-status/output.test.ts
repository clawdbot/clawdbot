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

    const warning = warnings.find((entry) => entry.code === "no_gateway_reachable");
    expect(warning?.message).toContain("openclaw gateway status --deep --require-rpc");
    expect(warning?.targetIds).toStrictEqual(["localLoopback"]);
    expect(warning?.message).toContain("lsof -nP -iTCP:<port>");
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
    expect(mocks.writeRuntimeJson.mock.calls[0]?.[0]).toBe(runtime);
    const payload = mocks.writeRuntimeJson.mock.calls[0]?.[1] as
      | { ok?: unknown; capability?: unknown }
      | undefined;
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
    expect(mocks.writeRuntimeJson.mock.calls[0]?.[0]).toBe(runtime);
    const payload = mocks.writeRuntimeJson.mock.calls[0]?.[1] as
      | {
          ok?: unknown;
          degraded?: unknown;
          primaryTargetId?: unknown;
          targets?: Array<{ connect?: { ok?: unknown; rpcOk?: unknown; error?: unknown } }>;
        }
      | undefined;
    expect(payload?.ok).toBe(true);
    expect(payload?.degraded).toBe(true);
    expect(payload?.primaryTargetId).toBe("detail-timeout");
    expect(payload?.targets).toHaveLength(1);
    expect(payload?.targets?.[0]?.connect?.ok).toBe(true);
    expect(payload?.targets?.[0]?.connect?.rpcOk).toBe(false);
    expect(payload?.targets?.[0]?.connect?.error).toBe("timeout");
  });
});
