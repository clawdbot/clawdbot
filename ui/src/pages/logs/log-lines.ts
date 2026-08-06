import { stripAnsi } from "../../../../packages/terminal-core/src/ansi.js";
import { parseLogLine as parseCoreLogLine } from "../../../../src/logging/parse-log-line.js";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogEntry = {
  raw: string;
  time?: string | null;
  level?: LogLevel | null;
  subsystem?: string | null;
  message?: string | null;
};

export const DEFAULT_LOG_LEVEL_FILTERS: Record<LogLevel, boolean> = {
  trace: true,
  debug: true,
  info: true,
  warn: true,
  error: true,
  fatal: true,
};

const LEVELS = new Set<LogLevel>(["trace", "debug", "info", "warn", "error", "fatal"]);

function normalizeLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") {
    return null;
  }
  const lowered = normalizeLowercaseStringOrEmpty(value) as LogLevel;
  return LEVELS.has(lowered) ? lowered : null;
}

export function parseLogLine(line: string): LogEntry {
  const parsed = parseCoreLogLine(line);
  if (!parsed) {
    return { raw: line, message: stripAnsi(line) };
  }
  const subsystem = parsed.subsystem ?? parsed.module;
  return {
    raw: parsed.raw,
    time: parsed.time ?? null,
    level: normalizeLevel(parsed.level),
    subsystem: subsystem ? stripAnsi(subsystem) : null,
    message: stripAnsi(parsed.message),
  };
}
