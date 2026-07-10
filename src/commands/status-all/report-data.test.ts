// Status-all report data tests cover local read-only diagnosis probes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(async () => ({ path: "/tmp/openclaw.json" })),
}));

vi.mock("../../agents/exec-defaults.js", () => ({ canExecRequestNode: () => false }));
vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: async () => null,
}));
vi.mock("../../infra/ports.js", () => ({ inspectPortUsage: async () => null }));
vi.mock("../../infra/restart-sentinel.js", () => ({ readRestartSentinel: async () => null }));
vi.mock("../../plugins/status.js", () => ({ buildPluginCompatibilityNotices: () => [] }));
vi.mock("../../skills/discovery/status.js", () => ({ buildWorkspaceSkillStatus: () => null }));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => ({}) }));
vi.mock("../status-overview-rows.ts", () => ({ buildStatusAllOverviewRows: () => [] }));
vi.mock("../status-overview-surface.ts", () => ({
  buildStatusOverviewSurfaceFromOverview: () => ({}),
}));
vi.mock("../status-runtime-shared.ts", () => ({
  resolveStatusGatewayDiagnosticsSafe: async () => null,
  resolveStatusGatewayHealthSafe: async () => undefined,
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
    mocks.readConfigFileSnapshot.mockClear();
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
  });
});
