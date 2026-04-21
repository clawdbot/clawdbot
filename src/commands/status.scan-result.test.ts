import { describe, expect, it } from "vitest";
import { buildStatusScanResult } from "./status.scan-result.ts";
import { buildColdStartStatusSummary } from "./status.scan.bootstrap-shared.ts";
import type { GatewayProbeSnapshot } from "./status.scan.shared.ts";

describe("buildStatusScanResult", () => {
  it("builds the full shared scan result shape", () => {
    const osSummary = {
      platform: "linux" as const,
      arch: "x64",
      release: "6.8.0",
      label: "linux 6.8.0 (x64)",
    };
    const update = {
      root: "/tmp/openclaw",
      installKind: "package" as const,
      packageManager: "npm" as const,
    };
    const gatewaySnapshot: Pick<
      GatewayProbeSnapshot,
      | "gatewayConnection"
      | "remoteUrlMissing"
      | "gatewayMode"
      | "gatewayProbeAuth"
      | "gatewayProbeAuthWarning"
      | "gatewayProbe"
      | "gatewayReachable"
      | "gatewaySelf"
    > = {
      gatewayConnection: {
        url: "ws://127.0.0.1:18789",
        urlSource: "config" as const,
        message: "Gateway target: ws://127.0.0.1:18789",
      },
      remoteUrlMissing: false,
      gatewayMode: "local" as const,
      gatewayProbeAuth: { token: "tok" },
      gatewayProbeAuthWarning: "warn",
      gatewayProbe: {
        ok: true,
        url: "ws://127.0.0.1:18789",
        connectLatencyMs: 42,
        error: null,
        close: null,
        auth: {
          role: "operator",
          scopes: ["operator.read"],
          capability: "read_only",
        },
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      },
      gatewayReachable: true,
      gatewaySelf: { host: "gateway" },
    };
    const channelIssues = [
      {
        channel: "quietchat",
        accountId: "default",
        kind: "runtime" as const,
        message: "warn",
      },
    ];
    const agentStatus = {
      defaultId: "main",
      totalSessions: 0,
      bootstrapPendingCount: 0,
      agents: [
        {
          id: "main",
          workspaceDir: null,
          bootstrapPending: false,
          sessionsPath: "/tmp/main.json",
          sessionsCount: 0,
          lastUpdatedAt: null,
          lastActiveAgeMs: null,
        },
      ],
    };
    const channels = { rows: [], details: [] };
    const summary = buildColdStartStatusSummary();
    const memory = { agentId: "main", backend: "builtin" as const, provider: "sqlite" };
    const memoryPlugin = { enabled: true, slot: "memory-core" };
    const pluginCompatibility = [
      {
        pluginId: "legacy",
        code: "legacy-before-agent-start" as const,
        severity: "warn" as const,
        message: "warn",
      },
    ];

    expect(
      buildStatusScanResult({
        cfg: { gateway: {} },
        sourceConfig: { gateway: {} },
        secretDiagnostics: ["diag"],
        osSummary,
        tailscaleMode: "serve",
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
        update,
        gatewaySnapshot,
        channelIssues,
        agentStatus,
        channels,
        summary,
        memory,
        memoryPlugin,
        pluginCompatibility,
      }),
    ).toEqual({
      cfg: { gateway: {} },
      sourceConfig: { gateway: {} },
      secretDiagnostics: ["diag"],
      osSummary,
      tailscaleMode: "serve",
      tailscaleDns: "box.tail.ts.net",
      tailscaleHttpsUrl: "https://box.tail.ts.net",
      update,
      gatewayConnection: gatewaySnapshot.gatewayConnection,
      remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
      gatewayMode: gatewaySnapshot.gatewayMode,
      gatewayProbeAuth: gatewaySnapshot.gatewayProbeAuth,
      gatewayProbeAuthWarning: gatewaySnapshot.gatewayProbeAuthWarning,
      gatewayProbe: gatewaySnapshot.gatewayProbe,
      gatewayReachable: gatewaySnapshot.gatewayReachable,
      gatewaySelf: gatewaySnapshot.gatewaySelf,
      channelIssues,
      agentStatus,
      channels,
      summary,
      memory,
      memoryPlugin,
      pluginCompatibility,
    });
  });
});
