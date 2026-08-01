// Doctor lint flow tests cover lint diagnostics surfaced by doctor.
import { describe, expect, it } from "vitest";
import { exitCodeFromFindings, runDoctorLintChecks } from "./doctor-lint-flow.js";
import { normalizeHealthCheck } from "./health-check-adapter.js";
import type { RunnableHealthCheck } from "./health-check-runner-types.js";
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
    detect: detect ?? (async () => []),
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

  it("skips default-disabled checks unless explicitly selected", async () => {
    const defaultDisabled = normalizeHealthCheck({
      ...check("targeted", async () => [
        { checkId: "targeted", severity: "warning" as const, message: "warn" },
      ]),
      defaultEnabled: false,
    });

    await expect(
      runDoctorLintChecks(ctx, {
        checks: [defaultDisabled],
      }),
    ).resolves.toMatchObject({
      checksRun: 0,
      checksSkipped: 1,
      findings: [],
    });

    await expect(
      runDoctorLintChecks(ctx, {
        checks: [defaultDisabled],
        onlyIds: ["targeted"],
      }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "targeted" })],
    });
  });

  it("runs default-disabled checks when all checks are requested", async () => {
    const defaultDisabled = normalizeHealthCheck({
      ...check("targeted", async () => [
        { checkId: "targeted", severity: "warning" as const, message: "warn" },
      ]),
      defaultEnabled: false,
    });
    const defaultEnabled = check("regular", async () => []);

    const result = await runDoctorLintChecks(ctx, {
      checks: [defaultDisabled, defaultEnabled],
      includeAllChecks: true,
    });

    expect(result).toMatchObject({
      checksRun: 2,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "targeted" })],
    });
  });

  it("supports single-run checks in lint mode", async () => {
    const runnable: RunnableHealthCheck = {
      id: "run-check",
      kind: "core",
      description: "run check",
      async run(runCtx) {
        expect(runCtx).toMatchObject({
          mode: "lint",
          repair: false,
        });
        return {
          findings: [
            {
              checkId: "run-check",
              severity: "warning",
              message: "warn",
            },
          ],
        };
      },
    };
    const checkLocal = normalizeHealthCheck(runnable);

    const result = await runDoctorLintChecks(ctx, { checks: [checkLocal] });

    expect(result.findings.map((finding) => finding.checkId)).toEqual(["run-check"]);
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

  it("keeps truncated thrown error messages UTF-16 safe", async () => {
    const emoji = "\u{1F600}";
    const result = await runDoctorLintChecks(ctx, {
      checks: [
        check("emoji-boom", async () => {
          throw new Error(`${"A".repeat(252)}${emoji}${"B".repeat(10)}`);
        }),
      ],
    });

    expect(result.findings[0]?.message).toBe(`health check threw: ${"A".repeat(252)}...`);
  });
});

describe("exitCodeFromFindings", () => {
  it("uses the selected severity threshold", () => {
    const findings = [{ checkId: "a", severity: "warning" as const, message: "warn" }];

    expect(exitCodeFromFindings(findings, "warning")).toBe(1);
    expect(exitCodeFromFindings(findings, "error")).toBe(0);
  });

  it("does not fail default lint for informational findings", () => {
    const findings = [{ checkId: "a", severity: "info" as const, message: "info" }];

    expect(exitCodeFromFindings(findings)).toBe(0);
  });
});
