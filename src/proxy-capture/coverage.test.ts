import { describe, expect, it } from "vitest";
import { buildDebugProxyCoverageReport } from "./coverage.js";

describe("debug proxy coverage report", () => {
  it("summarizes captured and partial transport seams", () => {
    const report = buildDebugProxyCoverageReport();

    expect(report.summary.total).toBe(report.entries.length);
    expect(report.summary.captured).toBeGreaterThan(0);
    expect(report.summary.proxyOnly).toBeGreaterThan(0);
    const entryIds = new Set(report.entries.map((entry) => entry.id));
    expect(entryIds.has("provider-transport-fetch")).toBe(true);
    expect(entryIds.has("feishu-client-http")).toBe(true);
  });
});
