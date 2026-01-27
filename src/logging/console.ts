import { createRequire } from "node:module";
import util from "node:util";

import type { MoltbotConfig } from "../config/types.js";
import { isVerbose } from "../globals.js";
import { stripAnsi } from "../terminal/ansi.js";
import { type LogLevel, normalizeLogLevel } from "./levels.js";
import { getLogger, type LoggerSettings } from "./logger.js";
import { readLoggingConfig } from "./config.js";
import { loggingState } from "./state.js";

export type ConsoleStyle = "pretty" | "compact" | "json";
type ConsoleSettings = {
  level: LogLevel;
  style: ConsoleStyle;
};
export type ConsoleLoggerSettings = ConsoleSettings;

const requireConfig = createRequire(import.meta.url);

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
  let cfg: MoltbotConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  if (!cfg) {
    if (loggingState.resolvingConsoleSettings) {
      cfg = undefined;
    } else {
      loggingState.resolvingConsoleSettings = true;
      try {
        const loaded = requireConfig("../config/config.js") as {
          loadConfig?: () => MoltbotConfig;
        };
        cfg = loaded.loadConfig?.().logging;
      } catch {
        cfg = undefined;
      } finally {
        loggingState.resolvingConsoleSettings = false;
      }
    }
  }
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

export function setConsoleTimestampPrefix(enabled: boolean): void {
  loggingState.consoleTimestampPrefix = enabled;
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
  if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return true;
  }
  if (
    message.startsWith("[EventQueue] Slow listener detected") &&
    message.includes("DiscordMessageListener")
  ) {
    return true;
  }
  return false;
}

function isEpipeError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

function formatConsoleTimestamp(style: ConsoleStyle): string {
  const now = new Date().toISOString();
  if (style === "pretty") return now.slice(11, 19);
  return now;
}

function hasTimestampPrefix(value: string): boolean {
  return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/.test(value);
}

function isJsonPayload(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Route console.* calls through file logging while still emitting to stdout/stderr.
 * This keeps user-facing output unchanged but guarantees every console call is captured in log files.
 */
export function enableConsoleCapture(): void {
  if (loggingState.consolePatched) return;
  loggingState.consolePatched = true;

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

  const forward =
    (level: LogLevel, orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const formatted = util.format(...args);
      if (shouldSuppressConsoleMessage(formatted)) return;
      const trimmed = stripAnsi(formatted).trimStart();
      const shouldPrefixTimestamp =
        loggingState.consoleTimestampPrefix &&
        trimmed.length > 0 &&
        !hasTimestampPrefix(trimmed) &&
        !isJsonPayload(trimmed);
      const timestamp = shouldPrefixTimestamp
        ? formatConsoleTimestamp(getConsoleSettings().style)
        : "";
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
      if (loggingState.forceConsoleToStderr) {
        // in RPC/JSON mode, keep stdout clean
        try {
          const line = timestamp ? `${timestamp} ${formatted}` : formatted;
          process.stderr.write(`${line}\n`);
        } catch (err) {
          if (isEpipeError(err)) return;
          throw err;
        }
      } else {
        try {
          if (!timestamp) {
            orig.apply(console, args as []);
            return;
          }
          if (args.length === 0) {
            orig.call(console, timestamp);
            return;
          }
          if (typeof args[0] === "string") {
            orig.call(console, `${timestamp} ${args[0]}`, ...args.slice(1));
            return;
          }
          orig.call(console, timestamp, ...args);
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
