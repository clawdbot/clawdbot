import util from "node:util";

import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import { isVerbose } from "../globals.js";
import { type LogLevel, normalizeLogLevel } from "./levels.js";
import { getLogger, type LoggerSettings } from "./logger.js";
import { loggingState } from "./state.js";

export type ConsoleStyle = "pretty" | "compact" | "json";
type ConsoleSettings = {
  level: LogLevel;
  style: ConsoleStyle;
};
export type ConsoleLoggerSettings = ConsoleSettings;

function normalizeConsoleLevel(level?: string): LogLevel {
  if (isVerbose()) return "debug";
  return normalizeLogLevel(level, "info");
}

function normalizeConsoleStyle(style?: string): ConsoleStyle {
  if (style === "compact" || style === "json" || style === "pretty") {
    return style;
  }
  if (!process.stdout.isTTY) return "compact";
  return "pretty";
}

function resolveConsoleSettings(): ConsoleSettings {
  const cfg: ClawdbotConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? loadConfig().logging;
  const level = normalizeConsoleLevel(cfg?.consoleLevel);
  const style = normalizeConsoleStyle(cfg?.consoleStyle);
  return { level, style };
}

function consoleSettingsChanged(a: ConsoleSettings | null, b: ConsoleSettings) {
  if (!a) return true;
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

export function shouldLogSubsystemToConsole(subsystem: string): boolean {
  const filter = loggingState.consoleSubsystemFilter;
  if (!filter || filter.length === 0) {
    return true;
  }
  return filter.some((prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`));
}

const SUPPRESSED_CONSOLE_PREFIXES = [
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
  "Session already closed",
  "Session already open",
] as const;

function shouldSuppressConsoleMessage(message: string): boolean {
  if (isVerbose()) return false;
  return SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function isEpipeError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

/**
 * Route console.* calls through file logging while still emitting to stdout/stderr.
 * This keeps user-facing output unchanged but guarantees every console call is captured in log files.
 */
export function enableConsoleCapture(): void {
  if (loggingState.consolePatched) return;
  loggingState.consolePatched = true;

  const logger = getLogger();

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

  const forward =
    (level: LogLevel, orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const formatted = util.format(...args);
      if (shouldSuppressConsoleMessage(formatted)) return;
      try {
        // Map console levels to file logger
        if (level === "trace") {
          logger.trace(formatted);
        } else if (level === "debug") {
          logger.debug(formatted);
        } else if (level === "info") {
          logger.info(formatted);
        } else if (level === "warn") {
          logger.warn(formatted);
        } else if (level === "error" || level === "fatal") {
          logger.error(formatted);
        } else {
          logger.info(formatted);
        }
      } catch {
        // never block console output on logging failures
      }
      if (loggingState.forceConsoleToStderr) {
        // in RPC/JSON mode, keep stdout clean
        try {
          process.stderr.write(`${formatted}\n`);
        } catch (err) {
          if (isEpipeError(err)) return;
          throw err;
        }
      } else {
        try {
          orig.apply(console, args as []);
        } catch (err) {
          if (isEpipeError(err)) return;
          throw err;
        }
      }
    };

  console.log = forward("info", original.log);
  console.info = forward("info", original.info);
  console.warn = forward("warn", original.warn);
  console.error = forward("error", original.error);
  console.debug = forward("debug", original.debug);
  console.trace = forward("trace", original.trace);
}
