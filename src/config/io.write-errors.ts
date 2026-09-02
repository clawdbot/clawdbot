// Formats stable user-facing config write failures.
import type { ConfigValidationIssue } from "./types.js";

const CONFIG_VALIDATION_FAILED_CODE = "CONFIG_VALIDATION_FAILED";
const CONFIG_INCLUDE_OWNERSHIP_CODE = "CONFIG_INCLUDE_OWNERSHIP";

function hasConfigWriteErrorCode(error: unknown, code: string): error is Error {
  return (
    error instanceof Error &&
    "code" in error &&
    // SAFETY: the `"code" in error` guard proves the property exists; the cast only widens to unknown for comparison.
    (error as { code?: unknown }).code === code
  );
}

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
  return hasConfigWriteErrorCode(error, CONFIG_VALIDATION_FAILED_CODE);
}

type ConfigIncludeOwnershipRefusal = {
  /** Logical config path of the $include-owned value the write would flatten. */
  ownedConfigPath: string;
  /** Authored `$include` target(s) at that path, when the root file names them. */
  includeTargets?: readonly string[];
};

/**
 * Typed write refusal for a candidate that would flatten an $include-owned value
 * into the root file, so doctor can record "config left unchanged" with the
 * owning path instead of surfacing a raw error after advertising the repair.
 */
export function createConfigIncludeOwnershipError(refusal: ConfigIncludeOwnershipRefusal): Error {
  return Object.assign(
    new Error(
      `Config write would flatten $include-owned config at ${refusal.ownedConfigPath}; edit that include file directly or remove the $include first.`,
    ),
    { code: CONFIG_INCLUDE_OWNERSHIP_CODE, ...refusal },
  );
}

/** True when a config write was refused because it would flatten an included file. */
export function isConfigIncludeOwnershipError(
  error: unknown,
): error is Error & ConfigIncludeOwnershipRefusal {
  return hasConfigWriteErrorCode(error, CONFIG_INCLUDE_OWNERSHIP_CODE);
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
