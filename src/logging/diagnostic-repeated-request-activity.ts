import { resolveCurrentDiagnosticRunId } from "./diagnostic-embedded-run-index.js";

// Mechanical request retries stay continuous for one run owner. Only typed
// semantic progress or owner teardown can clear the clock that recovery reads.
type RepeatedRequestOwner = { runId: string; sequence: number };

export type DiagnosticRepeatedRequestActivity = {
  repeatedRequestOwnerRunId?: string;
  repeatedRequestFirstStartedAt?: number;
  repeatedRequestCount?: number;
  repeatedRequestMutationSequence?: number;
};

let mutationSequence = 0;

function nextMutationSequence(): number {
  mutationSequence += 1;
  return mutationSequence;
}

export function recordRepeatedRequestObservation(
  activity: DiagnosticRepeatedRequestActivity,
  owners: Iterable<RepeatedRequestOwner>,
  params: {
    runId?: string;
    observationUnit?: "request" | "turn";
    now?: number;
  },
): void {
  if (params.observationUnit === "turn") {
    return;
  }
  const currentOwnerRunId = resolveCurrentDiagnosticRunId(owners);
  const runId = params.runId?.trim();
  if (currentOwnerRunId === undefined || !runId || currentOwnerRunId !== runId) {
    return;
  }
  if (activity.repeatedRequestOwnerRunId !== runId) {
    activity.repeatedRequestOwnerRunId = runId;
    activity.repeatedRequestFirstStartedAt = params.now ?? Date.now();
    activity.repeatedRequestCount = 1;
  } else {
    activity.repeatedRequestCount = (activity.repeatedRequestCount ?? 0) + 1;
  }
  activity.repeatedRequestMutationSequence = nextMutationSequence();
}

export function clearRepeatedRequestActivity(
  activity: DiagnosticRepeatedRequestActivity,
  params: { runId?: string } = {},
): boolean {
  if (
    params.runId !== undefined &&
    activity.repeatedRequestOwnerRunId !== undefined &&
    activity.repeatedRequestOwnerRunId !== params.runId
  ) {
    return false;
  }
  const cleared = activity.repeatedRequestCount !== undefined;
  if (!cleared && params.runId !== undefined) {
    return false;
  }
  activity.repeatedRequestOwnerRunId = undefined;
  activity.repeatedRequestFirstStartedAt = undefined;
  activity.repeatedRequestCount = undefined;
  activity.repeatedRequestMutationSequence = nextMutationSequence();
  return cleared;
}

export function mergeRepeatedRequestActivity(
  target: DiagnosticRepeatedRequestActivity,
  source: DiagnosticRepeatedRequestActivity,
): void {
  if (
    source.repeatedRequestMutationSequence === undefined ||
    (target.repeatedRequestMutationSequence ?? 0) >= source.repeatedRequestMutationSequence
  ) {
    return;
  }
  target.repeatedRequestOwnerRunId = source.repeatedRequestOwnerRunId;
  target.repeatedRequestFirstStartedAt = source.repeatedRequestFirstStartedAt;
  target.repeatedRequestCount = source.repeatedRequestCount;
  target.repeatedRequestMutationSequence = source.repeatedRequestMutationSequence;
}

export function resolveRepeatedRequestNoProgressAgeMs(
  activity: DiagnosticRepeatedRequestActivity,
  currentOwnerRunId: string | undefined,
  now: number,
): number | undefined {
  if (
    currentOwnerRunId === undefined ||
    currentOwnerRunId !== activity.repeatedRequestOwnerRunId ||
    (activity.repeatedRequestCount ?? 0) < 2 ||
    activity.repeatedRequestFirstStartedAt === undefined
  ) {
    return undefined;
  }
  return Math.max(0, now - activity.repeatedRequestFirstStartedAt);
}
