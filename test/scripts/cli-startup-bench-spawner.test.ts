// Cli Startup Bench Spawner tests cover cli startup bench spawner script behavior.
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
        samples: [{ ms: 10, firstOutputMs: 5, maxRssMb: 10, exitCode: 0, signal: null }],
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
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              OPENCLAW_STARTUP_BENCH_ENFORCE_NONCANONICAL_ARCH: "1",
            },
            stdio: "pipe",
          },
        ),
      ).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects narrowed preset reports with no matching current cases", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-budget-empty-test-"));
    try {
      const baselinePath = path.join(tmpDir, "baseline.json");
      const reportPath = path.join(tmpDir, "current.json");
      fs.writeFileSync(
        baselinePath,
        JSON.stringify({
          primary: {
            cases: [
              {
                id: "gatewayStatusJson",
                name: "gateway status --json",
                samples: [{ ms: 10, firstOutputMs: 5, maxRssMb: 10, exitCode: 0, signal: null }],
                summary: {
                  durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
                  firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
                  maxRssMb: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
                },
              },
            ],
          },
        }),
      );
      fs.writeFileSync(reportPath, JSON.stringify({ primary: { cases: [] } }));

      const result = spawnSync(
        process.execPath,
        [
          "scripts/test-cli-startup-bench-budget.mjs",
          "--baseline",
          baselinePath,
          "--report",
          reportPath,
          "--preset",
          "real",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "[test-cli-startup-bench-budget] current report has no cases for preset real",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects narrowed preset reports with unrelated current cases when baseline checks run", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-budget-overlap-test-"));
    try {
      const baselinePath = path.join(tmpDir, "baseline.json");
      const reportPath = path.join(tmpDir, "current.json");
      const makeCase = (id: string, name: string) => ({
        id,
        name,
        samples: [{ ms: 10, firstOutputMs: 5, maxRssMb: 10, exitCode: 0, signal: null }],
        summary: {
          durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
          firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
          maxRssMb: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
        },
      });

      fs.writeFileSync(
        baselinePath,
        JSON.stringify({ primary: { cases: [makeCase("fixtureOnly", "fixture only")] } }),
      );
      fs.writeFileSync(
        reportPath,
        JSON.stringify({ primary: { cases: [makeCase("targetOnly", "target only")] } }),
      );

      const result = spawnSync(
        process.execPath,
        [
          "scripts/test-cli-startup-bench-budget.mjs",
          "--baseline",
          baselinePath,
          "--report",
          reportPath,
          "--preset",
          "real",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_STARTUP_BENCH_ENFORCE_NONCANONICAL_ARCH: "1",
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "[test-cli-startup-bench-budget] no current cases matched the baseline for preset real",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows skip-baseline reports without fixture case overlap", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-budget-skip-test-"));
    try {
      const baselinePath = path.join(tmpDir, "baseline.json");
      const reportPath = path.join(tmpDir, "current.json");
      const makeCase = (id: string, name: string) => ({
        id,
        name,
        samples: [{ ms: 10, firstOutputMs: 5, maxRssMb: 10, exitCode: 0, signal: null }],
        summary: {
          durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
          firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
          maxRssMb: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
        },
      });

      fs.writeFileSync(
        baselinePath,
        JSON.stringify({ primary: { cases: [makeCase("fixtureOnly", "fixture only")] } }),
      );
      fs.writeFileSync(
        reportPath,
        JSON.stringify({ primary: { cases: [makeCase("targetOnly", "target only")] } }),
      );

      const result = spawnSync(
        process.execPath,
        [
          "scripts/test-cli-startup-bench-budget.mjs",
          "--baseline",
          baselinePath,
          "--report",
          reportPath,
          "--preset",
          "real",
          "--skip-baseline",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("no current cases matched the baseline");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips x64 startup budgets on noncanonical architectures", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-budget-arch-test-"));
    try {
      const archShimPath = path.join(tmpDir, "arch-shim.mjs");
      const baselinePath = path.join(tmpDir, "baseline.json");
      const reportPath = path.join(tmpDir, "current.json");
      const slowCase = {
        id: "slow",
        name: "slow",
        contract: {
          firstOutputBudgetMs: 20,
          exitBudgetMs: 20,
        },
        samples: [{ ms: 10, firstOutputMs: 10, maxRssMb: 100, exitCode: 0, signal: null }],
        summary: {
          durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
          firstOutputMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
          maxRssMb: { avg: 100, p50: 100, p95: 100, min: 100, max: 100 },
        },
      };
      fs.writeFileSync(
        archShimPath,
        'Object.defineProperty(process, "arch", { value: "arm64" });\n',
      );
      fs.writeFileSync(
        baselinePath,
        JSON.stringify({
          primary: {
            cases: [
              {
                ...slowCase,
                summary: {
                  ...slowCase.summary,
                  durationMs: { avg: 1, p50: 1, p95: 1, min: 1, max: 1 },
                },
              },
            ],
          },
        }),
      );
      fs.writeFileSync(reportPath, JSON.stringify({ primary: { cases: [slowCase] } }));

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          archShimPath,
          "scripts/test-cli-startup-bench-budget.mjs",
          "--baseline",
          baselinePath,
          "--report",
          reportPath,
          "--preset",
          "all",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("skipping x64 startup fixture budgets on arm64");
      expect(result.stderr).not.toContain("exceeded");

      const slowResponseCase = {
        ...slowCase,
        contract: {
          firstOutputBudgetMs: 1,
          exitBudgetMs: 1,
        },
      };
      fs.writeFileSync(baselinePath, JSON.stringify({ primary: { cases: [slowResponseCase] } }));
      fs.writeFileSync(reportPath, JSON.stringify({ primary: { cases: [slowResponseCase] } }));
      const responseBudgetResult = spawnSync(
        process.execPath,
        [
          "--import",
          archShimPath,
          "scripts/test-cli-startup-bench-budget.mjs",
          "--baseline",
          baselinePath,
          "--report",
          reportPath,
          "--preset",
          "all",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(responseBudgetResult.status).toBe(1);
      expect(responseBudgetResult.stderr).toContain("first output 10.0ms exceeded contract 1.0ms");

      fs.writeFileSync(reportPath, JSON.stringify({ primary: { cases: [] } }));
      const missingCaseResult = spawnSync(
        process.execPath,
        [
          "--import",
          archShimPath,
          "scripts/test-cli-startup-bench-budget.mjs",
          "--baseline",
          baselinePath,
          "--report",
          reportPath,
          "--preset",
          "all",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(missingCaseResult.status).toBe(1);
      expect(missingCaseResult.stderr).toContain("missing current case slow");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails reused reports with timed-out samples", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-budget-timeout-test-"));
    try {
      const baselinePath = path.join(tmpDir, "baseline.json");
      const reportPath = path.join(tmpDir, "current.json");
      const timedOutCase = {
        id: "version",
        name: "--version",
        contract: {
          firstOutputBudgetMs: 1000,
          exitBudgetMs: 2000,
        },
        samples: [
          {
            ms: 10,
            firstOutputMs: 5,
            maxRssMb: 10,
            exitCode: 0,
            signal: null,
            timedOut: true,
          },
        ],
        summary: {
          durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
          firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
          maxRssMb: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
        },
      };
      fs.writeFileSync(baselinePath, JSON.stringify({ primary: { cases: [timedOutCase] } }));
      fs.writeFileSync(reportPath, JSON.stringify({ primary: { cases: [timedOutCase] } }));

      const result = spawnSync(
        process.execPath,
        [
          "scripts/test-cli-startup-bench-budget.mjs",
          "--baseline",
          baselinePath,
          "--report",
          reportPath,
          "--skip-baseline",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[test-cli-startup-bench-budget] --version timed out.");
      expect(result.stderr).toContain(
        "[test-cli-startup-bench-budget] --version exited timeout; response contract requires a clean exit.",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails reused reports with missing RSS samples", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-budget-rss-test-"));
    try {
      const baselinePath = path.join(tmpDir, "baseline.json");
      const reportPath = path.join(tmpDir, "current.json");
      const missingRssCase = {
        id: "version",
        name: "--version",
        samples: [{ ms: 10, firstOutputMs: 5, maxRssMb: null, exitCode: 0, signal: null }],
        summary: {
          durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
          firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
          maxRssMb: null,
        },
      };
      fs.writeFileSync(baselinePath, JSON.stringify({ primary: { cases: [missingRssCase] } }));
      fs.writeFileSync(reportPath, JSON.stringify({ primary: { cases: [missingRssCase] } }));

      const result = spawnSync(
        process.execPath,
        [
          "scripts/test-cli-startup-bench-budget.mjs",
          "--baseline",
          baselinePath,
          "--report",
          reportPath,
          "--skip-baseline",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "[test-cli-startup-bench-budget] --version did not report max RSS.",
      );
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
