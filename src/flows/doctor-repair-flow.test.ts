import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthRepairs } from "./doctor-repair-flow.js";
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
  it("repairs modern checks and threads updated config", async () => {
    const scopes: unknown[] = [];
    const checks: HealthCheck[] = [
      {
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
      },
    ];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(result.config.gateway?.mode).toBe("local");
    expect(result.changes).toEqual(["Set gateway.mode to local."]);
    expect(result.checksRepaired).toBe(1);
    expect(result.checksValidated).toBe(1);
    expect(result.remainingFindings).toEqual([]);
    expect(scopes).toMatchObject([{ paths: ["gateway.mode"] }]);
  });

  it("leaves non-repairable checks for legacy doctor behavior", async () => {
    const checks: HealthCheck[] = [
      {
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
      },
    ];

    const result = await runDoctorHealthRepairs(ctx({}), { checks });

    expect(result.config).toEqual({});
    expect(result.findings).toHaveLength(1);
    expect(result.remainingFindings).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.checksRepaired).toBe(0);
    expect(result.checksValidated).toBe(0);
  });

  it("reports repair validation findings that remain after repair", async () => {
    const checks: HealthCheck[] = [
      {
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
      },
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

  it("does not validate skipped or failed repair results", async () => {
    let validationCalls = 0;
    const checks: HealthCheck[] = [
      {
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
      },
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
      {
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
      },
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
});
