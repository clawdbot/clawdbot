import util from "node:util";
import type { OpenClawConfig } from "../config/types.js";
import { isVerbose } from "../global-state.js";
import { stripAnsi } from "../terminal/ansi.js";
import { readLoggingConfig, shouldSkipMutatingLoggingConfigRead } from "./config.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { type LogLevel, normalizeLogLevel } from "./levels.js";
import { getLogger } from "./logger.js";
import { redactSensitiveText } from "./redact.js";
import { loggingState } from "./state.js";
import { formatLocalIsoWithOffset, formatTimestamp } from "./timestamps.js";
import type { ConsoleStyle, LoggerSettings } from "./types.js";

export type { ConsoleStyle } from "./types.js";
type ConsoleSettings = {
  level: LogLevel;
  style: ConsoleStyle;
};
export type ConsoleLoggerSettings = ConsoleSettings;

type ConsoleConfigLoader = () => OpenClawConfig["logging"] | undefined;
const loadConfigFallbackDefault: ConsoleConfigLoader = () => undefined;
let loadConfigFallback: ConsoleConfigLoader = loadConfigFallbackDefault;

export function setConsoleConfigLoaderForTests(loader?: ConsoleConfigLoader): void {
  loadConfigFallback = loader ?? loadConfigFallbackDefault;
}

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

  let cfg: OpenClawConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  if (!cfg && !shouldSkipMutatingLoggingConfigRead()) {
    if (loggingState.resolvingConsoleSettings) {
      cfg = undefined;
    } else {
      loggingState.resolvingConsoleSettings = true;
      try {
        cfg = loadConfigFallback();
      } finally {
        loggingState.resolvingConsoleSettings = false;
      }
    }
  }
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
  if (isVerbose()) {
    return false;
  }
  if (SUPPRESSED_CONSOLE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return true;
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
  return formatLocalIsoWithOffset(now);
}

function hasTimestampPrefix(value: string): boolean {
  return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.test(
    value,
  );
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

  const forward =
    (level: LogLevel, orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const formatted = util.format(...args);
      if (shouldSuppressConsoleMessage(formatted)) {
        return;
      }
      const trimmed = stripAnsi(formatted).trimStart();
      const shouldPrefixTimestamp =
        loggingState.consoleTimestampPrefix && trimmed.length > 0 && !hasTimestampPrefix(trimmed);
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
        // In --json mode, all console.* writes are diagnostics and should stay off stdout.
        try {
          const redacted = redactSensitiveText(formatted);
          const line = timestamp ? `${timestamp} ${redacted}` : redacted;
          process.stderr.write(`${line}\n`);
        } catch (err) {
          if (isEpipeError(err)) {
            return;
          }
          throw err;
        }
      } else {
        try {
          const redacted = redactSensitiveText(formatted);
          if (!timestamp) {
            if (args.length === 0) {
              orig.apply(console, args as []);
              return;
            }
            orig.call(console, redacted);
            return;
          }
          orig.call(console, redacted ? `${timestamp} ${redacted}` : timestamp);
        } catch (err) {
          if (isEpipeError(err)) {
            return;
          }
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
