// Session level override helpers normalize per-session logging and behavior levels.
import {
  normalizeTraceLevel,
  normalizeVerboseLevel,
  type TraceLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";

const INVALID_VERBOSE_LEVEL_ERROR = 'invalid verboseLevel (use "on"|"off"|"full")';

// Session-level override parsers use tri-state results: undefined means no
// change, null clears the saved override, and a level writes the override.
export function parseVerboseOverride(
  raw: unknown,
): { ok: true; value: VerboseLevel | null | undefined } | { ok: false; error: string } {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: INVALID_VERBOSE_LEVEL_ERROR };
  }
  const normalized = normalizeVerboseLevel(raw);
  if (!normalized) {
    return { ok: false, error: INVALID_VERBOSE_LEVEL_ERROR };
  }
  return { ok: true, value: normalized };
}

// Mutates a persisted session entry after parsing. Callers keep parse/apply
// separate so invalid user input can be reported before touching the store.
export function applyVerboseOverride(entry: SessionEntry, level: VerboseLevel | null | undefined) {
  if (level === undefined) {
    return;
  }
  if (level === null) {
    delete entry.verboseLevel;
    return;
  }
  entry.verboseLevel = level;
}

export function parseTraceOverride(
  raw: unknown,
): { ok: true; value: TraceLevel | null | undefined } | { ok: false; error: string } {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: 'invalid traceLevel (use "on"|"off"|"raw")' };
  }
  const normalized = normalizeTraceLevel(raw);
  if (!normalized) {
    return { ok: false, error: 'invalid traceLevel (use "on"|"off"|"raw")' };
  }
  return { ok: true, value: normalized };
}

// Mutates trace override with the same tri-state contract as verbose level.
export function applyTraceOverride(entry: SessionEntry, level: TraceLevel | null | undefined) {
  if (level === undefined) {
    return;
  }
  if (level === null) {
    delete entry.traceLevel;
    return;
  }
  entry.traceLevel = level;
}
