// Status-all report data tests cover local read-only diagnosis probes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(async () => ({ path: "/tmp/openclaw.json" })),
  inspectPortUsage: vi.fn(async () => null),
  resolveGatewayBindHost: vi.fn(async () => "127.0.0.1"),
  resolveStatusGatewayDiagnosticsSafe: vi.fn(async () => null),
  resolveStatusGatewayHealthSafe: vi.fn(async () => undefined),
}));

vi.mock("../../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: () => ({ canExec: false }),
}));
vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: async () => null,
}));
vi.mock("../../gateway/net.js", () => ({
  resolveGatewayBindHost: mocks.resolveGatewayBindHost,
  resolveGatewayRequiredListenHosts: (bindHost: string) =>
    bindHost === "100.64.0.40" ? [bindHost, "127.0.0.1"] : [bindHost],
}));
vi.mock("../../infra/ports-inspect.js", () => ({ inspectPortUsage: mocks.inspectPortUsage }));
vi.mock("../../infra/restart-sentinel.js", () => ({ readRestartSentinel: async () => null }));
vi.mock("../../plugins/status.js", () => ({ buildPluginCompatibilityNotices: () => [] }));
vi.mock("../../skills/discovery/status.js", () => ({ buildWorkspaceSkillStatus: () => null }));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => ({}) }));
vi.mock("../status-overview-rows.ts", () => ({ buildStatusAllOverviewRows: () => [] }));
vi.mock("../status-overview-surface.ts", () => ({
  buildStatusOverviewSurfaceFromOverview: () => ({}),
}));
vi.mock("../status-runtime-shared.ts", () => ({
  resolveStatusGatewayDiagnosticsSafe: mocks.resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe: mocks.resolveStatusGatewayHealthSafe,
}));
vi.mock("../status-update-restart.ts", () => ({
  formatUpdateRestartStatusValue: () => null,
}));
vi.mock("../status.gateway-connection.ts", () => ({
  resolveStatusAllConnectionDetails: () => [],
}));

import { buildStatusAllReportData } from "./report-data.js";

describe("buildStatusAllReportData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValue(null);
    mocks.resolveStatusGatewayHealthSafe.mockResolvedValue(undefined);
  });

  it("keeps local config diagnosis non-observing", async () => {
    await buildStatusAllReportData({
      overview: {
        cfg: {},
        gatewaySnapshot: {
          gatewayReachable: false,
          gatewayProbe: null,
          gatewayCallOverrides: undefined,
          gatewayConnection: {},
          remoteUrlMissing: false,
        },
        secretDiagnostics: [],
        tailscaleMode: "off",
        tailscaleDns: null,
        agentStatus: { agents: [], defaultId: null },
        channels: { rows: [], details: [] },
        channelIssues: [],
        osSummary: { label: "test" },
      } as never,
      daemon: {} as never,
      nodeService: {} as never,
      nodeOnlyGateway: {} as never,
      progress: { setLabel: vi.fn(), tick: vi.fn() },
    });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
    expect(mocks.resolveGatewayBindHost).toHaveBeenCalledWith("loopback", undefined);
    expect(mocks.inspectPortUsage).toHaveBeenCalledWith(18789, {
      probeHosts: ["127.0.0.1"],
    });
  });

  it("collects delivery and exporter stability projections in parallel", async () => {
    await buildStatusAllReportData({
      overview: {
        cfg: {},
        gatewaySnapshot: {
          gatewayReachable: true,
          gatewayProbe: { error: null },
          gatewayCallOverrides: undefined,
          gatewayConnection: {},
          remoteUrlMissing: false,
        },
        secretDiagnostics: [],
        tailscaleMode: "off",
        tailscaleDns: null,
        agentStatus: { agents: [], defaultId: null },
        channels: { rows: [], details: [] },
        channelIssues: [],
        osSummary: { label: "test" },
      } as never,
      daemon: {} as never,
      nodeService: {} as never,
      nodeOnlyGateway: null,
      progress: { setLabel: vi.fn(), tick: vi.fn() },
    });

    expect(mocks.resolveStatusGatewayDiagnosticsSafe.mock.calls).toEqual([
      [
        expect.objectContaining({
          gatewayReachable: true,
        }),
      ],
      [
        expect.objectContaining({
          gatewayReachable: true,
          type: "telemetry.exporter",
        }),
      ],
    ]);
  });
});
