/** Exit-code helpers for `openclaw secrets audit --check`. */
import {
  healthFindingMeetsSeverity,
  parseHealthFindingSeverity,
  type HealthFindingSeverity,
} from "../flows/health-checks.js";

type SecretsAuditSeverity = "info" | "warn" | "error"; // pragma: allowlist secret

type SecretsAuditCheckSeverity = Extract<HealthFindingSeverity, "info" | "warning">;

type SecretsAuditExitReport = {
  summary: {
    unresolvedRefCount: number;
  };
  findings: Array<{
    severity: SecretsAuditSeverity;
  }>;
};

function normalizeSecretsAuditSeverity(severity: SecretsAuditSeverity): HealthFindingSeverity {
  return severity === "warn" ? "warning" : severity;
}

export function parseSecretsAuditCheckSeverity(value: string): SecretsAuditCheckSeverity | null {
  const severity = parseHealthFindingSeverity(value === "warn" ? "warning" : value);
  return severity === "info" || severity === "warning" ? severity : null;
}

/** Maps audit results to CLI exit codes. */
export function resolveSecretsAuditExitCode(
  report: SecretsAuditExitReport,
  check: boolean,
  severityMin: SecretsAuditCheckSeverity = "info",
): number {
  if (report.summary.unresolvedRefCount > 0) {
    return 2;
  }
  const hasBlockingFinding = report.findings.some((finding) =>
    healthFindingMeetsSeverity(
      { severity: normalizeSecretsAuditSeverity(finding.severity) },
      severityMin,
    ),
  );
  return check && hasBlockingFinding ? 1 : 0;
}
