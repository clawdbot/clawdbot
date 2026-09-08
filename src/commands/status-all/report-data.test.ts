// Status-all report data tests cover local read-only diagnosis probes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { baseStatusGatewaySnapshot, baseStatusOverviewSurface } from "../status.test-support.ts";

const mocks = vi.hoisted(() => ({
  listUpdateRuns: vi.fn<() => UpdateRunRecord[]>(() => []),
  findActiveUpdateRun: vi.fn<() => UpdateRunRecord | undefined>(),
  getUpdateRun: vi.fn<(runId: string) => UpdateRunRecord | undefined>(),
  readRestartSentinelReadOnly: vi.fn<() => Promise<{ payload: RestartSentinelPayload } | null>>(
    async () => null,
  ),
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
  findActiveUpdateRun: mocks.findActiveUpdateRun,
  getUpdateRun: mocks.getUpdateRun,
  listUpdateRuns: mocks.listUpdateRuns,
}));
vi.mock("../../infra/restart-sentinel.js", () => ({
  readRestartSentinelReadOnly: mocks.readRestartSentinelReadOnly,
}));
vi.mock("../../plugins/status.js", () => ({ buildPluginCompatibilityNotices: () => [] }));
vi.mock("../../skills/discovery/status.js", () => ({
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => ({}) }));
vi.mock("../status-overview-rows.ts", () => ({
  buildStatusAllOverviewRows: mocks.buildStatusAllOverviewRows,
}));
vi.mock("../status-runtime-shared.ts", () => ({
  resolveStatusGatewayDiagnosticsSafe: mocks.resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe: mocks.resolveStatusGatewayHealthSafe,
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
    mocks.findActiveUpdateRun.mockReturnValue(undefined);
    mocks.getUpdateRun.mockReturnValue(undefined);
    mocks.readRestartSentinelReadOnly.mockResolvedValue(null);
    mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValue({ ok: true, value: {} });
    mocks.resolveStatusGatewayHealthSafe.mockResolvedValue(undefined);
  });

  it.each([
    "completed",
    "active",
    "sentinel",
    "none",
    "mixed-sentinel",
    "same-run",
    "different-run",
    "same-prose",
    "generic-sentinel",
  ] as const)(
    "keeps current update availability alongside %s history without observing config",
    async (history) => {
      const rows = await vi.importActual<typeof import("../status-overview-rows.ts")>(
        "../status-overview-rows.ts",
      );
      mocks.buildStatusAllOverviewRows.mockImplementationOnce(rows.buildStatusAllOverviewRows);
      const completed: UpdateRunRecord = {
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
      };
      const hasRun = history !== "sentinel" && history !== "none";
      const hasSentinel = [
        "sentinel",
        "mixed-sentinel",
        "same-run",
        "different-run",
        "same-prose",
        "generic-sentinel",
      ].includes(history);
      if (hasRun) {
        mocks.listUpdateRuns.mockReturnValue([completed]);
        mocks.getUpdateRun.mockReturnValue(completed);
      }
      if (history === "active") {
        mocks.findActiveUpdateRun.mockReturnValue({
          ...completed,
          status: "running",
          phase: "verifying",
        });
      }
      if (hasSentinel) {
        const sentinelRunId =
          history === "different-run"
            ? "1e36e13e-8cbf-4c33-bd2b-03adbd8f7a64"
            : history === "same-run"
              ? completed.runId
              : undefined;
        if (sentinelRunId) {
          mocks.getUpdateRun.mockReturnValue({ ...completed, runId: sentinelRunId });
        }
        mocks.readRestartSentinelReadOnly.mockResolvedValue({
          payload: {
            kind: history === "generic-sentinel" ? "restart" : "update",
            status: history === "mixed-sentinel" ? "error" : "ok",
            ts: 3,
            stats: {
              before: completed.before,
              after: completed.after,
              ...(history === "mixed-sentinel" ? { reason: "restart-unhealthy" } : {}),
              ...(sentinelRunId ? { runId: sentinelRunId } : {}),
            },
          },
        });
      }
      const report = await buildStatusAllReportData({
        overview: {
          ...baseStatusOverviewSurface,
          cfg: {},
          update: {
            ...baseStatusOverviewSurface.update,
            registry: { latestVersion: "9999.1.1" },
          },
          gatewaySnapshot: {
            ...baseStatusGatewaySnapshot,
            gatewayReachable: false,
            gatewayProbe: null,
            gatewayCallOverrides: undefined,
            remoteUrlMissing: false,
          },
          secretDiagnostics: [],
          tailscaleMode: "off",
          tailscaleDns: null,
          agentStatus: { agents: [], defaultId: null, totalSessions: 0, bootstrapPendingCount: 0 },
          channels: { rows: [], details: [] },
          channelIssues: [],
          osSummary: { label: "test" },
        } as never,
        daemon: baseStatusOverviewSurface.gatewayService as never,
        nodeService: baseStatusOverviewSurface.nodeService as never,
        nodeOnlyGateway: null,
        progress: { setLabel: vi.fn(), tick: vi.fn() },
      });

      expect(report.overviewRows.find((row) => row.Item === "Update")?.Value).toContain(
        "npm update 9999.1.1",
      );
      expect(report.overviewRows.find((row) => row.Item === "Update")?.Value).toContain("behind 2");
      const success = "✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).";
      expect(
        report.overviewRows.filter((row) => ["Update run", "Update restart"].includes(row.Item)),
      ).toEqual([
        ...(hasRun
          ? [
              {
                Item: "Update run",
                Value:
                  history === "active" ? "⬆️ OpenClaw update in progress: verifying." : success,
              },
            ]
          : []),
        ...(hasSentinel && history !== "same-run" && history !== "generic-sentinel"
          ? [
              {
                Item: "Update restart",
                Value:
                  history === "mixed-sentinel"
                    ? "⚠️ OpenClaw update failed: restart-unhealthy."
                    : success,
              },
            ]
          : []),
      ]);
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
      expect(mocks.resolveGatewayBindHost).toHaveBeenCalledWith("loopback", undefined);
      expect(mocks.inspectPortUsage).toHaveBeenCalledWith(18789, {
        probeHosts: ["127.0.0.1"],
      });
      expect(mocks.resolveStatusSummaryFromOverview).toHaveBeenCalledOnce();
    },
  );

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
