import type { GatewayBrowserClient } from "../gateway.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { LogEntry, LogLevel } from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type LogsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  logsLoading: boolean;
  logsError: string | null;
  logsCursor: number | null;
  logsFile: string | null;
  logsEntries: LogEntry[];
  logsTruncated: boolean;
  logsLastFetchAt: number | null;
  logsLimit: number;
  logsMaxBytes: number;
};

const LOG_BUFFER_LIMIT = 2000;
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
      obj && typeof obj._meta === "object" && obj._meta !== null
        ? (obj._meta as Record<string, unknown>)
        : null;
    const time =
      typeof obj.time === "string" ? obj.time : typeof meta?.date === "string" ? meta?.date : null;
    const level = normalizeLevel(meta?.logLevelName ?? meta?.level);

    const contextCandidate =
      typeof obj["0"] === "string" ? obj["0"] : typeof meta?.name === "string" ? meta?.name : null;
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
      subsystem,
      message,
      meta: meta ?? undefined,
    };
  } catch {
    return { raw: line, message: line };
  }
}

export async function loadLogs(state: LogsState, opts?: { reset?: boolean; quiet?: boolean }) {
  const quiet = opts?.quiet === true;
  if (!state.client || !state.connected || (state.logsLoading && !quiet)) {
    return;
  }
  if (!quiet) {
    state.logsLoading = true;
  }
  state.logsError = null;
  try {
    const res = await state.client.request("logs.tail", {
      cursor: opts?.reset ? undefined : (state.logsCursor ?? undefined),
      limit: state.logsLimit,
      maxBytes: state.logsMaxBytes,
    });
    const payload = res as {
      file?: string;
      cursor?: number;
      lines?: unknown;
      truncated?: boolean;
      reset?: boolean;
    };
    const lines = Array.isArray(payload.lines)
      ? payload.lines.filter((line) => typeof line === "string")
      : [];
    const entries = lines.map(parseLogLine);
    const shouldReset = opts?.reset || payload.reset || state.logsCursor == null;
    state.logsEntries = shouldReset
      ? entries
      : [...state.logsEntries, ...entries].slice(-LOG_BUFFER_LIMIT);
    state.logsCursor = typeof payload.cursor === "number" ? payload.cursor : state.logsCursor;
    state.logsFile = typeof payload.file === "string" ? payload.file : state.logsFile;
    state.logsTruncated = Boolean(payload.truncated);
    state.logsLastFetchAt = Date.now();
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.logsEntries = [];
      state.logsError = formatMissingOperatorReadScopeMessage("logs");
    } else {
      state.logsError = String(err);
    }
  } finally {
    if (!quiet) {
      state.logsLoading = false;
    }
  }
}
