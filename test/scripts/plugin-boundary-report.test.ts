import { describe, expect, it } from "vitest";
import { createPluginBoundaryReport } from "../../scripts/plugin-boundary-report.js";

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
  it("emits compact CI-safe summary JSON", () => {
    const result = createPluginBoundaryReport([
      "--summary",
      "--json",
      "--fail-on-cross-owner",
      "--fail-on-unclassified-unused-reserved",
    ]);
    const summary = JSON.parse(result.stdout) as {
      pluginSdk?: {
        crossOwnerReservedImportCount?: unknown;
        unusedReservedCount?: unknown;
      };
      memoryHostSdk?: {
        implementation?: unknown;
      };
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const pluginSdk = requirePluginSdkSummary(summary);
    expect(pluginSdk.crossOwnerReservedImportCount).toBe(0);
    expect(pluginSdk.unusedReservedCount).toBe(0);
    expect(["private-core-bridge", "private-package-core-integrated"]).toContain(
      summary.memoryHostSdk?.implementation,
    );
  });
});
