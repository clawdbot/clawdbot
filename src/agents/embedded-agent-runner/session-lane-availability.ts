/**
 * Read-only availability view of a session's command-queue lane.
 *
 * A gateway `agent` dispatch keyed on a session key serializes on that session's
 * lane, so a caller that dispatches into a session currently holding its own
 * turn cannot be admitted until that turn ends. Lane state already answers
 * "could this session start another turn right now" — this module is the
 * session-keyed view of that answer, plus the matching release edge, so callers
 * do not have to know the `session:<key>` lane naming or reach into the queue.
 *
 * Nothing here mutates lane state.
 */
import {
  type CommandLaneSnapshot,
  isCommandLaneAdmissible,
  getCommandLaneSnapshot,
  subscribeCommandLaneRelease,
} from "../../process/command-queue.js";
import { resolveSessionLane } from "./lanes.js";

export type SessionLaneAvailability = {
  /** Resolved command-queue lane name, useful verbatim in logs. */
  lane: string;
  /** Tasks currently running on the lane. */
  activeCount: number;
  /** Tasks already waiting ahead of any new work. */
  queuedCount: number;
  /** True when a new turn for this session cannot start right now. */
  busy: boolean;
  /** Why the lane cannot start work, when it cannot. */
  blockedBy?: CommandLaneSnapshot["blockedBy"];
};

/** Reads the current lane availability for one session key. */
export function readSessionLaneAvailability(sessionKey: string): SessionLaneAvailability {
  const lane = resolveSessionLane(sessionKey);
  const snapshot = getCommandLaneSnapshot(lane);
  return {
    lane,
    activeCount: snapshot.activeCount,
    queuedCount: snapshot.queuedCount,
    busy: !isCommandLaneAdmissible(lane),
    ...(snapshot.blockedBy ? { blockedBy: snapshot.blockedBy } : {}),
  };
}

/** True when a new turn for this session key would have to wait for the lane. */
export function isSessionLaneBusy(sessionKey: string): boolean {
  return !isCommandLaneAdmissible(resolveSessionLane(sessionKey));
}

/**
 * Observe the moment this session's lane frees up.
 *
 * This is the turn-boundary readiness signal for work that chose to defer
 * rather than queue: the listener fires right after the session's in-flight
 * turn releases the lane. It is a hint, not a reservation — re-read
 * `isSessionLaneBusy` before acting. Returns an idempotent unsubscribe.
 */
export function subscribeSessionLaneRelease(sessionKey: string, listener: () => void): () => void {
  return subscribeCommandLaneRelease(resolveSessionLane(sessionKey), listener);
}
