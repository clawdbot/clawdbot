// Route-first CLI entry point for commands that can run before full Commander setup.
import { FLAG_TERMINATOR, isValueToken } from "../infra/cli-root-options.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { type LogLevel, tryParseLogLevel } from "../logging/levels.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag } from "./argv.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
} from "./command-execution-startup.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";
import { findRoutedCommand } from "./program/routes.js";

const LOG_LEVEL_FLAG = "--log-level";
const LOG_LEVEL_EQUALS_PREFIX = `${LOG_LEVEL_FLAG}=`;

function resolveRoutedCliLogLevel(argv: string[]): LogLevel | null | undefined {
  const args = argv.slice(2);
  let logLevel: LogLevel | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === LOG_LEVEL_FLAG) {
      const value = args[index + 1];
      if (!isValueToken(value)) {
        return null;
      }
      const parsed = tryParseLogLevel(value);
      if (!parsed) {
        return null;
      }
      logLevel = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith(LOG_LEVEL_EQUALS_PREFIX)) {
      const parsed = tryParseLogLevel(arg.slice(LOG_LEVEL_EQUALS_PREFIX.length));
      if (!parsed) {
        return null;
      }
      logLevel = parsed;
    }
  }

  return logLevel;
}

/** Try a lightweight route-first command before falling back to the full CLI program. */
export async function tryRouteCli(
  argv: string[],
  options: { machineOutput?: boolean } = {},
): Promise<boolean> {
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  if (!invocation.commandPath[0]) {
    return false;
  }
  const run = findRoutedCommand(invocation.commandPath, argv);
  if (!run) {
    return false;
  }
  const logLevel = resolveRoutedCliLogLevel(argv);
  if (logLevel === null) {
    // Let Commander own the existing user-facing --log-level validation errors.
    return false;
  }
  if (logLevel) {
    process.env.OPENCLAW_LOG_LEVEL = logLevel;
  }
  const startupPolicy = resolveCliStartupPolicy({
    argv,
    commandPath: invocation.commandPath,
    jsonOutputMode: options.machineOutput === true || hasFlag(argv, "--json"),
  });
  const { VERSION } = await import("../version.js");
  await applyCliExecutionStartupPresentation({
    argv,
    startupPolicy,
    showBanner: process.stdout.isTTY && !startupPolicy.suppressDoctorStdout,
    version: VERSION,
  });
  await ensureCliExecutionBootstrap({
    runtime: defaultRuntime,
    commandPath: invocation.commandPath,
    startupPolicy,
  });
  await run();
  return true;
}
