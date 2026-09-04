// Qa report cli tests cover source entrypoint operator errors.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

function runSourceScript(scriptPath: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

describe("QA report source CLIs", () => {
  it("forwards cross-harness mode to the comparison report instead of the release parity gate", () => {
    const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "qa-source-comparison-")));
    try {
      writeFileSync(path.join(scratch, "candidate.json"), "{}");
      writeFileSync(path.join(scratch, "baseline.json"), "{}");
      const result = runSourceScript(
        "scripts/qa-parity-report.ts",
        "--cross-harness",
        "--repo-root",
        scratch,
        "--candidate-summary",
        "candidate.json",
        "--baseline-summary",
        "baseline.json",
        "--output-dir",
        "out",
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("QA cross-harness conditions: not-comparable");
      const report = JSON.parse(
        readFileSync(path.join(scratch, "out/qa-cross-harness-comparison.json"), "utf8"),
      );
      expect(report).toEqual({
        status: "not-comparable",
        reasons: [
          "Candidate lacks valid completed-run comparison metadata.",
          "Baseline lacks valid completed-run comparison metadata.",
        ],
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  it("prints QA coverage help without an error", () => {
    const result = runSourceScript("scripts/qa-coverage-report.ts", "--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: openclaw qa coverage");
    expect(result.stderr).toBe("");
  });

  it("prints QA parity help without an error", () => {
    const result = runSourceScript("scripts/qa-parity-report.ts", "--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: openclaw qa parity-report");
    expect(result.stderr).toBe("");
  });

  it("reports unknown QA coverage options without a Node stack trace", () => {
    const result = runSourceScript("scripts/qa-coverage-report.ts", "--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown qa coverage option: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("rejects duplicate QA coverage artifact destinations without a Node stack trace", () => {
    const result = runSourceScript(
      "scripts/qa-coverage-report.ts",
      "--output",
      ".artifacts/first.md",
      "--output=.artifacts/second.md",
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--output was provided more than once");
    expectNoNodeStack(result.stderr);
  });

  it("reports unknown QA parity options without a Node stack trace", () => {
    const result = runSourceScript("scripts/qa-parity-report.ts", "--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown qa parity-report option: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("rejects duplicate QA parity artifact destinations without a Node stack trace", () => {
    const result = runSourceScript(
      "scripts/qa-parity-report.ts",
      "--candidate-summary",
      "candidate.json",
      "--baseline-summary",
      "baseline.json",
      "--output-dir",
      ".artifacts/first",
      "--output-dir=.artifacts/second",
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--output-dir was provided more than once");
    expectNoNodeStack(result.stderr);
  });

  it("reports missing QA parity inputs without a Node stack trace", () => {
    const result = runSourceScript("scripts/qa-parity-report.ts");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--candidate-summary is required.");
    expectNoNodeStack(result.stderr);
  });

  it("reports missing runtime-axis QA parity summary without a Node stack trace", () => {
    const result = runSourceScript("scripts/qa-parity-report.ts", "--runtime-axis");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--summary is required when --runtime-axis is set.");
    expectNoNodeStack(result.stderr);
  });
});
