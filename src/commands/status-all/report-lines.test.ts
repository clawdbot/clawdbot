import { describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";
import { buildStatusAllReportLines } from "./report-lines.js";

const diagnosisSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./diagnosis.js", () => ({
  appendStatusAllDiagnosis: diagnosisSpy,
}));

describe("buildStatusAllReportLines", () => {
  it("renders bootstrap column using file-presence semantics", async () => {
    const progress: ProgressReporter = {
      setLabel: () => {},
      setPercent: () => {},
      tick: () => {},
      done: () => {},
    };
    const lines = await buildStatusAllReportLines({
      progress,
      overviewRows: [{ Item: "Gateway", Value: "ok" }],
      channels: {
        rows: [],
        details: [],
      },
      channelIssues: [],
      agentStatus: {
        agents: [
          {
            id: "main",
            bootstrapPending: true,
            sessionsCount: 1,
            lastActiveAgeMs: 12_000,
            sessionsPath: "/tmp/main-sessions.json",
          },
          {
            id: "ops",
            bootstrapPending: false,
            sessionsCount: 0,
            lastActiveAgeMs: null,
            sessionsPath: "/tmp/ops-sessions.json",
          },
        ],
      },
      connectionDetailsForReport: "",
      diagnosis: {
        snap: null,
        remoteUrlMissing: false,
        secretDiagnostics: [],
        sentinel: null,
        lastErr: null,
        port: 18789,
        portUsage: null,
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
      },
    });

    const output = lines.join("\n");
    expect(output).toContain("Bootstrap file");
    expect(output).toContain("PRESENT");
    expect(output).toContain("ABSENT");
    expect(diagnosisSpy).toHaveBeenCalledOnce();
    const [diagnosisOptions] = diagnosisSpy.mock.calls.at(0) as unknown as [
      { secretDiagnostics?: unknown[] },
    ];
    expect(diagnosisOptions?.secretDiagnostics).toEqual([]);
  });
});
