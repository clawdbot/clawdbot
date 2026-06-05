// Status-all diagnosis tests cover port checks, restart logs, config issues, and safe diagnostic output.
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
  resolveGatewaySupervisorLogPaths: vi.fn<() => GatewayLogPaths>(() => {
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
  resolveGatewaySupervisorLogPaths: restartLogMocks.resolveGatewaySupervisorLogPaths,
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
    deliveryDiagnostics: null,
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
    restartLogMocks.resolveGatewaySupervisorLogPaths.mockImplementation(() => {
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
    expect(output).toContain("2 OpenClaw gateway processes appear to be listening on port 18789");
    expect(output).toContain("Port 18789 is already in use.");
  });

  it("adds direct update restart guidance for failed update sentinels", async () => {
    const params = createBaseParams([]);
    params.sentinel = {
      payload: {
        kind: "update",
        status: "error",
        ts: Date.now() - 60_000,
        stats: {
          mode: "npm",
          reason: "managed-service-handoff-failed",
          steps: [],
        },
      },
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain(
      "Update restart: failed · managed-service-handoff-failed · run openclaw gateway status --deep",
    );
    expect(output).toContain("Update restart failed; run openclaw gateway status --deep.");
    expect(output).toContain(
      "If the service is down, run openclaw gateway restart or openclaw gateway install --force.",
    );
  });

  it("adds direct update restart guidance for pending update sentinels", async () => {
    const params = createBaseParams([]);
    params.sentinel = {
      payload: {
        kind: "update",
        status: "skipped",
        ts: Date.now() - 60_000,
        stats: {
          mode: "npm",
          reason: "restart-health-pending",
          steps: [],
        },
      },
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain(
      "Update restart: restart pending health verification · run openclaw gateway status --deep",
    );
    expect(output).toContain(
      "Update restart is still pending; run openclaw update status --json for handoff state.",
    );
  });

  it("emits a soft warning when no agent sessions were active in the last 30m", async () => {
    const params = createBaseParams([]);
    params.agentStatus = {
      totalSessions: 2,
      agents: [
        { id: "main", lastActiveAgeMs: 31 * 60_000 },
        { id: "worker", lastActiveAgeMs: null },
      ],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("! Agent activity: 0 active in 30m · 2 sessions");
    expect(output).toContain("verify inbound dispatch and turn creation");
  });

  it("keeps agent activity healthy when a session was recently updated", async () => {
    const params = createBaseParams([]);
    params.agentStatus = {
      totalSessions: 2,
      agents: [
        { id: "main", lastActiveAgeMs: 5 * 60_000 },
        { id: "worker", lastActiveAgeMs: 45 * 60_000 },
      ],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Agent activity: 1 active in 30m · 2 sessions");
    expect(output).not.toContain("verify inbound dispatch and turn creation");
  });

  it("summarizes inbound delivery telemetry proof counters", async () => {
    const params = createBaseParams([]);
    params.gatewayReachable = true;
    params.deliveryDiagnostics = {
      summary: {
        byType: {
          "message.received": 2,
          "message.dispatch.started": 2,
          "message.dispatch.completed": 2,
          "session.turn.created": 2,
          "message.processed": 2,
        },
      },
      events: [{ type: "session.turn.created", ts: Date.now() - 60_000 }],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain(
      "✓ Inbound delivery telemetry: received 2 · dispatch 2/2 · turns 2 · processed 2",
    );
    expect(output).toContain("latest delivery event:");
  });

  it("keeps handled terminal delivery paths healthy without dispatch starts", async () => {
    const params = createBaseParams([]);
    params.gatewayReachable = true;
    params.deliveryDiagnostics = {
      summary: {
        byType: {
          "message.received": 1,
          "message.dispatch.started": 0,
          "message.dispatch.completed": 0,
          "session.turn.created": 0,
          "message.processed": 1,
        },
      },
      events: [{ type: "message.processed", ts: Date.now() - 30_000 }],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain(
      "✓ Inbound delivery telemetry: received 1 · dispatch 0/0 · turns 0 · processed 1",
    );
    expect(output).not.toContain("Messages were received, but no gateway dispatch started");
  });

  it("keeps handled terminal dispatches healthy without agent turns", async () => {
    const params = createBaseParams([]);
    params.gatewayReachable = true;
    params.deliveryDiagnostics = {
      summary: {
        byType: {
          "message.received": 1,
          "message.dispatch.started": 1,
          "message.dispatch.completed": 1,
          "session.turn.created": 0,
          "message.processed": 1,
        },
      },
      events: [{ type: "message.processed", ts: Date.now() - 30_000 }],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain(
      "✓ Inbound delivery telemetry: received 1 · dispatch 1/1 · turns 0 · processed 1",
    );
    expect(output).not.toContain("Gateway dispatch started, but no agent turn was created");
  });

  it("warns when received messages never reach agent turn creation", async () => {
    const params = createBaseParams([]);
    params.gatewayReachable = true;
    params.deliveryDiagnostics = {
      summary: {
        byType: {
          "message.received": 3,
          "message.dispatch.started": 3,
          "message.dispatch.completed": 1,
          "session.turn.created": 0,
          "message.processed": 1,
        },
      },
      events: [{ type: "message.dispatch.started", ts: Date.now() - 120_000 }],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain(
      "! Inbound delivery telemetry: received 3 · dispatch 3/1 · turns 0 · processed 1",
    );
    expect(output).toContain("Gateway dispatch started, but no agent turn was created");
    expect(output).toContain("Multiple gateway dispatches have not completed yet");
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
    params.gatewayReachable = true;

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("Node-only mode detected");
    expect(output).toContain(
      "Channel issues skipped (node-only mode; query gateway.example.com:19000)",
    );
    expect(output).not.toContain("Channel issues skipped (gateway unreachable)");
    expect(output).not.toContain("Gateway health:");
    expect(output).not.toContain("Inbound delivery telemetry: unavailable");
  });

  it("does not read or display stale stderr tails on Darwin", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      restartLogMocks.resolveGatewaySupervisorLogPaths.mockReturnValue({
        logDir: "/Users/test/Library/Logs/openclaw",
        stdoutPath: "/Users/test/Library/Logs/openclaw/gateway.log",
        stderrPath: "/Users/test/Library/Logs/openclaw/gateway.err.log",
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
        "/Users/test/Library/Logs/openclaw/gateway.err.log",
        40,
      );
      expect(output).toContain("# stdout: /Users/test/Library/Logs/openclaw/gateway.log");
      expect(output).toContain("gateway stdout current");
      expect(output).not.toContain("# stderr:");
      expect(output).not.toContain("failed to bind gateway socket stale");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
