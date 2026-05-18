import { listHealthChecks } from "./health-check-registry.js";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";
import {
  HEALTH_FINDING_SEVERITY_RANK,
  healthFindingMeetsSeverity,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
  type HealthFindingSeverity,
} from "./health-checks.js";

export interface DoctorLintRunOptions {
  readonly checks?: readonly HealthCheck[];
  readonly skipIds?: ReadonlySet<string> | readonly string[];
  readonly onlyIds?: ReadonlySet<string> | readonly string[];
}

export interface DoctorLintRunResult {
  readonly findings: readonly HealthFinding[];
  readonly checksRun: number;
  readonly checksSkipped: number;
}

export async function runDoctorLintChecks(
  ctx: HealthCheckContext,
  opts: DoctorLintRunOptions = {},
): Promise<DoctorLintRunResult> {
  const all = opts.checks ?? listHealthChecks();
  const skip = opts.skipIds instanceof Set ? opts.skipIds : new Set(opts.skipIds ?? []);
  const only = opts.onlyIds instanceof Set ? opts.onlyIds : new Set(opts.onlyIds ?? []);

  const selected = all.filter((c) => {
    if (only.size > 0 && !only.has(c.id)) {
      return false;
    }
    if (skip.has(c.id)) {
      return false;
    }
    return true;
  });

  const findings: HealthFinding[] = [];
  for (const check of selected) {
    try {
      const out = await check.detect(ctx);
      for (const f of out) {
        findings.push(f);
      }
    } catch (err) {
      findings.push({
        checkId: check.id,
        severity: "error",
        message: `health check threw: ${scrubDoctorErrorMessage(err)}`,
      });
    }
  }

  findings.sort(compareFindings);

  return {
    findings,
    checksRun: selected.length,
    checksSkipped: all.length - selected.length,
  };
}

function compareFindings(a: HealthFinding, b: HealthFinding): number {
  const sevDelta =
    HEALTH_FINDING_SEVERITY_RANK[b.severity] - HEALTH_FINDING_SEVERITY_RANK[a.severity];
  if (sevDelta !== 0) {
    return sevDelta;
  }
  const idDelta = a.checkId.localeCompare(b.checkId);
  if (idDelta !== 0) {
    return idDelta;
  }
  return (a.path ?? "").localeCompare(b.path ?? "");
}

export function exitCodeFromFindings(
  findings: readonly HealthFinding[],
  severityMin: HealthFindingSeverity = "warning",
): 0 | 1 {
  return findings.some((f) => healthFindingMeetsSeverity(f, severityMin)) ? 1 : 0;
}
