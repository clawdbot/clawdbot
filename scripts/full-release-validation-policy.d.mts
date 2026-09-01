export const MAX_RELEASE_ARTIFACT_BYTES: number;
export function serializeReleaseArtifact(payload: unknown): string;
export function normalizeReleaseCoveragePolicy(input: ReleaseRecord): "npm-beta-v1" | undefined;
export function validateReleaseCoveragePolicyBinding(
  plan: ReleaseRecord | undefined,
  validationInputs?: ReleaseRecord,
): void;
export function normalizeReleaseTelegramWaiver(input: ReleaseRecord): string;
export function validateReleaseTelegramWaiverBinding(
  plan: ReleaseRecord | undefined,
  validationInputs?: ReleaseRecord,
): void;

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
export interface ReleaseChildSpec {
  dispatchName: string;
  displayName: string;
  key: string;
  parentJobName: string;
  rerunGroups: string[];
  suffix: string;
  workflow: string;
}
export type ReleaseGhTransportErrorClass = "ambiguous" | "hard" | "transient";
export function classifyReleaseGhTransportError(error: unknown): ReleaseGhTransportErrorClass;
export function isReleaseGhArtifactMissingError(error: unknown): boolean;
export function releaseChildSpec(key: string): ReleaseChildSpec;
export function validateReleaseChildRunProvenance(
  run: ReleaseRecord,
  expected?: ReleaseRecord,
): {
  dispatchActor: string;
  effectiveRunAttempt: number;
  repository: string;
  triggeringActor: string;
};
export function validateReleaseChildDispatchBinding(input: ReleaseRecord): void;
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
export function releaseCompositeJobsSha256(value: ReleaseRecord): string;
export function compareReleaseJobsByName(left: { name: string }, right: { name: string }): number;
export function composeReleaseAttemptJobs(
  attempts: Array<{ jobs: ReleaseRecord[]; runAttempt: number }>,
  expected: { effectiveRunAttempt: number; plannedRunAttempt: number },
): {
  effectiveRunAttempt: number;
  jobs: ReleaseRecord[];
  plannedRunAttempt: number;
  sha256: string;
};
export function composeReleaseChildAttemptEvidence(input: {
  attempts: Array<{ jobs: ReleaseRecord[]; runAttempt: number }>;
  expected: ReleaseRecord;
  run: ReleaseRecord;
}): ReleaseRecord;

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
export function releaseStateChildEvidence(child: ReleaseRecord): ReleaseRecord;
export function affectedActiveRunIds(
  children: ReleaseRecord[],
  blockers: ReleaseRecord[],
  cancelledRunIds?: Set<string>,
): string[];
