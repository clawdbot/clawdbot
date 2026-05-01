import { sanitizeTerminalText } from "../terminal/safe-text.js";
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

export function normalizeConfigIssuePath(path: string | null | undefined): string {
  if (typeof path !== "string") {
    return "<root>";
  }
  const trimmed = path.trim();
  return trimmed ? trimmed : "<root>";
}

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

export function formatConfigIssueLines(
  issues: ReadonlyArray<ConfigIssueLineInput>,
  marker = "-",
  opts?: ConfigIssueFormatOptions,
): string[] {
  return issues.map((issue) => formatConfigIssueLine(issue, marker, opts));
}

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
  return `${lines.join("; ")}; and ${hiddenIssueCount} more`;
}
