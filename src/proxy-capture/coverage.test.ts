// Proxy capture coverage tests cover capture coverage accounting and summaries.
import { describe, expect, it } from "vitest";
import { buildDebugProxyCoverageReport, maybeWarnAboutDebugProxyCoverage } from "./coverage.js";

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

  it("warns about required capture gaps", () => {
    const warnings: string[] = [];

    maybeWarnAboutDebugProxyCoverage(
      {
        blobDir: "/tmp/openclaw-debug-proxy-blobs",
        certDir: "/tmp/openclaw-debug-proxy-certs",
        dbPath: "/tmp/openclaw-debug-proxy.sqlite",
        enabled: true,
        proxyUrl: "http://127.0.0.1:8080",
        required: true,
        sessionId: "coverage-test",
        sourceProcess: "test",
      },
      (message) => warnings.push(message),
    );

    expect(warnings).toEqual([
      expect.stringContaining("debug proxy coverage"),
      expect.stringContaining("remaining gaps"),
    ]);
  });
});
