import { expectDefined } from "@openclaw/normalization-core";
// Provides root logger helpers and themed terminal output.
import { theme } from "../packages/terminal-core/src/theme.js";
import { isVerbose } from "./global-state.js";
import { getLogger } from "./logging/logger.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;

function splitSubsystem(message: string) {
  const match = message.match(subsystemPrefixRe);
  if (!match) {
    return null;
  }
  const subsystem = match.at(1);
  const rest = match.at(2);
  if (subsystem === undefined || rest === undefined) {
    return null;
  }
  return { subsystem, rest };
}

type LogMethod = "info" | "warn" | "error";
type RuntimeMethod = "log" | "error";

function logWithSubsystem(params: {
  message: string;
  runtime: RuntimeEnv;
  runtimeMethod: RuntimeMethod;
  runtimeFormatter: (value: string) => string;
  loggerMethod: LogMethod;
  subsystemMethod: LogMethod;
}) {
  const parsed = params.runtime === defaultRuntime ? splitSubsystem(params.message) : null;
  if (parsed) {
    const method = expectDefined(
      createSubsystemLogger(parsed.subsystem)[params.subsystemMethod],
      "subsystem logger method",
    );
    method(parsed.rest);
    return;
  }
  params.runtime[params.runtimeMethod](params.runtimeFormatter(params.message));
  getLogger()[params.loggerMethod](params.message);
}

const info = theme.info;
const warn = theme.warn;
const success = theme.success;
const danger = theme.error;

export function logInfo(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    message,
    runtime,
    runtimeMethod: "log",
    runtimeFormatter: info,
    loggerMethod: "info",
    subsystemMethod: "info",
  });
}

export function logWarn(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    message,
    runtime,
    runtimeMethod: "log",
    runtimeFormatter: warn,
    loggerMethod: "warn",
    subsystemMethod: "warn",
  });
}

export function logSuccess(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    message,
    runtime,
    runtimeMethod: "log",
    runtimeFormatter: success,
    loggerMethod: "info",
    subsystemMethod: "info",
  });
}

export function logError(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    message,
    runtime,
    runtimeMethod: "error",
    runtimeFormatter: danger,
    loggerMethod: "error",
    subsystemMethod: "error",
  });
}

export function logDebug(message: string) {
  // Always emit to file logger (level-filtered); console only when verbose.
  getLogger().debug(message);
  if (isVerbose()) {
    console.log(theme.muted(message));
  }
}
