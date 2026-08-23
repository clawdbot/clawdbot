// Formats stable user-facing config write failures.
import type { ConfigValidationIssue } from "./types.js";

const CONFIG_VALIDATION_FAILED_CODE = "CONFIG_VALIDATION_FAILED";

/**
 * Typed write refusal for a candidate that fails schema validation, so doctor
 * can render "config left unchanged" plus the offending paths instead of crashing.
 */
export function createConfigValidationFailedError(issues: ConfigValidationIssue[]): Error {
  const issue = issues[0];
  return Object.assign(
    new Error(formatConfigValidationFailure(issue?.path || "<root>", issue?.message ?? "invalid")),
    { code: CONFIG_VALIDATION_FAILED_CODE, issues },
  );
}

/** True when a config write was refused because the candidate failed schema validation. */
export function isConfigValidationFailedError(
  error: unknown,
): error is Error & { issues: ConfigValidationIssue[] } {
  return (
    error instanceof Error &&
    "code" in error &&
    // SAFETY: the `"code" in error` guard proves the property exists; the cast only widens to unknown for comparison.
    (error as { code?: unknown }).code === CONFIG_VALIDATION_FAILED_CODE
  );
}

const OPEN_DM_POLICY_ALLOW_FROM_RE =
  /^(?<policyPath>[a-z0-9_.-]+)\s*=\s*"open"\s+requires\s+(?<allowPath>[a-z0-9_.-]+)(?:\s+\(or\s+[a-z0-9_.-]+\))?\s+to include "\*"$/i;

function formatConfigValidationFailure(pathLabel: string, issueMessage: string): string {
  const match = issueMessage.match(OPEN_DM_POLICY_ALLOW_FROM_RE);
  const policyPath = match?.groups?.policyPath?.trim();
  const allowPath = match?.groups?.allowPath?.trim();
  if (!policyPath || !allowPath) {
    return `Config validation failed: ${pathLabel}: ${issueMessage}`;
  }

  return [
    `Config validation failed: ${pathLabel}`,
    "",
    `Configuration mismatch: ${policyPath} is "open", but ${allowPath} does not include "*".`,
    "",
    "Fix with:",
    `  openclaw config set ${allowPath} '["*"]'`,
    "",
    "Or switch policy:",
    `  openclaw config set ${policyPath} "pairing"`,
  ].join("\n");
}
