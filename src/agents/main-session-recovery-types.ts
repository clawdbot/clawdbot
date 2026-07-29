import type {
  InternalSessionEntry as SessionEntry,
  RestartRecoveryRun,
} from "../config/sessions.js";

export type MainSessionRecoveryObservation = {
  sessionId: string;
  cycleId: string;
  revision: number;
};

export type MainSessionRecoveryReservation = {
  sessionId: string;
  cycleId: string;
  lifecycleGeneration: string;
  runId: string;
  attempt: number;
};

export type MainSessionRecoveryOwnerClaim = {
  cycleId: string;
  lifecycleGeneration: string;
  claimId: string;
  sessionId: string;
  sessionKey: string;
  runId?: string;
};

export type MainSessionRecoveryView =
  | { status: "inactive" }
  | { status: "blocked" }
  | {
      status: "recoverable";
      observation: MainSessionRecoveryObservation;
      nextAttempt: number;
    }
  | {
      status: "exhausted";
      observation: MainSessionRecoveryObservation;
      reason: string;
    }
  | { status: "tombstoned" };

export type MainSessionRecoveryConflict =
  | "already_tombstoned"
  | "foreground_active"
  | "not_interrupted"
  | "recovery_exhausted"
  | "reservation_active"
  | "session_replaced"
  | "stale_cycle"
  | "stale_generation"
  | "stale_reservation"
  | "stale_revision";

export type MainSessionRecoveryCommand =
  | {
      kind: "mark_interrupted";
      cycleId: string;
      now: number;
      runs?: RestartRecoveryRun[];
      resetRuntime?: boolean;
    }
  | {
      kind: "observe";
      cycleId: string;
      lifecycleGeneration: string;
      sessionKey: string;
    }
  | {
      kind: "inspect";
      lifecycleGeneration: string;
      sessionKey: string;
    }
  | {
      kind: "prepare_attempt";
      attempt: number;
      lifecycleGeneration: string;
      now: number;
      observation: MainSessionRecoveryObservation;
      runId: string;
    }
  | { kind: "cancel_reservation"; reservation: MainSessionRecoveryReservation }
  | { kind: "abandon_reservation"; reservation: MainSessionRecoveryReservation }
  | {
      kind: "validate_recovery";
      lifecycleGeneration: string;
      runId: string;
      sessionId: string;
    }
  | {
      kind: "admit_recovery";
      lifecycleGeneration: string;
      now: number;
      runId: string;
      sessionId: string;
    }
  | {
      kind: "mark_admitted_recovery_interrupted";
      lifecycleGeneration: string;
      now: number;
      runId: string;
      sessionId: string;
    }
  | {
      kind: "claim_foreground";
      cycleId: string;
      lifecycleGeneration: string;
      sessionId: string;
      sessionKey: string;
      claimId: string;
      runId?: string;
    }
  | { kind: "bind_foreground_run"; claim: MainSessionRecoveryOwnerClaim; runId: string }
  | { kind: "validate_foreground"; claim: MainSessionRecoveryOwnerClaim }
  | { kind: "release_foreground"; claim: MainSessionRecoveryOwnerClaim }
  | {
      kind: "tombstone";
      now: number;
      observation: MainSessionRecoveryObservation;
      reason: string;
    }
  | {
      kind: "fail_recovery";
      now: number;
      observation: MainSessionRecoveryObservation;
    }
  | { kind: "doctor_repair"; now: number }
  | { kind: "clear" };

export type MainSessionRecoveryTransitionResult =
  | { kind: "admitted_recovery" }
  | { kind: "applied" }
  | { kind: "doctor_repaired" }
  | { kind: "failed"; noticeEntry: SessionEntry }
  | { kind: "foreground_claimed"; claim: MainSessionRecoveryOwnerClaim }
  | { kind: "foreground_validated" }
  | { kind: "no_change" }
  | { kind: "observed"; view: MainSessionRecoveryView }
  | { kind: "rejected"; reason: MainSessionRecoveryConflict }
  | { kind: "recovery_validated" }
  | { kind: "reserved"; reservation: MainSessionRecoveryReservation }
  | { kind: "tombstoned" };
