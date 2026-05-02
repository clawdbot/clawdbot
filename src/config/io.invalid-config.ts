import { sanitizeTerminalText } from "../terminal/safe-text.js";

type ConfigValidationIssueLike = {
  path: string;
  message: string;
};

export function formatInvalidConfigDetails(issues: ConfigValidationIssueLike[]): string {
  return issues
    .map(
      (issue) =>
        `- ${sanitizeTerminalText(issue.path || "<root>")}: ${sanitizeTerminalText(issue.message)}`,
    )
    .join("\n");
}

export function formatInvalidConfigLogMessage(configPath: string, details: string): string {
  return `Invalid config at ${configPath}:\\n${details}`;
}

export function logInvalidConfigOnce(params: {
  configPath: string;
  details: string;
  logger: Pick<typeof console, "error">;
  loggedConfigPaths: Set<string>;
}): void {
  if (params.loggedConfigPaths.has(params.configPath)) {
    return;
  }
  params.loggedConfigPaths.add(params.configPath);
  params.logger.error(formatInvalidConfigLogMessage(params.configPath, params.details));
}

export function createInvalidConfigError(configPath: string, details: string): Error {
  const error = new Error(`Invalid config at ${configPath}:\n${details}`);
  (error as { code?: string; details?: string }).code = "INVALID_CONFIG";
  (error as { code?: string; details?: string }).details = details;
  return error;
}

export function throwInvalidConfig(params: {
  configPath: string;
  issues: ConfigValidationIssueLike[];
  logger: Pick<typeof console, "error">;
  loggedConfigPaths: Set<string>;
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
