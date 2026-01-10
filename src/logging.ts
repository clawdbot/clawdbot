import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { Chalk } from "chalk";
import { Logger as TsLogger } from "tslog";
import { type ClawdbotConfig, loadConfig } from "./config/config.js";
import { isVerbose } from "./globals.js";
import { CHAT_PROVIDER_ORDER } from "./providers/registry.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

// Pin to /tmp so mac Debug UI and docs match; os.tmpdir() can be a per-user
// randomized path on macOS which made the “Open log” button a no-op.
export const DEFAULT_LOG_DIR = "/tmp/clawdbot";
export const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "clawdbot.log"); // legacy single-file path

const LOG_PREFIX = "clawdbot";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const ALLOWED_LEVELS = [
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

type Level = (typeof ALLOWED_LEVELS)[number];

export type LoggerSettings = {
  level?: Level;
  file?: string;
  consoleLevel?: Level;
  consoleStyle?: ConsoleStyle;
};

type LogObj = { date?: Date } & Record<string, unknown>;

type ResolvedSettings = {
  level: Level;
  file: string;
};
export type LoggerResolvedSettings = ResolvedSettings;

export type ConsoleStyle = "pretty" | "compact" | "json";
type ConsoleSettings = {
  level: Level;
  style: ConsoleStyle;
};
export type ConsoleLoggerSettings = ConsoleSettings;

let cachedLogger: TsLogger<LogObj> | null = null;
let cachedSettings: ResolvedSettings | null = null;
let cachedConsoleSettings: ConsoleSettings | null = null;
let overrideSettings: LoggerSettings | null = null;
let consolePatched = false;
let forceConsoleToStderr = false;
let consoleSubsystemFilter: string[] | null = null;
let rawConsole: {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
} | null = null;

function normalizeLevel(level?: string): Level {
  const candidate = level ?? "info";
  return ALLOWED_LEVELS.includes(candidate as Level)
    ? (candidate as Level)
    : "info";
}

function resolveSettings(): ResolvedSettings {
  const cfg: ClawdbotConfig["logging"] | undefined =
    overrideSettings ?? loadConfig().logging;
  const level = normalizeLevel(cfg?.level);
  const file = cfg?.file ?? defaultRollingPathForToday();
  return { level, file };
}

function resolveConsoleSettings(): ConsoleSettings {
  const cfg: ClawdbotConfig["logging"] | undefined =
    overrideSettings ?? loadConfig().logging;
  const level = normalizeConsoleLevel(cfg?.consoleLevel);
  const style = normalizeConsoleStyle(cfg?.consoleStyle);
  return { level, style };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) return true;
  return a.level !== b.level || a.file !== b.file;
}

function consoleSettingsChanged(a: ConsoleSettings | null, b: ConsoleSettings) {
  if (!a) return true;
  return a.level !== b.level || a.style !== b.style;
}

function levelToMinLevel(level: Level): number {
  // tslog level ordering: fatal=0, error=1, warn=2, info=3, debug=4, trace=5
  const map: Record<Level, number> = {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
    silent: Number.POSITIVE_INFINITY,
  };
  return map[level];
}

export function isFileLogLevelEnabled(level: LogLevel): boolean {
  const settings = cachedSettings ?? resolveSettings();
  if (!cachedSettings) cachedSettings = settings;
  return levelToMinLevel(level) <= levelToMinLevel(settings.level);
}

function normalizeConsoleLevel(level?: string): Level {
  if (isVerbose()) return "debug";
  const candidate = level ?? "info";
  return ALLOWED_LEVELS.includes(candidate as Level)
    ? (candidate as Level)
    : "info";
}

function normalizeConsoleStyle(style?: string): ConsoleStyle {
  if (style === "compact" || style === "json" || style === "pretty") {
    return style;
  }
  if (!process.stdout.isTTY) return "compact";
  return "pretty";
}

function buildLogger(settings: ResolvedSettings): TsLogger<LogObj> {
  fs.mkdirSync(path.dirname(settings.file), { recursive: true });
  // Clean up stale rolling logs when using a dated log filename.
  if (isRollingPath(settings.file)) {
    pruneOldRollingLogs(path.dirname(settings.file));
  }
  const logger = new TsLogger<LogObj>({
    name: "clawdbot",
    minLevel: levelToMinLevel(settings.level),
    type: "hidden", // no ansi formatting
  });

  logger.attachTransport((logObj: LogObj) => {
    try {
      const time = logObj.date?.toISOString?.() ?? new Date().toISOString();
      const line = JSON.stringify({ ...logObj, time });
      fs.appendFileSync(settings.file, `${line}\n`, { encoding: "utf8" });
    } catch {
      // never block on logging failures
    }
  });

  return logger;
}

export function getLogger(): TsLogger<LogObj> {
  const settings = resolveSettings();
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    cachedLogger = buildLogger(settings);
    cachedSettings = settings;
  }
  return cachedLogger;
}

export function getConsoleSettings(): ConsoleLoggerSettings {
  const settings = resolveConsoleSettings();
  if (
    !cachedConsoleSettings ||
    consoleSettingsChanged(cachedConsoleSettings, settings)
  ) {
    cachedConsoleSettings = settings;
  }
  return cachedConsoleSettings;
}

export function getChildLogger(
  bindings?: Record<string, unknown>,
  opts?: { level?: Level },
): TsLogger<LogObj> {
  const base = getLogger();
  const minLevel = opts?.level ? levelToMinLevel(opts.level) : undefined;
  const name = bindings ? JSON.stringify(bindings) : undefined;
  return base.getSubLogger({
    name,
    minLevel,
    prefix: bindings ? [name ?? ""] : [],
  });
}

export type LogLevel = Level;

// Baileys expects a pino-like logger shape. Provide a lightweight adapter.
export function toPinoLikeLogger(
  logger: TsLogger<LogObj>,
  level: Level,
): PinoLikeLogger {
  const buildChild = (bindings?: Record<string, unknown>) =>
    toPinoLikeLogger(
      logger.getSubLogger({
        name: bindings ? JSON.stringify(bindings) : undefined,
      }),
      level,
    );

  return {
    level,
    child: buildChild,
    trace: (...args: unknown[]) => logger.trace(...args),
    debug: (...args: unknown[]) => logger.debug(...args),
    info: (...args: unknown[]) => logger.info(...args),
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    fatal: (...args: unknown[]) => logger.fatal(...args),
  };
}

export type PinoLikeLogger = {
  level: string;
  child: (bindings?: Record<string, unknown>) => PinoLikeLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
};

export function getResolvedLoggerSettings(): LoggerResolvedSettings {
  return resolveSettings();
}

export function getResolvedConsoleSettings(): ConsoleLoggerSettings {
  return getConsoleSettings();
}

// Test helpers
export function setLoggerOverride(settings: LoggerSettings | null) {
  overrideSettings = settings;
  cachedLogger = null;
  cachedSettings = null;
}

export function resetLogger() {
  cachedLogger = null;
  cachedSettings = null;
  cachedConsoleSettings = null;
  overrideSettings = null;
}

// Route all console output (including tslog console writes) to stderr.
// This keeps stdout clean for RPC/JSON modes.
export function routeLogsToStderr(): void {
  forceConsoleToStderr = true;
}

export function setConsoleSubsystemFilter(filters?: string[] | null): void {
  if (!filters || filters.length === 0) {
    consoleSubsystemFilter = null;
    return;
  }
  const normalized = filters
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  consoleSubsystemFilter = normalized.length > 0 ? normalized : null;
}

export function shouldLogSubsystemToConsole(subsystem: string): boolean {
  if (!consoleSubsystemFilter || consoleSubsystemFilter.length === 0) {
    return true;
  }
  return consoleSubsystemFilter.some(
    (prefix) => subsystem === prefix || subsystem.startsWith(`${prefix}/`),
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
  if (isVerbose()) return false;
  return SUPPRESSED_CONSOLE_PREFIXES.some((prefix) =>
    message.startsWith(prefix),
  );
}

function isEpipeError(err: unknown): boolean {
  return Boolean((err as { code?: string })?.code === "EPIPE");
}

/**
 * Route console.* calls through pino while still emitting to stdout/stderr.
 * This keeps user-facing output unchanged but guarantees every console call is captured in log files.
 */
export function enableConsoleCapture(): void {
  if (consolePatched) return;
  consolePatched = true;

  const logger = getLogger();

  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
  rawConsole = {
    log: original.log,
    info: original.info,
    warn: original.warn,
    error: original.error,
  };

  const forward =
    (level: Level, orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const formatted = util.format(...args);
      if (shouldSuppressConsoleMessage(formatted)) return;
      try {
        // Map console levels to pino
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
      if (forceConsoleToStderr) {
        const target =
          level === "error" || level === "fatal" || level === "warn"
            ? process.stderr
            : process.stderr; // in RPC/JSON mode, keep stdout clean
        try {
          target.write(`${formatted}\n`);
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

type SubsystemLogger = {
  subsystem: string;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  fatal: (message: string, meta?: Record<string, unknown>) => void;
  raw: (message: string) => void;
  child: (name: string) => SubsystemLogger;
};

function shouldLogToConsole(level: Level, settings: ConsoleSettings): boolean {
  const current = levelToMinLevel(level);
  const min = levelToMinLevel(settings.level);
  return current <= min;
}

type ChalkInstance = InstanceType<typeof Chalk>;

function isRichConsoleEnv(): boolean {
  const term = (process.env.TERM ?? "").toLowerCase();
  if (process.env.COLORTERM || process.env.TERM_PROGRAM) return true;
  return term.length > 0 && term !== "dumb";
}

function getColorForConsole(): ChalkInstance {
  const hasForceColor =
    typeof process.env.FORCE_COLOR === "string" &&
    process.env.FORCE_COLOR.trim().length > 0 &&
    process.env.FORCE_COLOR.trim() !== "0";
  if (process.env.NO_COLOR && !hasForceColor) return new Chalk({ level: 0 });
  const hasTty = Boolean(process.stdout.isTTY || process.stderr.isTTY);
  return hasTty || isRichConsoleEnv()
    ? new Chalk({ level: 1 })
    : new Chalk({ level: 0 });
}

const SUBSYSTEM_COLORS = [
  "cyan",
  "green",
  "yellow",
  "blue",
  "magenta",
  "red",
] as const;
const SUBSYSTEM_COLOR_OVERRIDES: Record<
  string,
  (typeof SUBSYSTEM_COLORS)[number]
> = {
  "gmail-watcher": "blue",
};
const SUBSYSTEM_PREFIXES_TO_DROP = ["gateway", "providers"] as const;
const SUBSYSTEM_MAX_SEGMENTS = 2;
const PROVIDER_SUBSYSTEM_PREFIXES = new Set<string>(CHAT_PROVIDER_ORDER);

function pickSubsystemColor(
  color: ChalkInstance,
  subsystem: string,
): ChalkInstance {
  const override = SUBSYSTEM_COLOR_OVERRIDES[subsystem];
  if (override) return color[override];
  let hash = 0;
  for (let i = 0; i < subsystem.length; i += 1) {
    hash = (hash * 31 + subsystem.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % SUBSYSTEM_COLORS.length;
  const name = SUBSYSTEM_COLORS[idx];
  return color[name];
}

function formatSubsystemForConsole(subsystem: string): string {
  const parts = subsystem.split("/").filter(Boolean);
  const original = parts.join("/") || subsystem;
  while (
    parts.length > 0 &&
    SUBSYSTEM_PREFIXES_TO_DROP.includes(
      parts[0] as (typeof SUBSYSTEM_PREFIXES_TO_DROP)[number],
    )
  ) {
    parts.shift();
  }
  if (parts.length === 0) return original;
  if (PROVIDER_SUBSYSTEM_PREFIXES.has(parts[0])) {
    return parts[0];
  }
  if (parts.length > SUBSYSTEM_MAX_SEGMENTS) {
    return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");
  }
  return parts.join("/");
}

function formatConsoleLine(opts: {
  level: Level;
  subsystem: string;
  message: string;
  style: ConsoleStyle;
  meta?: Record<string, unknown>;
}): string {
  const displaySubsystem =
    opts.style === "json"
      ? opts.subsystem
      : formatSubsystemForConsole(opts.subsystem);
  if (opts.style === "json") {
    return JSON.stringify({
      time: new Date().toISOString(),
      level: opts.level,
      subsystem: displaySubsystem,
      message: opts.message,
      ...opts.meta,
    });
  }
  const color = getColorForConsole();
  const prefix = `[${displaySubsystem}]`;
  const prefixColor = pickSubsystemColor(color, displaySubsystem);
  const levelColor =
    opts.level === "error" || opts.level === "fatal"
      ? color.red
      : opts.level === "warn"
        ? color.yellow
        : opts.level === "debug" || opts.level === "trace"
          ? color.gray
          : color.cyan;
  const time =
    opts.style === "pretty"
      ? color.gray(new Date().toISOString().slice(11, 19))
      : "";
  const prefixToken = prefixColor(prefix);
  const head = [time, prefixToken].filter(Boolean).join(" ");
  return `${head} ${levelColor(opts.message)}`;
}

function writeConsoleLine(level: Level, line: string) {
  const sanitized =
    process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
      ? line
          .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?")
          .replace(/[\uD800-\uDFFF]/g, "?")
      : line;
  const sink = rawConsole ?? console;
  if (forceConsoleToStderr || level === "error" || level === "fatal") {
    (sink.error ?? console.error)(sanitized);
  } else if (level === "warn") {
    (sink.warn ?? console.warn)(sanitized);
  } else {
    (sink.log ?? console.log)(sanitized);
  }
}

function logToFile(
  fileLogger: TsLogger<LogObj>,
  level: Level,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (level === "silent") return;
  const safeLevel = level as Exclude<Level, "silent">;
  const method = (fileLogger as unknown as Record<string, unknown>)[
    safeLevel
  ] as unknown as ((...args: unknown[]) => void) | undefined;
  if (typeof method !== "function") return;
  if (meta && Object.keys(meta).length > 0) {
    method.call(fileLogger, meta, message);
  } else {
    method.call(fileLogger, message);
  }
}

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  let fileLogger: TsLogger<LogObj> | null = null;
  const getFileLogger = () => {
    if (!fileLogger) fileLogger = getChildLogger({ subsystem });
    return fileLogger;
  };
  const emit = (
    level: Level,
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    const consoleSettings = getConsoleSettings();
    let consoleMessageOverride: string | undefined;
    let fileMeta = meta;
    if (meta && Object.keys(meta).length > 0) {
      const { consoleMessage, ...rest } = meta as Record<string, unknown> & {
        consoleMessage?: unknown;
      };
      if (typeof consoleMessage === "string") {
        consoleMessageOverride = consoleMessage;
      }
      fileMeta = Object.keys(rest).length > 0 ? rest : undefined;
    }
    logToFile(getFileLogger(), level, message, fileMeta);
    if (!shouldLogToConsole(level, consoleSettings)) return;
    if (!shouldLogSubsystemToConsole(subsystem)) return;
    const line = formatConsoleLine({
      level,
      subsystem,
      message:
        consoleSettings.style === "json"
          ? message
          : (consoleMessageOverride ?? message),
      style: consoleSettings.style,
      meta: fileMeta,
    });
    writeConsoleLine(level, line);
  };

  const logger: SubsystemLogger = {
    subsystem,
    trace: (message, meta) => emit("trace", message, meta),
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
    fatal: (message, meta) => emit("fatal", message, meta),
    raw: (message) => {
      logToFile(getFileLogger(), "info", message, { raw: true });
      if (shouldLogSubsystemToConsole(subsystem)) {
        writeConsoleLine("info", message);
      }
    },
    child: (name) => createSubsystemLogger(`${subsystem}/${name}`),
  };
  return logger;
}

export function runtimeForLogger(
  logger: SubsystemLogger,
  exit: RuntimeEnv["exit"] = defaultRuntime.exit,
): RuntimeEnv {
  return {
    log: (message: string) => logger.info(message),
    error: (message: string) => logger.error(message),
    exit,
  };
}

export function createSubsystemRuntime(
  subsystem: string,
  exit: RuntimeEnv["exit"] = defaultRuntime.exit,
): RuntimeEnv {
  return runtimeForLogger(createSubsystemLogger(subsystem), exit);
}

function defaultRollingPathForToday(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(DEFAULT_LOG_DIR, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}

function isRollingPath(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith(`${LOG_PREFIX}-`) &&
    base.endsWith(LOG_SUFFIX) &&
    base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length
  );
}

function pruneOldRollingLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (
        !entry.name.startsWith(`${LOG_PREFIX}-`) ||
        !entry.name.endsWith(LOG_SUFFIX)
      )
        continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // ignore errors during pruning
      }
    }
  } catch {
    // ignore missing dir or read errors
  }
}
