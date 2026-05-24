import type {
  HealthCheckInput,
  HealthCheckRunResult,
  RegisteredHealthCheck,
} from "./health-check-runner-types.js";
import type { HealthCheck, HealthRepairContext } from "./health-checks.js";

export function defineSplitHealthCheck(check: HealthCheck): RegisteredHealthCheck {
  return {
    id: check.id,
    kind: check.kind,
    description: check.description,
    source: check.source,
    sourceContract: "split",
    detect: (ctx, scope) => check.detect(ctx, scope),
    repair:
      check.repair === undefined
        ? undefined
        : (ctx, findings) => check.repair?.(ctx, findings) ?? Promise.resolve({ changes: [] }),
    async run(ctx, scope): Promise<HealthCheckRunResult> {
      const findings = await check.detect(ctx, scope);
      if (
        findings.length === 0 ||
        check.repair === undefined ||
        (!ctx.repair && ctx.previewRepair !== true)
      ) {
        return { findings };
      }
      const repairResult = await check.repair(
        {
          ...ctx,
          mode: "fix",
          dryRun: !ctx.repair,
          diff: ctx.diff === true,
        } as HealthRepairContext,
        findings,
      );
      return {
        findings,
        config: ctx.repair ? repairResult.config : undefined,
        changes: repairResult.changes,
        warnings: repairResult.warnings,
        diffs: repairResult.diffs,
        effects: repairResult.effects,
        status: ctx.repair ? repairResult.status : (repairResult.status ?? "repairable"),
        reason: repairResult.reason,
      };
    },
  };
}

export function normalizeHealthCheck(check: HealthCheckInput): RegisteredHealthCheck {
  if (
    "detect" in check &&
    check.detect !== undefined &&
    "run" in check &&
    check.run !== undefined &&
    "sourceContract" in check
  ) {
    return check as RegisteredHealthCheck;
  }
  if ("detect" in check && check.detect !== undefined) {
    return defineSplitHealthCheck(check);
  }
  if ("run" in check && check.run !== undefined) {
    return {
      id: check.id,
      kind: check.kind,
      description: check.description,
      source: check.source,
      sourceContract: "run",
      async detect(ctx, scope) {
        const result = await check.run({ ...ctx, repair: false }, scope);
        return result.findings ?? [];
      },
      run: (ctx, scope) => check.run(ctx, scope),
    };
  }
  throw new Error(`health check ${check.id} must define run() or detect()`);
}
