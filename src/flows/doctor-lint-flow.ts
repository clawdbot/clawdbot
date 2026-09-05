// Doctor lint flow runs lint-like doctor checks and formats findings.
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";
import { listHealthChecks } from "./health-check-registry.js";
import {
  HEALTH_FINDING_SEVERITY_RANK,
  healthFindingMeetsSeverity,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
  type HealthFindingSeverity,
} from "./health-checks.js";

// Non-mutating health-check runner used by `openclaw doctor --lint`.
export interface DoctorLintRunOptions {
  readonly checks?: readonly HealthCheck[];
  readonly skipIds?: ReadonlySet<string> | readonly string[];
  readonly onlyIds?: ReadonlySet<string> | readonly string[];
  readonly includeAllChecks?: boolean;
}

interface DoctorLintRunResult {
  readonly findings: readonly HealthFinding[];
  readonly checksRun: number;
  readonly checksSkipped: number;
}

/** Runs selected health checks in lint mode and returns sorted findings. */
export async function runDoctorLintChecks(
  ctx: HealthCheckContext,
  opts: DoctorLintRunOptions = {},
): Promise<DoctorLintRunResult> {
  const all = opts.checks ?? listHealthChecks();
  const skip = opts.skipIds instanceof Set ? opts.skipIds : new Set(opts.skipIds ?? []);
  const only = opts.onlyIds instanceof Set ? opts.onlyIds : new Set(opts.onlyIds ?? []);
  const allIds = new Set(all.map((check) => check.id));
  const includeDefaultDisabled = opts.includeAllChecks === true;

  const selected = all.filter((c) => {
    if (only.size > 0 && !only.has(c.id)) {
      return false;
    }
    if (only.size === 0 && !includeDefaultDisabled && isDefaultDisabled(c)) {
      return false;
    }
    if (skip.has(c.id)) {
      return false;
    }
    return true;
  });

  const findings: HealthFinding[] = [];
  for (const id of only) {
    let message: string;
    if (!allIds.has(id)) {
      message = `Unknown health check id selected by --only: ${id}.`;
    } else if (selected.length === 0 && skip.has(id)) {
      message = `Health check ${id} cannot be selected by --only and excluded by --skip.`;
    } else {
      continue;
    }
    findings.push({
      checkId: "core/doctor/lint-selection",
      severity: "error",
      message,
      path: id,
    });
  }
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

/** Internal update gate selection; public Doctor lint remains selector-driven. */
export function selectUpdateReadinessChecks(
  checks: readonly HealthCheck[],
  phase: "post-plugin",
): readonly HealthCheck[] {
  return checks.filter((check) => "updateReadiness" in check && check.updateReadiness === phase);
}

function isDefaultDisabled(check: HealthCheck): boolean {
  return "defaultEnabled" in check && check.defaultEnabled === false;
}

// Stable ordering keeps CLI output and tests deterministic across registry order changes.
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

/** Converts findings to a process exit code using the requested minimum severity. */
export function exitCodeFromFindings(
  findings: readonly HealthFinding[],
  severityMin: HealthFindingSeverity = "warning",
): 0 | 1 {
  return findings.some((f) => healthFindingMeetsSeverity(f, severityMin)) ? 1 : 0;
}
