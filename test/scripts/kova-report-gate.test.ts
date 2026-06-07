// Kova report gate tests cover tolerated PARTIAL performance verdict handling.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateToleratedPartialKovaReport } from "../../scripts/lib/kova-report-gate.mjs";

const tempRoots: string[] = [];
const SCRIPT_PATH = "scripts/lib/kova-report-gate.mjs";

function partialReport(overrides: Record<string, unknown> = {}) {
  return {
    baseline: { comparison: { regressionCount: 0 } },
    gate: { verdict: "PARTIAL", blockingCount: 0 },
    performance: {
      groups: [
        {
          metrics: {
            cpuPercentMax: { count: 1 },
            resourcePeakGatewayRssMb: { count: 1 },
          },
          scenario: "gateway",
          state: "clean",
        },
      ],
    },
    records: [{ scenario: "gateway", state: "clean", status: "PASS" }],
    summary: { statuses: { PASS: 3 } },
    ...overrides,
  };
}

function writeReport(report: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-kova-report-"));
  tempRoots.push(root);
  const reportPath = join(root, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  return reportPath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scripts/lib/kova-report-gate.mjs", () => {
  it("accepts partial reports only when selected scenarios passed", () => {
    expect(evaluateToleratedPartialKovaReport(partialReport())).toEqual({ ok: true });
  });

  it("rejects partial reports with missing status summaries", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          summary: {},
        }),
      ),
    ).toEqual({ ok: false, reason: "missing status summary" });
  });

  it("rejects partial reports without explicit blocking counts", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          gate: { verdict: "PARTIAL" },
        }),
      ),
    ).toEqual({ ok: false, reason: "missing blocking count" });
  });

  it("rejects partial reports with malformed zero-like blocking counts", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          gate: { blockingCount: "", verdict: "PARTIAL" },
        }),
      ),
    ).toEqual({ ok: false, reason: "missing blocking count" });
  });

  it("rejects partial reports without explicit baseline regression counts", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          baseline: {},
        }),
      ),
    ).toEqual({ ok: false, reason: "missing baseline regression count" });
  });

  it("rejects partial reports with malformed zero-like baseline regression counts", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          baseline: { comparison: { regressionCount: null } },
        }),
      ),
    ).toEqual({ ok: false, reason: "missing baseline regression count" });
  });

  it("rejects partial reports without PASS records", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          summary: { statuses: { PASS: 0 } },
        }),
      ),
    ).toEqual({ ok: false, reason: "status summary had no PASS records" });
  });

  it("rejects partial reports with non-pass records", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          summary: { statuses: { PASS: 2, FAIL: 1 } },
        }),
      ),
    ).toEqual({ ok: false, reason: "non-pass statuses present: FAIL=1" });
  });

  it("rejects partial reports without selected scenario records", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          records: [],
        }),
      ),
    ).toEqual({ ok: false, reason: "missing selected scenario records" });
  });

  it("rejects partial reports without performance groups", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          performance: {},
        }),
      ),
    ).toEqual({ ok: false, reason: "missing performance groups" });
  });

  it("rejects partial reports without sampled RSS metrics", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          performance: {
            groups: [
              {
                metrics: { cpuPercentMax: { count: 1 } },
                scenario: "gateway",
                state: "clean",
              },
            ],
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "missing sampled RSS metric in performance groups" });
  });

  it("rejects partial reports without sampled CPU metrics", () => {
    expect(
      evaluateToleratedPartialKovaReport(
        partialReport({
          performance: {
            groups: [
              {
                metrics: { resourcePeakGatewayRssMb: { count: 1 } },
                scenario: "gateway",
                state: "clean",
              },
            ],
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "missing sampled CPU metric in performance groups" });
  });

  it("exits non-zero for malformed tolerated-partial candidates", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, writeReport(partialReport({ summary: {} }))],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing status summary");
  });

  it("runs the CLI guard from paths that need file URL escaping", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kova report-"));
    tempRoots.push(root);
    const scriptDir = join(root, "script dir");
    mkdirSync(scriptDir);
    const scriptPath = join(scriptDir, "kova-report-gate.mjs");
    copyFileSync(SCRIPT_PATH, scriptPath);

    const result = spawnSync(
      process.execPath,
      [scriptPath, writeReport(partialReport({ summary: {} }))],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing status summary");
  });
});
