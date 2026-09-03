// Console logging helpers format and write messages to console streams.
import util from "node:util";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { clearActiveProgressLine } from "../../packages/terminal-core/src/progress-line.js";
import { isVerbose } from "../global-state.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { formatJsonConsoleLine } from "./json-console-line.js";
import { type LogLevel, normalizeLogLevel } from "./levels.js";
import { getLogger, readLoggerConfig } from "./logger.js";
import { redactSensitiveText } from "./redact.js";
import { loggingState } from "./state.js";
import { formatTimestamp } from "./timestamps.js";
import type { ConsoleStyle, LoggerSettings } from "./types.js";

export type { ConsoleStyle } from "./types.js";
export { formatJsonConsoleLine };
type ConsoleSettings = {
  level: LogLevel;
  style: ConsoleStyle;
};
export type ConsoleLoggerSettings = ConsoleSettings;

function normalizeConsoleLevel(level?: string): LogLevel {
  if (isVerbose()) {
    return "debug";
  }
  if (!level && process.env.VITEST === "true" && process.env.OPENCLAW_TEST_CONSOLE !== "1") {
    return "silent";
  }
  return normalizeLogLevel(level, "info");
}

function normalizeConsoleStyle(style?: string): ConsoleStyle {
  if (style === "compact" || style === "json" || style === "pretty") {
    return style;
  }
  if (!process.stdout.isTTY) {
    return "compact";
  }
  return "pretty";
}

function resolveConsoleSettings(): ConsoleSettings {
  const envLevel = resolveEnvLogLevelOverride();
  // Test runs default to silent console logging unless explicitly overridden.
  // Skip config-file and full config fallback reads in this fast path.
  if (
    process.env.VITEST === "true" &&
    process.env.OPENCLAW_TEST_CONSOLE !== "1" &&
    !isVerbose() &&
    !envLevel &&
    !loggingState.overrideSettings
  ) {
    return { level: "silent", style: normalizeConsoleStyle(undefined) };
  }

  const cfg = (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggerConfig();
  const level = envLevel ?? normalizeConsoleLevel(cfg?.consoleLevel);
  const style = normalizeConsoleStyle(cfg?.consoleStyle);
  return { level, style };
}

export function getConsoleSettings(): ConsoleLoggerSettings {
  const cached = loggingState.cachedConsoleSettings as ConsoleSettings | null;
  if (cached) {
    return cached;
  }
  const settings = resolveConsoleSettings();
  loggingState.cachedConsoleSettings = settings;
  return loggingState.cachedConsoleSettings as ConsoleSettings;
}

export function getResolvedConsoleSettings(): ConsoleLoggerSettings {
  return getConsoleSettings();
}

// Route all console output (including tslog console writes) to stderr.
// This keeps stdout clean for RPC/JSON modes.
export function routeLogsToStderr(): void {
  loggingState.forceConsoleToStderr = true;
}

export function setConsoleSubsystemFilter(filters?: string[] | null): void {
  if (!filters || filters.length === 0) {
    loggingState.consoleSubsystemFilter = null;
    return;
  }
  const normalized = filters.map((value) => value.trim()).filter((value) => value.length > 0);
  loggingState.consoleSubsystemFilter = normalized.length > 0 ? normalized : null;
}

/** Hides subsystem console lines for TTY-owned work while preserving file logging. */
export async function withConsoleSubsystemsSuppressed<T>(work: () => Promise<T>): Promise<T> {
  const previousFilter = loggingState.consoleSubsystemFilter
    ? [...loggingState.consoleSubsystemFilter]
    : null;
  setConsoleSubsystemFilter(["__openclaw_tui_quiet__"]);
  try {
    return await work();
  } finally {
    setConsoleSubsystemFilter(previousFilter);
  }
}

export function setConsoleTimestampPrefix(enabled: boolean): void {
  loggingState.consoleTimestampPrefix = enabled;
}

function normalizeConsoleSubsystem(subsystem?: string | null): string | null {
  if (typeof subsystem !== "string") {
    return null;
  }
  const normalized = subsystem.trim();
  return normalized.length > 0 ? normalized : null;
}

export function shouldLogSubsystemToConsole(subsystem?: string | null): boolean {
  const filter = loggingState.consoleSubsystemFilter;
  if (!filter || filter.length === 0) {
    return true;
  }
  const normalizedSubsystem = normalizeConsoleSubsystem(subsystem);
  if (!normalizedSubsystem) {
    return false;
  }
  return filter.some(
    (prefix) => normalizedSubsystem === prefix || normalizedSubsystem.startsWith(`${prefix}/`),
  );
}

const SUPPRESSED_CONSOLE_PREFIXES = [
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
  "Session already closed",
  "Session already open",
] as const;

// Node's default warning printer prefixes its single console.error call. Its
// internal caller proves ownership so matching application errors stay ERROR.
const NODE_PROCESS_WARNING_PREFIX = `(${process.release.name}:${process.pid}) `;

function shouldSuppressConsoleMessage(message: string): boolean {
  return SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function isEpipeError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

export function formatConsoleTimestamp(style: ConsoleStyle): string {
  const now = new Date();
  if (style === "pretty") {
    return formatTimestamp(now, { style: "short" }).replace(/[+-]\d{2}:\d{2}$/, "");
  }
  return formatTimestamp(now, { style: "long" });
}

function captureConsoleTraceStack(message: string, caller: (...args: unknown[]) => void): string {
  const trace = new Error(message);
  trace.name = "Trace";
  // An Error instance lets both Node and Bun exclude the console wrapper structurally.
  Error.captureStackTrace(trace, caller);
  return trace.stack === undefined
    ? `Trace: ${message}`
    : typeof trace.stack === "string"
      ? trace.stack
      : util.format(trace.stack);
}

function hasTimestampPrefix(value: string): boolean {
  return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.test(
    value,
  );
}

function writeFormattedConsoleOutput(params: {
  level: LogLevel;
  args: unknown[];
  formatted: string;
  write: (...args: unknown[]) => void;
  caller?: (...args: unknown[]) => void;
}) {
  const consoleStyle = getConsoleSettings().style;
  const trimmed =
    consoleStyle !== "json" && loggingState.consoleTimestampPrefix
      ? stripAnsi(params.formatted).trimStart()
      : "";
  const timestamp =
    trimmed && !hasTimestampPrefix(trimmed) ? formatConsoleTimestamp(consoleStyle) : "";
  const stack =
    params.level === "trace" && params.caller
      ? captureConsoleTraceStack(params.formatted, params.caller)
      : undefined;
  try {
    const rendered =
      consoleStyle === "json"
        ? formatJsonConsoleLine({
            level: params.level,
            message: stripAnsi(params.formatted),
            meta: stack === undefined ? undefined : { stack: stripAnsi(stack) },
          })
        : redactSensitiveText(stack ?? params.formatted);
    const line = timestamp ? `${timestamp} ${rendered}` : rendered;
    if (loggingState.forceConsoleToStderr) {
      process.stderr.write(`${line}\n`);
    } else if (
      consoleStyle !== "json" &&
      !timestamp &&
      params.args.length === 0 &&
      stack === undefined
    ) {
      params.write.apply(console, params.args as []);
    } else {
      params.write.call(console, line);
    }
  } catch (err) {
    if (isEpipeError(err)) {
      return;
    }
    throw err;
  }
}

/** Writes a root logger line to the pre-capture console sink without re-entering file capture. */
export function writeRootConsoleLine(method: "log" | "error", line: string): boolean {
  const rawConsole = loggingState.rawConsole;
  if (!rawConsole) {
    return false;
  }
  clearActiveProgressLine();
  if (shouldSuppressConsoleMessage(line)) {
    return true;
  }
  const level = method === "error" ? "error" : "info";
  writeFormattedConsoleOutput({
    level,
    args: [line],
    formatted: line,
    write: rawConsole[method],
  });
  return true;
}

/**
 * Route console.* calls through file logging while still emitting to stdout/stderr.
 * This keeps user-facing output unchanged but guarantees every console call is captured in log files.
 */
export function enableConsoleCapture(): void {
  if (loggingState.consolePatched) {
    return;
  }
  loggingState.consolePatched = true;

  // Handle async EPIPE errors on stdout/stderr. The synchronous try/catch in
  // the forward() wrapper below only covers errors thrown during write dispatch.
  // When the receiving pipe closes (e.g. during shutdown), Node emits the error
  // asynchronously on the stream. Without a listener this becomes an uncaught
  // exception that crashes the gateway.
  // Guard separately from consolePatched so test resets don't stack listeners.
  if (!loggingState.streamErrorHandlersInstalled) {
    loggingState.streamErrorHandlersInstalled = true;
    for (const stream of [process.stdout, process.stderr]) {
      stream.on("error", (err) => {
        if (isEpipeError(err)) {
          // stdout/stderr broken means the process is orphaned (e.g. the parent
          // service restarted and closed the journal pipe). Exit cleanly instead
          // of spinning in a tight loop where every log attempt re-triggers EPIPE.
          const exitCode = process.exitCode;
          process.exit(exitCode !== undefined && exitCode !== 0 && exitCode !== "0" ? exitCode : 0);
          return;
        }
        throw err;
      });
    }
  }

  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  loggingState.rawConsole = {
    log: original.log,
    info: original.info,
    warn: original.warn,
    error: original.error,
  };

  const forward = (
    level: Exclude<LogLevel, "fatal" | "silent">,
    orig: (...args: unknown[]) => void,
  ) => {
    const forwardedConsoleCall = (...args: unknown[]) => {
      const formatted = util.format(...args);
      let routedLevel = level;
      if (
        level === "error" &&
        formatted.startsWith(NODE_PROCESS_WARNING_PREFIX) &&
        typeof util.getCallSites === "function"
      ) {
        const caller = util.getCallSites(2, { sourceMap: false })[1];
        if (
          caller?.functionName === "writeOut" &&
          caller.scriptName === "node:internal/process/warning"
        ) {
          routedLevel = "warn";
        }
      }
      if (shouldSuppressConsoleMessage(formatted)) {
        return;
      }
      try {
        getLogger()[routedLevel](formatted);
      } catch {
        // never block console output on logging failures
      }
      writeFormattedConsoleOutput({
        level: routedLevel,
        args,
        formatted,
        write: orig,
        caller: forwardedConsoleCall,
      });
    };
    return forwardedConsoleCall;
  };

  console.log = forward("info", original.log);
  console.info = forward("info", original.info);
  console.warn = forward("warn", original.warn);
  console.error = forward("error", original.error);
  console.debug = forward("debug", original.debug);
  // Native trace delegates to console.error; write the prepared stack directly
  // so capture owns exactly one TRACE file record in every console style.
  console.trace = forward("trace", original.error);
}
