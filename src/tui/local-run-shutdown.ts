// Coordinates graceful shutdown for local TUI runs.
import {
  MAX_TIMER_TIMEOUT_MS,
  parseStrictNonNegativeInteger,
} from "../infra/parse-finite-number.js";

// Local TUI runs get extra shutdown time because embedded agents/providers may still be closing.
const LOCAL_RUN_SHUTDOWN_GRACE_MS = 120_000;

/** Resolves the hard-exit grace period for local TUI shutdown. */
export function resolveLocalRunShutdownGraceMs(): number {
  const raw = process.env.OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS?.trim();
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed !== undefined) {
    return Math.min(parsed, MAX_TIMER_TIMEOUT_MS);
  }
  return LOCAL_RUN_SHUTDOWN_GRACE_MS;
}
