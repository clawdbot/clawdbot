// Status command report data tests cover report data assembly from shared status fixtures.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { buildStatusCommandReportData } from "./status.command-report-data.ts";
import { createStatusCommandReportDataParams } from "./status.test-support.ts";

describe("buildStatusCommandReportData", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_PROFILE", undefined);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

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
                ...expectDefined(
                  baseParams.summary.sessions.recent[0],
                  "baseParams.summary.sessions.recent[0] test invariant",
                ),
                key: "session-key",
                kind: "direct",
                updatedAt: 1,
                age: 5_000,
                model: "gpt-5.4",
                inputTokens: 3_000,
                cacheRead: 1_000,
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
    expect(result.taskMaintenanceHint).toBe("Task maintenance: openclaw tasks maintenance --apply");
    expect(result.pluginCompatibilityLines.map(stripAnsi)).toEqual(["  WARN a legacy"]);
    const pairingTitle = expectDefined(result.pairingRecoveryLines[0], "pairing recovery title");
    expect(stripAnsi(pairingTitle)).toBe("Gateway pairing approval required.");
    expect(result.modelSelectionLines).toEqual([]);
    expect(result.channelsRows[0]?.Channel).toBe("QuietChat");
    expect(result.sessionsRows[0]?.Cache).toBe("25% hit · read 1.0k");
    const gatewayHealth = expectDefined(result.healthRows?.[0], "Gateway health row");
    expect({ ...gatewayHealth, Status: stripAnsi(gatewayHealth.Status) }).toEqual({
      Item: "Gateway",
      Status: "reachable",
      Detail: "42ms",
    });
    expect(result.footerLines.at(-1)).toBe("  Need to test channels? openclaw status --deep");
  });

  it("shows skipped audit text when fast status omits the security audit", async () => {
    const result = await buildStatusCommandReportData(
      createStatusCommandReportDataParams({
        securityAudit: undefined,
      }),
    );

    expect(result.securityAuditLines.map(stripAnsi)).toEqual([
      "Skipped in fast status. Full report: openclaw security audit",
      "Deep probe: openclaw status --deep",
    ]);
  });

  it("surfaces retained lost task cleanup timing only for detailed reports", async () => {
    const baseParams = createStatusCommandReportDataParams();
    const summary = {
      ...baseParams.summary,
      taskAuditRetainedLost: {
        count: 1,
        nextCleanupAfter: Date.parse("2026-03-30T01:00:00.000Z"),
      },
    };

    const deepResult = await buildStatusCommandReportData(
      createStatusCommandReportDataParams({ summary, opts: { deep: true } }),
    );
    const fastResult = await buildStatusCommandReportData(
      createStatusCommandReportDataParams({ summary, opts: {} }),
    );

    expect(stripAnsi(expectDefined(deepResult.retainedLostTaskLine, "retained lost task"))).toBe(
      "1 lost task retained until 2026-03-30T01:00:00.000Z",
    );
    expect(fastResult.retainedLostTaskLine).toBeNull();
  });

  it("falls back when retained lost task cleanup timing is Date-invalid", async () => {
    const baseParams = createStatusCommandReportDataParams();
    const result = await buildStatusCommandReportData(
      createStatusCommandReportDataParams({
        summary: {
          ...baseParams.summary,
          taskAuditRetainedLost: {
            count: 2,
            nextCleanupAfter: 8_700_000_000_000_000,
          },
        },
        opts: { deep: true },
      }),
    );

    expect(stripAnsi(expectDefined(result.retainedLostTaskLine, "retained lost task"))).toBe(
      "2 lost tasks retained until cleanupAfter",
    );
  });

  it("adds pinned-session model selection lines", async () => {
    const baseParams = createStatusCommandReportDataParams();
    const result = await buildStatusCommandReportData(
      createStatusCommandReportDataParams({
        summary: {
          ...baseParams.summary,
          sessions: {
            ...baseParams.summary.sessions,
            recent: [
              {
                ...expectDefined(
                  baseParams.summary.sessions.recent[0],
                  "baseParams.summary.sessions.recent[0] test invariant",
                ),
                configuredModel: "zhipu/glm-4.5-air",
                selectedModel: "deepseek/deepseek-v4-flash",
                modelSelectionReason: "session override",
              },
            ],
          },
        },
      }),
    );

    expect(result.modelSelectionLines).toContain("  Configured default: zhipu/glm-4.5-air");
    expect(result.modelSelectionLines).toContain("  Session selected: deepseek/deepseek-v4-flash");
    expect(result.modelSelectionLines).toContain("  Reason: session override");
  });
});
