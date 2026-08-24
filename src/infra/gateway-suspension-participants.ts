// Optional registry letting plugins fence background work the Gateway cannot see.
//
// Core accounting only covers work that flows through Gateway-owned queues,
// sessions, and runs. A plugin that owns its own background queue registers a
// participant here so its work is closed and counted inside the same atomic
// suspension fence.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Active work a participant still owns. Zero means the participant is idle. */
export type GatewaySuspensionParticipantReport = {
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
  prepared: Set<string>;
};

const PARTICIPANT_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewaySuspensionParticipantState"),
  (): GatewaySuspensionParticipantState => ({
    participants: new Map(),
    prepared: new Set(),
  }),
);

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function toBlocker(
  participantId: string,
  report: GatewaySuspensionParticipantReport,
): GatewaySuspensionParticipantBlocker | null {
  const count = normalizeCount(report?.activeCount);
  if (count === 0) {
    return null;
  }
  const message = report?.message?.trim();
  return {
    participantId,
    count,
    message: message || `${count} active ${participantId} operation(s)`,
  };
}

/**
 * Register a participant and return its unregister handle. Re-registering the
 * same id replaces the previous participant, which keeps plugin reloads from
 * leaving a stale closure owning the fence.
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
    // A participant removed mid-lease must not keep the fence marked closed.
    PARTICIPANT_STATE.prepared.delete(id);
  };
}

/** Point-in-time participant work, for preflight and status observation. */
export function inspectGatewaySuspensionParticipants(): GatewaySuspensionParticipantBlocker[] {
  const blockers: GatewaySuspensionParticipantBlocker[] = [];
  for (const [id, participant] of PARTICIPANT_STATE.participants) {
    let report: GatewaySuspensionParticipantReport;
    try {
      report = participant.status();
    } catch {
      // A participant that cannot answer is treated as busy: never report idle
      // on missing evidence.
      report = { activeCount: 1, message: `${id} suspension status unavailable` };
    }
    const blocker = toBlocker(id, report);
    if (blocker) {
      blockers.push(blocker);
    }
  }
  return blockers;
}

/**
 * Close every participant's admission. Callers hold the core fence already, so
 * this runs synchronously and rolls every participant back when any of them is
 * still busy or throws.
 */
export function prepareGatewaySuspensionParticipants(): {
  idle: boolean;
  blockers: GatewaySuspensionParticipantBlocker[];
} {
  const blockers: GatewaySuspensionParticipantBlocker[] = [];
  for (const [id, participant] of PARTICIPANT_STATE.participants) {
    let report: GatewaySuspensionParticipantReport;
    try {
      report = participant.prepare();
      PARTICIPANT_STATE.prepared.add(id);
    } catch {
      // Fail closed: an unusable participant blocks the suspension instead of
      // silently leaving its queue open behind a ready result.
      PARTICIPANT_STATE.prepared.add(id);
      report = { activeCount: 1, message: `${id} could not prepare for suspension` };
    }
    const blocker = toBlocker(id, report);
    if (blocker) {
      blockers.push(blocker);
    }
  }
  if (blockers.length > 0) {
    resumeGatewaySuspensionParticipants();
    return { idle: false, blockers };
  }
  return { idle: true, blockers };
}

/**
 * Reopen every prepared participant. Throws when any participant fails so the
 * coordinator's existing fail-closed scheduler recovery owns the retry, rather
 * than reopening core admission over a still-fenced participant.
 */
export function resumeGatewaySuspensionParticipants(): void {
  const failed: string[] = [];
  for (const id of Array.from(PARTICIPANT_STATE.prepared)) {
    const participant = PARTICIPANT_STATE.participants.get(id);
    if (!participant) {
      PARTICIPANT_STATE.prepared.delete(id);
      continue;
    }
    try {
      participant.resume();
      PARTICIPANT_STATE.prepared.delete(id);
    } catch {
      failed.push(id);
    }
  }
  if (failed.length > 0) {
    throw new Error(`gateway suspension participants failed to resume: ${failed.join(", ")}`);
  }
}

export function resetGatewaySuspensionParticipantsForTest(): void {
  PARTICIPANT_STATE.participants.clear();
  PARTICIPANT_STATE.prepared.clear();
}
