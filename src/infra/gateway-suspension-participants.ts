// Optional registry letting plugins fence background work the Gateway cannot see.
//
// Core accounting only covers work that flows through Gateway-owned queues,
// sessions, and runs. A plugin that owns its own background queue registers a
// participant here so its work is closed and counted inside the same atomic
// suspension fence.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Active work a participant still owns. Zero means the participant is idle. */
type GatewaySuspensionParticipantReport = {
  activeCount: number;
  /** Operator-facing blocker text. Defaults to a generic count message. */
  message?: string;
};

export type GatewaySuspensionParticipant = {
  id: string;
  /**
   * Close the participant's own admission and report work still in flight.
   * Synchronous by contract: the core fence must not yield between closing
   * admission and taking the authoritative snapshot, or new work could slip in.
   */
  prepare: () => GatewaySuspensionParticipantReport;
  /** Report current work without changing admission state. */
  status: () => GatewaySuspensionParticipantReport;
  /** Reopen the participant's admission on resume, rollback, or lease expiry. */
  resume: () => void;
};

export type GatewaySuspensionParticipantBlocker = {
  participantId: string;
  count: number;
  message: string;
};

type GatewaySuspensionParticipantState = {
  participants: Map<string, GatewaySuspensionParticipant>;
  // Keyed by instance, not id: unregister or a plugin reload can drop or replace
  // the registry entry while a lease is held, and only the exact instance whose
  // prepare() closed the queue can reopen it. Losing it strands that queue closed
  // after the Gateway reports the suspension recovered.
  prepared: Set<GatewaySuspensionParticipant>;
};

const PARTICIPANT_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewaySuspensionParticipantState"),
  (): GatewaySuspensionParticipantState => ({
    participants: new Map(),
    prepared: new Set(),
  }),
);

/** Stand-in count for a participant that cannot be trusted to be idle. */
const UNUSABLE_REPORT_COUNT = 1;

function unusableReportBlocker(
  participantId: string,
  reason: string,
): GatewaySuspensionParticipantBlocker {
  return {
    participantId,
    count: UNUSABLE_REPORT_COUNT,
    message: `${participantId} ${reason}`,
  };
}

/**
 * Convert a participant's raw return value into a blocker.
 *
 * Fails closed: only an exact synchronous non-negative integer may report idle.
 * A promise, missing field, NaN, or any other shape means the participant did
 * not actually fence and account for its queue, so it blocks the suspension
 * instead of silently permitting an unsafe host freeze.
 */
function toBlocker(
  participantId: string,
  report: unknown,
): GatewaySuspensionParticipantBlocker | null {
  if (!isRecord(report)) {
    return unusableReportBlocker(participantId, "returned an unusable suspension report");
  }
  if (typeof report.then === "function") {
    // Participants are synchronous by contract; awaiting here would reopen the
    // gap between closing admission and taking the authoritative snapshot.
    return unusableReportBlocker(participantId, "returned an asynchronous suspension report");
  }
  const activeCount = report.activeCount;
  if (typeof activeCount !== "number" || !Number.isSafeInteger(activeCount) || activeCount < 0) {
    return unusableReportBlocker(participantId, "reported an invalid active count");
  }
  if (activeCount === 0) {
    return null;
  }
  const message = report.message;
  const trimmed = typeof message === "string" ? message.trim() : "";
  return {
    participantId,
    count: activeCount,
    message: trimmed || `${activeCount} active ${participantId} operation(s)`,
  };
}

/**
 * Register a participant and return its unregister handle. Re-registering the
 * same id replaces the previous participant, which keeps plugin reloads from
 * leaving a stale closure owning the fence. A replaced or unregistered instance
 * that is already prepared stays owed a resume until it has been reopened.
 */
export function registerGatewaySuspensionParticipant(
  participant: GatewaySuspensionParticipant,
): () => void {
  const id = participant.id.trim();
  if (!id) {
    throw new Error("gateway suspension participant requires a non-empty id");
  }
  const entry: GatewaySuspensionParticipant = { ...participant, id };
  PARTICIPANT_STATE.participants.set(id, entry);
  return () => {
    if (PARTICIPANT_STATE.participants.get(id) !== entry) {
      return;
    }
    PARTICIPANT_STATE.participants.delete(id);
  };
}

/** Point-in-time participant work, for preflight and status observation. */
export function inspectGatewaySuspensionParticipants(): GatewaySuspensionParticipantBlocker[] {
  const blockers: GatewaySuspensionParticipantBlocker[] = [];
  for (const [id, participant] of PARTICIPANT_STATE.participants) {
    // The return value is untrusted plugin output, not the declared type.
    let report: unknown;
    try {
      report = participant.status();
    } catch {
      // A participant that cannot answer is treated as busy: never report idle
      // on missing evidence.
      report = {
        activeCount: UNUSABLE_REPORT_COUNT,
        message: `${id} suspension status unavailable`,
      };
    }
    const blocker = toBlocker(id, report);
    if (blocker) {
      blockers.push(blocker);
    }
  }
  return blockers;
}

/**
 * Close every participant's admission and report what that close observed.
 * Callers hold the core fence already, so this runs synchronously; reopening is
 * the caller's job through resumeGatewaySuspensionParticipants, which keeps a
 * drain lease fenced instead of rolling back the moment work is still in flight.
 */
export function prepareGatewaySuspensionParticipants(): GatewaySuspensionParticipantBlocker[] {
  const blockers: GatewaySuspensionParticipantBlocker[] = [];
  for (const [id, participant] of PARTICIPANT_STATE.participants) {
    // The return value is untrusted plugin output, not the declared type.
    let report: unknown;
    // Marked prepared before the report is read: a participant that threw may
    // still have closed its admission, so it is owed a resume either way.
    PARTICIPANT_STATE.prepared.add(participant);
    try {
      report = participant.prepare();
    } catch {
      // Fail closed: an unusable participant blocks the suspension instead of
      // silently leaving its queue open behind a ready result.
      report = {
        activeCount: UNUSABLE_REPORT_COUNT,
        message: `${id} could not prepare for suspension`,
      };
    }
    const blocker = toBlocker(id, report);
    if (blocker) {
      blockers.push(blocker);
    }
  }
  return blockers;
}

/**
 * Reopen every prepared participant, including ones unregistered or replaced
 * while the lease was held. Throws when any participant fails so the
 * coordinator's existing fail-closed scheduler recovery owns the retry, rather
 * than reopening core admission over a still-fenced participant.
 */
export function resumeGatewaySuspensionParticipants(): void {
  const failed: string[] = [];
  for (const participant of Array.from(PARTICIPANT_STATE.prepared)) {
    try {
      participant.resume();
      PARTICIPANT_STATE.prepared.delete(participant);
    } catch {
      failed.push(participant.id);
    }
  }
  if (failed.length > 0) {
    throw new Error(`gateway suspension participants failed to resume: ${failed.join(", ")}`);
  }
}
