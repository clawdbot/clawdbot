export interface ReleaseRecord {
  [key: string]: unknown;
}
export interface ReleaseChild extends ReleaseRecord {
  key: string;
  runAttempt: number | null;
  runId: string;
}
export interface ReleaseExecutionPlan extends ReleaseRecord {
  children: ReleaseChild[];
  evidenceReuse: ReleaseRecord;
  gates: ReleaseRecord[];
}
export interface ReleaseStateArtifact extends ReleaseRecord {
  blockers: ReleaseRecord[];
  children: Record<string, ReleaseRecord>;
  errors: ReleaseRecord[];
  parentRunAttempt: number;
  sourceParentRunAttempt: number;
  state: string;
}
export type ReleaseGhTransportErrorClass = "hard" | "transient";
export function classifyReleaseGhTransportError(error: unknown): ReleaseGhTransportErrorClass;
export function buildReleaseExecutionPlan(input: ReleaseRecord): {
  children: ReleaseChild[];
  gates: ReleaseRecord[];
};
export function buildReleaseExecutionPlanArtifact(input: ReleaseRecord): ReleaseExecutionPlan;
export function validateReleaseExecutionPlanArtifact(
  payload: unknown,
  expected?: Record<string, unknown>,
): ReleaseExecutionPlan;
export function releaseExecutionPlanSha256(plan: ReleaseRecord): string;

export function terminalPolicyPass(
  child: ReleaseRecord,
  releaseProfile: string,
  workflowRef: string,
): boolean;

export function classifyReleaseSnapshot(input: ReleaseRecord): ReleaseStateArtifact;
export function releasePlanGateFailures(gates: ReleaseRecord[]): ReleaseRecord[];
export function buildReleaseStateArtifact(input: ReleaseRecord): ReleaseStateArtifact;
export function validateReleaseStateArtifact(
  payload: unknown,
  expected?: Record<string, unknown>,
  expectedMode?: string,
): ReleaseStateArtifact;
export function verifyReleaseStateArtifacts(
  executionPlanPayload: unknown,
  decisionPayload: unknown,
  drainPayload: unknown,
  expected?: Record<string, unknown>,
): {
  decision: ReleaseStateArtifact;
  drain: ReleaseStateArtifact;
  executionPlan: ReleaseExecutionPlan;
  sourceAttempts: {
    decision: number;
    drain: number;
    executionPlan: number;
  };
};
export function selectReleaseStateArtifacts(
  executionPlanPayload: unknown,
  decisionCandidates: Array<{ name: string; payload: unknown }>,
  drainCandidates: Array<{ name: string; payload: unknown }>,
  expected?: Record<string, unknown>,
): {
  decision: ReleaseStateArtifact;
  drain: ReleaseStateArtifact;
  executionPlan: ReleaseExecutionPlan;
  sourceAttempts: {
    decision: number;
    drain: number;
    executionPlan: number;
  };
};
export function formatReleaseStateOutcome(payload: ReleaseRecord): string;
export function affectedActiveRunIds(
  children: ReleaseRecord[],
  blockers: ReleaseRecord[],
  cancelledRunIds?: Set<string>,
): string[];
