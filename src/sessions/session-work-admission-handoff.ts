import { randomUUID } from "node:crypto";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeSessionIdentities } from "./session-lifecycle-identity.js";

export type SessionWorkAdmissionLease = {
  createHandoff: () => string;
  release: () => void;
  released: Promise<void>;
  run: <T>(run: () => Promise<T>) => Promise<T>;
};

export type HandoffSessionWorkAdmission = {
  handoffIds: Set<string>;
  identities: ReadonlySet<string>;
  interrupt?: () => void;
  interrupted: boolean;
};

export type SessionWorkAdmissionHandoffEntry = {
  admission: HandoffSessionWorkAdmission;
  lease: SessionWorkAdmissionLease;
};

type SessionWorkAdmissionHandoff = {
  entries: readonly SessionWorkAdmissionHandoffEntry[];
};

// Runtime chunks can load separate module instances. Handoff tokens must still
// resolve against the one process-wide admission registry.
const SESSION_WORK_ADMISSION_HANDOFFS = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionWorkAdmissionHandoffs"),
  () => new Map<string, SessionWorkAdmissionHandoff>(),
);

export function createSessionWorkAdmissionHandoff(
  admission: HandoffSessionWorkAdmission,
  lease: SessionWorkAdmissionLease,
): string {
  return createSessionWorkAdmissionHandoffForEntries([{ admission, lease }]);
}

/**
 * Registers one single-use token that hands off several admissions at once. A
 * turn can hold nested admissions for the same session (the gateway chat.send
 * admission plus the inner reply-run admission); adopting only one of them
 * would leave the drain blocking on the others, so they travel as one token.
 */
export function createSessionWorkAdmissionHandoffForEntries(
  entries: readonly SessionWorkAdmissionHandoffEntry[],
): string {
  if (entries.length === 0) {
    throw new Error("session work admission handoff requires at least one admission");
  }
  const handoffId = randomUUID();
  for (const entry of entries) {
    entry.admission.handoffIds.add(handoffId);
  }
  SESSION_WORK_ADMISSION_HANDOFFS.set(handoffId, { entries });
  return handoffId;
}

function detachSessionWorkAdmissionHandoff(
  handoffId: string,
  handoff: SessionWorkAdmissionHandoff,
): void {
  SESSION_WORK_ADMISSION_HANDOFFS.delete(handoffId);
  for (const entry of handoff.entries) {
    entry.admission.handoffIds.delete(handoffId);
  }
}

export function clearSessionWorkAdmissionHandoffs(admission: HandoffSessionWorkAdmission): void {
  // A released member admission invalidates the whole token: adopting the
  // remaining members would claim the session is still owned by the initiator.
  for (const handoffId of Array.from(admission.handoffIds)) {
    const handoff = SESSION_WORK_ADMISSION_HANDOFFS.get(handoffId);
    if (handoff) {
      detachSessionWorkAdmissionHandoff(handoffId, handoff);
    }
  }
  admission.handoffIds.clear();
}

function composeSessionWorkAdmissionLeases(
  entries: readonly SessionWorkAdmissionHandoffEntry[],
): SessionWorkAdmissionLease {
  if (entries.length === 1) {
    return entries[0]!.lease;
  }
  const leases = entries.map((entry) => entry.lease);
  return {
    createHandoff: () => createSessionWorkAdmissionHandoffForEntries(entries),
    release: () => {
      for (const lease of leases) {
        lease.release();
      }
    },
    released: Promise.all(leases.map((lease) => lease.released)).then(() => undefined),
    run: async <T>(run: () => Promise<T>): Promise<T> => {
      let composed = run;
      for (const lease of leases) {
        const inner = composed;
        composed = () => lease.run(inner);
      }
      return await composed();
    },
  };
}

/**
 * Atomically adopts previously admitted work leases across an in-process RPC.
 * The opaque token is single-use; requested identities must be covered by
 * every admission it carries.
 */
export function consumeSessionWorkAdmissionHandoff(params: {
  handoffId: string;
  scope: string;
  identities: Iterable<string | undefined>;
  onInterrupt?: () => void;
}): SessionWorkAdmissionLease | undefined {
  const handoffId = params.handoffId.trim();
  if (!handoffId) {
    return undefined;
  }
  const handoff = SESSION_WORK_ADMISSION_HANDOFFS.get(handoffId);
  if (!handoff) {
    return undefined;
  }
  const identities = normalizeSessionIdentities(params.scope, params.identities);
  if (
    identities.length === 0 ||
    handoff.entries.some((entry) =>
      identities.some((identity) => !entry.admission.identities.has(identity)),
    )
  ) {
    return undefined;
  }
  detachSessionWorkAdmissionHandoff(handoffId, handoff);
  let interrupted = false;
  for (const entry of handoff.entries) {
    entry.admission.interrupt = params.onInterrupt;
    interrupted ||= entry.admission.interrupted;
  }
  if (interrupted) {
    params.onInterrupt?.();
  }
  return composeSessionWorkAdmissionLeases(handoff.entries);
}

/** Releases a handoff that was never consumed; the adopter owns consumed leases. */
export function cancelSessionWorkAdmissionHandoff(handoffId: string): boolean {
  const normalizedHandoffId = handoffId.trim();
  const handoff = SESSION_WORK_ADMISSION_HANDOFFS.get(normalizedHandoffId);
  if (!handoff) {
    return false;
  }
  detachSessionWorkAdmissionHandoff(normalizedHandoffId, handoff);
  for (const entry of handoff.entries) {
    entry.lease.release();
  }
  return true;
}
