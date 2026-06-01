import { isSubagentSessionKey } from "../../routing/session-key.js";
import type { CronServiceState } from "./state.js";

/** Enqueues a manual cron wake event and optionally pokes the targeted heartbeat loop. */
export function wake(
  state: CronServiceState,
  opts: { mode: "now" | "next-heartbeat"; text: string; sessionKey?: string },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  const sessionKey = opts.sessionKey?.trim() || undefined;
  if (sessionKey && isSubagentSessionKey(sessionKey)) {
    return { ok: false, reason: "unwakeable-session-key" } as const;
  }
  state.deps.enqueueSystemEvent(text, sessionKey ? { sessionKey } : undefined);
  if (opts.mode === "now") {
    state.deps.requestHeartbeat({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      ...(sessionKey ? { sessionKey } : {}),
    });
  } else if (sessionKey) {
    // next-heartbeat + sessionKey still needs a targeted immediate wake.
    // Reasons:
    //   1. The regularly-scheduled heartbeat fires for the agent's main
    //      session, not the supplied sessionKey, so it never peeks the queue
    //      we just enqueued - the event would sit stranded indefinitely.
    //   2. An `intent: "event"` wake gets deferred by heartbeat-runner as
    //      not-due and is not retried (only busy-skips are), so it cannot
    //      stand in for the regular cadence either.
    // Effectively, --session-key collapses --mode now and --mode next-heartbeat
    // into the same targeted-immediate behavior - this matches the documented
    // user intent (target a specific session for relay) better than silently
    // dropping the event.
    state.deps.requestHeartbeat({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey,
    });
  }
  return { ok: true } as const;
}
