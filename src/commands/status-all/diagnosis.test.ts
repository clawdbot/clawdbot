import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";

type GatewayLogPaths = {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
};

const restartLogMocks = vi.hoisted(() => ({
  resolveGatewayLogPaths: vi.fn<() => GatewayLogPaths>(() => {
    throw new Error("skip log tail");
  }),
  resolveGatewayRestartLogPath: vi.fn<() => string>(() => "/tmp/gateway-restart.log"),
}));

const gatewayMocks = vi.hoisted(() => ({
  readFileTailLines: vi.fn<(filePath: string, maxLines: number) => Promise<string[]>>(
    async () => [],
  ),
  summarizeLogTail: vi.fn<(lines: string[], opts?: { maxLines?: number }) => string[]>(
    (lines) => lines,
  ),
}));

vi.mock("../../daemon/restart-logs.js", () => ({
  resolveGatewayLogPaths: restartLogMocks.resolveGatewayLogPaths,
  resolveGatewayRestartLogPath: restartLogMocks.resolveGatewayRestartLogPath,
}));

vi.mock("./gateway.js", () => ({
  readFileTailLines: gatewayMocks.readFileTailLines,
  summarizeLogTail: gatewayMocks.summarizeLogTail,
}));

import { appendStatusAllDiagnosis } from "./diagnosis.js";

type DiagnosisParams = Parameters<typeof appendStatusAllDiagnosis>[0];

function createProgressReporter(): ProgressReporter {
  return {
    setLabel: () => {},
    setPercent: () => {},
    tick: () => {},
    done: () => {},
  };
}

function createBaseParams(
  listeners: NonNullable<DiagnosisParams["portUsage"]>["listeners"],
): DiagnosisParams {
  return {
    lines: [] as string[],
    progress: createProgressReporter(),
    muted: (text: string) => text,
    ok: (text: string) => text,
    warn: (text: string) => text,
    fail: (text: string) => text,
    connectionDetailsForReport: "ws://127.0.0.1:18789",
    snap: null,
    remoteUrlMissing: false,
    secretDiagnostics: [],
    sentinel: null,
    lastErr: null,
    port: 18789,
    portUsage: { port: 18789, status: "busy", listeners, hints: [] },
    tailscaleMode: "off",
    tailscale: {
      backendState: null,
      dnsName: null,
      ips: [],
      error: null,
    },
    tailscaleHttpsUrl: null,
    skillStatus: null,
    pluginCompatibility: [],
    channelsStatus: null,
    channelIssues: [],
    gatewayReachable: false,
    health: null,
    nodeOnlyGateway: null,
  };
}

describe("status-all diagnosis port checks", () => {
  beforeEach(() => {
    restartLogMocks.resolveGatewayLogPaths.mockImplementation(() => {
      throw new Error("skip log tail");
    });
    restartLogMocks.resolveGatewayRestartLogPath.mockReturnValue("/tmp/gateway-restart.log");
    gatewayMocks.readFileTailLines.mockResolvedValue([]);
    gatewayMocks.summarizeLogTail.mockImplementation((lines: string[]) => lines);
  });

  it("labels OpenClaw Tailscale exposure separately from daemon state", async () => {
    const params = createBaseParams([]);
    params.tailscale.backendState = "Running";
    params.tailscale.dnsName = "box.tail.ts.net";

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Tailscale exposure: off · daemon Running · box.tail.ts.net");
    expect(output).not.toContain("Tailscale: off");
  });

  it("treats same-process dual-stack loopback listeners as healthy", async () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      { pid: 5001, commandLine: "openclaw-gateway", address: "[::1]:18789" },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Port 18789");
    expect(output).toContain("Detected dual-stack loopback listeners");
    expect(output).not.toContain("Port 18789 is already in use.");
  });

  it("treats a single wildcard Gateway listener as healthy", async () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "openclaw-gateway", address: "0.0.0.0:18789" },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Port 18789");
    expect(output).toContain("Detected OpenClaw Gateway listener on the configured port.");
    expect(output).not.toContain("Port 18789 is already in use.");
  });

  it("keeps warning for multi-process listener conflicts", async () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      { pid: 5002, commandLine: "openclaw-gateway", address: "[::1]:18789" },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("! Port 18789");
    expect(output).toContain("Port 18789 is already in use.");
  });

  it("avoids unreachable gateway diagnosis in node-only mode", async () => {
    const params = createBaseParams([]);
    params.connectionDetailsForReport = [
      "Node-only mode detected",
      "Local gateway: not expected on this machine",
      "Remote gateway target: gateway.example.com:19000",
    ].join("\n");
    params.tailscale.backendState = "Running";
    params.health = undefined;
    params.nodeOnlyGateway = {
      gatewayTarget: "gateway.example.com:19000",
      gatewayValue: "node → gateway.example.com:19000 · no local gateway",
      connectionDetails: [
        "Node-only mode detected",
        "Local gateway: not expected on this machine",
        "Remote gateway target: gateway.example.com:19000",
        "Inspect the remote gateway host for live channel and health details.",
      ].join("\n"),
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("Node-only mode detected");
    expect(output).toContain(
      "Channel issues skipped (node-only mode; query gateway.example.com:19000)",
    );
    expect(output).not.toContain("Channel issues skipped (gateway unreachable)");
    expect(output).not.toContain("Gateway health:");
  });

  it("does not read or display stale stderr tails on Darwin", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      restartLogMocks.resolveGatewayLogPaths.mockReturnValue({
        logDir: "/tmp/openclaw/logs",
        stdoutPath: "/tmp/openclaw/logs/gateway.log",
        stderrPath: "/tmp/openclaw/logs/gateway.err.log",
      });
      restartLogMocks.resolveGatewayRestartLogPath.mockReturnValue(
        "/tmp/openclaw/logs/gateway-restart.log",
      );
      gatewayMocks.readFileTailLines.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith("gateway.log")) {
          return ["gateway stdout current"];
        }
        if (filePath.endsWith("gateway.err.log")) {
          return ["failed to bind gateway socket stale"];
        }
        return [];
      });
      const params = createBaseParams([]);

      await appendStatusAllDiagnosis(params);

      const output = params.lines.join("\n");
      expect(gatewayMocks.readFileTailLines).not.toHaveBeenCalledWith(
        "/tmp/openclaw/logs/gateway.err.log",
        40,
      );
      expect(output).toContain("# stdout: /tmp/openclaw/logs/gateway.log");
      expect(output).toContain("gateway stdout current");
      expect(output).not.toContain("# stderr:");
      expect(output).not.toContain("failed to bind gateway socket stale");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
