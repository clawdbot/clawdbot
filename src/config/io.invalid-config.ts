/**
 * Shared invalid-config formatting, logging, and error helpers for config reads and mutations.
 * All terminal-facing text is sanitized here so callers can reuse the same failure surface.
 */
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import type { DedupeCache } from "../infra/dedupe.js";
import { formatConfigIssueLines } from "./issue-format.js";

/** Minimal validation issue shape accepted from schema and mutation validation paths. */
type ConfigValidationIssueLike = {
  path: string;
  message: string;
};

/** Formats validation issues as terminal-safe bullet lines for config load failures. */
export function formatInvalidConfigDetails(issues: ConfigValidationIssueLike[]): string {
  return formatConfigIssueLines(issues, "-", { normalizeRoot: true }).join("\n");
}

type InvalidConfigError = Error & {
  code: "INVALID_CONFIG";
  details?: string;
  recovery?: "doctor" | "manual";
  diagnosticEmitted?: boolean;
};

/** Creates a tagged error without logging; throwInvalidConfig owns diagnostic emission. */
export function createInvalidConfigError(
  configPath: string,
  details: string,
  options: { recovery?: "doctor" | "manual" } = {},
): InvalidConfigError {
  // Keep metadata non-class-based so cross-module callers can inspect plain Error instances.
  return Object.assign(new Error(`Invalid config at ${configPath}:\n${details}`), {
    name: "InvalidConfigError",
    code: "INVALID_CONFIG" as const,
    details,
    recovery: options.recovery ?? "doctor",
    diagnosticEmitted: false,
  });
}

export function isInvalidConfigError(err: unknown): err is InvalidConfigError {
  return extractErrorCode(err) === "INVALID_CONFIG";
}

export function isDoctorRecoverableInvalidConfigError(err: unknown): boolean {
  return isInvalidConfigError(err) && err.recovery !== "manual";
}

/** Logs and throws the standard invalid-config error for a validation result. */
export function throwInvalidConfig(params: {
  configPath: string;
  issues: ConfigValidationIssueLike[];
  logger: Pick<typeof console, "error">;
  loggedConfigPaths: DedupeCache;
}): never {
  const details = formatInvalidConfigDetails(params.issues);
  const error = createInvalidConfigError(params.configPath, details);
  // Dedupe the full diagnostic: a later invalid config at the same path may need a different repair.
  // Record only after logging succeeds so a failed logger cannot silence a subsequent attempt.
  if (!params.loggedConfigPaths.peek(error.message)) {
    params.logger.error(error.message);
  }
  params.loggedConfigPaths.check(error.message);
  error.diagnosticEmitted = true;
  throw error;
}
