// Formats config validation issues for CLI and diagnostics.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { ConfigValidationIssue } from "./types.js";

export type ConfigIssueLineInput = {
  path?: string | null;
  message: string;
};

type ConfigIssueFormatOptions = {
  normalizeRoot?: boolean;
};

type ConfigIssueSummaryOptions = ConfigIssueFormatOptions & {
  maxIssues?: number;
};

/** Normalize missing or blank config issue paths to the root marker used in CLI output. */
export function normalizeConfigIssuePath(path: string | null | undefined): string {
  if (typeof path !== "string") {
    return "<root>";
  }
  const trimmed = path.trim();
  return trimmed ? trimmed : "<root>";
}

/** Return the public config issue shape with a normalized path and non-empty allowed values. */
export function normalizeConfigIssue(issue: ConfigValidationIssue): ConfigValidationIssue {
  const hasAllowedValues = Array.isArray(issue.allowedValues) && issue.allowedValues.length > 0;
  return {
    path: normalizeConfigIssuePath(issue.path),
    message: issue.message,
    ...(hasAllowedValues ? { allowedValues: issue.allowedValues } : {}),
    ...(hasAllowedValues &&
    typeof issue.allowedValuesHiddenCount === "number" &&
    issue.allowedValuesHiddenCount > 0
      ? { allowedValuesHiddenCount: issue.allowedValuesHiddenCount }
      : {}),
  };
}

/** Normalize a batch of config validation issues for display or JSON output. */
export function normalizeConfigIssues(
  issues: ReadonlyArray<ConfigValidationIssue>,
): ConfigValidationIssue[] {
  return issues.map((issue) => normalizeConfigIssue(issue));
}

function resolveIssuePathForLine(
  path: string | null | undefined,
  opts?: ConfigIssueFormatOptions,
): string {
  if (opts?.normalizeRoot) {
    return normalizeConfigIssuePath(path);
  }
  return typeof path === "string" ? path : "";
}

/**
 * Format one config issue for terminal output.
 * Path and message are sanitized because issues can include user-edited config text.
 */
export function formatConfigIssueLine(
  issue: ConfigIssueLineInput,
  marker = "-",
  opts?: ConfigIssueFormatOptions,
): string {
  const prefix = marker ? `${marker} ` : "";
  const path = sanitizeTerminalText(resolveIssuePathForLine(issue.path, opts));
  const message = sanitizeTerminalText(issue.message);
  return `${prefix}${path}: ${message}`;
}

/** Format config issues as terminal-safe lines with a shared marker prefix. */
export function formatConfigIssueLines(
  issues: ReadonlyArray<ConfigIssueLineInput>,
  marker = "-",
  opts?: ConfigIssueFormatOptions,
): string[] {
  return issues.map((issue) => formatConfigIssueLine(issue, marker, opts));
}

/** Build a compact, terminal-safe issue summary for logs and recovery diagnostics. */
export function formatConfigIssueSummary(
  issues: ReadonlyArray<ConfigIssueLineInput>,
  opts: ConfigIssueSummaryOptions = {},
): string | null {
  if (issues.length === 0) {
    return null;
  }
  const maxIssueCandidate = Math.floor(opts.maxIssues ?? 5);
  const maxIssues = Number.isFinite(maxIssueCandidate) ? Math.max(1, maxIssueCandidate) : 5;
  const visibleIssues = issues.slice(0, maxIssues);
  const lines = formatConfigIssueLines(visibleIssues, "", {
    normalizeRoot: opts.normalizeRoot ?? true,
  });
  const hiddenIssueCount = issues.length - visibleIssues.length;
  if (hiddenIssueCount <= 0) {
    return lines.join("; ");
  }
  // Keep log lines bounded while preserving the exact hidden count for triage.
  return `${lines.join("; ")}; and ${hiddenIssueCount} more`;
}
