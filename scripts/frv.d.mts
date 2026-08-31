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
  getAttemptJobs: (runId: string, runAttempt: number) => Promise<Record<string, unknown>[]>;
  getJobLog: (jobId: number) => Promise<string>;
  getParentJobs: (runId: string) => Promise<Record<string, unknown>[]>;
  getRun: (runId: string) => Promise<Record<string, unknown>>;
  getRunAttempt: (runId: string, runAttempt: number) => Promise<Record<string, unknown>>;
  rerunFailed?: (runId: string) => Promise<unknown>;
  rerunParent?: (runId: string) => Promise<unknown>;
  verify?: (
    runId: string,
    plan: Record<string, unknown>,
    operationDeadline?: number,
    expectedRunAttempts?: Record<string, number>,
  ) => Promise<unknown>;
  verifySeal?: (
    runId: string,
    plan: Record<string, unknown>,
    operationDeadline: number,
    expectedRunAttempts: Record<string, number>,
  ) => Promise<boolean>;
}

export type FrvConcreteClient = FrvClient &
  Required<Pick<FrvClient, "rerunFailed" | "rerunParent" | "verify" | "verifySeal">>;

export function inspectContinuation(
  plan: Record<string, unknown>,
  client: Pick<FrvClient, "getAttemptJobs" | "getRun" | "repository">,
): Promise<FrvContinuationStatus>;
export function createClient(
  repository: string,
  dependencies?: Record<string, unknown>,
): FrvConcreteClient;
export function preflightContinuation(
  plan: Record<string, unknown>,
  rootRunId: string,
  client: Pick<FrvClient, "getJobLog" | "getParentJobs" | "getRunAttempt">,
  repository?: string,
): Promise<Record<string, unknown>>;
export function loadPlan(
  options: Record<string, unknown>,
  loadExecutionPlan?: (...args: unknown[]) => Promise<unknown>,
): Promise<Record<string, unknown>>;
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
