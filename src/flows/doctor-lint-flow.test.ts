import { describe, expect, it } from "vitest";
import { exitCodeFromFindings, runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck, HealthCheckContext } from "./health-checks.js";

const ctx: HealthCheckContext = {
  mode: "lint",
  runtime: {
    log() {},
    error() {},
    exit() {},
  },
  cfg: {},
};

function check(id: string, detect: HealthCheck["detect"]): HealthCheck {
  return {
    id,
    kind: "core",
    description: id,
    detect,
  };
}

describe("runDoctorLintChecks", () => {
  it("filters selected checks and reports skipped count", async () => {
    const result = await runDoctorLintChecks(ctx, {
      checks: [
        check("a", async () => [{ checkId: "a", severity: "warning", message: "warn" }]),
        check("b", async () => [{ checkId: "b", severity: "error", message: "err" }]),
      ],
      onlyIds: ["a"],
    });

    expect(result.checksRun).toBe(1);
    expect(result.checksSkipped).toBe(1);
    expect(result.findings.map((finding) => finding.checkId)).toEqual(["a"]);
  });

  it("turns thrown checks into error findings", async () => {
    const result = await runDoctorLintChecks(ctx, {
      checks: [
        check("boom", async () => {
          throw new Error("nope");
        }),
      ],
    });

    expect(result.findings).toEqual([
      {
        checkId: "boom",
        severity: "error",
        message: "health check threw: nope",
      },
    ]);
  });
});

describe("exitCodeFromFindings", () => {
  it("uses the selected severity threshold", () => {
    const findings = [{ checkId: "a", severity: "warning" as const, message: "warn" }];

    expect(exitCodeFromFindings(findings, "warning")).toBe(1);
    expect(exitCodeFromFindings(findings, "error")).toBe(0);
  });
});
