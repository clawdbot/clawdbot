import { describe, expect, it } from "vitest";
import { createPluginBoundaryReport } from "../../scripts/plugin-boundary-report.js";

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

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(summary.pluginSdk?.crossOwnerReservedImportCount).toBe(0);
    expect(summary.pluginSdk?.unusedReservedCount).toBe(0);
    expect(["private-core-bridge", "private-package-core-integrated"]).toContain(
      summary.memoryHostSdk?.implementation,
    );
  });
});
