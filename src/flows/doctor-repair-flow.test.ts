import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthRepairs } from "./doctor-repair-flow.js";
import { defineSplitHealthCheck, normalizeHealthCheck } from "./health-check-adapter.js";
import type { RunnableHealthCheck } from "./health-check-runner-types.js";
import type { HealthCheck, HealthRepairContext } from "./health-checks.js";

function ctx(cfg: OpenClawConfig): HealthRepairContext {
  return {
    mode: "fix",
    runtime: {
      log() {},
      error() {},
      exit() {},
    },
    cfg,
  };
}

describe("runDoctorHealthRepairs", () => {
  it("repairs single-run checks and validates through lint mode", async () => {
    const runModes: string[] = [];
    const scopes: unknown[] = [];
    const runnable: RunnableHealthCheck = {
      id: "test/run-repairable",
      kind: "core",
      description: "run repairable",
      async run(ctx, scope) {
        runModes.push(ctx.mode);
        if (scope !== undefined) {
          scopes.push(scope);
        }
        const findings =
          ctx.cfg.gateway?.mode === "local"
            ? []
            : [
                {
                  checkId: "test/run-repairable",
                  severity: "warning" as const,
                  message: "gateway mode missing",
                  path: "gateway.mode",
                },
              ];
        if (!ctx.repair || findings.length === 0) {
          return { findings };
        }
        return {
          findings,
          config: { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, mode: "local" } },
          changes: ["Set gateway.mode to local."],
        };
      },
    };
    const checks: HealthCheck[] = [normalizeHealthCheck(runnable)];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(result.config.gateway?.mode).toBe("local");
    expect(result.changes).toEqual(["Set gateway.mode to local."]);
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([]);
    expect(runModes).toEqual(["fix", "lint"]);
    expect(scopes).toMatchObject([{ paths: ["gateway.mode"] }]);
  });

  it("repairs modern checks and threads updated config", async () => {
    const scopes: unknown[] = [];
    const checks: HealthCheck[] = [
      defineSplitHealthCheck({
        id: "test/repairable",
        kind: "core",
        description: "repairable",
        async detect(ctx, scope) {
          if (scope !== undefined) {
            scopes.push(scope);
          }
          return ctx.cfg.gateway?.mode === "local"
            ? []
            : [
                {
                  checkId: "test/repairable",
                  severity: "warning",
                  message: "gateway mode missing",
                  path: "gateway.mode",
                },
              ];
        },
        async repair(ctx) {
          return {
            config: { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, mode: "local" } },
            changes: ["Set gateway.mode to local."],
          };
        },
      }),
    ];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(result.config.gateway?.mode).toBe("local");
    expect(result.changes).toEqual(["Set gateway.mode to local."]);
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([]);
    expect(scopes).toMatchObject([{ paths: ["gateway.mode"] }]);
  });

  it("keeps repairable out of split repair result types", () => {
    const check = defineSplitHealthCheck({
      id: "test/repair-result-status-boundary",
      kind: "core",
      description: "repair result status boundary",
      async detect() {
        return [
          {
            checkId: "test/repair-result-status-boundary",
            severity: "warning",
            message: "needs repair",
          },
        ];
      },
      // @ts-expect-error repairable is a run-result preview status, not a split repair result.
      async repair() {
        return {
          status: "repairable",
          changes: [],
        };
      },
    });

    expect(check.id).toBe("test/repair-result-status-boundary");
  });

  it("leaves non-repairable checks for legacy doctor behavior", async () => {
    const checks: HealthCheck[] = [
      defineSplitHealthCheck({
        id: "test/legacy-only",
        kind: "core",
        description: "legacy only",
        async detect() {
          return [
            {
              checkId: "test/legacy-only",
              severity: "warning",
              message: "legacy repair still owns this finding",
            },
          ];
        },
      }),
    ];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(result.config).toEqual({});
    expect(result.findings).toHaveLength(1);
    expect(result.remainingFindings).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.checksRepaired).toBe(0);
    expect(result.checksValidated).toBe(0);
  });

  it("keeps split check findings when repair throws", async () => {
    const checks: HealthCheck[] = [
      defineSplitHealthCheck({
        id: "test/repair-throws",
        kind: "core",
        description: "repair throws",
        async detect() {
          return [
            {
              checkId: "test/repair-throws",
              severity: "warning",
              message: "needs repair",
              path: "gateway.mode",
            },
          ];
        },
        async repair() {
          throw new Error("repair exploded");
        },
      }),
    ];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(result.findings).toMatchObject([
      {
        checkId: "test/repair-throws",
        path: "gateway.mode",
      },
    ]);
    expect(result.warnings).toEqual(["test/repair-throws repair failed: repair exploded"]);
    expect(result.checksRepaired).toBe(0);
    expect(result.checksValidated).toBe(0);
  });

  it("reports repair validation findings that remain after repair", async () => {
    const checks: HealthCheck[] = [
      defineSplitHealthCheck({
        id: "test/not-fixed",
        kind: "core",
        description: "not fixed",
        async detect() {
          return [
            {
              checkId: "test/not-fixed",
              severity: "warning",
              message: "still broken",
              ocPath: "oc://openclaw.json/gateway.mode",
            },
          ];
        },
        async repair() {
          return {
            changes: ["Tried repair."],
          };
        },
      }),
    ];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toMatchObject([
      {
        checkId: "test/not-fixed",
        ocPath: "oc://openclaw.json/gateway.mode",
      },
    ]);
    expect(result.warnings).toEqual(["test/not-fixed repair left 1 finding(s)"]);
  });

  it("validates successful repairs by default", async () => {
    let detectCalls = 0;
    const checks: HealthCheck[] = [
      defineSplitHealthCheck({
        id: "test/no-default-validation",
        kind: "core",
        description: "no default validation",
        async detect() {
          detectCalls++;
          return [
            {
              checkId: "test/no-default-validation",
              severity: "warning",
              message: "needs repair",
            },
          ];
        },
        async repair() {
          return {
            changes: ["Ran repair."],
          };
        },
      }),
    ];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(detectCalls).toBe(2);
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([
      {
        checkId: "test/no-default-validation",
        severity: "warning",
        message: "needs repair",
      },
    ]);
  });

  it("does not validate skipped or failed repair results", async () => {
    let validationCalls = 0;
    const checks: HealthCheck[] = [
      defineSplitHealthCheck({
        id: "test/skipped",
        kind: "core",
        description: "skipped",
        async detect() {
          validationCalls++;
          return [
            {
              checkId: "test/skipped",
              severity: "warning",
              message: "needs manual repair",
            },
          ];
        },
        async repair() {
          return {
            status: "skipped",
            reason: "manual confirmation required",
            changes: [],
          };
        },
      }),
    ];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(validationCalls).toBe(1);
    expect(result.checksRepaired).toBe(0);
    expect(result.checksValidated).toBe(0);
    expect(result.remainingFindings).toEqual([]);
    expect(result.warnings).toEqual(["test/skipped repair skipped: manual confirmation required"]);
  });

  it("supports dry-run repairs without applying returned config or validating", async () => {
    const repairContexts: HealthRepairContext[] = [];
    let detectCalls = 0;
    const checks: HealthCheck[] = [
      defineSplitHealthCheck({
        id: "test/dry-run",
        kind: "core",
        description: "dry run",
        async detect(ctx) {
          detectCalls++;
          return ctx.cfg.gateway?.mode === "local"
            ? []
            : [
                {
                  checkId: "test/dry-run",
                  severity: "warning",
                  message: "gateway mode missing",
                  path: "gateway.mode",
                },
              ];
        },
        async repair(ctx) {
          repairContexts.push(ctx);
          return {
            config: { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, mode: "local" } },
            changes: ["Would set gateway.mode to local."],
            diffs: [
              {
                kind: "config",
                path: "gateway.mode",
                before: undefined,
                after: "local",
              },
            ],
            effects: [
              {
                kind: "config",
                action: "would-set",
                target: "gateway.mode",
                dryRunSafe: true,
              },
            ],
          };
        },
      }),
    ];

    const result = await runDoctorHealthRepairs(ctx({}), {
      checks,
      dryRun: true,
      diff: true,
    });

    expect(result.config).toEqual({});
    expect(result.changes).toEqual(["Would set gateway.mode to local."]);
    expect(result.diffs).toMatchObject([{ kind: "config", path: "gateway.mode" }]);
    expect(result.effects).toMatchObject([{ kind: "config", action: "would-set" }]);
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(0);
    expect(detectCalls).toBe(1);
    expect(repairContexts[0]).toMatchObject({ dryRun: true, diff: true });
  });

  it("passes diff false and true through the repair API", async () => {
    const repairContexts: HealthRepairContext[] = [];
    const checks: HealthCheck[] = [
      defineSplitHealthCheck({
        id: "test/diff-preview",
        kind: "core",
        description: "diff preview",
        async detect() {
          return [
            {
              checkId: "test/diff-preview",
              severity: "warning",
              message: "config needs repair",
              path: "gateway.mode",
            },
          ];
        },
        async repair(ctx) {
          repairContexts.push(ctx);
          return {
            changes: ["Would set gateway.mode to local."],
            diffs:
              ctx.diff === true
                ? [
                    {
                      kind: "config",
                      path: "gateway.mode",
                      before: undefined,
                      after: "local",
                    },
                  ]
                : [],
          };
        },
      }),
    ];

    const withoutDiff = await runDoctorHealthRepairs(ctx({}), {
      checks,
      dryRun: true,
      diff: false,
    });
    const withDiff = await runDoctorHealthRepairs(ctx({}), {
      checks,
      dryRun: true,
      diff: true,
    });

    expect(repairContexts[0]).toMatchObject({ dryRun: true, diff: false });
    expect(withoutDiff.diffs).toEqual([]);
    expect(repairContexts[1]).toMatchObject({ dryRun: true, diff: true });
    expect(withDiff.diffs).toMatchObject([{ kind: "config", path: "gateway.mode" }]);
  });
});
