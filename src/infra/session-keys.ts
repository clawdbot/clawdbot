// Canonical guard for key-gated side-effects.
//
// Several call-sites need to skip (rather than throw) when sessionKey is
// missing or blank — typically observability/persistence emissions where the
// dropped call is a no-op rather than a correctness failure. Without a shared
// helper, each site re-implements `params.sessionKey?.trim()` plus its own
// log line, which makes "where did we skip a side-effect because key was
// missing" hard to grep.
//
// Use this for caller-level guards that want to *skip and log*. For bottom-of-
// stack invariants where the missing key is a programmer error, keep the
// throwing `requireSessionKey` in `system-events.ts` instead.
//
// Keep skip-and-log callers distinguishable from bottom-of-stack invariants.

type SessionKeyParams = {
  sessionKey?: string | null;
  sessionId?: string | null;
};

type SessionKeyLogger = {
  warn: (msg: string) => void;
};

/**
 * Returns the trimmed `sessionKey` if non-empty, else logs a structured
 * warning and returns `null`. Callers decide their fallback behavior
 * explicitly (typically: early-return / skip the side-effect).
 *
 * The warning is anchored on `[session-key:missing]` so all skip sites can be
 * grepped from one place.
 *
 * @param params object containing `sessionKey` (optional) and `sessionId` (optional, used for diagnostics)
 * @param log    structured logger with `.warn`
 * @param site   stable site identifier (e.g. `"pi-runner.timeout-compaction"`) used for grouping skip events
 */
export function requireSessionKeyOrSkip(
  params: SessionKeyParams,
  log: SessionKeyLogger,
  site: string,
): string | null {
  const sk = params.sessionKey?.trim();
  if (sk) {
    return sk;
  }
  log.warn(`[session-key:missing] site=${site} sessionId=${params.sessionId ?? "?"}`);
  return null;
}
