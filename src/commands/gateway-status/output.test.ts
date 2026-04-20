import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { GatewayStatusProbedTarget } from "./probe-run.js";

const writeRuntimeJson = vi.fn();

vi.mock("../../runtime.js", () => ({
  writeRuntimeJson: (...args: unknown[]) => writeRuntimeJson(...args),
}));

vi.mock("../../terminal/theme.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../terminal/theme.js")>("../../terminal/theme.js");
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

const { writeGatewayStatusJson, writeGatewayStatusText } = await import("./output.js");

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
    writeRuntimeJson.mockReset();
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
          "unreachable-admin",
          createProbe("admin_capable", {
            ok: false,
            connectLatencyMs: 40,
            error: "unknown method: status",
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

    expect(writeRuntimeJson).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        ok: true,
        capability: "read_only",
      }),
    );
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
          "unreachable-admin",
          createProbe("admin_capable", {
            ok: false,
            connectLatencyMs: 40,
            error: "unknown method: status",
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
});
