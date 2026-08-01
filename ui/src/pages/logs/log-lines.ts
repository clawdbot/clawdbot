import { stripAnsi } from "../../../../packages/terminal-core/src/ansi.js";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogEntry = {
  raw: string;
  time?: string | null;
  level?: LogLevel | null;
  subsystem?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
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

function parseMaybeJsonString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") {
    return null;
  }
  const lowered = normalizeLowercaseStringOrEmpty(value) as LogLevel;
  return LEVELS.has(lowered) ? lowered : null;
}

export function parseLogLine(line: string): LogEntry {
  if (!line.trim()) {
    return { raw: line, message: line };
  }
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const meta =
      obj && typeof obj["_meta"] === "object" && obj["_meta"] !== null
        ? (obj["_meta"] as Record<string, unknown>)
        : null;
    const time =
      typeof obj.time === "string" ? obj.time : typeof meta?.date === "string" ? meta.date : null;
    const level = normalizeLevel(meta?.logLevelName ?? meta?.level);

    const contextCandidate =
      typeof obj["0"] === "string" ? obj["0"] : typeof meta?.name === "string" ? meta.name : null;
    const contextObj = parseMaybeJsonString(contextCandidate);
    let subsystem =
      typeof contextObj?.subsystem === "string"
        ? contextObj.subsystem
        : typeof contextObj?.module === "string"
          ? contextObj.module
          : null;
    if (!subsystem && contextCandidate && contextCandidate.length < 120) {
      subsystem = contextCandidate;
    }

    const message =
      typeof obj["1"] === "string"
        ? obj["1"]
        : typeof obj["2"] === "string"
          ? obj["2"]
          : !contextObj && typeof obj["0"] === "string"
            ? obj["0"]
            : typeof obj.message === "string"
              ? obj.message
              : line;

    return {
      raw: line,
      time,
      level,
      subsystem: subsystem ? stripAnsi(subsystem) : subsystem,
      message: stripAnsi(message),
      meta: meta ?? undefined,
    };
  } catch {
    return { raw: line, message: stripAnsi(line) };
  }
}
