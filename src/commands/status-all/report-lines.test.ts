// Status-all report-lines tests verify rendered report structure and diagnosis section integration.
import { describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";
import { buildStatusAllReportLines } from "./report-lines.js";

const diagnosisSpy = vi.hoisted(() =>
  vi.fn(async ({ lines }: { lines: string[]; secretDiagnostics: string[] }) => {
    await Promise.resolve();
    lines.push("diagnosis body", "");
  }),
);

vi.mock("./diagnosis.js", () => ({
  appendStatusAllDiagnosis: diagnosisSpy,
}));

describe("buildStatusAllReportLines", () => {
  it("renders bootstrap state and invalid config diagnostics", async () => {
    const progress: ProgressReporter = {
      setLabel: () => {},
      setPercent: () => {},
      tick: () => {},
      done: () => {},
    };
    const lines = await buildStatusAllReportLines({
      progress,
      configDiagnostics: {
        path: "/tmp/openclaw.json",
        issues: [{ path: "gateway.port", message: "invalid" }],
      },
      overviewRows: [{ Item: "Gateway", Value: "ok" }],
      channels: {
        rows: [
          {
            id: "discord",
            label: "Discord",
            enabled: true,
            state: "ok",
            detail: "connected",
          },
        ],
        details: [
          {
            title: "Discord accounts",
            columns: ["Account", "Status", "Notes"],
            rows: [{ Account: "default", Status: "OK", Notes: "ready" }],
          },
          { title: "Empty accounts", columns: ["Account", "Status"], rows: [] },
        ],
      },
      channelIssues: [{ channel: "discord", message: `${"x".repeat(89)}🚀tail` }],
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
        deliveryDiagnostics: null,
        exporterDiagnostics: null,
        gatewayReachable: false,
        health: null,
        nodeOnlyGateway: null,
      },
    });

    const output = lines.join("\n");
    expect(output).toContain("Bootstrap file");
    expect(output).toContain("PRESENT");
    expect(output).toContain("ABSENT");
    expect(output).toContain("Config diagnostics:");
    expect(output).toContain("Config file is invalid: /tmp/openclaw.json");
    expect(output).toContain("gateway.port: invalid");
    expect(output).toContain("Fix: openclaw doctor --fix");
    expect(output.indexOf("Config diagnostics:")).toBeLessThan(
      output.indexOf("OpenClaw status --all"),
    );
    expect(output).not.toContain(String.fromCharCode(0xd83d));
    expect(
      lines.filter((line) =>
        /^(Overview|Channels|Discord accounts|Empty accounts|Agents|Diagnosis \(read-only\))$/.test(
          line,
        ),
      ),
    ).toEqual([
      "Overview",
      "Channels",
      "Discord accounts",
      "Empty accounts",
      "Agents",
      "Diagnosis (read-only)",
    ]);
    expect(lines.slice(-4)).toEqual(["", "Diagnosis (read-only)", "diagnosis body", ""]);
    expect(diagnosisSpy).toHaveBeenCalledOnce();
    expect(diagnosisSpy).toHaveBeenCalledWith(expect.objectContaining({ secretDiagnostics: [] }));
  });
});
