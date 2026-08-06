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

type SessionWorkAdmissionHandoff = {
  admission: HandoffSessionWorkAdmission;
  lease: SessionWorkAdmissionLease;
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
  const handoffId = randomUUID();
  admission.handoffIds.add(handoffId);
  SESSION_WORK_ADMISSION_HANDOFFS.set(handoffId, { admission, lease });
  return handoffId;
}

export function clearSessionWorkAdmissionHandoffs(admission: HandoffSessionWorkAdmission): void {
  for (const handoffId of admission.handoffIds) {
    SESSION_WORK_ADMISSION_HANDOFFS.delete(handoffId);
  }
  admission.handoffIds.clear();
}

/**
 * Atomically adopts a previously admitted work lease across an in-process RPC.
 * The opaque token is single-use; requested identities must be covered by the lease.
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
    identities.some((identity) => !handoff.admission.identities.has(identity))
  ) {
    return undefined;
  }
  SESSION_WORK_ADMISSION_HANDOFFS.delete(handoffId);
  handoff.admission.handoffIds.delete(handoffId);
  handoff.admission.interrupt = params.onInterrupt;
  if (handoff.admission.interrupted) {
    params.onInterrupt?.();
  }
  return handoff.lease;
}

/** Releases a handoff that was never consumed; the adopter owns consumed leases. */
export function cancelSessionWorkAdmissionHandoff(handoffId: string): boolean {
  const normalizedHandoffId = handoffId.trim();
  const handoff = SESSION_WORK_ADMISSION_HANDOFFS.get(normalizedHandoffId);
  if (!handoff) {
    return false;
  }
  SESSION_WORK_ADMISSION_HANDOFFS.delete(normalizedHandoffId);
  handoff.admission.handoffIds.delete(normalizedHandoffId);
  handoff.lease.release();
  return true;
}
