/**
 * Shared invalid-config formatting, logging, and error helpers for config reads and mutations.
 * All terminal-facing text is sanitized here so callers can reuse the same failure surface.
 */
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { DedupeCache } from "../infra/dedupe.js";
import { extractErrorCode } from "../infra/errors.js";

/** Minimal validation issue shape accepted from schema and mutation validation paths. */
type ConfigValidationIssueLike = {
  path: string;
  message: string;
};

/** Formats validation issues as terminal-safe bullet lines for config load failures. */
export function formatInvalidConfigDetails(issues: ConfigValidationIssueLike[]): string {
  return issues
    .map(
      (issue) =>
        // Validation paths/messages can contain user config text; sanitize before terminal output.
        `- ${sanitizeTerminalText(issue.path || "<root>")}: ${sanitizeTerminalText(issue.message)}`,
    )
    .join("\n");
}

/** Builds the one-line invalid-config prefix plus preformatted validation details. */
function formatInvalidConfigLogMessage(configPath: string, details: string): string {
  return `Invalid config at ${configPath}:\\n${details}`;
}

/** Logs an invalid config message once per path during a load sequence. */
function logInvalidConfigOnce(params: {
  configPath: string;
  details: string;
  logger: Pick<typeof console, "error">;
  loggedConfigPaths: DedupeCache;
}): void {
  if (params.loggedConfigPaths.check(params.configPath)) {
    // Avoid repeating the same invalid config block when multiple callers observe the same path.
    return;
  }
  params.logger.error(formatInvalidConfigLogMessage(params.configPath, params.details));
}

/** Creates the tagged error shape used by callers that need details after catch. */
export function createInvalidConfigError(configPath: string, details: string): Error {
  const error = new Error(`Invalid config at ${configPath}:\n${details}`);
  // Keep metadata non-class-based so cross-module callers can inspect plain Error instances.
  error.name = "InvalidConfigError";
  (error as { code?: "INVALID_CONFIG"; details?: string }).code = "INVALID_CONFIG";
  (error as { code?: "INVALID_CONFIG"; details?: string }).details = details;
  return error;
}

export function isInvalidConfigError(err: unknown): err is Error & {
  code: "INVALID_CONFIG";
  details?: string;
} {
  return extractErrorCode(err) === "INVALID_CONFIG";
}

/** Logs and throws the standard invalid-config error for a validation result. */
export function throwInvalidConfig(params: {
  configPath: string;
  issues: ConfigValidationIssueLike[];
  logger: Pick<typeof console, "error">;
  loggedConfigPaths: DedupeCache;
}): never {
  const details = formatInvalidConfigDetails(params.issues);
  logInvalidConfigOnce({
    configPath: params.configPath,
    details,
    logger: params.logger,
    loggedConfigPaths: params.loggedConfigPaths,
  });
  throw createInvalidConfigError(params.configPath, details);
}
