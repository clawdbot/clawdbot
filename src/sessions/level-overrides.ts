import {
  normalizeTraceLevel,
  normalizeVerboseLevel,
  type TraceLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";

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
    return { ok: false, error: 'invalid verboseLevel (use "on"|"off")' };
  }
  const normalized = normalizeVerboseLevel(raw);
  if (!normalized) {
    return { ok: false, error: 'invalid verboseLevel (use "on"|"off")' };
  }
  return { ok: true, value: normalized };
}

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
    return { ok: false, error: 'invalid traceLevel (use "on"|"off")' };
  }
  const normalized = normalizeTraceLevel(raw);
  if (!normalized) {
    return { ok: false, error: 'invalid traceLevel (use "on"|"off")' };
  }
  return { ok: true, value: normalized };
}

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
