// Doctor lint flow tests cover lint diagnostics surfaced by doctor.
import { describe, expect, it } from "vitest";
import {
  exitCodeFromFindings,
  runDoctorLintChecks,
  selectUpdateReadinessChecks,
} from "./doctor-lint-flow.js";
import { normalizeHealthCheck } from "./health-check-adapter.js";
import {
  clearHealthChecksForTest,
  listHealthChecks,
  registerHealthCheck,
} from "./health-check-registry.js";
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

  it.each(["array", "set"] as const)(
    "reports conflicting selectors for a registered health check (%s)",
    async (selectorShape) => {
      const checkId = "plugin/example/critical";
      let detections = 0;
      const existingChecks = listHealthChecks();
      registerHealthCheck(
        check(checkId, async () => {
          detections += 1;
          return [{ checkId, severity: "error", message: "critical failure" }];
        }),
      );

      try {
        const selectors = selectorShape === "set" ? new Set([checkId]) : [checkId];
        const result = await runDoctorLintChecks(ctx, {
          onlyIds: selectors,
          skipIds: selectors,
        });

        expect(detections).toBe(0);
        expect(result.checksRun).toBe(0);
        expect(result.checksSkipped).toBe(1);
        expect(result.findings).toEqual([
          {
            checkId: "core/doctor/lint-selection",
            severity: "error",
            message: `Health check ${checkId} cannot be selected by --only and excluded by --skip.`,
            path: checkId,
          },
        ]);
        expect(exitCodeFromFindings(result.findings)).toBe(1);
      } finally {
        clearHealthChecksForTest();
        for (const existingCheck of existingChecks) {
          registerHealthCheck(existingCheck);
        }
      }
    },
  );

  it.each(["array", "set"] as const)(
    "runs surviving selected checks when selectors only partially overlap (%s)",
    async (selectorShape) => {
      const skippedId = "plugin/example/skipped";
      const selectedId = "plugin/example/selected";
      const detections: string[] = [];
      const ids = [skippedId, selectedId];
      const result = await runDoctorLintChecks(ctx, {
        checks: ids.map((id) =>
          check(id, async () => {
            detections.push(id);
            return [];
          }),
        ),
        onlyIds: selectorShape === "set" ? new Set(ids) : ids,
        skipIds: selectorShape === "set" ? new Set([skippedId]) : [skippedId],
      });

      expect(result).toEqual({ findings: [], checksRun: 1, checksSkipped: 1 });
      expect(detections).toEqual([selectedId]);
      expect(exitCodeFromFindings(result.findings)).toBe(0);
    },
  );

  it("retains every overlap diagnostic when exclusion removes all selected checks", async () => {
    const ids = ["plugin/example/first", "plugin/example/second"];
    const result = await runDoctorLintChecks(ctx, {
      checks: ids.map((id) => check(id, async () => [])),
      onlyIds: ids,
      skipIds: ids,
    });

    expect(result.checksRun).toBe(0);
    expect(result.checksSkipped).toBe(2);
    expect(result.findings).toEqual(
      ids.map((id) => ({
        checkId: "core/doctor/lint-selection",
        severity: "error",
        message: `Health check ${id} cannot be selected by --only and excluded by --skip.`,
        path: id,
      })),
    );
    expect(exitCodeFromFindings(result.findings)).toBe(1);
  });

  it("keeps unknown-only diagnostics without treating partial overlap as an error", async () => {
    const skippedId = "plugin/example/skipped";
    const selectedId = "plugin/example/selected";
    const unknownId = "plugin/future/not-loaded";
    const detections: string[] = [];
    const result = await runDoctorLintChecks(ctx, {
      checks: [skippedId, selectedId].map((id) =>
        check(id, async () => {
          detections.push(id);
          return [];
        }),
      ),
      onlyIds: [skippedId, unknownId, selectedId],
      skipIds: [skippedId, "plugin/future/ignored"],
    });

    expect(result.checksRun).toBe(1);
    expect(result.checksSkipped).toBe(1);
    expect(detections).toEqual([selectedId]);
    expect(result.findings).toEqual([
      {
        checkId: "core/doctor/lint-selection",
        severity: "error",
        message: `Unknown health check id selected by --only: ${unknownId}.`,
        path: unknownId,
      },
    ]);
    expect(exitCodeFromFindings(result.findings)).toBe(1);
  });

  it("keeps non-conflicting selection and exclusion filters independent", async () => {
    let selectedDetections = 0;
    let skippedDetections = 0;
    const result = await runDoctorLintChecks(ctx, {
      checks: [
        check("plugin/example/selected", async () => {
          selectedDetections += 1;
          return [];
        }),
        check("plugin/example/skipped", async () => {
          skippedDetections += 1;
          return [];
        }),
      ],
      onlyIds: ["plugin/example/selected"],
      skipIds: ["plugin/example/skipped"],
    });

    expect(result).toEqual({ findings: [], checksRun: 1, checksSkipped: 1 });
    expect(selectedDetections).toBe(1);
    expect(skippedDetections).toBe(0);
  });

  it("preserves forward-compatible skips for unregistered plugin checks", async () => {
    let detections = 0;
    const result = await runDoctorLintChecks(ctx, {
      checks: [
        check("plugin/example/available", async () => {
          detections += 1;
          return [];
        }),
      ],
      skipIds: ["plugin/future/not-loaded"],
    });

    expect(result).toEqual({ findings: [], checksRun: 1, checksSkipped: 0 });
    expect(detections).toBe(1);
    expect(exitCodeFromFindings(result.findings)).toBe(0);
  });

  it("skips default-disabled checks unless explicitly selected", async () => {
    const defaultDisabled = normalizeHealthCheck({
      ...check("targeted", async () => [
        { checkId: "targeted", severity: "warning" as const, message: "warn" },
      ]),
      defaultEnabled: false,
      sourceContract: "split",
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
      sourceContract: "split",
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

  it("runs only checks that own the selected update-readiness phase", async () => {
    const detections: string[] = [];
    const checks = [
      Object.assign(
        check("plugin/example/post-plugin", async () => {
          detections.push("post-plugin");
          return [];
        }),
        { updateReadiness: "post-plugin" as const },
      ),
      check("plugin/example/default", async () => {
        detections.push("default");
        return [];
      }),
    ];

    const result = await runDoctorLintChecks(ctx, {
      checks: selectUpdateReadinessChecks(checks, "post-plugin"),
    });

    expect(result).toEqual({ findings: [], checksRun: 1, checksSkipped: 0 });
    expect(detections).toEqual(["post-plugin"]);
  });

  it("supports single-run checks in lint mode", async () => {
    const runnable: RunnableHealthCheck = {
      sourceContract: "run",
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
