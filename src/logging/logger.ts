import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { Logger as TsLogger } from "tslog";

import type { ClawdbotConfig } from "../config/types.js";
import type { ConsoleStyle } from "./console.js";
import { type LogLevel, levelToMinLevel, normalizeLogLevel } from "./levels.js";
import { readLoggingConfig } from "./config.js";
import { loggingState } from "./state.js";

// Pin to /tmp so mac Debug UI and docs match; os.tmpdir() can be a per-user
// randomized path on macOS which made the “Open log” button a no-op.
export const DEFAULT_LOG_DIR = "/tmp/clawdbot";
export const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "clawdbot.log"); // legacy single-file path

const LOG_PREFIX = "clawdbot";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const requireConfig = createRequire(import.meta.url);

export type LoggerSettings = {
  level?: LogLevel;
  file?: string;
  consoleLevel?: LogLevel;
  consoleStyle?: ConsoleStyle;
};

type LogObj = { date?: Date } & Record<string, unknown>;

type ResolvedSettings = {
  level: LogLevel;
  file: string;
};
export type LoggerResolvedSettings = ResolvedSettings;
export type LogTransportRecord = Record<string, unknown>;
export type LogTransport = (logObj: LogTransportRecord) => void;

const externalTransports = new Set<LogTransport>();

function attachExternalTransport(logger: TsLogger<LogObj>, transport: LogTransport): void {
  logger.attachTransport((logObj: LogObj) => {
    if (!externalTransports.has(transport)) return;
    try {
      transport(logObj as LogTransportRecord);
    } catch {
      // never block on logging failures
    }
  });
}

function resolveSettings(): ResolvedSettings {
  let cfg: ClawdbotConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  if (!cfg) {
    try {
      const loaded = requireConfig("../config/config.js") as {
        loadConfig?: () => ClawdbotConfig;
      };
      cfg = loaded.loadConfig?.().logging;
    } catch {
      cfg = undefined;
    }
  }
  const level = normalizeLogLevel(cfg?.level, "info");
  const file = cfg?.file ?? defaultRollingPathForToday();
  return { level, file };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) return true;
  return a.level !== b.level || a.file !== b.file;
}

export function isFileLogLevelEnabled(level: LogLevel): boolean {
  const settings = (loggingState.cachedSettings as ResolvedSettings | null) ?? resolveSettings();
  if (!loggingState.cachedSettings) loggingState.cachedSettings = settings;
  if (settings.level === "silent") return false;
  return levelToMinLevel(level) <= levelToMinLevel(settings.level);
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
  for (const transport of externalTransports) {
    attachExternalTransport(logger, transport);
  }

  return logger;
}

export function getLogger(): TsLogger<LogObj> {
  const settings = resolveSettings();
  const cachedLogger = loggingState.cachedLogger as TsLogger<LogObj> | null;
  const cachedSettings = loggingState.cachedSettings as ResolvedSettings | null;
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    loggingState.cachedLogger = buildLogger(settings);
    loggingState.cachedSettings = settings;
  }
  return loggingState.cachedLogger as TsLogger<LogObj>;
}

export function getChildLogger(
  bindings?: Record<string, unknown>,
  opts?: { level?: LogLevel },
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

// Baileys expects a pino-like logger shape. Provide a lightweight adapter.
export function toPinoLikeLogger(logger: TsLogger<LogObj>, level: LogLevel): PinoLikeLogger {
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

// Test helpers
export function setLoggerOverride(settings: LoggerSettings | null) {
  loggingState.overrideSettings = settings;
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
}

export function resetLogger() {
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
  loggingState.overrideSettings = null;
}

export function registerLogTransport(transport: LogTransport): () => void {
  externalTransports.add(transport);
  const logger = loggingState.cachedLogger as TsLogger<LogObj> | null;
  if (logger) {
    attachExternalTransport(logger, transport);
  }
  return () => {
    externalTransports.delete(transport);
  };
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultRollingPathForToday(): string {
  const today = formatLocalDate(new Date());
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
      if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) continue;
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
