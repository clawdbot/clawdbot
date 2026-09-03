import type { ReleaseRecord } from "./full-release-validation-policy.mjs";
export * from "./full-release-validation-policy.mjs";
export function validateChildBinding(
  child: ReleaseRecord,
  run: ReleaseRecord,
  composite: ReleaseRecord,
): ReleaseRecord;
export function readChild(
  child: ReleaseRecord,
  previous: ReleaseRecord | undefined,
  signal?: AbortSignal,
  options?: {
    readAttemptJobs?: (
      runId: string,
      runAttempt: number,
      signal?: AbortSignal,
    ) => Promise<ReleaseRecord[]>;
    readRun?: (runId: string, signal?: AbortSignal) => Promise<ReleaseRecord>;
  },
): Promise<ReleaseRecord>;
export function releaseGhRetryDelayMs(
  attempt: number,
  deadlineMonotonicMs?: number,
  nowMonotonicMs?: number,
): number;
export function updateReleaseTransportEpisode(
  previous: ReleaseRecord | undefined,
  children: ReleaseRecord[],
  options?: { deadline?: number; monotonicNow?: number; wallNow?: number },
): ReleaseRecord;
export function parsePlanInputs(value: string): ReleaseRecord;
export function hydrateReusedPlan(plan: ReleaseRecord[], evidence: ReleaseRecord): ReleaseRecord[];
export function formatReleaseStateHeartbeat(mode: string, decision: ReleaseRecord): string;
