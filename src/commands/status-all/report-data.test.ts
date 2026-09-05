// Status-all report data tests cover local read-only diagnosis probes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";

const mocks = vi.hoisted(() => ({
  listUpdateRuns: vi.fn<() => UpdateRunRecord[]>(() => []),
  buildStatusAllOverviewRows: vi.fn<
    typeof import("../status-overview-rows.ts").buildStatusAllOverviewRows
  >(() => []),
  readConfigFileSnapshot: vi.fn(async () => ({ path: "/tmp/openclaw.json" })),
  inspectPortUsage: vi.fn(async () => null),
  resolveGatewayBindHost: vi.fn(async () => "127.0.0.1"),
  resolveStatusGatewayDiagnosticsSafe: vi.fn(async () => ({ ok: true, value: {} })),
  resolveStatusGatewayHealthSafe: vi.fn(async () => undefined),
  resolveNodeExecEligibility: vi.fn(() => ({ canExec: false })),
  loadExecApprovalsReadOnly: vi.fn(() => ({ version: 1, agents: {} })),
  buildWorkspaceSkillStatus: vi.fn(() => null),
  resolveStatusSummaryFromOverview: vi.fn(async () => ({})),
}));

vi.mock("../../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: mocks.resolveNodeExecEligibility,
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
vi.mock("../../infra/exec-approvals.js", () => ({
  loadExecApprovalsReadOnly: mocks.loadExecApprovalsReadOnly,
}));
vi.mock("../../infra/update-run-ledger.js", () => ({
  findActiveUpdateRun: () => undefined,
  listUpdateRuns: mocks.listUpdateRuns,
}));
vi.mock("../../infra/restart-sentinel.js", () => ({
  readRestartSentinelReadOnly: async () => null,
}));
vi.mock("../../plugins/status.js", () => ({ buildPluginCompatibilityNotices: () => [] }));
vi.mock("../../skills/discovery/status.js", () => ({
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => ({}) }));
vi.mock("../status-overview-rows.ts", () => ({
  buildStatusAllOverviewRows: mocks.buildStatusAllOverviewRows,
}));
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
vi.mock("../status.scan-overview.ts", () => ({
  resolveStatusSummaryFromOverview: mocks.resolveStatusSummaryFromOverview,
}));

import { buildStatusAllReportData } from "./report-data.js";

describe("buildStatusAllReportData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUpdateRuns.mockReturnValue([]);
    mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValue({ ok: true, value: {} });
    mocks.resolveStatusGatewayHealthSafe.mockResolvedValue(undefined);
  });

  it("keeps diagnosis non-observing and retains the update report after sentinel consumption", async () => {
    mocks.listUpdateRuns.mockReturnValue([
      {
        runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
        createdAtMs: 1,
        updatedAtMs: 2,
        trigger: "cli",
        phase: "finished",
        status: "succeeded",
        reason: null,
        origin: {},
        target: {},
        before: { version: "2026.9.1" },
        after: { version: "2026.9.2" },
        steps: [],
        verification: {},
        repair: [],
        confirmedAtMs: null,
        finishedAtMs: 2,
        downtimeMs: null,
      },
    ]);
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

    expect(mocks.buildStatusAllOverviewRows).toHaveBeenCalledWith(
      expect.objectContaining({
        updateValue: "✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).",
        updateRestartValue: null,
      }),
    );
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
    expect(mocks.resolveGatewayBindHost).toHaveBeenCalledWith("loopback", undefined);
    expect(mocks.inspectPortUsage).toHaveBeenCalledWith(18789, {
      probeHosts: ["127.0.0.1"],
    });
    expect(mocks.resolveStatusSummaryFromOverview).toHaveBeenCalledOnce();
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
        runtimeDegradation: { degradedSecretOwners: [], degradedPlugins: [] },
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
    expect(mocks.resolveStatusSummaryFromOverview).not.toHaveBeenCalled();
  });

  it("uses the configured system agent for workspace skill diagnosis", async () => {
    await buildStatusAllReportData({
      overview: {
        cfg: {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "beta" } },
            entries: {
              alpha: { workspace: "/tmp/alpha" },
              beta: { workspace: "/tmp/beta" },
            },
          },
        },
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
        agentStatus: {
          agents: [
            { id: "alpha", workspaceDir: "/tmp/alpha" },
            { id: "beta", workspaceDir: "/tmp/beta" },
          ],
          defaultId: null,
        },
        channels: { rows: [], details: [] },
        channelIssues: [],
        osSummary: { label: "test" },
      } as never,
      daemon: {} as never,
      nodeService: {} as never,
      nodeOnlyGateway: {} as never,
      progress: { setLabel: vi.fn(), tick: vi.fn() },
    });

    expect(mocks.resolveNodeExecEligibility).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      execApprovals: { version: 1, agents: {} },
      agentId: "beta",
    });
    expect(mocks.buildWorkspaceSkillStatus).toHaveBeenCalledWith("/tmp/beta", expect.any(Object));
  });

  it("does not inspect the first workspace when an explicit fleet has no owner", async () => {
    await buildStatusAllReportData({
      overview: {
        cfg: {
          agents: {
            ownership: "explicit",
            entries: {
              alpha: { workspace: "/tmp/alpha" },
              beta: { workspace: "/tmp/beta" },
            },
          },
        },
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
        agentStatus: {
          agents: [
            { id: "alpha", workspaceDir: "/tmp/alpha" },
            { id: "beta", workspaceDir: "/tmp/beta" },
          ],
          defaultId: null,
        },
        channels: { rows: [], details: [] },
        channelIssues: [],
        osSummary: { label: "test" },
      } as never,
      daemon: {} as never,
      nodeService: {} as never,
      nodeOnlyGateway: {} as never,
      progress: { setLabel: vi.fn(), tick: vi.fn() },
    });

    expect(mocks.resolveNodeExecEligibility).not.toHaveBeenCalled();
    expect(mocks.buildWorkspaceSkillStatus).not.toHaveBeenCalled();
  });
});
