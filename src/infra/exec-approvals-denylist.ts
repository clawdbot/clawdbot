// Exec approval denylist: an operator-authored STOP list that forces an
// explicit human approval for matching commands even when the resolved policy
// (including `security=full` + `ask="off"`) or a durable allowlist grant would
// otherwise auto-run them. Deny wins over allow.
//
// Two openclaw.json config layers feed the effective denylist and are merged
// as a UNION (stricter-wins: a deny in EITHER layer denies):
//   1. openclaw.json  -> `tools.exec.denylist` (global) and
//                        `agents.list.<id>.tools.exec.denylist` (per-agent)
//
// Patterns use the SAME glob language as the exec allowlist (via
// `matchesExecGlob`): `*` -> any run of non-`/` chars, `**` -> any run,
// `?` -> one non-`/` char, case-insensitive on win32.
import { matchesExecGlob } from "./exec-allowlist-pattern.js";

export type ExecDenylistEntry = {
  /** Glob pattern matched against analyzed command/argv text. */
  pattern: string;
  /** Optional human-readable reason surfaced in the approval prompt. */
  reason?: string;
};

type ExecDenylistMatch = {
  pattern: string;
  reason?: string;
} | null;

/** A parsed command segment (as produced by allowlist analysis). */
export type ExecDenylistSegment = {
  argv: string[];
  raw?: string;
};

function basename(token: string): string {
  const parts = token.split(/[\\/]/);
  const last = parts.at(-1);
  return last && last.length > 0 ? last : token;
}

/** Normalizes a single raw denylist entry, dropping malformed input. */
function normalizeExecDenylistEntry(raw: unknown): ExecDenylistEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const pattern = typeof record.pattern === "string" ? record.pattern.trim() : "";
  if (!pattern) {
    return null;
  }
  const reasonRaw = record.reason;
  const reason =
    typeof reasonRaw === "string" && reasonRaw.trim().length > 0 ? reasonRaw.trim() : undefined;
  return reason ? { pattern, reason } : { pattern };
}

/** Normalizes and de-duplicates a raw denylist array (unknown-safe). */
function normalizeExecDenylist(raw: unknown): ExecDenylistEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ExecDenylistEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = normalizeExecDenylistEntry(item);
    if (!entry) {
      continue;
    }
    const key = `${entry.pattern}\u0000${entry.reason ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Strict validation for config-file surfaces (openclaw.json). Returns a list of
 * human-readable errors; empty array means valid/absent. Unlike
 * {@link normalizeExecDenylist} (which silently drops malformed entries for the
 * self-healing approvals file) this REJECTS malformed input so `config validate`
 * fails loudly rather than silently ignoring a mistyped STOP rule.
 */
export function collectExecDenylistErrors(raw: unknown, path: string): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [`${path} must be an array of { pattern, reason? } entries`];
  }
  const errors: string[] = [];
  raw.forEach((item, index) => {
    const at = `${path}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${at} must be an object with a non-empty "pattern"`);
      return;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.pattern !== "string" || record.pattern.trim().length === 0) {
      errors.push(`${at}.pattern must be a non-empty string`);
    }
    if (record.reason !== undefined && typeof record.reason !== "string") {
      errors.push(`${at}.reason must be a string when present`);
    }
  });
  return errors;
}

/**
 * Stable identity key for a denylist entry (pattern + reason). Mirrors the
 * de-duplication key used by {@link normalizeExecDenylist} so callers can tell
 * whether a currently-effective rule was already present when an authorization
 * snapshot was captured (i.e. detect a newly-added STOP rule).
 */
export function buildExecDenylistRuleKey(entry: ExecDenylistEntry): string {
  return `${entry.pattern}\u0000${entry.reason ?? ""}`;
}

/**
 * Resolves the effective denylist as the de-duplicated UNION of every supplied
 * config layer (order-independent). Any entry from any layer applies
 * (stricter-wins / deny-over-allow across layers).
 */
export function resolveEffectiveExecDenylist(params: {
  layers: ReadonlyArray<unknown>;
}): ExecDenylistEntry[] {
  const merged: unknown[] = [];
  for (const layer of params.layers) {
    if (Array.isArray(layer)) {
      merged.push(...layer);
    }
  }
  return normalizeExecDenylist(merged);
}

function segmentTargets(segment: ExecDenylistSegment): string[] {
  const targets = new Set<string>();
  if (Array.isArray(segment.argv) && segment.argv.length > 0) {
    targets.add(segment.argv.join(" "));
    // basename variant so `/usr/bin/git push --force` still matches
    // `git push*--force*` written against the bare executable name.
    const exe = segment.argv[0];
    const rest = segment.argv.slice(1);
    if (exe) {
      targets.add([basename(exe), ...rest].join(" "));
    }
  }
  const raw = segment.raw?.trim();
  if (raw) {
    targets.add(raw);
  }
  return [...targets];
}

type ExecDenylistEvaluation = {
  /** Non-null when a denylist entry matched -> approval is mandatory. */
  match: ExecDenylistMatch;
  /**
   * True when a denylist is configured but the command could not be screened
   * (analysis failed and no segments were produced). Callers must require
   * approval rather than fail open.
   */
  conservativeApproval: boolean;
};

/**
 * Evaluates a command against the effective denylist. Matches each entry glob
 * against the whole command text plus every analyzed segment's argv/basename
 * text. Returns the first match. When nothing matches but the command was
 * unanalyzable, requests conservative approval instead of failing open.
 */
export function evaluateExecDenylist(params: {
  command: string;
  segments: ReadonlyArray<ExecDenylistSegment>;
  denylist: ReadonlyArray<ExecDenylistEntry>;
  analysisOk: boolean;
}): ExecDenylistEvaluation {
  if (params.denylist.length === 0) {
    return { match: null, conservativeApproval: false };
  }
  const targets = new Set<string>();
  const command = params.command.trim();
  if (command) {
    targets.add(command);
  }
  for (const segment of params.segments) {
    for (const target of segmentTargets(segment)) {
      targets.add(target);
    }
  }
  for (const entry of params.denylist) {
    for (const target of targets) {
      if (matchesExecGlob(entry.pattern, target)) {
        return {
          match: entry.reason
            ? { pattern: entry.pattern, reason: entry.reason }
            : { pattern: entry.pattern },
          conservativeApproval: false,
        };
      }
    }
  }
  const conservativeApproval = !params.analysisOk && params.segments.length === 0;
  return { match: null, conservativeApproval };
}

/** Formats the approval-prompt warning for a denylist hit. */
export function formatExecDenylistWarning(match: NonNullable<ExecDenylistMatch>): string {
  const reason = match.reason ? ` (${match.reason})` : "";
  return `Warning: command matches exec denylist entry ${match.pattern}${reason}; explicit approval is required.`;
}
