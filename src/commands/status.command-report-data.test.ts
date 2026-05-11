import { describe, expect, it } from "vitest";
import { buildStatusCommandReportData } from "./status.command-report-data.ts";
import { createStatusCommandReportDataParams } from "./status.test-support.ts";

describe("buildStatusCommandReportData", () => {
  it("builds report inputs from shared status surfaces", async () => {
    const baseParams = createStatusCommandReportDataParams();
    const result = await buildStatusCommandReportData(
      createStatusCommandReportDataParams({
        surface: {
          ...baseParams.surface,
          gatewayProbe: { connectLatencyMs: 123, error: null },
        },
        summary: {
          ...baseParams.summary,
          sessions: {
            ...baseParams.summary.sessions,
            recent: [
              {
                ...baseParams.summary.sessions.recent[0],
                key: "session-key",
                kind: "direct",
                updatedAt: 1,
                age: 5_000,
                model: "gpt-5.4",
              },
            ],
          },
        },
      }),
    );

    expect(result.overviewRows[0]).toEqual({
      Item: "OS",
      Value: "macOS · node " + process.versions.node,
    });
    expect(result.taskMaintenanceHint).toBe(
      "Task maintenance: cmd:openclaw tasks maintenance --apply",
    );
    expect(result.pluginCompatibilityLines).toEqual(["  warn(WARN) legacy"]);
    expect(result.pairingRecoveryLines[0]).toBe("warn(Gateway pairing approval required.)");
    expect(result.channelsRows[0]?.Channel).toBe("QuietChat");
    expect(result.sessionsRows[0]?.Cache).toBe("cache ok");
    expect(result.healthRows?.[0]).toEqual({
      Item: "Gateway",
      Status: "ok(reachable)",
      Detail: "42ms",
    });
    expect(result.footerLines.at(-1)).toBe("  Need to test channels? cmd:openclaw status --deep");
  });

  it("shows skipped audit text when fast status omits the security audit", async () => {
    const result = await buildStatusCommandReportData(
      createStatusCommandReportDataParams({
        securityAudit: undefined,
      }),
    );

    expect(result.securityAuditLines).toEqual([
      "muted(Skipped in fast status. Full report: cmd:openclaw security audit)",
      "muted(Deep probe: cmd:openclaw status --deep)",
    ]);
  });

  it("adds model-pricing degradation from gateway probe health to overview rows", async () => {
    const baseParams = createStatusCommandReportDataParams();
    const result = await buildStatusCommandReportData(
      createStatusCommandReportDataParams({
        surface: {
          ...baseParams.surface,
          gatewayProbe: {
            connectLatencyMs: 123,
            error: null,
            health: {
              ok: true,
              modelPricing: {
                state: "degraded",
                detail: "OpenRouter pricing fetch failed: TypeError: fetch failed",
                sources: [{ source: "openrouter", state: "degraded" }],
              },
            },
          },
        },
        health: undefined,
      }),
    );

    expect(result.overviewRows).toEqual(
      expect.arrayContaining([
        {
          Item: "Model pricing",
          Value: "warn(degraded · OpenRouter pricing fetch failed: TypeError: fetch failed)",
        },
      ]),
    );
  });
});
