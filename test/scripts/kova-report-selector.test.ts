import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectKovaReport } from "../../scripts/lib/kova-report-selector.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const SCRIPT_PATH = "scripts/lib/kova-report-selector.mjs";

function reportDir() {
  const root = tempRoots.make("openclaw-kova-report-selector-");
  const dir = join(root, "reports");
  mkdirSync(dir);
  return dir;
}

describe("Kova report selector", () => {
  it("selects the full report when Kova also writes its summary", () => {
    const dir = reportDir();
    const report = join(dir, "kova-run-release.json");
    writeFileSync(report, '{"schemaVersion":"kova.report.v1"}\n');
    writeFileSync(
      join(dir, "kova-run-release.summary.json"),
      '{"schemaVersion":"kova.report.summary.v1"}\n',
    );

    expect(selectKovaReport(dir)).toBe(report);
    const cli = spawnSync(process.execPath, [SCRIPT_PATH, "--report-dir", dir], {
      encoding: "utf8",
    });
    expect(cli).toMatchObject({ status: 0, stderr: "", stdout: `${report}\n` });
  });

  it("fails closed without a full report", () => {
    const dir = reportDir();
    writeFileSync(
      join(dir, "kova-run-release.summary.json"),
      '{"schemaVersion":"kova.report.summary.v1"}\n',
    );

    expect(() => selectKovaReport(dir)).toThrow(
      "expected exactly one full Kova JSON report; found 0",
    );
  });

  it("fails closed with multiple full reports", () => {
    const dir = reportDir();
    writeFileSync(join(dir, "kova-run-a.json"), "{}\n");
    writeFileSync(join(dir, "kova-run-b.json"), "{}\n");

    expect(() => selectKovaReport(dir)).toThrow(
      "expected exactly one full Kova JSON report; found 2",
    );
  });

  it("rejects an empty full report", () => {
    const dir = reportDir();
    writeFileSync(join(dir, "kova-run-release.json"), "");

    expect(() => selectKovaReport(dir)).toThrow("full Kova JSON report is empty");
  });
});
