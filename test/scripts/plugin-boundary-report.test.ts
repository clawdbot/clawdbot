// Plugin Boundary Report tests cover plugin boundary report script behavior.
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPluginBoundaryReport,
  type PluginBoundaryReportResult,
} from "../../scripts/plugin-boundary-report.js";

function requirePluginSdkSummary(summary: {
  pluginSdk?: {
    crossOwnerReservedImportCount?: unknown;
    unusedReservedCount?: unknown;
  };
}) {
  if (!summary.pluginSdk) {
    throw new Error("Expected plugin SDK summary");
  }
  return summary.pluginSdk;
}

describe("plugin-boundary-report", () => {
  let summaryResult: PluginBoundaryReportResult;

  beforeAll(() => {
    summaryResult = createPluginBoundaryReport([
      "--summary",
      "--json",
      "--fail-on-cross-owner",
      "--fail-on-unclassified-unused-reserved",
    ]);
  });

  it("emits compact CI-safe summary JSON", () => {
    const summary = JSON.parse(summaryResult.stdout) as {
      compat?: {
        removalPendingCount?: unknown;
        removalPendingDueCount?: unknown;
        removalPending?: Array<{
          code?: unknown;
          removeAfter?: unknown;
          blocker?: unknown;
          readerCount?: unknown;
          readerSample?: unknown;
          dueForReview?: unknown;
        }>;
      };
      pluginSdk?: {
        crossOwnerReservedImportCount?: unknown;
        unusedReservedCount?: unknown;
      };
      memoryHostSdk?: {
        implementation?: unknown;
      };
    };

    expect(summaryResult.exitCode).toBe(0);
    expect(summaryResult.stderr).toBe("");
    expect(summary.compat?.removalPendingCount).toBe(5);
    expect(summary.compat?.removalPendingDueCount).toEqual(expect.any(Number));
    expect(summary.compat?.removalPending?.map((record) => record.code)).toEqual([
      "agent-harness-sdk-alias",
      "plugin-sdk-media-understanding-public-demotion",
      "plugin-sdk-memory-host-core-public-demotion",
      "plugin-sdk-plugin-config-runtime-public-demotion",
      "plugin-sdk-tool-plugin-public-demotion",
    ]);
    for (const record of summary.compat?.removalPending ?? []) {
      expect(record.removeAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(record.blocker).toEqual(expect.stringMatching(/retain|replacement/iu));
      expect(record.readerCount).toEqual(expect.any(Number));
      expect(record.readerSample).toEqual(expect.arrayContaining([expect.any(String)]));
      expect((record.readerSample as unknown[]).length).toBeLessThanOrEqual(5);
      expect(record.dueForReview).toEqual(expect.any(Boolean));
    }
    const pluginSdk = requirePluginSdkSummary(summary);
    expect(pluginSdk.crossOwnerReservedImportCount).toBe(0);
    expect(pluginSdk.unusedReservedCount).toBe(0);
    expect(["private-core-bridge", "private-package-core-integrated"]).toContain(
      summary.memoryHostSdk?.implementation,
    );
  });

  it("renders removal-pending blockers and reader references without changing fail gates", () => {
    const result = createPluginBoundaryReport(["--summary"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("removalPending=5");
    expect(result.stdout).toContain("removal-pending 2026-07-25 agent-harness-sdk-alias");
    expect(result.stdout).toMatch(/blocker=.*retain the public/iu);
    expect(result.stdout).toMatch(/readerRefs=\d+ readers=/u);
  });
});
