// Doctor repair flow builds and runs repair actions for doctor findings.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";
import { copyHealthCheck, normalizeHealthCheck } from "./health-check-adapter.js";
import { listHealthChecks } from "./health-check-registry.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type {
  HealthFinding,
  HealthRepairContext,
  HealthRepairDiff,
  HealthRepairEffect,
} from "./health-checks.js";

// Repair runner for structured doctor health checks; carries config between checks.
interface DoctorRepairRunOptions {
  readonly checks?: readonly DoctorHealthCheck[];
  readonly dryRun?: boolean;
  readonly diff?: boolean;
}

interface DoctorRepairRunResult {
  readonly config: OpenClawConfig;
  readonly findings: readonly HealthFinding[];
  readonly remainingFindings: readonly HealthFinding[];
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
  readonly diffs: readonly HealthRepairDiff[];
  readonly effects: readonly HealthRepairEffect[];
  readonly checksRun: number;
  readonly checksRepaired: number;
  readonly checksValidated: number;
}

/** Runs health checks in fix mode, applies repair outputs, and validates repaired scopes. */
export async function runDoctorHealthRepairs(
  ctx: HealthRepairContext,
  opts: DoctorRepairRunOptions = {},
): Promise<DoctorRepairRunResult> {
  const inputs = opts.checks ?? listHealthChecks().map(copyHealthCheck);
  const checks: readonly DoctorHealthCheck[] = inputs.map(normalizeHealthCheck);
  const findings: HealthFinding[] = [];
  const remainingFindings: HealthFinding[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  const diffs: HealthRepairDiff[] = [];
  const effects: HealthRepairEffect[] = [];
  let cfg = ctx.cfg;
  let checksRepaired = 0;
  let checksValidated = 0;

  for (const check of checks) {
    const detectCtx: HealthRepairContext = { ...ctx, cfg };
    const runResult = await runHealthCheck(check, detectCtx, opts);
    cfg = runResult.config;
    findings.push(...runResult.findings);
    // Only a completed validation can replace this check's original findings;
    // skipped, failed, and unvalidated siblings must remain visible in mixed batches.
    remainingFindings.push(
      ...(runResult.checksValidated > 0 ? runResult.remainingFindings : runResult.findings),
    );
    changes.push(...runResult.changes);
    warnings.push(...runResult.warnings);
    diffs.push(...runResult.diffs);
    effects.push(...runResult.effects);
    checksRepaired += runResult.checksRepaired;
    checksValidated += runResult.checksValidated;
  }

  return {
    config: cfg,
    findings,
    remainingFindings,
    changes,
    warnings,
    diffs,
    effects,
    checksRun: checks.length,
    checksRepaired,
    checksValidated,
  };
}

async function runHealthCheck(
  check: DoctorHealthCheck,
  ctx: HealthRepairContext,
  opts: DoctorRepairRunOptions,
): Promise<DoctorRepairRunResult> {
  const findings: HealthFinding[] = [];
  const remainingFindings: HealthFinding[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  const diffs: HealthRepairDiff[] = [];
  const effects: HealthRepairEffect[] = [];
  let cfg = ctx.cfg;
  let checksRepaired = 0;
  let checksValidated = 0;

  let checkFindings: readonly HealthFinding[];
  try {
    checkFindings = await check.detect(ctx);
  } catch (err) {
    warnings.push(`${check.id} detect failed: ${scrubDoctorErrorMessage(err)}`);
    return repairRunResult(cfg, findings, remainingFindings, changes, warnings, diffs, effects);
  }
  findings.push(...checkFindings);
  if (checkFindings.length === 0 || check.repair === undefined) {
    return repairRunResult(cfg, findings, remainingFindings, changes, warnings, diffs, effects);
  }

  // Split checks expose detect/repair separately, so repair output must be validated by detect().
  try {
    const result = await check.repair(
      { ...ctx, dryRun: opts.dryRun === true, diff: opts.diff === true },
      checkFindings,
    );
    warnings.push(...(result.warnings ?? []));
    diffs.push(...(result.diffs ?? []));
    effects.push(...(result.effects ?? []));
    changes.push(...result.changes);
    const status = result.status ?? "repaired";
    if (status !== "repaired") {
      warnings.push(`${check.id} repair ${status}${result.reason ? `: ${result.reason}` : ""}`);
      return repairRunResult(cfg, findings, remainingFindings, changes, warnings, diffs, effects);
    }
    if (result.config !== undefined && opts.dryRun !== true) {
      cfg = result.config;
    }
    checksRepaired++;
    if (opts.dryRun === true) {
      return repairRunResult(cfg, findings, remainingFindings, changes, warnings, diffs, effects, {
        checksRepaired,
        checksValidated,
      });
    }
    try {
      const validationFindings = await check.detect(
        { ...ctx, cfg },
        createValidationScope(findings),
      );
      remainingFindings.push(...validationFindings);
      checksValidated++;
      if (validationFindings.length > 0) {
        warnings.push(`${check.id} repair left ${validationFindings.length} finding(s)`);
      }
    } catch (err) {
      warnings.push(`${check.id} validation failed: ${scrubDoctorErrorMessage(err)}`);
    }
  } catch (err) {
    warnings.push(`${check.id} repair failed: ${scrubDoctorErrorMessage(err)}`);
  }

  return repairRunResult(cfg, findings, remainingFindings, changes, warnings, diffs, effects, {
    checksRepaired,
    checksValidated,
  });
}

function repairRunResult(
  config: OpenClawConfig,
  findings: readonly HealthFinding[],
  remainingFindings: readonly HealthFinding[],
  changes: readonly string[],
  warnings: readonly string[],
  diffs: readonly HealthRepairDiff[],
  effects: readonly HealthRepairEffect[],
  counts: { checksRepaired?: number; checksValidated?: number } = {},
): DoctorRepairRunResult {
  return {
    config,
    findings,
    remainingFindings,
    changes,
    warnings,
    diffs,
    effects,
    checksRun: 1,
    checksRepaired: counts.checksRepaired ?? 0,
    checksValidated: counts.checksValidated ?? 0,
  };
}

// Re-run only the failing paths/ocPaths after repair to avoid unrelated expensive checks.
function createValidationScope(findings: readonly HealthFinding[]) {
  return {
    findings,
    paths: uniqueDefined(findings.map((finding) => finding.path)),
    ocPaths: uniqueDefined(findings.map((finding) => finding.ocPath)),
  };
}

function uniqueDefined(values: readonly (string | undefined)[]): readonly string[] {
  return uniqueStrings(values.filter((value): value is string => value !== undefined));
}
