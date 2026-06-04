/** Config IO adapter used by secrets apply/configure flows. */
import { createConfigIO } from "../config/config.js";

const silentConfigIoLogger = {
  error: () => {},
  warn: () => {},
} as const;

/**
 * Creates config I/O for secrets commands with config-loader logging suppressed.
 */
export function createSecretsConfigIO(params: { env: NodeJS.ProcessEnv }) {
  // Secrets command output is owned by the CLI command so --json stays machine-parseable.
  return createConfigIO({
    env: params.env,
    logger: silentConfigIoLogger,
  });
}
