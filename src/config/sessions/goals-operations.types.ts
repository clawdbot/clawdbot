import type { SessionsGoalMutationResult } from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";

type SessionGoalOperationIdentity = {
  operationId: string;
  issuedAtMs: number;
  /** Hash of the complete immutable request, including the requested session generation. */
  requestFingerprint: string;
};

export type SessionGoalOperation = SessionGoalOperationIdentity &
  (
    | { action: "start"; objective: string; tokenBudget?: number }
    | { action: "edit"; goalId: string; objective: string }
    | { action: "resume" | "pause" | "block" | "complete"; goalId: string; note?: string }
    | { action: "clear"; goalId: string }
  );

export type SessionGoalOperationResult = Omit<SessionsGoalMutationResult, "replayed">;

/** Closed session mutation admitted together with its transcript and lifecycle state. */
export type SessionTranscriptTurnMutation = {
  kind: "goal";
  /** Private live authority; never serialized into operation fingerprints or receipts. */
  assertCurrent?: () => void;
  operation: SessionGoalOperation & { action: "start" | "resume" };
  runId: string;
};

export type SessionTranscriptTurnMutationResult = {
  result: SessionGoalOperationResult;
  replayed: boolean;
};
