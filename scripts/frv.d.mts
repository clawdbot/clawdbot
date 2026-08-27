export interface FrvChildStatus extends Record<string, unknown> {
  effectiveRunAttempt: number;
  key: string;
  plannedRunAttempt: number;
  runId: string;
  status: string;
}

export interface FrvContinuationStatus {
  active: FrvChildStatus[];
  children: FrvChildStatus[];
  failed: FrvChildStatus[];
  passed: FrvChildStatus[];
}

export interface FrvClient {
  repository?: string;
  deleteWorkflowRef?: (branch: string, workflowSha: string) => Promise<unknown>;
  dispatchContinuation?: (
    plan: Record<string, unknown>,
    operationDeadline?: number,
  ) => Promise<{ branch: string; runId: string; workflowSha: string }>;
  getAttemptJobs: (runId: string, runAttempt: number) => Promise<Record<string, unknown>[]>;
  getJobLog: (jobId: number) => Promise<string>;
  getParentJobs: (runId: string) => Promise<Record<string, unknown>[]>;
  getRun: (runId: string) => Promise<Record<string, unknown>>;
  getRunAttempt: (runId: string, runAttempt: number) => Promise<Record<string, unknown>>;
  getWorkflowSource: (workflowSha: string) => Promise<string>;
  loadHistoricalCandidateArtifacts: (
    candidate: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  loadSourceManifest?: (
    runId: string,
    runAttempt: number,
  ) => Promise<Record<string, unknown> | undefined>;
  rerunFailed?: (runId: string) => Promise<unknown>;
  rerunParent?: (runId: string) => Promise<unknown>;
  verifyTrustedSourceSha?: (workflowSha: string) => Promise<void>;
  verifyTrustedToolingSha?: (workflowSha: string) => Promise<void>;
  verify?: (
    runId: string,
    plan: Record<string, unknown>,
    operationDeadline?: number,
  ) => Promise<unknown>;
}

export type FrvConcreteClient = FrvClient &
  Required<
    Pick<
      FrvClient,
      | "deleteWorkflowRef"
      | "dispatchContinuation"
      | "loadSourceManifest"
      | "rerunFailed"
      | "rerunParent"
      | "verify"
      | "verifyTrustedSourceSha"
      | "verifyTrustedToolingSha"
    >
  >;

export function inspectContinuation(
  plan: Record<string, unknown>,
  client: Pick<FrvClient, "getAttemptJobs" | "getRun" | "repository">,
): Promise<FrvContinuationStatus>;
export function createClient(
  repository: string,
  dependencies?: Record<string, unknown>,
): FrvConcreteClient;
export function continuationBranchName(sourceRunId: string, toolingSha: string): string;
export function preflightContinuation(
  plan: Record<string, unknown>,
  rootRunId: string,
  client: Pick<
    FrvClient,
    | "getJobLog"
    | "getParentJobs"
    | "getRunAttempt"
    | "getWorkflowSource"
    | "loadHistoricalCandidateArtifacts"
    | "loadSourceManifest"
    | "verifyTrustedSourceSha"
  >,
  repository?: string,
): Promise<Record<string, unknown>>;
export function loadPlan(
  options: Record<string, unknown>,
  loadExecutionPlan?: (...args: unknown[]) => Promise<unknown>,
): Promise<Record<string, unknown>>;
export function validateLegacySource(
  value: unknown,
  expectedRunId: string,
): Record<string, unknown>;
export function continueFailed(
  plan: Record<string, unknown>,
  rootRunId: string,
  client: FrvClient,
  options?: Record<string, unknown>,
): Promise<{
  action: string;
  finalRunId?: string;
  status: FrvContinuationStatus;
}>;
