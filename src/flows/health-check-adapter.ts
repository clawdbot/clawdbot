// Health check adapter converts plugin health checks into doctor check records.
import type {
  HealthCheckInput,
  HealthCheckRunResult,
  RegisteredHealthCheck,
  SplitHealthCheckInput,
} from "./health-check-runner-types.js";
import type { HealthRepairContext } from "./health-checks.js";

// Adapts legacy split detect/repair checks and newer runnable checks to one runner contract.
/** Wraps a detect/repair health check in the runnable health-check contract. */
function defineSplitHealthCheck(check: SplitHealthCheckInput): RegisteredHealthCheck {
  return {
    id: check.id,
    kind: check.kind,
    description: check.description,
    source: check.source,
    defaultEnabled: check.defaultEnabled,
    sourceContract: "split",
    detect: (ctx, scope) => check.detect(ctx, scope),
    repair:
      check.repair === undefined
        ? undefined
        : (ctx, findings) => check.repair?.(ctx, findings) ?? Promise.resolve({ changes: [] }),
    async run(ctx, scope): Promise<HealthCheckRunResult> {
      const findings = await check.detect(ctx, scope);
      // Preview repair returns proposed changes without persisting config updates.
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

/** Normalizes any supported health-check shape before lint/fix execution. */
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
      defaultEnabled: check.defaultEnabled,
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
