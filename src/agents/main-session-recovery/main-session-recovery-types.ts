import type { MainRestartRecoveryState, RestartRecoveryRun } from "../../config/sessions.js";

type MainSessionRecoveryExecutionIdentity = NonNullable<
  MainRestartRecoveryState["executionIdentity"]
>;

type MainSessionRecoveryExecutionIdentityAdmission =
  | { kind: "capture"; token: MainSessionRecoveryExecutionIdentity }
  | { kind: "retry-reference"; token: MainSessionRecoveryExecutionIdentity };

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
  executionIdentityAdmission?: MainSessionRecoveryExecutionIdentityAdmission;
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

type RecoveryRunOwner = {
  lifecycleGeneration: string;
  runId: string;
  sessionId: string;
};

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
      executionIdentity: { state: "disabled" } | { state: "enabled" };
    }
  | ({
      kind: "bind_admitted_execution_identity";
      attempt: number;
      cycleId: string;
      token: MainSessionRecoveryExecutionIdentity;
    } & RecoveryRunOwner)
  | {
      kind: "cancel_reservation" | "abandon_reservation";
      reservation: MainSessionRecoveryReservation;
    }
  | ({ kind: "validate_recovery" } & RecoveryRunOwner)
  | ({
      kind: "admit_recovery" | "mark_admitted_recovery_interrupted";
      now: number;
    } & RecoveryRunOwner)
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
  | { kind: "doctor_repair"; now: number }
  | { kind: "clear" };

export type MainSessionRecoveryTransitionResult =
  | {
      kind:
        | "admitted_recovery"
        | "applied"
        | "doctor_repaired"
        | "foreground_validated"
        | "no_change"
        | "recovery_validated"
        | "tombstoned";
    }
  | { kind: "foreground_claimed"; claim: MainSessionRecoveryOwnerClaim }
  | { kind: "observed"; view: MainSessionRecoveryView }
  | { kind: "rejected"; reason: MainSessionRecoveryConflict }
  | { kind: "reserved"; reservation: MainSessionRecoveryReservation };
