#!/usr/bin/env node
export function normalizeFullReleaseValidationRun(run: unknown): {
  databaseId: string;
  runAttempt: number;
  workflowName: unknown;
  workflowPath: string;
  workflowQualifiedRef: string;
  repository: unknown;
  headBranch: unknown;
  headSha: unknown;
  event: unknown;
  status: unknown;
  conclusion: unknown;
  url: unknown;
};
export function isShaPinnedReleaseValidationBranch(branch: unknown): boolean;
export function validateFullReleaseValidationEvidence({
  run: rawRun,
  manifest,
  expectedRepository,
  expectedRunId,
  expectedTargetSha,
  expectedWorkflowBranch,
  isTrustedMainAncestor,
  validateEvidenceReuseStrictly,
}: {
  run: unknown;
  manifest: unknown;
  expectedRepository: unknown;
  expectedRunId: unknown;
  expectedTargetSha: unknown;
  expectedWorkflowBranch: unknown;
  isTrustedMainAncestor: unknown;
  validateEvidenceReuseStrictly?: unknown;
}): {
  run: {
    databaseId: string;
    runAttempt: number;
    workflowName: unknown;
    workflowPath: string;
    workflowQualifiedRef: string;
    repository: unknown;
    headBranch: unknown;
    headSha: unknown;
    event: unknown;
    status: unknown;
    conclusion: unknown;
    url: unknown;
  };
  source: string;
};
export function runStrictReleaseEvidenceValidation({
  repository,
  runId,
  validatorFile,
  verifierSourceSha,
}: {
  repository: unknown;
  runId: unknown;
  validatorFile?: string | undefined;
  verifierSourceSha: unknown;
}): unknown;
