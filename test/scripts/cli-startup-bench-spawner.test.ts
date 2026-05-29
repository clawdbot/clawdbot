import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATHS = [
  "scripts/test-cli-startup-bench-budget.mjs",
  "scripts/test-update-cli-startup-bench.mjs",
];

describe("CLI startup benchmark script spawners", () => {
  it("use the active Node executable for benchmark child processes", () => {
    for (const scriptPath of SCRIPT_PATHS) {
      const source = fs.readFileSync(path.resolve(process.cwd(), scriptPath), "utf8");

      expect(source).toContain("spawnSync(process.execPath, args");
      expect(source).not.toContain('spawnSync("node", args');
    }
  });

  it("builds the source CLI before generating a startup budget report", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/test-cli-startup-bench-budget.mjs"),
      "utf8",
    );

    expect(source).toContain(
      'spawnSync(process.execPath, ["scripts/ensure-cli-startup-build.mjs"]',
    );
    expect(source.indexOf("scripts/ensure-cli-startup-build.mjs")).toBeLessThan(
      source.indexOf("scripts/bench-cli-startup.ts"),
    );
  });

  it("does not require unrelated fixture cases for a narrowed preset", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-budget-test-"));
    try {
      const baselinePath = path.join(tmpDir, "baseline.json");
      const reportPath = path.join(tmpDir, "current.json");
      const makeCase = (id: string, name: string) => ({
        id,
        name,
        samples: [],
        summary: {
          durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
          firstOutputMs: null,
          maxRssMb: null,
        },
      });

      fs.writeFileSync(
        baselinePath,
        JSON.stringify({
          primary: { cases: [makeCase("version", "--version"), makeCase("realOnly", "real only")] },
        }),
      );
      fs.writeFileSync(
        reportPath,
        JSON.stringify({ primary: { cases: [makeCase("version", "--version")] } }),
      );

      expect(() =>
        execFileSync(
          process.execPath,
          [
            "scripts/test-cli-startup-bench-budget.mjs",
            "--baseline",
            baselinePath,
            "--report",
            reportPath,
            "--preset",
            "startup",
          ],
          { cwd: process.cwd(), stdio: "pipe" },
        ),
      ).not.toThrow();

      expect(() =>
        execFileSync(
          process.execPath,
          [
            "scripts/test-cli-startup-bench-budget.mjs",
            "--baseline",
            baselinePath,
            "--report",
            reportPath,
            "--preset",
            "all",
          ],
          { cwd: process.cwd(), stdio: "pipe" },
        ),
      ).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed startup budget env vars before reading reports", () => {
    const result = spawnSync(process.execPath, ["scripts/test-cli-startup-bench-budget.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_STARTUP_BENCH_MAX_RSS_REGRESSION_PCT: "20pct",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_STARTUP_BENCH_MAX_RSS_REGRESSION_PCT must be a non-negative number",
    );
    expect(result.stderr).not.toContain("at ");
  });

  it("rejects malformed startup budget CLI values before reading reports", () => {
    const malformed = spawnSync(
      process.execPath,
      ["scripts/test-cli-startup-bench-budget.mjs", "--max-duration-regression-pct", "1e2ms"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toContain(
      "--max-duration-regression-pct must be a non-negative number",
    );
    expect(malformed.stderr).not.toContain("at ");

    const missing = spawnSync(
      process.execPath,
      ["scripts/test-cli-startup-bench-budget.mjs", "--max-first-output-regression-pct"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("--max-first-output-regression-pct requires a value");
    expect(missing.stderr).not.toContain("at ");
  });
});
