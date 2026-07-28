// Kova Ci Summary tests cover kova ci summary script behavior.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function runSummary(report: unknown, extraArgs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-kova-summary-"));
  const reportPath = join(root, "report.json");
  const outputPath = join(root, "summary.md");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const result = spawnSync(
    process.execPath,
    ["scripts/kova-ci-summary.mjs", "--report", reportPath, "--output", outputPath, ...extraArgs],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  let output = "";
  try {
    output = readFileSync(outputPath, "utf8");
  } catch {}
  rmSync(root, { force: true, recursive: true });
  return { output, result };
}

describe("scripts/kova-ci-summary", () => {
  it("prints help without treating --help as a valued option", () => {
    const result = spawnSync(process.execPath, ["scripts/kova-ci-summary.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: node scripts/kova-ci-summary.mjs --report");
  });

  it.each([
    ["flag-shaped value", ["--report", "-h"]],
    ["option separator before help", ["--report", "--", "--help"]],
  ])("rejects %s before help handling", (_name, args) => {
    const result = spawnSync(process.execPath, ["scripts/kova-ci-summary.mjs", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: --report requires a value");
  });

  it("rejects empty Kova reports instead of rendering unknown summaries", () => {
    const empty = runSummary({});
    expect(empty.result.status).toBe(1);
    expect(empty.result.stderr).toContain("invalid Kova report: missing summary.statuses");

    const noEvidence = runSummary({ summary: { statuses: { pass: 1 } } });
    expect(noEvidence.result.status).toBe(1);
    expect(noEvidence.result.stderr).toContain(
      "invalid Kova report: missing records or performance groups",
    );
  });

  it("rejects unknown flags instead of silently dropping report metadata", () => {
    const result = runSummary(
      {
        records: [{ scenario: "gateway", state: "clean", status: "pass" }],
        summary: { statuses: { pass: 1 } },
      },
      ["--report-urlz", "https://example.test/report"],
    ).result;

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument: --report-urlz");
  });

  it("renders a Kova summary when status and evidence are present", () => {
    const { output, result } = runSummary({
      generatedAt: "2026-06-06T00:00:00.000Z",
      performance: {
        repeat: 1,
        groups: [
          {
            metrics: {
              cpuPercentMax: {
                count: 1,
                max: 12,
                median: 12,
                p95: 12,
                title: "CPU max",
                unit: "%",
              },
              resourcePeakGatewayRssMb: {
                count: 1,
                max: 256,
                median: 256,
                p95: 256,
                title: "Gateway RSS",
                unit: "MB",
              },
              timeToHealthReadyMs: {
                count: 1,
                max: 30,
                median: 20,
                p95: 30,
                title: "Health ready",
                unit: "ms",
              },
            },
            scenario: "gateway",
            state: "clean",
          },
        ],
      },
      records: [{ scenario: "gateway", state: "clean", status: "pass" }],
      runId: "run-1",
      summary: { statuses: { pass: 1 } },
      target: "main",
    });

    expect(result.status).toBe(0);
    expect(output).toContain("- Statuses: pass: 1");
    expect(output).toContain("| gateway | clean | Health ready | 20 ms | 30 ms | 30 ms |");
    expect(output).toContain("| gateway | clean | Gateway RSS | 256 MB | 256 MB | 256 MB |");
    expect(output).toContain("| gateway | clean | CPU max | 12 % | 12 % | 12 % |");
  });

  it("renders blocked reports without resource metrics", () => {
    const { output, result } = runSummary({
      performance: {
        repeat: 1,
        groups: [
          {
            metrics: {
              timeToHealthReadyMs: {
                count: 1,
                max: 30,
                median: 20,
                p95: 30,
                title: "Health ready",
                unit: "ms",
              },
            },
            scenario: "gateway",
            state: "clean",
          },
        ],
      },
      records: [{ scenario: "gateway", state: "clean", status: "BLOCKED" }],
      summary: { statuses: { BLOCKED: 1 } },
    });

    expect(result.status).toBe(0);
    expect(output).toContain("| gateway | clean | Health ready | 20 ms | 30 ms | 30 ms |");
    expect(output).toContain("| gateway | clean | BLOCKED |");
  });

  it("rejects successful reports without resource metrics", () => {
    const { result } = runSummary({
      performance: {
        repeat: 1,
        groups: [
          {
            metrics: {
              timeToHealthReadyMs: {
                count: 1,
                max: 30,
                median: 20,
                p95: 30,
                title: "Health ready",
                unit: "ms",
              },
            },
            scenario: "gateway",
            state: "clean",
          },
        ],
      },
      records: [{ scenario: "gateway", state: "clean", status: "PASS" }],
      summary: { statuses: { PASS: 1 } },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "invalid Kova report: missing sampled RSS metric in performance groups",
    );
  });

  it("renders available metrics from failed reports when CPU samples are absent", () => {
    const { output, result } = runSummary({
      performance: {
        repeat: 1,
        groups: [
          {
            metrics: {
              resourcePeakGatewayRssMb: {
                count: 1,
                max: 256,
                median: 256,
                p95: 256,
                title: "Gateway RSS",
                unit: "MB",
              },
              timeToHealthReadyMs: {
                count: 1,
                max: 30,
                median: 20,
                p95: 30,
                title: "Health ready",
                unit: "ms",
              },
            },
            scenario: "gateway",
            state: "clean",
          },
        ],
      },
      records: [{ scenario: "gateway", state: "clean", status: "FAIL" }],
      summary: { statuses: { FAIL: 1 } },
    });

    expect(result.status).toBe(0);
    expect(output).toContain("| gateway | clean | Gateway RSS | 256 MB | 256 MB | 256 MB |");
    expect(output).toContain("| gateway | clean | FAIL |");
  });

  it("rejects successful reports without CPU metrics", () => {
    const { result } = runSummary({
      performance: {
        repeat: 1,
        groups: [
          {
            metrics: {
              resourcePeakGatewayRssMb: {
                count: 1,
                max: 256,
                median: 256,
                p95: 256,
                title: "Gateway RSS",
                unit: "MB",
              },
            },
            scenario: "gateway",
            state: "clean",
          },
        ],
      },
      records: [{ scenario: "gateway", state: "clean", status: "PASS" }],
      summary: { statuses: { PASS: 1 } },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "invalid Kova report: missing sampled CPU metric in performance groups",
    );
  });

  it("omits malformed resource metrics instead of rejecting failure evidence", () => {
    const { output, result } = runSummary({
      performance: {
        repeat: 1,
        groups: [
          {
            metrics: {
              cpuPercentMax: {
                count: "Infinity",
                max: 12,
                median: 12,
                p95: 12,
                title: "CPU max",
                unit: "%",
              },
              resourcePeakGatewayRssMb: {
                count: true,
                max: 256,
                median: 256,
                p95: 256,
                title: "Gateway RSS",
                unit: "MB",
              },
            },
            scenario: "gateway",
            state: "clean",
          },
        ],
      },
      records: [{ scenario: "gateway", state: "clean", status: "FAIL" }],
      summary: { statuses: { FAIL: 1 } },
    });

    expect(result.status).toBe(0);
    expect(output).toContain("No sampled key metrics were available");
  });

  it("omits key metric rows with invalid sample counts", () => {
    const { output, result } = runSummary({
      performance: {
        repeat: 1,
        groups: [
          {
            metrics: {
              cpuPercentMax: {
                count: 1,
                max: 12,
                median: 12,
                p95: 12,
                title: "CPU max",
                unit: "%",
              },
              resourcePeakGatewayRssMb: {
                count: 1,
                max: 256,
                median: 256,
                p95: 256,
                title: "Gateway RSS",
                unit: "MB",
              },
              timeToHealthReadyMs: {
                count: "0",
                max: 30,
                median: 20,
                p95: 30,
                title: "Health ready",
                unit: "ms",
              },
            },
            scenario: "gateway",
            state: "clean",
          },
        ],
      },
      records: [{ scenario: "gateway", state: "clean", status: "pass" }],
      summary: { statuses: { pass: 1 } },
    });

    expect(result.status).toBe(0);
    expect(output).not.toContain("Health ready");
    expect(output).toContain("| gateway | clean | Gateway RSS | 256 MB | 256 MB | 256 MB |");
    expect(output).toContain("| gateway | clean | CPU max | 12 % | 12 % | 12 % |");
  });
});
