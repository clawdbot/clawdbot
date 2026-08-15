// Console logging helpers format and write messages to console streams.
import util from "node:util";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { clearActiveProgressLine } from "../../packages/terminal-core/src/progress-line.js";
import { isVerbose } from "../global-state.js";
import { readLoggingConfig } from "./config.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { formatJsonConsoleLine } from "./json-console-line.js";
import { type LogLevel, normalizeLogLevel } from "./levels.js";
import { getLogger } from "./logger.js";
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

  const cfg = (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  const level = envLevel ?? normalizeConsoleLevel(cfg?.consoleLevel);
  const style = normalizeConsoleStyle(cfg?.consoleStyle);
  return { level, style };
}

function consoleSettingsChanged(a: ConsoleSettings | null, b: ConsoleSettings) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.style !== b.style;
}

export function getConsoleSettings(): ConsoleLoggerSettings {
  const settings = resolveConsoleSettings();
  const cached = loggingState.cachedConsoleSettings as ConsoleSettings | null;
  if (!cached || consoleSettingsChanged(cached, settings)) {
    loggingState.cachedConsoleSettings = settings;
  }
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

function shouldSuppressConsoleMessage(message: string): boolean {
  if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return true;
  }
  if (isVerbose()) {
    return false;
  }
  return false;
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
  traceWrite: (...args: unknown[]) => void;
  caller?: (...args: unknown[]) => void;
}) {
  const trimmed = stripAnsi(params.formatted).trimStart();
  const consoleStyle = getConsoleSettings().style;
  const shouldPrefixTimestamp =
    consoleStyle !== "json" &&
    loggingState.consoleTimestampPrefix &&
    trimmed.length > 0 &&
    !hasTimestampPrefix(trimmed);
  const timestamp = shouldPrefixTimestamp ? formatConsoleTimestamp(consoleStyle) : "";
  const jsonMessage = consoleStyle === "json" ? stripAnsi(params.formatted) : "";
  const jsonMeta =
    consoleStyle === "json" && params.level === "trace" && params.caller
      ? { stack: stripAnsi(captureConsoleTraceStack(params.formatted, params.caller)) }
      : undefined;
  try {
    const redacted = redactSensitiveText(params.formatted);
    const line =
      consoleStyle === "json"
        ? formatJsonConsoleLine({ level: params.level, message: jsonMessage, meta: jsonMeta })
        : timestamp
          ? `${timestamp} ${redacted}`
          : redacted;
    if (loggingState.forceConsoleToStderr) {
      process.stderr.write(`${line}\n`);
    } else if (consoleStyle === "json") {
      // Node and Bun implement console.trace() through this.error(). Use the raw error
      // sink so the structured trace does not re-enter as an error.
      (params.level === "trace" ? params.traceWrite : params.write).call(console, line);
    } else if (!timestamp && params.args.length === 0) {
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
    traceWrite: rawConsole.error,
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

  let logger: ReturnType<typeof getLogger> | null = null;
  const getLoggerLazy = () => {
    if (!logger) {
      logger = getLogger();
    }
    return logger;
  };

  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
  loggingState.rawConsole = {
    log: original.log,
    info: original.info,
    warn: original.warn,
    error: original.error,
  };

  const forward = (level: LogLevel, orig: (...args: unknown[]) => void) => {
    const forwardedConsoleCall = (...args: unknown[]) => {
      const formatted = util.format(...args);
      if (shouldSuppressConsoleMessage(formatted)) {
        return;
      }
      try {
        const resolvedLogger = getLoggerLazy();
        // Map console levels to file logger
        if (level === "trace") {
          resolvedLogger.trace(formatted);
        } else if (level === "debug") {
          resolvedLogger.debug(formatted);
        } else if (level === "info") {
          resolvedLogger.info(formatted);
        } else if (level === "warn") {
          resolvedLogger.warn(formatted);
        } else if (level === "error" || level === "fatal") {
          resolvedLogger.error(formatted);
        } else {
          resolvedLogger.info(formatted);
        }
      } catch {
        // never block console output on logging failures
      }
      writeFormattedConsoleOutput({
        level,
        args,
        formatted,
        write: orig,
        traceWrite: original.error,
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
  console.trace = forward("trace", original.trace);
}
