import type {
  FullReleaseCandidateBinding,
  FullReleaseCandidateRequest,
} from "../full-release-candidate-contract.mjs";

export class CandidateConstituentUnavailableError extends Error {}
export class CandidateDiscoveryBudgetError extends Error {}
export class CandidateEvaluationLimitError extends Error {}

export interface SelectedFullReleaseCandidate {
  artifact: Record<string, unknown>;
}

export function selectTrustedFullReleaseCandidate(input: {
  artifacts: unknown[];
  deadlineMs?: number;
  now?: number;
  readWorkflowRun: (runId: number) => Promise<unknown>;
  readWorkflowJobs: (runId: number) => Promise<unknown>;
  request: FullReleaseCandidateRequest;
}): Promise<SelectedFullReleaseCandidate | null>;

export function loadSelectedFullReleaseCandidate(input: {
  deadlineMs?: number;
  downloadArchive?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  fetchImpl?: typeof fetch;
  now?: number;
  readArtifact: (artifactId: string) => Promise<unknown>;
  readRunAttempt: (runId: string, runAttempt: string) => Promise<unknown>;
  readWorkflowJobs: (runId: string, runAttempt: string) => Promise<unknown>;
  request: FullReleaseCandidateRequest;
  selected: SelectedFullReleaseCandidate;
  token: string;
}): Promise<FullReleaseCandidateBinding>;

export function candidateArtifactJsonFromBinding(value: unknown): string;

export function validateCandidateBinding(
  value: unknown,
  options?: {
    minimumRemainingMs?: number;
    now?: number;
    request?: FullReleaseCandidateRequest;
  },
): FullReleaseCandidateBinding;

export function resolveCandidateBinding(input: {
  freshBinding?: unknown;
  now?: number;
  request?: FullReleaseCandidateRequest | null;
  required: boolean;
  reusedBinding?: unknown;
}): FullReleaseCandidateBinding | null;

export function verifySealedFullReleaseCandidate(input: {
  binding: unknown;
  consumerRunAttempt: number | string;
  consumerRunId: number | string;
  downloadArchive?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  fetchImpl?: typeof fetch;
  now?: number;
  readArtifact: (artifactId: string) => Promise<unknown>;
  readRunAttempt: (runId: string, runAttempt: string) => Promise<unknown>;
  readWorkflowJobs: (runId: string, runAttempt: string) => Promise<unknown>;
  token: string;
}): Promise<FullReleaseCandidateBinding>;
