import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import pino, { type Bindings, type LevelWithSilent, type Logger } from "pino";
import { loadConfig, type WarelayConfig } from "./config/config.js";
import { isVerbose } from "./globals.js";

export const DEFAULT_LOG_DIR = path.join(os.tmpdir(), "warelay");
export const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "warelay.log"); // legacy single-file path

const LOG_PREFIX = "warelay";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const ALLOWED_LEVELS: readonly LevelWithSilent[] = [
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

export type LoggerSettings = {
  level?: LevelWithSilent;
  file?: string;
};

type ResolvedSettings = {
  level: LevelWithSilent;
  file: string;
};
export type LoggerResolvedSettings = ResolvedSettings;

let cachedLogger: Logger | null = null;
let cachedSettings: ResolvedSettings | null = null;
let overrideSettings: LoggerSettings | null = null;

function normalizeLevel(level?: string): LevelWithSilent {
  if (isVerbose()) return "debug";
  const candidate = level ?? "info";
  return ALLOWED_LEVELS.includes(candidate as LevelWithSilent)
    ? (candidate as LevelWithSilent)
    : "info";
}

function resolveSettings(): ResolvedSettings {
  const cfg: WarelayConfig["logging"] | undefined =
    overrideSettings ?? loadConfig().logging;
  const level = normalizeLevel(cfg?.level);
  const file = cfg?.file ?? defaultRollingPathForToday();
  return { level, file };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) return true;
  return a.level !== b.level || a.file !== b.file;
}

function buildLogger(settings: ResolvedSettings): Logger {
  fs.mkdirSync(path.dirname(settings.file), { recursive: true });
  // Clean up stale rolling logs when using a dated log filename.
  if (isRollingPath(settings.file)) {
    pruneOldRollingLogs(path.dirname(settings.file));
  }
  const destination = pino.destination({
    dest: settings.file,
    mkdir: true,
    sync: true, // deterministic for tests; log volume is modest.
  });
  return pino(
    {
      level: settings.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

export function getLogger(): Logger {
  const settings = resolveSettings();
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    cachedLogger = buildLogger(settings);
    cachedSettings = settings;
  }
  return cachedLogger;
}

export function getChildLogger(
  bindings?: Bindings,
  opts?: { level?: LevelWithSilent },
): Logger {
  return getLogger().child(bindings ?? {}, opts);
}

export function getResolvedLoggerSettings(): LoggerResolvedSettings {
  return resolveSettings();
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
  overrideSettings = null;
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
