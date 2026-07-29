/** Severity levels emitted by security audit checks. */
export type SecurityAuditSeverity = "info" | "warn" | "critical";

/** One actionable or informational security audit finding. */
export type SecurityAuditFinding = {
  checkId: string;
  severity: SecurityAuditSeverity;
  title: string;
  detail: string;
  remediation?: string;
};

/** Finding intentionally hidden by a configured audit suppression. */
export type SecurityAuditSuppressedFinding = SecurityAuditFinding & {
  suppression: {
    reason?: string;
  };
};

/** Count summary grouped by audit severity. */
export type SecurityAuditSummary = {
  critical: number;
  warn: number;
  info: number;
};

/** Complete security audit report returned by CLI/runtime callers. */
export type SecurityAuditReport = {
  ts: number;
  summary: SecurityAuditSummary;
  findings: SecurityAuditFinding[];
  suppressedFindings?: SecurityAuditSuppressedFinding[];
  deep?: {
    gateway?: {
      attempted: boolean;
      url: string | null;
      ok: boolean;
      error: string | null;
      close?: { code: number; reason: string } | null;
    };
  };
};
